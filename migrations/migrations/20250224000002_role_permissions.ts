import { Knex } from 'knex';

/**
 * Гранулярные права по ролям (v2).
 * role + resource + action. Дефолты: owner — всё, admin — workspace/team/audit без transfer, остальные — ограниченно.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('role_permissions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('role', 50).notNullable();
    table.string('resource', 50).notNullable();
    table.string('action', 50).notNullable();
    table.unique(['role', 'resource', 'action']);
    table.index('role');
  });

  const perms: { role: string; resource: string; action: string }[] = [
    // owner — полный доступ ко всему
    { role: 'owner', resource: 'workspace', action: '*' },
    { role: 'owner', resource: 'team', action: '*' },
    { role: 'owner', resource: 'audit', action: '*' },
    { role: 'owner', resource: 'invitations', action: '*' },
    // admin — всё кроме transfer_ownership и delete workspace
    { role: 'admin', resource: 'workspace', action: 'read' },
    { role: 'admin', resource: 'workspace', action: 'update' },
    { role: 'admin', resource: 'team', action: '*' },
    { role: 'admin', resource: 'audit', action: 'read' },
    { role: 'admin', resource: 'invitations', action: '*' },
    // supervisor — команда и просмотр
    { role: 'supervisor', resource: 'team', action: 'read' },
    { role: 'supervisor', resource: 'workspace', action: 'read' },
    // bidi — базовый доступ
    { role: 'bidi', resource: 'workspace', action: 'read' },
    { role: 'bidi', resource: 'team', action: 'read' },
    // viewer — только чтение
    { role: 'viewer', resource: 'workspace', action: 'read' },
    { role: 'viewer', resource: 'team', action: 'read' },
  ];

  for (const p of perms) {
    await knex('role_permissions').insert(p);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('role_permissions');
}
