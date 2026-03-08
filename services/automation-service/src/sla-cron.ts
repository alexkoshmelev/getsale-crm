import crypto from 'node:crypto';
import cron from 'node-cron';
import { Pool } from 'pg';
import { Counter } from 'prom-client';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';

interface SlaCronDeps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  automationSlaPublishedTotal: Counter<string>;
}

export function runSlaCronOnce(
  deps: SlaCronDeps,
  filterOrgId?: string,
  filterLeadId?: string
): Promise<void> {
  return runSlaCronOnceImpl(deps, filterOrgId, filterLeadId);
}

async function runSlaCronOnceImpl(
  deps: SlaCronDeps,
  filterOrgId?: string,
  filterLeadId?: string
): Promise<void> {
  const { pool, rabbitmq, log, automationSlaPublishedTotal } = deps;

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
  const breachDate = now.toISOString().slice(0, 10);
  const cutoff = new Date(now.getTime() - Number(max_days) * 24 * 60 * 60 * 1000);

  if (rule.trigger_type === EventType.LEAD_SLA_BREACH) {
    const leadParams: (string | Date)[] = [pipeline_id, stage_id, organizationId, cutoff];
    const leadWhere = filterLeadId != null ? `AND id = $${leadParams.length + 1}` : '';
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
    log.info({
      message: 'sla cron published lead.sla.breach',
      rule_id: rule.id,
      lead_id: lead.id,
      breach_date: breachDate,
    });
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
    log.info({
      message: 'sla cron published deal.sla.breach',
      rule_id: rule.id,
      deal_id: deal.id,
      breach_date: breachDate,
    });
  }
}

interface TimeBasedCronDeps {
  pool: Pool;
  log: Logger;
  executeRule: (rule: import('./event-handlers').AutomationRuleRow, event: import('./event-handlers').AutomationEventPayload) => Promise<void>;
}

export function startCronJobs(
  slaDeps: SlaCronDeps,
  runSlaCronOnceFn: (filterOrgId?: string, filterLeadId?: string) => Promise<void>,
  timeBasedDeps: TimeBasedCronDeps
): void {
  const { log } = slaDeps;

  // Time-based automations: every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const { pool, executeRule } = timeBasedDeps;
      const rules = await pool.query(
        `SELECT * FROM automation_rules 
         WHERE is_active = true 
         AND trigger_type = 'time_elapsed'`
      );

      for (const rule of rules.rows) {
        const triggerConditions =
          typeof rule.trigger_conditions === 'string'
            ? JSON.parse(rule.trigger_conditions)
            : rule.trigger_conditions;
        const { elapsed_hours, stage } = triggerConditions;
        const cutoffTime = new Date(Date.now() - elapsed_hours * 60 * 60 * 1000);

        const clients = await pool.query(
          `SELECT d.* FROM deals d
           JOIN stages s ON d.stage_id = s.id
           WHERE s.name = $1 AND d.created_at < $2`,
          [stage, cutoffTime]
        );

        for (const client of clients.rows) {
          await executeRule(rule as import('./event-handlers').AutomationRuleRow, {
            id: crypto.randomUUID(),
            type: 'time_elapsed',
            organizationId: client.organization_id,
            data: { clientId: client.client_id, dealId: client.id },
          });
        }
      }
    } catch (error) {
      log.error({ message: 'Error in time-based automation cron', error: String(error) });
    }
  });

  // SLA cron: every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await runSlaCronOnceFn();
    } catch (error) {
      log.error({ message: 'sla cron failed', error: String(error) });
    }
  });
}
