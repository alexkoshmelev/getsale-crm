import { Knex } from 'knex';
import bcrypt from 'bcryptjs';

export async function seed(knex: Knex): Promise<void> {
  console.log('🌱 Starting database seeding...');

  // Create default organization
  const [org] = await knex('organizations')
    .insert({
      name: 'Default Organization',
      slug: 'default-org',
    })
    .onConflict('slug')
    .merge()
    .returning('*');
  
  console.log(`✅ Created organization: ${org.name} (${org.id})`);

  // Create admin user
  const passwordHash = await bcrypt.hash('admin123', 10);
  const [adminUser] = await knex('users')
    .insert({
      email: 'admin@getsale.com',
      password_hash: passwordHash,
      organization_id: org.id,
      role: 'admin',
    })
    .onConflict('email')
    .merge()
    .returning('*');
  
  console.log(`✅ Created admin user: ${adminUser.email} (${adminUser.id})`);

  // Create test user
  const testPasswordHash = await bcrypt.hash('test123', 10);
  const [testUser] = await knex('users')
    .insert({
      email: 'test@getsale.com',
      password_hash: testPasswordHash,
      organization_id: org.id,
      role: 'bidi',
    })
    .onConflict('email')
    .merge()
    .returning('*');
  
  console.log(`✅ Created test user: ${testUser.email} (${testUser.id})`);

  // Create user profiles for both users
  await knex('user_profiles')
    .insert({
      user_id: adminUser.id,
      organization_id: org.id,
      first_name: 'Admin',
      last_name: 'User',
    })
    .onConflict('user_id')
    .merge();
  
  console.log('✅ Created admin user profile');

  // Create user profile for test user
  await knex('user_profiles')
    .insert({
      user_id: testUser.id,
      organization_id: org.id,
      first_name: 'Test',
      last_name: 'User',
    })
    .onConflict('user_id')
    .merge();
  
  console.log('✅ Created test user profile');

  // Create default team (idempotent - check if exists first)
  let team = await knex('teams')
    .where({ organization_id: org.id, name: 'Default Team' })
    .first();
  
  if (!team) {
    [team] = await knex('teams')
      .insert({
        organization_id: org.id,
        name: 'Default Team',
        created_by: adminUser.id,
      })
      .returning('*');
    console.log(`✅ Created team: ${team.name} (${team.id})`);
  } else {
    console.log(`ℹ️  Team already exists: ${team.name} (${team.id})`);
  }

  // Add admin user to team (idempotent)
  const adminMember = await knex('team_members')
    .where({ team_id: team.id, user_id: adminUser.id })
    .first();
  
  if (!adminMember) {
    await knex('team_members').insert({
      team_id: team.id,
      user_id: adminUser.id,
      role: 'admin',
      invited_by: adminUser.id,
    });
    console.log('✅ Added admin user to team');
  } else {
    console.log('ℹ️  Admin user already in team');
  }

  // Add test user to team (idempotent)
  const testMember = await knex('team_members')
    .where({ team_id: team.id, user_id: testUser.id })
    .first();
  
  if (!testMember) {
    await knex('team_members').insert({
      team_id: team.id,
      user_id: testUser.id,
      role: 'member',
      invited_by: adminUser.id,
    });
    console.log('✅ Added test user to team');
  } else {
    console.log('ℹ️  Test user already in team');
  }

  // Create default pipeline (idempotent - check if exists first)
  let pipeline = await knex('pipelines')
    .where({ organization_id: org.id, name: 'Default Pipeline' })
    .first();
  
  if (!pipeline) {
    [pipeline] = await knex('pipelines')
      .insert({
        organization_id: org.id,
        name: 'Default Pipeline',
        description: 'Default sales pipeline',
        is_default: true,
      })
      .returning('*');
    console.log(`✅ Created pipeline: ${pipeline.name} (${pipeline.id})`);
  } else {
    console.log(`ℹ️  Pipeline already exists: ${pipeline.name} (${pipeline.id})`);
  }

  // Create default stages (idempotent - check if exists first)
  const stages = [
    { name: 'Lead', order: 1, color: '#3B82F6' },
    { name: 'Qualified', order: 2, color: '#10B981' },
    { name: 'Proposal', order: 3, color: '#F59E0B' },
    { name: 'Negotiation', order: 4, color: '#EF4444' },
    { name: 'Closed Won', order: 5, color: '#8B5CF6' },
    { name: 'Closed Lost', order: 6, color: '#6B7280' },
  ];

  let createdStages = 0;
  for (const stage of stages) {
    const existing = await knex('stages')
      .where({ 
        pipeline_id: pipeline.id, 
        organization_id: org.id, 
        name: stage.name 
      })
      .first();
    
    if (!existing) {
      await knex('stages').insert({
        pipeline_id: pipeline.id,
        organization_id: org.id,
        name: stage.name,
        order_index: stage.order,
        color: stage.color,
      });
      createdStages++;
    }
  }
  
  if (createdStages > 0) {
    console.log(`✅ Created ${createdStages} new stage(s)`);
  } else {
    console.log(`ℹ️  All stages already exist`);
  }

  // Create test company (idempotent - check if exists first)
  let company = await knex('companies')
    .where({ organization_id: org.id, name: 'Acme Corp' })
    .first();
  
  if (!company) {
    [company] = await knex('companies')
      .insert({
        organization_id: org.id,
        name: 'Acme Corp',
        industry: 'Technology',
        size: '50-100',
      })
      .returning('*');
    console.log(`✅ Created company: ${company.name} (${company.id})`);
  } else {
    console.log(`ℹ️  Company already exists: ${company.name} (${company.id})`);
  }

  // Create test contact (idempotent - check if exists first)
  const existingContact = await knex('contacts')
    .where({ 
      organization_id: org.id, 
      company_id: company.id, 
      email: 'john.doe@acme.com' 
    })
    .first();
  
  if (!existingContact) {
    await knex('contacts').insert({
      organization_id: org.id,
      company_id: company.id,
      first_name: 'John',
      last_name: 'Doe',
      email: 'john.doe@acme.com',
    });
    console.log('✅ Created test contact');
  } else {
    console.log('ℹ️  Test contact already exists');
  }

  // Create subscription for admin
  await knex('subscriptions').insert({
    user_id: adminUser.id,
    organization_id: org.id,
    plan: 'pro',
    status: 'active',
  }).onConflict().ignore();
  
  console.log('✅ Created subscription for admin user');

  console.log('\n🎉 Database seeding completed successfully!');
  console.log('\n📝 Default credentials:');
  console.log('   Admin: admin@getsale.com / admin123');
  console.log('   Test:  test@getsale.com / test123');
}

