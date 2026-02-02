import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.string('first_name', 255).nullable();
    table.string('last_name', 255).nullable();
    table.string('username', 255).nullable();
    table.text('bio').nullable();
    table.string('photo_file_id', 512).nullable(); // Telegram file_id / photo reference for avatar
    table.string('display_name', 255).nullable(); // custom name for UI (e.g. "Work", "Support")
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.dropColumn('first_name');
    table.dropColumn('last_name');
    table.dropColumn('username');
    table.dropColumn('bio');
    table.dropColumn('photo_file_id');
    table.dropColumn('display_name');
  });
}
