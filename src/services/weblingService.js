'use strict';

const axios = require('axios');
const cfg   = require('../config');

// Webling field keys for custom member properties (configure in Webling admin)
const FIELD = {
  balance:         process.env.WEBLING_FIELD_BALANCE          || 'Guthaben',
  upgradeStatus:   process.env.WEBLING_FIELD_UPGRADE_STATUS   || 'Upgrade',
  upgradeStart:    process.env.WEBLING_FIELD_UPGRADE_START    || 'Upgrade ab',
  upgradeAblauf:   process.env.WEBLING_FIELD_UPGRADE_ABLAUF   || 'Upgrade bis',
  upgradeHistory:  process.env.WEBLING_FIELD_UPGRADE_HISTORY  || 'Membership-History',
};

function client() {
  return axios.create({
    baseURL: cfg.webling.apiUrl,
    params:  { apikey: cfg.webling.apiKey },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30_000,
  });
}

// ── Member ─────────────────────────────────────────────────────────────────────

async function getMember(weblingId) {
  const { data } = await client().get(`/member/${weblingId}`);
  return data;
}

async function isActive(weblingId) {
  // Wird nicht mehr für Billing verwendet – Aktiv-Check erfolgt über lokale DB.
  // Existenz in Webling = ausreichend für Buchungen.
  const member = await getMember(weblingId).catch(() => null);
  return !!member;
}

async function updateMemberFields(weblingId, fields) {
  await client().put(`/member/${weblingId}`, { properties: fields });
}

// ── Balance (Modul E) ──────────────────────────────────────────────────────────

async function getBalance(weblingId) {
  const member = await getMember(weblingId);
  const raw = member?.properties?.[FIELD.balance];
  return raw != null ? parseFloat(raw) : 0;
}

async function setBalance(weblingId, newBalance) {
  await updateMemberFields(weblingId, { [FIELD.balance]: String(newBalance) });
}

// ── Accounting entries (Buchungen) ─────────────────────────────────────────────

async function bookEntry({ accountDebit, accountCredit, amount, date, reference, memberId }) {
  await client().post('/entry', {
    date,
    title:  reference,
    amount,
    debit:  accountDebit,
    credit: accountCredit,
    // link to member so the booking appears in their account view
    links:  memberId ? [{ type: 'member', id: memberId }] : [],
  });
}

async function bookDeposit(weblingId, amount, creditAccount, reference) {
  // Die Buchungs-Entrygroup wird via bookInvoice erstellt (Doppelerfassung vermeiden).
  // Hier nur das Guthaben-Feld auf dem Webling-Mitglied aktualisieren.
  const current = await getBalance(weblingId);
  await setBalance(weblingId, +(current + amount).toFixed(2));
}

// ── Invoice Booking ────────────────────────────────────────────────────────────

// In-memory cache: konto_nr (string) → Webling account ID (number)
let _accountCache = null;      // Map<string, number>
let _activePeriodId = null;    // number

async function _loadActivePeriod() {
  if (_activePeriodId) return _activePeriodId;
  const { data } = await client().get('/period');
  const ids = data.objects || [];
  // Load all period details and find the open one (or highest ID as fallback)
  const details = await Promise.all(ids.map(id => client().get('/period/' + id)));
  const open = details.find(r => r.data?.properties?.state === 'open');
  _activePeriodId = open
    ? Number(open.data.id || ids[details.indexOf(open)])
    : Math.max(...ids);
  return _activePeriodId;
}

async function _resolveAccountId(kontoNr) {
  if (!_accountCache) {
    // Load all account IDs, then batch-fetch in groups of 100
    const { data: list } = await client().get('/account');
    const allIds = list.objects || [];
    const activePeriodId = await _loadActivePeriod();

    _accountCache = new Map();
    for (let i = 0; i < allIds.length; i += 100) {
      const batch = allIds.slice(i, i + 100);
      const { data: accts } = await client().get('/account/' + batch.join(','));
      const rows = Array.isArray(accts) ? accts : [accts];
      for (const a of rows) {
        const title = a.properties?.title || '';
        // title format: "1000 Kasse", "3511 Lasersaur", etc.
        const num   = title.split(' ')[0];
        const id    = Number(a.id);
        if (!num) continue;
        // Keep the account with the highest ID (= most recent period) as the primary
        if (!_accountCache.has(num) || id > _accountCache.get(num)) {
          _accountCache.set(num, id);
        }
      }
    }
    console.log(`[weblingService] Account-Cache geladen: ${_accountCache.size} Konten, Periode ${activePeriodId}`);
  }

  const id = _accountCache.get(String(kontoNr));
  if (!id) throw new Error(`Webling-Konto ${kontoNr} nicht gefunden (evtl. Konto in Webling anlegen)`);
  return id;
}

/**
 * Bucht eine bezahlte Rechnung als Entrygroup in Webling.
 *
 * Buchungslogik:
 *   SOLL  (debit)  : paymode.konto_nr – Zahlungseingang (Kasse, Bank, etc.)
 *   HABEN (credit) : machine/article konto_nr – Erlöskonto
 *
 * Artikel mit is_balance_deposit=true werden nicht gebucht (bereits via bookDeposit).
 */
async function bookInvoice({ weblingId, invoiceId, userName, date, paymodeKontoNr, machineLines = [], articleItems = [] }) {
  if (!paymodeKontoNr) throw new Error('Kein Zahlungskonto (paymode.konto_nr) konfiguriert');

  // Haben-Positionen sammeln und nach Konto aggregieren
  const habenRaw = [
    ...machineLines
      .filter(l => l.konto_nr && l.price > 0)
      .map(l => ({ kontoNr: String(l.konto_nr), amount: l.price })),
    ...articleItems
      .filter(i => !i.is_balance_deposit && i.credit_account && Number(i.total) > 0)
      .map(i => ({ kontoNr: String(i.credit_account), amount: Number(i.total) })),
  ];
  if (!habenRaw.length) throw new Error('Keine buchbaren Positionen (konto_nr fehlt auf Maschinen/Artikeln)');

  const byKonto = {};
  for (const l of habenRaw) {
    byKonto[l.kontoNr] = +((byKonto[l.kontoNr] || 0) + l.amount).toFixed(2);
  }
  const total = +Object.values(byKonto).reduce((s, v) => s + v, 0).toFixed(2);

  // Alle Kontonummern → Webling-Account-IDs auflösen
  const sollId  = await _resolveAccountId(paymodeKontoNr);
  const habenIds = {};
  for (const [k, amt] of Object.entries(byKonto)) {
    habenIds[k] = { id: await _resolveAccountId(k), amount: amt };
  }

  const periodId = await _loadActivePeriod();
  const baseTitle = `Rechnung #${invoiceId}${userName ? ' – ' + userName : ''}`;

  // Pro Haben-Konto ein eigenes Entrygroup (Split-Entrygroups nicht erlaubt)
  const createdIds = [];
  for (const [kontoNr, { id: habenId, amount }] of Object.entries(habenIds)) {
    const payload = {
      type: 'entrygroup',
      properties: { title: `${baseTitle} (${kontoNr})`, date },
      parents:    [periodId],
      children: {
        entry: [{
          type:       'entry',
          properties: { amount },
          links:      { debit: [sollId], credit: [habenId] },
        }],
      },
    };
    try {
      const { data } = await client().post('/entrygroup', payload);
      const egId = typeof data === 'number' ? data : (data?.id ?? null);
      createdIds.push(egId);
    } catch (err) {
      const status = err.response?.status;
      const body   = JSON.stringify(err.response?.data);
      console.error(`[weblingService/bookInvoice] HTTP ${status} konto=${kontoNr} response=${body}`);
      throw new Error(`Webling ${status} (Konto ${kontoNr}): ${body}`);
    }
  }

  console.log(`[weblingService] Buchung Rechnung #${invoiceId} → Entrygroups ${createdIds.join(', ')}`);
  return createdIds[0] ?? null;
}

/**
 * Bucht eine Guthaben-Schenkung als Entrygroup in Webling und erhöht das Guthaben-Feld.
 * SOLL (debit): debitKontoNr (Schenkungskonto, z.B. Projektfonds)
 * HABEN (credit): creditKontoNr (Guthaben-Gegenkonto, aus Config balance.gift_credit_account)
 */
async function bookGift(weblingId, amount, debitKontoNr, creditKontoNr, reference) {
  const periodId  = await _loadActivePeriod();
  const debitId   = await _resolveAccountId(debitKontoNr);
  const creditId  = await _resolveAccountId(creditKontoNr);

  const payload = {
    type: 'entrygroup',
    properties: { title: reference, date: new Date().toISOString().slice(0, 10) },
    parents:    [periodId],
    children: {
      entry: [{
        type:       'entry',
        properties: { amount },
        links:      { debit: [debitId], credit: [creditId] },
      }],
    },
  };
  try {
    await client().post('/entrygroup', payload);
  } catch (err) {
    const status = err.response?.status;
    const body   = JSON.stringify(err.response?.data);
    throw new Error(`Webling ${status} (Buchung): ${body}`);
  }

  // Guthaben-Feld auf Member aktualisieren
  const current = await getBalance(weblingId);
  await setBalance(weblingId, +(current + amount).toFixed(2));
}

async function bookWithdraw(weblingId, amount, debitAccount, reference) {
  // Die Buchungs-Entrygroup wird via bookInvoice erstellt.
  // Hier nur das Guthaben-Feld auf dem Webling-Mitglied aktualisieren.
  const current = await getBalance(weblingId);
  await setBalance(weblingId, +(current - amount).toFixed(2));
}

// ── Upgrades (Modul F) ─────────────────────────────────────────────────────────

async function setUpgrade(weblingId, { upgradeType, startDate, expiryDate }) {
  await updateMemberFields(weblingId, {
    [FIELD.upgradeStatus]: upgradeType,
    [FIELD.upgradeStart]:  startDate,
    [FIELD.upgradeAblauf]: expiryDate,
  });
}

async function clearUpgrade(weblingId) {
  await updateMemberFields(weblingId, {
    [FIELD.upgradeStatus]: '',
    [FIELD.upgradeStart]:  '',
    [FIELD.upgradeAblauf]: '',
  });
}

async function updateUpgradeHistory(weblingId, historyArray) {
  await updateMemberFields(weblingId, {
    [FIELD.upgradeHistory]: JSON.stringify(historyArray),
  });
}

// ── Sync helpers (Modul H) ─────────────────────────────────────────────────────

async function getAllMembers() {
  const { data } = await client().get('/member');
  // Webling returns { objects: [...], meta: {...} }
  return data.objects || data;
}

async function createMember(properties, parentGroupId = null) {
  const payload = { properties };
  if (parentGroupId) payload.parents = [Number(parentGroupId)];
  const { data } = await client().post('/member', payload);
  return data;
}

async function deleteMember(weblingId) {
  await client().delete(`/member/${weblingId}`);
}

module.exports = {
  _client: client,
  getMember,
  isActive,
  updateMemberFields,
  getBalance,
  setBalance,
  bookDeposit,
  bookGift,
  bookWithdraw,
  bookInvoice,
  setUpgrade,
  clearUpgrade,
  updateUpgradeHistory,
  getAllMembers,
  createMember,
  deleteMember,
};
