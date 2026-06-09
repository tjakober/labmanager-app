# FabLab Winti App – Synology DSM 6.2 Deployment

## Voraussetzungen

- Synology DSM 6.2.4 mit installiertem **Docker**-Paket (Paketzentrum)
- SSH-Zugang aktiviert (Systemsteuerung → Terminal & SNMP)
- Ports 3003 in Synology Firewall freigegeben (oder Reverse Proxy)

---

## 1. docker-compose installieren

Via SSH als **root** einloggen und docker-compose V1 installieren:

```bash
# x86_64 Synology (die meisten NAS):
curl -L "https://github.com/docker/compose/releases/download/1.29.2/docker-compose-Linux-x86_64" \
  -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Version prüfen:
docker-compose version
# Erwartet: docker-compose version 1.29.2
```

Falls `curl` nicht verfügbar: Datei auf dem PC herunterladen und via SCP übertragen:
```bash
scp docker-compose-Linux-x86_64 admin@NAS-IP:/usr/local/bin/docker-compose
ssh admin@NAS-IP "chmod +x /usr/local/bin/docker-compose"
```

---

## 2. App-Dateien auf NAS übertragen

Ordner `/volume1/docker/fablabwinti/` anlegen und folgende Dateien kopieren:

```
fablabwinti/
  docker-compose.yml
  Dockerfile
  .env                    ← aus .env.example erstellen
  db/
    schema.sql
    init.sql
  src/                    ← Quellcode
  public/
  locales/
  migration/
  package.json
  package-lock.json
  certs/                  ← SSL-Zertifikate (oder leer lassen)
  logs/
```

Am einfachsten via SCP oder Synology File Station.

---

## 3. .env konfigurieren

```bash
cd /volume1/docker/fablabwinti
cp .env.example .env
vi .env
```

Pflichtfelder:
```
APP_BASE_URL=https://deine-domain.ch
DB_PASSWORD=sicheres_passwort
DB_ROOT_PASSWORD=sicheres_root_passwort
JWT_SECRET=mindestens_32_zeichen_zufallsstring
WEBLING_API_KEY=aus_webling_admin
MAIL_USER=mail@example.com
MAIL_PASSWORD=app_passwort
```

---

## 4. Image bauen und Container starten

```bash
cd /volume1/docker/fablabwinti

# Image bauen (dauert einige Minuten):
docker-compose build

# Container starten:
docker-compose up -d

# Logs prüfen:
docker-compose logs -f app
docker-compose logs -f db
```

**Hinweis:** Beim ersten Start initialisiert MariaDB das Schema aus `db/schema.sql` und die Config-Seeds aus `db/init.sql`. Das dauert 30–60 Sekunden. Falls die App vorher startet, einfach `docker-compose restart app` ausführen.

---

## 5. HTTPS / Reverse Proxy (empfohlen)

Synology Systemsteuerung → **Anwendungsportal** → **Reverse-Proxy**:

| Quelle | Ziel |
|--------|------|
| HTTPS 443 / deine-domain.ch | HTTP localhost:3003 |

Synology übernimmt damit das Let's Encrypt-Zertifikat. In `.env`:
```
APP_BASE_URL=https://deine-domain.ch
```

Alternativ direkt via Port 3003 mit eigenem Zertifikat in `certs/`.

---

## 6. Updates

```bash
cd /volume1/docker/fablabwinti
# Neue Dateien übertragen (src/, public/ etc.)
docker-compose build --no-cache
docker-compose up -d
```

---

## 7. Nützliche Befehle

```bash
# Status:
docker-compose ps

# App neu starten:
docker-compose restart app

# Alles stoppen:
docker-compose stop

# Logs (live):
docker-compose logs -f app

# Datenbank-Backup:
docker exec fablabwinti_db sh -c \
  "mysqldump -u fablab -pPASSWORT --default-character-set=utf8mb4 fablabwinti" \
  > backup_$(date +%Y%m%d).sql
```

---

## Portübersicht

| Service | Port | Protokoll |
|---------|------|-----------|
| App     | 3003 | HTTP/HTTPS |
| DB      | 3306 | intern (nicht erreichbar von aussen) |