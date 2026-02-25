import express from 'express';
import crypto from 'crypto';
import { Pool } from 'pg';
import { register, Counter } from 'prom-client';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { createLogger } from '@getsale/logger';

const app = express();
const PORT = process.env.PORT || 3008;
const log = createLogger('pipeline-service');

const eventPublishTotal = new Counter({
  name: 'event_publish_total',
  help: 'Events published to RabbitMQ',
  labelNames: ['event_type'],
  registers: [register],
});
const eventPublishFailedTotal = new Counter({
  name: 'event_publish_failed_total',
  help: 'Event publish failures',
  labelNames: ['event_type'],
  registers: [register],
});

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

app.get('/ready', async (_req, res) => {
  const checks: { postgres?: boolean; rabbitmq?: boolean } = {};
  try {
    await pool.query('SELECT 1');
    checks.postgres = true;
  } catch {
    checks.postgres = false;
  }
  try {
    checks.rabbitmq = rabbitmq.isConnected();
  } catch {
    checks.rabbitmq = false;
  }
  const ok = checks.postgres === true;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not ready', checks });
});

app.get('/metrics', async (_req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
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

const DEFAULT_STAGES = [
  { name: 'Lead', order_index: 0, color: '#3B82F6' },
  { name: 'Qualified', order_index: 1, color: '#10B981' },
  { name: 'Proposal', order_index: 2, color: '#F59E0B' },
  { name: 'Negotiation', order_index: 3, color: '#EF4444' },
  { name: 'Closed Won', order_index: 4, color: '#8B5CF6' },
  { name: 'Closed Lost', order_index: 5, color: '#6B7280' },
  { name: 'Converted', order_index: 6, color: '#059669' }, // системная финальная стадия (лид конвертирован в сделку)
];

app.post('/api/pipeline', async (req, res) => {
  try {
    const user = getUser(req);
    const { name, description, isDefault } = req.body;

    if (isDefault === true) {
      await pool.query(
        'UPDATE pipelines SET is_default = false WHERE organization_id = $1',
        [user.organizationId]
      );
    }

    const result = await pool.query(
      `INSERT INTO pipelines (organization_id, name, description, is_default)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [user.organizationId, name ?? 'New Pipeline', description ?? null, isDefault || false]
    );
    const pipeline = result.rows[0];
    const pipelineId = pipeline.id;

    for (const stage of DEFAULT_STAGES) {
      await pool.query(
        `INSERT INTO stages (pipeline_id, organization_id, name, order_index, color)
         VALUES ($1, $2, $3, $4, $5)`,
        [pipelineId, user.organizationId, stage.name, stage.order_index, stage.color]
      );
    }

    res.status(201).json(pipeline);
  } catch (error) {
    console.error('Error creating pipeline:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/pipeline/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { name, description, isDefault } = req.body;

    const existing = await pool.query(
      'SELECT id FROM pipelines WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }

    const updates: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    let idx = 1;
    if (name !== undefined) {
      params.push(name);
      updates.push(`name = $${idx++}`);
    }
    if (description !== undefined) {
      params.push(description ?? null);
      updates.push(`description = $${idx++}`);
    }
    if (isDefault !== undefined) {
      if (isDefault === true) {
        await pool.query(
          'UPDATE pipelines SET is_default = false WHERE organization_id = $1',
          [user.organizationId]
        );
      }
      params.push(!!isDefault);
      updates.push(`is_default = $${idx++}`);
    }
    if (params.length === 0) {
      const r = await pool.query('SELECT * FROM pipelines WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);
      return res.json(r.rows[0]);
    }
    params.push(id, user.organizationId);
    const result = await pool.query(
      `UPDATE pipelines SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
      params
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating pipeline:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/pipeline/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT id FROM pipelines WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }

    await pool.query('DELETE FROM leads WHERE pipeline_id = $1', [id]);
    await pool.query('DELETE FROM stages WHERE pipeline_id = $1', [id]);
    await pool.query('DELETE FROM pipelines WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting pipeline:', error);
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
    } as Event);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/pipeline/stages/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { name, orderIndex, color, automationRules, entryRules, exitRules, allowedActions } = req.body;

    const existing = await pool.query(
      'SELECT * FROM stages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Stage not found' });
    }

    const updates: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    let idx = 1;
    if (name !== undefined) {
      params.push(name);
      updates.push(`name = $${idx++}`);
    }
    if (typeof orderIndex === 'number') {
      params.push(orderIndex);
      updates.push(`order_index = $${idx++}`);
    }
    if (color !== undefined) {
      params.push(color ?? null);
      updates.push(`color = $${idx++}`);
    }
    if (automationRules !== undefined) {
      params.push(JSON.stringify(automationRules || []));
      updates.push(`automation_rules = $${idx++}`);
    }
    if (entryRules !== undefined) {
      params.push(JSON.stringify(entryRules || []));
      updates.push(`entry_rules = $${idx++}`);
    }
    if (exitRules !== undefined) {
      params.push(JSON.stringify(exitRules || []));
      updates.push(`exit_rules = $${idx++}`);
    }
    if (allowedActions !== undefined) {
      params.push(JSON.stringify(allowedActions || []));
      updates.push(`allowed_actions = $${idx++}`);
    }
    if (params.length === 0) {
      return res.json(existing.rows[0]);
    }
    params.push(id, user.organizationId);
    const result = await pool.query(
      `UPDATE stages SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
      params
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/pipeline/stages/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT * FROM stages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Stage not found' });
    }
    const pipelineId = existing.rows[0].pipeline_id;

    const leadCount = await pool.query('SELECT COUNT(*) AS cnt FROM leads WHERE stage_id = $1', [id]);
    if (parseInt(leadCount.rows[0]?.cnt || '0', 10) > 0) {
      const firstOther = await pool.query(
        'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 AND id != $3 ORDER BY order_index ASC LIMIT 1',
        [pipelineId, user.organizationId, id]
      );
      if (firstOther.rows.length > 0) {
        await pool.query('UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE stage_id = $2', [firstOther.rows[0].id, id]);
      } else {
        return res.status(400).json({ error: 'Cannot delete the only stage. Add another stage first or move leads out.' });
      }
    }

    await pool.query('DELETE FROM stages WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @deprecated This endpoint proxies deal stage changes to CRM (when body.dealId is set).
 * Will be removed after migration. Use PATCH /api/crm/deals/:id/stage for deal stage transitions.
 */
// Move client to stage (deals: proxy to CRM; leads: not used here — use PATCH /api/pipeline/leads/:id)
app.put('/api/pipeline/clients/:clientId/stage', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { stageId, dealId, reason, autoMoved } = req.body;

    const dealIdFromBody = dealId || null;
    const dealIdFromPath = dealIdFromBody
      ? null
      : (await pool.query('SELECT id FROM deals WHERE id = $1', [clientId])).rows[0]?.id || null;
    const resolvedDealId = dealIdFromBody || dealIdFromPath;

    if (resolvedDealId && stageId) {
      const crmUrl = process.env.CRM_SERVICE_URL || 'http://crm-service:3002';
      const dealRow = await pool.query(
        'SELECT organization_id FROM deals WHERE id = $1',
        [resolvedDealId]
      );
      if (dealRow.rows.length === 0) {
        return res.status(404).json({ error: 'Deal not found' });
      }
      const organizationId = dealRow.rows[0].organization_id;
      const userRow = await pool.query(
        'SELECT id FROM users WHERE organization_id = $1 LIMIT 1',
        [organizationId]
      );
      const userId = userRow.rows[0]?.id || '';
      const proxyRes = await fetch(`${crmUrl}/api/crm/deals/${resolvedDealId}/stage`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': userId,
          'X-Organization-Id': organizationId,
        },
        body: JSON.stringify({ stageId, reason, autoMoved: !!autoMoved }),
      });
      if (!proxyRes.ok) {
        const text = await proxyRes.text();
        return res.status(proxyRes.status >= 500 ? 502 : proxyRes.status).json({
          error: 'CRM deal stage update failed',
          detail: text,
        });
      }
      const data = await proxyRes.json().catch(() => ({}));
      return res.json(data);
    }

    return res.status(400).json({
      error: 'Deal stage changes must be done via CRM. Use PATCH /api/crm/deals/:id/stage or provide dealId in body.',
    });
  } catch (error) {
    console.error('Error moving client to stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Leads (контакты в воронке) ---

// Pipelines that contain this contact (for "add to funnel" — показать, в каких воронках контакт уже есть).
app.get('/api/pipeline/contacts/:contactId/pipelines', async (req, res) => {
  try {
    const user = getUser(req);
    const contactId = req.params.contactId?.trim();
    if (!contactId) {
      return res.status(400).json({ error: 'contactId is required' });
    }
    const result = await pool.query(
      `SELECT l.pipeline_id FROM leads l
       WHERE l.organization_id = $1 AND l.contact_id = $2`,
      [user.organizationId, contactId]
    );
    res.json({ pipelineIds: result.rows.map((r: any) => r.pipeline_id) });
  } catch (error) {
    console.error('Error fetching contact pipelines:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List leads for a pipeline (for Kanban or List view). Optional stageId filter; pagination for list view.
app.get('/api/pipeline/leads', async (req, res) => {
  try {
    const user = getUser(req);
    const { pipelineId, stageId, page, limit } = req.query;
    if (!pipelineId || typeof pipelineId !== 'string') {
      return res.status(400).json({ error: 'pipelineId is required' });
    }
    const pipelineIdTrim = pipelineId.trim();
    const stageIdTrim = typeof stageId === 'string' ? stageId.trim() : null;
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));

    const params: any[] = [user.organizationId, pipelineIdTrim];
    let where = 'l.organization_id = $1 AND l.pipeline_id = $2';
    if (stageIdTrim) {
      params.push(stageIdTrim);
      where += ` AND l.stage_id = $${params.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM leads l WHERE ${where}`,
      params
    );
    const total = countResult.rows[0]?.total ?? 0;

    const orderBy = 'ORDER BY l.order_index ASC, l.created_at ASC';
    const limitClause = `LIMIT ${limitNum} OFFSET ${(pageNum - 1) * limitNum}`;
    const result = await pool.query(
      `SELECT l.id, l.contact_id, l.pipeline_id, l.stage_id, l.order_index, l.created_at, l.updated_at,
        c.first_name, c.last_name, c.display_name, c.username, c.email, c.telegram_id
       FROM leads l
       JOIN contacts c ON c.id = l.contact_id AND c.organization_id = l.organization_id
       WHERE ${where} ${orderBy} ${limitClause}`,
      params
    );

    res.json({
      items: result.rows,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add contact to funnel (create lead). stageId defaults to first stage of pipeline. Optional responsibleId (user uuid) for lead owner.
app.post('/api/pipeline/leads', async (req, res) => {
  try {
    const user = getUser(req);
    const { contactId, pipelineId, stageId, responsibleId } = req.body;
    if (!contactId || !pipelineId) {
      return res.status(400).json({ error: 'contactId and pipelineId are required' });
    }

    const contactCheck = await pool.query(
      'SELECT 1 FROM contacts WHERE id = $1 AND organization_id = $2',
      [contactId, user.organizationId]
    );
    if (contactCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const pipelineCheck = await pool.query(
      'SELECT 1 FROM pipelines WHERE id = $1 AND organization_id = $2',
      [pipelineId, user.organizationId]
    );
    if (pipelineCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }

    let targetStageId = stageId;
    if (!targetStageId) {
      const firstStage = await pool.query(
        'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index ASC LIMIT 1',
        [pipelineId, user.organizationId]
      );
      if (firstStage.rows.length === 0) {
        return res.status(400).json({ error: 'Pipeline has no stages' });
      }
      targetStageId = firstStage.rows[0].id;
    } else {
      const stageCheck = await pool.query(
        'SELECT 1 FROM stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3',
        [targetStageId, pipelineId, user.organizationId]
      );
      if (stageCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Stage not found or does not belong to pipeline' });
      }
    }

    const existing = await pool.query(
      'SELECT id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3',
      [user.organizationId, contactId, pipelineId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Contact is already in this pipeline', code: 'ALREADY_IN_PIPELINE', leadId: existing.rows[0].id });
    }

    let responsibleIdValid: string | null = null;
    if (responsibleId && typeof responsibleId === 'string') {
      const userCheck = await pool.query(
        'SELECT id FROM users WHERE id = $1 AND id IN (SELECT user_id FROM organization_members WHERE organization_id = $2)',
        [responsibleId, user.organizationId]
      );
      if (userCheck.rows.length > 0) responsibleIdValid = responsibleId;
    }

    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM leads WHERE stage_id = $1',
      [targetStageId]
    );
    const orderIndex = maxOrder.rows[0]?.next ?? 0;

    const insert = await pool.query(
      `INSERT INTO leads (organization_id, contact_id, pipeline_id, stage_id, order_index, responsible_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user.organizationId, contactId, pipelineId, targetStageId, orderIndex, responsibleIdValid]
    );
    try {
      await rabbitmq.publishEvent({
        id: crypto.randomUUID(),
        type: EventType.LEAD_CREATED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { contactId, pipelineId, stageId: targetStageId, leadId: insert.rows[0].id },
      } as Event);
    } catch (e) {
      console.error('Failed to publish LEAD_CREATED:', e);
    }
    res.status(201).json(insert.rows[0]);
  } catch (error) {
    console.error('Error creating lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update lead (move to stage / reorder). Converted — финальная стадия, переходы из неё запрещены.
app.patch('/api/pipeline/leads/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { stageId, orderIndex } = req.body;

    const existing = await pool.query(
      'SELECT l.*, s.name AS stage_name FROM leads l JOIN stages s ON s.id = l.stage_id WHERE l.id = $1 AND l.organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    if (stageId != null && String((existing.rows[0] as any).stage_name) === 'Converted') {
      return res.status(400).json({ error: 'Cannot move lead from Converted stage' });
    }

    const updates: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    let idx = 1;

    if (stageId != null) {
      const stageCheck = await pool.query(
        'SELECT 1 FROM stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3',
        [stageId, existing.rows[0].pipeline_id, user.organizationId]
      );
      if (stageCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Stage not found' });
      }
      params.push(stageId);
      updates.push(`stage_id = $${idx++}`);
    }
    if (typeof orderIndex === 'number') {
      params.push(orderIndex);
      updates.push(`order_index = $${idx++}`);
    }

    if (params.length === 0) {
      return res.json(existing.rows[0]);
    }
    params.push(id, user.organizationId);
    const result = await pool.query(
      `UPDATE leads SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
      params
    );
    const fromStageId = existing.rows[0].stage_id;
    if (stageId != null && fromStageId !== stageId) {
      const eventId = crypto.randomUUID();
      const event = {
        id: eventId,
        type: EventType.LEAD_STAGE_CHANGED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: {
          contactId: existing.rows[0].contact_id,
          pipelineId: existing.rows[0].pipeline_id,
          fromStageId,
          toStageId: stageId,
          leadId: id,
          correlationId: eventId,
        },
      } as Event;
      try {
        log.info({
          message: 'publish lead.stage.changed',
          event_id: eventId,
          correlation_id: eventId,
          entity_type: 'lead',
          entity_id: id,
        });
        await rabbitmq.publishEvent(event);
        eventPublishTotal.inc({ event_type: EventType.LEAD_STAGE_CHANGED });
      } catch (e) {
        eventPublishFailedTotal.inc({ event_type: EventType.LEAD_STAGE_CHANGED });
        log.error({
          message: 'Failed to publish LEAD_STAGE_CHANGED',
          event_id: eventId,
          correlation_id: eventId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove lead from funnel
app.delete('/api/pipeline/leads/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM leads WHERE id = $1 AND organization_id = $2 RETURNING id',
      [id, user.organizationId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Pipeline service running on port ${PORT}`);
});

