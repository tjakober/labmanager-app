-- Migration: invoice_machine_lines Tabelle hinzufügen
-- Ausführen: mysql -u fablab -p fablabwinti --default-character-set=utf8mb4 < migration/add_invoice_machine_lines.sql

CREATE TABLE IF NOT EXISTS `invoice_machine_lines` (
  `id`           int          NOT NULL AUTO_INCREMENT,
  `invoice_id`   int          NOT NULL,
  `machine_id`   int          DEFAULT NULL,
  `machine_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `usage_seconds` int         NOT NULL DEFAULT 0,
  `period`       int          NOT NULL DEFAULT 0,
  `min_periods`  int          NOT NULL DEFAULT 1,
  `min_price`    decimal(10,2) DEFAULT NULL,
  `price`        decimal(10,2) NOT NULL,
  `line_price`   decimal(10,2) NOT NULL,
  `konto_nr`     varchar(20)  COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `start_iso`    varchar(30)  COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order`   int          NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `invoice_id` (`invoice_id`),
  CONSTRAINT `iml_invoice_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Config: Labmanager-Rabatt
INSERT INTO config (`key`, value, type, description)
VALUES ('invoice.labmanager_discount', '50', 'number', 'Rabatt für Labmanager auf Maschinenzeit in % (0 = kein Rabatt)')
ON DUPLICATE KEY UPDATE type = VALUES(type), description = VALUES(description);
