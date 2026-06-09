'use strict';

/**
 * Phase 2 – Transformation & Normalisierung
 *
 * adresstypen.csv = Lookup-Tabelle (kein per-Member pro-Jahr-Log).
 * Der aktuelle Mitgliedstyp je Member steht in adressen.adress_typ_id.
 *
 * Upgrade-Artikel-Name wird aus sys_changelog geparst:
 *   "Artikel: [m_up_b>p Monats-Upgrade Basis > Premium]" → "Monats-Upgrade Basis > Premium"
 */

function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s || s === '0' || s === '00.00.0000' || s === '01.01.1900') return null;
  // DD/MM/YYYY (Zynex-Format)
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  // DD.MM.YYYY
  const m2 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function str(val) {
  const s = val != null ? String(val).trim() : '';
  return s || null;
}
function int(val) {
  const n = parseInt(val);
  return isNaN(n) ? null : n;
}
function bool(val) {
  if (val == null) return false;
  const s = String(val).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'ja' || s === 'yes';
}

// "Artikel: [Monats-Upgrade Basis > Premium]" → "Monats-Upgrade Basis > Premium"
function parseArtikelName(changelog) {
  if (!changelog) return null;
  const m = String(changelog).match(/Artikel:\s*\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

function transform({ log, errors }, raw) {
  const { adressen, gruppen, adrGruppen, adresstypen, upgrades, COL } = raw;

  // ── Adresstypen Lookup: id → { bezeichnung, isMitglied } ─────────────────

  const typLookup = {};
  for (const t of adresstypen) {
    const id = int(t[COL.adresstypen.id]);
    if (!id) continue;
    typLookup[id] = {
      bezeichnung:      str(t[COL.adresstypen.bezeichnung]) || '',
      isMitglied:       bool(t[COL.adresstypen.mitgliedschaftTyp]),
      mitgliedschaftTyp: str(t[COL.adresstypen.mitgliedschaftTyp]),
    };
  }
  log.info(`Adresstypen-Lookup: ${Object.keys(typLookup).length} Typen`);

  // ── Adressen ──────────────────────────────────────────────────────────────

  const today = new Date().toISOString().slice(0, 10);
  const adr = [];

  for (let i = 0; i < adressen.length; i++) {
    const r = adressen[i];
    const id = int(r[COL.adressen.id]);
    if (!id) { errors.push({ line: i+2, field: 'adresse_id', error: 'Keine ID' }); continue; }

    const adressTypId = int(r[COL.adressen.adressTypId]);
    const typInfo     = adressTypId ? typLookup[adressTypId] : null;
    const inaktiv     = bool(r[COL.adressen.inaktiv]);

    // Mitglied_bis: falls gesetzt und in der Vergangenheit → inaktiv
    const mitgliedBis = parseDate(r[COL.adressen.mitgliedBis]);
    const isActive    = !inaktiv && typInfo?.isMitglied &&
                        (!mitgliedBis || mitgliedBis >= today);

    adr.push({
      zynex_id:         id,
      vorname:          str(r[COL.adressen.vorname]),
      name:             str(r[COL.adressen.name]),
      email:            str(r[COL.adressen.email])?.toLowerCase() || null,
      strasse:          str(r[COL.adressen.strasse]),
      plz:              str(r[COL.adressen.plz]),
      ort:              str(r[COL.adressen.ort]),
      tel:              str(r[COL.adressen.tel]),
      mobile:           str(r[COL.adressen.mobile]),
      firma:            str(r[COL.adressen.firma]),
      geburtsdatum:     parseDate(r[COL.adressen.geburtsdatum]),
      eintrittsdatum:   parseDate(r[COL.adressen.eintrittsdatum]),
      austrittsdatum:   parseDate(r[COL.adressen.austrittsdatum]),
      mitgliedBis,
      adressTypId,
      adressTypBez:     typInfo?.bezeichnung || null,
      isMitglied:       typInfo?.isMitglied ?? false,
      isActive,
      notiz:            str(r[COL.adressen.notiz]),
      antragsDatum:     parseDate(r[COL.adressen.datumAntrag]),
    });
  }
  log.info(`Adressen transformiert: ${adr.length} (davon aktive Mitglieder: ${adr.filter(a => a.isActive).length})`);

  // ── Gruppen ──────────────────────────────────────────────────────────────

  const grp = gruppen.map(r => ({
    zynex_group_id: int(r[COL.gruppen.id]),
    name:           str(r[COL.gruppen.name]),
    beschreibung:   str(r[COL.gruppen.beschreibung]),
    bemerkung:      null,   // in adr_gruppen pro Mitglied, nicht pro Gruppe
  })).filter(g => g.zynex_group_id && g.name);
  log.info(`Gruppen transformiert: ${grp.length}`);

  // ── Adr-Gruppen ───────────────────────────────────────────────────────────

  const adrGrp = adrGruppen
    .filter(r => bool(r[COL.adrGruppen.aktiv]))
    .map(r => ({
      zynex_adr_id:   int(r[COL.adrGruppen.adrId]),
      zynex_group_id: int(r[COL.adrGruppen.gruppeId]),
      bemerkung:      str(r[COL.adrGruppen.bemerkung]),
    }))
    .filter(r => r.zynex_adr_id && r.zynex_group_id);
  log.info(`Adr-Gruppen Zuordnungen (aktiv): ${adrGrp.length}`);

  // ── Upgrades ──────────────────────────────────────────────────────────────

  const upgr = upgrades.map(r => {
    const adrId      = int(r[COL.upgrades.adrId]);
    if (!adrId) return null;
    const gueltigBis = parseDate(r[COL.upgrades.gueltigBis]);
    const artikelName = parseArtikelName(r[COL.upgrades.changelog]) || `Artikel ${r[COL.upgrades.artikelId]}`;
    return {
      zynex_adr_id:  adrId,
      typ:           artikelName,
      artikelId:     int(r[COL.upgrades.artikelId]),
      gueltigAb:     parseDate(r[COL.upgrades.gueltigAb]),
      gueltigBis,
      bezahlt:       bool(r[COL.upgrades.bezahlt]),
      zahlungsDatum: parseDate(r[COL.upgrades.zahlungsDatum]),
      zahlungsart:   str(r[COL.upgrades.zahlungsart]),
      isActive:      !gueltigBis || gueltigBis >= today,
    };
  }).filter(Boolean);
  log.info(`Upgrades transformiert: ${upgr.length} (davon aktiv: ${upgr.filter(u => u.isActive).length})`);

  if (errors.length) log.warn(`${errors.length} Transformationsfehler`);

  return { adressen: adr, gruppen: grp, adrGruppen: adrGrp, upgrades: upgr, typLookup };
}

module.exports = { transform };
