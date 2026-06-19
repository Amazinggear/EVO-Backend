const { query } = require('../config/database');
const logger = require('./logger');

const performBackup = async () => {
  try {
    logger.info('Starting database backup to JSON...');
    
    // We fetch critical tables to JSON to provide a snapshot
    const tablesToBackup = ['users', 'driver_profiles', 'rides', 'transactions', 'pricing_config', 'complaints'];
    const backupData = {};

    for (const table of tablesToBackup) {
      const { rows } = await query(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT 1000`); // Taking a sample of recent data for snapshot purposes
      backupData[table] = rows;
    }

    backupData.timestamp = new Date().toISOString();
    
    // In a real scenario, this would be uploaded to S3 or similar
    // We return the raw JSON object for the admin panel to trigger a download
    return backupData;

  } catch (err) {
    logger.error('Database backup failed:', err.message);
    throw err;
  }
};

module.exports = { performBackup };
