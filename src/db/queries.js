'use strict';

module.exports = {

  // ── Assignments (Modul A) ──────────────────────────────────────────────────

  getSchedules: `
    SELECT id, weekday, open_time, close_time FROM schedules ORDER BY weekday ASC`,

  upsertSchedule: `
    INSERT INTO schedules (weekday, open_time, close_time)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE open_time = VALUES(open_time), close_time = VALUES(close_time)`,

  deleteSchedule: `
    DELETE FROM schedules WHERE weekday = ?`,

  getAssignments: `
    SELECT a.id, a.date, a.start_time, a.end_time, a.status, a.gcal_event_id,
           u.id AS user_id, u.name AS user_name, u.email AS user_email
    FROM assignments a
    JOIN users u ON u.id = a.user_id
    WHERE a.date BETWEEN ? AND ?
    ORDER BY a.date ASC, a.start_time ASC`,

  getAssignmentById: `
    SELECT a.id, a.date, a.start_time, a.end_time, a.status, a.gcal_event_id,
           u.id AS user_id, u.name AS user_name, u.email AS user_email
    FROM assignments a
    JOIN users u ON u.id = a.user_id
    WHERE a.id = ?`,

  insertAssignment: `
    INSERT INTO assignments (user_id, date, start_time, end_time, status)
    VALUES (?, ?, ?, ?, 'scheduled')`,

  updateAssignment: `
    UPDATE assignments SET date = ?, start_time = ?, end_time = ?, user_id = ?
    WHERE id = ?`,

  updateAssignmentGcal: `
    UPDATE assignments SET gcal_event_id = ? WHERE id = ?`,

  cancelAssignment: `
    UPDATE assignments SET status = 'cancelled' WHERE id = ?`,

  // Active labmanagers with their preferences (NULL prefs = use defaults)
  getLabmanagers: `
    SELECT u.id, u.name, u.email,
           COALESCE(p.priority, 5)      AS priority,
           COALESCE(p.max_per_month, 4) AS max_per_month,
           p.weekday                    AS preferred_weekday
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r       ON r.id = ur.role_id AND r.name = 'labmanager'
    LEFT JOIN lm_preferences p ON p.user_id = u.id
    WHERE u.active = 1
    ORDER BY p.priority ASC, u.name ASC`,

  // How many confirmed/scheduled assignments each labmanager has in a given month
  getMonthlyAssignmentCounts: `
    SELECT user_id, COUNT(*) AS count
    FROM assignments
    WHERE DATE_FORMAT(date, '%Y-%m') = ?
      AND status != 'cancelled'
    GROUP BY user_id`,

  // Check if a user is already assigned on a specific date
  getAssignmentOnDate: `
    SELECT id FROM assignments
    WHERE user_id = ? AND date = ? AND status != 'cancelled'
    LIMIT 1`,

  getLmPreferences: `
    SELECT id, weekday, priority, max_per_month
    FROM lm_preferences WHERE user_id = ?`,

  upsertLmPreferences: `
    INSERT INTO lm_preferences (user_id, weekday, priority, max_per_month)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      weekday       = VALUES(weekday),
      priority      = VALUES(priority),
      max_per_month = VALUES(max_per_month)`,

  insertSubstitution: `
    INSERT INTO substitutions (original_id, substitute_id, created_at)
    VALUES (?, ?, NOW())`,

  getSubstitutionByAssignment: `
    SELECT s.id, s.substitute_id, u.name AS substitute_name, u.email AS substitute_email
    FROM substitutions s
    JOIN users u ON u.id = s.substitute_id
    WHERE s.original_id = ?
    ORDER BY s.created_at DESC LIMIT 1`,

  // ── Browser: Members ──────────────────────────────────────────────────────

  insertMember: `
    INSERT INTO users (name, email, password_hash, active) VALUES (?, ?, ?, 1)`,

  insertMemberRole: `
    INSERT IGNORE INTO user_roles (user_id, role_id)
    SELECT ?, id FROM roles WHERE name = ?`,

  checkEmailExists: `
    SELECT id FROM users WHERE email = ?`,

  // ── Webling Sync (Modul H) ─────────────────────────────────────────────────

  getMembersToCreateInWebling: `
    SELECT id, name, email, membership_status, zynex_id
    FROM users
    WHERE webling_id IS NULL
      AND zynex_id IS NOT NULL
      AND (
        membership_status IN (?)
        OR membership_status = 'Ex-Mitglied'
      )`,

  getMemberByWeblingId: `
    SELECT id FROM users WHERE webling_id = ?`,

  getMemberByEmail: `
    SELECT id, webling_id FROM users WHERE email = ?`,

  updateMemberFromWebling: `
    UPDATE users SET name = ?, email = ?, active = 1 WHERE webling_id = ?`,

  linkMemberWebling: `
    UPDATE users SET name = ?, webling_id = ?, active = 1 WHERE id = ?`,

  insertMemberFromWebling: `
    INSERT INTO users (webling_id, name, email, active) VALUES (?, ?, ?, 1)`,

  deactivateOrphanedMembers: `
    UPDATE users SET active = 0
    WHERE webling_id IS NOT NULL AND webling_id NOT IN (?)`,

  updateWeblingMeta: `
    UPDATE users SET webling_meta = ? WHERE webling_id = ?`,

  updateMemberContact: `
    UPDATE users SET email = ?, webling_meta = ? WHERE id = ?`,

  getUserIdByWeblingId: `
    SELECT id FROM users WHERE webling_id = ?`,

  getFachgruppeByWeblingGroupId: `
    SELECT id, name FROM fachgruppen WHERE webling_group_id = ?`,

  insertFachgruppe: `
    INSERT IGNORE INTO fachgruppen (name, webling_group_id) VALUES (?, ?)`,

  updateFachgruppeName: `
    UPDATE fachgruppen SET name = ? WHERE webling_group_id = ?`,

  deleteUserFachgruppeByFachgruppeId: `
    DELETE FROM user_fachgruppen WHERE fachgruppe_id = ?`,

  insertUserFachgruppe: `
    INSERT IGNORE INTO user_fachgruppen (user_id, fachgruppe_id) VALUES (?, ?)`,

  // ── Knowledge edit (Labmanager) ────────────────────────────────────────────

  getAllKnowledge: `
    SELECT id, name FROM knowledge ORDER BY name ASC`,

  getKnowledgeByName: `
    SELECT id, name FROM knowledge WHERE name = ?`,

  createKnowledge: `
    INSERT INTO knowledge (name) VALUES (?)`,

  addUserKnowledge: `
    INSERT IGNORE INTO user_knowledge (user_id, knowledge_id) VALUES (?, ?)`,

  removeUserKnowledge: `
    DELETE FROM user_knowledge WHERE user_id = ? AND knowledge_id = ?`,

  getMembersSummary: `
    SELECT
      COALESCE(membership_status, '(kein Status)') AS status,
      COUNT(*) AS total,
      SUM(webling_id IS NOT NULL) AS in_webling
    FROM users
    GROUP BY membership_status
    ORDER BY total DESC`,

  getMembers: `
    SELECT u.id, u.name, u.email, u.active, u.webling_id,
           GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ',') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r       ON r.id = ur.role_id
    WHERE (:search IS NULL OR u.name LIKE :search OR u.email LIKE :search)
      AND (:active IS NULL OR u.active = :active)
      AND (:role   IS NULL OR r.name   = :role)
    GROUP BY u.id
    ORDER BY u.name ASC
    LIMIT :limit OFFSET :offset`,

  getMemberById: `
    SELECT u.id, u.name, u.email, u.active, u.webling_id, u.webling_meta, u.membership_status, u.zynex_id,
           GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ',') AS roles
    FROM users u
    LEFT JOIN user_roles ur    ON ur.user_id = u.id
    LEFT JOIN roles r          ON r.id = ur.role_id
    WHERE u.id = ?
    GROUP BY u.id`,

  getMemberKnowledge: `
    SELECT k.id, k.name
    FROM user_knowledge uk
    JOIN knowledge k ON k.id = uk.knowledge_id
    WHERE uk.user_id = ?
    ORDER BY k.name ASC`,

  getMemberLogs: `
    SELECT l.id, l.created_at, l.invoice_id,
           m.name AS machine_name,
           e.name AS event_name
    FROM logs l
    JOIN machines m ON m.id = l.machine_id
    JOIN events   e ON e.id = l.event_id
    JOIN tags     t ON t.id = l.tag_id
    WHERE t.user_id = ?
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?`,

  getMemberInvoices: `
    SELECT i.id, i.total, i.created_at, i.paid_at,
           p.name AS paymode
    FROM invoices i
    LEFT JOIN paymode p ON p.id = i.paymode_id
    WHERE i.user_id = ?
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?`,

  getMemberRights: `
    SELECT r.id, r.valid_from, r.valid_to,
           m.id AS machine_id, m.name AS machine_name,
           m.period, m.min_periods, m.min_price, m.price,
           t.id AS tag_id, t.blocked
    FROM rights r
    JOIN machines m ON m.id = r.machine_id
    JOIN tags     t ON t.id = r.tag_id
    WHERE t.user_id = ?
      AND t.blocked = 0
      AND (r.valid_to IS NULL OR r.valid_to >= CURDATE())
    ORDER BY m.name ASC`,

  getMemberRightsManage: `
    SELECT r.id, r.valid_from, r.valid_to,
           m.id AS machine_id, m.name AS machine_name,
           t.id AS tag_id
    FROM rights r
    JOIN machines m ON m.id = r.machine_id
    JOIN tags     t ON t.id = r.tag_id
    WHERE t.user_id = ?
    ORDER BY m.name ASC, r.valid_to DESC`,

  getAllMachines: `
    SELECT id, name, price, konto_nr, period, min_periods, min_price, active FROM machines ORDER BY name ASC`,

  insertMachine: `
    INSERT INTO machines (name, period, min_periods, min_price, price, konto_nr, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)`,

  updateMachine: `
    UPDATE machines SET name=?, period=?, min_periods=?, min_price=?, price=?, konto_nr=?, active=? WHERE id=?`,

  getAllConfig: `
    SELECT \`key\`, value, type, description FROM config
    WHERE \`key\` NOT LIKE 'google.%'
    ORDER BY \`key\` ASC`,

  insertRight: `
    INSERT IGNORE INTO rights (tag_id, machine_id, valid_from, valid_to) VALUES (?,?,?,?)`,

  updateRight: `
    UPDATE rights SET valid_from = ?, valid_to = ? WHERE id = ?`,

  deleteRight: `
    DELETE FROM rights WHERE id = ?`,

  getRightById: `
    SELECT id, tag_id, machine_id FROM rights WHERE id = ?`,

  getUserNameByTagId: `
    SELECT u.name FROM tags t JOIN users u ON u.id = t.user_id WHERE t.id = ? LIMIT 1`,

  getMemberUpgrade: `
    SELECT event_type, upgrade_type, start_date, expiry_date, created_at, note
    FROM upgrade_history
    WHERE member_id = ?
    ORDER BY created_at DESC
    LIMIT 10`,

  updateMemberPassword: `
    UPDATE users SET password_hash = ? WHERE id = ?`,

  updateMemberStatus: `
    UPDATE users SET membership_status = ? WHERE id = ?`,

  // ── Browser: Tags / Badges ─────────────────────────────────────────────────

  getTagById: `
    SELECT t.id, t.user_id, t.blocked, t.replacement_id, t.created_at,
           u.name AS user_name, u.email AS user_email, u.active AS user_active,
           GROUP_CONCAT(DISTINCT r2.name ORDER BY r2.name SEPARATOR ',') AS user_roles
    FROM tags t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r2      ON r2.id = ur.role_id
    WHERE t.id = ?
    GROUP BY t.id`,

  getTagsByMember: `
    SELECT t.id, t.blocked, t.replacement_id, t.created_at
    FROM tags t
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC`,

  insertTag: `
    INSERT INTO tags (user_id, blocked, created_at)
    VALUES (?, 0, NOW())`,

  blockTag: `
    UPDATE tags SET blocked = 1 WHERE id = ?`,

  setTagReplacement: `
    UPDATE tags SET replacement_id = ?, blocked = 1 WHERE id = ?`,

  unassignTag: `
    UPDATE tags SET user_id = NULL, blocked = 0 WHERE id = ?`,

  deleteTag: `DELETE FROM tags WHERE id = ?`,

  tagHasLogs: `SELECT COUNT(*) AS n FROM logs WHERE tag_id = ? LIMIT 1`,

  reactivateOriginalTag: `
    UPDATE tags SET blocked = 0, replacement_id = NULL WHERE id = ?`,

  deleteRightsByTagId: `
    DELETE FROM rights WHERE tag_id = ?`,

  insertTagDeposit: `
    INSERT INTO tag_deposits (original_tag_id, replace_tag_id, user_id, amount)
    VALUES (?, ?, ?, ?)`,

  returnTagDeposit: `
    UPDATE tag_deposits SET returned_at = NOW(), returned_by = ?
    WHERE original_tag_id = ? AND returned_at IS NULL`,

  getOpenTagDeposit: `
    SELECT id, amount, paid_at
    FROM tag_deposits
    WHERE original_tag_id = ? AND returned_at IS NULL
    LIMIT 1`,

  // ── Browser: Invoices ──────────────────────────────────────────────────────

  getInvoiceById: `
    SELECT i.id, i.user_id, i.total, i.paymode_id, i.created_at, i.paid_at,
           p.name AS paymode, p.konto_nr AS paymode_konto_nr,
           u.name AS user_name, u.email AS user_email, u.webling_id,
           c.name AS created_by_name, i.created_by
    FROM invoices i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN paymode p ON p.id = i.paymode_id
    LEFT JOIN users c ON c.id = i.created_by
    WHERE i.id = ?`,

  getInvoicePdf: `
    SELECT \`blob\` AS \`blob\` FROM documents
    WHERE invoice_id = ? AND type = 'pdf'
    ORDER BY created_at DESC LIMIT 1`,

  deleteInvoicePdf: `
    DELETE FROM documents WHERE invoice_id = ? AND type = 'pdf'`,

  cancelInvoice: `
    DELETE FROM invoices WHERE id = ? AND paymode_id IS NULL`,

  payInvoice: `
    UPDATE invoices SET paymode_id = ?, paid_at = NOW() WHERE id = ?`,

  unPayInvoice: `
    UPDATE invoices SET paymode_id = NULL, paid_at = NULL WHERE id = ?`,

  unlinkLogsFromInvoice: `
    UPDATE logs SET invoice_id = NULL WHERE invoice_id = ?`,

  getAllPaymodes: `
    SELECT id, name, konto_nr FROM paymode ORDER BY name ASC`,

  updatePaymode: `
    UPDATE paymode SET konto_nr = ? WHERE id = ?`,

  // ── Auth ───────────────────────────────────────────────────────────────────

  getUserByEmail: `
    SELECT id, name, email, password_hash
    FROM users WHERE email = ? AND active = 1`,

  getUserByTagUid: `
    SELECT u.id, u.name, u.membership_status
    FROM tags t
    JOIN users u ON u.id = t.user_id
    WHERE t.id = ? AND t.blocked = 0 AND u.active = 1
    LIMIT 1`,

  setBadgeLoginEnabled: `
    UPDATE users SET badge_login_enabled = ? WHERE id = ?`,

  getRolesByUserId: `
    SELECT r.name FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?`,

  // ── Controller ─────────────────────────────────────────────────────────────

  getMachineByApiKey: `
    SELECT id FROM machines WHERE api_key = ? AND active = 1`,

  checkTagRight: `
    SELECT u.id AS user_id, u.name
    FROM rights r
    JOIN tags t  ON t.id = r.tag_id
    JOIN users u ON u.id = t.user_id
    WHERE r.tag_id = ? AND r.machine_id = ?
      AND t.blocked = 0
      AND (r.valid_to IS NULL OR r.valid_to >= CURDATE())`,

  insertLog: `
    INSERT INTO logs (tag_id, machine_id, event_id, created_at)
    VALUES (?, ?, ?, ?)`,

  insertLogIgnore: `
    INSERT IGNORE INTO logs (tag_id, machine_id, event_id, created_at)
    VALUES (?, ?, ?, ?)`,

  getRightsForMachine: `
    SELECT r.tag_id, r.valid_to
    FROM rights r
    JOIN tags t ON t.id = r.tag_id
    WHERE r.machine_id = ?
      AND t.blocked = 0
      AND (r.valid_to IS NULL OR r.valid_to >= CURDATE())`,

  getMachineConfig: `
    SELECT name, period, min_periods, min_price, price
    FROM machines WHERE id = ?`,

  getMemberActiveSessions: `
    SELECT m.id, m.name AS machine_name, l.created_at AS session_start
    FROM machines m
    JOIN (
      SELECT l2.machine_id, MAX(l2.id) AS last_log_id
      FROM logs l2
      JOIN tags t ON t.id = l2.tag_id
      WHERE t.user_id = ?
      GROUP BY l2.machine_id
    ) latest ON latest.machine_id = m.id
    JOIN logs  l ON l.id  = latest.last_log_id
    JOIN events e ON e.id = l.event_id
    WHERE e.name IN ('start','login','running','running1')
      AND m.active = 1
    ORDER BY m.name ASC`,

  getMachineStatus: `
    SELECT
      m.id, m.name, m.last_heartbeat,
      l.created_at  AS session_start,
      e.name        AS last_event,
      u.name        AS user_name,
      u.id          AS user_id
    FROM machines m
    LEFT JOIN (
      SELECT machine_id, MAX(id) AS last_log_id
      FROM logs
      GROUP BY machine_id
    ) latest ON latest.machine_id = m.id
    LEFT JOIN logs  l ON l.id  = latest.last_log_id
    LEFT JOIN events e ON e.id  = l.event_id
    LEFT JOIN tags   t ON t.id  = l.tag_id
    LEFT JOIN users  u ON u.id  = t.user_id
    WHERE m.active = 1
    ORDER BY m.name ASC`,

  // ── Shift Reports ─────────────────────────────────────────────────────────

  getMachineUsersAfter: `
    SELECT DISTINCT u.id, u.name
    FROM logs l
    JOIN tags  t ON t.id = l.tag_id
    JOIN users u ON u.id = t.user_id
    WHERE l.created_at >= ?
      AND u.id <> ?
    ORDER BY u.name ASC`,

  insertShiftReport: `
    INSERT INTO shift_reports (datum, labmanager_id, members, visitors, cashbox, notes)
    VALUES (CURDATE(), ?, ?, ?, ?, ?)`,

  getShiftReports: `
    SELECT sr.id, sr.datum, sr.members, sr.visitors, sr.cashbox, sr.notes,
           u.name AS labmanager_name
    FROM shift_reports sr
    JOIN users u ON u.id = sr.labmanager_id
    ORDER BY sr.datum DESC, sr.id DESC
    LIMIT 50`,

  // ── Firmware-kompatible Endpunkte ─────────────────────────────────────────

  getFirmwareMachineConfig: `
    SELECT id, name, price, period, min_periods, min_price AS minp_price
    FROM machines WHERE id = ? AND active = 1`,

  getFirmwareMachineTags: `
    SELECT
      r.id                                         AS tid,
      t.id                                         AS uid,
      u.name                                       AS name,
      COALESCE(UNIX_TIMESTAMP(r.valid_from), 0)    AS start,
      COALESCE(UNIX_TIMESTAMP(r.valid_to),   2147483647) AS \`end\`
    FROM rights r
    JOIN tags t ON t.id = r.tag_id
    JOIN users u ON u.id = t.user_id
    WHERE r.machine_id = ?
      AND t.blocked = 0
      AND u.active = 1
      AND (r.valid_from IS NULL OR r.valid_from <= CURDATE())
      AND (r.valid_to   IS NULL OR r.valid_to   >= CURDATE())
    ORDER BY u.name ASC`,

  updateHeartbeat: `
    UPDATE machines
    SET last_heartbeat = NOW(), firmware_version = ?, last_ip = ?
    WHERE id = ?`,

  // ── Balance ────────────────────────────────────────────────────────────────

  insertBalanceTransaction: `
    INSERT INTO balance_transactions
      (member_id, type, amount, account, reference, new_balance, requested_by_app, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,

  // ── Config ─────────────────────────────────────────────────────────────────

  getConfig: 'SELECT value, type FROM config WHERE `key` = ?',

  setConfig: `
    INSERT INTO config (\`key\`, value, updated_by, updated_at)
    VALUES (?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      value      = VALUES(value),
      updated_by = VALUES(updated_by),
      updated_at = NOW()`,

  // ── Display ────────────────────────────────────────────────────────────────

  // Single query – avoids N+1 by using GROUP_CONCAT for skills
  getUpcomingAssignments: `
    SELECT a.id, a.date, a.start_time, a.end_time,
           u.name, u.id AS user_id,
           d.id AS photo_id,
           GROUP_CONCAT(k.name ORDER BY k.name SEPARATOR ',') AS skills_csv
    FROM assignments a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN documents d       ON d.user_id = u.id AND d.type = 'photo'
    LEFT JOIN user_knowledge uk ON uk.user_id = u.id
    LEFT JOIN knowledge k       ON k.id = uk.knowledge_id
    WHERE a.date >= CURDATE()
      AND a.status != 'cancelled'
    GROUP BY a.id, a.date, a.start_time, a.end_time, u.name, u.id, d.id
    ORDER BY a.date ASC, a.start_time ASC
    LIMIT ?`,

  // ── Billing ────────────────────────────────────────────────────────────────

  // Open log entries (no invoice yet) for a given user, ordered per machine + time.
  // start/stop pairs are reconstructed in JS to stay DB-agnostic.
  getOpenLogsForUser: `
    SELECT l.id, l.machine_id, l.event_id, l.created_at,
           e.name  AS event_name,
           m.name  AS machine_name,
           m.period, m.min_periods, m.min_price, m.price,
           m.konto_nr
    FROM logs l
    JOIN events   e ON e.id = l.event_id
    JOIN machines m ON m.id = l.machine_id
    JOIN tags     t ON t.id = l.tag_id
    WHERE t.user_id       = ?
      AND l.invoice_id IS NULL
    ORDER BY l.machine_id ASC, l.created_at ASC`,

  createInvoice: `
    INSERT INTO invoices (user_id, total, paymode_id, created_by, created_at)
    VALUES (?, ?, ?, ?, NOW())`,

  markLogsInvoiced: `
    UPDATE logs SET invoice_id = ?
    WHERE id IN (?)`,

  storeInvoicePdf: `
    INSERT INTO documents (user_id, invoice_id, type, mime_type, \`blob\`, created_at)
    VALUES (?, ?, 'pdf', 'application/pdf', ?, NOW())`,

  getInvoiceWithItems: `
    SELECT i.id, i.total, i.created_at,
           u.name AS user_name, u.email,
           p.name AS paymode,
           c.name AS created_by_name
    FROM invoices i
    JOIN users   u ON u.id = i.user_id
    LEFT JOIN users c ON c.id = i.created_by
    LEFT JOIN paymode p ON p.id = i.paymode_id
    WHERE i.id = ?`,

  getLogsForInvoice: `
    SELECT l.id, l.machine_id, l.created_at, e.name AS event_name,
           m.name AS machine_name, m.period, m.min_periods, m.min_price, m.price,
           m.konto_nr
    FROM logs l
    JOIN events   e ON e.id  = l.event_id
    JOIN machines m ON m.id  = l.machine_id
    WHERE l.invoice_id = ?
    ORDER BY l.machine_id ASC, l.created_at ASC`,

  getArticles: `
    SELECT id, name, description, price, konto_nr, is_balance_deposit FROM articles WHERE active = 1 ORDER BY name ASC`,

  getAllArticles: `
    SELECT id, name, description, price, konto_nr, is_balance_deposit, active FROM articles ORDER BY name ASC`,

  insertArticle: `
    INSERT INTO articles (name, description, price, konto_nr, is_balance_deposit, active) VALUES (?, ?, ?, ?, ?, 1)`,

  updateArticle: `
    UPDATE articles SET name = ?, description = ?, price = ?, konto_nr = ?, is_balance_deposit = ? WHERE id = ?`,

  setArticleActive: `
    UPDATE articles SET active = ? WHERE id = ?`,

  insertInvoiceItem: `
    INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total, credit_account, is_correction)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,

  getInvoiceItems: `
    SELECT id, description, quantity, unit_price, total, credit_account, is_correction
    FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`,

  deleteInvoiceItem: `
    DELETE FROM invoice_items WHERE id = ? AND invoice_id = ?`,

  // ── invoice_machine_lines ──────────────────────────────────────────────────

  insertMachineLine: `
    INSERT INTO invoice_machine_lines
      (invoice_id, machine_id, machine_name, usage_seconds, period, min_periods, min_price, price, line_price, konto_nr, start_iso, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  getMachineLines: `
    SELECT id, machine_id, machine_name, usage_seconds, period, min_periods, min_price, price, line_price, konto_nr, start_iso
    FROM invoice_machine_lines WHERE invoice_id = ? ORDER BY sort_order ASC, id ASC`,

  updateMachineLineUsage: `
    UPDATE invoice_machine_lines SET usage_seconds = ?, line_price = ? WHERE id = ? AND invoice_id = ?`,

  deleteMachineLines: `
    DELETE FROM invoice_machine_lines WHERE invoice_id = ?`,

  // ── Upgrades ───────────────────────────────────────────────────────────────

  getExpiredUpgrades: `
    SELECT uh.id, uh.member_id, uh.upgrade_type
    FROM upgrade_history uh
    WHERE uh.event_type   = 'upgrade'
      AND uh.expiry_date <= CURDATE()
      AND NOT EXISTS (
        SELECT 1 FROM upgrade_history uh2
        WHERE uh2.member_id  = uh.member_id
          AND uh2.event_type IN ('revert','manual_revert')
          AND uh2.created_at > uh.created_at
      )`,

  insertUpgradeRevert: `
    INSERT INTO upgrade_history (member_id, event_type, created_at, note)
    VALUES (?, 'revert', NOW(), ?)`,

  getUserRoles: `
    SELECT r.name FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?`,

  deleteMemberRole: `
    DELETE ur FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name = ?`,

  getUserByIdSimple: `
    SELECT id, name, email, active, password_hash FROM users WHERE id = ?`,

  // ── Password Reset ────────────────────────────────────────────────────────

  getUserByEmailForReset: `
    SELECT id, name, email, active FROM users WHERE email = ?`,

  insertPasswordReset: `
    INSERT INTO password_resets (user_id, token_hash, expires_at)
    VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 2 HOUR))`,

  getPasswordReset: `
    SELECT pr.id, pr.user_id, pr.expires_at, pr.used
    FROM password_resets pr
    WHERE pr.token_hash = ?`,

  markPasswordResetUsed: `
    UPDATE password_resets SET used = 1 WHERE id = ?`,

  updateUserPassword: `
    UPDATE users SET password_hash = ? WHERE id = ?`,

};
