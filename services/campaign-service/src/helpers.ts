import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { ServiceHttpClient, ServiceCallError, type BdAccountsListScope } from '@getsale/service-core';
import {
  dateInTz,
  isWithinOperatingScheduleAt as isWithinScheduleAt,
  isWithinOperatingSchedule as isWithinSchedule,
  type OperatingSchedule,
} from '@getsale/utils';

export type Schedule = OperatingSchedule;

export { dateInTz, isWithinScheduleAt, isWithinSchedule };

export type StepConditions = {
  stopIfReplied?: boolean;
  contact?: Array<{
    field: 'first_name' | 'last_name' | 'email' | 'phone' | 'telegram_id' | 'company_name';
    op: 'equals' | 'not_equals' | 'contains' | 'empty' | 'not_empty';
    value?: string;
  }>;
  inPipelineStage?: { pipelineId: string; stageIds: string[] };
  notInPipelineStage?: { pipelineId: string; stageIds: string[] };
};

export const CHANNEL_TELEGRAM = 'telegram';

/** Default max DMs per BD account per day when campaign has no dailySendTarget and bd_accounts.max_dm_per_day is unset. */
export const DEFAULT_DAILY_SEND_CAP = parseInt(
  String(process.env.CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY || 20),
  10
);

export function normalizeTelegramUsername(username: unknown): string | null {
  if (typeof username !== 'string') return null;
  const normalized = username.trim().replace(/^@/, '');
  return normalized !== '' ? normalized : null;
}

/**
 * Peer channel for campaign sends. Prefer numeric Telegram user id when present so
 * bd-accounts MessageSender can use numeric peer without contacts.ResolveUsername per send.
 */
export function resolveCampaignChannelId(
  telegramId: unknown,
  username: unknown
): string | null {
  const usernameNorm = normalizeTelegramUsername(username);
  const telegramIdNorm =
    telegramId != null && String(telegramId).trim() !== '' ? String(telegramId).trim() : null;
  return telegramIdNorm ?? usernameNorm;
}

export function getContactField(
  contact: Record<string, unknown>,
  field: 'first_name' | 'last_name' | 'email' | 'phone' | 'telegram_id' | 'company_name'
): string {
  const v = contact[field];
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

export function evalContactRule(
  contact: Record<string, unknown>,
  rule: NonNullable<StepConditions['contact']>[number]
): boolean {
  const raw = getContactField(contact, rule.field);
  const val = (rule.value ?? '').trim().toLowerCase();
  const rawLower = raw.toLowerCase();
  switch (rule.op) {
    case 'equals':
      return rawLower === val;
    case 'not_equals':
      return rawLower !== val;
    case 'contains':
      return val ? rawLower.includes(val) : true;
    case 'empty':
      return raw === '';
    case 'not_empty':
      return raw !== '';
    default:
      return true;
  }
}

export async function evaluateStepConditions(
  pool: Pool,
  organizationId: string,
  contactId: string,
  conditions: StepConditions | undefined | null,
  contact: Record<string, unknown>,
  participantStatus?: string
): Promise<boolean> {
  if (!conditions || (typeof conditions !== 'object')) return true;
  if (conditions.stopIfReplied && participantStatus === 'replied') return false;
  if (conditions.contact?.length) {
    for (const rule of conditions.contact) {
      if (!evalContactRule(contact, rule)) return false;
    }
  }
  if (conditions.inPipelineStage?.pipelineId && conditions.inPipelineStage.stageIds?.length) {
    const lead = await pool.query(
      `SELECT stage_id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3`,
      [organizationId, contactId, conditions.inPipelineStage.pipelineId]
    );
    const stageId = lead.rows[0]?.stage_id;
    if (!stageId || !conditions.inPipelineStage.stageIds.includes(stageId)) return false;
  }
  if (conditions.notInPipelineStage?.pipelineId && conditions.notInPipelineStage.stageIds?.length) {
    const lead = await pool.query(
      `SELECT stage_id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3`,
      [organizationId, contactId, conditions.notInPipelineStage.pipelineId]
    );
    const stageId = lead.rows[0]?.stage_id;
    if (stageId && conditions.notInPipelineStage.stageIds.includes(stageId)) return false;
  }
  return true;
}

export type BdAccountScheduleRow = {
  timezone?: string | null;
  working_hours_start?: string | null;
  working_hours_end?: string | null;
  working_days?: number[] | null;
};

/** Build campaign `Schedule` from `bd_accounts` working window columns. */
export function scheduleFromBdAccountRow(row: BdAccountScheduleRow | null | undefined): Schedule {
  if (!row?.working_hours_start || !row.working_hours_end || !row.working_days?.length) return null;
  return {
    timezone: (row.timezone && String(row.timezone).trim()) || 'UTC',
    workingHours: { start: String(row.working_hours_start), end: String(row.working_hours_end) },
    daysOfWeek: row.working_days,
  };
}

/** Use campaign schedule when it defines a full window; otherwise fall back to BD account schedule. */
export function getEffectiveSchedule(campaignSchedule: Schedule, accountSchedule: Schedule): Schedule {
  if (
    campaignSchedule?.workingHours?.start &&
    campaignSchedule?.workingHours?.end &&
    campaignSchedule.daysOfWeek?.length
  ) {
    return campaignSchedule;
  }
  return accountSchedule;
}

export interface SendDelayRange {
  minSeconds: number;
  maxSeconds: number;
}

export function resolveDelayRange(
  audience: { sendDelaySeconds?: unknown; sendDelayMinSeconds?: unknown; sendDelayMaxSeconds?: unknown } | null | undefined,
  fallbackSeconds = 60
): SendDelayRange {
  const cap = 3600;
  const toNum = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.max(0, Math.min(cap, Math.floor(v)));
  };
  const minRaw = toNum(audience?.sendDelayMinSeconds);
  const maxRaw = toNum(audience?.sendDelayMaxSeconds);
  if (minRaw != null && maxRaw != null) {
    return minRaw <= maxRaw
      ? { minSeconds: minRaw, maxSeconds: maxRaw }
      : { minSeconds: maxRaw, maxSeconds: minRaw };
  }
  const legacy = toNum(audience?.sendDelaySeconds);
  const one = legacy ?? Math.max(0, Math.min(cap, Math.floor(fallbackSeconds)));
  return { minSeconds: one, maxSeconds: one };
}

export function sampleDelaySeconds(range: SendDelayRange): number {
  const min = Math.max(0, Math.floor(range.minSeconds));
  const max = Math.max(min, Math.floor(range.maxSeconds));
  if (min === max) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Deterministic per-slot step from audience delay range (midpoint), min 1s. Used for initial queue stagger. */
export function representativeStepSecondsFromDelayRange(range: SendDelayRange): number {
  const min = Math.max(0, Math.floor(range.minSeconds));
  const max = Math.max(min, Math.floor(range.maxSeconds));
  return Math.max(1, Math.floor((min + max) / 2));
}

/**
 * Seconds offset for participant queue index so up to `dailyCap` first-wave sends spread across the working-day window.
 * When `delayRange` is set (from campaign target_audience), uses it as the per-slot step instead of a hardcoded 60s.
 */
export function spreadOffsetSecondsForSlot(
  slotIndex: number,
  dailyCap: number,
  schedule: Schedule,
  delayRange?: SendDelayRange | null
): number {
  const minStep = delayRange != null ? representativeStepSecondsFromDelayRange(delayRange) : 60;
  if (!schedule?.workingHours?.start || !schedule.workingHours?.end || dailyCap <= 0) {
    return Math.max(0, slotIndex) * minStep;
  }
  const startParts = schedule.workingHours.start.split(':').map((x) => Number(x));
  const endParts = schedule.workingHours.end.split(':').map((x) => Number(x));
  const sh = startParts[0] ?? 0;
  const sm = startParts[1] ?? 0;
  const eh = endParts[0] ?? 0;
  const em = endParts[1] ?? 0;
  const windowSec = Math.max(300, eh * 3600 + em * 60 - sh * 3600 - sm * 60);
  const baseInterval = Math.max(minStep, Math.floor(windowSec / Math.max(1, dailyCap)));
  const jitterMag = Math.max(10, Math.floor(baseInterval * 0.1));
  const jitter = slotIndex === 0 ? 0 : Math.floor(Math.random() * (2 * jitterMag + 1)) - jitterMag;
  return Math.max(0, slotIndex * baseInterval + jitter);
}

export function nextSendAtWithSchedule(from: Date, delayHours: number, schedule: Schedule): Date {
  const base = new Date(from.getTime() + delayHours * 60 * 60 * 1000);
  if (!schedule?.workingHours?.start || !schedule?.workingHours?.end || !schedule.daysOfWeek?.length) return base;
  let d = new Date(base.getTime());
  for (let i = 0; i < 24 * 8; i++) {
    if (isWithinScheduleAt(d, schedule)) return d;
    d.setTime(d.getTime() + 60 * 60 * 1000);
  }
  return d;
}

export function delayHoursFromStep(step: { delay_hours?: number | null; delay_minutes?: number | null } | null | undefined): number {
  if (!step) return 24;
  const h = step.delay_hours ?? 24;
  const m = step.delay_minutes ?? 0;
  return h + m / 60;
}

export function nextSlotRetry(_schedule: Schedule): Date {
  return new Date(Date.now() + 15 * 60 * 1000);
}

export function staggeredFirstSendAtByOffset(
  baseNow: Date,
  offsetSeconds: number,
  schedule: Schedule
): Date {
  const delayMs = Math.max(0, offsetSeconds) * 1000;
  const raw = new Date(baseNow.getTime() + delayMs);
  if (!schedule?.workingHours?.start || !schedule?.workingHours?.end || !schedule.daysOfWeek?.length) {
    return raw;
  }
  let d = new Date(raw.getTime());
  for (let i = 0; i < 24 * 4 * 14; i++) {
    if (isWithinScheduleAt(d, schedule)) return d;
    d = new Date(d.getTime() + 15 * 60 * 1000);
  }
  return raw;
}

/**
 * First message time for participant at queue index: base + index * sendDelaySeconds.
 * If a working-hours schedule exists, nudge forward in 15-minute steps until the time falls inside the window.
 */
export function staggeredFirstSendAt(
  baseNow: Date,
  queueIndex: number,
  sendDelaySeconds: number,
  schedule: Schedule
): Date {
  const delayMs = Math.max(0, sendDelaySeconds) * 1000;
  const raw = new Date(baseNow.getTime() + queueIndex * delayMs);
  if (!schedule?.workingHours?.start || !schedule?.workingHours?.end || !schedule.daysOfWeek?.length) {
    return raw;
  }
  let d = new Date(raw.getTime());
  for (let i = 0; i < 24 * 4 * 14; i++) {
    if (isWithinScheduleAt(d, schedule)) return d;
    d = new Date(d.getTime() + 15 * 60 * 1000);
  }
  return raw;
}

export async function ensureLeadInPipeline(
  pipelineClient: ServiceHttpClient,
  log: Logger,
  organizationId: string,
  contactId: string,
  pipelineId: string,
  stageId: string | null,
  systemUserId: string,
  responsibleId?: string | null
): Promise<string | null> {
  try {
    const body = await pipelineClient.post<{ id?: string }>('/api/pipeline/leads', {
      contactId,
      pipelineId,
      ...(stageId ? { stageId } : {}),
      ...(responsibleId ? { responsibleId } : {}),
    }, undefined, { userId: systemUserId, organizationId });
    return body.id ?? null;
  } catch (err) {
    if (err instanceof ServiceCallError && err.statusCode === 409) {
      const body = err.body as { details?: { leadId?: string }; leadId?: string; id?: string } | undefined;
      const fromDetails = body?.details && typeof body.details === 'object' ? (body.details as { leadId?: string }).leadId : undefined;
      return fromDetails ?? body?.leadId ?? body?.id ?? null;
    }
    log.error({ message: 'Pipeline create lead error', error: String(err) });
    return null;
  }
}

export function getBdAccountDisplayName(account: {
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  phone_number?: string | null;
  telegram_id?: string | null;
  id: string;
}): string {
  return account.display_name?.trim()
    || [account.first_name, account.last_name].filter(Boolean).map(s => s!.trim()).filter(Boolean).join(' ')
    || account.username?.trim()
    || account.phone_number?.trim()
    || account.telegram_id
    || account.id.slice(0, 8);
}

export async function getSentTodayByAccount(pool: Pool, orgId?: string): Promise<Map<string, number>> {
  const query = orgId
    ? `SELECT cp.bd_account_id, COUNT(*)::int AS cnt
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       JOIN campaigns c ON c.id = cp.campaign_id
       WHERE c.organization_id = $1 AND cs.sent_at::date = $2::date
       GROUP BY cp.bd_account_id`
    : `SELECT cp.bd_account_id, COUNT(*)::int AS cnt
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       JOIN campaigns c ON c.id = cp.campaign_id
       WHERE cs.sent_at::date = $1::date
       GROUP BY cp.bd_account_id`;
  const today = new Date().toISOString().slice(0, 10);
  const params = orgId ? [orgId, today] : [today];
  const result = await pool.query(query, params);
  return new Map((result.rows as { bd_account_id: string; cnt: number }[]).map(r => [r.bd_account_id, r.cnt]));
}

/** Splits a single CSV line by the given delimiter (respects quoted fields). */
export function parseCsvLine(line: string, delimiter: string = ','): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === delimiter && !inQuotes) || c === '\r') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Detects CSV delimiter from first line: use semicolon if it yields more columns than comma. */
function detectCsvDelimiter(firstLine: string): string {
  const byComma = parseCsvLine(firstLine, ',').length;
  const bySemicolon = parseCsvLine(firstLine, ';').length;
  return bySemicolon > byComma ? ';' : ',';
}

export function parseCsv(content: string): string[][] {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return [];
  const delimiter = detectCsvDelimiter(lines[0]);
  return lines.map((l) => parseCsvLine(l, delimiter));
}

/** Spintax: {option1|option2|option3} → one option chosen at random per occurrence. */
export function expandSpintax(text: string): string {
  const re = /\{([^{}|]+(?:\|[^{}|]+)*)\}/g;
  return text.replace(re, (_match, options: string) => {
    const parts = options.split('|').map((s) => s.trim());
    if (parts.length === 0) return '';
    return parts[Math.floor(Math.random() * parts.length)] ?? '';
  });
}

export function substituteVariables(
  content: string,
  contact: { first_name?: string | null; last_name?: string | null },
  company: { name?: string | null } | null
): string {
  const first = (contact?.first_name ?? '').trim();
  const last = (contact?.last_name ?? '').trim();
  const companyName = (company?.name ?? '').trim();
  let out = content
    .replace(/\{\{contact\.first_name\}\}/g, first)
    .replace(/\{\{contact\.last_name\}\}/g, last)
    .replace(/\{\{company\.name\}\}/g, companyName);
  out = out.replace(/[ \t]+/g, ' ').replace(/\n +/g, '\n').replace(/ +\n/g, '\n').trim();
  return out;
}

/** Filters BD account rows for campaign list/detail responses (viewer: none; bidi: own only). */
export function filterBdAccountRowsForScope<T extends { created_by_user_id: string | null }>(
  rows: T[],
  scope: BdAccountsListScope,
  userId: string
): T[] {
  if (scope === 'none') return [];
  if (scope === 'own_only') return rows.filter((r) => r.created_by_user_id != null && r.created_by_user_id === userId);
  return rows;
}
