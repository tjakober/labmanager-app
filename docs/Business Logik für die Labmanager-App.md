# Business Logik für die Labmanager-App

## Webling
Mitglieder werden über Webling erfasst und die Zuteilung der Fachgruppen-Mitglieder erfolgt über Webling. Die Daten werden über den Webling-Sync in die Labmanager-App übertragen. Der Webling-Sync läuft täglich in der Nacht, hann aber von einem Admin auch manuell ausgelöst werden.
1. Webling hat die führende Rolle.
2. Rechte für die Labmanger App werden über die Fachgruppen zugeordnet. Fachgruppen-Mitglieder von ICT bekommen Admin-Rechte. FG Labmanager die Labmanager-Rechte. Alle anderen sind Mitglieder.
3. Alle können sich über über ihre im Webling erfasste Email-Adresse einloggen.
4. Erstmalig muss sich ein Mitglied über den Passwort-Verloren Link registrieren. Er gibt sein Passwort dort bekannt und bekommt sein Login-Link über seine registriete Mailadresse zugestellt. Dazu muss sein Gerät mit seinem Mail-Client im Fablab Wifi Netz befinden.
5. Jedem Mitglied kann einen RFID Tag zugeirdnet werden. Dann kann er sich in der Login-Maske auch mit dem Tag anmelden und muss nur noch sein Paswort eingeben.
6. Admins und Labmanager können auch einen Passwortfreien Zugriff in ihrem Profil aktivieren.
## Im Webling befindliche Adressen
Da wir aus Kostengründen nur eine beschränkte Zahl von Adressen im Webling aufbewaren können, werden ältere Adressen über das Status-Feld ausgelagert. 
Im Admin-Bereich der Labmanager-App kann konfiguriert werden, welche Adressen mir welchem Status im Webling verbleiben müssen.
Damit man möglichst viele Adressen im Webling online hat, wird beim Sych-Prozess berechent, für wiviele Monate zurück noch Adressen platz haben in der konfigurierbaren Maximum.

## Admin-Bereich
Folgende Bereiche befinden sich im Admin-Bereich:
- **Mitglieder**
    Hier werden die Informationen über ein zu wählendes Miglied angezeigt. Im Suchfeld können Namen, E-Mail oder die RFID-Tag Nummer eingegeben werden.
    Ausserdem gibt es Tabs für folgende Einstellungen:
    - Guthaben:     
        Ein informationsfeld für den Stand des Guthabens eines Mitglieds
    - Rechte:
        Die Nutungsrechte eines Mitglieds für die Maschinen, die er bedienen darf. Die Vorgabedauer kann in den Eistellungen konfiguriert werden.
    - Badges:
        Hier wird dem Mitglied ein RFID-Tag zugeordnet. Man kann verloren gemeldete Tags ersetzen durch ein neues Tag, das alte wird dadurch                gesperrt. Wenn das Mitglied die Karte wieder zurückbringt, wird die alte Karte wieder aktiviert und das Ersatz-Tag zur Weiterverwendung                freigegeben.
    - Logs:
        Hier werden die Maschinenlogs, die einem Mitglied zugeordnet sind, angezeigt.
    - Rechnungen:
        Hier können Rechnungen verwaltet werden. Durch Drücken des "Rechnung erstellen" Knopfes weden alle offenen Maschinenstunden berechnet und angezeigt. Zusätzlich konnen noch Maerial- und Getränkeposten hinzugefügt werden.
        Nach Fertigstellung kann die Rechnung abgeschlossen und gedruckt werden. Sie kann auch gleichzeitig durch den Labmanager als Bezahlt und verbucht werden.
        Die dazu möglichen Zahlungsmethoden können konfiguriert werden.
    - Upgrades:
        Hier werden die aktuellen Upgrades angezeigt, welche für das Mitglied gültig sind. Die Upgrades werden im Webling eingegeben. Die 3 Felder Upgrade, ab, bis werden ausgefüllt. Über das Webling-Sync weden die Ubgrades dann aktiviert und bei Ablauf automatisch deaktiviert.Bei diesen Ereignissen wird ein Mail an eine oder mehrere Adressen verschickt, damit die dafür verantwortlichen Personen für beipielsweise Zugangskontrolle oder so informiert werden. Diese Adressen können konfiguriert werden.
        Das Webling-Sync loggt zudem diese Ereignisse im Feld Membership-History.
- **Einsatzplanung**
    Gedacht für die Labmanager - Einsatzplanung. Noch nicht programmiert.
- **Guthaben**
    Zeigt das Guthaben eines Mitglieds. Einzahlungen erfolgen über das Rechnungsprogramm mittels des Artikels "Guthaben".
    Das eingezahlte Guthaben wird in der Buchhaltung auf das in der Konfiguration spezifizierte Konto eingezahlt und zum Feld Guthaben des Webling Mitglierderfelds "Guthaben" addiert. Es besteht eine Beschränkung des Guthabens pro Mitglied, konfigurierbar in den Einstellungen.
- **Belegung**
    Zeigt, wer derzeit an welcher Maschine welches Mitglied eingeloggt ist und wie lanhe schon. Wird alle 15 Sekunden akualisiert.
- **Einstellungen**
    Dient den Admins für die konfigurierbaren Einstellungen.
    - Maschinen: 
        Hier wird der Maschinenpark unterhalten und die Preisangaben für die Berechnung der Maschinenzeit festgelegt.
        Das Konto muss mit einem in der Buchhaltung vorhandenen Konto übereinstimmen, sonst werden Rechnungen nicht im Webling verbucht. 
    - Artikel:
        Hier können die Mengenpreise für Verkaufartikel und Getränke festgelegt werden.
    - Zahlungsarten:
        Hier werden die möglichen Zahlungsarten für die Erstellung der Rechnungen definiert.
    - Konfiguration:
        In diesem Bereich werden die bereits oben erwähnten Konfigurationen festgelegt.
    - Öffnungszeiten (Wochenplan):
        Hier können die Öffnungszeiten des FabLabs festgelegt werden. Dient für die Einatzplanung sowie das Info-Display.
    - Webling-Sync:
        Hier kann der Webling-Sync manuell ausgelöst werden. Der Webling-Sync wird Nachts un 02:00 Uhr automatisch gestartet.
        Der Webling-Sync Synchronisiert die im Webling veränderten Adressen in die Datenbank auf dem Applikationsserver übertragen.
        Dabei werden zusätlich folgende Manipulationen dutchgeführt:
        - Die Zugangsrechte für Administratoren der Labmanager-App werden für alle Mitglieder der ICT-Fachgruppe gewährleistet. Abgängern werden die Rechte entzogen.
        - Die Zugangsrechte für Labmanager  der Labmanager-App werden für alle Mitglieder der Labmanager-Fachgruppe gewährleistet. Abgängern werden die Rechte entzogen.
        - Die Upgrades werden in der Labmanager-App werden aktiviert und bei Ablauf deaktiviert sowie die Member-History aktualisiert. Dabei werden auch Änderungen im Status protokolliert. Alle Änderungen werden jeweils im Logfile logs/webling-sync.log eingetragen.
    - Google Kalender
        Dient für die Zugangsdaten zum Google Kalender. Wird für die Einsatzplanung und das InfoDisplay verwendet.
- **Profil**
    Im Profil-Bereich kann man sein Passwort ändern. 
    Wer will, kann das Badge-Login aktivieren. Dann nann er an einem PC mit RFID-Leser sich ohne Passwort anmelden. Er stellt den Cursor ins Email Feld und hält den RFID-Tag über den Leser. Ist das Badge-Login nicht aktiviert, muss er das Passwort noch eingeben. Per Default ist das Badge-Login deaktiviert.
    Einsatz-Präferenzen:
        Dies ist für die Labmanager-Einstzplanung gedacht. Zur Zeit noch nicht programmiert.
