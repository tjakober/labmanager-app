'use strict';

/**
 * Phase 4 – Webling-Sync
 *
 * A. Adressen       → Member-Felder (Adresse, Kontakt, Eintritt, Austritt)
 * B. Adressgruppen  → Webling membergroup anlegen/verknüpfen
 * C. Aktueller Typ  → Webling Status-Felder + upgrade_history JSON
 * D. Upgrades       → upgrade_history JSON + aktives Upgrade in Member-Feldern
 */

const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeClient(cfg) {
  return axios.create({
    baseURL: cfg.webling.apiUrl,
    params:  { apikey: cfg.webling.apiKey },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
}

const FIELD = {
  upgradeStatus:  process.env.WEBLING_FIELD_UPGRADE_STATUS  || 'Upgrade',
  upgradeStart:   process.env.WEBLING_FIELD_UPGRADE_START   || 'Upgrade ab',
  upgradeAblauf:  process.env.WEBLING_FIELD_UPGRADE_ABLAUF  || 'Upgrade bis',
  upgradeHistory: process.env.WEBLING_FIELD_UPGRADE_HISTORY || 'Membership-History',
};

// ── A. Adressen → Webling Member-Felder ──────────────────────────────────────

// Zynex ist führendes System: alle Felder werden in bestehende Webling-Datensätze geschrieben.
async function syncAdressen({ conn, config, log, dryRun }, adressen) {
  const client = makeClient(config);
  let synced = 0, skipped = 0;

  for (const a of adressen) {
    const rows = await conn.query('SELECT webling_id FROM users WHERE zynex_id = ?', [a.zynex_id]);
    if (!rows.length || !rows[0].webling_id) { skipped++; continue; }
    const weblingId = Number(rows[0].webling_id);

    // Alle Zynex-Felder → Webling-Properties (Zynex ist führend)
    // 'Mitglieder ID' wird NICHT geschrieben – bei einigen Members autoincrement-geschützt
    const props = {};
    if (a.vorname)        props['Vorname']         = a.vorname;
    if (a.name)           props['Name']            = a.name;
    if (a.email)          props['E-Mail P']        = a.email;
    if (a.strasse)        props['Strasse']         = a.strasse;
    if (a.plz)            props['PLZ']             = a.plz;
    if (a.ort)            props['Ort']             = a.ort;
    if (a.tel)            props['Telefon P']       = a.tel;
    if (a.mobile)         props['Mobile P']        = a.mobile;
    if (a.firma)          props['Firma']           = a.firma;
    if (a.geburtsdatum)   props['Geburtsdatum']    = a.geburtsdatum;
    if (a.antragsDatum)   props['Datum Antrag']    = a.antragsDatum;
    if (a.eintrittsdatum) props['Eintrittsdatum']  = a.eintrittsdatum;
    if (a.austrittsdatum) props['Austrittsdatum']  = a.austrittsdatum;
    if (a.mitgliedBis)    props['Mitglied bis']    = a.mitgliedBis;
    if (a.notiz)          props['Bemerkungen']     = a.notiz;
    if (a.adressTypBez)   props['Status']          = a.adressTypBez;

    if (!dryRun) {
      try {
        await client.put(`/member/${weblingId}`, { properties: props });
        await sleep(config.webling.rateDelay);
      } catch (err) {
        log.warn(`Adresse ${a.zynex_id}: ${err.response?.status} ${err.message}`);
        continue;
      }
    }
    synced++;
  }
  log.info(`Adressen → Webling: ${synced} synced, ${skipped} ohne webling_id`);
}

// ── B. Adressgruppen → Webling membergroup + Zuordnungen ─────────────────────

async function syncGruppen({ conn, config, log, dryRun }, gruppen, adrGruppen) {
  const client = makeClient(config);

  // Alle bestehenden Webling-Gruppen laden
  const { data } = await client.get('/membergroup');
  const weblingGroups = [];
  const groupIds = Array.isArray(data) ? data : (data.objects || []);
  for (const gid of groupIds) {
    try {
      const { data: g } = await client.get(`/membergroup/${gid}`);
      weblingGroups.push({ id: gid, title: g.properties?.title });
      await sleep(50);
    } catch (_) {}
  }

  // Lokale Fachgruppen mit Webling-IDs
  const localGroups = await conn.query(
    'SELECT id, name, zynex_group_id, webling_group_id FROM fachgruppen WHERE zynex_group_id IS NOT NULL'
  );

  for (const g of gruppen) {
    const local = localGroups.find(l => Number(l.zynex_group_id) === g.zynex_group_id);
    let weblingGroupId = local?.webling_group_id
      || weblingGroups.find(wg => wg.title === g.name)?.id
      || null;

    if (!weblingGroupId && !dryRun) {
      try {
        const { data: created } = await client.post('/membergroup', {
          properties: { title: g.name },
        });
        weblingGroupId = typeof created === 'number' ? created : created?.id;
        await sleep(config.webling.rateDelay);
        log.info(`  Gruppe angelegt: «${g.name}» → Webling ${weblingGroupId}`);
      } catch (err) { log.warn(`Gruppe «${g.name}»: ${err.message}`); continue; }
    }

    if (weblingGroupId && !dryRun && local) {
      await conn.query('UPDATE fachgruppen SET webling_group_id = ? WHERE zynex_group_id = ?',
        [weblingGroupId, g.zynex_group_id]);
    }
  }

  // Mitglieder-Zuordnungen via parents-Array
  // Webling: Member gehören über parents[] zu Gruppen (nicht via links)
  let assigned = 0, skipped = 0;

  // Alle Zuordnungen nach Member gruppieren
  const byMember = {};
  for (const ag of adrGruppen) {
    const fg = await conn.query('SELECT webling_group_id FROM fachgruppen WHERE zynex_group_id = ?', [ag.zynex_group_id]);
    if (!fg.length || !fg[0].webling_group_id) continue;
    const ur = await conn.query('SELECT webling_id FROM users WHERE zynex_id = ?', [ag.zynex_adr_id]);
    if (!ur.length || !ur[0].webling_id) { skipped++; continue; }

    const wMemberId = Number(ur[0].webling_id);
    const wGroupId  = Number(fg[0].webling_group_id);
    if (!byMember[wMemberId]) byMember[wMemberId] = [];
    byMember[wMemberId].push(wGroupId);
  }

  for (const [wMemberId, groupIds] of Object.entries(byMember)) {
    if (!dryRun) {
      try {
        // Bestehende Parents laden
        const { data: m } = await client.get(`/member/${wMemberId}`);
        await sleep(50);
        const existingParents = m.parents || [];
        const newParents = [...new Set([...existingParents, ...groupIds])];

        if (newParents.length > existingParents.length) {
          await client.put(`/member/${wMemberId}`, { parents: newParents });
          await sleep(config.webling.rateDelay);
        }
        assigned++;
      } catch (err) {
        log.warn(`Gruppen-Zuordnung Member ${wMemberId}: ${err.message}`);
      }
    } else {
      assigned++;
    }
  }
  log.info(`Gruppen-Zuordnungen → Webling: ${assigned} Members, ${skipped} ohne webling_id`);
}

// ── C+D. upgrade_history JSON + aktuelles Upgrade ───────────────────────────

async function syncUpgradeHistory({ conn, config, log, dryRun }, adressen, upgrades) {
  const client = makeClient(config);

  const zynexIds = [...new Set([
    ...adressen.filter(a => a.adressTypBez).map(a => a.zynex_id),
    ...upgrades.map(u => u.zynex_adr_id),
  ])];

  let synced = 0;

  for (const zynexId of zynexIds) {
    const ur = await conn.query('SELECT id, webling_id, name FROM users WHERE zynex_id = ?', [zynexId]);
    if (!ur.length || !ur[0].webling_id) continue;

    const weblingId  = Number(ur[0].webling_id);
    const memberName = ur[0].name || '';
    const memberId   = Number(ur[0].id);

    // Bestehende History laden
    let history = [];
    try {
      const { data: member } = await client.get(`/member/${weblingId}`);
      await sleep(50);
      const raw = member?.properties?.[FIELD.upgradeHistory];
      if (raw) history = JSON.parse(raw);
    } catch (_) {}

    // C. Aktueller Mitgliedstyp
    const adr = adressen.find(a => a.zynex_id === zynexId);
    if (adr?.adressTypBez) {
      const key = `zynex:typ:${zynexId}`;
      const entry = {
        _key:           key,
        _typ:           'mitgliedschaft',
        member_id:      memberId,
        name:           memberName,
        bezeichnung:    adr.adressTypBez,
        eintrittsdatum: adr.eintrittsdatum,
        antragsDatum:   adr.antragsDatum,
        kuendigDatum:   adr.austrittsdatum || adr.mitgliedBis,
      };
      const idx = history.findIndex(h => h._key === key);
      if (idx === -1) {
        history.push(entry);
      } else {
        history[idx] = { ...history[idx], ...entry };
      }
    }

    // D. Upgrades
    const memberUpgr = upgrades.filter(u => u.zynex_adr_id === zynexId);
    let activeUpgrade = null;

    for (const u of memberUpgr) {
      const key = `zynex:upg:${zynexId}:${u.gueltigAb || ''}:${u.artikelId || ''}`;
      if (!history.find(h => h._key === key)) {
        history.push({
          _key: key, _typ: 'upgrade', member_id: memberId, name: memberName,
          typ: u.typ, gueltigAb: u.gueltigAb, gueltigBis: u.gueltigBis,
          zahlungsDatum: u.zahlungsDatum, zahlungsart: u.zahlungsart,
        });
      }
      if (u.isActive) activeUpgrade = u;
    }

    if (!dryRun) {
      try {
        const props = { [FIELD.upgradeHistory]: JSON.stringify(history) };

        // Aktuelles Upgrade in Upgrade-Felder schreiben
        // (Status-Feld ist in Webling schreibgeschützt – wird automatisch berechnet)
        if (activeUpgrade) {
          props[FIELD.upgradeStatus] = activeUpgrade.typ || '';
          props[FIELD.upgradeStart]  = activeUpgrade.gueltigAb  || '';
          props[FIELD.upgradeAblauf] = activeUpgrade.gueltigBis || '';
        }

        await client.put(`/member/${weblingId}`, { properties: props });
        await sleep(config.webling.rateDelay);
        synced++;
      } catch (err) {
        log.warn(`History ${zynexId}: ${err.message}`);
      }
    } else synced++;
  }
  log.info(`Upgrade-History → Webling: ${synced} Members aktualisiert`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function syncWebling(ctx, data) {
  const { adressen, gruppen, adrGruppen, upgrades } = data;

  console.log('\n  A. Adressen → Webling Member-Felder …');
  await syncAdressen(ctx, adressen);

  console.log('\n  B. Adressgruppen → Webling Fachgruppen …');
  await syncGruppen(ctx, gruppen, adrGruppen);

  console.log('\n  C+D. Upgrade-History → Webling …');
  await syncUpgradeHistory(ctx, adressen, upgrades);
}

module.exports = { syncWebling };
