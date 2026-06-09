'use strict';

require('dotenv').config();
const weblingSync = require('../src/services/weblingSync');

weblingSync.runSync()
  .then(stats => {
    console.log('Sync abgeschlossen:', stats);
    process.exit(0);
  })
  .catch(err => {
    console.error('Sync fehlgeschlagen:', err.message);
    process.exit(1);
  });
