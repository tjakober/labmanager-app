'use strict';

/**
 * Phase 5 – Verifikation
 */

async function verify({ conn, log }) {
  const [users]    = await conn.query('SELECT COUNT(*) AS n FROM users WHERE zynex_id IS NOT NULL');
  const [grp]      = await conn.query('SELECT COUNT(*) AS n FROM fachgruppen WHERE zynex_group_id IS NOT NULL');
  const [upgHist]  = await conn.query("SELECT COUNT(*) AS n FROM upgrade_history WHERE note LIKE '%zynex:%'");
  const [noWebling]= await conn.query('SELECT COUNT(*) AS n FROM users WHERE zynex_id IS NOT NULL AND webling_id IS NULL AND active = 1');

  log.info(`Users mit zynex_id:           ${Number(users.n)}`);
  log.info(`Fachgruppen aus Zynex:         ${Number(grp.n)}`);
  log.info(`Upgrade-History (Zynex):       ${Number(upgHist.n)}`);

  if (Number(noWebling.n) > 0) {
    log.warn(`Aktive Users ohne webling_id:  ${Number(noWebling.n)} (wurden nicht zu Webling gesynced)`);
  }
}

module.exports = { verify };
