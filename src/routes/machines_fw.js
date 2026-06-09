'use strict';

/**
 * Firmware-kompatible API für RFID Machine Controller (ESP8266)
 * Entspricht den Endpunkten die die bestehende Firmware erwartet.
 *
 * GET  /api/machines/:mid         → Maschinenparameter
 * GET  /api/machines/:mid/tags    → Berechtigte Tags mit Gültigkeitszeitraum
 * POST /api/logs                  → Event-Log vom Controller
 *
 * Authentifizierung: HTTPS-Zertifikat-Pinning (Firmware-seitig).
 * Machine-ID im URL / Body identifiziert den Controller.
 */

const express      = require('express');
const db           = require('../db/pool');
const Q            = require('../db/queries');
const logService   = require('../services/logService');
const { sessionStart, sessionEnd } = require('./display');

const router = express.Router();

// CORS für Controller-Webinterface (Browser auf 192.168.x.x)
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── GET /api/machines → Liste aller aktiven Maschinen ─────────────────────

router.get('/', async (req, res) => {
  try {
    const machines = await db.query(Q.getAllMachines, []);
    res.json(machines.map(m => ({ mid: m.id, name: m.name })));
  } catch (err) {
    console.error('[machines_fw/list]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── GET /api/machines/:mid ─────────────────────────────────────────────────

router.get('/:mid', async (req, res) => {
  const mid = parseInt(req.params.mid);
  if (isNaN(mid)) return res.status(400).json({ error: 'Ungültige Machine-ID' });

  try {
    const machine = await db.queryOne(Q.getFirmwareMachineConfig, [mid]);
    if (!machine) return res.status(404).json({ error: 'Maschine nicht gefunden' });

    res.json({
      name:        machine.name,
      price:       Math.round(parseFloat(machine.price) * 100),      // CHF → Rappen
      period:      machine.period,                                    // Minuten
      min_periods: machine.min_periods,
      minp_price:  machine.minp_price != null
                     ? Math.round(parseFloat(machine.minp_price) * 100)
                     : null,
      offdelay:    0,
    });
  } catch (err) {
    console.error('[machines_fw/config]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── GET /api/machines/:mid/tags ────────────────────────────────────────────

router.get('/:mid/tags', async (req, res) => {
  const mid = parseInt(req.params.mid);
  if (isNaN(mid)) return res.status(400).json({ error: 'Ungültige Machine-ID' });

  try {
    const tags = await db.query(Q.getFirmwareMachineTags, [mid]);

    res.json(tags.map(t => ({
      tid:   Number(t.tid),
      uid:   Number(t.uid),
      name:  t.name,
      start: Number(t.start),
      end:   Number(t.end),
    })));
  } catch (err) {
    console.error('[machines_fw/tags]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── POST /api/logs ─────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  // Wird als /api/logs gemountet, daher root-Handler
  res.status(404).end();
});

module.exports = router;

// Separater Export für /api/logs
module.exports.logsRouter = (() => {
  const r = express.Router();

  r.post('/', async (req, res) => {
    const { timestamp, mid, eid, tid, remarks } = req.body;

    if (!mid || !eid) {
      return res.status(400).json({ error: 'mid und eid erforderlich' });
    }

    try {
      const machineId = parseInt(mid);
      const eventId   = parseInt(eid);
      const tagId     = tid ? parseInt(tid) : null;

      // Maschine muss existieren
      const machine = await db.queryOne(Q.getFirmwareMachineConfig, [machineId]);
      if (!machine) return res.status(404).json({ error: 'Maschine nicht gefunden' });

      // Tag-Logs: tid ist rights.id → echte tag_id nachschlagen
      if (tagId) {
        const right = await db.queryOne(Q.getRightById, [tagId]);
        const realTagId = right ? right.tag_id : tagId;
        await logService.insertLogIgnore(machineId, realTagId, eventId, timestamp || null);

        // Display: aktive Session tracken (eid 4=login, 5=logout)
        if (eventId === 4) {
          const userRow = await db.queryOne(Q.getUserNameByTagId, [Number(realTagId)]);
          sessionStart(machineId, machine.name, userRow ? userRow.name : 'Unbekannt');
        } else if (eventId === 5) {
          sessionEnd(machineId);
        }
      } else {
        // Event ohne Tag (z.B. Fehler-Events) — tag_id ist NOT NULL, überspringen
        console.log(`[machines_fw/logs] Event ohne Tag: mid=${machineId} eid=${eventId} remarks=${remarks}`);
      }

      res.send('200 OK');
    } catch (err) {
      console.error('[machines_fw/logs]', err.message);
      res.status(500).send('500 Error');
    }
  });

  return r;
})();
