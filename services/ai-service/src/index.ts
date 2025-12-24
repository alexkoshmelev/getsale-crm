import express from 'express';
import OpenAI from 'openai';
import { RabbitMQClient, RedisClient } from '@getsale/utils';
import { EventType, AIDraftGeneratedEvent } from '@getsale/events';
import { AIDraftStatus } from '@getsale/types';

const app = express();
const PORT = process.env.PORT || 3005;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6379');
const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

(async () => {
  await rabbitmq.connect();
  await subscribeToEvents();
})();

// Subscribe to events that trigger AI actions
async function subscribeToEvents() {
  await rabbitmq.subscribeToEvents(
    [EventType.MESSAGE_RECEIVED, EventType.DEAL_STAGE_CHANGED],
    async (event) => {
      if (event.type === EventType.MESSAGE_RECEIVED) {
        // Generate draft response
        await generateDraft(event.data.contactId, event.data.content);
      }
    },
    'events',
    'ai-service'
  );
}

async function generateDraft(contactId: string, context: string) {
  try {
    // Get contact context from cache or CRM service
    const contactKey = `contact:${contactId}`;
    let contact = await redis.get(contactKey);

    if (!contact) {
      // Fetch from CRM service (simplified)
      contact = { name: 'Contact', company: 'Company' };
    }

    // Generate draft using OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a professional sales assistant. Generate concise, friendly responses.',
        },
        {
          role: 'user',
          content: `Generate a response to this message: "${context}" for contact ${contact.name}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 200,
    });

    const draftContent = completion.choices[0].message.content || '';

    // Create draft
    const draft = {
      id: crypto.randomUUID(),
      contactId,
      content: draftContent,
      status: AIDraftStatus.GENERATED,
      generatedBy: 'ai-agent',
      createdAt: new Date(),
    };

    // Cache draft
    await redis.set(`draft:${draft.id}`, draft, 3600);

    // Publish event
    const event: AIDraftGeneratedEvent = {
      id: crypto.randomUUID(),
      type: EventType.AI_DRAFT_GENERATED,
      timestamp: new Date(),
      organizationId: '', // Should be extracted from contact
      data: {
        draftId: draft.id,
        contactId,
        content: draftContent,
      },
    };
    await rabbitmq.publishEvent(event);

    return draft;
  } catch (error) {
    console.error('Error generating draft:', error);
    throw error;
  }
}

function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
  };
}

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ai-service' });
});

// Generate draft
app.post('/api/ai/drafts/generate', async (req, res) => {
  try {
    const user = getUser(req);
    const { contactId, dealId, context } = req.body;

    const draft = await generateDraft(contactId, context || '');

    res.json(draft);
  } catch (error) {
    console.error('Error generating draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get draft
app.get('/api/ai/drafts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const draft = await redis.get(`draft:${id}`);

    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    res.json(draft);
  } catch (error) {
    console.error('Error fetching draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve draft
app.post('/api/ai/drafts/:id/approve', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const draft = await redis.get(`draft:${id}`);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    // Update draft status
    const updatedDraft = {
      ...draft,
      status: AIDraftStatus.APPROVED,
      approvedBy: user.id,
    };

    await redis.set(`draft:${id}`, updatedDraft, 3600);

    // Publish event
    await rabbitmq.publishEvent({
      id: crypto.randomUUID(),
      type: EventType.AI_DRAFT_APPROVED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { draftId: id },
    });

    res.json(updatedDraft);
  } catch (error) {
    console.error('Error approving draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`AI service running on port ${PORT}`);
});

