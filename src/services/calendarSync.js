'use strict';

const axios         = require('axios');
const cfg           = require('../config');
const configService = require('./configService');

const SCOPES        = 'https://www.googleapis.com/auth/calendar';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

// Config-table keys for persisted tokens
const KEY = {
  accessToken:  'google.access_token',
  refreshToken: 'google.refresh_token',
  tokenExpiry:  'google.token_expiry',   // ISO datetime string
};

// ── OAuth2 ─────────────────────────────────────────────────────────────────────

/**
 * Returns the URL the admin must visit once to authorise the app.
 * After approval Google redirects to GOOGLE_REDIRECT_URI with ?code=...
 */
function getAuthUrl() {
  const params = new URLSearchParams({
    client_id:     cfg.google.clientId,
    redirect_uri:  cfg.google.redirectUri,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',          // force refresh_token even if previously granted
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchanges the one-time auth code for access + refresh tokens
 * and persists them in the config table.
 */
async function handleAuthCallback(code) {
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    code,
    client_id:     cfg.google.clientId,
    client_secret: cfg.google.clientSecret,
    redirect_uri:  cfg.google.redirectUri,
    grant_type:    'authorization_code',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  await _storeTokens(data);
}

async function _storeTokens({ access_token, refresh_token, expires_in }) {
  const expiry = new Date(Date.now() + expires_in * 1000).toISOString();
  await configService.set(KEY.accessToken,  access_token);
  await configService.set(KEY.tokenExpiry,  expiry);
  if (refresh_token) {
    // Google only sends refresh_token on first auth; don't overwrite with null
    await configService.set(KEY.refreshToken, refresh_token);
  }
}

async function _refreshAccessToken() {
  const refreshToken = await configService.get(KEY.refreshToken);
  if (!refreshToken) throw new Error('Google OAuth2: kein Refresh-Token gespeichert. /api/browser/google/auth aufrufen.');

  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     cfg.google.clientId,
    client_secret: cfg.google.clientSecret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  await _storeTokens(data);
  return data.access_token;
}

async function _getAccessToken() {
  const [token, expiry] = await Promise.all([
    configService.get(KEY.accessToken),
    configService.get(KEY.tokenExpiry),
  ]);

  // Refresh if expired or expiring within 60 seconds
  if (!token || !expiry || new Date(expiry).getTime() - Date.now() < 60_000) {
    return _refreshAccessToken();
  }

  return token;
}

// ── Calendar API client ────────────────────────────────────────────────────────

async function _client() {
  const token = await _getAccessToken();
  return axios.create({
    baseURL: `${CALENDAR_BASE}/calendars/${encodeURIComponent(cfg.google.calendarId)}`,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10_000,
  });
}

// ── Event helpers ──────────────────────────────────────────────────────────────

function _buildEvent(assignment) {
  // assignment: { date, start_time, end_time, name }
  // date = 'YYYY-MM-DD', start_time / end_time = 'HH:MM:SS' or null
  const dateStr = typeof assignment.date === 'string'
    ? assignment.date.slice(0, 10)
    : new Date(assignment.date).toISOString().slice(0, 10);

  // If no times are set, create an all-day event
  if (!assignment.start_time || !assignment.end_time) {
    return {
      summary: `Labmanager: ${assignment.name}`,
      start:   { date: dateStr },
      end:     { date: dateStr },
    };
  }

  const start = `${dateStr}T${String(assignment.start_time).slice(0, 8)}`;
  const end   = `${dateStr}T${String(assignment.end_time).slice(0, 8)}`;

  return {
    summary: `Labmanager: ${assignment.name}`,
    start:   { dateTime: start, timeZone: 'Europe/Zurich' },
    end:     { dateTime: end,   timeZone: 'Europe/Zurich' },
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Creates a Google Calendar event for an assignment.
 * Returns the gcal_event_id to store in the assignments table.
 */
async function createAssignmentEvent(assignment) {
  const cal = await _client();
  const { data } = await cal.post('/events', _buildEvent(assignment));
  return data.id;
}

/**
 * Updates an existing calendar event (e.g. substitution or time change).
 */
async function updateAssignmentEvent(gcalEventId, assignment) {
  const cal = await _client();
  await cal.put(`/events/${gcalEventId}`, _buildEvent(assignment));
}

/**
 * Deletes a calendar event (cancelled assignment).
 */
async function deleteAssignmentEvent(gcalEventId) {
  const cal = await _client();
  await cal.delete(`/events/${gcalEventId}`);
}

/**
 * Lists events in a time range (used by display to show courses/maintenance).
 * Returns raw Google Calendar event objects.
 */
async function listEvents(timeMin, timeMax) {
  const cal = await _client();
  const { data } = await cal.get('/events', {
    params: {
      timeMin:    timeMin instanceof Date ? timeMin.toISOString() : timeMin,
      timeMax:    timeMax instanceof Date ? timeMax.toISOString() : timeMax,
      singleEvents: true,
      orderBy:    'startTime',
    },
  });
  return data.items || [];
}

/**
 * Returns true if OAuth2 tokens are stored and not obviously invalid.
 */
async function isAuthorised() {
  const token = await configService.get(KEY.accessToken);
  const refresh = await configService.get(KEY.refreshToken);
  return !!(token || refresh);
}

module.exports = {
  getAuthUrl,
  handleAuthCallback,
  isAuthorised,
  createAssignmentEvent,
  updateAssignmentEvent,
  deleteAssignmentEvent,
  listEvents,
};
