/**
 * Выводит тестовые user_id и organization_id для скрипта stage3-e2e-test.mjs.
 * Запуск после migrate + seed: cd migrations && npx tsx scripts/print-stage3-ids.ts
 * Затем: export TEST_USER_ID=... TEST_ORGANIZATION_ID=... (и при необходимости TEST_ORG_B_*)
 */
import knex from 'knex';
import type { Knex } from 'knex';

const connection =
  process.env.DATABASE_URL ||
  `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`;

const db = knex({
  client: 'pg',
  connection,
});

async function main() {
  const orgs = await db('organizations').select('id', 'name', 'slug').orderBy('created_at').limit(2);
  if (orgs.length === 0) {
    console.log('No organizations. Run seed first.');
    process.exit(1);
  }
  const orgA = orgs[0];
  const orgB = orgs[1] || orgA;
  const memberA = await db('organization_members')
    .where('organization_id', orgA.id)
    .select('user_id')
    .first();
  const memberB = await db('organization_members')
    .where('organization_id', orgB.id)
    .select('user_id')
    .first();
  const userIdA = memberA?.user_id;
  const userIdB = memberB?.user_id;
  console.log('\n# Stage 3 E2E test IDs (copy to env or .env):\n');
  console.log(`TEST_USER_ID=${userIdA || ''}`);
  console.log(`TEST_ORGANIZATION_ID=${orgA.id}`);
  if (orgB.id !== orgA.id && userIdB) {
    console.log(`TEST_ORG_B_USER_ID=${userIdB}`);
    console.log(`TEST_ORG_B_ORGANIZATION_ID=${orgB.id}`);
  }
  console.log('\n# Example:');
  console.log(
    `export TEST_USER_ID=${userIdA} TEST_ORGANIZATION_ID=${orgA.id}${orgB.id !== orgA.id && userIdB ? ` TEST_ORG_B_USER_ID=${userIdB} TEST_ORG_B_ORGANIZATION_ID=${orgB.id}` : ''}`
  );
  console.log('node scripts/stage3-e2e-test.mjs\n');
  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
