const { Pool } = require('pg');
const logger = require('../utils/logger');

// ────────────────────────────────────────────
// PostgreSQL Connection Pool — Neon Cloud
// ────────────────────────────────────────────
// In production, we should ideally use env vars, but as a fallback for 1-click deployments, we provide the Neon DB URL
const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_Pt3DRmLdsy8w@ep-square-bonus-atf93yt1-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new Pool({
  connectionString: connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,                   // max connections in pool
  idleTimeoutMillis: 30000,  // close idle after 30s
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  logger.info('✅ PostgreSQL (Neon) connected successfully');
});

pool.on('error', (err) => {
  logger.error('❌ PostgreSQL pool error:', err.message);
});

// Test connection removed for serverless compatibility

// ────────────────────────────────────────────
// Query Helper
// ────────────────────────────────────────────
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn(`⚠️ Slow query (${duration}ms): ${text.substring(0, 100)}`);
    }
    return result;
  } catch (err) {
    logger.error('❌ Database query error:', {
      query: text.substring(0, 200),
      params,
      error: err.message,
    });
    throw err;
  }
};

const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
