import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { ServiceHttpClient } from '@getsale/service-core';
import { scheduleFromBdAccountRow, isWithinScheduleAt, type Schedule } from './helpers';
import type { MessageReceivedEvent } from '@getsale/events';

const DEBOUNCE_MS = 5 * 60 * 1000;
const lastRespondAt = new Map<string, number>();

function debounceKey(organizationId: string, bdAccountId: string, channelId: string): string {
  return `${organizationId}:${bdAccountId}:${channelId}`;
}

function isNoiseContent(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith('[System]')) return true;
  if (t === '[Media]' || t.startsWith('[File:')) return true;
  return false;
}

export interface AutoResponderDeps {
  pool: Pool;
  log: Logger;
  messagingClient: ServiceHttpClient;
  bdAccountsClient: ServiceHttpClient;
  aiClient: ServiceHttpClient;
}

/**
 * Off-hours auto-reply using BD account settings. Non-blocking for the event handler (call with void + catch).
 */
export async function runAutoResponderIfEligible(deps: AutoResponderDeps, event: MessageReceivedEvent): Promise<void> {
  const { pool, log, messagingClient, bdAccountsClient, aiClient } = deps;
  const data = event.data;
  if (data.direction !== 'inbound') return;

  const organizationId = event.organizationId;
  const contactId = data.contactId;
  const bdAccountId = data.bdAccountId;
  const channelId = data.channelId;
  const incoming = typeof data.content === 'string' ? data.content : '';
  if (!organizationId || !contactId || !bdAccountId || !channelId) return;
  if (isNoiseContent(incoming)) return;

  const accRes = await pool.query(
    `SELECT auto_responder_enabled, auto_responder_system_prompt, auto_responder_history_count,
            timezone, working_hours_start, working_hours_end, working_days
     FROM bd_accounts WHERE id = $1 AND organization_id = $2 AND is_active = true`,
    [bdAccountId, organizationId]
  );
  const row = accRes.rows[0] as
    | {
        auto_responder_enabled?: boolean;
        auto_responder_system_prompt?: string | null;
        auto_responder_history_count?: number;
      }
    | undefined;
  if (!row?.auto_responder_enabled) return;

  const prompt = typeof row.auto_responder_system_prompt === 'string' ? row.auto_responder_system_prompt.trim() : '';
  if (!prompt) {
    log.info({ message: 'auto-responder: no system prompt, skip', bdAccountId });
    return;
  }

  const accountSchedule: Schedule = scheduleFromBdAccountRow({
    timezone: (accRes.rows[0] as { timezone?: string | null }).timezone,
    working_hours_start: (accRes.rows[0] as { working_hours_start?: string | null }).working_hours_start,
    working_hours_end: (accRes.rows[0] as { working_hours_end?: string | null }).working_hours_end,
    working_days: (accRes.rows[0] as { working_days?: number[] | null }).working_days,
  });
  if (!accountSchedule) {
    log.info({ message: 'auto-responder: account has no working window; cannot determine off-hours', bdAccountId });
    return;
  }
  if (isWithinScheduleAt(new Date(), accountSchedule)) return;

  const dk = debounceKey(organizationId, bdAccountId, channelId);
  const nowMs = Date.now();
  const prev = lastRespondAt.get(dk) ?? 0;
  if (nowMs - prev < DEBOUNCE_MS) {
    log.info({ message: 'auto-responder: debounced', bdAccountId, channelId });
    return;
  }
  lastRespondAt.set(dk, nowMs);

  const userRow = await pool.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [organizationId]);
  const userId = userRow.rows[0]?.id as string | undefined;
  if (!userId) {
    log.warn({ message: 'auto-responder: no user in org', organizationId });
    return;
  }

  const ctx = { userId, organizationId };

  try {
    await bdAccountsClient.post('/api/bd-accounts/' + bdAccountId + '/read', { chatId: channelId }, undefined, ctx);
  } catch (e) {
    log.warn({ message: 'auto-responder: markAsRead failed', error: e instanceof Error ? e.message : String(e) });
  }

  const preTypingDelay = 2000 + Math.floor(Math.random() * 6000);
  await new Promise((r) => setTimeout(r, preTypingDelay));

  const historyCap = Math.min(100, Math.max(10, Number(row.auto_responder_history_count) || 25));
  const qs = new URLSearchParams({
    contactId,
    channel: 'telegram',
    channelId,
    bdAccountId,
    limit: String(Math.min(100, historyCap + 10)),
    page: '1',
  });

  type MsgList = { messages?: Array<{
    direction?: string;
    content?: string;
    created_at?: string | Date;
    telegram_date?: string | Date | null;
  }> };

  let historyMsgs: NonNullable<MsgList['messages']> = [];
  try {
    const list = await messagingClient.get<MsgList>(`/api/messaging/messages?${qs.toString()}`, undefined, ctx);
    historyMsgs = Array.isArray(list?.messages) ? list.messages : [];
  } catch (e) {
    log.warn({ message: 'auto-responder: load messages failed', error: e instanceof Error ? e.message : String(e) });
  }

  const chronological = [...historyMsgs].sort((a, b) => {
    const ta = new Date(a.created_at || a.telegram_date || 0).getTime();
    const tb = new Date(b.created_at || b.telegram_date || 0).getTime();
    return ta - tb;
  });

  const conversationHistory: { role: 'user' | 'assistant'; content: string; date?: string }[] = [];
  for (const m of chronological) {
    const c = typeof m.content === 'string' ? m.content : '';
    if (isNoiseContent(c)) continue;
    const dir = m.direction === 'outbound' ? 'assistant' : 'user';
    const role: 'user' | 'assistant' = dir === 'assistant' ? 'assistant' : 'user';
    const d = m.created_at ?? m.telegram_date;
    const dateStr =
      d instanceof Date ? d.toISOString() : typeof d === 'string' && d.length > 0 ? d : undefined;
    conversationHistory.push({
      role,
      content: c.slice(0, 8000),
      date: dateStr,
    });
  }

  const tail = conversationHistory.slice(-historyCap);

  let replyText: string;
  try {
    const aiRes = await aiClient.post<{ text?: string }>(
      '/api/ai/auto-respond',
      {
        systemPrompt: prompt,
        conversationHistory: tail,
        incomingMessage: incoming.slice(0, 4000),
      },
      undefined,
      ctx
    );
    replyText = typeof aiRes?.text === 'string' ? aiRes.text.trim() : '';
  } catch (e) {
    log.warn({ message: 'auto-responder: AI failed', error: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (!replyText || isNoiseContent(replyText)) return;

  const typingBase = Math.min(14_000, Math.max(2500, replyText.length * 45));
  const renewTyping = async (): Promise<void> => {
    try {
      await bdAccountsClient.post('/api/bd-accounts/' + bdAccountId + '/typing', { chatId: channelId }, undefined, ctx);
    } catch (e) {
      log.warn({ message: 'auto-responder: typing failed', error: e instanceof Error ? e.message : String(e) });
    }
  };

  await renewTyping();
  const TYPING_STATUS_TTL_MS = 5500;
  let left = typingBase;
  while (left > 0) {
    const chunk = Math.min(TYPING_STATUS_TTL_MS, left);
    await new Promise((r) => setTimeout(r, chunk));
    left -= chunk;
    if (replyText.length > 200 && left > 400) await renewTyping();
  }

  const idempotencyKey = `auto-responder:${data.messageId ?? event.id}`;
  try {
    await messagingClient.post(
      '/api/messaging/send',
      {
        contactId,
        channel: 'telegram',
        channelId,
        content: replyText.slice(0, 8000),
        bdAccountId,
        source: 'auto_responder',
        idempotencyKey,
      },
      undefined,
      ctx
    );
    log.info({ message: 'auto-responder: reply sent', bdAccountId, channelId, contactId });
  } catch (e) {
    log.warn({ message: 'auto-responder: send failed', error: e instanceof Error ? e.message : String(e) });
  }
}
