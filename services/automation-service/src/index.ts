import express from 'express';
import { Pool } from 'pg';
import cron from 'node-cron';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, AutomationRuleTriggeredEvent } from '@getsale/events';

const app = express();
const PORT = process.env.PORT || 3009;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

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
  startCronJobs();
})();

async function subscribeToEvents() {
  await rabbitmq.subscribeToEvents(
    [EventType.MESSAGE_RECEIVED, EventType.DEAL_STAGE_CHANGED, EventType.CONTACT_CREATED],
    async (event) => {
      await processEvent(event);
    },
    'events',
    'automation-service'
  );
}

async function processEvent(event: any) {
  try {
    // Get enabled rules for this event type
    const rules = await pool.query(
      `SELECT * FROM automation_rules 
       WHERE is_active = true 
       AND trigger_type = $1 
       AND organization_id = $2`,
      [event.type, event.organizationId]
    );

    for (const rule of rules.rows) {
      // Parse JSONB fields if they come as strings
      const triggerConditions = typeof rule.trigger_conditions === 'string' 
        ? JSON.parse(rule.trigger_conditions) 
        : rule.trigger_conditions;
      const conditions = typeof rule.conditions === 'string'
        ? JSON.parse(rule.conditions)
        : (rule.conditions || []);
      let shouldExecute = true;

      // Check conditions
      for (const condition of conditions) {
        if (!evaluateCondition(condition, event)) {
          shouldExecute = false;
          break;
        }
      }

      if (shouldExecute) {
        await executeRule(rule, event);
      }
    }
  } catch (error) {
    console.error('Error processing automation event:', error);
  }
}

function evaluateCondition(condition: any, event: any): boolean {
  const { field, operator, value } = condition;
  const eventValue = event.data?.[field];

  switch (operator) {
    case 'eq':
      return eventValue === value;
    case 'ne':
      return eventValue !== value;
    case 'gt':
      return eventValue > value;
    case 'lt':
      return eventValue < value;
    case 'contains':
      return String(eventValue).includes(String(value));
    default:
      return false;
  }
}

async function executeRule(rule: any, event: any) {
  try {
    const actions = rule.actions || [];

    for (const action of actions) {
      switch (action.type) {
        case 'move_to_stage':
          await moveToStage(action, event);
          break;
        case 'notify_team':
          await notifyTeam(action, event);
          break;
        case 'create_task':
          await createTask(action, event);
          break;
      }
    }

    // Record execution
    await pool.query(
      `INSERT INTO automation_executions (rule_id, client_id, deal_id, status, result)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        rule.id,
        event.data?.clientId || event.data?.contactId,
        event.data?.dealId,
        'success',
        JSON.stringify({ actions }),
      ]
    );

    // Publish event
    const automationEvent: AutomationRuleTriggeredEvent = {
      id: crypto.randomUUID(),
      type: EventType.AUTOMATION_RULE_TRIGGERED,
      timestamp: new Date(),
      organizationId: event.organizationId,
      userId: event.userId,
      data: {
        ruleId: rule.id,
        clientId: event.data?.clientId || event.data?.contactId,
        action: action.type,
      },
    };
    await rabbitmq.publishEvent(automationEvent);
  } catch (error) {
    console.error('Error executing automation rule:', error);
  }
}

async function moveToStage(action: any, event: any) {
  // Call pipeline service to move client/deal
  const pipelineServiceUrl = process.env.PIPELINE_SERVICE_URL || 'http://pipeline-service:3008';
  await fetch(`${pipelineServiceUrl}/api/pipeline/clients/${event.data?.clientId || event.data?.contactId}/stage`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stageId: action.targetStageId,
      dealId: event.data?.dealId,
      autoMoved: true,
      reason: `Automated by rule: ${action.ruleName || 'N/A'}`,
    }),
  });
}

async function notifyTeam(action: any, event: any) {
  // Publish notification event
  await rabbitmq.publishEvent({
    id: crypto.randomUUID(),
    type: EventType.TRIGGER_EXECUTED,
    timestamp: new Date(),
    organizationId: event.organizationId,
    data: {
      type: 'notification',
      message: action.message || 'Automation rule triggered',
      userIds: action.userIds || [],
    },
  });
}

async function createTask(action: any, event: any) {
  // TODO: Integrate with task service
  console.log('Create task:', action, event);
}

// Cron job to check time-based rules
function startCronJobs() {
  // Check every hour for time-based automations
  cron.schedule('0 * * * *', async () => {
    try {
      const rules = await pool.query(
        `SELECT * FROM automation_rules 
         WHERE is_active = true 
         AND trigger_type = 'time_elapsed'`
      );

      for (const rule of rules.rows) {
        const triggerConditions = typeof rule.trigger_conditions === 'string' 
          ? JSON.parse(rule.trigger_conditions) 
          : rule.trigger_conditions;
        const { elapsed_hours, stage } = triggerConditions;
        const cutoffTime = new Date(Date.now() - elapsed_hours * 60 * 60 * 1000);

        // Find clients in the stage for longer than elapsed_hours
        const clients = await pool.query(
          `SELECT d.* FROM deals d
           JOIN stages s ON d.stage_id = s.id
           WHERE s.name = $1 AND d.created_at < $2`,
          [stage, cutoffTime]
        );

        for (const client of clients.rows) {
          await executeRule(rule, {
            type: 'time_elapsed',
            organizationId: client.organization_id,
            data: { clientId: client.client_id, dealId: client.id },
          });
        }
      }
    } catch (error) {
      console.error('Error in time-based automation cron:', error);
    }
  });
}

function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
  };
}

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'automation-service' });
});

// Automation Rules
app.get('/api/automation/rules', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      'SELECT * FROM automation_rules WHERE organization_id = $1 ORDER BY created_at DESC',
      [user.organizationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching automation rules:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/automation/rules', async (req, res) => {
  try {
    const user = getUser(req);
    const { name, triggerType, triggerConfig, conditions, actions, is_active } = req.body;

    const result = await pool.query(
      `INSERT INTO automation_rules (organization_id, name, trigger_type, trigger_conditions, actions, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        user.organizationId,
        name,
        triggerType,
        JSON.stringify(triggerConfig || {}),
        JSON.stringify(actions),
        is_active !== false,
      ]
    );

    // Publish event
    await rabbitmq.publishEvent({
      id: crypto.randomUUID(),
      type: EventType.AUTOMATION_RULE_CREATED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { ruleId: result.rows[0].id },
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating automation rule:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Automation service running on port ${PORT}`);
});

