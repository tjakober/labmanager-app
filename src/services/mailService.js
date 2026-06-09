'use strict';

const nodemailer    = require('nodemailer');
const cfg           = require('../config');
const configService = require('./configService');

// Transport is created lazily so a missing MAIL_HOST doesn't crash startup
let _transport = null;

function transport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host:   cfg.mail.host,
      port:   cfg.mail.port,
      secure: cfg.mail.port === 465,
      auth: {
        user: cfg.mail.user,
        pass: cfg.mail.password,
      },
    });
  }
  return _transport;
}

// ── Core send ──────────────────────────────────────────────────────────────────

/**
 * Low-level send. All other functions call this.
 * @param {{ to: string|string[], subject: string, text: string, html?: string }} mail
 */
async function send({ to, subject, text, html }) {
  if (!cfg.mail.host) {
    console.warn('[mailService] MAIL_HOST nicht konfiguriert – E-Mail nicht gesendet:', subject);
    return;
  }

  await transport().sendMail({
    from:    cfg.mail.from,
    to:      Array.isArray(to) ? to.join(', ') : to,
    subject,
    text,
    html: html || text.replace(/\n/g, '<br>'),
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(d) {
  if (!d) return '–';
  return new Date(d).toLocaleDateString('de-CH');
}

function formatDateTime(d) {
  if (!d) return '–';
  return new Date(d).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
}

// ── Upgrade notifications (Modul F) ───────────────────────────────────────────

/**
 * Sent to upgrade.notify_emails when a labmanager books an upgrade.
 */
async function sendUpgradeBooked(member, upgradeType, startDate, expiryDate) {
  const recipients = await configService.get('upgrade.notify_emails') || [];
  if (!recipients.length) return;

  await send({
    to:      recipients,
    subject: `Upgrade gebucht: ${member.name} → ${upgradeType}`,
    text: [
      `Upgrade-Buchung`,
      ``,
      `Mitglied:   ${member.name} (${member.email})`,
      `Typ:        ${upgradeType}`,
      `Gültig ab:  ${formatDate(startDate)}`,
      `Gültig bis: ${formatDate(expiryDate)}`,
    ].join('\n'),
  });
}

/**
 * Sent to upgrade.expire_notify_emails when an upgrade expires automatically.
 */
async function sendUpgradeExpired(member, upgradeType) {
  const recipients = await configService.get('upgrade.expire_notify_emails') || [];
  if (!recipients.length) return;

  await send({
    to:      recipients,
    subject: `Upgrade abgelaufen: ${member.name}`,
    text: [
      `Upgrade abgelaufen – Zugang prüfen!`,
      ``,
      `Mitglied: ${member.name} (${member.email})`,
      `Typ:      ${upgradeType}`,
      ``,
      `Das Upgrade wurde automatisch zurückgesetzt.`,
      `Bitte den Zugang zur Maschine prüfen und ggf. anpassen.`,
    ].join('\n'),
  });
}

// ── Substitution notifications (Modul A.4) ────────────────────────────────────

/**
 * Sent to a potential substitute asking them to accept/decline.
 * confirmUrl and rejectUrl are one-click links (signed tokens recommended).
 */
async function sendSubstitutionRequest(assignment, substitute, confirmUrl, rejectUrl) {
  await send({
    to:      substitute.email,
    subject: `Labmanager-Einsatz: Kannst du einspringen? (${formatDate(assignment.date)})`,
    text: [
      `Hallo ${substitute.name}`,
      ``,
      `${assignment.original_name} kann den Einsatz am ${formatDate(assignment.date)} nicht wahrnehmen.`,
      `Kannst du einspringen?`,
      ``,
      `Datum:  ${formatDate(assignment.date)}`,
      `Zeit:   ${assignment.start_time ? `${assignment.start_time} – ${assignment.end_time}` : 'ganztags'}`,
      ``,
      `✅ Ja, ich übernehme:  ${confirmUrl}`,
      `❌ Nein, kann nicht:   ${rejectUrl}`,
      ``,
      `Diese Links sind 48 Stunden gültig.`,
    ].join('\n'),
    html: [
      `<p>Hallo ${substitute.name},</p>`,
      `<p><strong>${assignment.original_name}</strong> kann den Einsatz am <strong>${formatDate(assignment.date)}</strong> nicht wahrnehmen.</p>`,
      `<table>`,
      `  <tr><td>Datum:</td><td>${formatDate(assignment.date)}</td></tr>`,
      `  <tr><td>Zeit:</td><td>${assignment.start_time ? `${assignment.start_time} – ${assignment.end_time}` : 'ganztags'}</td></tr>`,
      `</table>`,
      `<p>`,
      `  <a href="${confirmUrl}" style="background:#2ecc71;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;margin-right:10px">✅ Ja, ich übernehme</a>`,
      `  <a href="${rejectUrl}"  style="background:#e74c3c;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">❌ Nein, kann nicht</a>`,
      `</p>`,
      `<p><small>Diese Links sind 48 Stunden gültig.</small></p>`,
    ].join('\n'),
  });
}

/**
 * Sent to the original labmanager confirming their substitution was found.
 */
async function sendSubstitutionConfirmed(assignment, substitute) {
  if (!assignment.original_email) return;

  await send({
    to:      assignment.original_email,
    subject: `Stellvertretung bestätigt: ${formatDate(assignment.date)}`,
    text: [
      `Hallo ${assignment.original_name},`,
      ``,
      `Dein Einsatz am ${formatDate(assignment.date)} wird von ${substitute.name} übernommen.`,
      ``,
      `Datum:         ${formatDate(assignment.date)}`,
      `Zeit:          ${assignment.start_time ? `${assignment.start_time} – ${assignment.end_time}` : 'ganztags'}`,
      `Vertretung:    ${substitute.name} (${substitute.email})`,
    ].join('\n'),
  });
}

/**
 * Sent to the labmanager when no substitute could be found automatically.
 */
async function sendSubstitutionFailed(assignment) {
  if (!assignment.original_email) return;

  await send({
    to:      assignment.original_email,
    subject: `Keine Vertretung gefunden: ${formatDate(assignment.date)}`,
    text: [
      `Hallo ${assignment.original_name},`,
      ``,
      `Für deinen Einsatz am ${formatDate(assignment.date)} konnte keine automatische Vertretung`,
      `gefunden werden. Bitte melde dich im FabLab-Team.`,
    ].join('\n'),
  });
}

// ── Admin notifications ────────────────────────────────────────────────────────

/**
 * Sent to admins when Webling sync auto-adjusts exmember_months (Modul H.2).
 */
async function sendWeblingAutoAdjust({ oldMonths, newMonths, occupation, maxMembers }) {
  const recipients = await configService.get('upgrade.notify_emails') || [];
  if (!recipients.length) return;

  await send({
    to:      recipients,
    subject: `Webling-Sync: exmember_months angepasst (${oldMonths} → ${newMonths})`,
    text: [
      `Webling Sync – automatische Anpassung`,
      ``,
      `Die konfigurierte Anzahl Ex-Mitglieder-Monate war höher als nötig.`,
      ``,
      `Auslastung:          ${occupation} / ${maxMembers}`,
      `Alte Konfiguration:  ${oldMonths} Monate`,
      `Neue Konfiguration:  ${newMonths} Monate`,
      ``,
      `Die Einstellung wurde automatisch aktualisiert.`,
    ].join('\n'),
  });
}

module.exports = {
  send,
  sendUpgradeBooked,
  sendUpgradeExpired,
  sendSubstitutionRequest,
  sendSubstitutionConfirmed,
  sendSubstitutionFailed,
  sendWeblingAutoAdjust,
};
