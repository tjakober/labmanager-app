'use strict';

/**
 * Phase 5 – Verify & Report
 *
 * Checks the local DB and Webling for consistency after migration.
 * Prints a summary and returns { ok, report }.
 */

const axios = require('axios');

async function verify(ctx) {
  const { conn, config, log } = ctx;
  const checks = [];

  // ── Local DB checks ──────────────────────────────────────────────────────────

  const [totalRows]  = await conn.query('SELECT COUNT(*) AS n FROM users');
  const [activeRows] = await conn.query('SELECT COUNT(*) AS n FROM users WHERE active = 1');
  const [linkedRows] = await conn.query('SELECT COUNT(*) AS n FROM users WHERE webling_id IS NOT NULL');
  const [dupEmails]  = await conn.query(
    'SELECT COUNT(*) AS n FROM (SELECT email FROM users GROUP BY email HAVING COUNT(*) > 1) t'
  );

  checks.push({ check: 'Gesamt Benutzer (lokal)',    value: totalRows.n });
  checks.push({ check: 'Aktive Benutzer (lokal)',    value: activeRows.n });
  checks.push({ check: 'Mit webling_id verknüpft',  value: linkedRows.n });
  checks.push({ check: 'Doppelte E-Mails',          value: dupEmails.n, warn: dupEmails.n > 0 });

  // Active without webling_id = sync gap
  const syncGap = activeRows.n - linkedRows.n;
  checks.push({ check: 'Aktiv ohne webling_id',     value: syncGap, warn: syncGap > 0 });

  // ── Webling checks ───────────────────────────────────────────────────────────

  if (config.webling.apiUrl && config.webling.apiKey) {
    try {
      const client    = axios.create({
        baseURL: config.webling.apiUrl,
        params:  { apikey: config.webling.apiKey },
        timeout: 15_000,
      });
      const { data }  = await client.get('/member');
      const members   = Array.isArray(data) ? data : (data.objects || []);
      checks.push({ check: 'Mitglieder in Webling', value: members.length });

      const weblingEmails = new Set(members.map(m => m.properties?.email?.toLowerCase()));
      const [activeUsers] = await conn.query(
        'SELECT GROUP_CONCAT(email) AS emails FROM users WHERE active = 1'
      );
      const localEmails = (activeUsers.emails || '').split(',').filter(Boolean);
      const missing = localEmails.filter(e => !weblingEmails.has(e.toLowerCase()));
      checks.push({ check: 'Aktive lokal, nicht in Webling', value: missing.length, warn: missing.length > 0 });
      if (missing.length) log.warn('Fehlend in Webling: ' + missing.join(', '));

    } catch (err) {
      checks.push({ check: 'Webling API', value: `Fehler: ${err.message}`, warn: true });
    }
  } else {
    checks.push({ check: 'Webling API', value: 'nicht konfiguriert – übersprungen' });
  }

  // ── Report ───────────────────────────────────────────────────────────────────

  const hasWarnings = checks.some(c => c.warn);

  log.info('');
  log.info('═══════════════════════════════════════');
  log.info('  Migrations-Verifikation');
  log.info('═══════════════════════════════════════');
  for (const c of checks) {
    const flag = c.warn ? ' ⚠️' : ' ✓';
    log.info(`  ${flag}  ${c.check}: ${c.value}`);
  }
  log.info('═══════════════════════════════════════');
  log.info(hasWarnings ? '  Status: WARNUNGEN vorhanden' : '  Status: OK');
  log.info('');

  return { ok: !hasWarnings, checks };
}

module.exports = { verify };
