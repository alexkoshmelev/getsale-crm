import { Knex } from 'knex';

/**
 * Объединение дубликатов команд "Default Team" в организации.
 * Оставляет одну команду (самую старую по created_at), переносит участников из остальных, удаляет дубликаты.
 */
export async function up(knex: Knex): Promise<void> {
  const duplicates = await knex('teams')
    .select('organization_id')
    .where('name', 'Default Team')
    .groupBy('organization_id')
    .havingRaw('count(*) > 1');

  for (const { organization_id } of duplicates) {
    const teams = await knex('teams')
      .where({ organization_id, name: 'Default Team' })
      .orderBy('created_at', 'asc');

    const [keepTeam, ...toMerge] = teams;
    if (!keepTeam || toMerge.length === 0) continue;

    for (const other of toMerge) {
      // Move team_members from other to keepTeam (skip if user already in keepTeam)
      await knex.raw(
        `INSERT INTO team_members (id, team_id, user_id, role, invited_by, status, joined_at)
         SELECT gen_random_uuid(), ?, tm.user_id, tm.role, tm.invited_by, tm.status, tm.joined_at
         FROM team_members tm
         WHERE tm.team_id = ?
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [keepTeam.id, other.id]
      );
      // Delete old memberships from the duplicate team (so we can delete the team)
      await knex('team_members').where('team_id', other.id).del();
      await knex('teams').where('id', other.id).del();
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // No safe way to restore deleted duplicate teams; no-op
}
