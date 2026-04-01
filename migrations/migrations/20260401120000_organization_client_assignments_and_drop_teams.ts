import { Knex } from 'knex';

/**
 * Workspace-only model: client assignments and team membership live at organization level.
 * Replaces team_client_assignments; removes teams / team_members / team_invitations.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('organization_client_assignments'))) {
    await knex.schema.createTable('organization_client_assignments', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table
        .uuid('organization_id')
        .notNullable()
        .references('id')
        .inTable('organizations')
        .onDelete('CASCADE');
      table.uuid('client_id').notNullable();
      table.uuid('assigned_to').notNullable().references('id').inTable('users');
      table.timestamp('assigned_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('assigned_by').references('id').inTable('users');
      table.unique(['organization_id', 'client_id']);
      table.index('organization_id');
      table.index('client_id');
    });
  }

  if (await knex.schema.hasTable('team_client_assignments')) {
    const colRows = await knex('information_schema.columns')
      .select('column_name')
      .where({ table_schema: 'public', table_name: 'team_client_assignments' });
    const colNames = new Set(colRows.map((r: { column_name: string }) => r.column_name));
    const assignExpr = colNames.has('assigned_to')
      ? 'COALESCE(tca.assigned_to, tca.assigned_by)'
      : 'tca.assigned_by';
    await knex.raw(`
      INSERT INTO organization_client_assignments (organization_id, client_id, assigned_to, assigned_at, assigned_by)
      SELECT organization_id, client_id, assigned_to, assigned_at, assigned_by
      FROM (
        SELECT DISTINCT ON (t.organization_id, tca.client_id)
          t.organization_id,
          tca.client_id,
          ${assignExpr} AS assigned_to,
          tca.assigned_at,
          tca.assigned_by
        FROM team_client_assignments tca
        INNER JOIN teams t ON t.id = tca.team_id
        WHERE ${assignExpr} IS NOT NULL
        ORDER BY t.organization_id, tca.client_id, tca.assigned_at DESC
      ) sub
      ON CONFLICT (organization_id, client_id) DO NOTHING
    `);
    await knex.schema.dropTable('team_client_assignments');
  }

  if (await knex.schema.hasTable('teams')) {
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation_teams ON teams`);
    await knex.raw(`DROP POLICY IF EXISTS bypass_rls_teams ON teams`);
    await knex.raw(`ALTER TABLE teams DISABLE ROW LEVEL SECURITY`);
  }

  if (await knex.schema.hasTable('team_invitations')) {
    await knex.schema.dropTable('team_invitations');
  }
  if (await knex.schema.hasTable('team_members')) {
    await knex.schema.dropTable('team_members');
  }
  if (await knex.schema.hasTable('teams')) {
    await knex.schema.dropTable('teams');
  }

  // RLS for new org-scoped table (same pattern as 20260313130000_row_level_security)
  const rlsExists = await knex.raw(`
    SELECT 1 FROM pg_policies WHERE tablename = 'organization_client_assignments' AND policyname = 'tenant_isolation_organization_client_assignments'
  `);
  if (rlsExists.rows?.length === 0 && (await knex.schema.hasTable('organization_client_assignments'))) {
    await knex.raw(`ALTER TABLE organization_client_assignments ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation_organization_client_assignments ON organization_client_assignments
        USING (organization_id = current_setting('app.current_org_id', true)::uuid)
    `);
    await knex.raw(`
      CREATE POLICY bypass_rls_organization_client_assignments ON organization_client_assignments
        USING (current_setting('app.current_org_id', true) IS NULL)
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation_organization_client_assignments ON organization_client_assignments`);
  await knex.raw(`DROP POLICY IF EXISTS bypass_rls_organization_client_assignments ON organization_client_assignments`);
  await knex.raw(`ALTER TABLE organization_client_assignments DISABLE ROW LEVEL SECURITY`);

  await knex.schema.dropTableIfExists('organization_client_assignments');

  await knex.schema.createTable('teams', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('name', 255).notNullable();
    table.uuid('created_by').notNullable().references('id').inTable('users');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.index('organization_id');
  });

  await knex.schema.createTable('team_members', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users');
    table.string('role', 50).notNullable().defaultTo('member');
    table.uuid('invited_by').references('id').inTable('users');
    table.string('status', 50).notNullable().defaultTo('active');
    table.timestamp('joined_at').notNullable().defaultTo(knex.fn.now());
    table.index('team_id');
    table.index('user_id');
    table.unique(['team_id', 'user_id']);
  });

  await knex.schema.createTable('team_invitations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    table.string('email', 255).notNullable();
    table.string('role', 50).notNullable().defaultTo('member');
    table.uuid('invited_by').notNullable().references('id').inTable('users');
    table.string('token', 255).notNullable().unique();
    table.timestamp('expires_at').notNullable();
    table.timestamp('accepted_at');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('team_client_assignments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    table.uuid('client_id').notNullable();
    table.timestamp('assigned_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('assigned_by').references('id').inTable('users');
    table.index('team_id');
    table.index('client_id');
  });
}
