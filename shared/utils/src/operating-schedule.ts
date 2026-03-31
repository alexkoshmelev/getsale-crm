/**
 * Local operating window for BD accounts and campaign schedules.
 * Same shape as campaigns.schedule JSON.
 */
export type OperatingSchedule = {
  timezone?: string;
  workingHours?: { start?: string; end?: string };
  daysOfWeek?: number[];
} | null;

export function dateInTz(d: Date, tz: string): { hour: number; minute: number; dayOfWeek: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'UTC',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(d);
  let hour = 0;
  let minute = 0;
  let dayOfWeek = 1;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
    if (p.type === 'weekday')
      dayOfWeek =
        ({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as Record<string, number>)[
          p.value.toLowerCase().slice(0, 3)
        ] ?? 1;
  }
  return { hour, minute, dayOfWeek };
}

/** If schedule is null or incomplete, treated as no restriction (always "within"). */
export function isWithinOperatingScheduleAt(d: Date, schedule: OperatingSchedule): boolean {
  if (!schedule?.workingHours?.start || !schedule?.workingHours?.end || !schedule.daysOfWeek?.length) {
    return true;
  }
  const tz = schedule.timezone || 'UTC';
  const { hour, minute, dayOfWeek } = dateInTz(d, tz);
  const [startH] = schedule.workingHours.start.split(':').map(Number);
  const [endH] = schedule.workingHours.end.split(':').map(Number);
  const inWindow = hour > startH || (hour === startH && minute >= 0);
  const beforeEnd = hour < endH || (hour === endH && minute === 0);
  return inWindow && beforeEnd && schedule.daysOfWeek.includes(dayOfWeek);
}

export function isWithinOperatingSchedule(schedule: OperatingSchedule): boolean {
  return isWithinOperatingScheduleAt(new Date(), schedule);
}

export function isWithinCampaignAndAccountScheduleAt(
  d: Date,
  campaignSchedule: OperatingSchedule,
  accountSchedule: OperatingSchedule
): boolean {
  return isWithinOperatingScheduleAt(d, campaignSchedule) && isWithinOperatingScheduleAt(d, accountSchedule);
}

/**
 * Next time (inclusive search) at or after `from` when both schedules allow sending.
 * Steps in 15-minute increments (aligned with campaign staggering).
 */
export function nextIntersectionSlot(
  from: Date,
  campaignSchedule: OperatingSchedule,
  accountSchedule: OperatingSchedule,
  maxSteps = 672
): Date {
  let d = new Date(from.getTime());
  for (let i = 0; i < maxSteps; i++) {
    if (isWithinCampaignAndAccountScheduleAt(d, campaignSchedule, accountSchedule)) return d;
    d = new Date(d.getTime() + 15 * 60 * 1000);
  }
  return new Date(from.getTime() + 15 * 60 * 1000);
}
