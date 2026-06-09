'use strict';

/**
 * Phase 1 – Extract from Zynex CMS
 *
 * Supported modes (auto-detected):
 *   CSV  – reads migration/input/mitglieder.csv (default)
 *   MSSQL – set MIGRATION_DB_HOST in .env (requires: npm i mssql)
 *
 * Expected CSV columns (Zynex export):
 *   id, vorname, name, email_p, strasse, plz, ort,
 *   tel_p, handy_p, mitglied_seit, datum_austritt, status, upgrade_typ
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

async function extract(ctx) {
  const { config, log } = ctx;

  if (config.source.dbHost) {
    return extractMssql(ctx);
  }
  return extractCsv(ctx);
}

// ── CSV ────────────────────────────────────────────────────────────────────────

async function extractCsv({ config, log }) {
  const file = path.join(config.source.csvDir, 'mitglieder.csv');

  if (!fs.existsSync(file)) {
    throw new Error(`CSV nicht gefunden: ${file}\nLege die Zynex-Exportdatei unter migration/input/mitglieder.csv ab.`);
  }

  log.info(`Lese CSV: ${file}`);

  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });

  let headers = null;
  let lineNo  = 0;

  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;

    const cols = parseCsvLine(line);

    if (!headers) {
      headers = cols.map(h => h.trim().toLowerCase());
      continue;
    }

    const row = {};
    headers.forEach((h, i) => { row[h] = (cols[i] || '').trim(); });
    row._line = lineNo;
    rows.push(row);
  }

  log.info(`${rows.length} Zeilen aus CSV gelesen`);
  return rows;
}

// RFC 4180-compliant CSV parser (handles quoted fields with commas)
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ── MSSQL (optional) ───────────────────────────────────────────────────────────

async function extractMssql({ config, log }) {
  let mssql;
  try {
    mssql = require('mssql');
  } catch {
    throw new Error('MSSQL-Modus: npm i mssql ausführen');
  }

  log.info(`Verbinde mit MSSQL: ${config.source.dbHost}/${config.source.dbName}`);

  const pool = await mssql.connect({
    server:   config.source.dbHost,
    port:     config.source.dbPort,
    database: config.source.dbName,
    user:     config.source.dbUser,
    password: config.source.dbPass,
    options:  { trustServerCertificate: true },
  });

  // Adjust this query to match the actual Zynex table/column names
  const result = await pool.request().query(`
    SELECT
      id,
      vorname, name, email_p,
      strasse, plz, ort,
      tel_p, handy_p,
      mitglied_seit, datum_austritt,
      status, upgrade_typ
    FROM mitglieder
    ORDER BY id
  `);

  await pool.close();
  log.info(`${result.recordset.length} Zeilen aus MSSQL gelesen`);
  return result.recordset;
}

module.exports = { extract };
