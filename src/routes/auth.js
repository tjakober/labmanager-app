'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const db       = require('../db/pool');
const Q        = require('../db/queries');
const cfg      = require('../config');
const mail     = require('../services/mailService');
const { sessionAuth } = require('../middleware/sessionAuth');

const router = express.Router();

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Antwort: { token, user: { id, name, roles } }
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
  }

  try {
    // Benutzer laden
    const user = await db.queryOne(
      `SELECT u.id, u.name, u.email, u.password_hash
       FROM users u
       WHERE u.email = ? AND u.active = 1`,
      [email]
    );

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    // Passwort prüfen
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    // Rollen laden
    const roleRows = await db.query(
      `SELECT r.name FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?`,
      [user.id]
    );
    const roles = roleRows.map(r => r.name);

    // JWT ausstellen
    const payload = { id: user.id, name: user.name, roles };
    const token   = jwt.sign(payload, cfg.jwt.secret, { expiresIn: cfg.jwt.expiresIn });

    return res.json({ token, user: payload });

  } catch (err) {
    console.error('[auth/login]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/auth/reset-request
 * Body: { email }
 * Schickt einen Reset-Link per E-Mail. Antwortet immer 200 (kein User-Enumeration).
 */
router.post('/reset-request', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich' });

  try {
    const user = await db.queryOne(Q.getUserByEmailForReset, [email]);

    if (user && user.active) {
      const token     = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      await db.query(Q.insertPasswordReset, [user.id, tokenHash]);

      const resetUrl = `${cfg.app.baseUrl}/?reset=${token}`;
      try {
        await mail.send({
          to:      user.email,
          subject: 'FabLab Winti – Passwort zurücksetzen',
          text:    `Hallo ${user.name},\n\nKlicke auf folgenden Link um dein Passwort zurückzusetzen (gültig 2 Stunden):\n\n${resetUrl}\n\nFalls du kein Passwort-Reset angefordert hast, ignoriere diese E-Mail.`,
          html:    `<p>Hallo ${user.name},</p><p>Klicke auf folgenden Link um dein Passwort zurückzusetzen (gültig 2 Stunden):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Falls du kein Passwort-Reset angefordert hast, ignoriere diese E-Mail.</p>`,
        });
      } catch (mailErr) {
        console.warn('[auth/reset-request] Mail-Versand fehlgeschlagen:', mailErr.message);
        console.info('[auth/reset-request] Reset-URL:', resetUrl);
      }
    }

    // Immer 200 – kein Hinweis ob E-Mail existiert
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/reset-request]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/auth/reset-confirm
 * Body: { token, password }
 * Setzt das neue Passwort.
 */
router.post('/reset-confirm', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token und Passwort erforderlich' });
  if (password.length < 8)  return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const reset     = await db.queryOne(Q.getPasswordReset, [tokenHash]);

    if (!reset || reset.used || new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Link ungültig oder abgelaufen' });
    }

    const hash = await bcrypt.hash(password, 12);
    await db.query(Q.updateUserPassword, [hash, reset.user_id]);
    await db.query(Q.markPasswordResetUsed, [reset.id]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/reset-confirm]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/auth/badge-login
 * Body: { badge_uid }
 * Loggt einen User per Badge-UID ein (nur wenn badge_login_enabled = 1).
 */
router.post('/badge-login', async (req, res) => {
  const { badge_uid, password } = req.body;
  if (!badge_uid) return res.status(400).json({ error: 'badge_uid erforderlich' });

  try {
    const uid  = Number(badge_uid);
    if (!Number.isFinite(uid)) return res.status(400).json({ error: 'Ungültige Badge-UID' });

    const user = await db.queryOne(Q.getUserByTagUid, [uid]);
    if (!user) {
      return res.status(401).json({ error: 'Badge unbekannt' });
    }

    if (!user.badge_login_enabled) {
      if (!password) {
        return res.status(401).json({ error: 'Passwort erforderlich', error_code: 'BADGE_LOGIN_DISABLED' });
      }
      if (!user.password_hash) {
        return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    const roleRows = await db.query(Q.getRolesByUserId, [user.id]);
    const roles    = roleRows.map(r => r.name);
    const payload  = { id: Number(user.id), name: user.name, roles };
    const token    = jwt.sign(payload, cfg.jwt.secret, { expiresIn: cfg.jwt.expiresIn });

    return res.json({ token, user: payload });
  } catch (err) {
    console.error('[auth/badge-login]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/auth/badge-login-status
 * Gibt zurück ob Badge-Login für den eingeloggten User aktiv ist.
 */
router.get('/badge-login-status', sessionAuth, async (req, res) => {
  try {
    const row = await db.queryOne('SELECT badge_login_enabled FROM users WHERE id = ?', [req.user.id]);
    res.json({ badge_login_enabled: !!(row && row.badge_login_enabled) });
  } catch (err) {
    console.error('[auth/badge-login-status]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PUT /api/auth/badge-login-toggle
 * Body: { enabled: true/false }
 * Aktiviert/deaktiviert Badge-Login für den eingeloggten User.
 */
router.put('/badge-login-toggle', sessionAuth, async (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  try {
    await db.query(Q.setBadgeLoginEnabled, [enabled, req.user.id]);
    res.json({ ok: true, badge_login_enabled: !!enabled });
  } catch (err) {
    console.error('[auth/badge-login-toggle]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

module.exports = router;
