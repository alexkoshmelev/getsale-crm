import { describe, it, expect } from 'vitest';
import {
  getContactField,
  evalContactRule,
  substituteVariables,
  delayHoursFromStep,
  parseCsvLine,
  dateInTz,
  isWithinScheduleAt,
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

  it('handles quoted fields', () => {
    expect(parseCsvLine('"a,b",c')).toEqual(['a,b', 'c']);
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
