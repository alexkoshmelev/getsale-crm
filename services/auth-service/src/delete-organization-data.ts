import type { PoolClient } from 'pg';

/**
 * Hard-delete all tenant data for an organization. Call inside a transaction.
 * Caller must ensure no users still reference this organization_id (users.organization_id FK).
 */
export async function deleteOrganizationData(client: PoolClient, organizationId: string): Promise<void> {
  const o = organizationId;

  // Messaging / AI (conversation_ai_insights references conversations)
  await client.query(
    `DELETE FROM conversation_ai_insights WHERE conversation_id IN (SELECT id FROM conversations WHERE organization_id = $1)`,
    [o]
  );
  await client.query(`DELETE FROM conversations WHERE organization_id = $1`, [o]);

  // Campaigns tree
  await client.query(
    `DELETE FROM campaign_sends WHERE campaign_participant_id IN (
       SELECT id FROM campaign_participants WHERE campaign_id IN (SELECT id FROM campaigns WHERE organization_id = $1)
     )`,
    [o]
  );
  await client.query(
    `DELETE FROM campaign_participants WHERE campaign_id IN (SELECT id FROM campaigns WHERE organization_id = $1)`,
    [o]
  );
  await client.query(
    `DELETE FROM campaign_sequences WHERE campaign_id IN (SELECT id FROM campaigns WHERE organization_id = $1)`,
    [o]
  );
  await client.query(`DELETE FROM campaign_templates WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM campaigns WHERE organization_id = $1`, [o]);

  // CRM / pipeline (lead_activity_log cascades from leads)
  await client.query(`DELETE FROM leads WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM stage_history WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM deals WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM contacts WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM companies WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM stages WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM pipelines WHERE organization_id = $1`, [o]);

  await client.query(`DELETE FROM messages WHERE organization_id = $1`, [o]);

  await client.query(`DELETE FROM automation_executions WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM automation_rules WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM analytics_metrics WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM conversion_rates WHERE organization_id = $1`, [o]);

  await client.query(`DELETE FROM user_chat_pins WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM notes WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM reminders WHERE organization_id = $1`, [o]);

  await client.query(`DELETE FROM contact_telegram_sources WHERE organization_id = $1`, [o]);

  // BD accounts (children cascade from bd_accounts in migrations)
  await client.query(`DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id IN (SELECT id FROM bd_accounts WHERE organization_id = $1)`, [o]);
  await client.query(`DELETE FROM bd_account_sync_folders WHERE bd_account_id IN (SELECT id FROM bd_accounts WHERE organization_id = $1)`, [o]);
  await client.query(`DELETE FROM bd_account_sync_chats WHERE bd_account_id IN (SELECT id FROM bd_accounts WHERE organization_id = $1)`, [o]);
  await client.query(`DELETE FROM bd_accounts WHERE organization_id = $1`, [o]);

  await client.query(`DELETE FROM contact_discovery_tasks WHERE organization_id = $1`, [o]);

  await client.query(`DELETE FROM organization_activity WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM organization_settings WHERE organization_id = $1`, [o]);

  // subscriptions: one row per user — caller should reassign organization_id before delete if needed
  await client.query(`DELETE FROM user_profiles WHERE organization_id = $1`, [o]);

  // Teams
  await client.query(`DELETE FROM team_invitations WHERE team_id IN (SELECT id FROM teams WHERE organization_id = $1)`, [o]);
  await client.query(`DELETE FROM team_client_assignments WHERE team_id IN (SELECT id FROM teams WHERE organization_id = $1)`, [o]);
  await client.query(`DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE organization_id = $1)`, [o]);
  await client.query(`DELETE FROM teams WHERE organization_id = $1`, [o]);

  await client.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM organization_invite_links WHERE organization_id = $1`, [o]);
  await client.query(`DELETE FROM organization_members WHERE organization_id = $1`, [o]);

  await client.query(`DELETE FROM organizations WHERE id = $1`, [o]);
}
