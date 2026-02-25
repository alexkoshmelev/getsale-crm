import { Knex } from 'knex';

/**
 * ЭТАП 3: системная финальная стадия Converted для конверсии лида в сделку.
 * Добавляется во все существующие pipelines (последней по order_index).
 */
const CONVERTED_STAGE_NAME = 'Converted';
const CONVERTED_STAGE_COLOR = '#059669';

export async function up(knex: Knex): Promise<void> {
  const pipelines = await knex('pipelines').select('id', 'organization_id');
  for (const pipe of pipelines) {
    const maxOrder = await knex('stages')
      .where({ pipeline_id: pipe.id })
      .max('order_index as max')
      .first();
    const nextOrder = (Number(maxOrder?.max ?? -1) + 1) as number;
    const existing = await knex('stages')
      .where({ pipeline_id: pipe.id, organization_id: pipe.organization_id, name: CONVERTED_STAGE_NAME })
      .first();
    if (!existing) {
      await knex('stages').insert({
        pipeline_id: pipe.id,
        organization_id: pipe.organization_id,
        name: CONVERTED_STAGE_NAME,
        order_index: nextOrder,
        color: CONVERTED_STAGE_COLOR,
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('stages').where('name', CONVERTED_STAGE_NAME).del();
}
