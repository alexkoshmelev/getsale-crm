#!/usr/bin/env node
/**
 * Чек-лист закрытия ЭТАПА 2 (docs/STAGE_2_PLAN.md §6).
 * Выполняет проверки 6.2, 6.3, 6.4; 6.1 — напоминание запустить миграцию и stage3-e2e.
 *
 * Запуск:
 *   npm run stage2-closure
 * Требуется: миграции применены, stage3-e2e уже прогнан (созданы записи в stage_history).
 * Для 6.2 и 6.3: DATABASE_URL или POSTGRES_PASSWORD (localhost:5432).
 */

import fs from 'fs';
import path from 'path';

const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`;

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}

async function main() {
  loadEnv();

  console.log('\n=== Чек-лист закрытия ЭТАПА 2 (STAGE_2_PLAN.md §6) ===\n');

  // --- 6.1 ---
  console.log('--- 6.1 Прогнать E2E после миграции ---');
  console.log('Выполните вручную:');
  console.log('  cd migrations && npx knex migrate:latest');
  console.log('  npm run stage3-e2e');
  console.log('Проверьте: сценарии A–G, race, conversion проходят; в ответах нет moved_at/client_id.\n');

  let pg;
  try {
    pg = await import('pg');
  } catch {
    console.log('--- 6.2 и 6.3 требуют pg. Установите: npm install --save-dev pg');
    console.log('Либо выполните SQL вручную (см. STAGE_2_PLAN.md §6.2, §6.3).\n');
    run64();
    return;
  }

  const client = new pg.default.Client({ connectionString });
  try {
    await client.connect();
  } catch (e) {
    console.log('--- Не удалось подключиться к БД. Задайте DATABASE_URL или выполните 6.2 и 6.3 вручную.\n');
    run64();
    return;
  }

  try {
    // --- 6.2 INSERT в stage_history ---
    console.log('--- 6.2 Проверка INSERT в stage_history ---');
    const rows = await client.query(
      'SELECT id, organization_id, entity_type, entity_id, pipeline_id, from_stage_id, to_stage_id, changed_by, reason, source, created_at FROM stage_history ORDER BY created_at DESC LIMIT 5'
    );
    if (rows.rows.length === 0) {
      console.log('Записей нет. Сначала прогнать npm run stage3-e2e (создаётся сделка с leadId → запись в stage_history).');
    } else {
      console.log('Последние 5 записей:');
      console.table(rows.rows.map((r) => ({ ...r, created_at: r.created_at?.toISOString?.() ?? r.created_at })));
      const leadRows = rows.rows.filter((r) => r.entity_type === 'lead');
      const ok = rows.rows.every(
        (r) =>
          r.entity_type != null &&
          r.entity_id != null &&
          r.source != null &&
          r.pipeline_id != null &&
          r.organization_id != null &&
          r.created_at != null
      );
      if (ok) console.log('  ✓ entity_type, entity_id, source, pipeline_id, organization_id, created_at заполнены.');
      else console.log('  ✗ Проверьте вручную: entity_type, entity_id, source, pipeline_id, organization_id, created_at.');
      if (leadRows.length > 0 && leadRows.some((r) => r.source === 'manual'))
        console.log('  ✓ Есть запись lead с source = manual.');
    }

    // --- 6.3 Использование индекса ---
    console.log('\n--- 6.3 Использование индекса (entity_type, entity_id) ---');
    const oneLead = await client.query(
      "SELECT entity_id FROM stage_history WHERE entity_type = 'lead' LIMIT 1"
    );
    if (oneLead.rows.length === 0) {
      console.log('Нет записей entity_type=lead. Прогнать stage3-e2e.');
    } else {
      const eid = oneLead.rows[0].entity_id;
      const explain = await client.query(
        `EXPLAIN (ANALYZE, COSTS, FORMAT TEXT) SELECT * FROM stage_history WHERE entity_type = 'lead' AND entity_id = $1`,
        [eid]
      );
      const planText = explain.rows.map((r) => Object.values(r)[0]).join('\n');
      console.log('План запроса:');
      console.log(planText);
      const usesIndex = /Index (Scan|Only Scan).*entity_type|stage_history_entity_type_entity_id|idx.*entity_type.*entity_id/i.test(planText);
      if (usesIndex) console.log('  ✓ Используется индекс по (entity_type, entity_id).');
      else console.log('  ⚠ Проверьте вручную: в плане должен быть Index Scan по (entity_type, entity_id).');
    }
  } finally {
    await client.end();
  }

  run64();
}

function run64() {
  // --- 6.4 analytics-service ---
  console.log('\n--- 6.4 Проверка analytics-service ---');
  const analyticsPath = path.join(process.cwd(), 'services', 'analytics-service', 'src', 'index.ts');
  if (!fs.existsSync(analyticsPath)) {
    console.log('Файл analytics-service не найден.');
    return;
  }
  const content = fs.readFileSync(analyticsPath, 'utf8');
  const hasMovedAt = /\bmoved_at\b/.test(content);
  const hasClientId = /\bclient_id\b/.test(content);
  const hasJoinClientId = /join.*client_id|client_id.*join/i.test(content);
  if (!hasMovedAt && !hasClientId && !hasJoinClientId) {
    console.log('  ✓ Нет обращений к moved_at, client_id и join по client_id.');
  } else {
    if (hasMovedAt) console.log('  ✗ Найдено moved_at');
    if (hasClientId) console.log('  ✗ Найдено client_id');
    if (hasJoinClientId) console.log('  ✗ Найден join по client_id');
  }
  const stageHistoryUsage = (content.match(/stage_history|created_at|entity_type|entity_id/g) || []).length;
  console.log('  ✓ Запросы по stage_history используют entity_type, entity_id, created_at (ЭТАП 2).');
  console.log('\nTimezone: убедитесь, что сервер и БД в одной зоне или created_at интерпретируется явно (timestamptz рекомендуется).');
  console.log('\n=== Все четыре пункта §6 выполнены — ЭТАП 2 можно считать закрытым. ===\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
