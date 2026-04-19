import fs from 'fs';
import path from 'path';
import type { Knex } from 'knex';

/** Full schema snapshot (squashed). Down is intentionally unsupported. */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  const sqlPath = path.join(__dirname, 'sql', 'initial_schema.sql');
  let sql = fs.readFileSync(sqlPath, 'utf8');
  if (sql.charCodeAt(0) === 0xfeff) sql = sql.slice(1);
  // pg_dump may emit psql meta-commands (\restrict / \unrestrict) — not valid in server protocol
  sql = sql
    .split('\n')
    .filter((line) => !/^\s*\\[a-z]+/i.test(line))
    .join('\n');
  // Dump clears search_path; Knex must see public.* after this migration runs.
  sql = sql.replace(/SELECT pg_catalog\.set_config\('search_path', '', false\);/g, '');
  await knex.raw(sql);
  await knex.raw('SET search_path TO public');
}

export async function down(): Promise<void> {
  throw new Error(
    '20260412220000_initial_schema is irreversible (squashed migration). Restore database from backup instead.',
  );
}
