'use strict';

const db = require('../db/pool');
const Q  = require('../db/queries');

async function checkTagRight(tagId, machineId) {
  return db.queryOne(Q.checkTagRight, [tagId, machineId]);
}

async function getRightsForMachine(machineId) {
  return db.query(Q.getRightsForMachine, [machineId]);
}

module.exports = { checkTagRight, getRightsForMachine };
