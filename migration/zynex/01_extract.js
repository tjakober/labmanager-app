'use strict';

/**
 * Phase 1 – Extraktion aus Zynex
 *
 * Liest 5 Tabellen – primär via MSSQL (MIGRATION_DB_HOST gesetzt),
 * Fallback: CSV-Dateien in migration/input/zynex/.
 *
 * Tatsächliche Zynex-Spaltennamen (ermittelt aus Export 2026-06-02):
 *   adressen.csv:    adresse_id, vorname, name, email_p, strasse, plz, ort,
 *                    tel_p, handy_p, firma, geburtsdatum, anrede_id,
 *                    mitglied_seit, datum_austritt, mitglied_bis,
 *                    adress_typ_id, inaktiv, notiz
 *   gruppen.csv:     adressgruppe_id, bezeichnung, beschreibung
 *   adr_gruppen.csv: adresse_id, adressgruppe_id, aktiv, bemerkung
 *   adresstypen.csv: adress_typ_id, bezeichnung, mitgliedschaft_typ
 *                    (Lookup-Tabelle: "Mitglied 2026 Basis", "Extern", ...)
 *   upgrades.csv:    adresse_id, artikel_id, gueltig_ab, gueltig_bis,
 *                    bezahlt, zahlungsdatum, zahlungsart, sys_changelog
 *                    (sys_changelog enthält Artikel-Namen parsebar)
 *
 * Spaltennamen können via .env überschrieben werden (ZYNEX_COL_*).
 */

const fs       = require('fs');
const path     = require('path');

// ── Spaltennamen-Mapping ───────────────────────────────────────────────────────

const COL = {
  adressen: {
    id:             process.env.ZYNEX_COL_ADR_ID          || 'adresse_id',
    anredeId:       process.env.ZYNEX_COL_ADR_ANREDE       || 'anrede_id',
    vorname:        process.env.ZYNEX_COL_ADR_VORNAME      || 'vorname',
    name:           process.env.ZYNEX_COL_ADR_NAME         || 'name',
    email:          process.env.ZYNEX_COL_ADR_EMAIL        || 'email_p',
    strasse:        process.env.ZYNEX_COL_ADR_STRASSE      || 'strasse',
    plz:            process.env.ZYNEX_COL_ADR_PLZ          || 'plz',
    ort:            process.env.ZYNEX_COL_ADR_ORT          || 'ort',
    tel:            process.env.ZYNEX_COL_ADR_TEL          || 'tel_p',
    mobile:         process.env.ZYNEX_COL_ADR_MOBILE       || 'handy_p',
    firma:          process.env.ZYNEX_COL_ADR_FIRMA        || 'firma',
    geburtsdatum:   process.env.ZYNEX_COL_ADR_GEB          || 'geburtsdatum',
    eintrittsdatum: process.env.ZYNEX_COL_ADR_EINTRITT     || 'mitglied_seit',
    austrittsdatum: process.env.ZYNEX_COL_ADR_AUSTRITT     || 'datum_austritt',
    mitgliedBis:    process.env.ZYNEX_COL_ADR_BIS          || 'mitglied_bis',
    adressTypId:    process.env.ZYNEX_COL_ADR_TYP_ID       || 'adress_typ_id',
    inaktiv:        process.env.ZYNEX_COL_ADR_INAKTIV      || 'inaktiv',
    notiz:          process.env.ZYNEX_COL_ADR_NOTIZ        || 'notiz',
    datumAntrag:    process.env.ZYNEX_COL_ADR_ANTRAG       || 'datum_antrag',
  },
  gruppen: {
    id:          process.env.ZYNEX_COL_GRP_ID          || 'adressgruppe_id',
    name:        process.env.ZYNEX_COL_GRP_NAME        || 'bezeichnung',
    beschreibung:process.env.ZYNEX_COL_GRP_BESCHR      || 'beschreibung',
  },
  adrGruppen: {
    adrId:     process.env.ZYNEX_COL_ADRGRP_ADRID    || 'adresse_id',
    gruppeId:  process.env.ZYNEX_COL_ADRGRP_GRPID    || 'adressgruppe_id',
    aktiv:     process.env.ZYNEX_COL_ADRGRP_AKTIV    || 'aktiv',
    bemerkung: process.env.ZYNEX_COL_ADRGRP_BEMERK   || 'bemerkung',
  },
  adresstypen: {
    id:              process.env.ZYNEX_COL_ATYP_ID        || 'adress_typ_id',
    bezeichnung:     process.env.ZYNEX_COL_ATYP_BEZ       || 'bezeichnung',
    mitgliedschaftTyp: process.env.ZYNEX_COL_ATYP_MTYP   || 'mitgliedschaft_typ',
  },
  upgrades: {
    adrId:        process.env.ZYNEX_COL_UPG_ADRID    || 'adresse_id',
    artikelId:    process.env.ZYNEX_COL_UPG_ARTIKEL  || 'artikel_id',
    gueltigAb:    process.env.ZYNEX_COL_UPG_AB       || 'gueltig_ab',
    gueltigBis:   process.env.ZYNEX_COL_UPG_BIS      || 'gueltig_bis',
    bezahlt:      process.env.ZYNEX_COL_UPG_BEZAHLT  || 'bezahlt',
    zahlungsDatum:process.env.ZYNEX_COL_UPG_ZAHL     || 'zahlungsdatum',
    zahlungsart:  process.env.ZYNEX_COL_UPG_ZART     || 'zahlungsart',
    changelog:    process.env.ZYNEX_COL_UPG_LOG      || 'sys_changelog',
  },
};

const TABLE = {
  adressen:   process.env.ZYNEX_TABLE_ADRESSEN    || 'Adressen',
  gruppen:    process.env.ZYNEX_TABLE_GRUPPEN     || 'Adressgruppen',
  adrGruppen: process.env.ZYNEX_TABLE_ADR_GRUPPEN || 'Adressen_Gruppen',
  adresstypen:process.env.ZYNEX_TABLE_ADRESSTYPEN || 'Adresstypen',
  upgrades:   process.env.ZYNEX_TABLE_UPGRADES    || 'Upgrades',
};

// ── CSV ────────────────────────────────────────────────────────────────────────

// RFC-4180-konformer CSV-Parser mit Multi-Line-Support
// Liest die komplette Datei und verarbeitet mehrzeilige Felder (in "..." eingeschlossen)
function parseCsv(content, delimiter = ',') {
  const rows = [];
  let cur = '', inQuotes = false;
  const fields = [];

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') { cur += '"'; i++; }   // escaped quote
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      fields.push(cur); cur = '';
    } else if ((ch === '\r' && next === '\n') && !inQuotes) {
      fields.push(cur); cur = '';
      rows.push([...fields]); fields.length = 0; i++;     // skip \n
    } else if (ch === '\n' && !inQuotes) {
      fields.push(cur); cur = '';
      rows.push([...fields]); fields.length = 0;
    } else {
      cur += ch;
    }
  }
  if (cur || fields.length) { fields.push(cur); rows.push([...fields]); }
  return rows;
}

async function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return null;

  // Encoding auto-detektieren: BOM = UTF-8, sonst Windows-1252 probieren
  const raw = fs.readFileSync(filePath);
  let content;
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    // UTF-8 BOM
    content = raw.slice(3).toString('utf8');
  } else if (raw.toString('utf8').includes('�')) {
    // Kein gültiges UTF-8 → Windows-1252 / Latin-1
    content = raw.toString('latin1');
  } else {
    content = raw.toString('utf8');
  }

  // Trennzeichen auto-detektieren (Komma oder Semikolon)
  const firstLine = content.split(/\r?\n/)[0];
  const delimiter = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';

  const allRows = parseCsv(content, delimiter);
  if (allRows.length < 2) return [];

  const headers = allRows[0].map(h => h.trim());
  const rows = [];

  for (let i = 1; i < allRows.length; i++) {
    const cols = allRows[i];
    if (cols.length === 1 && !cols[0].trim()) continue; // Leerzeile
    if (cols.length < 2) continue;
    const row = {};
    headers.forEach((h, j) => { row[h] = (cols[j] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

// ── MSSQL ──────────────────────────────────────────────────────────────────────

async function queryMssql(pool, tableName) {
  const result = await pool.request().query(`SELECT * FROM [${tableName}]`);
  return result.recordset;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function extract(ctx) {
  const { config, log } = ctx;
  const csvDir = path.join(config.source.csvDir, 'zynex');

  if (config.source.dbHost) return extractMssql(ctx);
  return extractCsv(ctx, csvDir);
}

async function extractCsv({ log }, csvDir) {
  log.info(`Lese CSV-Dateien aus: ${csvDir}`);

  const load = async (name) => {
    const p = path.join(csvDir, `${name}.csv`);
    const rows = await readCsv(p);
    if (!rows) throw new Error(`CSV nicht gefunden: ${p}`);
    log.info(`  ${name}.csv: ${rows.length} Zeilen`);
    return rows;
  };

  return {
    adressen:    await load('adressen'),
    gruppen:     await load('gruppen'),
    adrGruppen:  await load('adr_gruppen'),
    adresstypen: await load('adresstypen'),
    upgrades:    await load('upgrades'),
    COL, TABLE,
  };
}

async function extractMssql({ config, log }) {
  let mssql;
  try { mssql = require('mssql'); }
  catch { throw new Error('MSSQL-Modus: npm i mssql ausführen'); }

  log.info(`Verbinde MSSQL: ${config.source.dbHost}/${config.source.dbName}`);
  const pool = await mssql.connect({
    server: config.source.dbHost, port: config.source.dbPort,
    database: config.source.dbName, user: config.source.dbUser,
    password: config.source.dbPass, options: { trustServerCertificate: true },
  });
  const load = async (key) => {
    const rows = await queryMssql(pool, TABLE[key]);
    log.info(`  ${TABLE[key]}: ${rows.length} Zeilen`);
    return rows;
  };
  const data = {
    adressen:    await load('adressen'),
    gruppen:     await load('gruppen'),
    adrGruppen:  await load('adrGruppen'),
    adresstypen: await load('adresstypen'),
    upgrades:    await load('upgrades'),
    COL, TABLE,
  };
  await pool.close();
  return data;
}

module.exports = { extract, COL, TABLE };
