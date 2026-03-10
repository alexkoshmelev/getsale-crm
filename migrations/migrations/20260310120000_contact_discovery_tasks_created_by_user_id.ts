import type { Knex } from 'knex';

/**
 * Add created_by_user_id to contact_discovery_tasks for SSE/Redis push (events:userId).
 * Used to deliver parse_progress and parse_done to the user who started the task.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contact_discovery_tasks', (table) => {
    table.uuid('created_by_user_id').nullable();
    table.index('created_by_user_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contact_discovery_tasks', (table) => {
    table.dropColumn('created_by_user_id');
  });
}
