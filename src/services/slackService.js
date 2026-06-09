'use strict';

const axios = require('axios');
const cfg   = require('../config');

// ── Core send ──────────────────────────────────────────────────────────────────

async function send(text) {
  if (!cfg.slack.webhookUrl) {
    console.warn('[slackService] SLACK_WEBHOOK_URL nicht konfiguriert – Nachricht nicht gesendet:', text);
    return;
  }
  await axios.post(cfg.slack.webhookUrl, { text });
}

// ── Notifications (Modul A.4) ──────────────────────────────────────────────────

function formatDate(d) {
  return new Date(d).toLocaleDateString('de-CH', { weekday: 'long', day: 'numeric', month: 'long' });
}

async function notifySubstitution(original, substitute, date) {
  await send(`Stellvertretung: *${substitute}* übernimmt von *${original}* am ${formatDate(date)}`);
}

async function notifySubstitutionNeeded(original, date) {
  await send(`⚠️ Vertretung gesucht: *${original}* braucht Vertretung am ${formatDate(date)}`);
}

async function notifyUpgradeBooked(memberName, upgradeType, expiryDate) {
  await send(`🔼 Upgrade gebucht: *${memberName}* → ${upgradeType} (bis ${formatDate(expiryDate)})`);
}

async function notifyUpgradeExpired(memberName, upgradeType) {
  await send(`🔽 Upgrade abgelaufen: *${memberName}* (${upgradeType}) – Zugang prüfen!`);
}

module.exports = {
  send,
  notifySubstitution,
  notifySubstitutionNeeded,
  notifyUpgradeBooked,
  notifyUpgradeExpired,
};
