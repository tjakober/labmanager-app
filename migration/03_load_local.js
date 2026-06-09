'use strict';

/**
 * Phase 3 – Load into local MariaDB
 *
 * Idempotent: INSERT … ON DUPLICATE KEY UPDATE (keyed on email).
 * Expired upgrades are recorded in upgrade_history but NOT set on the user row
 * (per spec G.4: abgelaufene Upgrades nur lokal, nicht in Webling-Felder).
 */

async function loadLocal(ctx, rows) {
  const { conn, log, dryRun } = ctx;

  let inserted = 0;
  let updated  = 0;

  for (const row of rows) {
    if (dryRun) {
      log.info(`[dry-run] würde laden: ${row.email}`);
      inserted++;
      continue;
    }

    // Upsert user (email is the unique key before webling_id is known)
    const result = await conn.query(
      `INSERT INTO users (name, email, active, created_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         name      = VALUES(name),
         active    = VALUES(active)`,
      [
        row.name,
        row.email,
        row.status === 'aktiv' ? 1 : 0,
      ]
    );

    // insertId > 0 → new row; affectedRows = 2 → updated
    const userId = Number(result.insertId) || await _getUserId(conn, row.email);

    if (Number(result.insertId) > 0) inserted++;
    else updated++;

    // Record upgrade history if an upgrade type is set
    if (row.upgrade_type) {
      await _recordUpgradeHistory(conn, userId, row);
    }

    // Store Zynex ID in a temp column for cross-referencing during Webling sync
    // (column added by init.sql as zynex_id VARCHAR(50) NULL)
    await conn.query(
      `UPDATE users SET zynex_id = ? WHERE id = ?`,
      [row._zynex_id, userId]
    ).catch(() => {}); // silently skip if column doesn't exist yet
  }

  log.info(`Local load: ${inserted} neu, ${updated} aktualisiert`);
}

async function _getUserId(conn, email) {
  const rows = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
  return rows[0]?.id;
}

async function _recordUpgradeHistory(conn, userId, row) {
  // Expired upgrades (member_until set and in the past): only local, not to Webling
  const isExpired = row.member_until && row.member_until < new Date().toISOString().slice(0, 10);
  const eventType = isExpired ? 'revert' : 'upgrade';

  // Check if already recorded (idempotency)
  const existing = await conn.query(
    `SELECT id FROM upgrade_history WHERE member_id = ? AND event_type = ? LIMIT 1`,
    [userId, 'upgrade']
  );
  if (existing.length) return;

  await conn.query(
    `INSERT INTO upgrade_history
       (member_id, event_type, upgrade_type, start_date, expiry_date, created_at, note)
     VALUES (?, ?, ?, ?, ?, NOW(), 'Migriert aus Zynex CMS')`,
    [userId, eventType, row.upgrade_type, row.member_since, row.member_until]
  );
}

module.exports = { loadLocal };
