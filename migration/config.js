'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

module.exports = {

  // Source: Zynex CMS export
  // Default: CSV files in migration/input/
  // Optional: set MIGRATION_DB_HOST to connect directly via MSSQL (requires: npm i mssql)
  source: {
    csvDir:  process.env.MIGRATION_CSV_DIR   || require('path').join(__dirname, 'input'),
    dbHost:  process.env.MIGRATION_DB_HOST   || '',
    dbPort:  parseInt(process.env.MIGRATION_DB_PORT  || '1433'),
    dbName:  process.env.MIGRATION_DB_NAME   || '',
    dbUser:  process.env.MIGRATION_DB_USER   || '',
    dbPass:  process.env.MIGRATION_DB_PASS   || '',
  },

  // Target: local MariaDB (same credentials as the app)
  target: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306'),
    database: process.env.DB_NAME     || 'fablabwinti',
    user:     process.env.DB_USER     || 'fablab',
    password: process.env.DB_PASSWORD || '',
  },

  // Webling REST API
  webling: {
    apiUrl:    process.env.WEBLING_API_URL || '',
    apiKey:    process.env.WEBLING_API_KEY || '',
    rateDelay: parseInt(process.env.WEBLING_RATE_DELAY_MS || '300'), // ms between requests
  },

};
