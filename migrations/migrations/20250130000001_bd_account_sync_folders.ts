import { Knex } from 'knex';

/**
 * Папки для синхронизации: пользователь выбирает папки (Личное, Все чаты, кастомные),
 * только чаты из этих папок подтягиваются и отображаются.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bd_account_sync_folders', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('bd_account_id').notNullable().references('id').inTable('bd_accounts').onDelete('CASCADE');
    // folder_id: int для Telegram (0 = все чаты, 1 = архив, 2+ = id фильтра); или спец-код в отдельном поле
    table.integer('folder_id').notNullable(); // Telegram folder/filter id
    table.string('folder_title', 255).notNullable(); // для UI
    table.integer('order_index').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['bd_account_id', 'folder_id']);
    table.index('bd_account_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('bd_account_sync_folders');
}
