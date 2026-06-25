'use strict';

const PDFDocument = require('pdfkit');
const db          = require('../db/pool');
const Q           = require('../db/queries');

// ── Billing formula (Spec §5.2) ────────────────────────────────────────────────
//
// period is stored in MINUTES in the DB.
// for each machine in log:
//   base  = min_periods * (min_price ?? price)
//   if usageSeconds <= min_periods * periodSeconds:
//     total = base
//   else:
//     extraPeriods = ceil((usageSeconds - min_periods * periodSeconds) / periodSeconds)
//     total = base + extraPeriods * price

// Sessions on the same machine+day are aggregated before calling this.
// min_periods is therefore only applied once per machine per day.
function calcMachinePrice(usageSeconds, machine) {
  const { period, min_periods, min_price, price } = machine;
  const periodSeconds = period * 60;   // period stored in minutes → convert to seconds
  const unitPrice     = parseFloat(price);
  const baseRate      = min_price != null ? parseFloat(min_price) : unitPrice;
  const base          = min_periods * baseRate;

  if (usageSeconds <= min_periods * periodSeconds) {
    return base;
  }

  const extraPeriods = Math.ceil((usageSeconds - min_periods * periodSeconds) / periodSeconds);
  return base + extraPeriods * unitPrice;
}

// ── Session pairing ────────────────────────────────────────────────────────────
// Groups log rows by machine+day. Returns one line per machine per day.
// Each line includes startIso (first session start), usageSeconds, logIds.

function pairSessions(logRows) {
  const byMachine = {};

  for (const row of logRows) {
    const mid = String(Number(row.machine_id));
    if (!byMachine[mid]) byMachine[mid] = [];
    byMachine[mid].push(row);
  }

  const dayBuckets = {};

  for (const [machineId, rows] of Object.entries(byMachine)) {
    let openStart = null;

    for (const row of rows) {
      if (row.event_name === 'start' || row.event_name === 'login') {
        openStart = row;
      } else if ((row.event_name === 'stop' || row.event_name === 'logout') && openStart) {
        const startTs = new Date(String(openStart.created_at).replace(' ', 'T')).getTime();
        const stopTs  = new Date(String(row.created_at).replace(' ', 'T')).getTime();
        const seconds = Math.max(0, Math.round((stopTs - startTs) / 1000));
        const day     = String(openStart.created_at).slice(0, 10);
        const key     = `${machineId}:${day}`;

        if (!dayBuckets[key]) {
          dayBuckets[key] = {
            machine_id:   Number(machineId),
            machine_name: row.machine_name,
            period:       row.period,
            min_periods:  row.min_periods,
            min_price:    row.min_price,
            price:        row.price,
            konto_nr:     row.konto_nr || null,
            usageSeconds: 0,
            logIds:       [],
            startIso:     String(openStart.created_at),
          };
        }
        dayBuckets[key].usageSeconds += seconds;
        dayBuckets[key].logIds.push(Number(openStart.id), Number(row.id));
        openStart = null;
      }
    }
  }

  return Object.values(dayBuckets);
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function previewInvoice(userId) {
  const logs     = await db.query(Q.getOpenLogsForUser, [userId]);
  const sessions = pairSessions(logs);

  return sessions.map(s => ({
    machine_id:   s.machine_id,
    machine_name: s.machine_name,
    usageSeconds: s.usageSeconds,
    startIso:     s.startIso,
    konto_nr:     s.konto_nr || null,
    price:        +calcMachinePrice(s.usageSeconds, s).toFixed(2),
  }));
}

async function createInvoice(userId, paymodeId = null, extraItems = [], createdBy = null) {
  const logs     = await db.query(Q.getOpenLogsForUser, [userId]);
  const sessions = pairSessions(logs);

  if (!sessions.length && !extraItems.length) {
    throw new Error('Keine offenen Posten und keine Artikel vorhanden');
  }

  const lines = sessions.map(s => ({
    machine_id:   s.machine_id,
    machine_name: s.machine_name,
    period:       s.period,
    min_periods:  s.min_periods,
    min_price:    s.min_price,
    price:        s.price,
    usageSeconds: s.usageSeconds,
    konto_nr:     s.konto_nr,
    startIso:     s.startIso,
    linePrice:    +calcMachinePrice(s.usageSeconds, s).toFixed(2),
    logIds:       s.logIds,
  }));

  const machineTotal = +lines.reduce((sum, l) => sum + l.linePrice, 0).toFixed(2);
  const itemsTotal   = +extraItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0).toFixed(2);
  const total        = +(machineTotal + itemsTotal).toFixed(2);
  const allIds       = lines.flatMap(l => l.logIds);

  let conn;
  let invoiceId;

  try {
    conn = await db.pool.getConnection();
    await conn.beginTransaction();

    const result = await conn.query(Q.createInvoice, [userId, total, paymodeId, createdBy || null]);
    invoiceId = Number(result.insertId);

    if (allIds.length) {
      await conn.query(Q.markLogsInvoiced, [invoiceId, allIds]);
    }

    // Maschinenzeilen in neue Tabelle schreiben
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await conn.query(Q.insertMachineLine, [
        invoiceId,
        l.machine_id,
        l.machine_name,
        l.usageSeconds,
        l.period,
        l.min_periods,
        l.min_price != null ? parseFloat(l.min_price) : null,
        parseFloat(l.price),
        l.linePrice,
        l.konto_nr || null,
        l.startIso || null,
        i,
      ]);
    }

    for (const item of extraItems) {
      const itemTotal = +(item.quantity * item.unit_price).toFixed(2);
      await conn.query(Q.insertInvoiceItem, [
        invoiceId, item.description, item.quantity, item.unit_price, itemTotal, item.credit_account || null, 0,
      ]);
    }

    await conn.commit();
  } catch (err) {
    if (conn) await conn.rollback();
    throw err;
  } finally {
    if (conn) conn.release();
  }

  return { invoiceId, total, lines };
}

/**
 * Berechnet den Preis einer Maschinenzeile neu anhand der gespeicherten Tariffelder.
 * Wird aufgerufen wenn der Benutzer die Nutzungszeit einer Zeile ändert.
 */
async function recalcMachineLine(invoiceId, lineId, newUsageSeconds) {
  const rows = await db.query(Q.getMachineLines, [invoiceId]);
  const line = rows.find(r => Number(r.id) === Number(lineId));
  if (!line) throw new Error(`Maschinenzeile ${lineId} nicht gefunden`);

  const newPrice = +calcMachinePrice(newUsageSeconds, {
    period:      Number(line.period),
    min_periods: Number(line.min_periods),
    min_price:   line.min_price != null ? parseFloat(line.min_price) : null,
    price:       parseFloat(line.price),
  }).toFixed(2);

  await db.query(Q.updateMachineLineUsage, [newUsageSeconds, newPrice, lineId, invoiceId]);
  return { usage_seconds: newUsageSeconds, line_price: newPrice };
}

/**
 * Liest Maschinenzeilen aus invoice_machine_lines.
 * Fallback auf Logs-Rekonstruktion falls keine Zeilen vorhanden (Altdaten).
 */
async function getInvoiceMachineLines(invoiceId) {
  const rows = await db.query(Q.getMachineLines, [invoiceId]);
  if (rows.length > 0) {
    return rows.map(r => ({
      id:           Number(r.id),
      machine_id:   r.machine_id ? Number(r.machine_id) : null,
      machine_name: r.machine_name,
      usageSeconds: Number(r.usage_seconds),
      startIso:     r.start_iso || null,
      konto_nr:     r.konto_nr || null,
      price:        parseFloat(r.line_price),
    }));
  }
  // Fallback: aus Logs rekonstruieren (Rechnungen vor Migration)
  const logRows = await db.query(Q.getLogsForInvoice, [invoiceId]);
  return pairSessions(logRows).map(s => ({
    id:           null,
    machine_name: s.machine_name,
    usageSeconds: s.usageSeconds,
    startIso:     s.startIso,
    konto_nr:     s.konto_nr,
    price:        +calcMachinePrice(s.usageSeconds, s).toFixed(2),
  }));
}

async function generateInvoicePdf(invoiceId, userId) {
  const invoice = await db.queryOne(Q.getInvoiceWithItems, [invoiceId]);
  if (!invoice) throw new Error(`Rechnung ${invoiceId} nicht gefunden`);

  const [machineLines, invoiceItems] = await Promise.all([
    getInvoiceMachineLines(invoiceId),
    db.query(Q.getInvoiceItems, [invoiceId]),
  ]);

  const pdfBuffer = await buildPdf(invoice, machineLines, invoiceItems);

  await db.query(Q.deleteInvoicePdf, [invoiceId]);
  const result = await db.query(Q.storeInvoicePdf, [userId, invoiceId, pdfBuffer]);
  return Number(result.insertId);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  if (m > 0) return `${m}min ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// "2024-01-15 09:23:45" → "15.01.24 09:24" (rounded to nearest minute, CH format)
function fmtRoundedDateTime(isoOrMysql) {
  if (!isoOrMysql) return '–';
  const d = new Date(String(isoOrMysql).replace(' ', 'T'));
  if (isNaN(d)) return String(isoOrMysql);
  if (d.getSeconds() >= 30) d.setMinutes(d.getMinutes() + 1);
  d.setSeconds(0, 0);
  return String(d.getDate()).padStart(2, '0') + '.' +
    String(d.getMonth() + 1).padStart(2, '0') + '.' +
    String(d.getFullYear()).slice(2) + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');
}

// ── PDF builder ────────────────────────────────────────────────────────────────

function buildPdf(invoice, machineLines = [], articleItems = []) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on('data',  chunk => chunks.push(chunk));
    doc.on('end',   ()    => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 50;   // left margin
    const R = 562;  // right edge (page 612 - margin 50)

    // Column x-positions (left edge of each column)
    const COL = { machine: L, start: 220, duration: 360, amount: 450 };

    // Header
    doc.fontSize(20).fillColor('black').text('FabLab Winti', L, doc.y, { align: 'left' });
    doc.fontSize(12).text(`Rechnung #${invoice.id}`);
    doc.moveDown(0.5);

    // Recipient
    doc.text(`Mitglied: ${invoice.user_name}`);
    doc.text(`E-Mail:   ${invoice.email}`);
    doc.text(`Datum:    ${new Date(String(invoice.created_at).replace(' ', 'T')).toLocaleDateString('de-CH')}`);
    if (invoice.created_by_name) doc.text(`Ausgestellt von: ${invoice.created_by_name}`);
    if (invoice.paymode) doc.text(`Zahlungsart: ${invoice.paymode}`);
    doc.moveDown();

    const regularItems = articleItems.filter(i => !i.is_correction);
    const corrItems    = articleItems.filter(i => !!i.is_correction);

    // ── Maschinenzeilen ──
    if (machineLines.length > 0) {
      doc.fontSize(11).fillColor('black').text('Maschinenzeit:', { underline: true });
      doc.moveDown(0.4);

      const headerY = doc.y;
      doc.fontSize(8).fillColor('#888888');
      doc.text('Maschine',  COL.machine,  headerY, { width: COL.start - COL.machine - 4 });
      doc.text('Start',     COL.start,    headerY, { width: COL.duration - COL.start - 4 });
      doc.text('Laufzeit',  COL.duration, headerY, { width: COL.amount - COL.duration - 4 });
      doc.text('Betrag',    COL.amount,   headerY, { width: R - COL.amount, align: 'right' });
      doc.moveDown(0.2);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.3);

      doc.fontSize(10).fillColor('black');
      let machineSubtotal = 0;
      for (const line of machineLines) {
        const y = doc.y;
        doc.text(line.machine_name,                COL.machine,  y, { width: COL.start - COL.machine - 4 });
        doc.text(fmtRoundedDateTime(line.startIso),COL.start,    y, { width: COL.duration - COL.start - 4 });
        doc.text(fmtDuration(line.usageSeconds),   COL.duration, y, { width: COL.amount - COL.duration - 4 });
        doc.text(Number(line.price).toFixed(2),    COL.amount,   y, { width: R - COL.amount, align: 'right' });
        doc.moveDown(0.5);
        machineSubtotal += Number(line.price);
      }

      // Zwischentotal Maschinenzeit
      doc.moveDown(0.1);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.3);
      const stY = doc.y;
      doc.fontSize(9).fillColor('#444444');
      doc.text('Zwischentotal Maschinenzeit', COL.machine, stY, { width: COL.amount - COL.machine - 4 });
      doc.text(machineSubtotal.toFixed(2), COL.amount, stY, { width: R - COL.amount, align: 'right' });
      doc.fillColor('black').fontSize(10);
      doc.moveDown(1.0);
    }

    // ── Artikel ──
    if (regularItems.length > 0) {
      doc.fontSize(11).fillColor('black').text('Artikel:', { underline: true });
      doc.moveDown(0.4);

      const artHeaderY = doc.y;
      doc.fontSize(8).fillColor('#888888');
      doc.text('Artikel',   COL.machine,  artHeaderY, { width: COL.start - COL.machine - 4 });
      doc.text('Stk.',      COL.start,    artHeaderY, { width: COL.duration - COL.start - 4, align: 'right' });
      doc.text('Einzelpr.', COL.duration, artHeaderY, { width: COL.amount - COL.duration - 4, align: 'right' });
      doc.text('Betrag',    COL.amount,   artHeaderY, { width: R - COL.amount, align: 'right' });
      doc.moveDown(0.2);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.3);

      doc.fontSize(10).fillColor('black');
      for (const item of regularItems) {
        const qty   = Number(item.quantity);
        const unitP = Number(item.unit_price);
        const total = Number(item.total);
        const y     = doc.y;
        doc.text(item.description, COL.machine,  y, { width: COL.start - COL.machine - 4 });
        doc.text(String(qty),      COL.start,    y, { width: COL.duration - COL.start - 4, align: 'right' });
        doc.text(unitP.toFixed(2), COL.duration, y, { width: COL.amount - COL.duration - 4, align: 'right' });
        doc.text(total.toFixed(2), COL.amount,   y, { width: R - COL.amount, align: 'right' });
        doc.moveDown(0.5);
      }
    }

    // ── Korrekturen ──
    if (corrItems.length > 0) {
      doc.moveDown(0.3);
      for (const item of corrItems) {
        const total = Number(item.total);
        const y     = doc.y;
        doc.fontSize(10).fillColor(total < 0 ? 'red' : 'black');
        doc.text(item.description, COL.machine, y, { width: COL.amount - COL.machine - 4 });
        doc.text(total.toFixed(2), COL.amount,  y, { width: R - COL.amount, align: 'right' });
        doc.fillColor('black');
        doc.moveDown(0.5);
      }
    }

    if (machineLines.length > 0 || articleItems.length > 0) {
      doc.moveDown(0.3);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#888888').stroke();
      doc.moveDown(0.4);
    }

    // Total
    const totalY = doc.y;
    doc.fontSize(12).fillColor('black')
       .text('Total CHF', COL.machine, totalY, { width: COL.amount - COL.machine - 4 })
       .text(Number(invoice.total).toFixed(2), COL.amount, totalY, { width: R - COL.amount, align: 'right' });
    doc.moveDown(1.5);

    // Status stamp
    const paid = !!invoice.paymode;
    doc.fontSize(24)
       .fillColor(paid ? 'green' : 'red')
       .text(paid ? 'BEZAHLT' : 'AUSSTEHEND', { align: 'center' });

    doc.end();
  });
}

module.exports = { previewInvoice, createInvoice, generateInvoicePdf, getInvoiceMachineLines, recalcMachineLine, calcMachinePrice };
