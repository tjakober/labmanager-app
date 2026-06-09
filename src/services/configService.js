'use strict';

const db = require('../db/pool');
const Q  = require('../db/queries');

async function get(key) {
  const row = await db.queryOne(Q.getConfig, [key]);
  if (!row) return null;
  if (row.type === 'number')  return parseFloat(row.value);
  if (row.type === 'boolean') return row.value === 'true';
  if (row.type === 'json')    return JSON.parse(row.value);
  return row.value;
}

async function set(key, value, updatedBy = null) {
  await db.query(Q.setConfig, [key, String(value), updatedBy]);
}

module.exports = { get, set };
