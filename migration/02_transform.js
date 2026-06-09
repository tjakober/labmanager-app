'use strict';

/**
 * Phase 2 – Transform & Validate
 *
 * Maps Zynex CMS fields → local DB schema (spec §G.2).
 * Invalid rows are pushed to ctx.errors and excluded from output.
 */

// ── Date normalisation ─────────────────────────────────────────────────────────
// Accepts: 'DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', JS Date, null, ''

function normaliseDate(raw) {
  if (!raw || String(raw).trim() === '') return null;

  const s = String(raw).trim();

  // DD.MM.YYYY
  const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;

  // MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  return null;
}

function normaliseEmail(raw) {
  return String(raw || '').trim().toLowerCase() || null;
}

function normalisePhone(raw) {
  if (!raw) return null;
  // Keep digits, +, spaces, hyphens
  const cleaned = String(raw).replace(/[^\d+\s\-()]/g, '').trim();
  return cleaned || null;
}

// Zynex status → local status label (adapt to match actual Zynex values)
const STATUS_MAP = {
  'aktiv':         'aktiv',
  'active':        'aktiv',
  'passiv':        'passiv',
  'ex':            'ex',
  'ex-mitglied':   'ex',
  'ausgeschlossen':'ausgeschlossen',
  'excluded':      'ausgeschlossen',
};

function normaliseStatus(raw) {
  const s = String(raw || '').toLowerCase().trim();
  return STATUS_MAP[s] || 'ex';
}

// Zynex upgrade_typ → local upgrade_type
const UPGRADE_MAP = {
  'premium':      'Premium',
  'kommerziell':  'Kommerziell',
  'commercial':   'Kommerziell',
};

function normaliseUpgrade(raw) {
  if (!raw) return null;
  return UPGRADE_MAP[String(raw).toLowerCase().trim()] || null;
}

// ── Main transform ─────────────────────────────────────────────────────────────

function transform(ctx, rawRows) {
  const { log, errors } = ctx;
  const valid = [];

  for (const row of rawRows) {
    const lineNo = row._line || '?';
    const rowErrors = [];

    const email = normaliseEmail(row.email_p);
    if (!email) rowErrors.push({ field: 'email_p', error: 'Leer oder ungültig' });

    const name = String(row.name || '').trim();
    if (!name)  rowErrors.push({ field: 'name', error: 'Leer' });

    const vorname = String(row.vorname || '').trim();

    const memberSince = normaliseDate(row.mitglied_seit);
    const memberUntil = normaliseDate(row.datum_austritt);

    if (memberSince && memberUntil && memberSince > memberUntil) {
      rowErrors.push({ field: 'datum_austritt', error: 'Vor mitglied_seit' });
    }

    if (rowErrors.length) {
      for (const e of rowErrors) {
        errors.push({ line: lineNo, field: e.field, error: e.error, email: email || row.email_p });
      }
      log.warn(`Zeile ${lineNo}: ${rowErrors.length} Fehler – übersprungen`);
      continue;
    }

    valid.push({
      _zynex_id:     String(row.id || '').trim(),
      _line:         lineNo,
      name:          `${vorname} ${name}`.trim(),
      email,
      strasse:       String(row.strasse  || '').trim() || null,
      plz:           String(row.plz      || '').trim() || null,
      ort:           String(row.ort      || '').trim() || null,
      tel:           normalisePhone(row.tel_p),
      handy:         normalisePhone(row.handy_p),
      member_since:  memberSince,
      member_until:  memberUntil,
      status:        normaliseStatus(row.status),
      upgrade_type:  normaliseUpgrade(row.upgrade_typ),
    });
  }

  log.info(`Transform: ${valid.length} gültig, ${rawRows.length - valid.length} übersprungen`);
  return valid;
}

module.exports = { transform };
