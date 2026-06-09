'use strict';

/**
 * Migration Orchestrator – Zynex CMS → Webling
 * Spec: Modul G
 *
 * Usage:
 *   node migration/run.js                   # alle Phasen
 *   node migration/run.js --dry-run         # alles prüfen, nichts schreiben
 *   node migration/run.js --phase 1         # nur Phase 1 (extract)
 *   node migration/run.js --from-phase 3    # ab Phase 3 (benötigt gecachte Daten)
 *
 * Output:
 *   migration/migration_log.json    # vollständiges Protokoll
 *   migration/migration_errors.csv  # Fehler-Datensätze
 */

const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const config = require('./config');
const { extract }     = require('./01_extract');
const { transform }   = require('./02_transform');
const { loadLocal }   = require('./03_load_local');
const { syncWebling } = require('./04_sync_webling');
const { verify }      = require('./05_verify');

// ── CLI args ───────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const dryRun    = args.includes('--dry-run');
const phaseArg  = args.find(a => a.startsWith('--phase=') || a === '--phase');
const fromArg   = args.find(a => a.startsWith('--from-phase=') || a === '--from-phase');

function getArgValue(flag) {
  const eqForm  = args.find(a => a.startsWith(`${flag}=`));
  if (eqForm) return parseInt(eqForm.split('=')[1]);
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return parseInt(args[idx + 1]);
  return null;
}

const onlyPhase = phaseArg ? getArgValue('--phase')      : null;
const fromPhase = fromArg  ? getArgValue('--from-phase') : 1;

// ── Logging ────────────────────────────────────────────────────────────────────

const logEntries = [];
const errors     = [];

const log = {
  info:  (msg) => { console.log(`  ${msg}`); logEntries.push({ level: 'info',  msg, ts: new Date().toISOString() }); },
  warn:  (msg) => { console.warn(`  ⚠️  ${msg}`); logEntries.push({ level: 'warn',  msg, ts: new Date().toISOString() }); },
  error: (msg) => { console.error(`  ❌  ${msg}`); logEntries.push({ level: 'error', msg, ts: new Date().toISOString() }); },
};

// ── Cache (for --from-phase) ───────────────────────────────────────────────────

const CACHE_FILE = path.join(__dirname, '.migration_cache.json');

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) throw new Error('Kein Cache gefunden. Starte mit --phase 1 oder ohne Flag.');
  return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
}

// ── Phase runner ───────────────────────────────────────────────────────────────

function shouldRun(phase) {
  if (onlyPhase !== null) return phase === onlyPhase;
  return phase >= fromPhase;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  FabLab Winti – Datenmigration           ║');
  console.log('║  Zynex CMS → Webling                     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  if (dryRun) console.log('  *** DRY-RUN – keine Änderungen werden geschrieben ***\n');

  const startTime = Date.now();
  let conn;

  try {
    // ── DB connection ──────────────────────────────────────────────────────────
    conn = await mariadb.createConnection(config.target);
    log.info(`DB verbunden: ${config.target.database}@${config.target.host}`);

    const ctx = { conn, config, log, errors, dryRun };

    let rawRows, validRows;

    // ── Phase 1: Extract ───────────────────────────────────────────────────────
    if (shouldRun(1)) {
      console.log('\n── Phase 1: Extraktion aus Zynex CMS ──────────────────');
      rawRows = await extract(ctx);
      saveCache({ rawRows });
    } else {
      rawRows = loadCache().rawRows;
      log.info(`Cache geladen: ${rawRows.length} Zeilen`);
    }

    // ── Phase 2: Transform ─────────────────────────────────────────────────────
    if (shouldRun(2)) {
      console.log('\n── Phase 2: Transformation & Validierung ───────────────');
      validRows = transform(ctx, rawRows);
      saveCache({ rawRows, validRows });
    } else {
      validRows = loadCache().validRows;
      log.info(`Cache geladen: ${validRows.length} valide Zeilen`);
    }

    // ── Phase 3: Load local ────────────────────────────────────────────────────
    if (shouldRun(3)) {
      console.log('\n── Phase 3: Laden in lokale Datenbank ──────────────────');
      await loadLocal(ctx, validRows);
    }

    // ── Phase 4: Sync to Webling ───────────────────────────────────────────────
    if (shouldRun(4)) {
      console.log('\n── Phase 4: Webling-Sync ───────────────────────────────');
      if (!config.webling.apiUrl || !config.webling.apiKey) {
        log.warn('WEBLING_API_URL / WEBLING_API_KEY nicht gesetzt – Phase 4 übersprungen');
      } else {
        await syncWebling(ctx, validRows);
      }
    }

    // ── Phase 5: Verify ────────────────────────────────────────────────────────
    if (shouldRun(5)) {
      console.log('\n── Phase 5: Verifikation ───────────────────────────────');
      await verify(ctx);
    }

  } catch (err) {
    log.error(`Kritischer Fehler: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }

  // ── Write log & error report ───────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Fertig in ${elapsed}s`);

  const logPath = path.join(__dirname, 'migration_log.json');
  fs.writeFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    dryRun,
    elapsed:   `${elapsed}s`,
    entries:   logEntries,
    errorCount: errors.length,
  }, null, 2), 'utf8');

  if (errors.length) {
    const csvPath  = path.join(__dirname, 'migration_errors.csv');
    const csvLines = ['line,field,email,error', ...errors.map(e =>
      [e.line, e.field, e.email || '', `"${String(e.error).replace(/"/g, '""')}"`].join(',')
    )];
    fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
    console.log(`\n  ⚠️  ${errors.length} Fehler → ${csvPath}`);
  }

  console.log(`\n  Protokoll → ${logPath}\n`);
}

main();
