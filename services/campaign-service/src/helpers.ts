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

export function delayHoursFromStep(step: { delay_hours?: number; delay_minutes?: number } | null | undefined): number {
  if (!step) return 24;
  const h = step.delay_hours ?? 24;
  const m = step.delay_minutes ?? 0;
  return h + m / 60;
}

export function nextSlotRetry(_schedule: Schedule): Date {
  return new Date(Date.now() + 15 * 60 * 1000);
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
