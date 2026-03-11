import { Pool } from 'pg';

/** Single point of conversation creation. Call before saving any message. */
export async function ensureConversation(
  db: Pool,
  params: { organizationId: string; bdAccountId: string | null; channel: string; channelId: string; contactId: string | null }
): Promise<void> {
  await db.query(
    `INSERT INTO conversations (id, organization_id, bd_account_id, channel, channel_id, contact_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (organization_id, bd_account_id, channel, channel_id)
     DO UPDATE SET contact_id = COALESCE(EXCLUDED.contact_id, conversations.contact_id), updated_at = NOW()`,
    [params.organizationId, params.bdAccountId, params.channel, params.channelId, params.contactId]
  );
  if (params.contactId) {
    await db.query(
      `UPDATE conversations c SET lead_id = sub.id, became_lead_at = COALESCE(c.became_lead_at, sub.created_at), updated_at = NOW()
       FROM (SELECT id, created_at FROM leads WHERE organization_id = $1 AND contact_id = $5 ORDER BY created_at DESC LIMIT 1) sub
       WHERE c.organization_id = $1 AND c.bd_account_id IS NOT DISTINCT FROM $2 AND c.channel = $3 AND c.channel_id = $4 AND c.lead_id IS NULL`,
      [params.organizationId, params.bdAccountId, params.channel, params.channelId, params.contactId]
    );
  }
}

/** Attach lead to conversation (idempotent by conversationId + leadId). Triggered by LEAD_CREATED_FROM_CAMPAIGN.
 *  On duplicate event delivery, UPDATE matches 0 rows (already same lead_id) — safe no-op. */
export async function attachLead(
  db: Pool,
  params: { conversationId: string; leadId: string; campaignId: string }
): Promise<number> {
  const r = await db.query(
    `UPDATE conversations SET lead_id = $1, campaign_id = $2, became_lead_at = COALESCE(became_lead_at, NOW()), updated_at = NOW()
     WHERE id = $3 AND (lead_id IS NULL OR lead_id = $1)`,
    [params.leadId, params.campaignId, params.conversationId]
  );
  return r.rowCount ?? 0;
}

export const MESSAGES_FOR_AI_LIMIT = 200;
export const AI_INSIGHT_MODEL_VERSION = 'gpt-4';
export const ALLOWED_EMOJI = ['👍', '👎', '❤️', '🔥', '👏', '😄', '😮', '😢', '🙏'];
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const UNFURL_TIMEOUT_MS = 4000;
export const UNFURL_MAX_BODY = 300_000; // 300 KB
export const URL_REGEX = /^https?:\/\/[^\s<>"']+$/i;

/** Block internal/private URLs to prevent SSRF. Only allow public internet URLs. */
export function isUrlAllowedForUnfurl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();

  // Block localhost and reserved hostnames (IPv6 loopback may appear as ::1 or [::1])
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  // Block common internal service hostnames (Docker Compose / K8s)
  const blockedHosts = [
    'redis', 'postgres', 'rabbitmq', 'api-gateway', 'auth-service', 'crm-service',
    'messaging-service', 'websocket-service', 'ai-service', 'user-service', 'bd-accounts-service',
    'pipeline-service', 'automation-service', 'analytics-service', 'team-service', 'campaign-service',
  ];
  if (blockedHosts.includes(host)) return false;

  // IPv4: block private, loopback, link-local
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match.map(Number);
    if (a === 127) return false; // 127.0.0.0/8
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local
    if (a === 0) return false; // 0.0.0.0/8
  }

  // IPv6: block loopback and unique-local
  if (host === '::1' || host === '[::1]' || host.startsWith('fd') || host.startsWith('fe80')) return false;

  return true;
}
