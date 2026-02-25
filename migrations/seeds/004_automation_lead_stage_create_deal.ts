import { Knex } from 'knex';

/**
 * ЭТАП 4 MVP: один rule — при переходе лида в стадию X создавать сделку.
 * trigger_type = lead.stage.changed, trigger_conditions = { pipeline_id, to_stage_id }, actions = [{ type: 'create_deal' }].
 * Без UI; один сценарий end-to-end.
 */
export async function seed(knex: Knex): Promise<void> {
  const org = await knex('organizations').orderBy('created_at').first();
  if (!org) {
    console.log('⏭️ 004_automation_lead_stage_create_deal: no organization, skip.');
    return;
  }

  const pipeline = await knex('pipelines')
    .where({ organization_id: org.id, is_default: true })
    .first();
  if (!pipeline) {
    console.log('⏭️ 004_automation_lead_stage_create_deal: no default pipeline, skip.');
    return;
  }

  const stage = await knex('stages')
    .where({ pipeline_id: pipeline.id, organization_id: org.id })
    .whereNot('name', 'Converted')
    .orderBy('order_index')
    .first();
  if (!stage) {
    console.log('⏭️ 004_automation_lead_stage_create_deal: no non-Converted stage, skip.');
    return;
  }

  const existing = await knex('automation_rules')
    .where({
      organization_id: org.id,
      trigger_type: 'lead.stage.changed',
    })
    .first();
  if (existing) {
    console.log('⏭️ 004_automation_lead_stage_create_deal: rule already exists, skip.');
    return;
  }

  await knex('automation_rules').insert({
    organization_id: org.id,
    name: 'Create deal when lead moves to stage',
    trigger_type: 'lead.stage.changed',
    trigger_conditions: JSON.stringify({
      pipeline_id: pipeline.id,
      to_stage_id: stage.id,
    }),
    actions: JSON.stringify([{ type: 'create_deal' }]),
    is_active: true,
  });
  console.log(`✅ 004: automation rule lead.stage.changed → create_deal (pipeline=${pipeline.id}, to_stage=${stage.name})`);
}
