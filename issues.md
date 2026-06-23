Issues:

Webling Migration:
         Der Prozess muss geprüft und überarbeitet werden. Folgende Phasen werden benötigt:
         1. Leeren der Mariadb-Datenbank-Tabelle users sowie ihren Relationen.
         2. Einlesen der 5 excel-csv tabellen in die relevanten Tabellen der Mariadb-Datenbank. Simulieren der webling_meta.
            Upgrade-History in der webling_meta Membeship-History eintragen. 
         3. push der users mit den webling.active_statuses. Dabei auf Webling die Mitglieder-Datensätze mit der 
            "Mitglieder ID"="Zynex_ID" überschreiben. Löschen aller anderen Webling-Mitglieder ausser denen mit Status "Ex-Mitglied".
         4. Aktualisieren der user_fachgruppen aus einegesenen Zynex-Daten
         5. Ermitteln des freien Platzes an Mitglieder-Adressen abzüglich denen mit Status "Ex-Mitglied" gemäss der Regel
            webling.max_members - webling.reserve
         6. Falls der Platz auf Webling vorhanden ist, die entprechede Anzahl Ex-Mitglieder zu Webling pushen und dabei
            vorhandene, welche "Mitglieder ID"="Zynex_ID" haben, überschreiben. Falls zu wenig Platz ist, entsprechend älteste
            Ex-Mitglieder aus Webling entfernen.
         7. user_roles aktualisieren: Allen der User-Fachgruppe ICT bekommen Admin-Rolle, die der Fachruppe Labmanager die
            Labmanager-Rolle, alle anderen mit Status Mitglied* Mitglieder-Rolle. 
         8. Upgrades: Es gibt zwei Arten in Zynex: Mitgliedschaften von bis und Upgrades von bis, jeweils auf eine bestehende   Mitgliedschaft. Beide sollten im Feld Membership-Upgrade eingetragen werden. Ersteres als "_typ": "member" und     "typ" die Art der Mitgliedschaft: "basis", "premium" oder "commercial"
         letzteres als "_typ" upgrade und "typ" monthly-upgrade [bestehende Migliedschaft] > [Upgrade]:
           {
             "_key": "local:upg:...",
             "_typ": "upgrade",
             "date": [gemerktes Datum],
             "member_id": [Zynex ID],
             "name": "...",
             "typ": "monthly-upgrade [Status] > [Upgrade]",
             "gueltigAb": "[Upgrade start]",
             "gueltigBis": "[Upgrade end]"
           },
         
                                                                                   
Webling sync:
      
    Upgrade:
         Der Upgrade wird im Webling mit der Eingabe Upgrade von bis gemacht. Der wird verarbeitet vom täglichen Weebling sync.
         
         Vor dem synchronisieren eines Mitglieder-Recods folgender Prozess durcführen:
         Datum des Eintrags merken. Dieses Datum kann vor oder auch nach dem [Upgrade ab] sein.
         Wenn ein neues Uprade im Webling-Feld Upgrade zu finden ist, sollte im  Membership-Upgrade das als neuer Record eingetragen werden mit:
           {
             "_key": "local:upg:...",
             "_typ": "upgrade",
             "date": [gemerktes Datum],
             "member_id": [Mitglieder ID],
             "name": "...",
             "typ": "monthly-upgrade [Status] > [Upgrade]",
             "gueltigAb": "[Upgrade start]",
             "gueltigBis": "[Upgrade end]"
           },
         und eine Message an die ensprechende email-Adresse in den Einstellungen senden.
         
         Wenn beim derzeitigen Mitglied  das Datum abgelaufen ist, dann die drei Felder [Upgrade], [Upgrade ab] und [Upgrade bis] leeren und:
         Message an die ensprechende email-Adresse in den Einstellungen senden. Damit ist das Upgrade abgeschlossen.
         
         In der Anzeige im Upgrade Bereich anzeigen: Datum Upgrade [Status] > [Upgrade] von bis

    Mitgliedschafts-Änderung:
         ein Eintag vom typ "mitgliedschaft" in die Membership-History machen. Wenn bereits ein Eintrag besteht, der noch nicht gekündigt oder
         aisgeschlossen ist, diesen mit dem Event ergänzen, sonst einen neuen Eintrag eröffnen.
         Antrag:
                  nur Antragsdatum eintragen. 
         Eintritt:
                  Eintrittsdatum ergänzen
         Kündigung:
                  Kündigungsdatum ergänzen
         Ausschluss:
                  'bezeichnung': 'ausgeschlossen' ergänzen
    Plaz für Ex-Mitglieder:
         Platz ermitteln und Ex-Mitglieder zu Webling hinzufügen oder entfernen.

Invoice:
 
Belegung:
    Angezeigte Maschinenzeit ist falsch.

Labmanager Einsatzplanung:
    Einsatz-Präferenzen:
         - 0 Einsätze pro Monat möglich machen: Da Webling Fachgruppe Labmanager den Zugriff zur Einsatzpalnung haben, muss es auch möglich sein
           dass solche ohne Einsatz dabei sind, z.B. der Fachguppen-Leiter oder der Vorstand.
         - bis 3 bevorzugte Einsatztage möglich, mit Priorität 
         - Text bei Vertretung verbessern: "Vertretungsanfrage für [Labmanger] am [Datum / Zeit] versenden?"
         - Mehrere Abwesenheitsperioden für Einsatzplanung festlegbar machen. Beim Das Auto-generieren berücksichtigen. Nach Ablauf automatisch entfernen.
         - Ein Labmanager muss einen vorgeschlaganen Einsatz als "Verhindert" markieren können. In diesem Fall läuft das Auto-generieren nochmals ab.
    Auto-Generierung:
         - Nach Möglichkeit keine zwei Einsätze desselben Labmanagers hintereinander.
         - Das Auto-generieren der Einsätze so oft durchlaufen bis alle Präferenzen der Priorität nach prozessiert sind. Erst danach zufällige Einsätze vergeben.

Controllers:
- GET Machines from database funktioniert nicht. Routing?
- Poll für neue Rechte erfolgt nicht. 



statuses, die im Webling verbleiben müssen:
["Mitglied*", "Ausgeschlossen", "Extern Kursteilnehmer" ]