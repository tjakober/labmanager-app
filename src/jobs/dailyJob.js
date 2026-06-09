'use strict';

const cron           = require('node-cron');
const upgradeService = require('../services/upgradeService');
const weblingSync    = require('../services/weblingSync');

/**
 * Daily at 02:00 UTC:
 *  1. Revert expired upgrades (Modul F.5)
 *  2. Run Webling sync (Modul H.4)
 */
cron.schedule('0 2 * * *', async () => {
  console.log('[dailyJob] Start:', new Date().toISOString());

  try {
    const reverted = await upgradeService.revertExpiredUpgrades();
    console.log(`[dailyJob] Upgrades reverted: ${reverted}`);

    await weblingSync.runSync();
  } catch (err) {
    console.error('[dailyJob] Error:', err.message);
  }

  console.log('[dailyJob] Done:', new Date().toISOString());
});

module.exports = { upgradeService, weblingSync };
