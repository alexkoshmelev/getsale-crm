import express from 'express';
import OpenAI from 'openai';
import { RabbitMQClient, RedisClient } from '@getsale/utils';
import { EventType, AIDraftGeneratedEvent, Event } from '@getsale/events';
import { AIDraftStatus } from '@getsale/types';

const app = express();
const PORT = process.env.PORT || 3005;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || '';
const isPlaceholder = /your[_\-]?openai|placeholder|your_ope/i.test(OPENAI_API_KEY);
const isOpenAIKeyConfigured =
  OPENAI_API_KEY.length > 0 &&
  !isPlaceholder &&
  OPENAI_API_KEY.startsWith('sk-');

const openai = isOpenAIKeyConfigured
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : (null as unknown as OpenAI);

if (!isOpenAIKeyConfigured) {
  console.warn(
    '[AI Service] OPENAI_API_KEY is not set or is a placeholder. AI draft generation will return 503. Set a valid key from https://platform.openai.com/account/api-keys'
  );
}

const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6379');
const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

(async () => {
  try {
    await rabbitmq.connect();
    await subscribeToEvents();
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event subscription:', error);
  }
})();

// Subscribe to events that trigger AI actions
async function subscribeToEvents() {
  await rabbitmq.subscribeToEvents(
    [EventType.MESSAGE_RECEIVED, EventType.DEAL_STAGE_CHANGED],
    async (event) => {
      if (event.type === EventType.MESSAGE_RECEIVED) {
        try {
          const data = event.data as { contactId?: string; content: string };
          await generateDraft(data.contactId, data.content);
        } catch (err: unknown) {
          const e = err as Error & { statusCode?: number };
          if (e.statusCode === 503 || e.message === OPENAI_NOT_CONFIGURED_MSG) {
            // Do not log as error; key is simply not configured
            return;
          }
          console.error('Error generating draft (event):', err);
        }
      }
    },
    'events',
    'ai-service'
  );
}

const OPENAI_NOT_CONFIGURED_MSG =
  'OpenAI API key is not configured or is a placeholder. Set OPENAI_API_KEY to a valid key from https://platform.openai.com/account/api-keys';

interface ContactContext {
  name: string;
  company: string;
}

async function generateDraft(contactId: string | undefined, context: string) {
  if (!isOpenAIKeyConfigured || !openai) {
    const err = new Error(OPENAI_NOT_CONFIGURED_MSG) as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }

  try {
    // Get contact context from cache or CRM service
    const contactKey = contactId ? `contact:${contactId}` : null;
    const cached = contactKey ? await redis.get<ContactContext>(contactKey) : null;
    const contact: ContactContext = cached ?? { name: 'Contact', company: 'Company' };

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
  } catch (error: unknown) {
    const err = error as Error & { statusCode?: number };
    if (err.statusCode === 503 || err.message === OPENAI_NOT_CONFIGURED_MSG) {
      res.status(503).json({
        error: 'Service Unavailable',
        code: 'OPENAI_NOT_CONFIGURED',
        message: OPENAI_NOT_CONFIGURED_MSG,
      });
      return;
    }
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
    const approvedEvent = {
      id: crypto.randomUUID(),
      type: EventType.AI_DRAFT_APPROVED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { draftId: id },
    };
    await rabbitmq.publishEvent(approvedEvent as Event);

    res.json(updatedDraft);
  } catch (error) {
    console.error('Error approving draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`AI service running on port ${PORT}`);
});

