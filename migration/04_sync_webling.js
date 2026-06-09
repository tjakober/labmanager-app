'use strict';

/**
 * Phase 4 – Sync active members to Webling
 *
 * Only active members are pushed to Webling (spec G.1, H.1).
 * After Webling creates/returns the member, the webling_id is stored locally.
 *
 * API order per spec G.4:
 *   1. Ensure address groups exist (adressgruppe)
 *   2. Create/update members (adressen)
 *   3. Link member to group (adressgruppe_mitglied)
 */

const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function weblingClient(config) {
  return axios.create({
    baseURL: config.webling.apiUrl,
    params:  { apikey: config.webling.apiKey },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
}

// ── Group management ───────────────────────────────────────────────────────────

async function ensureGroup(client, groupName) {
  const { data } = await client.get('/membergroup');
  const groups   = Array.isArray(data) ? data : (data.objects || []);
  const existing = groups.find(g => g.properties?.title === groupName);

  if (existing) return existing.id;

  const { data: created } = await client.post('/membergroup', {
    properties: { title: groupName },
  });
  return created.id;
}

// ── Member sync ────────────────────────────────────────────────────────────────

async function syncWebling(ctx, rows) {
  const { conn, config, log, errors, dryRun } = ctx;
  const client = weblingClient(config);

  // Only sync active members to Webling (spec G.1 Phase 3)
  const active = rows.filter(r => r.status === 'aktiv');
  log.info(`Webling-Sync: ${active.length} aktive Mitglieder`);

  // Ensure the "Aktiv" group exists
  let groupId;
  if (!dryRun) {
    groupId = await ensureGroup(client, 'Aktiv');
    log.info(`Webling Gruppe "Aktiv": id=${groupId}`);
  }

  let synced  = 0;
  let skipped = 0;

  for (const row of active) {
    // Check if already synced (has webling_id in local DB)
    const local = await conn.query(
      'SELECT id, webling_id FROM users WHERE email = ?',
      [row.email]
    );
    const user = local[0];
    if (!user) { skipped++; continue; }

    if (dryRun) {
      log.info(`[dry-run] würde synchen: ${row.email}`);
      synced++;
      await sleep(0);
      continue;
    }

    const memberPayload = buildMemberPayload(row);

    try {
      let weblingId = user.webling_id;

      if (weblingId) {
        // Update existing member
        await client.put(`/member/${weblingId}`, { properties: memberPayload });
      } else {
        // Create new member and link to group
        const { data } = await client.post(`/member`, {
          parents:    [groupId],
          properties: memberPayload,
        });
        weblingId = data.id;

        // Store webling_id locally
        await conn.query(
          'UPDATE users SET webling_id = ? WHERE id = ?',
          [weblingId, user.id]
        );
      }

      synced++;
      log.info(`Synched: ${row.email} → webling_id=${weblingId}`);

    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      errors.push({ line: row._line, field: 'webling_sync', error: msg, email: row.email });
      log.warn(`Webling-Fehler für ${row.email}: ${msg}`);
    }

    // Rate limiting
    await sleep(config.webling.rateDelay);
  }

  log.info(`Webling-Sync: ${synced} synchronisiert, ${skipped} übersprungen`);
}

function buildMemberPayload(row) {
  // Map local fields → Webling member properties
  // Field names must match your Webling member form configuration
  return {
    firstName:    (row.name || '').split(' ')[0],
    lastName:     (row.name || '').split(' ').slice(1).join(' ') || row.name,
    email:        row.email,
    address:      row.strasse   || '',
    zip:          row.plz       || '',
    city:         row.ort       || '',
    phone:        row.tel       || '',
    mobile:       row.handy     || '',
    memberSince:  row.member_since || '',
    memberUntil:  row.member_until || '',
  };
}

module.exports = { syncWebling };
