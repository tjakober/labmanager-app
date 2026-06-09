'use strict';

/**
 * Phase 0 – Schema-Migration
 * Erweitert fachgruppen um beschreibung/bemerkung und
 * fügt zynex_id auf fachgruppen hinzu.
 * Idempotent: prüft Spalten via information_schema vor ALTER.
 */

const mariadb = require('mariadb');
const cfg     = require('../config');

async function migrateSchema() {
  const conn = await mariadb.createConnection({ ...cfg.target, dateStrings: true });
  try {
    // fachgruppen.beschreibung
    const [hasBeschr] = await conn.query(`
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fachgruppen' AND COLUMN_NAME = 'beschreibung'`);
    if (!hasBeschr) {
      await conn.query('ALTER TABLE fachgruppen ADD COLUMN beschreibung TEXT NULL');
      console.log('  + fachgruppen.beschreibung hinzugefügt');
    }

    // fachgruppen.bemerkung
    const [hasBemerk] = await conn.query(`
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fachgruppen' AND COLUMN_NAME = 'bemerkung'`);
    if (!hasBemerk) {
      await conn.query('ALTER TABLE fachgruppen ADD COLUMN bemerkung TEXT NULL');
      console.log('  + fachgruppen.bemerkung hinzugefügt');
    }

    // fachgruppen.zynex_group_id (für Idempotenz)
    const [hasZynexGid] = await conn.query(`
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fachgruppen' AND COLUMN_NAME = 'zynex_group_id'`);
    if (!hasZynexGid) {
      await conn.query('ALTER TABLE fachgruppen ADD COLUMN zynex_group_id INT NULL');
      console.log('  + fachgruppen.zynex_group_id hinzugefügt');
    }

    // users.membership_status (aktueller Zynex-Adresstyp, z.B. "Mitglied 2026 Basis")
    const [hasStatus] = await conn.query(`
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'membership_status'`);
    if (!hasStatus) {
      await conn.query('ALTER TABLE users ADD COLUMN membership_status VARCHAR(100) NULL');
      console.log('  + users.membership_status hinzugefügt');
    }

    console.log('  Schema-Migration abgeschlossen.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateSchema().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { migrateSchema };
