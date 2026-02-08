import { Knex } from 'knex';

/**
 * Унификация ролей: team_members.role 'member' → 'bidi' (совместимость с UserRole).
 */
export async function up(knex: Knex): Promise<void> {
  await knex('team_members').where({ role: 'member' }).update({ role: 'bidi' });
}

export async function down(knex: Knex): Promise<void> {
  // Не восстанавливаем 'member' — оставляем bidi
}
