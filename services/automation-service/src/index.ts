import crypto from 'node:crypto';
import express from 'express';
import { Pool } from 'pg';
import cron from 'node-cron';
import { register, Counter } from 'prom-client';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, AutomationRuleTriggeredEvent, Event } from '@getsale/events';
import { createLogger } from '@getsale/logger';

const app = express();
const PORT = process.env.PORT || 3009;
const log = createLogger('automation-service');

const automationEventsTotal = new Counter({
  name: 'automation_events_total',
  help: 'Total events consumed by automation',
  labelNames: ['event_type'],
  registers: [register],
});
const automationProcessedTotal = new Counter({ name: 'automation_processed_total', help: 'Events processed successfully', registers: [register] });
const automationSkippedTotal = new Counter({ name: 'automation_skipped_total', help: 'Events skipped (e.g. already executed)', registers: [register] });
const automationFailedTotal = new Counter({ name: 'automation_failed_total', help: 'Events that failed processing', registers: [register] });
const dealCreatedTotal = new Counter({ name: 'deal_created_total', help: 'Deals created by automation', registers: [register] });
const automationDlqTotal = new Counter({ name: 'automation_dlq_total', help: 'Events sent to DLQ after retries exceeded', labelNames: ['event_type'], registers: [register] });
const automationSlaProcessedTotal = new Counter({ name: 'automation_sla_processed_total', help: 'SLA breach events processed', registers: [register] });
const automationSlaSkippedTotal = new Counter({ name: 'automation_sla_skipped_total', help: 'SLA breach events skipped (already executed for this breach_date)', registers: [register] });
const automationSlaPublishedTotal = new Counter({ name: 'automation_sla_published_total', help: 'SLA breach events published by cron', labelNames: ['event_type'], registers: [register] });

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
    log.error({ message: 'Failed to connect to RabbitMQ, service will continue without event subscription', error: String(error) });
  }
  startCronJobs();
})();

async function subscribeToEvents() {
  await rabbitmq.subscribeToEvents(
    [
      EventType.MESSAGE_RECEIVED,
      EventType.DEAL_STAGE_CHANGED,
      EventType.CONTACT_CREATED,
      EventType.LEAD_STAGE_CHANGED,
      EventType.LEAD_SLA_BREACH,
      EventType.DEAL_SLA_BREACH,
    ],
    async (event) => {
      await processEvent(event);
    },
    'events',
    'automation-service'
  );
}

async function processEvent(event: any) {
  try {
    // ЭТАП 4: lead.stage.changed — вертикальный срез (create_deal по одному правилу)
    if (event.type === EventType.LEAD_STAGE_CHANGED) {
      automationEventsTotal.inc({ event_type: EventType.LEAD_STAGE_CHANGED });
      const correlationId = event.data?.correlationId ?? event.id;
      log.info({
        message: 'consume lead.stage.changed',
        correlation_id: correlationId,
        event_id: event.id,
        entity_type: 'lead',
        entity_id: event.data?.leadId,
      });
      await processLeadStageChanged(event, correlationId);
      return;
    }

    // ЭТАП 6: SLA breach — один обработчик на оба типа
    if (event.type === EventType.LEAD_SLA_BREACH || event.type === EventType.DEAL_SLA_BREACH) {
      automationEventsTotal.inc({ event_type: event.type });
      const correlationId = event.data?.correlationId ?? event.id;
      log.info({
        message: event.type === EventType.LEAD_SLA_BREACH ? 'consume lead.sla.breach' : 'consume deal.sla.breach',
        correlation_id: correlationId,
        event_id: event.id,
        entity_type: event.type === EventType.LEAD_SLA_BREACH ? 'lead' : 'deal',
        entity_id: event.data?.leadId ?? event.data?.dealId,
        breach_date: event.data?.breachDate,
      });
      await processSlaBreach(event, correlationId);
      return;
    }

    // Get enabled rules for this event type
    const rules = await pool.query(
      `SELECT * FROM automation_rules 
       WHERE is_active = true 
       AND trigger_type = $1 
       AND organization_id = $2`,
      [event.type, event.organizationId]
    );

    for (const rule of rules.rows) {
      const triggerConditions = typeof rule.trigger_conditions === 'string'
        ? JSON.parse(rule.trigger_conditions)
        : rule.trigger_conditions;
      const conditions = typeof rule.conditions === 'string'
        ? JSON.parse(rule.conditions)
        : (rule.conditions || []);
      let shouldExecute = true;

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
    log.error({ message: 'Error processing automation event', error: String(error) });
  }
}

/**
 * ЭТАП 4: обработка lead.stage.changed.
 * Порядок (критично): вызов CRM → при 201/409 → INSERT execution → return (ACK).
 * НЕ вставлять execution до вызова CRM: иначе при падении между INSERT и CRM получим «записано success, сделки нет».
 * При 23505 (unique) — не бросать exception, иначе redelivery.
 */
async function processLeadStageChanged(event: any, correlationId: string) {
  const { organizationId, data } = event;
  const leadId = data?.leadId;
  const pipelineId = data?.pipelineId;
  const toStageId = data?.toStageId;
  const userId = event.userId;

  if (!organizationId || !leadId || !pipelineId || !toStageId) {
    log.warn({
      message: 'lead.stage.changed missing required fields',
      correlation_id: correlationId,
      event_id: event.id,
      organizationId: organizationId ?? null,
      leadId: leadId ?? null,
      pipelineId: pipelineId ?? null,
      toStageId: toStageId ?? null,
    });
    return;
  }

  const rules = await pool.query(
    `SELECT * FROM automation_rules 
     WHERE is_active = true 
     AND trigger_type = $1 
     AND organization_id = $2`,
    [EventType.LEAD_STAGE_CHANGED, organizationId]
  );

  for (const rule of rules.rows) {
    const triggerConditions =
      typeof rule.trigger_conditions === 'string'
        ? JSON.parse(rule.trigger_conditions)
        : rule.trigger_conditions || {};
    if (triggerConditions.pipeline_id !== pipelineId || triggerConditions.to_stage_id !== toStageId) {
      continue;
    }

    const actions = typeof rule.actions === 'string' ? JSON.parse(rule.actions || '[]') : rule.actions || [];
    const createDealAction = actions.find((a: any) => a.type === 'create_deal');
    if (!createDealAction) continue;

    // Идемпотентность: уже есть execution для (rule_id, lead, leadId)?
    const existing = await pool.query(
      `SELECT id FROM automation_executions 
       WHERE rule_id = $1 AND entity_type = 'lead' AND entity_id = $2`,
      [rule.id, leadId]
    );
    if (existing.rows.length > 0) {
      automationSkippedTotal.inc();
      log.info({
        message: 'lead.stage.changed skip (already executed)',
        correlation_id: correlationId,
        event_id: event.id,
        rule_id: rule.id,
        entity_type: 'lead',
        entity_id: leadId,
        status: 'skipped',
      });
      continue;
    }

    const crmServiceUrl = process.env.CRM_SERVICE_URL || 'http://crm-service:3002';
    const MAX_CRM_RETRIES = 3;
    let dealId: string | null = null;
    let status: 'success' | 'skipped' | 'failed' = 'success';

    let effectiveUserId = userId;
    if (!effectiveUserId) {
      const userRow = await pool.query(
        'SELECT id FROM users WHERE organization_id = $1 LIMIT 1',
        [organizationId]
      );
      effectiveUserId = userRow.rows[0]?.id ?? '';
    }

    for (let attempt = 1; attempt <= MAX_CRM_RETRIES; attempt++) {
      try {
        const res = await fetch(`${crmServiceUrl}/api/crm/deals`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': effectiveUserId,
            'X-Organization-Id': organizationId,
            'X-Correlation-Id': correlationId,
          },
          body: JSON.stringify({
            leadId,
            pipelineId,
            contactId: data?.contactId,
            title: `Deal from lead ${leadId.slice(0, 8)}`,
          }),
        });

        if (res.status === 201) {
          const body = (await res.json()) as { id?: string };
          dealId = body.id ?? null;
          dealCreatedTotal.inc();
          break;
        }
        if (res.status === 409) {
          status = 'skipped';
          automationSkippedTotal.inc();
          break;
        }
        status = 'failed';
        log.error({
          message: 'lead.stage.changed CRM returned non-success',
          correlation_id: correlationId,
          event_id: event.id,
          rule_id: rule.id,
          entity_id: leadId,
          status: 'failed',
          http_status: res.status,
          response: await res.text(),
          attempt,
        });
        if (attempt < MAX_CRM_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      } catch (err) {
        status = 'failed';
        log.error({
          message: 'lead.stage.changed CRM call failed',
          correlation_id: correlationId,
          event_id: event.id,
          rule_id: rule.id,
          entity_id: leadId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          attempt,
        });
        if (attempt < MAX_CRM_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }

    if (status === 'failed') {
      automationFailedTotal.inc();
      try {
        await rabbitmq.publishToDlq('lead.stage.changed.dlq', event);
        automationDlqTotal.inc({ event_type: EventType.LEAD_STAGE_CHANGED });
        log.warn({
          message: 'lead.stage.changed sent to DLQ after retries exceeded',
          correlation_id: correlationId,
          event_id: event.id,
          entity_type: 'lead',
          entity_id: leadId,
        });
      } catch (dlqErr) {
        log.error({
          message: 'Failed to publish to DLQ',
          correlation_id: correlationId,
          event_id: event.id,
          error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
        });
      }
    }

    try {
      await pool.query(
        `INSERT INTO automation_executions 
         (rule_id, organization_id, trigger_event, status, entity_type, entity_id, deal_id, correlation_id, trigger_event_id, created_at)
         VALUES ($1, $2, $3, $4, 'lead', $5, $6, $7, $8, NOW())`,
        [rule.id, organizationId, event.type, status, leadId, dealId, correlationId, event.id ?? null]
      );
    } catch (insertErr: any) {
      if (insertErr?.code === '23505') {
        // Два consumer получили одно событие: один 201, другой 409; оба пытаются INSERT — второй получает unique violation.
        // Считаем успехом и НЕ бросаем exception, иначе будет redelivery.
        automationSkippedTotal.inc();
        log.info({
          message: 'lead.stage.changed execution already exists (unique), treat as success, ACK',
          correlation_id: correlationId,
          event_id: event.id,
          rule_id: rule.id,
          entity_type: 'lead',
          entity_id: leadId,
          status: 'skipped',
        });
        continue;
      }
      throw insertErr;
    }

    if (status === 'success') automationProcessedTotal.inc();
    log.info({
      message: 'lead.stage.changed processed',
      correlation_id: correlationId,
      event_id: event.id,
      rule_id: rule.id,
      entity_type: 'lead',
      entity_id: leadId,
      status,
      deal_id: dealId ?? undefined,
    });
  }
}

/**
 * ЭТАП 6: обработка lead.sla.breach и deal.sla.breach.
 * Матч правил по trigger_type и trigger_conditions (pipeline_id, stage_id); выполнение actions; INSERT execution с breach_date.
 * При 23505 — already processed, ACK (Design Lock §0.3).
 */
async function processSlaBreach(event: any, correlationId: string) {
  const { organizationId, data } = event;
  const breachDate = data?.breachDate;
  const pipelineId = data?.pipelineId;
  const stageId = data?.stageId;
  const isLead = event.type === EventType.LEAD_SLA_BREACH;
  const entityId = isLead ? data?.leadId : data?.dealId;

  if (!organizationId || !breachDate || !pipelineId || !stageId || !entityId) {
    log.warn({
      message: 'sla.breach missing required fields',
      correlation_id: correlationId,
      event_id: event.id,
      organizationId: organizationId ?? null,
      breachDate: breachDate ?? null,
      pipelineId: pipelineId ?? null,
      stageId: stageId ?? null,
      entity_id: entityId ?? null,
    });
    return;
  }

  const rules = await pool.query(
    `SELECT * FROM automation_rules 
     WHERE is_active = true 
     AND trigger_type = $1 
     AND organization_id = $2`,
    [event.type, organizationId]
  );

  for (const rule of rules.rows) {
    const triggerConditions =
      typeof rule.trigger_conditions === 'string'
        ? JSON.parse(rule.trigger_conditions)
        : rule.trigger_conditions || {};
    if (triggerConditions.pipeline_id !== pipelineId || triggerConditions.stage_id !== stageId) {
      continue;
    }

    const actions = typeof rule.actions === 'string' ? JSON.parse(rule.actions || '[]') : rule.actions || [];
    for (const action of actions) {
      try {
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
      } catch (err) {
        log.error({
          message: 'sla.breach action failed',
          correlation_id: correlationId,
          event_id: event.id,
          rule_id: rule.id,
          action_type: action.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const entityType = isLead ? 'lead' : 'deal';
    const dealId = isLead ? null : entityId;

    try {
      await pool.query(
        `INSERT INTO automation_executions 
         (rule_id, organization_id, trigger_event, status, entity_type, entity_id, deal_id, correlation_id, trigger_event_id, breach_date, created_at)
         VALUES ($1, $2, $3, 'success', $4, $5, $6, $7, $8, $9::date, NOW())`,
        [rule.id, organizationId, event.type, entityType, entityId, dealId, correlationId, event.id ?? null, breachDate]
      );
      automationSlaProcessedTotal.inc();
      log.info({
        message: isLead ? 'lead.sla.breach processed' : 'deal.sla.breach processed',
        correlation_id: correlationId,
        event_id: event.id,
        rule_id: rule.id,
        entity_type: entityType,
        entity_id: entityId,
        breach_date: breachDate,
      });
    } catch (insertErr: any) {
      if (insertErr?.code === '23505') {
        automationSlaSkippedTotal.inc();
        log.info({
          message: 'sla.breach execution already exists (unique), skip, ACK',
          correlation_id: correlationId,
          event_id: event.id,
          rule_id: rule.id,
          entity_type: entityType,
          entity_id: entityId,
          breach_date: breachDate,
          status: 'skipped',
        });
        continue;
      }
      throw insertErr;
    }
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

    // Publish event (use last action type for event payload)
    const lastActionType = actions.length > 0 ? actions[actions.length - 1].type : 'executed';
    const automationEvent: AutomationRuleTriggeredEvent = {
      id: crypto.randomUUID(),
      type: EventType.AUTOMATION_RULE_TRIGGERED,
      timestamp: new Date(),
      organizationId: event.organizationId,
      userId: event.userId,
      data: {
        ruleId: rule.id,
        clientId: event.data?.clientId || event.data?.contactId,
        action: lastActionType,
      },
    };
    await rabbitmq.publishEvent(automationEvent);
  } catch (error) {
    console.error('Error executing automation rule:', error);
  }
}

async function moveToStage(action: any, event: any) {
  const dealId = event.data?.dealId;
  const organizationId = event.organizationId;
  if (dealId && organizationId && action.targetStageId) {
    const crmServiceUrl = process.env.CRM_SERVICE_URL || 'http://crm-service:3002';
    const userRow = await pool.query(
      'SELECT id FROM users WHERE organization_id = $1 LIMIT 1',
      [organizationId]
    );
    const userId = event.userId || userRow.rows[0]?.id || '';
    await fetch(`${crmServiceUrl}/api/crm/deals/${dealId}/stage`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
        'X-Organization-Id': organizationId,
      },
      body: JSON.stringify({
        stageId: action.targetStageId,
        reason: `Automated by rule: ${action.ruleName || 'N/A'}`,
        autoMoved: true,
      }),
    });
    return;
  }
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
  const triggerEvent = {
    id: crypto.randomUUID(),
    type: EventType.TRIGGER_EXECUTED,
    timestamp: new Date(),
    organizationId: event.organizationId,
    userId: event.userId,
    data: {
      type: 'notification',
      ruleId: '',
      message: action.message || 'Automation rule triggered',
      userIds: action.userIds || [],
    },
  };
  await rabbitmq.publishEvent(triggerEvent as Event);
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

  // ЭТАП 6: SLA cron (минимальная версия — 1 правило, 1 сущность, раз в час)
  cron.schedule('0 * * * *', async () => {
    try {
      await runSlaCronOnce();
    } catch (error) {
      log.error({ message: 'sla cron failed', error: String(error) });
    }
  });
}

/** ЭТАП 6: одна итерация SLA cron (1 правило, 1 сущность). Используется cron и внутренним endpoint для e2e.
 *  filterOrgId — опционально (для E2E): брать только правила этой организации.
 *  filterLeadId — опционально (для E2E): публиковать только для этого лида (иначе LIMIT 1 даёт произвольный лид при нескольких в стадии). */
async function runSlaCronOnce(filterOrgId?: string, filterLeadId?: string): Promise<void> {
  const ruleQuery =
    filterOrgId != null
      ? `SELECT * FROM automation_rules 
         WHERE is_active = true 
         AND trigger_type IN ('lead.sla.breach', 'deal.sla.breach')
         AND organization_id = $1
         ORDER BY created_at DESC
         LIMIT 1`
      : `SELECT * FROM automation_rules 
         WHERE is_active = true 
         AND trigger_type IN ('lead.sla.breach', 'deal.sla.breach')
         ORDER BY created_at DESC
         LIMIT 1`;
  const ruleParams = filterOrgId != null ? [filterOrgId] : [];
  const ruleRow = await pool.query(ruleQuery, ruleParams);
  if (ruleRow.rows.length === 0) {
    log.info({ message: 'sla cron: no rule found', filter_org_id: filterOrgId ?? null });
    return;
  }

  const rule = ruleRow.rows[0];
  const triggerConditions =
    typeof rule.trigger_conditions === 'string'
      ? JSON.parse(rule.trigger_conditions)
      : rule.trigger_conditions || {};
  const { pipeline_id, stage_id, max_days } = triggerConditions;
  if (!pipeline_id || !stage_id || max_days == null) {
    log.info({ message: 'sla cron: rule missing pipeline_id/stage_id/max_days', rule_id: rule.id });
    return;
  }

  const organizationId = rule.organization_id;
  const now = new Date();
  const breachDate = now.toISOString().slice(0, 10); // YYYY-MM-DD UTC (минимальная версия)
  const cutoff = new Date(now.getTime() - Number(max_days) * 24 * 60 * 60 * 1000);

  if (rule.trigger_type === EventType.LEAD_SLA_BREACH) {
    const leadParams: (string | Date)[] = [pipeline_id, stage_id, organizationId, cutoff];
    const leadWhere =
      filterLeadId != null
        ? `AND id = $${leadParams.length + 1}`
        : '';
    if (filterLeadId != null) leadParams.push(filterLeadId);
    const leadRow = await pool.query(
      `SELECT id, contact_id, pipeline_id, stage_id, organization_id, updated_at 
       FROM leads 
       WHERE pipeline_id = $1 AND stage_id = $2 AND organization_id = $3 AND updated_at < $4 ${leadWhere}
       LIMIT 1`,
      leadParams
    );
    if (leadRow.rows.length === 0) {
      log.info({
        message: 'sla cron: no lead found for rule',
        rule_id: rule.id,
        pipeline_id,
        stage_id,
        organization_id: organizationId,
        cutoff: cutoff.toISOString(),
      });
      return;
    }
    const lead = leadRow.rows[0];
    const eventId = crypto.randomUUID();
    const updatedAt = lead.updated_at ? new Date(lead.updated_at).getTime() : now.getTime();
    const event = {
      id: eventId,
      type: EventType.LEAD_SLA_BREACH,
      timestamp: new Date(),
      organizationId,
      userId: undefined,
      data: {
        leadId: lead.id,
        pipelineId: lead.pipeline_id,
        stageId: lead.stage_id,
        organizationId,
        contactId: lead.contact_id,
        daysInStage: Math.floor((now.getTime() - updatedAt) / (24 * 60 * 60 * 1000)),
        breachDate,
        correlationId: eventId,
      },
    };
    await rabbitmq.publishEvent(event as Event);
    automationSlaPublishedTotal.inc({ event_type: EventType.LEAD_SLA_BREACH });
    log.info({ message: 'sla cron published lead.sla.breach', rule_id: rule.id, lead_id: lead.id, breach_date: breachDate });
  } else {
    const dealRow = await pool.query(
      `SELECT id, pipeline_id, stage_id, organization_id, updated_at 
       FROM deals 
       WHERE pipeline_id = $1 AND stage_id = $2 AND organization_id = $3 AND updated_at < $4 
       LIMIT 1`,
      [pipeline_id, stage_id, organizationId, cutoff]
    );
    if (dealRow.rows.length === 0) return;
    const deal = dealRow.rows[0];
    const eventId = crypto.randomUUID();
    const dealUpdatedAt = deal.updated_at ? new Date(deal.updated_at).getTime() : now.getTime();
    const event = {
      id: eventId,
      type: EventType.DEAL_SLA_BREACH,
      timestamp: new Date(),
      organizationId,
      userId: undefined,
      data: {
        dealId: deal.id,
        pipelineId: deal.pipeline_id,
        stageId: deal.stage_id,
        organizationId,
        daysInStage: Math.floor((now.getTime() - dealUpdatedAt) / (24 * 60 * 60 * 1000)),
        breachDate,
        correlationId: eventId,
      },
    };
    await rabbitmq.publishEvent(event as Event);
    automationSlaPublishedTotal.inc({ event_type: EventType.DEAL_SLA_BREACH });
    log.info({ message: 'sla cron published deal.sla.breach', rule_id: rule.id, deal_id: deal.id, breach_date: breachDate });
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
  res.json({ status: 'ok', service: 'automation-service' });
});

app.get('/ready', async (_req, res) => {
  const checks: { rabbitmq?: boolean; postgres?: boolean } = {};
  try {
    checks.rabbitmq = rabbitmq.isConnected();
  } catch {
    checks.rabbitmq = false;
  }
  try {
    await pool.query('SELECT 1');
    checks.postgres = true;
  } catch {
    checks.postgres = false;
  }
  const ok = checks.rabbitmq && checks.postgres;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not ready', checks });
});

app.get('/metrics', async (_req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ЭТАП 6: внутренний endpoint для e2e — один запуск SLA cron (1 правило, 1 сущность). Тело: { organizationId?: string }; или X-Organization-Id.
app.post('/api/automation/internal/run-sla-cron-once', async (req, res) => {
  try {
    const fromBody = typeof req.body?.organizationId === 'string' ? req.body.organizationId : undefined;
    const fromHeader = typeof req.headers['x-organization-id'] === 'string' ? req.headers['x-organization-id'] : undefined;
    const filterOrgId = fromBody ?? fromHeader;
    const filterLeadId = typeof req.body?.leadId === 'string' ? req.body.leadId : undefined;
    await runSlaCronOnce(filterOrgId, filterLeadId);
    res.json({ ok: true });
  } catch (e) {
    log.error({ message: 'run-sla-cron-once failed', error: String(e) });
    res.status(500).json({ error: String(e) });
  }
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
        JSON.stringify(actions ?? []),
        is_active !== false,
      ]
    );

    // Publish event (non-fatal: rule already saved)
    try {
      const createdEvent = {
        id: crypto.randomUUID(),
        type: EventType.AUTOMATION_RULE_CREATED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { ruleId: result.rows[0].id },
      };
      await rabbitmq.publishEvent(createdEvent as Event);
    } catch (pubErr) {
      console.error('Failed to publish AUTOMATION_RULE_CREATED:', pubErr);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating automation rule:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Automation service running on port ${PORT}`);
});

