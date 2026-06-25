# FabLab Winti – Maschinen-Abrechnungs-App

Node.js/Express backend für Mitgliederverwaltung, Maschinenabrechnung, RFID-Zugang und Webling-Synchronisation.

**Konzept:** `c:\Users\t_jak\Nextcloud\Documents\FabLabWinti\Frontend Labmanager App\Doku\FabLab_Winti_Konzept_v3.pdf`

## Tech-Stack

- **Backend:** Node.js 20 · Express 4 · MySQL 8 / MariaDB 11
- **Auth:** bcrypt · JWT (`jsonwebtoken`)
- **Externe APIs:** Webling REST · Google Calendar v3 · Slack Incoming Webhook
- **Benachrichtigungen:** nodemailer (SMTP)
- **Sonstiges:** node-cron · pdfkit · axios · mariadb@3.3.1 (CJS-kompatibel, `dateStrings: true`)
- **Frontend:** Alpine.js v3 + Tailwind CSS v3 (CDN, kein Build-Schritt)
- **Infra:** Docker + Docker Compose (Produktion: Raspberry Pi / Synology NAS)

## Verzeichnisstruktur

```
src/
  app.js                    Express-Setup, Router-Mounts, globaler Error-Handler
  config.js                 Alle .env-Werte zentral (app/db/jwt/webling/google/slack/mail)
  routes/
    auth.js                 POST /api/auth/login → JWT; badge-login; reset
    controller.js           /api/controller/* (ESP8266/ESP32, X-Controller-Key)
    balance.js              /api/balance/* (Guthaben-API, Modul E)
    browser.js              /api/browser/* (Browser-SPA + Google OAuth2-Callback)
    display.js              /api/display/* + /display (SSE, Raspberry Pi)
  middleware/
    sessionAuth.js          JWT-Prüfung, requireRole()
    controllerAuth.js       X-Controller-Key → req.machineId
  services/
    configService.js        config-Tabelle lesen/schreiben (get/set)
    logService.js           insertLog(), insertBatch()
    rightService.js         checkTagRight(), getRightsForMachine()
    billingService.js       Abrechnungsformel (§5.2), createInvoice(), previewInvoice(),
                            getInvoiceMachineLines(), generateInvoicePdf(), PDF-Builder
    balanceService.js       deposit(), withdraw(), getBalance() via Webling
    weblingService.js       Webling REST API (Member, Balance, bookDeposit/Withdraw, bookInvoice,
                            bookGift, resolveStatusSubgroup)
    weblingSync.js          Täglicher Sync + Membership-History schreiben + Sync-Log
    upgradeService.js       revertExpiredUpgrades() + Webling/Mail/Slack
    calendarSync.js         Google Calendar OAuth2, createAssignmentEvent() etc.
    mailService.js          SMTP via nodemailer (Upgrade, Stellvertretung, Sync)
    slackService.js         Incoming Webhook (Stellvertretung, Upgrade)
  db/
    pool.js                 MariaDB-Pool, query(), queryOne() — dateStrings: true
    queries.js              ALLE SQL-Statements – kein SQL in routes/services
  jobs/
    dailyJob.js             node-cron 02:00 UTC: Upgrades reverten + Webling-Sync
public/
  index.html                Browser-SPA (Alpine.js + Tailwind, Single File, kein Build)
  display.html              Vollbild-Kiosk (Raspberry Pi, SSE-getrieben)
scripts/
  sync-webling.js           Manueller Webling-Sync (node scripts/sync-webling.js)
  create-user.js            CLI-Tool: User anlegen (U_NAME/U_EMAIL/U_PASS/U_ROLE via env)
locales/
  de.json                   UI-Texte + Fehlercodes (INSUFFICIENT_BALANCE etc.)
db/
  schema.sql                Vollständiges CREATE TABLE Schema (für Docker-Init)
  init.sql                  Config-Seeds (idempotent, ON DUPLICATE KEY UPDATE type+description)
logs/
  webling-sync.log          Sync-Protokoll (wird von weblingSync.js geschrieben)
migration/
  zynex/                    Zynex CMS → Webling/lokale DB Datenübernahme
    run.js                  Orchestrator (Phasen 0–5, --dry-run, --phase N)
    00_migrate_schema.js    Schema-Migration (neue Spalten)
    01_extract.js           CSV oder MSSQL lesen (5 Tabellen, Wildcard-Spaltenkonfiguration)
    02_transform.js         Normalisierung, Datumsformat DD.MM.YYYY / YYYY-MM-DD
    03_load_local.js        Upsert users/fachgruppen, upgrade_history, webling_meta simuliert
    04_sync_webling.js      Webling: Adressen, Gruppen, Membership-History, Status
    05_verify.js            Konsistenz-Report
  config.js                 Quell-DB (Zynex MSSQL) + Ziel-DB + Webling
  input/zynex/              CSV-Dateien: adressen.csv, gruppen.csv, adr_gruppen.csv,
                            adresstypen.csv, upgrades.csv
Dockerfile                  Production Build (node:20-slim, bcrypt Prebuilds)
docker-compose.yml          MariaDB 10.11 + App, persistente Volumes, Port 3308 exponiert
.env.example                Vorlage für Produktions-Konfiguration
DEPLOY-SYNOLOGY.md          Schritt-für-Schritt Anleitung für Synology NAS
```

## Architektur-Regeln

**SQL:** Ausschliesslich in `src/db/queries.js`. Kein SQL in Routes oder Services.

**Business-Logik:** In `src/services/`. Routes delegieren nur, enthalten keine Logik.

**Fehlerantworten (alle Endpunkte):**
```json
{ "ok": false, "error_code": "INSUFFICIENT_BALANCE" }   // balance API
{ "error": "err.message || 'Server-Fehler'" }           // alle anderen (konkreter Fehlertext)
```

**Fehlercodes** (Modul E): `INSUFFICIENT_BALANCE` · `MAX_BALANCE_EXCEEDED` · `MEMBER_NOT_FOUND` · `WEBLING_ERROR`

**Guthaben:** Webling ist Single Source of Truth. Kein lokales Caching des Saldos.

**Config-Tabelle:** Alle Geschäftsregeln kommen aus `config`-Tabelle via `configService.get(key)`. Seeds in `db/init.sql`.

**Datumsformat:** `pool.js` hat `dateStrings: true` — DATE/DATETIME-Spalten kommen als Plain-Strings, keine Timezone-Konvertierung.

## Datenbank-Schema (Kerntabellen)

| Tabelle | Zweck |
|---|---|
| `users` | Mitglieder (webling_id, zynex_id, webling_meta, badge_login_enabled, membership_status) |
| `machines` | Maschinen + Tarife + api_key; `period` in **Minuten**; `last_heartbeat`, `last_ip` |
| `tags` | RFID-Badges (id = RFID-UID als Integer) |
| `rights` | tag_id + machine_id + valid_from/valid_to (DATE) |
| `paymode` | Zahlungsarten (Cash, Twint, SumUp, Guthaben) + konto_nr |
| `logs` | Maschinen-Ereignisse (invoice_id=NULL = offener Posten) |
| `events` | Event-Typen: start(1), stop(2), error(3), login(4), logout(5), denied(6), running(7), idle(8), running1(9) |
| `invoices` | Rechnungen + created_by (Labmanager-ID) |
| `invoice_items` | Rechnungspositionen (description, quantity, unit_price, total, credit_account, is_correction) |
| `articles` | Artikelkatalog (name, description, price, konto_nr, is_balance_deposit, active) |
| `documents` | PDF-Rechnungen (user_id, invoice_id, type, mime_type, blob) |
| `assignments` | Labmanager-Einsätze (gcal_event_id) |
| `schedules` | Wöchentliche Öffnungszeiten |
| `substitutions` | Stellvertretungsanfragen |
| `lm_preferences` | Labmanager-Einsatzpräferenzen |
| `balance_transactions` | Lokales Log aller Guthaben-Buchungen |
| `upgrade_history` | Upgrade/Revert-Events + Zynex-Import-Records (note enthält JSON) |
| `config` | Konfigurierbare Parameter (key/value/type/description) |
| `api_keys` | Controller + externe App Keys (key_hash) |
| `knowledge` | Skills/Kompetenzen |
| `user_knowledge` | Mitglied ↔ Skill (n:m) |
| `fachgruppen` | Webling-Fachgruppen (webling_group_id, zynex_group_id, beschreibung, bemerkung) |
| `user_fachgruppen` | Mitglied ↔ Fachgruppe (n:m, nur Webling-Sync) |
| `tag_deposits` | Depot-Buchungen bei Ersatzkarten-Ausgabe |
| `password_resets` | Token-Tabelle für Passwort-Reset (token_hash SHA256, expires_at +2h) |

## Config-Tabelle (wichtige Einträge)

| Key | Typ | Default | Zweck |
|---|---|---|---|
| `balance.max_deposit` | number | `500` | Max. Guthaben pro Mitglied (CHF) |
| `balance.gift_credit_account` | string | `''` | Webling-Konto HABEN bei Guthaben-Schenkung (z.B. `1001`) |
| `balance.gift_accounts` | json | `[]` | Konti für Guthaben-Schenkung: `[{konto_nr, bezeichnung, fachgruppe?}]` |
| `right.default_days` | number | `365` | Standard-Laufzeit für neue Maschinenrechte in Tagen |
| `tag.deposit_amount` | number | `20` | Depot-Gebühr für Ersatzkarte (CHF) |
| `upgrade.expire_notify_emails` | json | `[]` | Empfänger bei Upgrade-Ablauf |
| `upgrade.notify_emails` | json | `[]` | Empfänger Upgrade-Meldungen |
| `webling.active_statuses` | json | `[]` | Wildcard-Patterns für aktive Mitglieds-Statuses (z.B. `["Mitglied*"]`). Leer = alle |
| `webling.fachgruppe_roles` | json | `{"LabManager":"labmanager","ICT":"admin"}` | Fachgruppe → lokale Rolle |
| `webling.max_members` | number | `500` | Max. Mitglieder in Webling (nur informativ) |
| `webling.reserve` | number | `20` | Reserve unter Maximum (nur informativ) |
| `webling.member_group_id` | number | `0` | Webling Membergroup-ID (Haupt-Gruppe) für neue Mitglieder |

## Webling Buchungs-Integration

`weblingService.bookInvoice()` erstellt eine Entrygroup pro Erlöskonto:
- **SOLL** (`dc: 's'`): `paymode.konto_nr` — Zahlungseingang
- **HABEN** (`dc: 'h'`): `machines.konto_nr` + `articles.konto_nr` — Erlöskonto
- `is_balance_deposit`-Artikel: nur Guthaben-Feld auf Webling-Member aktualisieren (kein extra Entry)
- Guthaben-Zahlung: `PATCH /invoices/:id/pay` mit Guthaben-Paymode → Balance wird von Webling-Mitglied abgezogen + `webling_meta` lokal aktualisiert
- Account-Cache (konto_nr → Webling-ID) wird beim ersten Aufruf geladen

## Membership-History (Webling-Feld)

Webling-Feld: **`Membership-History`** (JSON-Array, konfigurierbar via `WEBLING_FIELD_UPGRADE_HISTORY`)

Eintrags-Typen (`_typ`):
- `mitgliedschaft` — Status-Events: Antrag, Eintritt, Kündigung, Ausschluss
- `upgrade` — Lokale Upgrades aus `upgrade_history` + Webling-Upgrade-Feld (`"Upgrade [Status] > [Upgrade]"`)
- `mitgliedschaft` (aus Zynex) — mit `_key: "zynex:typ:..."`

**Sync-Logik:**
- Status `Antrag` → neuen Mitgliedschafts-Eintrag mit `antragsDatum`
- Status `Mitglied*` → `eintrittsdatum` in offenem Eintrag ergänzen
- Status `Ex-Mitglied` → `kuendigDatum` in offenem Eintrag setzen
- Status `Ausgeschlossen` → `bezeichnung: 'ausgeschlossen'` + `kuendigDatum`
- Jahreswechsel wird **nicht** protokolliert
- Nach Kündigung/Ausschluss + erneutem Eintritt: neuer Eintrag wird angehängt

## Webling-Sync

`weblingSync.runSync()` — täglich 02:00 UTC + manuell auslösbar:

**Webling führt** — Sync ist read-only (kein Push aus App nach Webling). Neue Mitglieder werden in Webling erfasst oder via Migration übernommen. **Ausnahme:** Manueller Push aus dem Mitglied-Detail (Labmanager-Funktion).

**Phase 1:** Mitglieder-Upsert (Webling → DB), `webling_meta`-Backup, lokale Upgrades + Membership-Events schreiben. Match-Priorität: `webling_id` → `zynex_id` (= Webling `Mitglieder ID`) → E-Mail. Duplikat-User ohne `zynex_id` bei E-Mail-Konflikt werden gelöscht.

**Phase 2:** Fachgruppen-Sync — inaktive Mitglieder werden aus Webling-Fachgruppen entfernt; Rollen via `webling.fachgruppe_roles` synchronisiert

**Rollen:** Ausschliesslich via Fachgruppen (kein Funktion-Feld mehr)

**Wildcard in active_statuses:** `"Mitglied*"` trifft auf alle Jahres-/Typ-Kombinationen

**Log:** `logs/webling-sync.log` — alle Sync-Läufe mit Timestamp, übersprungene Mitglieder (mit Grund)

## Webling-Push (Mitglied-Detail)

Labmanager können im Info-Tab eines Mitglieds den Status ändern und die Adresse manuell zu Webling pushen.

**Status-Dropdown:** Antrag · Mitglied [Jahr] Basis/Premium/Kommerziell · Ex-Mitglied · Extern · Ausgeschlossen

**Auto-Push** bei Statuswechsel auf Antrag, Mitglied* oder Ausgeschlossen:
- Webling-Status wird aktualisiert
- Datums-Felder werden gesetzt: `Datum Antrag` (Antrag, nur wenn leer), `Eintrittsdatum` (Mitglied*, nur wenn leer), `Austrittsdatum` (Ex-Mitglied/Ausgeschlossen, immer)
- Membership-History wird ergänzt

**Manueller Push-Button:** Überträgt alle Adressfelder aus `webling_meta` + aktuellen Status.

**Lookup-Logik beim Erstellen:**
1. Suche in Webling nach `Mitglieder ID` = `zynex_id` (Batch-Scan aller Members)
2. Gefunden → `webling_id` in DB setzen + Update
3. Nicht gefunden → neuen Webling-Member anlegen mit `Mitglieder ID` = `zynex_id`
4. Webling gibt "not unique" → existierenden Member via Batch-Scan finden und linken
5. Parents: `webling.member_group_id` (Haupt) + Untergruppe via `resolveStatusSubgroup()` (lädt Kinder der Haupt-Gruppe, matched Titel gegen Status-String)

**Feldname-Whitelist** (verhindert unbekannte Felder): Vorname, Name, E-Mail P/G, Status, Mitglieder ID, Strasse, Adresszusatz, PLZ, Ort, Land, Telefon P/G, Mobile P/G, Firma, Anrede, Geburtsdatum, Eintrittsdatum, Austrittsdatum, Funktion, Bemerkungen, Datum Antrag

## Zynex Datenübernahme

Zynex ist **führendes System** bis zur offiziellen Abschaltung. Migration ist idempotent.

```bash
node migration/zynex/run.js --dry-run   # prüfen
node migration/zynex/run.js             # produktiv
node migration/zynex/run.js --phase 4  # nur Webling-Sync
```

**Was übernommen wird:**
- Adressen → `users` (zynex_id, webling_meta simuliert für Zynex-only Users)
- Adressgruppen → `fachgruppen` + Webling membergroups (inaktive Mitglieder werden entfernt)
- Adresstypen → `users.membership_status` + Webling Status
- Upgrades → `upgrade_history` + Webling Membership-History + Upgrade-Felder

**Feldname Membership-History** in `04_sync_webling.js` und `weblingService.js` via `WEBLING_FIELD_UPGRADE_HISTORY`.

## Rechnungs-Workflow

1. Labmanager erstellt Rechnung → Invoices-Tab öffnet sich automatisch
2. Offene Rechnung ergänzen: Artikel inline hinzufügen (Qty editierbar, Total live), Positionen löschen, **Korrektur** (Textarea + Betrag negativ möglich)
3. Guthaben-Artikel: `credit_account` automatisch aus `artikel.konto_nr` — kein manuelles Konto
4. Zahlungsart beim Erstellen: **Guthaben** ist ausgeblendet (nur Kasse/Twint/SumUp)
5. PDF immer neu generiert bei Download offener Rechnung + nach Bezahlung
6. PDF gespeichert in `documents` mit `invoice_id`
7. Bezahlen mit Guthaben → Webling-Balance abgezogen + `webling_meta` aktualisiert

## Onboarding neuer Labmanager

Rollen via **Webling-Fachgruppen** (konfigurierbar in `webling.fachgruppe_roles`):
- Fachgruppe **LabManager** (Teilstring-Match) → Rolle `labmanager`
- Fachgruppe **ICT** → Rolle `admin`

Neuer Labmanager: In Webling zur Fachgruppe hinzufügen → nächster Sync setzt Rolle + Welcome-Mail.

## Docker / Deployment

**Dateien:**
- `Dockerfile` — Production Build (node:20-slim, bcrypt Prebuilds)
- `docker-compose.yml` — MariaDB 10.11 + App, Volumes: db_data, certs, logs, migration/input; Port 3308 exponiert
- `.env.example` — Vorlage (ohne Secrets)
- `db/schema.sql` — vollständiges DB-Schema für First-Start
- `DEPLOY-SYNOLOGY.md` — Schritt-für-Schritt für Synology NAS

**Raspberry Pi / Synology NAS Start:**
```bash
cp .env.example .env && nano .env
sudo docker compose up -d
```

Beim ersten Start: MariaDB initialisiert Schema + Config-Seeds automatisch.

**Passwörter mit Sonderzeichen ($) in .env:** `$`-Zeichen mit `\$` escapen, sonst wird der Wert abgeschnitten.

**Git-Workflow (Raspi Update):**
```bash
# Lokal:
git add . && git commit -m "..." && git push

# Auf Raspi:
cd ~/Docker/FabLabWinti
git pull origin main
sudo docker compose up -d --build app
```

**DB-Zugriff von aussen:** Port 3308 exponiert. Root-Zugriff via `sudo docker exec -it fablabwinti_db bash -c "mariadb -u root -pPASSWORD"`. Für Remote-Zugriff: `GRANT ALL ON db.* TO 'user'@'%' IDENTIFIED BY '...'`.

## API-Routen

### Auth
| Route | Auth | Zweck |
|---|---|---|
| `POST /api/auth/login` | — | E-Mail + Passwort → JWT (nur intern/admin) |
| `POST /api/auth/reset-request` | — | Passwort-Reset per E-Mail |
| `POST /api/auth/reset-confirm` | — | Neues Passwort setzen |
| `POST /api/auth/badge-login` | — | RFID → JWT (immer aktiv, Mitgliedschaftsprüfung + Januar-Toleranz) |

### Browser-SPA (`/api/browser/*`)
| Route | Rolle | Zweck |
|---|---|---|
| `GET /me` | JWT | Eigenes User-Objekt |
| `POST /me/password` | JWT | Eigenes Passwort ändern |
| `GET /members/summary` | labmanager | Mitglieder-Statistik: total, in_webling, by_status |
| `GET /members` | labmanager | Mitgliederliste; 1 Treffer → Auto-Select |
| `POST /members` | admin | Neues Mitglied |
| `GET /members/:id` | owner/labmanager | Mitglied-Detail (inkl. mitglieder_id aus Webling) |
| `GET /members/:id/rights` | owner/labmanager | Rights |
| `GET /members/:id/tags` | labmanager | Badges |
| `POST /members/:id/tags` | labmanager | Badge ausgeben |
| `GET /members/:id/active-sessions` | owner/labmanager | Aktive Maschinensessions |
| `GET /members/:id/upgrade` | owner/labmanager | Upgrade-History |
| `GET /machines/status` | labmanager | Belegungsstatus alle Maschinen |
| `GET /machines` | labmanager | Alle Maschinen |
| `POST /machines` | labmanager | Maschine anlegen |
| `PUT /machines/:id` | labmanager | Maschine bearbeiten |
| `GET /rights/defaults` | labmanager | `{ default_days }` |
| `POST /rights` | labmanager | Recht hinzufügen |
| `PUT /rights/:id` | labmanager | Gültigkeitsdaten |
| `DELETE /rights/:id` | labmanager | Recht entfernen |
| `GET /members/:id/balance` | owner/labmanager | Guthaben |
| `POST /members/:id/balance/gift` | labmanager | Guthaben schenken (Webling-Buchung) |
| `PATCH /members/:id/status` | labmanager | membership_status ändern + Auto-Push Webling |
| `POST /members/:id/webling-push` | labmanager | Adresse manuell zu Webling pushen |
| `GET /gift-accounts` | labmanager | Konfigurierte Schenkungskonti (gefiltert nach Fachgruppe) |
| `GET /members/:id/invoices` | owner/labmanager | Rechnungsliste |
| `GET /members/:id/invoice/preview` | owner/labmanager | Vorschau offene Posten |
| `POST /members/:id/invoice` | labmanager | Rechnung erstellen + PDF |
| `GET /invoices/:id` | owner/labmanager | Rechnungsdetail inkl. machine_lines + items |
| `GET /invoices/:id/pdf` | owner/labmanager | PDF (offene Rechnung: immer neu generiert) |
| `POST /invoices/:id/items` | labmanager/owner | Artikel zu offener Rechnung |
| `DELETE /invoices/:id/items/:item_id` | labmanager | Position löschen |
| `DELETE /invoices/:id` | labmanager | Rechnung stornieren (nur unpaid) |
| `PATCH /invoices/:id/pay` | owner/labmanager | Zahlung → PDF + Webling-Buchung + ggf. Balance |
| `DELETE /invoices/:id/pay` | admin | Bezahlung rückgängig |
| `GET /articles` | JWT | Aktive Artikel (member: ohne is_balance_deposit) |
| `POST /articles` | labmanager | Artikel anlegen |
| `PUT /articles/:id` | labmanager | Artikel bearbeiten |
| `PATCH /articles/:id/toggle` | labmanager | Artikel aktiv/inaktiv |
| `GET /paymodes` | JWT | Alle Zahlungsarten |
| `PUT /paymodes/:id` | admin | Buchungskonto setzen |
| `GET /config` | admin | Alle Config-Einträge |
| `PUT /config/:key` | admin | Config-Wert ändern |
| `POST /webling/sync` | admin | Webling-Sync manuell |
| `GET /google/status` | admin | Google OAuth2 Status |

### Controller, Firmware, Sonstige
| Route | Auth | Zweck |
|---|---|---|
| `/api/controller/*` | X-Controller-Key | ESP8266/ESP32 |
| `GET /api/machines` | — | Maschinenliste (CORS offen) |
| `GET /api/machines/:mid` | — | Maschinenkonfig für ESP |
| `GET /api/machines/:mid/tags` | — | Tags mit Unix-Timestamps |
| `POST /api/logs` | — | Event-Log vom Controller |
| `/api/balance/*` | JWT labmanager | Guthaben deposit/withdraw |
| `/api/assignments/*` | JWT labmanager | Einsatzplanung |
| `/api/display/*` · `/display` | — | Kiosk SSE + HTML |

**Server läuft auf Port 3003** (`APP_PORT`). HTTPS: `certs/server.key` + `certs/server.crt`. Firmware-Repo: `C:\FabLabRFID`

## Wichtige Umgebungsvariablen

```
APP_PORT=3003
APP_BASE_URL=https://fablab.example.com
NODE_ENV=production
DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD / DB_ROOT_PASSWORD
JWT_SECRET / JWT_EXPIRES_IN
WEBLING_API_URL / WEBLING_API_KEY / WEBLING_RATE_DELAY_MS
WEBLING_FIELD_BALANCE / _UPGRADE_STATUS / _UPGRADE_START / _UPGRADE_ABLAUF
WEBLING_FIELD_UPGRADE_HISTORY=Membership-History
GOOGLE_CLIENT_ID / _SECRET / _REDIRECT_URI / _CALENDAR_ID
SLACK_WEBHOOK_URL
MAIL_HOST / MAIL_PORT / MAIL_USER / MAIL_PASSWORD / MAIL_FROM
```

**Lokale Entwicklung (wamp64):** MySQL 8.3.0 auf Port 3308 läuft nicht als Windows-Dienst:
```bash
C:\wamp64_3_3_5\bin\mysql\mysql8.3.0\bin\mysqld.exe --defaults-file="C:\wamp64_3_3_5\bin\mysql\mysql8.3.0\my.ini"
```

## Implementierungsstand

| Modul | Status |
|---|---|
| Auth (Login, JWT, Rollen, Badge-Login, Auto-Logout) | Fertig |
| C – Controller-API | Fertig |
| B – Display Website (SSE, Kiosk) | Fertig |
| D – Config-Tabelle | Fertig |
| E – Guthaben-API (deposit/withdraw inkl. Balance-Abzug bei Guthaben-Zahlung) | Fertig |
| F – Upgrades | Fertig |
| G – Migration Zynex → Webling (5 Phasen, idempotent, Wildcards) | Fertig |
| H – Webling-Sync (Fachgruppen-Rollen, Membership-History, Sync-Log) | Fertig |
| Abrechnung (billingService, PDF Stk./Einzelpr./Betrag, Korrektur-Zeile) | Fertig |
| Rechnungs-Workflow (inline Artikel, Auto-konto, Guthaben kein Paymode) | Fertig |
| Webling-Buchung (bookInvoice Entrygroup, Balance-Update) | Fertig |
| Membership-History (Mitgliedschaft/Upgrade-Events, Wildcard-Statuses) | Fertig |
| Google Calendar | Fertig |
| Mail / Slack | Fertig |
| A – Einsatzplanung | Fertig |
| Browser API + SPA | Fertig |
| Tag-Depot | Fertig |
| Webling-Felder + Mitglieder-ID im Mitglied-Detail | Fertig |
| Passwort-Reset per E-Mail | Fertig |
| Rechte: Checkbox-Grid, Default-Laufzeit | Fertig |
| Maschinenbelegung Live-View | Fertig |
| Member-Dashboard (Mein Konto) | Fertig |
| Zynex Datenübernahme + membership_status + webling_meta simuliert | Fertig |
| Docker-Deployment (Synology NAS / Raspberry Pi) | Fertig |
| Mitglieder-Übersicht Dashboard (Summary ohne Auswahl) | Fertig |
| Webling-Sync: nur Lesen (Webling führt, kein Push aus App) | Fertig |
| Badge-Login: nur RFID, immer aktiv, Mitgliedschaftsprüfung + Januar-Toleranz | Fertig |
| Guthaben schenken (Labmanager, konfigurierbare Konti, Fachgruppen-Einschränkung) | Fertig |
| Mitglied-Status ändern + Auto-Push zu Webling (Antrag/Mitglied*/Ausgeschlossen) | Fertig |
| Webling-Push: Adresse + Datums-Felder, Untergruppen via resolveStatusSubgroup() | Fertig |
| Membership-History bei Status-Wechsel aktualisieren | Fertig |

## Datenbankschema anwenden

```bash
# Erstinstallation (Schema + Config-Seeds):
mysql -u fablab -p fablabwinti --default-character-set=utf8mb4 < db/schema.sql
mysql -u fablab -p fablabwinti --default-character-set=utf8mb4 < db/init.sql

# Nur Config-Seeds aktualisieren (idempotent):
mysql -u fablab -p fablabwinti --default-character-set=utf8mb4 < db/init.sql
```

## Manuelle Operationen

```bash
# Webling-Sync manuell:
node scripts/sync-webling.js

# Zynex-Migration:
node migration/zynex/run.js --dry-run
node migration/zynex/run.js

# User anlegen:
U_NAME="Max Muster" U_EMAIL="max@example.com" U_PASS="geheim123" U_ROLE="member" node scripts/create-user.js

# Docker (Produktion):
docker compose up -d
docker compose logs -f app
docker compose pull && docker compose up -d   # Update
```
