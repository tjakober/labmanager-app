'use strict';

const mariadb = require('mariadb');
const cfg     = require('../config');

const pool = mariadb.createPool({
  host:            cfg.db.host,
  port:            cfg.db.port,
  database:        cfg.db.database,
  user:            cfg.db.user,
  password:        cfg.db.password,
  connectionLimit: cfg.db.connectionLimit,
  collation:       'UTF8MB4_UNICODE_CI',
  dateStrings:     true,
});

/**
 * Führt eine SQL-Abfrage aus.
 * @param {string} sql
 * @param {Array}  params
 * @returns {Promise<Array>}
 */
async function query(sql, params = []) {
  let conn;
  try {
    conn = await pool.getConnection();
    return await conn.query(sql, params);
  } finally {
    if (conn) conn.release();
  }
}

/**
 * Gibt eine einzelne Zeile zurück (oder null).
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

module.exports = { pool, query, queryOne };
