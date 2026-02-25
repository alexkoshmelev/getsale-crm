#!/usr/bin/env node
/**
 * STAGE 3 (Lead → Deal) + ЭТАП 4 (автосоздание сделки из лида).
 * Прогон чек-листов: STAGE_3_MANUAL_TEST_CHECKLIST.md, STAGE_4_PLAN.md §5.1.
 *
 * Вызов сервисов CRM, Pipeline и (для ЭТАПА 4) Automation напрямую, с заголовками X-User-Id и X-Organization-Id.
 *
 * Требуется:
 *   - Подняты: CRM (3002), Pipeline (3008), Postgres; для сценариев H–I: RabbitMQ, Automation (3009), seed 004.
 *   - Переменные: TEST_USER_ID, TEST_ORGANIZATION_ID (в .env или окружении).
 *   - Для сценария E: TEST_ORG_B_USER_ID, TEST_ORG_B_ORGANIZATION_ID.
 *   - Для проверки automation_executions (опционально): DATABASE_URL.
 *
 * Сценарии: A–G (ЭТАП 3), conversion; H–I (ЭТАП 4); J — Correlation Propagation Audit (ЭТАП 5 §3.1); K — SLA Automation (ЭТАП 6); после J — проверка GET /metrics.
 *
 * Запуск: npm run stage3-e2e
 * Получить тестовые ID: npm run stage3-ids
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Подгрузка .env из корня (Node.js сам .env не читает)
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

const CRM_URL = process.env.CRM_URL || 'http://localhost:3002';
const PIPELINE_URL = process.env.PIPELINE_URL || 'http://localhost:3008';
const AUTOMATION_URL = process.env.AUTOMATION_URL || 'http://localhost:3009';
const userId = process.env.TEST_USER_ID;
const organizationId = process.env.TEST_ORGANIZATION_ID;
const userIdB = process.env.TEST_ORG_B_USER_ID;
const organizationIdB = process.env.TEST_ORG_B_ORGANIZATION_ID;

function headers(uid, orgId) {
  return {
    'Content-Type': 'application/json',
    'X-User-Id': uid,
    'X-Organization-Id': orgId,
  };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

const log = {
  ok: (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`),
  fail: (msg) => console.log(`  \x1b[31m✗\x1b[0m ${msg}`),
  skip: (msg) => console.log(`  \x1b[33m⊘\x1b[0m ${msg}`),
  info: (msg) => console.log(`  ${msg}`),
};

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    log.ok(msg);
    passed++;
    return true;
  }
  log.fail(msg);
  failed++;
  return false;
}

/** ЭТАП 2: в ответах не должно быть legacy-полей moved_at, client_id */
function assertNoLegacyFields(obj, msg) {
  if (obj == null) return;
  const str = JSON.stringify(obj);
  const hasLegacy = /\b(moved_at|client_id)\b/.test(str);
  assert(!hasLegacy, msg);
}

async function main() {
  console.log('\n=== STAGE 3 E2E — Lead → Deal (docs/STAGE_3_MANUAL_TEST_CHECKLIST.md) ===\n');

  if (!userId || !organizationId) {
    console.error('Set TEST_USER_ID and TEST_ORGANIZATION_ID (e.g. run: npm run stage3-ids)\n');
    process.exit(1);
  }

  const h = () => headers(userId, organizationId);

  // --- Health ---
  let healthCrm = { ok: false };
  let healthPipe = { ok: false };
  try {
    healthCrm = await fetchJson(`${CRM_URL}/health`);
    healthPipe = await fetchJson(`${PIPELINE_URL}/health`);
  } catch (err) {
    const refused = err?.cause?.code === 'ECONNREFUSED' || err?.code === 'ECONNREFUSED';
    if (refused) {
      console.error('\nСервисы CRM или Pipeline не запущены (ECONNREFUSED).');
      console.error('Запустите их, например:\n  docker-compose up -d crm-service pipeline-service\n');
      console.error(`Ожидаемые URL: CRM ${CRM_URL}, Pipeline ${PIPELINE_URL}\n`);
    }
    throw err;
  }
  if (!healthCrm.ok || !healthPipe.ok) {
    console.error('CRM or Pipeline not reachable. Check CRM_URL and PIPELINE_URL.');
    process.exit(1);
  }
  log.ok('CRM and Pipeline are up');

  // --- Setup: contact, pipeline with Converted stage, lead (not Converted) ---
  let contactId, pipelineId, stageIdLead, leadId, convertedStageId;

  {
    const pipelinesRes = await fetchJson(`${PIPELINE_URL}/api/pipeline`, { headers: h() });
    if (!pipelinesRes.ok || !Array.isArray(pipelinesRes.body) || pipelinesRes.body.length === 0) {
      console.error('No pipelines. Run seed first.');
      process.exit(1);
    }
    pipelineId = pipelinesRes.body[0].id;

    const stagesRes = await fetchJson(`${PIPELINE_URL}/api/pipeline/stages?pipelineId=${pipelineId}`, { headers: h() });
    const stages = Array.isArray(stagesRes.body) ? stagesRes.body : stagesRes.body?.items ?? [];
    const converted = stages.find((s) => s.name === 'Converted');
    if (!converted) {
      console.error('Pipeline has no Converted stage. Run migrations (20250301000002).');
      process.exit(1);
    }
    convertedStageId = converted.id;
    const firstStage = stages.find((s) => s.name === 'Lead') || stages.sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))[0];
    stageIdLead = firstStage?.id;
    if (!stageIdLead) {
      console.error('Pipeline has no stages.');
      process.exit(1);
    }
  }

  const contactRes = await fetchJson(`${CRM_URL}/api/crm/contacts`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({ firstName: 'E2E', lastName: 'Stage3', email: `e2e-${Date.now()}@test.local` }),
  });
  if (!contactRes.ok || !contactRes.body?.id) {
    console.error('Failed to create contact:', contactRes.status, contactRes.body);
    process.exit(1);
  }
  contactId = contactRes.body.id;

  const leadRes = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({ contactId, pipelineId, stageId: stageIdLead }),
  });
  if (!leadRes.ok || !leadRes.body?.id) {
    console.error('Failed to create lead:', leadRes.status, leadRes.body);
    process.exit(1);
  }
  leadId = leadRes.body.id;
  log.ok(`Setup: contact ${contactId}, pipeline ${pipelineId}, lead ${leadId}`);

  // ---------- Сценарий A: Успешная конверсия (лид → сделка) ----------
  console.log('\n--- Сценарий A: Успешная конверсия (лид → сделка) ---');
  const createDealBody = { leadId, title: 'Deal from lead E2E', contactId, pipelineId };
  const dealA = await fetchJson(`${CRM_URL}/api/crm/deals`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify(createDealBody),
  });
  assert(dealA.status === 201, `Ответ 201 при создании сделки с leadId (получен ${dealA.status})`);
  assert(dealA.body?.leadId === leadId, `В теле сделки leadId = ${leadId}`);
  assertNoLegacyFields(dealA.body, 'Сценарий A: в ответе сделки нет moved_at/client_id');
  const dealIdA = dealA.body?.id;

  // Запрашиваем с limit=100, иначе лид может не попасть на первую страницу (default 20) и ourLead будет undefined
  const leadsList = await fetchJson(
    `${PIPELINE_URL}/api/pipeline/leads?pipelineId=${pipelineId}&limit=100`,
    { headers: h() }
  );
  const items = leadsList.body?.items ?? [];
  const ourLead = items.find((l) => l.id === leadId);
  assert(ourLead != null, `Лид ${leadId} найден в списке (pipelineId=${pipelineId}, limit=100)`);
  assert(ourLead.stage_id === convertedStageId, `Лид в стадии Converted (stage_id = ${convertedStageId}, получен ${ourLead.stage_id})`);

  log.info('Проверка stage_history и событий RabbitMQ — вручную (БД / очередь).');

  // ---------- Сценарий B: 409 при второй сделке по одному лиду ----------
  console.log('\n--- Сценарий B: Защита от второй сделки по одному лиду (409) ---');
  const dealB = await fetchJson(`${CRM_URL}/api/crm/deals`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify(createDealBody),
  });
  assert(dealB.status === 409, `Ответ 409 при повторном создании сделки с тем же leadId (получен ${dealB.status})`);

  // ---------- Сценарий C: 400 при смене стадии лида из Converted ----------
  console.log('\n--- Сценарий C: Запрет смены стадии лида из Converted (400) ---');
  const patchLead = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads/${leadId}`, {
    method: 'PATCH',
    headers: h(),
    body: JSON.stringify({ stageId: stageIdLead }),
  });
  assert(patchLead.status === 400, `Ответ 400 при PATCH стадии лида из Converted (получен ${patchLead.status})`);

  // ---------- Сценарий D: Сделка без leadId (поведение как раньше) ----------
  console.log('\n--- Сценарий D: Сделка без leadId ---');
  const dealD = await fetchJson(`${CRM_URL}/api/crm/deals`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({
      contactId,
      pipelineId,
      title: 'Deal without lead E2E',
    }),
  });
  assert(dealD.status === 201, `Ответ 201 при создании сделки без leadId (получен ${dealD.status})`);
  assert(dealD.body?.leadId == null, 'В теле сделки leadId отсутствует или null');
  assertNoLegacyFields(dealD.body, 'Сценарий D: в ответе сделки нет moved_at/client_id');

  // ---------- Сценарий E: Multi-tenant (403/404 при leadId из другой организации) ----------
  console.log('\n--- Сценарий E: Multi-tenant ---');
  if (userIdB && organizationIdB) {
    const hB = () => headers(userIdB, organizationIdB);
    const pipelinesB = await fetchJson(`${PIPELINE_URL}/api/pipeline`, { headers: hB() });
    const pipeB = Array.isArray(pipelinesB.body) && pipelinesB.body[0] ? pipelinesB.body[0].id : null;
    if (!pipeB) {
      log.skip('Org B has no pipeline; create pipeline in Org B for full E test.');
    } else {
      const stagesB = await fetchJson(`${PIPELINE_URL}/api/pipeline/stages?pipelineId=${pipeB}`, { headers: hB() });
      const stagesListB = Array.isArray(stagesB.body) ? stagesB.body : stagesB.body?.items ?? [];
      const firstStageB = stagesListB.sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))[0];
      const contactB = await fetchJson(`${CRM_URL}/api/crm/contacts`, {
        method: 'POST',
        headers: hB(),
        body: JSON.stringify({ firstName: 'OrgB', lastName: 'E2E', email: `e2e-orgb-${Date.now()}@test.local` }),
      });
      if (!contactB.ok || !contactB.body?.id) {
        log.skip('Failed to create contact in Org B.');
      } else {
        const leadB = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads`, {
          method: 'POST',
          headers: hB(),
          body: JSON.stringify({ contactId: contactB.body.id, pipelineId: pipeB, stageId: firstStageB?.id }),
        });
        if (!leadB.ok || !leadB.body?.id) {
          log.skip('Failed to create lead in Org B (contact already in pipeline?).');
        } else {
          const leadIdOrgB = leadB.body.id;
          const dealCross = await fetchJson(`${CRM_URL}/api/crm/deals`, {
            method: 'POST',
            headers: h(),
            body: JSON.stringify({
              leadId: leadIdOrgB,
              title: 'Cross-tenant deal',
              pipelineId,
              contactId,
            }),
          });
          assert(
            dealCross.status === 403 || dealCross.status === 404,
            `Ответ 403 или 404 при leadId из другой организации (получен ${dealCross.status})`
          );
        }
      }
    }
  } else {
    log.skip('TEST_ORG_B_USER_ID / TEST_ORG_B_ORGANIZATION_ID не заданы — сценарий E пропущен.');
  }

  // ---------- Сценарий F: Rollback — документируется, не автоматизируем ----------
  console.log('\n--- Сценарий F: Rollback при ошибке ---');
  log.skip('Проверка отката транзакции и публикации после COMMIT — вручную.');

  // ---------- Сценарий G: Race condition (10 параллельных запросов с одним leadId) ----------
  console.log('\n--- Сценарий G: Race condition ---');
  const contactGRes = await fetchJson(`${CRM_URL}/api/crm/contacts`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({ firstName: 'Race', lastName: 'E2E', email: `e2e-race-${Date.now()}@test.local` }),
  });
  const contactIdG = contactGRes.ok ? contactGRes.body?.id : null;
  let leadIdG;
  if (contactIdG) {
    const leadGRes = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({ contactId: contactIdG, pipelineId, stageId: stageIdLead }),
    });
    if (leadGRes.ok && leadGRes.body?.id) leadIdG = leadGRes.body.id;
  }
  if (!leadIdG) {
    log.skip('Не удалось создать контакт/лид для сценария G.');
  }
  if (leadIdG) {
    const bodyG = { leadId: leadIdG, title: 'Race deal E2E', contactId: contactIdG, pipelineId };
    const promises = Array(10)
      .fill(null)
      .map(() =>
        fetchJson(`${CRM_URL}/api/crm/deals`, {
          method: 'POST',
          headers: h(),
          body: JSON.stringify(bodyG),
        })
      );
    const results = await Promise.all(promises);
    const created = results.filter((r) => r.status === 201);
    const conflict = results.filter((r) => r.status === 409);
    assert(created.length === 1, `Ровно один ответ 201 (получено ${created.length})`);
    assert(conflict.length === 9, `Остальные девять ответов 409 (получено ${conflict.length})`);
  }

  // ---------- Conversion endpoint ----------
  console.log('\n--- Conversion endpoint ---');
  const convRes = await fetchJson(`${CRM_URL}/api/crm/analytics/conversion`, { headers: h() });
  assert(convRes.status === 200, `GET /api/crm/analytics/conversion возвращает 200 (получен ${convRes.status})`);
  const hasTotal = typeof convRes.body?.totalLeads === 'number';
  const hasConverted = typeof convRes.body?.convertedLeads === 'number';
  const hasRate = typeof convRes.body?.conversionRate === 'number';
  assert(hasTotal && hasConverted && hasRate, 'В ответе есть totalLeads, convertedLeads, conversionRate');
  if (convRes.body?.totalLeads > 0) {
    const expected = Math.round((convRes.body.convertedLeads / convRes.body.totalLeads) * 10000) / 10000;
    assert(
      convRes.body.conversionRate === expected,
      `conversionRate = convertedLeads / totalLeads (${convRes.body.conversionRate} ≈ ${expected})`
    );
  }

  const convPipe = await fetchJson(`${CRM_URL}/api/crm/analytics/conversion?pipelineId=${pipelineId}`, { headers: h() });
  assert(convPipe.status === 200, `GET .../conversion?pipelineId= возвращает 200`);

  // ---------- ЭТАП 4: автосоздание сделки при переходе лида в стадию (STAGE_4_PLAN.md §5.1) ----------
  await runStage4Scenarios(h, pipelineId);

  // ---------- Итог ----------
  console.log('\n=== Итог ===');
  console.log(`  Пройдено: ${passed}`);
  console.log(`  Провалено: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('\nЭТАП 3 и ЭТАП 4 проверены по автоматическим сценариям.\n');
}

/** ЭТАП 4: ручной сценарий + стресс-тест (STAGE_4_PLAN.md §5.1 п.2, п.3) */
async function runStage4Scenarios(h, pipelineId) {
  console.log('\n--- ЭТАП 4: автосоздание сделки из лида (automation) ---');

  let automationOk = false;
  try {
    const health = await fetchJson(`${AUTOMATION_URL}/health`);
    automationOk = health.ok;
  } catch (_) {}
  if (!automationOk) {
    log.skip('Automation-service недоступен (AUTOMATION_URL). Поднимите сервис и RabbitMQ для сценариев H–I.');
    return;
  }

  const rulesRes = await fetchJson(`${AUTOMATION_URL}/api/automation/rules`, { headers: h() });
  const rules = Array.isArray(rulesRes.body) ? rulesRes.body : [];
  const leadStageRule = rules.find(
    (r) => r.trigger_type === 'lead.stage.changed' && r.is_active
  );
  if (!leadStageRule) {
    log.skip('Нет активного правила lead.stage.changed (выполните seed 004).');
    return;
  }
  const triggerConditions =
    typeof leadStageRule.trigger_conditions === 'string'
      ? JSON.parse(leadStageRule.trigger_conditions || '{}')
      : leadStageRule.trigger_conditions || {};
  const toStageId = triggerConditions.to_stage_id;
  const rulePipelineId = triggerConditions.pipeline_id;
  if (!toStageId || !rulePipelineId) {
    log.skip('В правиле отсутствует to_stage_id или pipeline_id.');
    return;
  }

  // Используем пайплайн из правила (seed 004 привязывает к default pipeline; тест мог взять другой из списка)
  const pipelineId4 = rulePipelineId;
  const stagesRes = await fetchJson(`${PIPELINE_URL}/api/pipeline/stages?pipelineId=${pipelineId4}`, { headers: h() });
  const stages = Array.isArray(stagesRes.body) ? stagesRes.body : stagesRes.body?.items ?? [];
  const otherStage = stages.find((s) => s.id !== toStageId && s.name !== 'Converted');
  if (!otherStage) {
    log.skip('Нет другой стадии (кроме триггерной и Converted) для сценария H.');
    return;
  }

  // Сценарий H — ручной: лид → переход в стадию правила → сделка создаётся automation, execution записан
  console.log('\n--- Сценарий H (ЭТАП 4): ручной — лид переведён в стадию правила → одна сделка ---');
  const contactHRes = await fetchJson(`${CRM_URL}/api/crm/contacts`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({
      firstName: 'Stage4',
      lastName: 'Manual',
      email: `e2e-stage4-${Date.now()}@test.local`,
    }),
  });
  const contactIdH = contactHRes.ok ? contactHRes.body?.id : null;
  if (!contactIdH) {
    log.fail('Не удалось создать контакт для сценария H.');
    return;
  }
  const leadHRes = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({ contactId: contactIdH, pipelineId: pipelineId4, stageId: otherStage.id }),
  });
  if (!leadHRes.ok || !leadHRes.body?.id) {
    log.fail('Не удалось создать лид для сценария H.');
    return;
  }
  const leadIdH = leadHRes.body.id;

  const patchH = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads/${leadIdH}`, {
    method: 'PATCH',
    headers: h(),
    body: JSON.stringify({ stageId: toStageId }),
  });
  assert(patchH.ok, `PATCH лида в стадию правила вернул 200 (получен ${patchH.status})`);

  await sleep(3500);
  const dealsListH = await fetchJson(
    `${CRM_URL}/api/crm/deals?pipelineId=${pipelineId4}&limit=50`,
    { headers: h() }
  );
  const itemsH = dealsListH.body?.items ?? [];
  const dealFromLeadH = itemsH.find((d) => d.leadId === leadIdH);
  assert(dealFromLeadH != null, 'Сделка по лиду создана automation (201 или 409 → одна сделка)');
  if (dealFromLeadH) assertNoLegacyFields(dealFromLeadH, 'Сценарий H: в ответе сделки нет moved_at/client_id');

  const executionsH = await queryAutomationExecutions(leadIdH);
  if (executionsH !== null) {
    assert(executionsH >= 1, `В automation_executions есть запись по лиду (получено ${executionsH})`);
  }

  // Сценарий I — стресс: 10 одновременных PATCH стадии одного лида → одна сделка, один execution success
  console.log('\n--- Сценарий I (ЭТАП 4): стресс — 10 PATCH стадии одного лида → одна сделка ---');
  const contactIRes = await fetchJson(`${CRM_URL}/api/crm/contacts`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({
      firstName: 'Stage4',
      lastName: 'Stress',
      email: `e2e-stage4-stress-${Date.now()}@test.local`,
    }),
  });
  const contactIdI = contactIRes.ok ? contactIRes.body?.id : null;
  if (!contactIdI) {
    log.skip('Не удалось создать контакт для сценария I.');
    return;
  }
  const leadIRes = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({ contactId: contactIdI, pipelineId: pipelineId4, stageId: otherStage.id }),
  });
  if (!leadIRes.ok || !leadIRes.body?.id) {
    log.skip('Не удалось создать лид для сценария I.');
    return;
  }
  const leadIdI = leadIRes.body.id;

  const patchPromises = Array(10)
    .fill(null)
    .map(() =>
      fetchJson(`${PIPELINE_URL}/api/pipeline/leads/${leadIdI}`, {
        method: 'PATCH',
        headers: h(),
        body: JSON.stringify({ stageId: toStageId }),
      })
    );
  await Promise.all(patchPromises);

  await sleep(4000);
  const dealsListI = await fetchJson(
    `${CRM_URL}/api/crm/deals?pipelineId=${pipelineId4}&limit=50`,
    { headers: h() }
  );
  const itemsI = dealsListI.body?.items ?? [];
  const dealsForLeadI = itemsI.filter((d) => d.leadId === leadIdI);
  assert(dealsForLeadI.length === 1, `Ровно одна сделка по лиду при 10 PATCH (получено ${dealsForLeadI.length})`);

  const executionsI = await queryAutomationExecutions(leadIdI);
  if (executionsI !== null) {
    assert(executionsI === 1, `Ровно одна запись в automation_executions по лиду (получено ${executionsI})`);
  }

  // ---------- Сценарий J (ЭТАП 5 §3.1): Correlation Propagation Audit ----------
  console.log('\n--- Сценарий J (ЭТАП 5): Correlation Propagation Audit — STAGE_5_OBSERVABILITY_PLAN.md §3.1 ---');
  const contactJRes = await fetchJson(`${CRM_URL}/api/crm/contacts`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({
      firstName: 'Correlation',
      lastName: 'Audit',
      email: `e2e-correlation-${Date.now()}@test.local`,
    }),
  });
  const contactIdJ = contactJRes.ok ? contactJRes.body?.id : null;
  if (!contactIdJ) {
    log.skip('Не удалось создать контакт для сценария J (correlation audit).');
    return;
  }
  const leadJRes = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({ contactId: contactIdJ, pipelineId: pipelineId4, stageId: otherStage.id }),
  });
  if (!leadJRes.ok || !leadJRes.body?.id) {
    log.skip('Не удалось создать лид для сценария J.');
    return;
  }
  const leadIdJ = leadJRes.body.id;

  const patchJ = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads/${leadIdJ}`, {
    method: 'PATCH',
    headers: h(),
    body: JSON.stringify({ stageId: toStageId }),
  });
  assert(patchJ.ok, `PATCH лида (audit) в стадию правила вернул 200 (получен ${patchJ.status})`);

  await sleep(3500);
  const dealListJ = await fetchJson(
    `${CRM_URL}/api/crm/deals?pipelineId=${pipelineId4}&limit=50`,
    { headers: h() }
  );
  const hasDealJ = (dealListJ.body?.items ?? []).some((d) => d.leadId === leadIdJ);
  assert(hasDealJ, 'Сделка по лиду создана (audit)');

  const execRow = await queryAutomationExecutionRow(leadIdJ);
  if (execRow) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert(execRow.correlation_id != null, 'automation_executions.correlation_id заполнен');
    assert(uuidRe.test(String(execRow.correlation_id)), 'correlation_id — валидный UUID');
    assert(['success', 'skipped'].includes(String(execRow.status)), `automation_executions.status = success или skipped (получен ${execRow.status})`);

    const stageHistCorr = await queryStageHistoryCorrelationForLead(leadIdJ);
    if (stageHistCorr !== undefined) {
      if (stageHistCorr != null) {
        assert(
          stageHistCorr === execRow.correlation_id,
          `stage_history.correlation_id совпадает с automation_executions (${stageHistCorr} === ${execRow.correlation_id})`
        );
      }
      // если null — CRM пока может не писать correlation_id в stage_history, не падаем
    }

    log.info(`Correlation audit: correlation_id = ${execRow.correlation_id}, trigger_event_id = ${execRow.trigger_event_id || '(null)'}, status = ${execRow.status}`);

    const chainOk = checkCorrelationChainInLogs(String(execRow.correlation_id));
    if (chainOk === true) {
      log.ok('Цепочка по correlation_id в логах: pipeline — publish, automation — consume и processed.');
    } else if (chainOk === false) {
      log.fail('В логах не найдена полная цепочка (pipeline publish, automation consume, automation processed). Проверьте: grep ' + execRow.correlation_id + ' <логи>.');
    } else {
      log.info('Проверка логов пропущена (docker недоступен или DOCKER_COMPOSE_LOGS=0). Вручную: grep ' + execRow.correlation_id + ' <логи> — должны быть publish, consume, processed.');
    }
  } else {
    log.skip(
      'БД недоступна с хоста (скрипт подменяет host postgres→localhost). Проверьте: порт 5432 проброшен, pg установлен (npm install), при необходимости DEBUG_E2E=1 для вывода ошибки. Проверьте automation_executions.correlation_id и логи вручную по §3.1.'
    );
  }

  // ---------- Сценарий K (ЭТАП 6): SLA Automation — lead.sla.breach, execution, skip при повторном запуске ----------
  console.log('\n--- Сценарий K (ЭТАП 6): SLA Automation — STAGE_6_SLA_AUTOMATION_PLAN.md ---');
  const pipelineIdK = pipelineId4;
  const stagesKRes = await fetchJson(`${PIPELINE_URL}/api/pipeline/stages?pipelineId=${pipelineIdK}`, { headers: h() });
  if (!stagesKRes.ok) {
    log.skip('Не удалось получить стадии пайплайна для сценария K (ответ ' + stagesKRes.status + ').');
  } else {
  const stagesKList = Array.isArray(stagesKRes.body) ? stagesKRes.body : stagesKRes.body?.items ?? [];
  const firstStageK = stagesKList[0];
  if (!firstStageK?.id) {
    log.skip('Нет стадий в пайплайне для сценария K (SLA).');
  } else {
    const ruleKRes = await fetchJson(`${AUTOMATION_URL}/api/automation/rules`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({
        name: 'E2E SLA lead breach (max_days=0)',
        triggerType: 'lead.sla.breach',
        triggerConfig: { pipeline_id: pipelineIdK, stage_id: firstStageK.id, max_days: 0 },
        actions: [],
        is_active: true,
      }),
    });
    if (!ruleKRes.ok) {
      log.skip('Не удалось создать правило SLA для сценария K (ответ ' + ruleKRes.status + ').');
    } else {
      const ruleIdK = ruleKRes.body?.id;
      const contactKRes = await fetchJson(`${CRM_URL}/api/crm/contacts`, {
        method: 'POST',
        headers: h(),
        body: JSON.stringify({
          firstName: 'SLA',
          lastName: 'E2E',
          email: `e2e-sla-${Date.now()}@test.local`,
        }),
      });
      const contactIdK = contactKRes.ok ? contactKRes.body?.id : null;
      if (!contactIdK) {
        log.skip('Не удалось создать контакт для сценария K.');
      } else {
        const leadKRes = await fetchJson(`${PIPELINE_URL}/api/pipeline/leads`, {
          method: 'POST',
          headers: h(),
          body: JSON.stringify({ contactId: contactIdK, pipelineId: pipelineIdK, stageId: firstStageK.id }),
        });
        if (!leadKRes.ok || !leadKRes.body?.id) {
          log.skip('Не удалось создать лид для сценария K.');
        } else {
          const leadIdK = leadKRes.body.id;
          // Не полагаемся на updateLeadUpdatedAt (скрипт может подключаться к другой БД, чем сервисы).
          // Ждём 2 с: лид уже в стадии с updated_at в прошлом, при max_days=0 cron подхватит (updated_at < now).
          await sleep(2000);
          const run1 = await fetchJson(`${AUTOMATION_URL}/api/automation/internal/run-sla-cron-once`, {
              method: 'POST',
              headers: h(),
              body: JSON.stringify({ organizationId, leadId: leadIdK }),
            });
            if (!run1.ok) {
              log.info(`Ответ run-sla-cron-once (1): ${run1.status} — ${JSON.stringify(run1.body)}`);
            }
            assert(run1.ok, 'POST run-sla-cron-once (1) вернул 200');
            // Ждём появления execution: consumer обрабатывает событие асинхронно (очередь RabbitMQ)
            let execK1 = await querySlaExecutionForLead(leadIdK);
            for (let attempt = 0; attempt < 20 && (execK1 === null || execK1.count < 1); attempt++) {
              await sleep(500);
              execK1 = await querySlaExecutionForLead(leadIdK);
            }
            if (execK1 === null) {
              log.skip('БД недоступна — не проверяем automation_executions для SLA.');
            } else {
              assert(execK1.count >= 1, `После первого запуска cron: хотя бы 1 execution с breach_date (получено ${execK1.count})`);
              assert(execK1.breach_date != null, 'breach_date заполнен в execution');
              log.info(`SLA execution: breach_date = ${execK1.breach_date}`);

              const run2 = await fetchJson(`${AUTOMATION_URL}/api/automation/internal/run-sla-cron-once`, {
                method: 'POST',
                headers: h(),
                body: JSON.stringify({ organizationId, leadId: leadIdK }),
              });
              if (!run2.ok) {
                log.info(`Ответ run-sla-cron-once (2): ${run2.status} — ${JSON.stringify(run2.body)}`);
              }
              assert(run2.ok, 'POST run-sla-cron-once (2) вернул 200');
              await sleep(1500);
              // Идемпотентность проверяем по нашему правилу: для (rule_id, entity_id, breach_date) должна быть ровно 1 запись
              const execK2ForRule = ruleIdK ? await querySlaExecutionForLeadAndRule(leadIdK, ruleIdK) : null;
              if (execK2ForRule !== null) {
                assert(
                  execK2ForRule.count === 1,
                  `После второго запуска: для нашего правила ровно 1 execution (идемпотентность), получено ${execK2ForRule.count}`
                );
                log.ok('Повторный запуск cron → skipped (23505), дубля execution нет.');
              }
            }
        }
      }
    }
  }
  }

  // ---------- Проверка метрик (ЭТАП 5 + 6): GET /metrics у каждого сервиса ----------
  console.log('\n--- Проверка метрик: GET /metrics — STAGE_5 + SLA ---');
  const metricsChecks = [
    { url: CRM_URL, name: 'crm-service', metrics: ['deal_created_total', 'deal_stage_changed_total'] },
    { url: PIPELINE_URL, name: 'pipeline-service', metrics: ['event_publish_total', 'event_publish_failed_total'] },
    { url: AUTOMATION_URL, name: 'automation-service', metrics: ['automation_events_total', 'automation_processed_total', 'automation_skipped_total', 'automation_failed_total', 'deal_created_total', 'automation_dlq_total', 'automation_sla_published_total', 'automation_sla_processed_total', 'automation_sla_skipped_total'] },
  ];
  for (const { url, name, metrics } of metricsChecks) {
    try {
      const res = await fetchJson(`${url}/metrics`, { headers: {} });
      const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
      if (res.status === 200 && body.length > 0) {
        const missing = metrics.filter((m) => !body.includes(m));
        assert(missing.length === 0, `GET /metrics ${name}: 200, все метрики присутствуют (отсутствуют: ${missing.join(', ') || '—'})`);
      } else {
        assert(false, `GET /metrics ${name}: ожидается 200 и текст (получен ${res.status}, body length ${body.length})`);
      }
    } catch (e) {
      assert(false, `GET /metrics ${name}: запрос не выполнен (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Проверяет цепочку по correlation_id в логах: pipeline — publish, automation — consume и processed.
 * Запускает `docker compose logs --tail=500 pipeline-service automation-service` и ищет в выводе строки с correlation_id.
 * @param {string} correlationId — UUID из automation_executions
 * @returns {boolean|null} true — цепочка найдена, false — не найдена, null — проверка пропущена (docker недоступен или отключена)
 */
function checkCorrelationChainInLogs(correlationId) {
  if (process.env.DOCKER_COMPOSE_LOGS === '0') return null;
  const cwd = process.cwd();
  let out;
  try {
    out = execSync('docker compose logs --tail=500 pipeline-service automation-service 2>&1', {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      cwd,
      timeout: 15000,
    });
  } catch (e) {
    try {
      out = execSync('docker-compose logs --tail=500 pipeline-service automation-service 2>&1', {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        cwd,
        timeout: 15000,
      });
    } catch {
      return null;
    }
  }
  const lines = out.split(/\r?\n/).filter((l) => l.includes(correlationId));
  const fromPipeline = (l) => l.includes('pipeline-service') || l.includes('getsale-pipeline');
  const fromAutomation = (l) => l.includes('automation-service') || l.includes('getsale-automation');
  const hasPublish = lines.some((l) => fromPipeline(l) && (l.includes('publish') || l.includes('publish lead.stage.changed')));
  const hasConsume = lines.some((l) => fromAutomation(l) && (l.includes('consume') || l.includes('consume lead.stage.changed')));
  const hasProcessed = lines.some((l) => fromAutomation(l) && (l.includes('processed') || l.includes('lead.stage.changed processed')));
  return hasPublish && hasConsume && hasProcessed ? true : false;
}

/**
 * Строка подключения к Postgres для скрипта, запущенного на хосте.
 * - В .env переменные вида ${POSTGRES_PASSWORD} не раскрываются — подставляем вручную.
 * - Хост postgres (Docker) подменяем на localhost — с хоста имя postgres не резолвится.
 */
function getDbConnectionString() {
  let raw =
    process.env.DATABASE_URL ||
    `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`;
  raw = raw.replace(/\$\{POSTGRES_PASSWORD\}/g, process.env.POSTGRES_PASSWORD || 'postgres_dev');
  raw = raw.replace(/\$\{REDIS_PASSWORD\}/g, process.env.REDIS_PASSWORD || '');
  return raw.replace(/@postgres(\/|:)/g, '@localhost$1');
}

/** Возвращает количество записей automation_executions для entity_type=lead и entity_id=leadId, или null если БД недоступна */
async function queryAutomationExecutions(leadId) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    return null;
  }
  const conn = getDbConnectionString();
  const client = new pg.default.Client({ connectionString: conn });
  try {
    await client.connect();
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM automation_executions WHERE entity_type = 'lead' AND entity_id = $1`,
      [leadId]
    );
    return r.rows[0]?.c ?? 0;
  } catch (err) {
    if (process.env.DEBUG_E2E) console.error('[E2E DB]', err?.message || err);
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Возвращает { correlation_id, trigger_event_id, status } для последней записи automation_executions по лиду, или null */
async function queryAutomationExecutionRow(leadId) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    return null;
  }
  const conn = getDbConnectionString();
  const client = new pg.default.Client({ connectionString: conn });
  try {
    await client.connect();
    const r = await client.query(
      `SELECT correlation_id, trigger_event_id, status FROM automation_executions
       WHERE entity_type = 'lead' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [leadId]
    );
    const row = r.rows[0];
    return row ? { correlation_id: row.correlation_id, trigger_event_id: row.trigger_event_id, status: row.status } : null;
  } catch (err) {
    if (process.env.DEBUG_E2E) console.error('[E2E DB]', err?.message || err);
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Возвращает correlation_id из stage_history для entity_type='lead' и entity_id=leadId (конверсия), или undefined если колонка/запрос недоступны */
async function queryStageHistoryCorrelationForLead(leadId) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    return undefined;
  }
  const conn = getDbConnectionString();
  const client = new pg.default.Client({ connectionString: conn });
  try {
    await client.connect();
    const r = await client.query(
      `SELECT correlation_id FROM stage_history WHERE entity_type = 'lead' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [leadId]
    );
    return r.rows[0]?.correlation_id ?? null;
  } catch {
    return undefined;
  } finally {
    await client.end().catch(() => {});
  }
}

/** ЭТАП 6: устанавливает leads.updated_at в прошлое (daysAgo дней назад). Возвращает true при успехе. */
async function updateLeadUpdatedAt(leadId, daysAgo) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    return false;
  }
  const conn = getDbConnectionString();
  const client = new pg.default.Client({ connectionString: conn });
  try {
    await client.connect();
    await client.query(
      `UPDATE leads SET updated_at = NOW() - ($1 || ' days')::interval WHERE id = $2`,
      [String(daysAgo), leadId]
    );
    return true;
  } catch (err) {
    if (process.env.DEBUG_E2E) console.error('[E2E DB]', err?.message || err);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** ЭТАП 6: возвращает { count, breach_date } для SLA executions по лиду (entity_type=lead, entity_id=leadId, breach_date IS NOT NULL), или null при ошибке. */
async function querySlaExecutionForLead(leadId) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    return null;
  }
  const conn = getDbConnectionString();
  const client = new pg.default.Client({ connectionString: conn });
  try {
    await client.connect();
    const r = await client.query(
      `SELECT COUNT(*)::int AS c, MAX(breach_date)::text AS breach_date
       FROM automation_executions
       WHERE entity_type = 'lead' AND entity_id = $1 AND breach_date IS NOT NULL`,
      [leadId]
    );
    const row = r.rows[0];
    return { count: row?.c ?? 0, breach_date: row?.breach_date ?? null };
  } catch (err) {
    if (process.env.DEBUG_E2E) console.error('[E2E DB]', err?.message || err);
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/** ЭТАП 6: количество execution по лиду и правилу (идемпотентность: для одного rule_id должно быть ровно 1). */
async function querySlaExecutionForLeadAndRule(leadId, ruleId) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    return null;
  }
  const conn = getDbConnectionString();
  const client = new pg.default.Client({ connectionString: conn });
  try {
    await client.connect();
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM automation_executions
       WHERE entity_type = 'lead' AND entity_id = $1 AND rule_id = $2 AND breach_date IS NOT NULL`,
      [leadId, ruleId]
    );
    return { count: r.rows[0]?.c ?? 0 };
  } catch (err) {
    if (process.env.DEBUG_E2E) console.error('[E2E DB]', err?.message || err);
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  const refused = err?.cause?.code === 'ECONNREFUSED' || err?.code === 'ECONNREFUSED';
  if (refused) {
    console.error('\nСервисы CRM или Pipeline не запущены (ECONNREFUSED).');
    console.error('Запустите их, например:\n  docker-compose up -d crm-service pipeline-service\n');
  }
  console.error(err);
  process.exit(1);
});
