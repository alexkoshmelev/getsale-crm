import { Knex } from 'knex';

const DEMO_ORG_SLUG = 'demo-workspace';
const MORE_DEALS_COUNT = 24; // примерно в 3 раза больше базовых 8

/** Дата N дней от сегодня (положительное = в прошлом, отрицательное = в будущем), 10:00 + случайные минуты */
function daysFromTodayAt10(daysFromToday: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysFromToday);
  d.setHours(10, Math.floor(Math.random() * 60), 0, 0);
  return d;
}

/** Разносим 24 сделки по дням от -7 до +7 от сегодня */
const DEAL_DAYS_FROM_TODAY = [
  -7, -7, -6, -5, -5, -4, -3, -2, -1, 0, 0, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6, 7, 7, 7,
];

const EXTRA_VALUES = [
  11000, 22000, 9500, 33000, 14000, 19000, 27000, 6000, 21000, 16000,
  12000, 28000, 7500, 31000, 17000, 23000, 9000, 26000, 15000, 20000,
  13000, 24000, 18000, 29000,
];

export async function seed(knex: Knex): Promise<void> {
  const org = await knex('organizations').where({ slug: DEMO_ORG_SLUG }).first() as { id: string } | undefined;
  if (!org) {
    console.log('⏭️ 003_more_demo_deals: demo workspace not found, skip.');
    return;
  }

  const existing = await knex('deals')
    .where({ organization_id: org.id })
    .where('title', 'like', 'Доп. сделка%')
    .count('* as c')
    .first();
  const existingCount = Number((existing as { c?: string | number })?.c ?? 0);
  if (existingCount >= MORE_DEALS_COUNT) {
    console.log('⏭️ 003_more_demo_deals: extra deals already present, skip.');
    return;
  }

  const pipeline = await knex('pipelines').where({ organization_id: org.id, is_default: true }).first() as { id: string } | undefined;
  if (!pipeline) {
    console.log('⏭️ 003_more_demo_deals: no default pipeline, skip.');
    return;
  }

  const stages = await knex('stages').where({ pipeline_id: pipeline.id }).orderBy('order_index') as { id: string; name: string }[];
  const contacts = await knex('contacts').where({ organization_id: org.id }).orderBy('created_at') as { id: string; first_name: string; last_name: string }[];
  const companies = await knex('companies').where({ organization_id: org.id }) as { id: string }[];
  const users = await knex('users').where({ organization_id: org.id }).select('id') as { id: string }[];

  if (stages.length === 0 || contacts.length === 0 || companies.length === 0 || users.length === 0) {
    console.log('⏭️ 003_more_demo_deals: missing stages/contacts/companies/users, skip.');
    return;
  }

  for (let i = 0; i < MORE_DEALS_COUNT; i++) {
    const contact = contacts[i % contacts.length]!;
    const createdAt = daysFromTodayAt10(DEAL_DAYS_FROM_TODAY[i] ?? 0);
    await knex('deals').insert({
      organization_id: org.id,
      company_id: companies[i % companies.length]!.id,
      contact_id: contact.id,
      pipeline_id: pipeline.id,
      stage_id: stages[i % stages.length]!.id,
      owner_id: users[i % users.length]!.id,
      created_by_id: users[i % users.length]!.id,
      title: `Доп. сделка ${i + 1}: ${contact.first_name} ${contact.last_name}`,
      value: EXTRA_VALUES[i] ?? 10000 + i * 1000,
      currency: 'RUB',
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  console.log(`✅ 003_more_demo_deals: added ${MORE_DEALS_COUNT} deals (created_at from -7 to +7 days).`);
}
