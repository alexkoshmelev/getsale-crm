import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { ServiceHttpClient, ServiceCallError } from '@getsale/service-core';

export type Schedule = {
  timezone?: string;
  workingHours?: { start?: string; end?: string };
  daysOfWeek?: number[];
} | null;

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

export function normalizeTelegramUsername(username: unknown): string | null {
  if (typeof username !== 'string') return null;
  const normalized = username.trim().replace(/^@/, '');
  return normalized !== '' ? normalized : null;
}

export function resolveCampaignChannelId(
  telegramId: unknown,
  username: unknown
): string | null {
  const usernameNorm = normalizeTelegramUsername(username);
  const telegramIdNorm =
    telegramId != null && String(telegramId).trim() !== '' ? String(telegramId).trim() : null;
  return usernameNorm ?? telegramIdNorm;
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

export function dateInTz(d: Date, tz: string): { hour: number; minute: number; dayOfWeek: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short' });
  const parts = fmt.formatToParts(d);
  let hour = 0, minute = 0, dayOfWeek = 1;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
    if (p.type === 'weekday') dayOfWeek = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[p.value.toLowerCase().slice(0, 3)] ?? 1;
  }
  return { hour, minute, dayOfWeek };
}

export function isWithinScheduleAt(d: Date, schedule: Schedule): boolean {
  if (!schedule?.workingHours?.start || !schedule?.workingHours?.end || !schedule.daysOfWeek?.length) return true;
  const tz = schedule.timezone || 'UTC';
  const { hour, minute, dayOfWeek } = dateInTz(d, tz);
  const [startH] = schedule.workingHours.start.split(':').map(Number);
  const [endH] = schedule.workingHours.end.split(':').map(Number);
  const inWindow = hour > startH || (hour === startH && minute >= 0);
  const beforeEnd = hour < endH || (hour === endH && minute === 0);
  return inWindow && beforeEnd && schedule.daysOfWeek.includes(dayOfWeek);
}

export function isWithinSchedule(schedule: Schedule): boolean {
  return isWithinScheduleAt(new Date(), schedule);
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
      const body = err.body as { leadId?: string; id?: string } | undefined;
      return body?.leadId ?? body?.id ?? null;
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
