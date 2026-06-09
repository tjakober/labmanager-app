'use strict';

const express       = require('express');
const jwt           = require('jsonwebtoken');
const db            = require('../db/pool');
const Q             = require('../db/queries');
const calendarSync  = require('../services/calendarSync');
const mailService   = require('../services/mailService');
const slackService  = require('../services/slackService');
const cfg           = require('../config');
const { sessionAuth, requireRole } = require('../middleware/sessionAuth');

const router = express.Router();

// ── Substitution token helpers ─────────────────────────────────────────────────
// Signed JWT embedded in confirm/reject email links (48 h TTL, no DB state needed)

function signSubToken(assignmentId, candidateId) {
  return jwt.sign(
    { type: 'substitution', assignment_id: assignmentId, candidate_id: candidateId },
    cfg.jwt.secret,
    { expiresIn: '48h' }
  );
}

function verifySubToken(token) {
  const payload = jwt.verify(token, cfg.jwt.secret);
  if (payload.type !== 'substitution') throw new Error('Ungültiger Token-Typ');
  return payload;
}

// ── Schedules ──────────────────────────────────────────────────────────────────

/**
 * GET /api/assignments/schedules
 * Wöchentliche Öffnungszeiten.
 */
router.get('/schedules', sessionAuth, async (req, res) => {
  try {
    const schedules = await db.query(Q.getSchedules);
    res.json({ schedules });
  } catch (err) {
    console.error('[assignments/schedules]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PUT /api/assignments/schedules/:weekday  (0=Mo … 6=So)
 * Body: { open_time, close_time } | {} (leerer Body = Tag löschen)
 */
router.put('/schedules/:weekday', sessionAuth, requireRole('admin'), async (req, res) => {
  const weekday = parseInt(req.params.weekday);
  if (weekday < 0 || weekday > 6) return res.status(400).json({ error: 'weekday muss 0–6 sein' });

  const { open_time, close_time } = req.body;

  try {
    if (!open_time || !close_time) {
      await db.query(Q.deleteSchedule, [weekday]);
      return res.json({ ok: true, deleted: true });
    }
    await db.query(Q.upsertSchedule, [weekday, open_time, close_time]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[assignments/schedules PUT]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── Preferences ────────────────────────────────────────────────────────────────

/**
 * GET /api/assignments/preferences
 * Eigene Einsatzpräferenzen.
 */
router.get('/preferences', sessionAuth, async (req, res) => {
  try {
    const prefs = await db.queryOne(Q.getLmPreferences, [req.user.id]);
    res.json({ preferences: prefs || null });
  } catch (err) {
    console.error('[assignments/preferences]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PUT /api/assignments/preferences
 * Body: { weekday?, priority?, max_per_month }
 */
router.put('/preferences', sessionAuth, requireRole('admin', 'labmanager'), async (req, res) => {
  const { weekday = null, priority = 5, max_per_month = 4 } = req.body;
  try {
    await db.query(Q.upsertLmPreferences, [req.user.id, weekday, priority, max_per_month]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[assignments/preferences PUT]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── Substitution confirm / reject (unauthenticated – email link) ──────────────

/**
 * GET /api/assignments/substitute/confirm/:token
 */
router.get('/substitute/confirm/:token', async (req, res) => {
  try {
    const { assignment_id, candidate_id } = verifySubToken(req.params.token);
    await _applySubstitution(assignment_id, candidate_id);
    res.send('Danke! Deine Vertretung wurde bestätigt. Du kannst dieses Fenster schliessen.');
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(410).send('Dieser Link ist abgelaufen (48 h). Bitte melde dich direkt im Team.');
    }
    console.error('[assignments/substitute/confirm]', err.message);
    res.status(400).send(`Fehler: ${err.message}`);
  }
});

/**
 * GET /api/assignments/substitute/reject/:token
 */
router.get('/substitute/reject/:token', async (req, res) => {
  try {
    const { assignment_id } = verifySubToken(req.params.token);
    const assignment = await db.queryOne(Q.getAssignmentById, [assignment_id]);
    if (!assignment) return res.status(404).send('Einsatz nicht gefunden.');

    // Try to find the next candidate and send them a request
    const found = await _findAndRequestSubstitute(assignment, /* exclude */ []);
    if (found) {
      res.send('Verstanden. Wir suchen weiter nach einer Vertretung.');
    } else {
      await mailService.sendSubstitutionFailed(assignment).catch(() => {});
      res.send('Verstanden. Leider konnte keine Vertretung gefunden werden. Das Team wird informiert.');
    }
  } catch (err) {
    console.error('[assignments/substitute/reject]', err.message);
    res.status(400).send(`Fehler: ${err.message}`);
  }
});

// ── Assignment CRUD ────────────────────────────────────────────────────────────

/**
 * GET /api/assignments
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD  (default: current week)
 */
router.get('/', sessionAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from  = req.query.from || today;
  const to    = req.query.to   || _addDays(today, 13);

  try {
    const assignments = await db.query(Q.getAssignments, [from, to]);
    res.json({ assignments });
  } catch (err) {
    console.error('[assignments GET]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/assignments/generate
 * Auto-generate assignments for a date range (Modul A.2).
 * Body: { from, to }
 */
router.post('/generate', sessionAuth, requireRole('admin', 'labmanager'), async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from und to erforderlich (YYYY-MM-DD)' });

  try {
    const created = await _generateAssignments(from, to);
    res.status(201).json({ ok: true, created: created.length, assignments: created });
  } catch (err) {
    console.error('[assignments/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/assignments
 * Manuell einen Einsatz anlegen.
 * Body: { user_id, date, start_time?, end_time? }
 */
router.post('/', sessionAuth, requireRole('admin', 'labmanager'), async (req, res) => {
  const { user_id, date, start_time = null, end_time = null } = req.body;
  if (!user_id || !date) return res.status(400).json({ error: 'user_id und date erforderlich' });

  try {
    const result = await db.query(Q.insertAssignment, [user_id, date, start_time, end_time]);
    const assignmentId = Number(result.insertId);
    const assignment   = await db.queryOne(Q.getAssignmentById, [assignmentId]);

    // Google Calendar
    const gcalId = await calendarSync.createAssignmentEvent(assignment).catch(err => {
      console.error('[assignments POST] GCal:', err.message);
      return null;
    });
    if (gcalId) await db.query(Q.updateAssignmentGcal, [gcalId, assignmentId]);

    res.status(201).json({ ok: true, assignment: { ...assignment, gcal_event_id: gcalId } });
  } catch (err) {
    console.error('[assignments POST]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/assignments/:id
 */
router.get('/:id', sessionAuth, async (req, res) => {
  try {
    const assignment = await db.queryOne(Q.getAssignmentById, [parseInt(req.params.id)]);
    if (!assignment) return res.status(404).json({ error: 'Einsatz nicht gefunden' });

    const substitution = await db.queryOne(Q.getSubstitutionByAssignment, [assignment.id]);
    res.json({ assignment, substitution: substitution || null });
  } catch (err) {
    console.error('[assignments/:id]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PUT /api/assignments/:id
 * Drag-and-drop: Datum/Zeit/Person ändern (Modul A.2).
 * Body: { user_id?, date?, start_time?, end_time? }
 */
router.put('/:id', sessionAuth, requireRole('admin', 'labmanager'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const current = await db.queryOne(Q.getAssignmentById, [id]);
    if (!current) return res.status(404).json({ error: 'Einsatz nicht gefunden' });

    const user_id    = req.body.user_id    ?? current.user_id;
    const date       = req.body.date       ?? current.date;
    const start_time = req.body.start_time ?? current.start_time;
    const end_time   = req.body.end_time   ?? current.end_time;

    await db.query(Q.updateAssignment, [date, start_time, end_time, user_id, id]);

    const updated = await db.queryOne(Q.getAssignmentById, [id]);

    // Sync Google Calendar
    if (current.gcal_event_id) {
      await calendarSync.updateAssignmentEvent(current.gcal_event_id, updated).catch(err =>
        console.error('[assignments PUT] GCal:', err.message)
      );
    }

    res.json({ ok: true, assignment: updated });
  } catch (err) {
    console.error('[assignments/:id PUT]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * DELETE /api/assignments/:id
 * Einsatz absagen.
 */
router.delete('/:id', sessionAuth, requireRole('admin', 'labmanager'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const assignment = await db.queryOne(Q.getAssignmentById, [id]);
    if (!assignment) return res.status(404).json({ error: 'Einsatz nicht gefunden' });

    await db.query(Q.cancelAssignment, [id]);

    if (assignment.gcal_event_id) {
      await calendarSync.deleteAssignmentEvent(assignment.gcal_event_id).catch(err =>
        console.error('[assignments DELETE] GCal:', err.message)
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[assignments/:id DELETE]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/assignments/:id/substitute
 * Labmanager meldet Verhinderung – System sucht Ersatz und schickt Anfrage-Mail (Modul A.4).
 */
router.post('/:id/substitute', sessionAuth, requireRole('admin', 'labmanager'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const assignment = await db.queryOne(Q.getAssignmentById, [id]);
    if (!assignment) return res.status(404).json({ error: 'Einsatz nicht gefunden' });

    if (assignment.status === 'cancelled') {
      return res.status(409).json({ error: 'Einsatz bereits abgesagt' });
    }

    const found = await _findAndRequestSubstitute(assignment, [assignment.user_id]);
    if (!found) {
      await mailService.sendSubstitutionFailed({
        ...assignment,
        original_name:  assignment.user_name,
        original_email: assignment.user_email,
      }).catch(() => {});
      return res.status(422).json({ error: 'Keine verfügbare Vertretung gefunden' });
    }

    res.json({ ok: true, message: 'Vertretungsanfrage verschickt' });
  } catch (err) {
    console.error('[assignments/:id/substitute]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── Private helpers ────────────────────────────────────────────────────────────

function _addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function _weekday(dateStr) {
  // Returns 0=Mon … 6=Sun (matching the schedules table)
  const d = new Date(dateStr);
  return (d.getDay() + 6) % 7;
}

function _yearMonth(dateStr) {
  return dateStr.slice(0, 7); // 'YYYY-MM'
}

/**
 * Auto-generate assignments for every open day in [from, to].
 * Algorithm: sort labmanagers by (monthly count asc, priority asc), skip busy/maxed.
 */
async function _generateAssignments(from, to) {
  const schedules  = await db.query(Q.getSchedules);
  const openDays   = new Set(schedules.map(s => s.weekday));
  const labmanagers = await db.query(Q.getLabmanagers);

  if (!labmanagers.length) throw new Error('Keine aktiven Labmanager gefunden');

  const created = [];
  let cursor = from;

  while (cursor <= to) {
    const dow = _weekday(cursor);

    if (openDays.has(dow)) {
      const sched = schedules.find(s => s.weekday === dow);

      // Load monthly counts fresh each day (previous days affect counts)
      const counts = await db.query(Q.getMonthlyAssignmentCounts, [_yearMonth(cursor)]);
      const countMap = Object.fromEntries(counts.map(c => [c.user_id, Number(c.count)]));

      // Find best available candidate
      const sorted = [...labmanagers].sort((a, b) => {
        const ca = countMap[a.id] || 0;
        const cb = countMap[b.id] || 0;
        if (ca !== cb) return ca - cb;          // fewer assignments first
        return a.priority - b.priority;         // lower number = higher priority
      });

      let assigned = false;
      for (const lm of sorted) {
        const monthly = countMap[lm.id] || 0;
        if (monthly >= lm.max_per_month) continue;

        // Skip if preferred weekday is set but doesn't match
        if (lm.preferred_weekday != null && lm.preferred_weekday !== dow) continue;

        // Skip if already assigned that day
        const busy = await db.queryOne(Q.getAssignmentOnDate, [lm.id, cursor]);
        if (busy) continue;

        const result = await db.query(Q.insertAssignment, [
          lm.id, cursor, sched?.open_time || null, sched?.close_time || null,
        ]);
        const assignmentId = Number(result.insertId);
        const assignment   = await db.queryOne(Q.getAssignmentById, [assignmentId]);

        const gcalId = await calendarSync.createAssignmentEvent(assignment).catch(err => {
          console.error('[generate] GCal:', err.message);
          return null;
        });
        if (gcalId) await db.query(Q.updateAssignmentGcal, [gcalId, assignmentId]);

        created.push({ ...assignment, gcal_event_id: gcalId });
        assigned = true;
        break;
      }

      if (!assigned) {
        console.warn(`[assignments/generate] Kein Labmanager verfügbar für ${cursor}`);
      }
    }

    cursor = _addDays(cursor, 1);
  }

  return created;
}

/**
 * Finds the best available substitute, sends the request email, and returns true on success.
 * excludeIds: user IDs to skip (e.g. the original labmanager).
 */
async function _findAndRequestSubstitute(assignment, excludeIds = []) {
  const labmanagers = await db.query(Q.getLabmanagers);
  const counts      = await db.query(Q.getMonthlyAssignmentCounts, [
    assignment.date.toISOString ? assignment.date.toISOString().slice(0, 7) : String(assignment.date).slice(0, 7),
  ]);
  const countMap = Object.fromEntries(counts.map(c => [c.user_id, Number(c.count)]));

  const candidates = labmanagers
    .filter(lm => !excludeIds.includes(lm.id))
    .filter(lm => (countMap[lm.id] || 0) < lm.max_per_month)
    .sort((a, b) => (countMap[a.id] || 0) - (countMap[b.id] || 0));

  for (const candidate of candidates) {
    const busy = await db.queryOne(Q.getAssignmentOnDate, [candidate.id, assignment.date]);
    if (busy) continue;

    const token      = signSubToken(assignment.id, candidate.id);
    const base       = cfg.app.baseUrl;
    const confirmUrl = `${base}/api/assignments/substitute/confirm/${token}`;
    const rejectUrl  = `${base}/api/assignments/substitute/reject/${token}`;

    await mailService.sendSubstitutionRequest(
      {
        ...assignment,
        original_name: assignment.user_name,
      },
      { name: candidate.name, email: candidate.email },
      confirmUrl,
      rejectUrl
    ).catch(err => console.error('[substitute] Mail:', err.message));

    return true;
  }

  return false;
}

async function _applySubstitution(assignmentId, substituteId) {
  const assignment = await db.queryOne(Q.getAssignmentById, [assignmentId]);
  if (!assignment) throw new Error('Einsatz nicht gefunden');
  if (assignment.status === 'cancelled') throw new Error('Einsatz wurde bereits abgesagt');

  const substitute = await db.queryOne('SELECT id, name, email FROM users WHERE id = ?', [substituteId]);
  if (!substitute) throw new Error('Vertretung nicht gefunden');

  // Record substitution, then update assignment to new user
  await db.query(Q.insertSubstitution, [assignmentId, substituteId]);
  await db.query(Q.updateAssignment, [
    assignment.date, assignment.start_time, assignment.end_time, substituteId, assignmentId,
  ]);

  // Update Google Calendar event
  const updated = await db.queryOne(Q.getAssignmentById, [assignmentId]);
  if (assignment.gcal_event_id) {
    await calendarSync.updateAssignmentEvent(assignment.gcal_event_id, updated).catch(err =>
      console.error('[substitute/confirm] GCal:', err.message)
    );
  }

  // Notify original labmanager + Slack
  await Promise.all([
    mailService.sendSubstitutionConfirmed(
      { ...assignment, original_name: assignment.user_name, original_email: assignment.user_email },
      substitute
    ),
    slackService.notifySubstitution(assignment.user_name, substitute.name, assignment.date),
  ]).catch(err => console.error('[substitute/confirm] Notify:', err.message));
}

module.exports = router;
