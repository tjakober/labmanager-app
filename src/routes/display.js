'use strict';

const express = require('express');
const db      = require('../db/pool');
const Q       = require('../db/queries');
const path    = require('path');

const router  = express.Router();
const clients = new Set();

// machineId → { machineName, userName, loginAt }
const activeSessions = new Map();

/**
 * GET /display
 */
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/display.html'));
});

/**
 * GET /api/display/schedule
 * Returns the next n assignments with skills – single query, no N+1.
 */
router.get('/schedule', async (req, res) => {
  const n = Math.min(parseInt(req.query.n || '5', 10), 50);

  try {
    const rows = await db.query(Q.getUpcomingAssignments, [n]);

    const assignments = rows.map(row => ({
      id:       row.id,
      date:     row.date,
      start_time: row.start_time,
      end_time:   row.end_time,
      name:     row.name,
      user_id:  row.user_id,
      photo_id: row.photo_id,
      skills:   row.skills_csv ? row.skills_csv.split(',') : [],
    }));

    return res.json({ assignments });

  } catch (err) {
    console.error('[display/schedule]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/display/events
 * Server-Sent Events stream for real-time display updates.
 */
router.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

/**
 * GET /api/display/sessions
 * Returns currently active machine sessions (for display page reload).
 */
router.get('/sessions', (req, res) => {
  res.json({ sessions: Array.from(activeSessions.values()) });
});

function notifyDisplayClients(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function sessionStart(machineId, machineName, userName) {
  const session = { machineId, machineName, userName, loginAt: Date.now() };
  activeSessions.set(machineId, session);
  notifyDisplayClients({ session_start: session });
}

function sessionEnd(machineId) {
  activeSessions.delete(machineId);
  notifyDisplayClients({ session_end: { machineId } });
}

module.exports = { router, notifyDisplayClients, sessionStart, sessionEnd };
