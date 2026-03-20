import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { QueryParam } from './types';

export interface CsvContactRow {
  telegramId: string | null;
  email: string | null;
  username: string | null;
  firstName: string;
  lastName: string | null;
  phone: string | null;
}

const MAX_INVALID_SAMPLES = 10;
const USERNAME_RE = /^[a-zA-Z0-9_]{5,32}$/;
const DIGITS_ONLY_RE = /^\d+$/;

/**
 * Parse multiline text: one Telegram username (optional @) or numeric user id per line.
 * Dedupes case-insensitively for usernames; preserves order of first occurrence.
 */
export function parseUsernameListToRows(text: string): {
  rows: CsvContactRow[];
  skipped: number;
  invalidSamples: string[];
} {
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const rows: CsvContactRow[] = [];
  let skipped = 0;
  const invalidSamples: string[] = [];

  const pushInvalid = (sample: string) => {
    skipped++;
    if (invalidSamples.length < MAX_INVALID_SAMPLES) invalidSamples.push(sample.slice(0, 64));
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const token = line.replace(/^@+/, '').trim();
    if (!token) {
      pushInvalid(rawLine.trim() || '(empty)');
      continue;
    }

    let telegramId: string | null = null;
    let username: string | null = null;
    let firstName: string;

    if (DIGITS_ONLY_RE.test(token)) {
      telegramId = token;
      firstName = 'Contact';
      const key = `t:${telegramId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    } else {
      const lower = token.toLowerCase();
      if (!USERNAME_RE.test(lower)) {
        pushInvalid(token);
        continue;
      }
      username = lower;
      firstName = token.length <= 80 ? token : token.slice(0, 80);
      const key = `u:${username}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }

    rows.push({
      telegramId,
      email: null,
      username,
      firstName,
      lastName: null,
      phone: null,
    });
  }

  return { rows, skipped, invalidSamples };
}

/**
 * Match existing contacts by telegram_id / email / username and insert missing rows (same semantics as CSV import).
 */
export async function matchOrCreateContactsFromRows(
  pool: Pool,
  orgId: string,
  validRows: CsvContactRow[]
): Promise<{ contactIds: string[]; created: number; matched: number }> {
  const contactIds: string[] = [];
  let created = 0;
  let matched = 0;
  const BATCH_SIZE = 100;

  for (let b = 0; b < validRows.length; b += BATCH_SIZE) {
    const batch = validRows.slice(b, b + BATCH_SIZE);
    const telegramIds = batch.map((r) => r.telegramId).filter(Boolean) as string[];
    const emails = batch.map((r) => r.email).filter(Boolean) as string[];
    const usernamesLower = batch.map((r) => (r.username ? r.username.toLowerCase() : null)).filter(Boolean) as string[];

    const matchByTg = new Map<string, string>();
    const matchByEmail = new Map<string, string>();
    const matchByUsername = new Map<string, string>();

    if (telegramIds.length > 0) {
      const r = await pool.query(
        'SELECT id, telegram_id FROM contacts WHERE organization_id = $1 AND telegram_id = ANY($2::text[])',
        [orgId, telegramIds]
      );
      for (const row of r.rows as { id: string; telegram_id: string }[]) matchByTg.set(row.telegram_id, row.id);
    }
    if (emails.length > 0) {
      const r = await pool.query(
        'SELECT id, email FROM contacts WHERE organization_id = $1 AND email = ANY($2::text[])',
        [orgId, emails]
      );
      for (const row of r.rows as { id: string; email: string }[]) matchByEmail.set(row.email, row.id);
    }
    if (usernamesLower.length > 0) {
      const r = await pool.query(
        'SELECT id, username FROM contacts WHERE organization_id = $1 AND username IS NOT NULL AND LOWER(username) = ANY($2::text[])',
        [orgId, usernamesLower]
      );
      for (const row of r.rows as { id: string; username: string }[]) {
        matchByUsername.set(row.username.toLowerCase(), row.id);
      }
    }

    const toInsert: CsvContactRow[] = [];
    const insertIds: string[] = [];

    for (const row of batch) {
      const uKey = row.username ? row.username.toLowerCase() : '';
      const existingId =
        (row.telegramId && matchByTg.get(row.telegramId)) ||
        (row.email && matchByEmail.get(row.email)) ||
        (row.username && matchByUsername.get(uKey)) ||
        null;
      if (existingId) {
        matched++;
        contactIds.push(existingId);
      } else {
        const newId = randomUUID();
        insertIds.push(newId);
        toInsert.push(row);
        contactIds.push(newId);
      }
    }

    if (toInsert.length > 0) {
      const values: QueryParam[] = [];
      const placeholders = toInsert.map((c, idx) => {
        const off = idx * 8 + 1;
        values.push(insertIds[idx], orgId, c.firstName, c.lastName, c.email, c.phone, c.telegramId, c.username);
        return `($${off}, $${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7}, NOW(), NOW())`;
      });
      await pool.query(
        `INSERT INTO contacts (id, organization_id, first_name, last_name, email, phone, telegram_id, username, created_at, updated_at)
         VALUES ${placeholders.join(', ')}`,
        values
      );
      created += toInsert.length;
    }
  }

  return { contactIds, created, matched };
}
