# FabLab Winti – Maschinen-Abrechnungs-App

Node.js + MariaDB + Docker

## Schnellstart

```bash
# 1. Konfiguration anlegen
cp .env.example .env
# .env anpassen (DB-Passwörter, Webling-API-Key, etc.)

# 2. Docker starten
docker compose up -d

# 3. Datenbank-Schema initialisieren (beim ersten Start automatisch via db/init.sql)

# 4. App aufrufen
# https://localhost:3003
```

## Entwicklung (ohne Docker)

```bash
npm install
# MariaDB lokal starten, .env anpassen (DB_HOST=localhost)
npm run dev
```

## Verzeichnisstruktur

```
src/
  app.js              Express Hauptdatei
  config.js           Konfiguration aus .env
  routes/
    auth.js           Login, JWT
    controller.js     Maschinen-Controller API (/api/controller/*)
    balance.js        Guthaben-API (/api/balance/*)
    display.js        Display-Website + SSE
  middleware/
    sessionAuth.js    JWT-Prüfung für Browser
    controllerAuth.js API-Key-Prüfung für Controller
  services/           Business-Logik (TODO)
  db/
    pool.js           MariaDB Connection Pool
  jobs/
    dailyJob.js       Tages-Endverarbeitung (node-cron)
locales/
  de.json             Deutsche UI-Texte
public/
  display.html        Vollbild-Anzeige (Raspberry Pi)
  index.html          SPA-Einstieg (TODO)
migration/            Migrations-Script Zynex → Webling
db/
  init.sql            Datenbank-Schema (TODO)
```

## Module

| Modul | Status |
|-------|--------|
| A – Einsatzplanung | TODO |
| B – Display Website | Grundgerüst ✓ |
| C – Controller-API | Grundgerüst ✓ |
| D – Config-Tabelle | TODO |
| E – Guthaben-API | Grundgerüst ✓ |
| F – Upgrades | TODO |
| G – Migration | TODO |
| H – Webling-Sync | TODO |
