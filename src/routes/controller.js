'use strict';

const express       = require('express');
const db            = require('../db/pool');
const Q             = require('../db/queries');
const logService    = require('../services/logService');
const rightService  = require('../services/rightService');
const { controllerAuth } = require('../middleware/controllerAuth');

const router = express.Router();
router.use(controllerAuth);

/**
 * POST /api/controller/auth
 * Body: { tag_id }
 */
router.post('/auth', async (req, res) => {
  const { tag_id } = req.body;
  const machine_id  = req.machineId;

  try {
    const right = await rightService.checkTagRight(tag_id, machine_id);

    if (!right) {
      return res.json({ allowed: false, user_name: null, user_id: null });
    }

    return res.json({ allowed: true, user_name: right.name, user_id: right.user_id });

  } catch (err) {
    console.error('[controller/auth]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/controller/log
 * Body: { tag_id, event_id, timestamp }
 */
router.post('/log', async (req, res) => {
  const { tag_id, event_id, timestamp } = req.body;

  try {
    const log_id = await logService.insertLog(req.machineId, tag_id, event_id, timestamp);
    return res.json({ ok: true, log_id });

  } catch (err) {
    console.error('[controller/log]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/controller/log/batch
 * Body: { events: [{ tag_id, event_id, timestamp }] }
 */
router.post('/log/batch', async (req, res) => {
  const { events = [] } = req.body;

  try {
    const result = await logService.insertBatch(req.machineId, events);
    return res.json({ ok: true, ...result });

  } catch (err) {
    console.error('[controller/log/batch]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/controller/rights/:machine_id
 * Returns all valid tag IDs for this machine (for local flash cache).
 */
router.get('/rights/:machine_id', async (req, res) => {
  try {
    const tags = await rightService.getRightsForMachine(req.machineId);
    return res.json({ tags });

  } catch (err) {
    console.error('[controller/rights]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/controller/config/:machine_id
 * Returns machine tariff parameters.
 */
router.get('/config/:machine_id', async (req, res) => {
  try {
    const machine = await db.queryOne(Q.getMachineConfig, [req.machineId]);

    if (!machine) return res.status(404).json({ error: 'Maschine nicht gefunden' });
    return res.json(machine);

  } catch (err) {
    console.error('[controller/config]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/controller/heartbeat
 * Body: { firmware_version, ip, uptime }
 */
router.post('/heartbeat', async (req, res) => {
  const { firmware_version, ip } = req.body;

  try {
    await db.query(Q.updateHeartbeat, [firmware_version, ip, req.machineId]);
    return res.json({ ok: true });

  } catch (err) {
    console.error('[controller/heartbeat]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

module.exports = router;
