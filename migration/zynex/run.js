'use strict';

/**
 * Zynex-Datenübernahme Orchestrator
 *
 * Phasen:
 *   0  Schema-Migration (neue Spalten in fachgruppen)
 *   1  Extraktion aus Zynex (MSSQL oder CSV)
 *   2  Transformation & Validierung
 *   3  Laden in lokale DB
 *   4  Webling-Sync (Adressen, Gruppen, Upgrade-History)
 *   5  Verifikation
 *
 * Verwendung:
 *   node migration/zynex/run.js                  # alle Phasen
 *   node migration/zynex/run.js --dry-run        # prüfen ohne Schreiben
 *   node migration/zynex/run.js --from-phase 3   # ab Phase 3 (cached)
 *   node migration/zynex/run.js --phase 4        # nur Phase 4
 *
 * Datenquellen (MSSQL bevorzugt, sonst CSV):
 *   MSSQL: MIGRATION_DB_HOST, MIGRATION_DB_PORT, MIGRATION_DB_NAME,
 *          MIGRATION_DB_USER, MIGRATION_DB_PASS in .env setzen
 *   CSV:   Dateien in migration/input/zynex/
 *          adressen.csv, gruppen.csv, adr_gruppen.csv,
 *          adresstypen.csv, upgrades.csv
 *
 * Spaltennamen-Anpassung (falls abweichend):
 *   ZYNEX_COL_ADR_ID, ZYNEX_COL_ADR_VORNAME, ZYNEX_COL_ADR_NAME, ... in .env
 *   ZYNEX_TABLE_ADRESSEN, ZYNEX_TABLE_GRUPPEN, ... in .env
 */

const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const config = require('../config');
const { migrateSchema } = require('./00_migrate_schema');
const { extract }       = require('./01_extract');
const { transform }     = require('./02_transform');
const { loadLocal }     = require('./03_load_local');
const { syncWebling }   = require('./04_sync_webling');
const { verify }        = require('./05_verify');

// ── CLI ────────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const dryRun    = args.includes('--dry-run');

function getFlag(flag) {
  const eq  = args.find(a => a.startsWith(`${flag}=`));
  if (eq) return parseInt(eq.split('=')[1]);
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx+1]) return parseInt(args[idx+1]);
  return null;
}

const onlyPhase = getFlag('--phase');
const fromPhase = getFlag('--from-phase') ?? 0;

function shouldRun(p) {
  if (onlyPhase !== null) return p === onlyPhase;
  return p >= fromPhase;
}

// ── Logging ────────────────────────────────────────────────────────────────────

const logEntries = [];
const errors     = [];
const log = {
  info:  m => { console.log(`  ${m}`);     logEntries.push({ level:'info',  m, ts: new Date().toISOString() }); },
  warn:  m => { console.warn(`  ⚠️  ${m}`); logEntries.push({ level:'warn',  m, ts: new Date().toISOString() }); },
  error: m => { console.error(`  ❌  ${m}`);logEntries.push({ level:'error', m, ts: new Date().toISOString() }); },
};

// ── Cache ──────────────────────────────────────────────────────────────────────

const CACHE = path.join(__dirname, '.cache.json');
const saveCache = d => fs.writeFileSync(CACHE, JSON.stringify(d, null, 2), 'utf8');
const loadCache = () => {
  if (!fs.existsSync(CACHE)) throw new Error('Kein Cache. Starte ohne --from-phase oder mit --from-phase 0.');
  return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
};

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  Zynex → FabLab Winti Datenübernahme    ║');
  console.log('╚══════════════════════════════════════════╝\n');
  if (dryRun) console.log('  *** DRY-RUN – kein Schreiben ***\n');

  const t0 = Date.now();
  let conn;

  try {
    conn = await mariadb.createConnection({ ...config.target, dateStrings: true });
    log.info(`DB: ${config.target.database}@${config.target.host}:${config.target.port}`);

    const ctx = { conn, config, log, errors, dryRun };

    // Phase 0: Schema
    if (shouldRun(0)) {
      console.log('\n── Phase 0: Schema-Migration ───────────────────────────');
      await migrateSchema();
    }

    let raw, data;

    // Phase 1: Extract
    if (shouldRun(1)) {
      console.log('\n── Phase 1: Extraktion aus Zynex ───────────────────────');
      raw = await extract(ctx);
      saveCache({ raw });
    } else {
      raw = loadCache().raw;
      log.info('Cache geladen');
    }

    // Phase 2: Transform
    if (shouldRun(2)) {
      console.log('\n── Phase 2: Transformation ─────────────────────────────');
      data = transform(ctx, raw);
      saveCache({ raw, data });
    } else {
      data = loadCache().data;
    }

    // Phase 3: Load local
    if (shouldRun(3)) {
      console.log('\n── Phase 3: Lokale DB ──────────────────────────────────');
      await loadLocal(ctx, data);
    }

    // Phase 4: Webling
    if (shouldRun(4)) {
      console.log('\n── Phase 4: Webling-Sync ───────────────────────────────');
      if (!config.webling.apiUrl || !config.webling.apiKey) {
        log.warn('WEBLING_API_URL/KEY nicht gesetzt – Phase 4 übersprungen');
      } else {
        await syncWebling(ctx, data);
      }
    }

    // Phase 5: Verify
    if (shouldRun(5)) {
      console.log('\n── Phase 5: Verifikation ───────────────────────────────');
      await verify(ctx);
    }

  } catch (err) {
    log.error(`Kritischer Fehler: ${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log.info(`Fertig in ${elapsed}s`);

  const logPath = path.join(__dirname, 'migration_log.json');
  fs.writeFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(), dryRun, elapsed: `${elapsed}s`,
    entries: logEntries, errorCount: errors.length,
  }, null, 2), 'utf8');

  if (errors.length) {
    const csvPath = path.join(__dirname, 'migration_errors.csv');
    fs.writeFileSync(csvPath,
      ['zynex_id,field,error', ...errors.map(e =>
        [e.line || '', e.field || '', `"${String(e.error||'').replace(/"/g,'""')}"`].join(',')
      )].join('\n'), 'utf8');
    console.log(`\n  ⚠️  ${errors.length} Fehler → ${csvPath}`);
  }
  console.log(`  Protokoll → ${logPath}\n`);
}

main();
