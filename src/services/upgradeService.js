'use strict';

const db             = require('../db/pool');
const Q              = require('../db/queries');
const weblingService = require('./weblingService');
const mailService    = require('./mailService');
const slackService   = require('./slackService');

async function revertExpiredUpgrades() {
  const expired = await db.query(Q.getExpiredUpgrades);

  for (const row of expired) {
    console.log(`[upgradeService] Reverting upgrade: member_id=${row.member_id}`);

    await db.query(Q.insertUpgradeRevert, [row.member_id, 'Automatisch nach Ablauf']);

    // Fetch full history to rebuild the JSON array in Webling
    const history = await db.query(
      `SELECT event_type, upgrade_type, start_date, expiry_date, invoice_id, created_at, note
       FROM upgrade_history WHERE member_id = ? ORDER BY created_at DESC`,
      [row.member_id]
    );
    const historyJson = history.map(h => ({
      event:   h.event_type,
      type:    h.upgrade_type || undefined,
      start:   h.start_date   || undefined,
      expiry:  h.expiry_date  || undefined,
      invoice: h.invoice_id   || undefined,
      note:    h.note         || undefined,
      date:    h.created_at,
    }));

    try {
      await weblingService.clearUpgrade(row.member_id);
      await weblingService.updateUpgradeHistory(row.member_id, historyJson);
    } catch (err) {
      console.error(`[upgradeService] Webling update failed for member_id=${row.member_id}:`, err.message);
    }

    try {
      const member = await weblingService.getMember(row.member_id);
      await Promise.all([
        mailService.sendUpgradeExpired(member, row.upgrade_type),
        slackService.notifyUpgradeExpired(member.name || member.properties?.firstName, row.upgrade_type),
      ]);
    } catch (err) {
      console.error(`[upgradeService] Notification failed for member_id=${row.member_id}:`, err.message);
    }

    console.log(`[upgradeService] Reverted: member_id=${row.member_id}`);
  }

  return expired.length;
}

module.exports = { revertExpiredUpgrades };
