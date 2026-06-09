'use strict';

const db = require('../db/pool');

/**
 * Prüft den X-Controller-Key Header.
 * Setzt req.machineId wenn gültig.
 */
async function controllerAuth(req, res, next) {
  const key = req.headers['x-controller-key'];

  if (!key) {
    return res.status(401).json({ error: 'API-Key fehlt' });
  }

  try {
    const machine = await db.queryOne(
      `SELECT id FROM machines
       WHERE api_key = ? AND active = 1`,
      [key]
    );

    if (!machine) {
      return res.status(401).json({ error: 'API-Key ungültig' });
    }

    req.machineId = machine.id;
    next();

  } catch (err) {
    console.error('[controllerAuth]', err.message);
    return res.status(500).json({ error: 'Server-Fehler' });
  }
}

module.exports = { controllerAuth };
