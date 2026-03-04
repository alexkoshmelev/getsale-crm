import { Knex } from 'knex';

const DEMO_ORG_SLUG = 'demo-workspace';
const MORE_LEADS_COUNT = 24;

/** Дата N дней от сегодня (положительное = в прошлом) */
function daysFromTodayAt10(daysFromToday: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysFromToday);
  d.setHours(10, Math.floor(Math.random() * 60), 0, 0);
  return d;
}

const LEAD_DAYS_FROM_TODAY = [
  -7, -7, -6, -5, -5, -4, -3, -2, -1, 0, 0, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6, 7, 7, 7,
];

/** Добавляем 24 лида по дням от -7 до +7 (контакты без лида в воронке). */
export async function seed(knex: Knex): Promise<void> {
  const org = await knex('organizations').where({ slug: DEMO_ORG_SLUG }).first() as { id: string } | undefined;
  if (!org) {
    console.log('⏭️ 003_more_demo_leads: demo workspace not found, skip.');
    return;
  }

  const existingCount = await knex('leads')
    .where({ organization_id: org.id })
    .count('* as c')
    .first();
  const total = Number((existingCount as { c?: string | number })?.c ?? 0);
  if (total >= 8 + MORE_LEADS_COUNT) {
    console.log('⏭️ 003_more_demo_leads: extra leads already present, skip.');
    return;
  }

  const pipeline = await knex('pipelines').where({ organization_id: org.id, is_default: true }).first() as { id: string } | undefined;
  if (!pipeline) {
    console.log('⏭️ 003_more_demo_leads: no default pipeline, skip.');
    return;
  }

  const stages = await knex('stages').where({ pipeline_id: pipeline.id }).orderBy('order_index') as { id: string; name: string }[];
  const contacts = await knex('contacts').where({ organization_id: org.id }).orderBy('created_at') as { id: string; first_name: string; last_name: string }[];
  const existingLeadContactIds = new Set(
    (await knex('leads').where({ organization_id: org.id, pipeline_id: pipeline.id }).select('contact_id'))
      .map((r: { contact_id: string }) => r.contact_id)
  );
  const availableContacts = contacts.filter((c) => !existingLeadContactIds.has(c.id));

  if (stages.length === 0 || availableContacts.length < MORE_LEADS_COUNT) {
    console.log('⏭️ 003_more_demo_leads: not enough stages or free contacts, skip.');
    return;
  }

  for (let i = 0; i < MORE_LEADS_COUNT; i++) {
    const contact = availableContacts[i]!;
    const createdAt = daysFromTodayAt10(LEAD_DAYS_FROM_TODAY[i] ?? 0);
    await knex('leads').insert({
      organization_id: org.id,
      contact_id: contact.id,
      pipeline_id: pipeline.id,
      stage_id: stages[i % stages.length]!.id,
      order_index: 8 + i,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  console.log(`✅ 003_more_demo_leads: added ${MORE_LEADS_COUNT} leads (created_at from -7 to +7 days).`);
}
