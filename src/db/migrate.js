const fs = require('fs');
const path = require('path');
const pool = require('./client');
const logger = require('../utils/logger');

async function runMigrations() {
  logger.info('Running database schema migrations...');
  try {
    const sqlPath = path.join(__dirname, '../../db/trigger.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
    logger.info('Database schema and triggers verified/applied successfully.');
  } catch (err) {
    logger.error('Database migration failed:', err);
    throw err;
  }
}

module.exports = { runMigrations };
