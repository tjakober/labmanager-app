'use strict';

require('dotenv').config();

const express = require('express');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const cfg     = require('./config');

const authRouter        = require('./routes/auth');
const controllerRouter  = require('./routes/controller');
const balanceRouter     = require('./routes/balance');
const browserRouter     = require('./routes/browser');
const assignmentsRouter = require('./routes/assignments');
const { router: displayRouter } = require('./routes/display');
const machinesFw                = require('./routes/machines_fw');

require('./jobs/dailyJob');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../public')));

app.use((req, _res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (req.path.startsWith('/api/machines') || req.path.startsWith('/api/logs')) {
    const body = req.method === 'POST' ? JSON.stringify(req.body) : '';
    console.log(`[fw] ${req.method} ${req.path} from ${ip} ${body}`);
  }
  next();
});

app.use('/api/auth',        authRouter);
app.use('/api/controller',  controllerRouter);
app.use('/api/balance',     balanceRouter);
app.use('/api/browser',     browserRouter);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/display',     displayRouter);
app.use('/display',         displayRouter);
app.use('/api/machines',    machinesFw);
app.use('/api/logs',        machinesFw.logsRouter);

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpunkt nicht gefunden' });
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((err, req, res, _next) => {
  console.error('[app]', err.message);
  res.status(500).json({ error: 'Interner Server-Fehler' });
});

const certPath = path.join(__dirname, '../certs');
const certExists = fs.existsSync(path.join(certPath, 'server.key'));

if (certExists) {
  const sslOptions = {
    key:  fs.readFileSync(path.join(certPath, 'server.key')),
    cert: fs.readFileSync(path.join(certPath, 'server.crt')),
  };
  https.createServer(sslOptions, app).listen(cfg.app.port, () => {
    console.log(`FabLab Winti App läuft auf Port ${cfg.app.port} [HTTPS] [${cfg.app.env}]`);
  });
} else {
  app.listen(cfg.app.port, () => {
    console.log(`FabLab Winti App läuft auf Port ${cfg.app.port} [${cfg.app.env}]`);
  });
}

module.exports = app;
