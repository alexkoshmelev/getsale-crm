import { Pool } from 'pg';
import knex from 'knex';
import knexConfig from './knexfile';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

async function waitForDatabase(maxRetries = 60, delay = 2000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('✅ Database is ready');
      return;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`⏳ Waiting for database... (${i + 1}/${maxRetries}) ${msg}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Database is not available after maximum retries');
}

async function runMigrations() {
  const env = process.env.NODE_ENV || 'development';
  const db = knex(knexConfig[env]);
  
  try {
    console.log('🔄 Running database migrations...');
    console.log(`📁 Migrations directory: ${knexConfig[env].migrations?.directory}`);
    
    // Wait for database to be ready
    await waitForDatabase();
    
    // Get list of migration files - migrate.list() returns [completed, pending]
    const [completed, pending] = await db.migrate.list();
    
    // Extract migration names from objects
    const executed = completed.map((m: any) => m.name || (typeof m === 'string' ? m : null)).filter(Boolean);
    const pendingNames = pending.map((m: any) => m.name || (typeof m === 'string' ? m : null)).filter(Boolean);
    
    console.log(`\n📋 Migration status:`);
    console.log(`   - Executed: ${executed.length}`);
    console.log(`   - Pending: ${pendingNames.length}`);
    
    if (executed.length > 0) {
      console.log(`\n✅ Executed migrations:`);
      executed.forEach((name: string) => {
        console.log(`   - ${name}`);
      });
    }
    
    if (pendingNames.length > 0) {
      console.log(`\n⏳ Pending migrations:`);
      pendingNames.forEach((name: string) => {
        console.log(`   - ${name}`);
      });
    }
    
    // Run migrations
    const [batchNo, migrations] = await db.migrate.latest();
    
    if (migrations.length === 0) {
      console.log('\nℹ️  No new migrations to run');
    } else {
      console.log(`\n✅ Applied ${migrations.length} migration(s) in batch ${batchNo}:`);
      migrations.forEach((migration: string) => {
        console.log(`   - ${migration}`);
      });
    }
    
    console.log('\n✅ Migrations completed successfully');

    // Демо-данные создаются сидами (001_initial_data, 002_demo_access), не миграциями.
    // Сиды идемпотентны: 001 — merge; 002 — создаёт демо только если demo-workspace ещё нет.
    console.log('\n🌱 Running database seeds (001, 002 demo + chats, 003 extra demo deals)...');
    try {
      await db.seed.run();
      console.log('✅ Seeds completed successfully');
    } catch (error: any) {
      console.error('⚠️  Error running seeds:', error.message || error);
      // Don't fail the whole process if seeds fail
    }
  } catch (error: any) {
    console.error('❌ Error running migrations:', error.message || error);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
    throw error;
  } finally {
    await db.destroy();
    await pool.end();
  }
}

runMigrations().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
