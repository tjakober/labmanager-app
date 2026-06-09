# RFID Machine Controller – Gebrauchsanleitung

FabLab Winti | Firmware: Fablab_RFID_control

---

## 1. Übersicht

Der RFID Machine Controller ist ein ESP8266-basiertes Gerät, das den Zugang zu Maschinen per RFID-Karte steuert. Es kommuniziert mit dem Labmanager-Server, speichert Zugriffsrechte lokal und funktioniert auch bei Netzwerkausfall (Offline-Modus).

**Hardware-Komponenten:**
- ESP8266 (WiFi)
- MFRC522 RFID-Leser (Mifare Classic 1K Karten)
- OLED-Display
- Piezo-Buzzer + mehrfarbige LED
- Relais (250V/5A) oder Opto-Koppler (50V/40mA) für Maschinensteuerung
- SD-Karte für lokales Logging
- Echtzeituhr (RTC)

---

## 2. Bereits geflashten Controller konfigurieren

Wenn der Controller bereits mit der Firmware bespielt ist, gibt es zwei Wege in den Konfigurationsmodus:

### 2.1 Konfigurationsmodus über Flash-Taste (im Betrieb)

Der Controller aktiviert den Webserver/AP-Modus wenn die **Flash-Taste (GPIO0)** nach dem Bootvorgang gedrückt wird — **nicht** während des Resets.

**Ablauf:**
1. Reset-Taste kurz drücken und **loslassen**
2. Sofort danach (innerhalb ~1 Sekunde) **Flash-Taste drücken und 2 Sekunden gehalten halten**
3. LED leuchtet **lila** → AP-Modus ist aktiv (Timeout: 10 Minuten)
4. Mit WLAN **`RFIDnode-[MAC-Adresse]`** verbinden
5. Browser öffnen → `http://192.168.4.1`
6. Login: **admin** / **admin**
7. WLAN-SSID, Passwort, Server-Adresse und API-Key eintragen
8. Speichern → Controller startet neu und verbindet sich

> **Hinweis:** Der AP-Modus schaltet nach 10 Minuten automatisch ab und der Controller startet neu.

### 2.2 Factory Reset (Werkseinstellungen)

Falls der Controller nicht mehr erreichbar ist oder das Web-Passwort unbekannt ist:

1. **Reset-Taste drücken und loslassen**
2. Sofort **Flash-Taste drücken und 2 Sekunden halten**
3. Controller löscht alle WLAN- und Server-Einstellungen (Admin-UID bleibt erhalten)
4. Controller startet im AP-Modus → neu konfigurieren wie in 2.1 beschrieben

> **Achtung:** Factory Reset löscht WLAN, Server-Adresse, API-Key und RFID-Schlüssel. Die Admin-Karten-UID bleibt gespeichert.

---

## 3. Ersteinrichtung (Firmware flashen)

### 2.1 Arduino IDE einrichten

1. Arduino IDE öffnen → **Datei → Einstellungen**
2. Unter *Zusätzliche Boardverwalter-URLs* eintragen:
   ```
   http://arduino.esp8266.com/stable/package_esp8266com_index.json
   ```
3. **Werkzeuge → Board → Boardverwalter** → `esp8266` suchen → installieren
4. Board auswählen: **Generic ESP8266 Module**
5. Bibliothek installieren: `MFRC522` (von GitHub, im Repo als `FabLabRFID_Library.zip` enthalten)

### 2.2 Firmware flashen

1. Repository herunterladen: https://github.com/fablabwinti/RFID_Machine_Controller
2. `Firmware/Fablab_RFID_control/Fablab_RFID_control.ino` in Arduino IDE öffnen
3. ESP8266 per USB anschliessen
4. Richtigen COM-Port auswählen
5. **Sketch → Hochladen**

### 2.3 SPIFFS-Dateisystem flashen

Das Webinterface und die Konfigurationsdateien werden separat geflasht:

```bash
cd Firmware/Fablab_RFID_control
python spiffs_flash.py --port COM8
```

COM-Port anpassen (Windows: `COM8`, macOS/Linux: `/dev/ttyUSB0` o.ä.)

---

## 3. WLAN und Server konfigurieren

Nach dem ersten Start öffnet der Controller einen eigenen WLAN-Hotspot:

1. Mit WLAN **`RFIDnode-[MAC]`** verbinden (kein Passwort)
2. Browser öffnen → `http://192.168.4.1`
3. Login: **admin** / **admin** (danach ändern!)
4. Folgende Felder konfigurieren:

| Feld | Wert |
|---|---|
| Server Address | IP oder Domain des Labmanager-Servers |
| Server Port | `3000` (oder wie konfiguriert) |
| API Key | Aus der `api_keys`-Tabelle des Servers |
| Machine ID | ID der Maschine aus der `machines`-Tabelle |
| WLAN SSID | FabLab-WLAN-Name |
| WLAN Passwort | FabLab-WLAN-Passwort |

5. Speichern → Gerät startet neu und verbindet sich mit dem WLAN

---

## 4. RFID-Karten initialisieren

Mifare Classic 1K Karten müssen vor dem Einsatz initialisiert werden. Der Controller schreibt dabei einen Zugangscode auf Block 4 (Sektor 1) der Karte.

### 4.1 Admin-Karte einrichten

Die Admin-Karte ermöglicht das Einloggen in den Konfigurationsmodus direkt am Gerät.

1. Im Webinterface die **Admin-UID** eintragen (UID der gewünschten Admin-Karte als Dezimalzahl)
2. Die UID einer Karte lässt sich auslesen indem man sie kurz an den Leser hält — die UID erscheint im OLED-Display und im Browser-Websocket-Log

### 4.2 Zugangscode auf Karte schreiben (Karte initialisieren)

Der Controller verwendet einen 16-Byte **RFID-Code** (`config.RFIDcode`) und einen 6-Byte **RFID-Schlüssel** (`config.RFIDkey`) um Karten zu authentifizieren.

**Ablauf:**
1. Im Webinterface: **RFID Key** und **RFID Code** festlegen (für alle Karten gleich)
2. Karte an den Leser halten
3. Controller versucht den Code zu lesen (Block 4) und bei Misserfolg neu zu schreiben
4. Erfolgreiche Initialisierung: grüne LED + Bestätigungston

> **Wichtig:** RFID Key und RFID Code müssen auf allen Controllern im FabLab identisch sein, sonst werden Karten an anderen Geräten nicht erkannt.

### 4.3 Karten-UID in den Server eintragen

Die UID der Karte (32-Bit-Integer) muss als `id` in die `tags`-Tabelle des Servers eingetragen werden:

1. Karte an Controller halten → UID ablesen (Display oder Webinterface)
2. In der Labmanager-App: Mitglied öffnen → **Tags** → **Badge ausgeben**
3. Tag-ID = UID der Karte als Dezimalzahl eingeben
4. Rechte zuweisen: **Rechte** → **+ Recht hinzufügen**

---

## 5. Betrieb

### Normaler Zugang
1. Mitglied hält Karte an Leser
2. Controller prüft UID gegen lokale Datenbank
3. Hat Mitglied Recht für diese Maschine → **grüne LED + Ton + Relais schaltet ein**
4. Zum Abmelden: Karte nochmals halten → Relais schaltet aus, Nutzung wird geloggt

### Offline-Modus
Bei Netzwerkausfall arbeitet der Controller mit der lokal gespeicherten Datenbank weiter. Events werden auf SD-Karte gespeichert und beim nächsten Server-Kontakt übertragen.

### Synchronisation
Der Controller synchronisiert periodisch:
- **Tags/Rechte:** `GET /api/machines/{id}/tags`
- **Maschineneinstellungen:** `GET /api/machines/{id}`
- **Event-Logs:** `POST /api/logs`

---

## 6. LED- und Ton-Signale

| Signal | Bedeutung |
|---|---|
| Grüne LED + kurzer Ton | Zugang gewährt / Karte erkannt |
| Rote LED + langer Ton | Kein Zugang (kein Recht oder Karte ungültig) |
| Gelbe LED | Netzwerk-Aktivität |
| Blinken | Offline-Modus aktiv |

---

## 7. Webinterface

Erreichbar unter `http://[IP-des-Controllers]` (IP im WLAN über Router-DHCP-Tabelle ermitteln).

| Bereich | Inhalt |
|---|---|
| Status | Verbindungsstatus, aktuelle Uhrzeit, Maschinenname |
| Konfiguration | Server, WLAN, API-Key, Machine-ID, RFID-Schlüssel |
| Datenbank | Gespeicherte Benutzereinträge anzeigen |
| Log | Letzten Events |
| Update | Firmware-Update über OTA |

Standard-Login: **admin** / **admin**

---

## 8. Fehlerbehebung

| Problem | Lösung |
|---|---|
| Karte wird nicht erkannt | RFID Key/Code prüfen — muss mit Controller-Konfiguration übereinstimmen |
| Kein Server-Kontakt | API Key und Machine-ID im Webinterface prüfen; Server-Erreichbarkeit testen |
| Controller startet im Hotspot-Modus | WLAN-Zugangsdaten falsch oder SPIFFS nicht geflasht |
| UID erscheint nicht | Karte näher an Leser halten; Antennenverstärkung im Code erhöhen |
| Rechte werden nicht aktualisiert | Sync-Intervall abwarten oder Controller neu starten |

---

## 9. Wichtige Werte für den FabLab-Betrieb

Diese Werte müssen auf allen Controllern identisch sein und sicher aufbewahrt werden:

- **RFID Key** (6 Byte): `FF FF FF FF FF FF` (Standard — unbedingt ändern!)
- **RFID Code** (16 Byte): Frei wählbar, FabLab-intern festlegen
- **API Key**: Pro Controller unterschiedlich, in `api_keys`-Tabelle hinterlegt

---

*Firmware-Lizenz: GNU LGPL v3 | Hardware-Lizenz: CC-BY-SA 4.0*
