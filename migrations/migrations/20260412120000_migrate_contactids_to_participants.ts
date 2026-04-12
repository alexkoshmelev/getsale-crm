import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Move contactIds from target_audience JSONB into campaign_participants rows
  // for draft/paused campaigns that still store contacts in the JSONB field.
  await knex.raw(`
    INSERT INTO campaign_participants (id, campaign_id, contact_id, status, enqueue_order, created_at, updated_at)
    SELECT
      gen_random_uuid(),
      c.id,
      t.cid::uuid,
      'pending',
      (t.ordinality - 1)::int,
      NOW(),
      NOW()
    FROM campaigns c,
         jsonb_array_elements_text(c.target_audience -> 'contactIds') WITH ORDINALITY AS t(cid, ordinality)
    WHERE c.status IN ('draft', 'paused')
      AND c.deleted_at IS NULL
      AND c.target_audience -> 'contactIds' IS NOT NULL
      AND jsonb_typeof(c.target_audience -> 'contactIds') = 'array'
      AND jsonb_array_length(c.target_audience -> 'contactIds') > 0
    ON CONFLICT (campaign_id, contact_id) DO NOTHING
  `);

  // Strip contactIds key from target_audience for migrated campaigns
  // jsonb_exists() is the function form of the "?" operator (which Knex interprets as a bind placeholder)
  await knex.raw(`
    UPDATE campaigns
    SET target_audience = target_audience - 'contactIds',
        updated_at = NOW()
    WHERE status IN ('draft', 'paused')
      AND deleted_at IS NULL
      AND jsonb_exists(target_audience, 'contactIds')
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Reverse: rebuild contactIds in target_audience from campaign_participants for draft/paused campaigns
  await knex.raw(`
    UPDATE campaigns c
    SET target_audience = COALESCE(c.target_audience, '{}'::jsonb) || jsonb_build_object(
      'contactIds',
      (SELECT COALESCE(jsonb_agg(cp.contact_id::text ORDER BY cp.enqueue_order NULLS LAST, cp.created_at), '[]'::jsonb)
       FROM campaign_participants cp
       WHERE cp.campaign_id = c.id)
    ),
    updated_at = NOW()
    WHERE c.status IN ('draft', 'paused')
      AND c.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM campaign_participants cp2 WHERE cp2.campaign_id = c.id)
  `);
}
