'use strict';

const crypto         = require('crypto');
const fs             = require('fs');
const path           = require('path');
const db             = require('../db/pool');
const Q              = require('../db/queries');
const configService  = require('./configService');
const weblingService = require('./weblingService');
const mailService    = require('./mailService');
const cfg            = require('../config');

// ── Log-Datei ──────────────────────────────────────────────────────────────────

const LOG_DIR  = path.join(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'webling-sync.log');

function _ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function _log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    _ensureLogDir();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {}
}

function _warn(...args) {
  const line = `[${new Date().toISOString()}] ⚠  ${args.join(' ')}`;
  console.warn(line);
  try { _ensureLogDir(); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (_) {}
}

function _err(...args) {
  const line = `[${new Date().toISOString()}] ✗  ${args.join(' ')}`;
  console.error(line);
  try { _ensureLogDir(); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (_) {}
}

// ── Rollen kommen ausschliesslich aus Fachgruppen-Mitgliedschaft ──────────────
// (webling.fachgruppe_roles konfigurierbar, Standard: LabManager→labmanager, ICT→admin)
// Das Webling-Funktion-Feld wird NICHT mehr für Rollen verwendet.

const DELAY_MS = parseInt(process.env.WEBLING_RATE_DELAY_MS || '300');

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _clean(s)  { return (s || '').replace(/^_+/, '').trim(); }

/**
 * Modul H – Webling → lokale DB synchronisieren.
 * Phase 1: Mitglieder-Upsert + webling_meta-Backup + Aktiv-Status prüfen
 * Phase 2: Fachgruppen → user_fachgruppen + Rollen-Sync via Fachgruppe
 */
async function runSync() {
  _log('══════════════════════════════════════');
  _log('[weblingSync] SYNC START');

  const [activeStatuses, fachgruppeRoles] = await Promise.all([
    configService.get('webling.active_statuses'),
    configService.get('webling.fachgruppe_roles'),
  ]);
  // Wildcard-Patterns: "Mitglied*" → /^mitglied.*/i  ("*" = beliebige Zeichen)
  const activePatterns = (activeStatuses || []).map(s =>
    new RegExp('^' + s.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  );
  const isActiveStatus = (status) => {
    if (activePatterns.length === 0) return true;
    const lower = (status || '').toLowerCase();
    return activePatterns.some(p => p.test(lower));
  };
  const fgRoleMap = fachgruppeRoles || {};

  // ── Phase 1: Mitglieder ────────────────────────────────────────────────────
  const { data: listData } = await weblingService._client().get('/member');
  const weblingIds = (listData.objects || []).map(Number);
  _log(`[weblingSync] ${weblingIds.length} Mitglieder in Webling`);

  const stats           = { inserted: 0, updated: 0, skipped: 0, deactivated: 0, errors: 0 };
  const skippedList     = [];
  const seenIds         = [];
  const weblingToLocal  = {};
  const inactiveMembIds = [];

  for (const weblingId of weblingIds) {
    await _sleep(DELAY_MS);
    try {
      const member = await weblingService.getMember(weblingId);
      const props  = member.properties || {};

      const vorname = _clean(props['Vorname']);
      const nachname= _clean(props['Name']);
      const name    = [vorname, nachname].filter(Boolean).join(' ');
      const email   = (_clean(props['E-Mail P']) || _clean(props['E-Mail G'])).toLowerCase();

      if (!email || !name) {
        const reason = !name ? 'kein Name' : 'keine E-Mail';
        skippedList.push({ weblingId, name: name || '(leer)', email: email || '(leer)', reason });
        stats.skipped++;
        continue;
      }

      seenIds.push(weblingId);

      const status         = (props['Status'] || '').toLowerCase();
      const isActiveMember = isActiveStatus(status);
      if (!isActiveMember) inactiveMembIds.push(weblingId);

      let localId, isNew = false;
      const byWebling = await db.queryOne(Q.getMemberByWeblingId, [weblingId]);
      if (byWebling) {
        await db.query(Q.updateMemberFromWebling, [name, email, weblingId]);
        localId = byWebling.id;
        stats.updated++;
      } else {
        const byEmail = await db.queryOne(Q.getMemberByEmail, [email]);
        if (byEmail) {
          await db.query(Q.linkMemberWebling, [name, weblingId, byEmail.id]);
          localId = byEmail.id;
          stats.updated++;
        } else {
          const result = await db.query(Q.insertMemberFromWebling, [weblingId, name, email]);
          localId = Number(result.insertId);
          await db.query(Q.insertMemberRole, [localId, 'member']);
          stats.inserted++;
          isNew = true;
        }
      }

      // Lokale Upgrade-Events in Webling Membership-History schreiben (vor Meta-Backup)
      await _syncLocalUpgradesToWebling(localId, weblingId, member);

      // Frisches Member-Objekt holen (enthält nun aktuelle History) und als Meta speichern
      const freshMember = await weblingService.getMember(weblingId);
      await db.query(Q.updateWeblingMeta, [JSON.stringify(freshMember), weblingId]);
      weblingToLocal[weblingId] = localId;
      await _syncRolesAndWelcome(localId, name, email, props, isNew);

    } catch (err) {
      _err(`[weblingSync] ID ${weblingId}: ${err.message}`);
      stats.errors++;
    }
  }

  if (seenIds.length > 0) {
    await db.query(Q.deactivateOrphanedMembers, [seenIds]);
  }

  _log(
    `[weblingSync] Phase 1: +${stats.inserted} neu, ~${stats.updated} aktualisiert,` +
    ` ${stats.skipped} übersprungen, ${stats.errors} Fehler`
  );

  // Übersprungene Details loggen
  if (skippedList.length > 0) {
    _warn(`[weblingSync] Übersprungene Mitglieder (${skippedList.length}):`);
    for (const s of skippedList) {
      _warn(`  ID ${s.weblingId} | "${s.name}" | ${s.email} | Grund: ${s.reason}`);
    }
  }

  // ── Phase 2: Fachgruppen ───────────────────────────────────────────────────
  try {
    await syncFachgruppen(weblingToLocal, inactiveMembIds, fgRoleMap);
  } catch (err) {
    _err(`[weblingSync] Fachgruppen-Sync fehlgeschlagen: ${err.message}`);
  }

  // ── Phase 3: Lokale Mitglieder → Webling (Push) ───────────────────────────
  try {
    const pushed = await pushMissingToWebling(activePatterns);
    stats.inserted += pushed;
  } catch (err) {
    _err(`[weblingSync] Push-Phase fehlgeschlagen: ${err.message}`);
  }

  const autoCalc = await configService.get('webling.auto_calc_months');
  if (autoCalc) await calcOptimalExmemberMonths(weblingIds);

  _log(
    `[weblingSync] ✓ SYNC ABGESCHLOSSEN: ` +
    `+${stats.inserted} neu, ~${stats.updated} aktualisiert, ` +
    `${stats.skipped} übersprungen, ${stats.errors} Fehler`
  );
  _log('══════════════════════════════════════');
  return stats;
}

async function syncFachgruppen(weblingToLocal, inactiveMembIds, fgRoleMap) {
  _log('[weblingSync] Phase 2: Fachgruppen');

  const client = weblingService._client();
  const inactiveSet = new Set(inactiveMembIds);

  const { data: fgParent } = await client.get('/membergroup/252');
  const fgIds = (fgParent.children && fgParent.children.membergroup) || [];
  const fgManagedRoles = new Set(Object.values(fgRoleMap));

  let fgCount = 0, fgMemberCount = 0;

  for (const fgId of fgIds) {
    await _sleep(DELAY_MS);
    try {
      const { data: fg } = await client.get(`/membergroup/${fgId}`);
      const name = fg.properties?.['title'] || fg.properties?.['Titel'] || fg.label || `Gruppe ${fgId}`;

      let fg_row = await db.queryOne(Q.getFachgruppeByWeblingGroupId, [fgId]);
      if (!fg_row) {
        await db.query(Q.insertFachgruppe, [name, fgId]);
        fg_row = await db.queryOne(Q.getFachgruppeByWeblingGroupId, [fgId]);
      } else if (fg_row.name !== name) {
        await db.query(Q.updateFachgruppeName, [name, fgId]);
      }
      if (!fg_row) continue;

      const allMemberIds    = ((fg.children?.member) || []).map(Number);
      const activeMemberIds = allMemberIds.filter(wid => !inactiveSet.has(wid));
      const removedFromFg   = allMemberIds.filter(wid => inactiveSet.has(wid));

      // Inaktive aus Webling-Fachgruppe entfernen
      for (const wid of removedFromFg) {
        try {
          const { data: m } = await client.get(`/member/${wid}`);
          await _sleep(50);
          const newParents = (m.parents || []).filter(p => p !== fgId);
          if (newParents.length < (m.parents || []).length) {
            await client.put(`/member/${wid}`, { parents: newParents });
            await _sleep(DELAY_MS);
            _log(`[weblingSync] Inaktives Mitglied ${wid} aus Fachgruppe «${name}» entfernt`);
          }
        } catch (err) {
          _warn(`[weblingSync] Fachgruppe ${name}: Entfernen ${wid} fehlgeschlagen: ${err.message}`);
        }
      }

      await db.query(Q.deleteUserFachgruppeByFachgruppeId, [fg_row.id]);
      for (const weblingId of activeMemberIds) {
        const localId = weblingToLocal[weblingId];
        if (localId) {
          await db.query(Q.insertUserFachgruppe, [localId, fg_row.id]);
          fgMemberCount++;
        }
      }
      fgCount++;

    } catch (err) {
      _err(`[weblingSync] Fachgruppe ${fgId}: ${err.message}`);
    }
  }

  _log(`[weblingSync] Phase 2: ${fgCount} Fachgruppen, ${fgMemberCount} Zuordnungen`);

  // ── Rollen-Sync aus Fachgruppen ────────────────────────────────────────────
  if (Object.keys(fgRoleMap).length === 0) return;
  _log('[weblingSync] Phase 2b: Rollen-Sync via Fachgruppen');

  const allFg = await db.query('SELECT id, name, webling_group_id FROM fachgruppen');
  const roleToMembers = {};

  for (const fg of allFg) {
    const fgTitle = (fg.name || '').trim();
    // Teilstring-Match: "ICT" trifft auf "FG-ICT", "LabManager" auf "LabManager" etc.
    const role = Object.entries(fgRoleMap).find(([k]) =>
      fgTitle.toLowerCase().includes(k.toLowerCase())
    )?.[1];
    if (!role) continue;
    const members = await db.query('SELECT user_id FROM user_fachgruppen WHERE fachgruppe_id = ?', [fg.id]);
    if (!roleToMembers[role]) roleToMembers[role] = new Set();
    for (const m of members) roleToMembers[role].add(Number(m.user_id));
  }

  const affectedUsers = new Set();
  for (const s of Object.values(roleToMembers)) for (const id of s) affectedUsers.add(id);
  const usersWithFgRoles = await db.query(
    `SELECT DISTINCT ur.user_id FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id WHERE r.name IN (${[...fgManagedRoles].map(() => '?').join(',')})`,
    [...fgManagedRoles]
  );
  for (const r of usersWithFgRoles) affectedUsers.add(Number(r.user_id));

  for (const userId of affectedUsers) {
    const currentRoles = (await db.query(Q.getUserRoles, [userId])).map(r => r.name);
    const userInfo = await db.queryOne('SELECT name FROM users WHERE id = ?', [userId]);
    const uname = userInfo?.name || `#${userId}`;

    for (const role of fgManagedRoles) {
      const shouldHave = roleToMembers[role]?.has(userId) || false;
      const hasNow     = currentRoles.includes(role);
      if (shouldHave && !hasNow) {
        await db.query(Q.insertMemberRole, [userId, role]);
        _log(`[weblingSync] ${uname}: Rolle '${role}' via Fachgruppe hinzugefügt`);
      } else if (!shouldHave && hasNow) {
        await db.query(Q.deleteMemberRole, [userId, role]);
        _log(`[weblingSync] ${uname}: Rolle '${role}' entfernt (nicht mehr in Fachgruppe)`);
      }
    }
  }
}

async function _pushMember(u, memberGroupId) {
  const props = { 'E-Mail P': u.email };
  const nameParts = (u.name || '').trim().split(' ');
  props['Vorname'] = nameParts.slice(0, -1).join(' ') || u.name;
  props['Name']    = nameParts.slice(-1)[0] || '';

  const payload = { properties: props };
  if (memberGroupId) payload.parents = [Number(memberGroupId)];

  const { data: newId } = await weblingService._client().post('/member', payload);
  const weblingId = typeof newId === 'number' ? newId : Number(newId);
  await db.query('UPDATE users SET webling_id = ?, active = 1 WHERE id = ?', [weblingId, u.id]);
  await _sleep(DELAY_MS);
  return weblingId;
}

async function pushMissingToWebling(activePatterns) {
  const [maxMembers, reserve, exmemberMonths, memberGroupId] = await Promise.all([
    configService.get('webling.max_members'),
    configService.get('webling.reserve'),
    configService.get('webling.exmember_months'),
    configService.get('webling.member_group_id'),
  ]);

  const capacity = (maxMembers || 500) - (reserve || 0);

  // Wieviele sind bereits in Webling (live von Webling API, nicht lokale DB)
  const { data: listData } = await weblingService._client().get('/member');
  let inWebling = (listData.objects || []).length;

  // ── Schritt 1: Aktive ohne webling_id ermitteln ────────────────────────────
  const activeCandidates = await db.query(
    `SELECT id, name, email, membership_status, zynex_id
     FROM users
     WHERE webling_id IS NULL AND zynex_id IS NOT NULL AND email IS NOT NULL`
  );
  const toActivePush = activeCandidates.filter(u => {
    const s = (u.membership_status || '').toLowerCase();
    if (s === 'ex-mitglied') return false;
    return s === 'ausgeschlossen' || activePatterns.length === 0 || activePatterns.some(p => p.test(s));
  });

  // ── Schritt 2: Falls nicht genug Platz → Ex-Mitglieder aus Webling löschen ─
  const needed = toActivePush.length;
  const available = capacity - inWebling;

  if (available < needed) {
    const toFree = needed - available;
    _log(`[weblingSync] Phase 3: Brauche ${needed} Plätze, verfügbar ${available} → lösche ${toFree} Ex-Mitglieder aus Webling`);

    // Ex-Mitglieder in Webling, älteste zuerst (nach Austrittsdatum)
    const exInWebling = await db.query(
      `SELECT id, name, webling_id, webling_meta
       FROM users
       WHERE webling_id IS NOT NULL AND membership_status = 'Ex-Mitglied'
       ORDER BY id ASC`
    );

    // Sortieren nach Austrittsdatum aufsteigend (älteste zuerst)
    exInWebling.sort((a, b) => {
      const dateA = _getAustrittsdatum(a.webling_meta);
      const dateB = _getAustrittsdatum(b.webling_meta);
      return (dateA || '').localeCompare(dateB || '');
    });

    let freed = 0;
    for (const ex of exInWebling) {
      if (freed >= toFree) break;
      try {
        await weblingService._client().delete(`/member/${ex.webling_id}`);
        _log(`[weblingSync] Ex-Mitglied «${ex.name}» aus Webling gelöscht (Platz schaffen)`);
        inWebling--;
        freed++;
      } catch (err) {
        if (err.response?.status === 404) {
          _log(`[weblingSync] Ex-Mitglied «${ex.name}» bereits gelöscht — bereinige webling_id`);
          await db.query('UPDATE users SET webling_id = NULL WHERE id = ?', [ex.id]);
          inWebling--;
          freed++;
        } else if (err.response?.status === 409) {
          _warn(`[weblingSync] Ex-Mitglied «${ex.name}» hat Buchungen in Webling — wird behalten`);
        } else {
          _warn(`[weblingSync] Löschen fehlgeschlagen für «${ex.name}»: ${err.message}`);
        }
      }
    }
  }

  // ── Schritt 3: Aktive pushen ───────────────────────────────────────────────
  let pushed = 0;
  for (const u of toActivePush) {
    if (inWebling >= capacity) {
      _warn(`[weblingSync] Webling voll (${inWebling}/${capacity}) — «${u.name}» nicht gepusht`);
      continue;
    }
    try {
      const weblingId = await _pushMember(u, memberGroupId);
      _log(`[weblingSync] Push aktiv: «${u.name}» → Webling ${weblingId} [${u.membership_status}]`);
      inWebling++;
      pushed++;
    } catch (err) {
      _warn(`[weblingSync] Push fehlgeschlagen für «${u.name}» (${u.email}): ${err.message}`);
    }
  }

  // ── Schritt 4: Ex-Mitglieder in verbleibenden Platz pushen ────────────────
  if (exmemberMonths > 0) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - exmemberMonths);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const exCandidates = await db.query(
      `SELECT id, name, email, membership_status, zynex_id, webling_meta
       FROM users
       WHERE webling_id IS NULL AND zynex_id IS NOT NULL AND email IS NOT NULL
         AND membership_status = 'Ex-Mitglied'`
    );

    // Jüngste zuerst
    exCandidates.sort((a, b) => {
      const dateA = _getAustrittsdatum(a.webling_meta);
      const dateB = _getAustrittsdatum(b.webling_meta);
      return (dateB || '').localeCompare(dateA || '');
    });

    for (const u of exCandidates) {
      if (inWebling >= capacity) break;
      const austrittsdatum = _getAustrittsdatum(u.webling_meta);
      if (austrittsdatum && austrittsdatum < cutoffStr) continue;
      try {
        const weblingId = await _pushMember(u, memberGroupId);
        _log(`[weblingSync] Push Ex-Mitglied: «${u.name}» → Webling ${weblingId}`);
        inWebling++;
        pushed++;
      } catch (err) {
        _warn(`[weblingSync] Push Ex-Mitglied fehlgeschlagen für «${u.name}»: ${err.message}`);
      }
    }
  }

  _log(`[weblingSync] Phase 3: ${pushed} gepusht, ${inWebling}/${capacity} Webling-Plätze belegt`);
  return pushed;
}

function _getAustrittsdatum(weblingMeta) {
  try {
    const meta  = typeof weblingMeta === 'string' ? JSON.parse(weblingMeta) : weblingMeta;
    const props = meta?.properties || {};
    return props['Austrittsdatum'] || props['Mitglied bis'] || null;
  } catch (_) { return null; }
}

async function calcOptimalExmemberMonths(weblingIds) {
  const [maxMembers, reserve, configured] = await Promise.all([
    configService.get('webling.max_members'),
    configService.get('webling.reserve'),
    configService.get('webling.exmember_months'),
  ]);

  const capacity        = (maxMembers || 500) - (reserve || 0);
  const totalInWebling  = weblingIds.length;
  const available       = capacity - totalInWebling;

  // Ex-Mitglieder in Webling: Austrittsdatum live aus Webling holen
  const activeStatuses  = await configService.get('webling.active_statuses') || [];
  const activePatterns  = activeStatuses.map(s =>
    new RegExp('^' + s.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  );
  const isActiveStatus  = s => activePatterns.length === 0 || activePatterns.some(p => p.test((s||'').toLowerCase()));

  const now = Date.now();
  const byMonth = {};

  for (const wid of weblingIds) {
    try {
      const member = await weblingService.getMember(wid);
      const props  = member?.properties || {};
      const status = (props['Status'] || '').toLowerCase();
      if (isActiveStatus(status) || status === 'ausgeschlossen') continue;

      const until = props['Austrittsdatum'] || props['Mitglied bis'];
      if (!until) continue;
      const monthsAgo = Math.floor((now - new Date(until).getTime()) / (1000 * 60 * 60 * 24 * 30));
      if (monthsAgo < 0) continue;
      byMonth[monthsAgo] = (byMonth[monthsAgo] || 0) + 1;
      await _sleep(50);
    } catch (_) {}
  }

  // Maximum: so viele Monate wie möglich, solange Platzbedarf <= available
  let sum = 0, optimalMonths = 0;
  for (const mo of Object.keys(byMonth).map(Number).sort((a, b) => a - b)) {
    if (sum + byMonth[mo] > available) break;
    sum += byMonth[mo];
    optimalMonths = mo;
  }

  if (optimalMonths !== configured) {
    await configService.set('webling.exmember_months', optimalMonths);
    _log(`[weblingSync] exmember_months: ${configured} → ${optimalMonths} (Kapazität: ${capacity}, belegt: ${totalInWebling}, Ex-Mitglieder: ${sum})`);
    await mailService.sendWeblingAutoAdjust({ oldMonths: configured, newMonths: optimalMonths,
      occupation: totalInWebling, maxMembers }).catch(() => {});
  } else {
    _log(`[weblingSync] exmember_months: ${configured} unverändert (verfügbar: ${available}, Ex-Mitglieder: ${sum})`);
  }
}

async function _syncRolesAndWelcome(localId, name, email, props, isNew) {
  const currentRoles = (await db.query(Q.getUserRoles, [localId])).map(r => r.name);
  if (!currentRoles.includes('member')) {
    await db.query(Q.insertMemberRole, [localId, 'member']);
  }

  if (isNew) {
    try {
      const token     = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await db.query(Q.insertPasswordReset, [localId, tokenHash]);
      const resetUrl = `${cfg.app.baseUrl}/?reset=${token}`;
      await mailService.send({
        to:      email,
        subject: 'Willkommen bei FabLab Winti – Zugang aktivieren',
        text:    `Hallo ${name},\n\nDein Konto wurde eingerichtet.\n\nPasswort setzen:\n${resetUrl}\n\n(Link gültig 2 Stunden)`,
        html:    `<p>Hallo ${name},</p><p>Dein Konto wurde eingerichtet.</p><p><a href="${resetUrl}">Passwort jetzt setzen</a></p><p>Link gültig 2 Stunden.</p>`,
      });
      _log(`[weblingSync] ${name}: Welcome-Mail gesendet`);
    } catch (mailErr) {
      _warn(`[weblingSync] ${name}: Welcome-Mail fehlgeschlagen: ${mailErr.message}`);
    }
  }
}

/**
 * Schreibt Upgrade-Ereignisse in das Webling-Feld "Membership-History":
 *
 * A) Lokale 'upgrade'-Events aus upgrade_history (kein revert, kein Zynex-Import)
 * B) Aktuelles Webling-"Upgrade"-Feld → neuer Record "Upgrade [Status] > [Upgrade]"
 *    falls noch kein identischer Eintrag vorhanden
 */
async function _syncLocalUpgradesToWebling(localId, weblingId, weblingMember) {
  const props = weblingMember?.properties || {};
  const historyField = 'Membership-History';

  // Bestehende Membership-History aus Webling
  let history = [];
  try {
    const raw = props[historyField];
    if (raw) history = JSON.parse(raw);
  } catch (_) {}

  let changed = false;

  // ── A. Lokale 'upgrade'-Events (kein revert, kein Zynex-Import) ──────────────
  const localUpgrades = await db.query(
    `SELECT id, upgrade_type, start_date, expiry_date, created_at, note
     FROM upgrade_history
     WHERE member_id = ?
       AND event_type = 'upgrade'
       AND (note IS NULL OR (note NOT LIKE '%zynex:%' AND note NOT LIKE '%"key":"zynex%'))
     ORDER BY created_at ASC`,
    [localId]
  );

  for (const u of localUpgrades) {
    const key = `local:upg:${u.id}`;
    if (history.find(h => h._key === key)) continue;
    history.push({
      _key:         key,
      _typ:         'upgrade',
      upgrade_type: u.upgrade_type || '',
      start_date:   u.start_date   || null,
      expiry_date:  u.expiry_date  || null,
      created_at:   String(u.created_at).slice(0, 10),
      note:         u.note         || null,
    });
    changed = true;
  }

  // ── B. Webling-Upgrade-Feld → "Upgrade [Status] > [Upgrade]" ─────────────────
  const currentUpgrade = (props['Upgrade'] || '').trim();
  const currentStatus  = (props['Status']  || '').trim();

  if (currentUpgrade) {
    const description = `Upgrade ${currentStatus} > ${currentUpgrade}`;
    const upgradeAb   = (props['Upgrade ab']  || '').trim() || null;
    const upgradeBis  = (props['Upgrade bis'] || '').trim() || null;

    // Idempotenz: gleicher Schlüssel aus Felder-Kombination
    const key = `webling:upg:${currentUpgrade}:${upgradeAb || ''}`;

    if (!history.find(h => h._key === key)) {
      history.push({
        _key:         key,
        _typ:         'upgrade',
        description,
        upgrade_type: currentUpgrade,
        start_date:   upgradeAb,
        expiry_date:  upgradeBis,
        created_at:   new Date().toISOString().slice(0, 10),
      });
      changed = true;
      _log(`[weblingSync] ${weblingId}: Webling-Upgrade «${description}» → Membership-History`);
    }
  }

  // ── C. Mitgliedschafts-Ereignisse aus Webling-Status ─────────────────────────
  // Erkennt Status-Übergänge und protokolliert sie im offenen/neuen Mitgliedschafts-Eintrag.
  // Offen = letzter 'mitgliedschaft'-Eintrag ohne kuendigDatum und ohne bezeichnung='ausgeschlossen'

  const status        = (props['Status']         || '').trim();
  const antragsDatum  = (props['Datum Antrag']   || '').trim() || null;
  const eintritt      = (props['Eintrittsdatum'] || '').trim() || null;
  const austritt      = (props['Austrittsdatum'] || '').trim() ||
                        (props['Mitglied bis']   || '').trim() || null;
  const statusLower   = status.toLowerCase();

  // Letzten 'mitgliedschaft'-Eintrag finden
  const mitglEntries  = history.filter(h => h._typ === 'mitgliedschaft');
  const lastMitgl     = mitglEntries[mitglEntries.length - 1] || null;
  const isOpen        = lastMitgl &&
                        !lastMitgl.kuendigDatum &&
                        lastMitgl.bezeichnung !== 'ausgeschlossen';

  if (statusLower === 'antrag') {
    // Neuen Eintrag anlegen falls noch keiner existiert (oder letzter geschlossen)
    if (!isOpen && antragsDatum) {
      const key = `webling:mitgl:antrag:${antragsDatum}`;
      if (!history.find(h => h._key === key)) {
        history.push({ _key: key, _typ: 'mitgliedschaft', antragsDatum });
        changed = true;
        _log(`[weblingSync] ${weblingId}: Antrag ${antragsDatum} → Membership-History`);
      }
    } else if (isOpen && antragsDatum && !lastMitgl.antragsDatum) {
      lastMitgl.antragsDatum = antragsDatum;
      changed = true;
    }

  } else if (statusLower.startsWith('mitglied')) {
    if (isOpen) {
      // Eintrittsdatum ergänzen falls noch fehlt
      if (eintritt && !lastMitgl.eintrittsdatum) {
        lastMitgl.eintrittsdatum = eintritt;
        lastMitgl.bezeichnung    = status;
        changed = true;
        _log(`[weblingSync] ${weblingId}: Eintritt ${eintritt} → Membership-History`);
      }
    } else {
      // Kein offener Eintrag: neuen anlegen
      const key = `webling:mitgl:${eintritt || antragsDatum || status}`;
      if (!history.find(h => h._key === key)) {
        history.push({
          _key:          key,
          _typ:          'mitgliedschaft',
          bezeichnung:   status,
          antragsDatum:  antragsDatum || null,
          eintrittsdatum: eintritt   || null,
        });
        changed = true;
        _log(`[weblingSync] ${weblingId}: Mitgliedschaft «${status}» → Membership-History`);
      }
    }

  } else if (statusLower === 'ex-mitglied') {
    if (isOpen && austritt && !lastMitgl.kuendigDatum) {
      lastMitgl.kuendigDatum = austritt;
      changed = true;
      _log(`[weblingSync] ${weblingId}: Kündigung ${austritt} → Membership-History`);
    }

  } else if (statusLower === 'ausgeschlossen') {
    if (isOpen && lastMitgl.bezeichnung !== 'ausgeschlossen') {
      lastMitgl.bezeichnung  = 'ausgeschlossen';
      lastMitgl.kuendigDatum = austritt || new Date().toISOString().slice(0, 10);
      changed = true;
      _log(`[weblingSync] ${weblingId}: Ausschluss → Membership-History`);
    }
  }

  if (changed) {
    await weblingService.updateMemberFields(weblingId, {
      [historyField]: JSON.stringify(history),
    });
  }
}

module.exports = { runSync };
