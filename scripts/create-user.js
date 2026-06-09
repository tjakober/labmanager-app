'use strict';

require('dotenv').config();
const bcrypt = require('bcrypt');
const db     = require('../src/db/pool');

// ── Konfiguration ─────────────────────────────────────────────────────────────
const NAME  = process.env.U_NAME  || 'Neuer User';
const EMAIL = process.env.U_EMAIL || 'user@fablabwinti.ch';
const PASS  = process.env.U_PASS  || 'passwort123';
const ROLLE = process.env.U_ROLE  || 'member'; // member | labmanager | admin

async function run() {
  const existing = await db.queryOne('SELECT id FROM users WHERE email = ?', [EMAIL]);
  if (existing) {
    console.error(`Fehler: E-Mail "${EMAIL}" ist bereits vergeben (ID ${existing.id})`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(PASS, 12);
  const result = await db.query(
    'INSERT INTO users (name, email, password_hash, active) VALUES (?, ?, ?, 1)',
    [NAME, EMAIL, hash]
  );
  const uid = Number(result.insertId);

  await db.query(
    'INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = ?',
    [uid, ROLLE]
  );

  console.log(`✓ User erstellt:`);
  console.log(`  ID:     ${uid}`);
  console.log(`  Name:   ${NAME}`);
  console.log(`  E-Mail: ${EMAIL}`);
  console.log(`  Rolle:  ${ROLLE}`);
  process.exit(0);
}

run().catch(e => {
  console.error('Fehler:', e.message);
  process.exit(1);
});
