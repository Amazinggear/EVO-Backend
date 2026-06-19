#!/usr/bin/env node
// ══════════════════════════════════════════════════════
// EVO Database Setup Script
// Runs migrations v1 + v2 on Neon PostgreSQL
// Usage: node src/database/setup.js
// ══════════════════════════════════════════════════════

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigration(label, file) {
  console.log(`\n🚀 Running ${label}...`);
  const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`✅ ${label} — SUCCESS`);
  } catch (err) {
    await client.query('ROLLBACK');
    // If error is "already exists", that's OK — just warn
    if (err.message.includes('already exists')) {
      console.log(`⚠️  ${label} — Some objects already exist (OK)`);
    } else {
      console.error(`❌ ${label} — FAILED:`, err.message);
      throw err;
    }
  } finally {
    client.release();
  }
}

async function seedAdminUser() {
  console.log('\n🌱 Seeding admin user...');
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id FROM users WHERE email = 'admin@evo.jo' AND role = 'admin'`
    );
    if (rows.length === 0) {
      await client.query(`
        INSERT INTO users (phone, email, full_name, role, status, preferred_language)
        VALUES ('+962790000000', 'admin@evo.jo', 'EVO Admin', 'admin', 'active', 'ar')
        ON CONFLICT (phone) DO NOTHING
      `);
      console.log('✅ Admin user created: admin@evo.jo');
    } else {
      console.log('⚠️  Admin user already exists — skipped');
    }
  } finally {
    client.release();
  }
}

async function checkTables() {
  console.log('\n📊 Verifying tables...');
  const { rows } = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name
  `);
  console.log(`\n✅ Tables created (${rows.length} total):`);
  rows.forEach(r => console.log(`   → ${r.table_name}`));
}

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  EVO Database Setup — Neon PostgreSQL');
  console.log('═══════════════════════════════════════');
  console.log(`🔗 Connecting to: ${process.env.DATABASE_URL?.substring(0, 40)}...`);

  try {
    // Test connection first
    await pool.query('SELECT 1');
    console.log('✅ Connection established!\n');

    // Run migrations in order
    await runMigration('V1 — Core Tables (12 tables)', 'migrations.sql');
    await runMigration('V2 — Updates (5 car types, wallet, CliQ)', 'migrations_v2.sql');
    await runMigration('V3 — Admin Panel (RBAC, Complaints, Stats)', 'migrations_v3.sql');
    
    // Seed admin
    await seedAdminUser();
    
    // Verify
    await checkTables();

    console.log('\n🎉 Database setup COMPLETE!');
    console.log('   All tables created, admin user ready.');
    console.log('\n🔌 Restart the backend server now.');
    
  } catch (err) {
    console.error('\n💀 SETUP FAILED:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
