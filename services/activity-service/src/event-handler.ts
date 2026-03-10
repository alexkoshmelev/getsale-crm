import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { EventType } from '@getsale/events';

interface EventLike {
  type: string;
  organizationId: string;
  userId?: string;
  data?: Record<string, unknown>;
}

function mapEventToActivity(event: EventLike): { action_type: string; entity_type: string | null; entity_id: string | null; metadata: Record<string, unknown> | null } | null {
  const data = event.data || {};
  const get = (key: string): string | undefined => {
    const v = data[key];
    return typeof v === 'string' ? v : undefined;
  };

  switch (event.type) {
    case EventType.LEAD_CREATED:
      return { action_type: 'lead.created', entity_type: 'lead', entity_id: get('leadId') ?? null, metadata: data };
    case EventType.LEAD_STAGE_CHANGED:
      return { action_type: 'lead.stage_changed', entity_type: 'lead', entity_id: get('leadId') ?? null, metadata: data };
    case EventType.CAMPAIGN_STARTED:
      return { action_type: 'campaign.started', entity_type: 'campaign', entity_id: get('campaignId') ?? null, metadata: data };
    case EventType.CAMPAIGN_CREATED:
      return { action_type: 'campaign.created', entity_type: 'campaign', entity_id: get('campaignId') ?? null, metadata: data };
    case EventType.TEAM_MEMBER_ADDED:
      return { action_type: 'team.member.added', entity_type: 'team_member', entity_id: get('userId') ?? null, metadata: data };
    case EventType.TEAM_MEMBER_REMOVED:
      return { action_type: 'team.member.removed', entity_type: 'team_member', entity_id: get('userId') ?? null, metadata: data };
    case EventType.BD_ACCOUNT_CONNECTED:
      return { action_type: 'bd_account.connected', entity_type: 'bd_account', entity_id: get('bdAccountId') ?? null, metadata: data };
    case EventType.COMPANY_CREATED:
      return { action_type: 'company.created', entity_type: 'company', entity_id: get('companyId') ?? null, metadata: data };
    case EventType.CONTACT_CREATED:
      return { action_type: 'contact.created', entity_type: 'contact', entity_id: get('contactId') ?? null, metadata: data };
    case EventType.DEAL_CREATED:
      return { action_type: 'deal.created', entity_type: 'deal', entity_id: get('dealId') ?? null, metadata: data };
    case EventType.LEAD_CONVERTED:
      return { action_type: 'lead.converted', entity_type: 'lead', entity_id: get('leadId') ?? null, metadata: data };
    case EventType.DISCOVERY_TASK_STARTED:
      return { action_type: 'discovery.started', entity_type: 'discovery_task', entity_id: get('taskId') ?? null, metadata: data };
    default:
      return null;
  }
}

export async function handleActivityEvent(
  pool: Pool,
  log: Logger,
  event: EventLike
): Promise<void> {
  const userId = event.userId;
  if (!userId || !event.organizationId) return;

  const mapped = mapEventToActivity(event);
  if (!mapped) return;

  try {
    await pool.query(
      `INSERT INTO organization_activity (organization_id, user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.organizationId,
        userId,
        mapped.action_type,
        mapped.entity_type,
        mapped.entity_id,
        mapped.metadata ? JSON.stringify(mapped.metadata) : null,
      ]
    );
  } catch (err) {
    log.warn({
      message: 'Failed to insert organization_activity',
      error: err instanceof Error ? err.message : String(err),
      event_type: event.type,
      organization_id: event.organizationId,
    });
  }
}

export const ACTIVITY_EVENT_TYPES = [
  EventType.LEAD_CREATED,
  EventType.LEAD_STAGE_CHANGED,
  EventType.CAMPAIGN_STARTED,
  EventType.CAMPAIGN_CREATED,
  EventType.TEAM_MEMBER_ADDED,
  EventType.TEAM_MEMBER_REMOVED,
  EventType.BD_ACCOUNT_CONNECTED,
  EventType.COMPANY_CREATED,
  EventType.CONTACT_CREATED,
  EventType.DEAL_CREATED,
  EventType.LEAD_CONVERTED,
  EventType.DISCOVERY_TASK_STARTED,
];
