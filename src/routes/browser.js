'use strict';

const express        = require('express');
const bcrypt         = require('bcrypt');
const db             = require('../db/pool');
const Q              = require('../db/queries');
const billingService  = require('../services/billingService');
const balanceService  = require('../services/balanceService');
const weblingService  = require('../services/weblingService');
const calendarSync    = require('../services/calendarSync');
const configService   = require('../services/configService');
const { sessionAuth, requireRole } = require('../middleware/sessionAuth');

const router = express.Router();

// ── Google OAuth2 (unauthenticated – browser redirect flow) ───────────────────

router.get('/google/auth', (req, res) => {
  res.redirect(calendarSync.getAuthUrl());
});

router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.status(400).send(`Google OAuth2 Fehler: ${error || 'kein Code'}`);
  }
  try {
    await calendarSync.handleAuthCallback(code);
    res.send('Google Calendar autorisiert. Du kannst dieses Fenster schliessen.');
  } catch (err) {
    res.status(500).send(`Token-Austausch fehlgeschlagen: ${err.message}`);
  }
});

// ── All routes below require a valid JWT ──────────────────────────────────────

router.use(sessionAuth);

// ── Self ───────────────────────────────────────────────────────────────────────

/**
 * GET /api/browser/me
 */
router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

/**
 * POST /api/browser/me/password
 * Body: { current_password, new_password }
 */
router.post('/me/password', async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password und new_password erforderlich' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben' });
  }

  try {
    const user = await db.queryOne(
      'SELECT password_hash FROM users WHERE id = ?', [req.user.id]
    );
    if (!user || !await bcrypt.compare(current_password, user.password_hash)) {
      return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
    }
    const hash = await bcrypt.hash(new_password, 12);
    await db.query(Q.updateMemberPassword, [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/me/password]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── Members ────────────────────────────────────────────────────────────────────

/**
 * POST /api/browser/members
 * Neues Mitglied anlegen.
 * Body: { name, email, password, roles: ['member'|'labmanager'|'admin'] }
 */
router.post('/members', requireRole('admin'), async (req, res) => {
  const { name, email, password, roles = ['member'] } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email und password erforderlich' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben' });
  }
  const validRoles = ['member', 'labmanager', 'admin'];
  const assignRoles = roles.filter(r => validRoles.includes(r));
  if (assignRoles.length === 0) assignRoles.push('member');

  try {
    const existing = await db.queryOne(Q.checkEmailExists, [email]);
    if (existing) return res.status(409).json({ error: 'E-Mail bereits vergeben' });

    const hash   = await bcrypt.hash(password, 12);
    const result = await db.query(Q.insertMember, [name, email, hash]);
    const uid    = Number(result.insertId);

    for (const role of assignRoles) {
      await db.query(Q.insertMemberRole, [uid, role]);
    }

    const member = await db.queryOne(Q.getMemberById, [uid]);
    res.status(201).json({
      ...member,
      roles:     member.roles ? member.roles.split(',') : [],
      knowledge: [],
    });
  } catch (err) {
    console.error('[browser/members POST]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members/summary
 * Mitglieder-Statistik: Anzahl pro Status + davon in Webling
 */
router.get('/members/summary', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    const rows = await db.query(Q.getMembersSummary);
    const by_status = rows.map(r => ({
      status:     r.status,
      total:      Number(r.total),
      in_webling: Number(r.in_webling),
    }));
    const total     = by_status.reduce((s, r) => s + r.total,      0);
    const inWebling = by_status.reduce((s, r) => s + r.in_webling, 0);
    res.json({ total, in_webling: inWebling, by_status });
  } catch (err) {
    console.error('[browser/members/summary]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members
 * Query: ?search=&role=&active=&limit=50&offset=0
 * Roles: admin, labmanager
 */
router.get('/members', requireRole('admin', 'labmanager'), async (req, res) => {
  const search = req.query.search ? `%${req.query.search}%` : null;
  const role   = req.query.role   || null;
  const active = req.query.active != null ? Number(req.query.active) : null;
  const limit  = Math.min(parseInt(req.query.limit  || '50'),  200);
  const offset = parseInt(req.query.offset || '0');

  try {
    // Named placeholders require mariadb namedPlaceholders option –
    // fall back to a dynamic query build to stay compatible with the pool config.
    let sql = `
      SELECT u.id, u.name, u.email, u.active, u.webling_id,
             GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ',') AS roles
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r       ON r.id = ur.role_id
      WHERE 1=1`;
    const params = [];

    if (search) {
      // numeric search → match tag UID exactly
      const tagUid = /^\d+$/.test(req.query.search) ? req.query.search : null;
      if (tagUid) {
        sql += ' AND u.id IN (SELECT user_id FROM tags WHERE id = ? AND blocked = 0)';
        params.push(tagUid);
      } else {
        sql += ' AND (u.name LIKE ? OR u.email LIKE ?)';
        params.push(search, search);
      }
    }
    if (active != null) { sql += ' AND u.active = ?'; params.push(active); }
    if (role)   { sql += ' AND r.name = ?'; params.push(role); }

    sql += ' GROUP BY u.id ORDER BY u.name ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const members = await db.query(sql, params);
    res.json({ members: members.map(m => ({ ...m, roles: m.roles ? m.roles.split(',') : [] })) });
  } catch (err) {
    console.error('[browser/members]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members/:id
 * Admin/Labmanager sehen alle; Mitglied nur sich selbst.
 */
router.get('/members/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const isOwn = req.user.id === id;
  const isPrivileged = req.user.roles.some(r => ['admin', 'labmanager'].includes(r));

  if (!isOwn && !isPrivileged) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }

  try {
    const member = await db.queryOne(Q.getMemberById, [id]);
    if (!member) return res.status(404).json({ error: 'Mitglied nicht gefunden' });
    const knowledge = await db.query(Q.getMemberKnowledge, [id]);

    // Parse webling_meta for address/contact/status fields (labmanager/admin only)
    let webling = null;
    if (isPrivileged && member.webling_meta) {
      try {
        const meta = JSON.parse(member.webling_meta);
        const p = meta.properties || {};
        webling = {
          status:         p['Status']         || null,
          strasse:        p['Strasse']         || null,
          adresszusatz:   p['Adresszusatz']    || null,
          plz:            p['PLZ']             || null,
          ort:            p['Ort']             || null,
          telefon:        p['Telefon P']       || null,
          mobile:         p['Mobile P']        || null,
          firma:          p['Firma']           || null,
          anrede:         p['Anrede']          || null,
          geburtsdatum:   p['Geburtsdatum']    || null,
          funktion:       p['Funktion']        || null,
          eintrittsdatum: p['Eintrittsdatum']  || null,
          austrittsdatum: p['Austrittsdatum']  || null,
          bemerkungen:    p['Bemerkungen']     || null,
          mitglieder_id:  p['Mitglieder ID'] != null ? Number(p['Mitglieder ID']) : null,
        };
      } catch { /* ignore malformed meta */ }
    }

    res.json({
      ...member,
      webling_meta: undefined,
      roles:     member.roles ? member.roles.split(',') : [],
      knowledge,
      webling,
    });
  } catch (err) {
    console.error('[browser/members/:id]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PATCH /api/browser/members/:id/status
 * Body: { status }
 * Ändert membership_status lokal + Auto-Push zu Webling wenn Antrag oder Mitglied*.
 */
router.patch('/members/:id/status', async (req, res) => {
  if (!req.user.roles.some(r => ['admin', 'labmanager'].includes(r))) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  const id     = parseInt(req.params.id);
  const status = (req.body.status || '').trim();
  if (!status) return res.status(400).json({ error: 'Status erforderlich' });

  try {
    await db.query(Q.updateMemberStatus, [status, id]);

    // Auto-Push zu Webling wenn Status Antrag oder Mitglied*
    const member = await db.queryOne(Q.getMemberById, [id]);
    let pushed = false;
    const sl = status.toLowerCase();
    const shouldPush = sl === 'antrag' || sl.startsWith('mitglied') || sl === 'ausgeschlossen';
    if (shouldPush && member.webling_id) {
      try {
        await weblingService.updateMemberFields(member.webling_id, { Status: status });
      } catch (pushErr) {
        const body = JSON.stringify(pushErr.response?.data);
        console.error(`[status/webling-push] HTTP ${pushErr.response?.status} body=${body}`);
        throw pushErr;
      }
      await _appendMembershipHistory(member.webling_id, status);
      pushed = true;
    } else if (shouldPush && !member.webling_id) {
      const newWeblingId = await _pushMemberToWebling(member, status);
      if (newWeblingId) await _appendMembershipHistory(newWeblingId, status);
      pushed = !!newWeblingId;
    }

    res.json({ ok: true, membership_status: status, pushed });
  } catch (err) {
    console.error('[browser/members/:id/status]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/members/:id/webling-push
 * Manueller Push der Adresse zu Webling (erstellt neuen Webling-Eintrag oder aktualisiert Status).
 */
router.post('/members/:id/webling-push', async (req, res) => {
  if (!req.user.roles.some(r => ['admin', 'labmanager'].includes(r))) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  const id = parseInt(req.params.id);
  try {
    const member = await db.queryOne(Q.getMemberById, [id]);
    if (!member) return res.status(404).json({ error: 'Mitglied nicht gefunden' });

    if (member.webling_id) {
      // Bereits in Webling: nur Status aktualisieren
      await weblingService.updateMemberFields(member.webling_id, { Status: member.membership_status || '' });
      res.json({ ok: true, action: 'updated', webling_id: member.webling_id });
    } else {
      // Neu anlegen
      const newWeblingId = await _pushMemberToWebling(member, member.membership_status);
      res.json({ ok: true, action: 'created', webling_id: newWeblingId });
    }
  } catch (err) {
    console.error('[browser/members/:id/webling-push]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * Fügt einen Mitgliedschafts-Eintrag in die Webling Membership-History ein.
 */
async function _appendMembershipHistory(weblingId, status) {
  try {
    const wMember = await weblingService.getMember(weblingId);
    const historyField = process.env.WEBLING_FIELD_UPGRADE_HISTORY || 'Membership-History';
    const raw = wMember?.properties?.[historyField];
    let history = [];
    if (raw) { try { history = JSON.parse(raw); } catch {} }
    if (!Array.isArray(history)) history = [];

    const today = new Date().toISOString().slice(0, 10);
    const sl = status.toLowerCase();
    if (sl === 'antrag') {
      history.push({ _typ: 'mitgliedschaft', bezeichnung: 'antrag', antragsDatum: today });
    } else if (sl.startsWith('mitglied')) {
      const open = [...history].reverse().find(e => e._typ === 'mitgliedschaft' && !e.eintrittsdatum && !e.kuendigDatum);
      if (open) open.eintrittsdatum = today;
      else history.push({ _typ: 'mitgliedschaft', bezeichnung: 'eintritt', eintrittsdatum: today });
    } else if (sl === 'ausgeschlossen') {
      const open = [...history].reverse().find(e => e._typ === 'mitgliedschaft' && !e.kuendigDatum);
      if (open) { open.bezeichnung = 'ausgeschlossen'; open.kuendigDatum = today; }
      else history.push({ _typ: 'mitgliedschaft', bezeichnung: 'ausgeschlossen', kuendigDatum: today });
    }

    await weblingService.updateUpgradeHistory(weblingId, history);
  } catch (err) {
    console.warn('[_appendMembershipHistory]', err.message);
  }
}

/**
 * Erstellt ein neues Webling-Mitglied aus lokalem User und setzt webling_id in DB.
 */
async function _pushMemberToWebling(member, status) {
  const nameParts = (member.name || '').trim().split(/\s+/);
  const vorname   = nameParts.slice(0, -1).join(' ') || nameParts[0] || '';
  const nachname  = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';

  const properties = {
    Vorname:        vorname,
    Name:           nachname,
    'E-Mail P':     member.email || '',
    Status:         status || '',
  };
  if (member.zynex_id) properties['Mitglieder ID'] = member.zynex_id;

  console.log('[_pushMemberToWebling] properties:', JSON.stringify(properties));
  let result;
  try {
    result = await weblingService.createMember(properties);
  } catch (err) {
    console.error('[_pushMemberToWebling] HTTP', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
  const weblingId = typeof result === 'number' ? result : (result?.id ?? result);
  if (weblingId) {
    await db.query('UPDATE users SET webling_id = ? WHERE id = ?', [weblingId, member.id]);
  }
  return weblingId;
}

/**
 * GET /api/browser/members/:id/balance
 */
router.get('/members/:id/balance', async (req, res) => {
  const id = parseInt(req.params.id);
  if (req.user.id !== id && !req.user.roles.some(r => ['admin', 'labmanager'].includes(r))) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  try {
    const balance = await balanceService.getBalance(id);
    res.json({ member_id: id, balance });
  } catch (err) {
    console.error('[browser/members/:id/balance]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/gift-accounts
 * Gibt konfigurierte Schenkungskonti zurück, gefiltert auf Konti die der eingeloggte
 * User verwenden darf (Fachgruppen-Einschränkung).
 */
router.get('/gift-accounts', async (req, res) => {
  if (!req.user.roles.some(r => ['admin', 'labmanager'].includes(r))) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  try {
    const rawAccounts = await configService.get('balance.gift_accounts');
    let allAccounts = [];
    if (Array.isArray(rawAccounts)) allAccounts = rawAccounts;
    else if (typeof rawAccounts === 'string') { try { allAccounts = JSON.parse(rawAccounts); } catch {} }
    if (!allAccounts.length) return res.json({ accounts: [] });

    // Fachgruppen des eingeloggten Users laden
    const userFachgruppen = await db.query(
      `SELECT f.beschreibung FROM fachgruppen f
       JOIN user_fachgruppen uf ON uf.fachgruppe_id = f.id
       WHERE uf.user_id = ?`, [req.user.id]
    );
    const userFgNames = userFachgruppen.map(f => (f.beschreibung || '').toLowerCase());

    // Konti ohne Einschränkung oder wenn User in der Fachgruppe ist
    const allowed = allAccounts.filter(a => {
      if (!a.fachgruppe) return true;
      return userFgNames.some(fg => fg.includes(a.fachgruppe.toLowerCase()));
    });

    res.json({ accounts: allowed });
  } catch (err) {
    console.error('[browser/gift-accounts]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/members/:id/balance/gift
 * Body: { konto_nr, amount, bezeichnung }
 * Guthaben-Schenkung: Buchung von konfiguriertem Konto → Guthabenkonto + Saldo-Update.
 */
router.post('/members/:id/balance/gift', async (req, res) => {
  if (!req.user.roles.some(r => ['admin', 'labmanager'].includes(r))) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  const memberId = parseInt(req.params.id);
  const { konto_nr, amount, bezeichnung } = req.body;

  if (!konto_nr || !amount || amount <= 0) {
    return res.status(400).json({ error: 'konto_nr und amount erforderlich' });
  }

  try {
    // Prüfen ob Konto erlaubt und User berechtigt
    const rawAccounts2 = await configService.get('balance.gift_accounts');
    let allAccounts = [];
    if (Array.isArray(rawAccounts2)) allAccounts = rawAccounts2;
    else if (typeof rawAccounts2 === 'string') { try { allAccounts = JSON.parse(rawAccounts2); } catch {} }
    const account = allAccounts.find(a => a.konto_nr === String(konto_nr));
    if (!account) return res.status(400).json({ error: 'Konto nicht konfiguriert' });

    if (account.fachgruppe) {
      const userFachgruppen = await db.query(
        `SELECT f.beschreibung FROM fachgruppen f
         JOIN user_fachgruppen uf ON uf.fachgruppe_id = f.id
         WHERE uf.user_id = ?`, [req.user.id]
      );
      const inFg = userFachgruppen.some(f =>
        (f.beschreibung || '').toLowerCase().includes(account.fachgruppe.toLowerCase())
      );
      if (!inFg) return res.status(403).json({ error: 'Keine Berechtigung für dieses Konto' });
    }

    const creditKontoNr = await configService.get('balance.gift_credit_account');
    if (!creditKontoNr) return res.status(500).json({ error: 'balance.gift_credit_account nicht konfiguriert' });

    const maxDeposit = await configService.get('balance.max_deposit') || 500;
    const weblingId = (await db.queryOne(Q.getMemberById, [memberId]))?.webling_id;
    if (!weblingId) return res.status(404).json({ error: 'Mitglied hat kein Webling-Konto' });

    const currentBalance = await weblingService.getBalance(Number(weblingId));
    if (currentBalance + amount > maxDeposit) {
      return res.status(400).json({ error: `Max. Guthaben CHF ${maxDeposit} würde überschritten (aktuell: ${currentBalance})` });
    }

    const member = await db.queryOne(Q.getMemberById, [memberId]);
    const reference = `Guthaben-Schenkung ${bezeichnung || account.bezeichnung} – ${member?.name || ''}`;
    await weblingService.bookGift(Number(weblingId), amount, konto_nr, creditKontoNr, reference);

    await db.query(Q.insertBalanceTransaction,
      [memberId, 'deposit', amount, konto_nr, reference, currentBalance + amount, req.user.name || 'labmanager']);

    res.json({ ok: true, new_balance: +(currentBalance + amount).toFixed(2) });
  } catch (err) {
    console.error('[browser/members/:id/balance/gift]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members/:id/rights
 * Labmanager sehen alle Rights (inkl. abgelaufene); Members nur aktive.
 */
router.get('/members/:id/rights', async (req, res) => {
  const id = parseInt(req.params.id);
  const isOwn        = req.user.id === id;
  const isPrivileged = req.user.roles.some(r => ['admin', 'labmanager'].includes(r));
  if (!isOwn && !isPrivileged) return res.status(403).json({ error: 'Keine Berechtigung' });
  try {
    const query = isPrivileged ? Q.getMemberRightsManage : Q.getMemberRights;
    const rights = await db.query(query, [id]);
    res.json({ rights });
  } catch (err) {
    console.error('[browser/members/:id/rights]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members/:id/active-sessions
 * Aktuell laufende Maschinensessions des Mitglieds (für Member-Dashboard).
 */
router.get('/members/:id/active-sessions', async (req, res) => {
  const id = parseInt(req.params.id);
  if (req.user.id !== id && !req.user.roles.some(r => ['admin','labmanager'].includes(r))) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  try {
    const sessions = await db.query(Q.getMemberActiveSessions, [id]);
    res.json({ sessions });
  } catch (err) {
    console.error('[browser/members/:id/active-sessions]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/machines/status
 * Aktueller Belegungsstatus aller aktiven Maschinen.
 */
router.get('/machines/status', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    const IN_USE = new Set(['start', 'login', 'running', 'running1']);
    const rows   = await db.query(Q.getMachineStatus);
    const machines = rows.map(r => ({
      id:            Number(r.id),
      name:          r.name,
      in_use:        IN_USE.has(r.last_event),
      last_event:    r.last_event || null,
      session_start: r.session_start || null,
      user_name:     r.user_name    || null,
      user_id:       r.user_id      ? Number(r.user_id) : null,
      last_heartbeat: r.last_heartbeat || null,
    }));
    res.json({ machines });
  } catch (err) {
    console.error('[browser/machines/status]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/machines
 */
router.get('/machines', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    const machines = await db.query(Q.getAllMachines);
    res.json({ machines });
  } catch (err) {
    console.error('[browser/machines]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/machines
 * Body: { name, period, min_periods, min_price?, price }
 */
router.post('/machines', requireRole('admin', 'labmanager'), async (req, res) => {
  const { name, period, min_periods = 1, min_price = null, price, konto_nr = null } = req.body;
  if (!name || !period || !price) return res.status(400).json({ error: 'name, period und price erforderlich' });
  try {
    const result = await db.query(Q.insertMachine, [name, period, min_periods, min_price || null, price, konto_nr || null]);
    res.status(201).json({ ok: true, id: Number(result.insertId) });
  } catch (err) {
    console.error('[browser/machines POST]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PUT /api/browser/machines/:id
 * Body: { name, period, min_periods, min_price?, price, active }
 */
router.put('/machines/:id', requireRole('admin', 'labmanager'), async (req, res) => {
  const { name, period, min_periods = 1, min_price = null, price, konto_nr = null, active = 1 } = req.body;
  if (!name || !period || !price) return res.status(400).json({ error: 'name, period und price erforderlich' });
  try {
    await db.query(Q.updateMachine, [name, period, min_periods, min_price || null, price, konto_nr || null, active, parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/machines PUT]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── Config (admin) ─────────────────────────────────────────────────────────────

/**
 * GET /api/browser/config
 */
router.get('/config', requireRole('admin'), async (req, res) => {
  try {
    const config = await db.query(Q.getAllConfig);
    res.json({ config });
  } catch (err) {
    console.error('[browser/config]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PUT /api/browser/config/:key
 * Body: { value }
 */
router.put('/config/:key', requireRole('admin'), async (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value erforderlich' });
  try {
    await db.query(Q.setConfig, [req.params.key, String(value), req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/config PUT]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/rights/defaults
 * Liefert Standardwerte für neue Rechte (default_days aus config).
 */
router.get('/rights/defaults', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    const days = await configService.get('right.default_days') || 365;
    res.json({ default_days: Number(days) });
  } catch (err) {
    res.json({ default_days: 365 });
  }
});

/**
 * POST /api/browser/rights
 * Body: { tag_id, machine_id, valid_from?, valid_to? }
 */
router.post('/rights', requireRole('admin', 'labmanager'), async (req, res) => {
  const { tag_id, machine_id, valid_from = null, valid_to = null } = req.body;
  if (!tag_id || !machine_id) return res.status(400).json({ error: 'tag_id und machine_id erforderlich' });
  try {
    await db.query(Q.insertRight, [tag_id, machine_id, valid_from || null, valid_to || null]);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[browser/rights POST]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PUT /api/browser/rights/:id
 * Body: { valid_from?, valid_to? }
 */
router.put('/rights/:id', requireRole('admin', 'labmanager'), async (req, res) => {
  const { valid_from = null, valid_to = null } = req.body;
  try {
    await db.query(Q.updateRight, [valid_from || null, valid_to || null, parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/rights PUT]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * DELETE /api/browser/rights/:id
 */
router.delete('/rights/:id', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    await db.query(Q.deleteRight, [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/rights DELETE]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members/:id/upgrade
 */
router.get('/members/:id/upgrade', async (req, res) => {
  const id = parseInt(req.params.id);
  if (req.user.id !== id && !req.user.roles.some(r => ['admin', 'labmanager'].includes(r))) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  try {
    const history = await db.query(Q.getMemberUpgrade, [id]);
    const current = history.find(h => h.event_type === 'upgrade');
    res.json({ current: current || null, history });
  } catch (err) {
    console.error('[browser/members/:id/upgrade]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members/:id/logs
 * Query: ?limit=50&offset=0
 */
router.get('/members/:id/logs', async (req, res) => {
  const id     = parseInt(req.params.id);
  const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
  const offset = parseInt(req.query.offset || '0');

  if (req.user.id !== id && !req.user.roles.some(r => ['admin', 'labmanager'].includes(r))) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  try {
    const logs = await db.query(Q.getMemberLogs, [id, limit, offset]);
    res.json({ logs: logs.map(l => ({ ...l, id: Number(l.id), invoice_id: l.invoice_id != null ? Number(l.invoice_id) : null })) });
  } catch (err) {
    console.error('[browser/members/:id/logs]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members/:id/invoices
 * Query: ?limit=20&offset=0
 */
router.get('/members/:id/invoices', async (req, res) => {
  const id     = parseInt(req.params.id);
  const limit  = Math.min(parseInt(req.query.limit  || '20'), 100);
  const offset = parseInt(req.query.offset || '0');

  if (req.user.id !== id && !req.user.roles.some(r => ['admin', 'labmanager'].includes(r))) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  try {
    const invoices = await db.query(Q.getMemberInvoices, [id, limit, offset]);
    res.json({ invoices: invoices.map(i => ({ ...i, id: Number(i.id) })) });
  } catch (err) {
    console.error('[browser/members/:id/invoices]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── Tags / Badges (Modul Phase 4a) ────────────────────────────────────────────

/**
 * GET /api/browser/tags/:tag_id
 * Badge-Lookup für Web Serial API Flow – gibt Mitgliedsdaten zurück.
 */
router.get('/tags/:tag_id', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    const tag = await db.queryOne(Q.getTagById, [req.params.tag_id]);
    if (!tag) return res.status(404).json({ error: 'Badge nicht gefunden' });
    if (tag.blocked) return res.status(403).json({ error: 'Badge gesperrt', tag });

    res.json({
      tag_id:      tag.id,
      user_id:     tag.user_id,
      user_name:   tag.user_name,
      user_email:  tag.user_email,
      user_active: tag.user_active,
      user_roles:  tag.user_roles ? tag.user_roles.split(',') : [],
    });
  } catch (err) {
    console.error('[browser/tags/:id]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members/:id/tags
 */
router.get('/members/:id/tags', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    const tags = await db.query(Q.getTagsByMember, [parseInt(req.params.id)]);
    res.json({ tags });
  } catch (err) {
    console.error('[browser/members/:id/tags]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/members/:id/tags
 * Badge ausgeben. Body: { tag_id } (die vom NFC-Reader gelesene UID)
 */
router.post('/members/:id/tags', requireRole('admin', 'labmanager'), async (req, res) => {
  const user_id = parseInt(req.params.id);
  const { tag_id } = req.body;

  if (!tag_id) return res.status(400).json({ error: 'tag_id erforderlich' });

  try {
    const member = await db.queryOne('SELECT id FROM users WHERE id = ?', [user_id]);
    if (!member) return res.status(404).json({ error: 'Mitglied nicht gefunden' });

    // Check tag not already assigned
    const existing = await db.queryOne('SELECT id, user_id FROM tags WHERE id = ?', [tag_id]);
    if (existing) {
      return res.status(409).json({ error: 'Badge bereits vergeben', assigned_to: existing.user_id });
    }

    await db.query(
      'INSERT INTO tags (id, user_id, blocked, created_at) VALUES (?, ?, 0, NOW())',
      [tag_id, user_id]
    );
    res.status(201).json({ ok: true, tag_id, user_id });
  } catch (err) {
    console.error('[browser/members/:id/tags POST]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * DELETE /api/browser/tags/:tag_id
 * Tag löschen (nur wenn keine Logs vorhanden).
 */
router.delete('/tags/:tag_id', requireRole('admin', 'labmanager'), async (req, res) => {
  const tag_id = req.params.tag_id;
  try {
    const { n } = await db.queryOne(Q.tagHasLogs, [tag_id]);
    if (Number(n) > 0) {
      return res.status(409).json({ error: 'Tag hat Nutzungs-Logs und kann nicht gelöscht werden' });
    }
    await db.query(Q.deleteRightsByTagId, [tag_id]);
    await db.query(Q.deleteTag, [tag_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/tags DELETE]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/tags/:tag_id/block
 * Badge sperren.
 */
router.post('/tags/:tag_id/block', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    await db.query(Q.blockTag, [req.params.tag_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/tags/:id/block]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/tags/:tag_id/replace
 * Ersatz-Badge ausgeben + Depot erfassen.
 * Body: { new_tag_id }
 */
router.post('/tags/:tag_id/replace', requireRole('admin', 'labmanager'), async (req, res) => {
  const old_tag_id = req.params.tag_id;
  const { new_tag_id } = req.body;

  if (!new_tag_id) return res.status(400).json({ error: 'new_tag_id erforderlich' });

  try {
    const old = await db.queryOne('SELECT user_id FROM tags WHERE id = ?', [old_tag_id]);
    if (!old) return res.status(404).json({ error: 'Alter Badge nicht gefunden' });

    // Ersatzkarte anlegen, Originalkarte sperren + verknüpfen
    await db.query(
      'INSERT INTO tags (id, user_id, blocked, created_at) VALUES (?, ?, 0, NOW())',
      [new_tag_id, old.user_id]
    );
    await db.query(Q.setTagReplacement, [new_tag_id, old_tag_id]);

    // Rechte auf Ersatzkarte übertragen
    await db.query(
      `INSERT IGNORE INTO rights (tag_id, machine_id, valid_from, valid_to)
       SELECT ?, machine_id, valid_from, valid_to FROM rights WHERE tag_id = ?`,
      [new_tag_id, old_tag_id]
    );

    // Depot erfassen
    const depositAmount = await configService.get('tag.deposit_amount') || 20;
    await db.query(Q.insertTagDeposit, [old_tag_id, new_tag_id, old.user_id, depositAmount]);

    res.json({ ok: true, old_tag_id, new_tag_id, user_id: old.user_id, deposit: depositAmount });
  } catch (err) {
    console.error('[browser/tags/:id/replace]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/tags/:tag_id/return
 * Originalkarte gefunden und zurückgebracht.
 * tag_id = die Originalkarte (gesperrt, hat replacement_id).
 * → Originalkarte reaktivieren, Ersatzkarte freigeben, Depot zurückgeben.
 */
router.post('/tags/:tag_id/return', requireRole('admin', 'labmanager'), async (req, res) => {
  const original_tag_id = req.params.tag_id;

  try {
    const orig = await db.queryOne(
      'SELECT id, user_id, replacement_id FROM tags WHERE id = ?', [original_tag_id]
    );
    if (!orig) return res.status(404).json({ error: 'Badge nicht gefunden' });
    if (!orig.replacement_id) return res.status(400).json({ error: 'Keine Ersatzkarte verknüpft' });

    // Originalkarte reaktivieren
    await db.query(Q.reactivateOriginalTag, [original_tag_id]);

    // Ersatzkarte freigeben (kein User mehr, nicht gesperrt → Pool)
    await db.query(Q.deleteRightsByTagId, [orig.replacement_id]);
    await db.query(Q.unassignTag, [orig.replacement_id]);

    // Depot zurückgeben
    const deposit = await db.queryOne(Q.getOpenTagDeposit, [original_tag_id]);
    await db.query(Q.returnTagDeposit, [req.user.id, original_tag_id]);

    res.json({ ok: true, deposit_returned: deposit?.amount || 0 });
  } catch (err) {
    console.error('[browser/tags/:id/return]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── Billing / Invoices ─────────────────────────────────────────────────────────

/**
 * GET /api/browser/articles
 * Aktive Artikelliste + erlaubte Guthaben-Konten (für Invoice-Modal).
 * Mit ?all=1: alle inkl. inaktive (für Verwaltung).
 */
router.get('/articles', async (req, res) => {
  const isPrivileged = req.user.roles.some(r => ['admin','labmanager'].includes(r));
  try {
    const [articles, creditAccounts] = await Promise.all([
      db.query(req.query.all && isPrivileged ? Q.getAllArticles : Q.getArticles),
      isPrivileged ? configService.get('balance.credit_accounts').catch(() => []) : Promise.resolve([]),
    ]);
    // Members sehen nur käufliche Artikel (kein Guthaben-Einzahlung)
    const filtered = isPrivileged ? articles : articles.filter(a => !a.is_balance_deposit);
    res.json({ articles: filtered, creditAccounts: creditAccounts || [] });
  } catch (err) {
    console.error('[browser/articles]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/articles
 * Body: { name, price, is_balance_deposit }
 */
router.post('/articles', requireRole('admin', 'labmanager'), async (req, res) => {
  const { name, description = '', price = 0, konto_nr = null, is_balance_deposit = false } = req.body;
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  try {
    const result = await db.query(Q.insertArticle, [name, description || null, price, konto_nr || null, is_balance_deposit ? 1 : 0]);
    res.status(201).json({ ok: true, id: Number(result.insertId) });
  } catch (err) {
    console.error('[browser/articles POST]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PUT /api/browser/articles/:id
 * Body: { name, description, price, is_balance_deposit }
 */
router.put('/articles/:id', requireRole('admin', 'labmanager'), async (req, res) => {
  const { name, description = '', price = 0, konto_nr = null, is_balance_deposit = false } = req.body;
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  try {
    await db.query(Q.updateArticle, [name, description || null, price, konto_nr || null, is_balance_deposit ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/articles PUT]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PATCH /api/browser/articles/:id/toggle
 * Aktiviert / deaktiviert einen Artikel.
 */
router.patch('/articles/:id/toggle', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    const art = await db.queryOne('SELECT active FROM articles WHERE id = ?', [req.params.id]);
    if (!art) return res.status(404).json({ error: 'Artikel nicht gefunden' });
    await db.query(Q.setArticleActive, [art.active ? 0 : 1, req.params.id]);
    res.json({ ok: true, active: !art.active });
  } catch (err) {
    console.error('[browser/articles toggle]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/paymodes
 */
router.get('/paymodes', async (req, res) => {
  try {
    const paymodes = await db.query(Q.getAllPaymodes);
    res.json({ paymodes });
  } catch (err) {
    console.error('[browser/paymodes]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * PUT /api/browser/paymodes/:id
 * Buchungskonto einer Zahlungsart setzen.
 */
router.put('/paymodes/:id', requireRole('admin'), async (req, res) => {
  const { konto_nr = null } = req.body;
  try {
    await db.query(Q.updatePaymode, [konto_nr || null, parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/paymodes PUT]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/members/:id/invoice/preview
 * Vorschau: was würde eine Rechnung kosten (ohne zu schreiben)?
 */
router.get('/members/:id/invoice/preview', async (req, res) => {
  const id = parseInt(req.params.id);
  const isOwn        = req.user.id === id;
  const isPrivileged = req.user.roles.some(r => ['admin','labmanager'].includes(r));
  if (!isOwn && !isPrivileged) return res.status(403).json({ error: 'Keine Berechtigung' });
  try {
    const lines = await billingService.previewInvoice(id);
    const total = +lines.reduce((s, l) => s + l.price, 0).toFixed(2);
    res.json({ lines, total });
  } catch (err) {
    console.error('[browser/invoice/preview]', err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/browser/members/:id/invoice
 * Rechnung erstellen + PDF generieren.
 * Body: { paymode_id?, items?: [{ description, quantity, unit_price, is_balance_deposit, credit_account? }] }
 */
router.post('/members/:id/invoice', requireRole('admin', 'labmanager'), async (req, res) => {
  const userId = parseInt(req.params.id);
  const { paymode_id = null, items = [] } = req.body;

  try {
    // Process balance deposits first (before writing invoice)
    for (const item of items.filter(i => i.is_balance_deposit)) {
      const result = await balanceService.deposit(
        userId, item.unit_price, item.credit_account, 'Guthaben einzahlen via Rechnung', req.user.name
      );
      if (!result.ok) {
        return res.status(400).json({ error: `Guthabeneinzahlung fehlgeschlagen: ${result.error_code}` });
      }
    }

    const { invoiceId, total, lines } = await billingService.createInvoice(userId, paymode_id, items, req.user.id);
    await billingService.generateInvoicePdf(invoiceId, userId);

    // Webling-Buchung wenn Rechnung sofort bezahlt wird (best-effort)
    let webling_warning = null;
    if (paymode_id) {
      try {
        await _bookInvoiceWebling(invoiceId);
      } catch (wErr) {
        console.warn('[browser/invoice POST] Webling-Buchung fehlgeschlagen:', wErr.message);
        webling_warning = wErr.message;
      }
    }

    res.status(201).json({ ok: true, invoice_id: invoiceId, total, lines, webling_warning });
  } catch (err) {
    console.error('[browser/invoice POST]', err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/browser/invoices/:id/pdf
 * Rechnung als PDF herunterladen.
 */
router.get('/invoices/:id/pdf', async (req, res) => {
  const invoiceId = parseInt(req.params.id);

  try {
    const invoice = await db.queryOne(Q.getInvoiceById, [invoiceId]);
    if (!invoice) return res.status(404).json({ error: 'Rechnung nicht gefunden' });

    const isOwn        = req.user.id === invoice.user_id;
    const isPrivileged = req.user.roles.some(r => ['admin', 'labmanager'].includes(r));
    if (!isOwn && !isPrivileged) return res.status(403).json({ error: 'Keine Berechtigung' });

    // Offene Rechnungen immer neu generieren (Inhalt kann sich geändert haben)
    if (!invoice.paymode_id) {
      try {
        await billingService.generateInvoicePdf(invoiceId, Number(invoice.user_id));
      } catch (pdfErr) {
        console.warn('[browser/invoices/:id/pdf] PDF-Regenerierung fehlgeschlagen:', pdfErr.message);
      }
    }

    const doc = await db.queryOne(Q.getInvoicePdf, [invoiceId]);
    if (!doc) return res.status(404).json({ error: 'PDF nicht gefunden' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rechnung-${invoiceId}.pdf"`);
    res.send(doc.blob);
  } catch (err) {
    console.error('[browser/invoices/:id/pdf]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * GET /api/browser/invoices/:id
 * Rechnungsdetail inkl. Positionen.
 */
router.get('/invoices/:id', async (req, res) => {
  const invoiceId = parseInt(req.params.id);
  try {
    const invoice = await db.queryOne(Q.getInvoiceById, [invoiceId]);
    if (!invoice) return res.status(404).json({ error: 'Rechnung nicht gefunden' });

    const isOwn        = req.user.id === Number(invoice.user_id);
    const isPrivileged = req.user.roles.some(r => ['admin', 'labmanager'].includes(r));
    if (!isOwn && !isPrivileged) return res.status(403).json({ error: 'Keine Berechtigung' });

    const [items, machine_lines] = await Promise.all([
      db.query(Q.getInvoiceItems, [invoiceId]),
      billingService.getInvoiceMachineLines(invoiceId),
    ]);
    res.json({ invoice: { ...invoice, id: Number(invoice.id) }, items, machine_lines });
  } catch (err) {
    console.error('[browser/invoices/:id GET]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * DELETE /api/browser/invoices/:id
 * Rechnung stornieren – nur solange nicht an Webling übermittelt (paymode_id IS NULL).
 */
router.delete('/invoices/:id', requireRole('admin', 'labmanager'), async (req, res) => {
  const invoiceId = parseInt(req.params.id);

  try {
    const invoice = await db.queryOne(Q.getInvoiceById, [invoiceId]);
    if (!invoice) return res.status(404).json({ error: 'Rechnung nicht gefunden' });
    if (invoice.paymode_id) {
      return res.status(409).json({ error: 'Rechnung bereits abgeschlossen – Stornierung nicht möglich' });
    }

    // Restore log entries to open state, then delete invoice
    await db.query(Q.unlinkLogsFromInvoice, [invoiceId]);
    await db.query(Q.cancelInvoice, [invoiceId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/invoices/:id DELETE]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// Hilfsfunktion: Webling-Buchung für eine bezahlte Rechnung
async function _bookInvoiceWebling(invoiceId) {
  const invoice = await db.queryOne(Q.getInvoiceById, [invoiceId]);
  if (!invoice?.webling_id || !invoice?.paymode_konto_nr) return { ok: false, skipped: true };

  const [machineLines, articleItems] = await Promise.all([
    billingService.getInvoiceMachineLines(invoiceId),
    db.query(Q.getInvoiceItems, [invoiceId]),
  ]);

  const date = String(invoice.paid_at || invoice.created_at).slice(0, 10);

  await weblingService.bookInvoice({
    weblingId:      Number(invoice.webling_id),
    invoiceId,
    userName:       invoice.user_name,
    date,
    paymodeKontoNr: invoice.paymode_konto_nr,
    machineLines,
    articleItems,
  });
  return { ok: true };
}

/**
 * PATCH /api/browser/invoices/:id/pay
 * Zahlungsart nachträglich setzen (offene Rechnung bezahlen).
 */
router.patch('/invoices/:id/pay', sessionAuth, async (req, res) => {
  const invoiceId = parseInt(req.params.id);
  const { paymode_id } = req.body;
  if (!paymode_id) return res.status(400).json({ error: 'paymode_id erforderlich' });

  try {
    const invoice = await db.queryOne(Q.getInvoiceById, [invoiceId]);
    if (!invoice) return res.status(404).json({ error: 'Rechnung nicht gefunden' });
    if (invoice.paymode_id) return res.status(409).json({ error: 'Rechnung bereits bezahlt' });

    const isOwn        = req.user.id === Number(invoice.user_id);
    const isPrivileged = req.user.roles.some(r => ['admin','labmanager'].includes(r));
    if (!isOwn && !isPrivileged) return res.status(403).json({ error: 'Keine Berechtigung' });

    await db.query(Q.payInvoice, [parseInt(paymode_id), invoiceId]);

    // PDF neu generieren (enthält jetzt Zahlungsart + BEZAHLT-Stempel)
    try {
      await billingService.generateInvoicePdf(invoiceId, Number(invoice.user_id));
    } catch (pdfErr) {
      console.warn('[browser/invoices/:id/pay] PDF-Regenerierung fehlgeschlagen:', pdfErr.message);
    }

    // Webling-Buchung (best-effort)
    let webling_warning = null;
    try {
      await _bookInvoiceWebling(invoiceId);
    } catch (wErr) {
      console.warn('[browser/invoices/:id/pay] Webling-Buchung fehlgeschlagen:', wErr.message);
      webling_warning = wErr.message;
    }

    // Guthaben-Zahlung: Balance im Webling-Feld abziehen + webling_meta aktualisieren
    if ((invoice.paymode || '').toLowerCase().includes('guthaben') && invoice.webling_id) {
      try {
        const wid = Number(invoice.webling_id);
        const current = await weblingService.getBalance(wid);
        await weblingService.setBalance(wid, +(current - Number(invoice.total)).toFixed(2));

        // webling_meta lokal nachführen
        const freshMember = await weblingService.getMember(wid);
        await db.query(Q.updateWeblingMeta, [JSON.stringify(freshMember), wid]);
        console.info(`[invoices/:id/pay] Guthaben ${wid}: ${current} → ${+(current - Number(invoice.total)).toFixed(2)}`);
      } catch (balErr) {
        console.warn('[browser/invoices/:id/pay] Guthaben-Abzug fehlgeschlagen:', balErr.message);
        webling_warning = (webling_warning ? webling_warning + '; ' : '') + 'Guthaben-Abzug: ' + balErr.message;
      }
    }

    res.json({ ok: true, webling_warning });
  } catch (err) {
    console.error('[browser/invoices/:id/pay]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/invoices/:id/items
 * Artikel zu einer offenen (unbezahlten) Rechnung hinzufügen.
 * Body: { items: [{ description, quantity, unit_price, is_balance_deposit, credit_account? }] }
 */
router.post('/invoices/:id/items', async (req, res) => {
  const invoiceId = parseInt(req.params.id);
  const { items = [] } = req.body;
  if (!items.length) return res.status(400).json({ error: 'Keine Artikel angegeben' });

  try {
    const invoice = await db.queryOne(Q.getInvoiceById, [invoiceId]);
    if (!invoice) return res.status(404).json({ error: 'Rechnung nicht gefunden' });
    if (invoice.paymode_id) return res.status(409).json({ error: 'Rechnung bereits bezahlt – keine Änderung möglich' });

    const isOwn        = req.user.id === Number(invoice.user_id);
    const isPrivileged = req.user.roles.some(r => ['admin','labmanager'].includes(r));
    if (!isOwn && !isPrivileged) return res.status(403).json({ error: 'Keine Berechtigung' });

    // Balance deposits first
    for (const item of items.filter(i => i.is_balance_deposit)) {
      const result = await balanceService.deposit(
        invoice.user_id, item.unit_price, item.credit_account, 'Guthaben via Rechnung', req.user.name
      );
      if (!result.ok) {
        return res.status(400).json({ error: `Guthabeneinzahlung fehlgeschlagen: ${result.error_code}` });
      }
    }

    let addedTotal = 0;
    for (const item of items) {
      const itemTotal = +(item.quantity * item.unit_price).toFixed(2);
      addedTotal = +(addedTotal + itemTotal).toFixed(2);
      await db.query(Q.insertInvoiceItem, [
        invoiceId, item.description, item.quantity, item.unit_price, itemTotal, item.credit_account || null, item.is_correction ? 1 : 0,
      ]);
    }

    const newTotal = +(Number(invoice.total) + addedTotal).toFixed(2);
    await db.query('UPDATE invoices SET total = ? WHERE id = ?', [newTotal, invoiceId]);

    // Regenerate PDF
    await billingService.generateInvoicePdf(invoiceId, Number(invoice.user_id));

    res.json({ ok: true, added_total: addedTotal, new_total: newTotal });
  } catch (err) {
    console.error('[browser/invoices/:id/items POST]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * DELETE /api/browser/invoices/:id/items/:item_id
 * Einzelne Position aus offener Rechnung löschen.
 */
router.delete('/invoices/:id/items/:item_id', requireRole('admin', 'labmanager'), async (req, res) => {
  const invoiceId = parseInt(req.params.id);
  const itemId    = parseInt(req.params.item_id);
  try {
    const invoice = await db.queryOne(Q.getInvoiceById, [invoiceId]);
    if (!invoice) return res.status(404).json({ error: 'Rechnung nicht gefunden' });
    if (invoice.paymode_id) return res.status(409).json({ error: 'Rechnung bereits bezahlt' });

    // Position laden um Betrag zu kennen
    const items = await db.query(Q.getInvoiceItems, [invoiceId]);
    const item  = items.find(i => Number(i.id) === itemId);
    if (!item) return res.status(404).json({ error: 'Position nicht gefunden' });

    await db.query(Q.deleteInvoiceItem, [itemId, invoiceId]);

    const newTotal = +(Number(invoice.total) - Number(item.total)).toFixed(2);
    await db.query('UPDATE invoices SET total = ? WHERE id = ?', [newTotal, invoiceId]);

    await billingService.generateInvoicePdf(invoiceId, Number(invoice.user_id));
    res.json({ ok: true, new_total: newTotal });
  } catch (err) {
    console.error('[browser/invoices/:id/items DELETE]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * DELETE /api/browser/invoices/:id/pay
 * Bezahlung rückgängig machen (nur Admin) – setzt paymode_id und paid_at auf NULL.
 * Webling-Buchung muss manuell gelöscht werden.
 */
router.delete('/invoices/:id/pay', requireRole('admin'), async (req, res) => {
  const invoiceId = parseInt(req.params.id);
  try {
    const invoice = await db.queryOne(Q.getInvoiceById, [invoiceId]);
    if (!invoice) return res.status(404).json({ error: 'Rechnung nicht gefunden' });
    if (!invoice.paymode_id) return res.status(409).json({ error: 'Rechnung ist nicht bezahlt' });

    await db.query(Q.unPayInvoice, [invoiceId]);
    res.json({ ok: true, warning: 'Webling-Buchung muss manuell gelöscht werden' });
  } catch (err) {
    console.error('[browser/invoices/:id/pay DELETE]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── Knowledge / Skills ────────────────────────────────────────────────────────

/**
 * GET /api/browser/knowledge
 * Alle Knowledge-Einträge (für Dropdown beim Editieren).
 */
router.get('/knowledge', requireRole('admin', 'labmanager'), async (req, res) => {
  try {
    const list = await db.query(Q.getAllKnowledge);
    res.json({ knowledge: list });
  } catch (err) {
    console.error('[browser/knowledge]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/knowledge
 * Neuen Knowledge-Eintrag anlegen.
 * Body: { name }
 */
router.post('/knowledge', requireRole('admin', 'labmanager'), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name erforderlich' });
  try {
    const existing = await db.queryOne(Q.getKnowledgeByName, [name.trim()]);
    if (existing) return res.status(409).json({ error: 'Bereits vorhanden', knowledge: existing });
    const result = await db.query(Q.createKnowledge, [name.trim()]);
    res.status(201).json({ id: Number(result.insertId), name: name.trim() });
  } catch (err) {
    console.error('[browser/knowledge POST]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * POST /api/browser/members/:id/knowledge/:knowledge_id
 * Knowledge einem Mitglied zuweisen.
 */
router.post('/members/:id/knowledge/:knowledge_id', requireRole('admin', 'labmanager'), async (req, res) => {
  const userId      = parseInt(req.params.id);
  const knowledgeId = parseInt(req.params.knowledge_id);
  try {
    await db.query(Q.addUserKnowledge, [userId, knowledgeId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/members/:id/knowledge POST]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

/**
 * DELETE /api/browser/members/:id/knowledge/:knowledge_id
 * Knowledge von Mitglied entfernen.
 */
router.delete('/members/:id/knowledge/:knowledge_id', requireRole('admin', 'labmanager'), async (req, res) => {
  const userId      = parseInt(req.params.id);
  const knowledgeId = parseInt(req.params.knowledge_id);
  try {
    await db.query(Q.removeUserKnowledge, [userId, knowledgeId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[browser/members/:id/knowledge DELETE]', err.message);
    res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

// ── Google Calendar status (admin) ────────────────────────────────────────────

router.get('/google/status', requireRole('admin'), async (req, res) => {
  const authorised = await calendarSync.isAuthorised();
  res.json({ authorised });
});

// ── Webling Sync (admin) ───────────────────────────────────────────────────────

router.post('/webling/sync', requireRole('admin'), async (req, res) => {
  try {
    const weblingSync = require('../services/weblingSync');
    const stats = await weblingSync.runSync();
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error('[browser/webling/sync]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
