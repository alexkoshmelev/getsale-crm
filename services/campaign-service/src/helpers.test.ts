import { describe, it, expect } from 'vitest';
import {
  getContactField,
  evalContactRule,
  substituteVariables,
  expandSpintax,
  delayHoursFromStep,
  parseCsvLine,
  parseCsv,
  dateInTz,
  isWithinScheduleAt,
  resolveDelayRange,
  resolveCampaignChannelId,
  normalizeTelegramUsername,
  sampleDelaySeconds,
  staggeredFirstSendAtByOffset,
  staggeredFirstSendAt,
  type Schedule,
} from './helpers';

describe('getContactField', () => {
  it('returns trimmed string for present fields', () => {
    expect(getContactField({ first_name: '  John  ' }, 'first_name')).toBe('John');
    expect(getContactField({ email: 'a@b.co' }, 'email')).toBe('a@b.co');
  });

  it('returns empty string for missing or null', () => {
    expect(getContactField({}, 'first_name')).toBe('');
    expect(getContactField({ first_name: null }, 'first_name')).toBe('');
  });
});

describe('evalContactRule', () => {
  it('equals: matches case-insensitive', () => {
    expect(evalContactRule({ first_name: 'John' }, { field: 'first_name', op: 'equals', value: 'john' })).toBe(true);
    expect(evalContactRule({ first_name: 'Jane' }, { field: 'first_name', op: 'equals', value: 'john' })).toBe(false);
  });

  it('not_equals', () => {
    expect(evalContactRule({ first_name: 'John' }, { field: 'first_name', op: 'not_equals', value: 'jane' })).toBe(true);
    expect(evalContactRule({ first_name: 'John' }, { field: 'first_name', op: 'not_equals', value: 'john' })).toBe(false);
  });

  it('contains', () => {
    expect(evalContactRule({ first_name: 'Jonathan' }, { field: 'first_name', op: 'contains', value: 'nat' })).toBe(true);
    expect(evalContactRule({ first_name: 'John' }, { field: 'first_name', op: 'contains', value: 'x' })).toBe(false);
  });

  it('empty / not_empty', () => {
    expect(evalContactRule({ first_name: '' }, { field: 'first_name', op: 'empty' })).toBe(true);
    expect(evalContactRule({ first_name: 'x' }, { field: 'first_name', op: 'empty' })).toBe(false);
    expect(evalContactRule({ first_name: 'x' }, { field: 'first_name', op: 'not_empty' })).toBe(true);
    expect(evalContactRule({ first_name: '' }, { field: 'first_name', op: 'not_empty' })).toBe(false);
  });
});

describe('substituteVariables', () => {
  it('replaces contact and company placeholders', () => {
    const contact = { first_name: 'John', last_name: 'Doe' };
    const company = { name: 'Acme' };
    expect(substituteVariables('Hello {{contact.first_name}} {{contact.last_name}} from {{company.name}}', contact, company))
      .toBe('Hello John Doe from Acme');
  });

  it('handles null company', () => {
    expect(substituteVariables('{{contact.first_name}}', { first_name: 'A' }, null)).toBe('A');
  });

  it('normalizes whitespace', () => {
    expect(substituteVariables('  a   b  ', {}, null)).toBe('a b');
  });
});

describe('expandSpintax', () => {
  it('picks one option from spintax block', () => {
    const result = expandSpintax('{A|B|C}');
    expect(['A', 'B', 'C']).toContain(result);
    expect(result).not.toContain('|');
    expect(result).not.toContain('{');
  });

  it('expands multiple blocks', () => {
    const result = expandSpintax('{Hi|Hello}, {world|there}');
    expect(['Hi', 'Hello']).toContain(result.split(',')[0]?.trim());
    expect(['world', 'there']).toContain(result.split(',')[1]?.trim());
  });

  it('leaves text without spintax unchanged', () => {
    expect(expandSpintax('No spintax here')).toBe('No spintax here');
  });
});

describe('delayHoursFromStep', () => {
  it('returns delay from step', () => {
    expect(delayHoursFromStep({ delay_hours: 24, delay_minutes: 30 })).toBe(24.5);
    expect(delayHoursFromStep({ delay_hours: 1 })).toBe(1);
  });

  it('returns 24 when step is null/undefined', () => {
    expect(delayHoursFromStep(null)).toBe(24);
    expect(delayHoursFromStep(undefined)).toBe(24);
  });
});

describe('parseCsvLine', () => {
  it('splits by comma', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('splits by semicolon when given as delimiter', () => {
    expect(parseCsvLine('a;b;c', ';')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted fields', () => {
    expect(parseCsvLine('"a,b",c')).toEqual(['a,b', 'c']);
  });
});

describe('parseCsv', () => {
  it('auto-detects semicolon delimiter from first line', () => {
    const content = 'First Name;Last Name;Username\nJohn;Doe;johndoe';
    const rows = parseCsv(content);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['First Name', 'Last Name', 'Username']);
    expect(rows[1]).toEqual(['John', 'Doe', 'johndoe']);
  });

  it('uses comma when comma yields more columns', () => {
    const content = 'a,b,c\n1,2,3';
    const rows = parseCsv(content);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['a', 'b', 'c']);
    expect(rows[1]).toEqual(['1', '2', '3']);
  });
});

describe('dateInTz', () => {
  it('returns hour, minute, dayOfWeek for UTC', () => {
    const d = new Date('2025-03-05T14:30:00.000Z');
    const r = dateInTz(d, 'UTC');
    expect(r.hour).toBe(14);
    expect(r.minute).toBe(30);
    expect(r.dayOfWeek).toBe(3); // Wednesday
  });
});

describe('isWithinScheduleAt', () => {
  it('returns true when schedule is empty or incomplete', () => {
    expect(isWithinScheduleAt(new Date(), null)).toBe(true);
    expect(isWithinScheduleAt(new Date(), {})).toBe(true);
    expect(isWithinScheduleAt(new Date(), { workingHours: { start: '09:00' } })).toBe(true);
  });

  it('returns false when day not in daysOfWeek', () => {
    const schedule: Schedule = {
      timezone: 'UTC',
      workingHours: { start: '09:00', end: '18:00' },
      daysOfWeek: [6], // Saturday only
    };
    const wed = new Date('2025-03-05T12:00:00.000Z'); // Wednesday
    expect(isWithinScheduleAt(wed, schedule)).toBe(false);
  });
});

describe('staggeredFirstSendAt', () => {
  it('offsets by queueIndex * sendDelaySeconds when schedule is incomplete', () => {
    const base = new Date('2026-03-19T10:00:00.000Z');
    const schedule: Schedule = {};
    expect(staggeredFirstSendAt(base, 0, 60, schedule).getTime()).toBe(base.getTime());
    expect(staggeredFirstSendAt(base, 2, 60, schedule).getTime()).toBe(base.getTime() + 120_000);
  });

  it('uses 0 delay when sendDelaySeconds is negative', () => {
    const base = new Date('2026-03-19T10:00:00.000Z');
    expect(staggeredFirstSendAt(base, 1, -5, {}).getTime()).toBe(base.getTime());
  });
});

describe('resolveDelayRange', () => {
  it('uses min/max when both provided', () => {
    expect(resolveDelayRange({ sendDelayMinSeconds: 10, sendDelayMaxSeconds: 20 }, 60)).toEqual({
      minSeconds: 10,
      maxSeconds: 20,
    });
  });

  it('falls back to legacy sendDelaySeconds', () => {
    expect(resolveDelayRange({ sendDelaySeconds: 77 }, 60)).toEqual({
      minSeconds: 77,
      maxSeconds: 77,
    });
  });
});

describe('sampleDelaySeconds', () => {
  it('returns fixed value for equal bounds', () => {
    expect(sampleDelaySeconds({ minSeconds: 13, maxSeconds: 13 })).toBe(13);
  });
});

describe('campaign channel id resolution', () => {
  it('prefers username over telegram id when both exist', () => {
    expect(resolveCampaignChannelId('123456789', '@john_doe')).toBe('john_doe');
  });

  it('falls back to telegram id when username is missing', () => {
    expect(resolveCampaignChannelId('123456789', null)).toBe('123456789');
  });

  it('normalizes username by trimming and removing @', () => {
    expect(normalizeTelegramUsername('  @Sales_User  ')).toBe('Sales_User');
  });
});

describe('staggeredFirstSendAtByOffset', () => {
  it('adds exact offset when schedule is empty', () => {
    const base = new Date('2026-03-19T10:00:00.000Z');
    expect(staggeredFirstSendAtByOffset(base, 193, {}).getTime()).toBe(base.getTime() + 193_000);
  });
});
