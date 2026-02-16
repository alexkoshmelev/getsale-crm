import { Knex } from 'knex';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

export async function seed(knex: Knex): Promise<void> {
  console.log('🌱 Starting database seeding...');

  const adminPasswordHash = await bcrypt.hash('admin123', 10);
  const testPasswordHash = await bcrypt.hash('test123', 10);

  // --- Организация 1: воркспейс admin@getsale.com (owner) ---
  const [org1] = await knex('organizations')
    .insert({
      name: 'Admin Workspace',
      slug: 'admin-workspace',
    })
    .onConflict('slug')
    .merge()
    .returning('*');
  console.log(`✅ Organization 1: ${org1.name} (${org1.id})`);

  // --- Организация 2: воркспейс test@getsale.com (owner) ---
  const [org2] = await knex('organizations')
    .insert({
      name: 'Test Workspace',
      slug: 'test-workspace',
    })
    .onConflict('slug')
    .merge()
    .returning('*');
  console.log(`✅ Organization 2: ${org2.name} (${org2.id})`);

  // --- Пользователь admin: основной воркспейс org1, роль owner ---
  const [adminUser] = await knex('users')
    .insert({
      email: 'admin@getsale.com',
      password_hash: adminPasswordHash,
      organization_id: org1.id,
      role: 'owner',
    })
    .onConflict('email')
    .merge(['password_hash', 'organization_id', 'role'])
    .returning('*');
  console.log(`✅ Admin user: ${adminUser.email} (${adminUser.id})`);

  // --- Пользователь test: основной воркспейс org2, роль owner ---
  const [testUser] = await knex('users')
    .insert({
      email: 'test@getsale.com',
      password_hash: testPasswordHash,
      organization_id: org2.id,
      role: 'owner',
    })
    .onConflict('email')
    .merge(['password_hash', 'organization_id', 'role'])
    .returning('*');
  console.log(`✅ Test user: ${testUser.email} (${testUser.id})`);

  // --- organization_members: Admin Workspace — admin owner, test supervisor; Test Workspace — test owner, admin supervisor ---
  await knex('organization_members')
    .insert([
      { user_id: adminUser.id, organization_id: org1.id, role: 'owner' },
      { user_id: adminUser.id, organization_id: org2.id, role: 'supervisor' },
      { user_id: testUser.id, organization_id: org2.id, role: 'owner' },
      { user_id: testUser.id, organization_id: org1.id, role: 'supervisor' },
    ])
    .onConflict(['user_id', 'organization_id'])
    .merge(['role']);
  await knex('organization_members').where({ organization_id: org1.id, user_id: testUser.id }).update({ role: 'supervisor' });
  await knex('organization_members').where({ organization_id: org2.id, user_id: adminUser.id }).update({ role: 'supervisor' });
  console.log('✅ Organization members (Admin Workspace: admin=owner, test=supervisor; Test Workspace: test=owner, admin=supervisor)');

  // --- Профили пользователей (один на пользователя, primary org) ---
  await knex('user_profiles')
    .insert({
      user_id: adminUser.id,
      organization_id: org1.id,
      first_name: 'Admin',
      last_name: 'User',
    })
    .onConflict('user_id')
    .merge();
  await knex('user_profiles')
    .insert({
      user_id: testUser.id,
      organization_id: org2.id,
      first_name: 'Test',
      last_name: 'User',
    })
    .onConflict('user_id')
    .merge();
  console.log('✅ User profiles');

  const defaultStages = [
    { name: 'Lead', order: 1, color: '#3B82F6' },
    { name: 'Qualified', order: 2, color: '#10B981' },
    { name: 'Proposal', order: 3, color: '#F59E0B' },
    { name: 'Negotiation', order: 4, color: '#EF4444' },
    { name: 'Closed Won', order: 5, color: '#8B5CF6' },
    { name: 'Closed Lost', order: 6, color: '#6B7280' },
  ];

  // --- Org1: pipeline, stages, team, team_members, company, contact, deal ---
  let pipeline1 = await knex('pipelines').where({ organization_id: org1.id, name: 'Default Pipeline' }).first();
  if (!pipeline1) {
    [pipeline1] = await knex('pipelines')
      .insert({
        organization_id: org1.id,
        name: 'Default Pipeline',
        description: 'Default sales pipeline',
        is_default: true,
      })
      .returning('*');
    console.log(`✅ Org1 pipeline: ${pipeline1.name}`);
  }
  for (const s of defaultStages) {
    const exists = await knex('stages').where({ pipeline_id: pipeline1.id, organization_id: org1.id, name: s.name }).first();
    if (!exists) {
      await knex('stages').insert({
        pipeline_id: pipeline1.id,
        organization_id: org1.id,
        name: s.name,
        order_index: s.order,
        color: s.color,
      });
    }
  }

  let team1 = await knex('teams').where({ organization_id: org1.id, name: 'Default Team' }).first();
  if (!team1) {
    [team1] = await knex('teams')
      .insert({
        organization_id: org1.id,
        name: 'Default Team',
        created_by: adminUser.id,
      })
      .returning('*');
    console.log(`✅ Org1 team: ${team1.name}`);
  }
  for (const m of [
    { team_id: team1.id, user_id: adminUser.id, role: 'owner', invited_by: adminUser.id },
    { team_id: team1.id, user_id: testUser.id, role: 'supervisor', invited_by: adminUser.id },
  ]) {
    await knex('team_members').insert(m).onConflict(['team_id', 'user_id']).merge(['role']);
  }
  await knex('team_members').where({ team_id: team1.id, user_id: adminUser.id }).update({ role: 'owner' });
  await knex('team_members').where({ team_id: team1.id, user_id: testUser.id }).update({ role: 'supervisor' });

  let company1 = await knex('companies').where({ organization_id: org1.id, name: 'Acme Corp' }).first();
  if (!company1) {
    [company1] = await knex('companies')
      .insert({
        organization_id: org1.id,
        name: 'Acme Corp',
        industry: 'Technology',
        size: '50-100',
      })
      .returning('*');
    console.log(`✅ Org1 company: ${company1.name}`);
  }
  const stage1Lead = await knex('stages').where({ pipeline_id: pipeline1.id, organization_id: org1.id, name: 'Lead' }).first();
  let contact1 = await knex('contacts').where({ organization_id: org1.id, email: 'john.doe@acme.com' }).first();
  if (!contact1) {
    [contact1] = await knex('contacts')
      .insert({
        organization_id: org1.id,
        company_id: company1.id,
        first_name: 'John',
        last_name: 'Doe',
        email: 'john.doe@acme.com',
      })
      .returning('*');
    console.log('✅ Org1 contact: John Doe');
  }
  const existingDeal1 = await knex('deals').where({ organization_id: org1.id, title: 'Acme Enterprise Deal' }).first();
  if (!existingDeal1 && stage1Lead) {
    await knex('deals').insert({
      organization_id: org1.id,
      pipeline_id: pipeline1.id,
      stage_id: stage1Lead.id,
      contact_id: contact1.id,
      owner_id: adminUser.id,
      title: 'Acme Enterprise Deal',
      value: 15000,
    });
    console.log('✅ Org1 deal');
  }
  // Сделка в org1 от пользователя test — чтобы под admin видеть сделку другого пользователя (общая воронка)
  const existingDealTestInOrg1 = await knex('deals').where({ organization_id: org1.id, title: 'Тестовая сделка (test@getsale.com)' }).first();
  if (!existingDealTestInOrg1 && stage1Lead) {
    await knex('deals').insert({
      organization_id: org1.id,
      pipeline_id: pipeline1.id,
      stage_id: stage1Lead.id,
      company_id: company1.id,
      contact_id: contact1.id,
      owner_id: testUser.id,
      title: 'Тестовая сделка (test@getsale.com)',
      value: 5000,
      created_by_id: testUser.id,
    });
    console.log('✅ Org1 deal (created by test user, visible to admin)');
  }

  // --- Org2: pipeline, stages, team, team_members, company, contact, deal ---
  let pipeline2 = await knex('pipelines').where({ organization_id: org2.id, name: 'Default Pipeline' }).first();
  if (!pipeline2) {
    [pipeline2] = await knex('pipelines')
      .insert({
        organization_id: org2.id,
        name: 'Default Pipeline',
        description: 'Default sales pipeline',
        is_default: true,
      })
      .returning('*');
    console.log(`✅ Org2 pipeline: ${pipeline2.name}`);
  }
  for (const s of defaultStages) {
    const exists = await knex('stages').where({ pipeline_id: pipeline2.id, organization_id: org2.id, name: s.name }).first();
    if (!exists) {
      await knex('stages').insert({
        pipeline_id: pipeline2.id,
        organization_id: org2.id,
        name: s.name,
        order_index: s.order,
        color: s.color,
      });
    }
  }

  let team2 = await knex('teams').where({ organization_id: org2.id, name: 'Default Team' }).first();
  if (!team2) {
    [team2] = await knex('teams')
      .insert({
        organization_id: org2.id,
        name: 'Default Team',
        created_by: testUser.id,
      })
      .returning('*');
    console.log(`✅ Org2 team: ${team2.name}`);
  }
  for (const m of [
    { team_id: team2.id, user_id: testUser.id, role: 'owner', invited_by: testUser.id },
    { team_id: team2.id, user_id: adminUser.id, role: 'supervisor', invited_by: testUser.id },
  ]) {
    await knex('team_members').insert(m).onConflict(['team_id', 'user_id']).merge(['role']);
  }
  await knex('team_members').where({ team_id: team2.id, user_id: testUser.id }).update({ role: 'owner' });
  await knex('team_members').where({ team_id: team2.id, user_id: adminUser.id }).update({ role: 'supervisor' });

  let company2 = await knex('companies').where({ organization_id: org2.id, name: 'Beta Inc' }).first();
  if (!company2) {
    [company2] = await knex('companies')
      .insert({
        organization_id: org2.id,
        name: 'Beta Inc',
        industry: 'Finance',
        size: '10-50',
      })
      .returning('*');
    console.log(`✅ Org2 company: ${company2.name}`);
  }
  const stage2Lead = await knex('stages').where({ pipeline_id: pipeline2.id, organization_id: org2.id, name: 'Lead' }).first();
  let contact2 = await knex('contacts').where({ organization_id: org2.id, email: 'jane@beta.com' }).first();
  if (!contact2) {
    [contact2] = await knex('contacts')
      .insert({
        organization_id: org2.id,
        company_id: company2.id,
        first_name: 'Jane',
        last_name: 'Smith',
        email: 'jane@beta.com',
      })
      .returning('*');
    console.log('✅ Org2 contact: Jane Smith');
  }
  const existingDeal2 = await knex('deals').where({ organization_id: org2.id, title: 'Beta Partnership' }).first();
  if (!existingDeal2 && stage2Lead) {
    await knex('deals').insert({
      organization_id: org2.id,
      pipeline_id: pipeline2.id,
      stage_id: stage2Lead.id,
      contact_id: contact2.id,
      owner_id: testUser.id,
      title: 'Beta Partnership',
      value: 8000,
    });
    console.log('✅ Org2 deal');
  }

  // --- Подписки (по одной на пользователя, привязаны к primary org) ---
  if (!(await knex('subscriptions').where({ user_id: adminUser.id }).first())) {
    await knex('subscriptions').insert({
      user_id: adminUser.id,
      organization_id: org1.id,
      plan: 'pro',
      status: 'active',
    });
  }
  if (!(await knex('subscriptions').where({ user_id: testUser.id }).first())) {
    await knex('subscriptions').insert({
      user_id: testUser.id,
      organization_id: org2.id,
      plan: 'pro',
      status: 'active',
    });
  }
  console.log('✅ Subscriptions');

  // --- Инвайт-ссылки (опционально, для проверки функционала) ---
  const existingInv1 = await knex('organization_invite_links').where({ organization_id: org1.id }).first();
  if (!existingInv1) {
    await knex('organization_invite_links').insert({
      organization_id: org1.id,
      token: randomUUID(),
      role: 'bidi',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      created_by: adminUser.id,
    });
  }
  const existingInv2 = await knex('organization_invite_links').where({ organization_id: org2.id }).first();
  if (!existingInv2) {
    await knex('organization_invite_links').insert({
      organization_id: org2.id,
      token: randomUUID(),
      role: 'bidi',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      created_by: testUser.id,
    });
  }
  console.log('✅ Invite links');

  console.log('\n🎉 Database seeding completed successfully!');
  console.log('\n📝 Credentials and workspaces:');
  console.log('   Admin: admin@getsale.com / admin123');
  console.log('     → Owner in "Admin Workspace", Supervisor in "Test Workspace"');
  console.log('   Test:  test@getsale.com / test123');
  console.log('     → Owner in "Test Workspace", Supervisor in "Admin Workspace"');
}
