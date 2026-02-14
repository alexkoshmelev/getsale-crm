import { Knex } from 'knex';

/**
 * RBAC: права для messaging (удаление сообщений, закреплённых чатов) и bd_accounts (настройки аккаунта, удаление чата из списка).
 */
export async function up(knex: Knex): Promise<void> {
  const perms: { role: string; resource: string; action: string }[] = [
    { role: 'owner', resource: 'messaging', action: '*' },
    { role: 'owner', resource: 'bd_accounts', action: '*' },
    { role: 'admin', resource: 'messaging', action: '*' },
    { role: 'admin', resource: 'bd_accounts', action: '*' },
  ];
  for (const p of perms) {
    await knex.raw(
      `INSERT INTO role_permissions (role, resource, action) VALUES (?, ?, ?) ON CONFLICT (role, resource, action) DO NOTHING`,
      [p.role, p.resource, p.action]
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('role_permissions').whereIn('resource', ['messaging', 'bd_accounts']).del();
}
