import { Pool, PoolClient } from 'pg';
import { AppError, ErrorCodes, parsePageLimit, buildPagedResponse } from '@getsale/service-core';

/** Re-export shared pagination for routes that import from ../helpers. */
export { parsePageLimit, buildPagedResponse };

export async function getFirstStageId(
  pool: Pool,
  pipelineId: string,
  organizationId: string
): Promise<string | null> {
  const r = await pool.query(
    `SELECT id FROM stages
     WHERE pipeline_id = $1 AND organization_id = $2
     ORDER BY order_index ASC LIMIT 1`,
    [pipelineId, organizationId]
  );
  return r.rows[0]?.id ?? null;
}

export async function ensureStageInPipeline(
  pool: Pool,
  stageId: string,
  pipelineId: string,
  organizationId: string
): Promise<void> {
  const r = await pool.query(
    `SELECT 1 FROM stages
     WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3`,
    [stageId, pipelineId, organizationId]
  );
  if (r.rows.length === 0) {
    throw new AppError(400, 'Stage does not belong to the specified pipeline', ErrorCodes.VALIDATION);
  }
}

export async function ensureEntityAccess(
  pool: Pool,
  organizationId: string,
  entityType: 'contact' | 'deal',
  entityId: string
): Promise<void> {
  const table = entityType === 'contact' ? 'contacts' : 'deals';
  const r = await pool.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`,
    [entityId, organizationId]
  );
  if (r.rows.length === 0) {
    throw new AppError(
      404,
      `${entityType === 'contact' ? 'Contact' : 'Deal'} not found`,
      ErrorCodes.NOT_FOUND
    );
  }
}

const ENTITY_TYPE = ['contact', 'deal'] as const;
export type NotesRemindersEntityType = (typeof ENTITY_TYPE)[number];

/** List notes for a contact or deal. Use after ensureEntityAccess. */
export async function getNotesForEntity(
  pool: Pool,
  organizationId: string,
  entityType: NotesRemindersEntityType,
  entityId: string
): Promise<Record<string, unknown>[]> {
  const r = await pool.query(
    `SELECT id, entity_type, entity_id, content, user_id, created_at, updated_at
     FROM notes WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3
     ORDER BY created_at DESC`,
    [organizationId, entityType, entityId]
  );
  return r.rows;
}

/** Insert a note within an existing withOrgContext transaction. */
export async function insertNote(
  client: PoolClient,
  organizationId: string,
  entityType: NotesRemindersEntityType,
  entityId: string,
  content: string,
  userId: string | null
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `INSERT INTO notes (organization_id, entity_type, entity_id, content, user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [organizationId, entityType, entityId, content, userId]
  );
  return result.rows[0] as Record<string, unknown>;
}

/** List reminders for a contact or deal. Use after ensureEntityAccess. */
export async function getRemindersForEntity(
  pool: Pool,
  organizationId: string,
  entityType: NotesRemindersEntityType,
  entityId: string
): Promise<Record<string, unknown>[]> {
  const r = await pool.query(
    `SELECT id, entity_type, entity_id, remind_at, title, done, user_id, created_at
     FROM reminders WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3
     ORDER BY remind_at ASC`,
    [organizationId, entityType, entityId]
  );
  return r.rows;
}

/** Insert a reminder within an existing withOrgContext transaction. */
export async function insertReminder(
  client: PoolClient,
  organizationId: string,
  entityType: NotesRemindersEntityType,
  entityId: string,
  remindAt: Date,
  title: string | null,
  userId: string | null
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `INSERT INTO reminders (organization_id, entity_type, entity_id, remind_at, title, user_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [organizationId, entityType, entityId, remindAt, title, userId]
  );
  return result.rows[0] as Record<string, unknown>;
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === ',' && !inQuotes) || c === '\r') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}
