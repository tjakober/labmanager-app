'use strict';

const db = require('../db/pool');
const Q  = require('../db/queries');

async function insertLog(machineId, tagId, eventId, timestamp) {
  const result = await db.query(Q.insertLog, [tagId, machineId, eventId, timestamp || new Date()]);
  return Number(result.insertId);
}

async function insertLogIgnore(machineId, tagId, eventId, timestamp) {
  const result = await db.query(Q.insertLogIgnore, [tagId, machineId, eventId, timestamp || new Date()]);
  return Number(result.insertId);
}

async function insertBatch(machineId, events) {
  let inserted = 0;
  const errors = [];

  for (const ev of events) {
    try {
      await db.query(Q.insertLogIgnore, [ev.tag_id, machineId, ev.event_id, ev.timestamp || new Date()]);
      inserted++;
    } catch (err) {
      errors.push({ event: ev, error: err.message });
    }
  }

  return { inserted, errors };
}

module.exports = { insertLog, insertLogIgnore, insertBatch };
