import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE campaign_participants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_sequences ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_sends ENABLE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation_campaign_participants ON campaign_participants
      USING (campaign_id IN (SELECT id FROM campaigns WHERE organization_id = current_setting('app.current_organization_id')::uuid));

    CREATE POLICY bypass_rls_campaign_participants ON campaign_participants
      USING (current_setting('app.bypass_rls', true) = 'true');

    CREATE POLICY tenant_isolation_campaign_sequences ON campaign_sequences
      USING (campaign_id IN (SELECT id FROM campaigns WHERE organization_id = current_setting('app.current_organization_id')::uuid));

    CREATE POLICY bypass_rls_campaign_sequences ON campaign_sequences
      USING (current_setting('app.bypass_rls', true) = 'true');

    CREATE POLICY tenant_isolation_campaign_sends ON campaign_sends
      USING (campaign_participant_id IN (
        SELECT cp.id FROM campaign_participants cp
        JOIN campaigns c ON c.id = cp.campaign_id
        WHERE c.organization_id = current_setting('app.current_organization_id')::uuid
      ));

    CREATE POLICY bypass_rls_campaign_sends ON campaign_sends
      USING (current_setting('app.bypass_rls', true) = 'true');
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP POLICY IF EXISTS tenant_isolation_campaign_participants ON campaign_participants;
    DROP POLICY IF EXISTS bypass_rls_campaign_participants ON campaign_participants;
    ALTER TABLE campaign_participants DISABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS tenant_isolation_campaign_sequences ON campaign_sequences;
    DROP POLICY IF EXISTS bypass_rls_campaign_sequences ON campaign_sequences;
    ALTER TABLE campaign_sequences DISABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS tenant_isolation_campaign_sends ON campaign_sends;
    DROP POLICY IF EXISTS bypass_rls_campaign_sends ON campaign_sends;
    ALTER TABLE campaign_sends DISABLE ROW LEVEL SECURITY;
  `);
}
