-- FabLab Winti – Config-Seeds (idempotent)
-- Nur config-Tabelle; Schema wird manuell / via phpMyAdmin verwaltet.
-- Ausführen: mysql -u fablab -p fablabwinti --default-character-set=utf8mb4 < db/init.sql

INSERT INTO config (`key`, value, type, description)
VALUES
  ('balance.credit_accounts',     '["1000","1001"]', 'json',    'Erlaubte Gegenkonten Einzahlung'),
  ('balance.max_deposit',         '500',             'number',  'Max. Guthaben pro Mitglied (CHF)'),
  ('right.default_days',          '365',             'number',  'Standard-Laufzeit für neue Maschinenrechte in Tagen'),
  ('tag.deposit_amount',          '20',              'number',  'Depot-Gebühr für Ersatzkarte (CHF)'),
  ('upgrade.expire_notify_emails','[]',              'json',    'Empfänger bei Upgrade-Ablauf'),
  ('upgrade.notify_emails',       '[]',              'json',    'Empfänger Upgrade-Meldungen'),
  ('webling.auto_calc_months',    'true',            'boolean', 'Automatische Monats-Berechnung'),
  ('webling.exmember_months',     '0',               'number',  'Monate Ex-Mitglieder behalten'),
  ('webling.max_members',         '500',             'number',  'Max. Mitglieder in Webling'),
  ('webling.reserve',             '20',              'number',  'Reserve unter Maximum'),
  ('webling.active_statuses',     '[]',              'json',    'Webling-Statuses die als aktive Mitglieder gelten (leer = alle)'),
  ('webling.fachgruppe_roles',    '{"LabManager":"labmanager","ICT":"admin"}', 'json', 'Fachgruppen-Name → lokale Rolle'),
  ('webling.member_group_id',     '0',               'number',  'Webling membergroup-ID für neue Mitglieder (0 = kein Parent)'),
  ('balance.gift_credit_account', '',                'string',  'Webling-Konto HABEN bei Guthaben-Schenkung (z.B. 1001)'),
  ('balance.gift_accounts',       '[]',              'json',    'Konti für Guthaben-Schenkung: [{konto_nr, bezeichnung, fachgruppe?}]'),
  ('webling.status_groups',       '{}',              'json',    'Status-Substring → Webling Membergroup-ID, z.B. {"Basis":248,"Premium":249}')
ON DUPLICATE KEY UPDATE
  type        = VALUES(type),
  description = VALUES(description);
-- Hinweis: value wird bei ON DUPLICATE KEY NICHT überschrieben,
-- damit bestehende Einstellungen beim Neuausführen erhalten bleiben.
