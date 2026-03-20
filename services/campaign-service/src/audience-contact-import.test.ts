import { describe, it, expect } from 'vitest';
import { parseUsernameListToRows } from './audience-contact-import';

describe('parseUsernameListToRows', () => {
  it('strips @ and normalizes username to lowercase', () => {
    const { rows, skipped } = parseUsernameListToRows('@Sam_Getsale');
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe('sam_getsale');
    expect(rows[0]!.telegramId).toBeNull();
    expect(rows[0]!.firstName).toBe('Sam_Getsale');
  });

  it('dedupes case-insensitively for usernames', () => {
    const { rows } = parseUsernameListToRows('@SameUser\nsameuser\n@SAMEUSER');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe('sameuser');
  });

  it('treats digits-only line as telegram_id', () => {
    const { rows, skipped } = parseUsernameListToRows('12345');
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.telegramId).toBe('12345');
    expect(rows[0]!.username).toBeNull();
  });

  it('skips too-short usernames', () => {
    const { rows, skipped, invalidSamples } = parseUsernameListToRows('abcd');
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
    expect(invalidSamples).toContain('abcd');
  });

  it('skips empty lines and counts invalid', () => {
    const { rows, skipped } = parseUsernameListToRows('\n\n  \n@validuser\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe('validuser');
    expect(skipped).toBe(0);
  });

  it('accepts 5-char username and user examples shape', () => {
    const text = `@sam_getsale
getyurii
h5572695374
CJKJASO`;
    const { rows, skipped } = parseUsernameListToRows(text);
    expect(skipped).toBe(0);
    expect(rows.map((r) => r.username || r.telegramId)).toEqual([
      'sam_getsale',
      'getyurii',
      'h5572695374',
      'cjkjaso',
    ]);
  });

  it('rejects invalid characters in username', () => {
    const { rows, skipped } = parseUsernameListToRows('bad-name');
    expect(rows).toHaveLength(0);
    expect(skipped).toBeGreaterThanOrEqual(1);
  });
});
