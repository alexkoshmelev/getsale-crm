import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { Event, EventType } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { RabbitMQClient } from '@getsale/queue';

interface AutomationAction {
  type: string;
  userId?: string;
  stageId?: string;
  targetStageId?: string;
  message?: string;
  userIds?: string[];
  ruleName?: string;
  [key: string]: unknown;
}

interface RuleCondition {
  field: string;
  operator: string;
  value: unknown;
}

/**
 * Event-driven rule engine. Evaluates automation rules against incoming events
 * and executes actions via event publishing (not direct HTTP calls).
 *
 * Matches v1 automation-service capabilities:
 * - Field-based condition evaluation with operators (eq, ne, gt, lt, contains)
 * - Idempotent execution logging to automation_executions
 * - AUTOMATION_RULE_TRIGGERED event publishing
 * - Action types: assign_user, move_stage, send_notification, create_deal, create_task
 */
export class RuleEngine {
  private pool: Pool;
  private rabbitmq: RabbitMQClient;
  private log: Logger;

  constructor(pool: Pool, rabbitmq: RabbitMQClient, log: Logger) {
    this.pool = pool;
    this.rabbitmq = rabbitmq;
    this.log = log;
  }

  async evaluate(event: Event): Promise<void> {
    if (!event.organizationId) return;

    const rules = await this.pool.query(
      `SELECT * FROM automation_rules
       WHERE organization_id = $1 AND is_active = true AND trigger_type = $2`,
      [event.organizationId, event.type],
    );

    for (const rule of rules.rows) {
      try {
        const triggerConditions = parseJson(rule.trigger_conditions, {});
        const conditions = parseJson(rule.conditions, []);

        if (!this.matchesTriggerConditions(event, triggerConditions)) continue;
        if (!evaluateConditions(event, conditions)) continue;

        const entityType = extractEntityType(event);
        const entityId = extractEntityId(event);

        if (entityId && entityType) {
          const existing = await this.pool.query(
            `SELECT id FROM automation_executions
             WHERE rule_id = $1 AND entity_type = $2 AND entity_id = $3`,
            [rule.id, entityType, entityId],
          );
          if (existing.rows.length > 0) {
            this.log.info({
              message: 'Rule execution skipped (already executed)',
              rule_id: rule.id,
              entity_type: entityType,
              entity_id: entityId,
            });
            continue;
          }
        }

        await this.executeActions(event, rule);
        await this.logExecution(rule.id, event, entityType, entityId, 'success');
        await this.publishRuleTriggered(event, rule);
      } catch (err) {
        this.log.error({
          message: 'Rule execution failed',
          rule_id: rule.id,
          event_type: event.type,
          error: String(err),
        });

        const entityType = extractEntityType(event);
        const entityId = extractEntityId(event);
        await this.logExecution(rule.id, event, entityType, entityId, 'failed').catch(() => {});
      }
    }
  }

  private matchesTriggerConditions(event: Event, conditions: Record<string, unknown>): boolean {
    if (!conditions || Object.keys(conditions).length === 0) return true;
    const data = (event.data ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(conditions)) {
      if (data[key] !== value) return false;
    }
    return true;
  }

  private async executeActions(event: Event, rule: Record<string, unknown>): Promise<void> {
    const actions: AutomationAction[] = parseJson(rule.actions, []);

    for (const action of actions) {
      switch (action.type) {
        case 'assign_user':
          await this.publishAction('automation.action.assign', event, {
            targetUserId: action.userId,
            ruleId: rule.id,
          });
          break;

        case 'move_stage':
        case 'move_to_stage':
          await this.publishAction('automation.action.move_stage', event, {
            targetStageId: action.stageId || action.targetStageId,
            ruleId: rule.id,
            reason: `Automated by rule: ${(rule.name as string) || 'N/A'}`,
            autoMoved: true,
          });
          break;

        case 'send_notification':
        case 'notify_team':
          await this.rabbitmq.publishEvent({
            id: randomUUID(),
            type: EventType.TRIGGER_EXECUTED,
            timestamp: new Date(),
            organizationId: event.organizationId,
            userId: event.userId,
            correlationId: (event as any).correlationId,
            data: {
              type: 'notification',
              ruleId: rule.id as string,
              message: action.message || 'Automation rule triggered',
              userIds: action.userIds || [],
            },
          } as unknown as Event);
          break;

        case 'create_deal':
          await this.publishAction('automation.action.create_deal', event, {
            ruleId: rule.id,
          });
          break;

        case 'create_task':
          await this.publishAction('automation.action.create_task', event, {
            ruleId: rule.id,
            message: action.message,
            userIds: action.userIds,
          });
          break;
      }
    }

    this.log.info({
      message: 'Rule executed',
      rule_id: rule.id as string,
      event_type: event.type,
      action_count: actions.length,
    });
  }

  private async publishAction(
    actionType: string,
    event: Event,
    extraData: Record<string, unknown>,
  ): Promise<void> {
    await this.rabbitmq.publishEvent({
      id: randomUUID(),
      type: actionType as EventType,
      timestamp: new Date(),
      organizationId: event.organizationId,
      userId: event.userId || '',
      correlationId: (event as any).correlationId,
      data: { ...(event.data as Record<string, unknown>), ...extraData },
    } as unknown as Event);
  }

  private async logExecution(
    ruleId: string,
    event: Event,
    entityType: string | undefined,
    entityId: string | undefined,
    status: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO automation_executions
         (rule_id, organization_id, trigger_event, status, entity_type, entity_id, correlation_id, trigger_event_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          ruleId,
          event.organizationId,
          event.type,
          status,
          entityType || null,
          entityId || null,
          (event as any).correlationId || null,
          event.id || null,
        ],
      );
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        this.log.info({
          message: 'Execution already exists (unique constraint), skip',
          rule_id: ruleId,
          entity_type: entityType,
          entity_id: entityId,
        });
        return;
      }
      this.log.error({ message: 'Failed to log execution', rule_id: ruleId, error: String(err) });
    }
  }

  private async publishRuleTriggered(event: Event, rule: Record<string, unknown>): Promise<void> {
    const data = (event.data ?? {}) as Record<string, unknown>;
    try {
      await this.rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.AUTOMATION_RULE_TRIGGERED,
        timestamp: new Date(),
        organizationId: event.organizationId,
        userId: event.userId,
        correlationId: (event as any).correlationId,
        data: {
          ruleId: rule.id as string,
          clientId: (data.contactId || data.clientId || '') as string,
          action: 'executed',
        },
      } as unknown as Event);
    } catch (err) {
      this.log.warn({ message: 'Failed to publish AUTOMATION_RULE_TRIGGERED', error: String(err) });
    }
  }

  async checkSla(rule: Record<string, unknown>): Promise<void> {
    const orgId = rule.organization_id as string;
    const triggerConditions = parseJson(rule.trigger_conditions, {});
    const maxDays = triggerConditions.max_days;
    const maxAgeMinutes = maxDays != null
      ? Number(maxDays) * 24 * 60
      : (triggerConditions.maxAgeMinutes ?? 60);

    const overdue = await this.pool.query(
      `SELECT id, contact_id FROM leads
       WHERE organization_id = $1
         AND updated_at < NOW() - ($2 || ' minutes')::INTERVAL
         AND deleted_at IS NULL
         AND stage_id IS NOT NULL
       LIMIT 100`,
      [orgId, String(maxAgeMinutes)],
    );

    for (const lead of overdue.rows) {
      await this.rabbitmq.publishEvent({
        id: randomUUID(),
        type: 'automation.sla.breached' as EventType,
        timestamp: new Date(),
        organizationId: orgId,
        userId: '',
        data: { leadId: lead.id, contactId: lead.contact_id, ruleId: rule.id, maxAgeMinutes },
      } as unknown as Event);
    }

    if (overdue.rows.length > 0) {
      this.log.info({
        message: 'SLA breaches found',
        rule_id: rule.id as string,
        organization_id: orgId,
        breach_count: overdue.rows.length,
      });
    }
  }
}

function parseJson(value: unknown, fallback: any): any {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

/** Field-based condition evaluation with operators (matches v1 evaluateCondition). */
function evaluateConditions(event: Event, conditions: unknown): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  const data = ((event.data ?? {}) as Record<string, unknown>);

  for (const condition of conditions as RuleCondition[]) {
    const { field, operator, value } = condition;
    const eventValue = field != null ? data[field] : undefined;

    switch (operator) {
      case 'eq':
        if (eventValue !== value) return false;
        break;
      case 'ne':
        if (eventValue === value) return false;
        break;
      case 'gt':
        if (!(Number(eventValue) > Number(value))) return false;
        break;
      case 'lt':
        if (!(Number(eventValue) < Number(value))) return false;
        break;
      case 'contains':
        if (!String(eventValue ?? '').includes(String(value ?? ''))) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function extractEntityId(event: Event): string | undefined {
  const data = (event.data ?? {}) as Record<string, unknown>;
  return (data.leadId || data.dealId || data.contactId || data.clientId) as string | undefined;
}

function extractEntityType(event: Event): string | undefined {
  const data = (event.data ?? {}) as Record<string, unknown>;
  if (data.leadId) return 'lead';
  if (data.dealId) return 'deal';
  if (data.contactId) return 'contact';
  return undefined;
}
