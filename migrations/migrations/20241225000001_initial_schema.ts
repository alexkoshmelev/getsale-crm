import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Organizations (must be first - referenced by other tables)
  await knex.schema.createTable('organizations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name', 255).notNullable();
    table.string('slug', 255).notNullable().unique();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  // Users (auth-service)
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email', 255).notNullable().unique();
    table.string('password_hash', 255).notNullable();
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('role', 50).notNullable().defaultTo('bidi');
    table.uuid('bidi_id');
    table.string('mfa_secret', 255);
    table.boolean('mfa_enabled').notNullable().defaultTo(false);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('email');
    table.index('organization_id');
  });

  // Refresh tokens
  await knex.schema.createTable('refresh_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.text('token').notNullable().unique(); // Changed from VARCHAR(255) to TEXT for JWT tokens
    table.timestamp('expires_at').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('token');
  });

  // User profiles (user-service)
  await knex.schema.createTable('user_profiles', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().unique().references('id').inTable('users');
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('first_name', 255);
    table.string('last_name', 255);
    table.string('avatar_url', 500);
    table.string('timezone', 50);
    table.jsonb('preferences').defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('user_id');
  });

  // Subscriptions
  await knex.schema.createTable('subscriptions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().unique().references('id').inTable('users');
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('stripe_customer_id', 255);
    table.string('stripe_subscription_id', 255);
    table.string('plan', 50).notNullable().defaultTo('free');
    table.string('status', 50).notNullable().defaultTo('active');
    table.timestamp('current_period_start');
    table.timestamp('current_period_end');
    table.boolean('cancel_at_period_end').notNullable().defaultTo(false);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
  });

  // Companies (crm-service)
  await knex.schema.createTable('companies', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('name', 255).notNullable();
    table.string('industry', 100);
    table.string('size', 50);
    table.text('description');
    table.jsonb('goals');
    table.jsonb('policies');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
  });

  // Contacts
  await knex.schema.createTable('contacts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.uuid('company_id').references('id').inTable('companies');
    table.string('first_name', 255).notNullable();
    table.string('last_name', 255);
    table.string('email', 255);
    table.string('phone', 50);
    table.string('telegram_id', 100);
    table.jsonb('consent_flags').defaultTo('{"email": false, "sms": false, "telegram": false, "marketing": false}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
    table.index('company_id');
  });

  // Pipelines (pipeline-service)
  await knex.schema.createTable('pipelines', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('name', 255).notNullable();
    table.text('description');
    table.boolean('is_default').notNullable().defaultTo(false);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
  });

  // Stages
  await knex.schema.createTable('stages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('pipeline_id').notNullable().references('id').inTable('pipelines').onDelete('CASCADE');
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('name', 100).notNullable();
    table.integer('order_index').notNullable();
    table.string('color', 20);
    table.jsonb('automation_rules').defaultTo('[]');
    table.jsonb('entry_rules').defaultTo('[]');
    table.jsonb('exit_rules').defaultTo('[]');
    table.jsonb('allowed_actions').defaultTo('[]');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('pipeline_id');
    table.index('organization_id');
  });

  // Deals
  await knex.schema.createTable('deals', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.uuid('company_id').notNullable().references('id').inTable('companies');
    table.uuid('contact_id').references('id').inTable('contacts');
    table.uuid('pipeline_id').notNullable().references('id').inTable('pipelines');
    table.uuid('stage_id').notNullable().references('id').inTable('stages');
    table.uuid('owner_id').notNullable().references('id').inTable('users');
    table.string('title', 255).notNullable();
    table.decimal('value');
    table.string('currency', 10);
    table.jsonb('history').defaultTo('[]');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
    table.index('company_id');
    table.index('owner_id');
  });

  // Stage history
  await knex.schema.createTable('stage_history', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('client_id').notNullable();
    table.uuid('deal_id').references('id').inTable('deals');
    table.uuid('from_stage_id').references('id').inTable('stages');
    table.uuid('to_stage_id').notNullable().references('id').inTable('stages');
    table.uuid('moved_by').references('id').inTable('users');
    table.timestamp('moved_at').notNullable().defaultTo(knex.fn.now());
    table.boolean('auto_moved').notNullable().defaultTo(false);
    table.text('reason');
    
    table.index('client_id');
    table.index('deal_id');
  });

  // Teams
  await knex.schema.createTable('teams', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('name', 255).notNullable();
    table.uuid('created_by').notNullable().references('id').inTable('users');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
  });

  // Team members
  await knex.schema.createTable('team_members', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users');
    table.string('role', 50).notNullable().defaultTo('member');
    table.uuid('invited_by').references('id').inTable('users');
    table.string('status', 50).notNullable().defaultTo('active');
    table.timestamp('joined_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('team_id');
    table.index('user_id');
    table.unique(['team_id', 'user_id']);
  });

  // Team invitations
  await knex.schema.createTable('team_invitations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    table.string('email', 255).notNullable();
    table.string('role', 50).notNullable().defaultTo('member');
    table.uuid('invited_by').notNullable().references('id').inTable('users');
    table.string('token', 255).notNullable().unique();
    table.timestamp('expires_at').notNullable();
    table.timestamp('accepted_at');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // BD Accounts
  await knex.schema.createTable('bd_accounts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('telegram_id', 100).notNullable().unique();
    table.string('phone_number', 50);
    table.string('api_id', 255);
    table.string('api_hash', 255);
    table.text('session_string');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('connected_at');
    table.timestamp('last_activity');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    // TODO: add name or comment for editing on front

    table.index('organization_id');
    table.index('telegram_id');
  });

  // BD Account status
  await knex.schema.createTable('bd_account_status', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('account_id').notNullable().references('id').inTable('bd_accounts').onDelete('CASCADE');
    table.string('status', 50).notNullable();
    table.text('message');
    table.timestamp('recorded_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('account_id');
  });

  // Messages
  await knex.schema.createTable('messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.uuid('contact_id').references('id').inTable('contacts');
    table.uuid('bd_account_id').references('id').inTable('bd_accounts');
    table.string('channel', 50).notNullable();
    table.string('channel_id', 255);
    table.string('direction', 20).notNullable();
    table.text('content').notNullable();
    table.string('status', 50).defaultTo('sent');
    table.boolean('unread').notNullable().defaultTo(true);
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('sent_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
    table.index('contact_id');
    table.index('bd_account_id');
    table.index('unread');
  });

  // Automation rules
  await knex.schema.createTable('automation_rules', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('name', 255).notNullable();
    table.string('trigger_type', 100).notNullable();
    table.jsonb('trigger_conditions').notNullable();
    table.jsonb('actions').notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
  });

  // Automation executions
  await knex.schema.createTable('automation_executions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('rule_id').notNullable().references('id').inTable('automation_rules').onDelete('CASCADE');
    table.string('trigger_event', 100).notNullable();
    table.string('status', 50).notNullable();
    table.jsonb('result');
    table.timestamp('executed_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('rule_id');
  });

  // Analytics metrics
  await knex.schema.createTable('analytics_metrics', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('metric_type', 100).notNullable();
    table.string('metric_name', 255).notNullable();
    table.decimal('value').notNullable();
    table.jsonb('dimensions').defaultTo('{}');
    table.timestamp('recorded_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
    table.index('metric_type');
    table.index('recorded_at');
  });

  // Conversion rates
  await knex.schema.createTable('conversion_rates', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.string('from_stage', 100);
    table.string('to_stage', 100);
    table.decimal('rate').notNullable();
    table.timestamp('period_start').notNullable();
    table.timestamp('period_end').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('organization_id');
  });

  // Team client assignments
  await knex.schema.createTable('team_client_assignments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('team_id').notNullable().references('id').inTable('teams').onDelete('CASCADE');
    table.uuid('client_id').notNullable();
    table.timestamp('assigned_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('assigned_by').references('id').inTable('users');
    
    table.index('team_id');
    table.index('client_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('team_client_assignments');
  await knex.schema.dropTableIfExists('conversion_rates');
  await knex.schema.dropTableIfExists('analytics_metrics');
  await knex.schema.dropTableIfExists('automation_executions');
  await knex.schema.dropTableIfExists('automation_rules');
  await knex.schema.dropTableIfExists('messages');
  await knex.schema.dropTableIfExists('bd_account_status');
  await knex.schema.dropTableIfExists('bd_accounts');
  await knex.schema.dropTableIfExists('team_invitations');
  await knex.schema.dropTableIfExists('team_members');
  await knex.schema.dropTableIfExists('teams');
  await knex.schema.dropTableIfExists('stage_history');
  await knex.schema.dropTableIfExists('deals');
  await knex.schema.dropTableIfExists('stages');
  await knex.schema.dropTableIfExists('pipelines');
  await knex.schema.dropTableIfExists('contacts');
  await knex.schema.dropTableIfExists('companies');
  await knex.schema.dropTableIfExists('subscriptions');
  await knex.schema.dropTableIfExists('user_profiles');
  await knex.schema.dropTableIfExists('refresh_tokens');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('organizations');
}

