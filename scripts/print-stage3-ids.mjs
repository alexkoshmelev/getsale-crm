#!/usr/bin/env node
/**
 * Выводит тестовые user_id и organization_id для stage3-e2e-test.mjs.
 * Запуск после migrate + seed:  npm run stage3-ids
 *
 * Требуется: Postgres доступен (DATABASE_URL или localhost:5432).
 * Опционально: pg в корне (npm install) или запуск из папки migrations: npx tsx scripts/print-stage3-ids.ts
 */
const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`;

async function main() {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    console.log('Установите pg в корне проекта:  npm install --save-dev pg');
    console.log('Либо получите ID из папки migrations:\n  cd migrations && npx tsx scripts/print-stage3-ids.ts\n');
    process.exit(1);
  }
  const client = new pg.default.Client({ connectionString });
  await client.connect();
  try {
    const orgsRes = await client.query(
      'SELECT id, name, slug FROM organizations ORDER BY created_at ASC LIMIT 2'
    );
    const orgs = orgsRes.rows;
    if (orgs.length === 0) {
      console.log('Организаций нет. Выполните: npm run migrate && npm run seed');
      process.exit(1);
    }
    const orgA = orgs[0];
    const orgB = orgs[1] || orgA;
    const memberA = await client.query(
      'SELECT user_id FROM organization_members WHERE organization_id = $1 LIMIT 1',
      [orgA.id]
    );
    const memberB = await client.query(
      'SELECT user_id FROM organization_members WHERE organization_id = $1 LIMIT 1',
      [orgB.id]
    );
    const userIdA = memberA.rows[0]?.user_id;
    const userIdB = memberB.rows[0]?.user_id;
    console.log('\n# Stage 3 E2E test IDs (скопируйте в env или .env):\n');
    console.log(`TEST_USER_ID=${userIdA || ''}`);
    console.log(`TEST_ORGANIZATION_ID=${orgA.id}`);
    if (orgB.id !== orgA.id && userIdB) {
      console.log(`TEST_ORG_B_USER_ID=${userIdB}`);
      console.log(`TEST_ORG_B_ORGANIZATION_ID=${orgB.id}`);
    }
    console.log('\n# Пример запуска E2E (Windows PowerShell):');
    console.log(`$env:TEST_USER_ID="${userIdA}"; $env:TEST_ORGANIZATION_ID="${orgA.id}"; npm run stage3-e2e`);
    console.log('\n# Пример (Linux/macOS):');
    console.log(
      `export TEST_USER_ID=${userIdA} TEST_ORGANIZATION_ID=${orgA.id}${orgB.id !== orgA.id && userIdB ? ` TEST_ORG_B_USER_ID=${userIdB} TEST_ORG_B_ORGANIZATION_ID=${orgB.id}` : ''}`
    );
    console.log('npm run stage3-e2e\n');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
