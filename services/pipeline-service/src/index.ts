import express from 'express';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';

const app = express();
const PORT = process.env.PORT || 3008;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

(async () => {
  try {
    await rabbitmq.connect();
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event publishing:', error);
  }
})();

function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
  };
}

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pipeline-service' });
});

// Pipelines
app.get('/api/pipeline', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      'SELECT * FROM pipelines WHERE organization_id = $1 ORDER BY created_at DESC',
      [user.organizationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pipelines:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pipeline', async (req, res) => {
  try {
    const user = getUser(req);
    const { name, description, isDefault } = req.body;

    const result = await pool.query(
      `INSERT INTO pipelines (organization_id, name, description, is_default)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [user.organizationId, name, description, isDefault || false]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating pipeline:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stages
app.get('/api/pipeline/stages', async (req, res) => {
  try {
    const user = getUser(req);
    const { pipelineId } = req.query;

    let query = 'SELECT * FROM stages WHERE organization_id = $1';
    const params: any[] = [user.organizationId];

    if (pipelineId) {
      query += ' AND pipeline_id = $2';
      params.push(pipelineId);
    }

    query += ' ORDER BY order_index ASC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching stages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pipeline/stages', async (req, res) => {
  try {
    const user = getUser(req);
    const { pipelineId, name, orderIndex, color, automationRules, entryRules, exitRules, allowedActions } = req.body;

    const result = await pool.query(
      `INSERT INTO stages (pipeline_id, organization_id, name, order_index, color, automation_rules, entry_rules, exit_rules, allowed_actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        pipelineId,
        user.organizationId,
        name,
        orderIndex,
        color,
        JSON.stringify(automationRules || []),
        JSON.stringify(entryRules || []),
        JSON.stringify(exitRules || []),
        JSON.stringify(allowedActions || []),
      ]
    );

    // Publish event
    await rabbitmq.publishEvent({
      id: crypto.randomUUID(),
      type: EventType.STAGE_CREATED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { stageId: result.rows[0].id, pipelineId },
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Move client to stage
app.put('/api/pipeline/clients/:clientId/stage', async (req, res) => {
  try {
    const user = getUser(req);
    const { clientId } = req.params;
    const { stageId, dealId, reason, autoMoved } = req.body;

    // Get current stage from deal or client
    const currentStageResult = await pool.query(
      'SELECT stage_id FROM deals WHERE id = $1 OR client_id = $1',
      [dealId || clientId]
    );

    const fromStageId = currentStageResult.rows[0]?.stage_id;

    // Save history
    await pool.query(
      `INSERT INTO stage_history (client_id, deal_id, from_stage_id, to_stage_id, moved_by, auto_moved, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [clientId, dealId, fromStageId, stageId, user.id, autoMoved || false, reason]
    );

    // Update deal stage
    if (dealId) {
      await pool.query(
        'UPDATE deals SET stage_id = $1, updated_at = NOW() WHERE id = $2',
        [stageId, dealId]
      );
    }

    // Publish event
    await rabbitmq.publishEvent({
      id: crypto.randomUUID(),
      type: EventType.DEAL_STAGE_CHANGED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { dealId: dealId || clientId, fromStageId, toStageId: stageId, reason, autoMoved },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error moving client to stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Pipeline service running on port ${PORT}`);
});

