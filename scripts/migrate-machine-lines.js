'use strict';
// Einmalig ausführen: node scripts/migrate-machine-lines.js
require('dotenv').config();
const db = require('../src/db/pool');

async function run() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS \`invoice_machine_lines\` (
      \`id\`            int          NOT NULL AUTO_INCREMENT,
      \`invoice_id\`    int          NOT NULL,
      \`machine_id\`    int          DEFAULT NULL,
      \`machine_name\`  varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
      \`usage_seconds\` int          NOT NULL DEFAULT 0,
      \`period\`        int          NOT NULL DEFAULT 0,
      \`min_periods\`   int          NOT NULL DEFAULT 1,
      \`min_price\`     decimal(10,2) DEFAULT NULL,
      \`price\`         decimal(10,2) NOT NULL,
      \`line_price\`    decimal(10,2) NOT NULL,
      \`konto_nr\`      varchar(20)  COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      \`start_iso\`     varchar(30)  COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      \`sort_order\`    int          NOT NULL DEFAULT 0,
      PRIMARY KEY (\`id\`),
      KEY \`invoice_id\` (\`invoice_id\`),
      CONSTRAINT \`iml_invoice_fk\` FOREIGN KEY (\`invoice_id\`) REFERENCES \`invoices\` (\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('✓ Tabelle invoice_machine_lines erstellt (oder bereits vorhanden)');

  await db.query(`
    INSERT INTO config (\`key\`, value, type, description)
    VALUES ('invoice.labmanager_discount', '50', 'number', 'Rabatt für Labmanager auf Maschinenzeit in % (0 = kein Rabatt)')
    ON DUPLICATE KEY UPDATE type = VALUES(type), description = VALUES(description)
  `);
  console.log('✓ Config invoice.labmanager_discount gesetzt');

  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
