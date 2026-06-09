'use strict';

/**
 * Phase 3 – Laden in lokale Datenbank (idempotent)
 *
 * users:            upsert via zynex_id; name+email; active nur setzen wenn isMitglied
 * fachgruppen:      upsert via zynex_group_id
 * upgrade_history:  je Member einen Eintrag für aktuellen Typ + je Upgrade-Datensatz
 *                   Idempotenz via note-Feld (enthält zynex-Schlüssel)
 */

async function loadLocal({ conn, log, dryRun }, data) {
  const { adressen, gruppen, upgrades } = data;

  // ── 1. Users ───────────────────────────────────────────────────────────────

  let newUsers = 0, updatedUsers = 0;

  for (const a of adressen) {
    const fullName = [a.vorname, a.name].filter(Boolean).join(' ');
    if (!fullName) continue;

    const existing = await conn.query('SELECT id, email FROM users WHERE zynex_id = ?', [a.zynex_id]);

    if (!dryRun) {
      if (existing.length) {
        await conn.query('UPDATE users SET name = ? WHERE zynex_id = ?', [fullName, a.zynex_id]);
        if (a.email && !existing[0].email) {
          await conn.query(
            'UPDATE users SET email = ? WHERE zynex_id = ? AND (email IS NULL OR email = "")',
            [a.email, a.zynex_id]
          );
        }
        updatedUsers++;
      } else {
        // 1. Versuch: Match über E-Mail
        let matched = null;
        if (a.email) {
          const byEmail = await conn.query(
            'SELECT id FROM users WHERE email = ? AND zynex_id IS NULL', [a.email]
          );
          if (byEmail.length) matched = byEmail[0];
        }

        // 2. Versuch: Match über webling_meta "Mitglieder ID"
        if (!matched) {
          const byMeta = await conn.query(
            `SELECT id FROM users WHERE zynex_id IS NULL
             AND webling_meta IS NOT NULL
             AND JSON_UNQUOTE(JSON_EXTRACT(webling_meta, '$.properties."Mitglieder ID"')) = ?`,
            [String(a.zynex_id)]
          );
          if (byMeta.length) matched = byMeta[0];
        }

        if (matched) {
          await conn.query('UPDATE users SET zynex_id = ? WHERE id = ?',
            [a.zynex_id, Number(matched.id)]);
          updatedUsers++;
        } else if (a.email) {
          await conn.query(
            'INSERT IGNORE INTO users (zynex_id, name, email, active) VALUES (?, ?, ?, ?)',
            [a.zynex_id, fullName, a.email, a.isActive ? 1 : 0]
          );
          newUsers++;
        }
      }
    } else {
      updatedUsers++;
    }
  }
  log.info(`Users: ${newUsers} neu, ${updatedUsers} aktualisiert`);

  // ── 1b. membership_status + webling_meta simulieren ──────────────────────

  let statusUpdated = 0, metaSimulated = 0;

  for (const a of adressen) {
    const user = await conn.query(
      'SELECT id, webling_id, membership_status FROM users WHERE zynex_id = ?', [a.zynex_id]
    );
    if (!user.length) continue;
    const uid = Number(user[0].id);

    if (!dryRun) {
      // membership_status immer aktualisieren
      if (a.adressTypBez && a.adressTypBez !== user[0].membership_status) {
        await conn.query('UPDATE users SET membership_status = ? WHERE id = ?',
          [a.adressTypBez, uid]);
        statusUpdated++;
      }

      // webling_meta nur für Users OHNE webling_id simulieren
      // (Users mit webling_id bekommen echte Daten vom Webling-Sync)
      if (!user[0].webling_id) {
        const syntheticMeta = JSON.stringify({
          _source: 'zynex',
          type: 'member',
          id: null,
          properties: {
            'Mitglieder ID':  a.zynex_id,
            'Vorname':        a.vorname        || '',
            'Name':           a.name           || '',
            'E-Mail P':       a.email          || '',
            'Datum Antrag':   a.antragsDatum   || '',
            'Strasse':        a.strasse        || '',
            'PLZ':            a.plz            || '',
            'Ort':            a.ort            || '',
            'Telefon P':      a.tel            || '',
            'Mobile P':       a.mobile         || '',
            'Firma':          a.firma          || '',
            'Anrede':         '',
            'Geburtsdatum':   a.geburtsdatum   || '',
            'Eintrittsdatum': a.eintrittsdatum || '',
            'Austrittsdatum': a.austrittsdatum || '',
            'Bemerkungen':    a.notiz          || '',
            'Status':         a.adressTypBez   || '',
          },
        });
        await conn.query(
          'UPDATE users SET webling_meta = ? WHERE id = ?',
          [syntheticMeta, uid]
        );
        metaSimulated++;
      }
    } else {
      if (a.adressTypBez) statusUpdated++;
      if (!user[0].webling_id) metaSimulated++;
    }
  }
  log.info(`membership_status aktualisiert: ${statusUpdated}`);
  log.info(`webling_meta simuliert (Zynex-only): ${metaSimulated}`);

  // ── 2. Fachgruppen ─────────────────────────────────────────────────────────

  let upsertedGrp = 0;
  for (const g of gruppen) {
    if (!dryRun) {
      // 1. Suche via zynex_group_id
      let ex = await conn.query('SELECT id FROM fachgruppen WHERE zynex_group_id = ?', [g.zynex_group_id]);
      if (!ex.length) {
        // 2. Fallback: suche via Name (z.B. bereits aus Webling-Sync vorhanden)
        ex = await conn.query('SELECT id FROM fachgruppen WHERE name = ?', [g.name]);
      }
      if (ex.length) {
        await conn.query(
          'UPDATE fachgruppen SET name=?, beschreibung=?, zynex_group_id=? WHERE id=?',
          [g.name, g.beschreibung || null, g.zynex_group_id, Number(ex[0].id)]
        );
      } else {
        await conn.query(
          'INSERT INTO fachgruppen (name, zynex_group_id, beschreibung) VALUES (?, ?, ?)',
          [g.name, g.zynex_group_id, g.beschreibung || null]
        );
      }
    }
    upsertedGrp++;
  }
  log.info(`Fachgruppen: ${upsertedGrp} verarbeitet`);

  // ── 3. Upgrade-History: aktueller Mitgliedstyp ────────────────────────────

  let insTyp = 0;
  for (const a of adressen) {
    if (!a.adressTypBez) continue;
    const user = await conn.query('SELECT id FROM users WHERE zynex_id = ?', [a.zynex_id]);
    if (!user.length) continue;
    const memberId = Number(user[0].id);

    const key = `zynex:typ:${a.zynex_id}`;
    const ex  = await conn.query(
      'SELECT id FROM upgrade_history WHERE member_id = ? AND note LIKE ?',
      [memberId, `%${key}%`]
    );

    if (!dryRun) {
      const noteJson = JSON.stringify({
        key, bezeichnung: a.adressTypBez,
        eintrittsdatum:  a.eintrittsdatum,
        antragsDatum:    a.antragsDatum,
        kuendigDatum:    a.austrittsdatum || a.mitgliedBis,
      });
      if (ex.length) {
        // Update bestehenden Eintrag (Typ kann sich jedes Jahr ändern)
        await conn.query('UPDATE upgrade_history SET upgrade_type=?, note=? WHERE id=?',
          [a.adressTypBez.slice(0, 30), noteJson, Number(ex[0].id)]);
      } else {
        await conn.query(`
          INSERT INTO upgrade_history (member_id, event_type, upgrade_type, start_date, created_at, note)
          VALUES (?, 'upgrade', ?, ?, NOW(), ?)`,
          [memberId, a.adressTypBez.slice(0, 30), a.eintrittsdatum || null, noteJson]
        );
        insTyp++;
      }
    } else insTyp++;
  }
  log.info(`Mitgliedstypen → upgrade_history: ${insTyp} neu`);

  // ── 4. Upgrade-History: Upgrades ──────────────────────────────────────────

  let insUpgr = 0;
  for (const u of upgrades) {
    const user = await conn.query('SELECT id FROM users WHERE zynex_id = ?', [u.zynex_adr_id]);
    if (!user.length) continue;
    const memberId = Number(user[0].id);

    const key = `zynex:upg:${u.zynex_adr_id}:${u.gueltigAb || ''}:${u.artikelId || ''}`;
    const ex  = await conn.query(
      'SELECT id FROM upgrade_history WHERE member_id = ? AND note LIKE ?',
      [memberId, `%${key}%`]
    );
    if (ex.length) continue;

    if (!dryRun) {
      await conn.query(`
        INSERT INTO upgrade_history
          (member_id, event_type, upgrade_type, start_date, expiry_date, created_at, note)
        VALUES (?, 'upgrade', ?, ?, ?, NOW(), ?)`,
        [memberId, u.typ?.slice(0, 30) || 'Upgrade', u.gueltigAb || null, u.gueltigBis || null,
         JSON.stringify({ key, typ: u.typ, gueltigAb: u.gueltigAb, gueltigBis: u.gueltigBis,
           zahlungsDatum: u.zahlungsDatum, zahlungsart: u.zahlungsart })]
      );
    }
    insUpgr++;
  }
  log.info(`Upgrades → upgrade_history: ${insUpgr} neu`);
}

module.exports = { loadLocal };
