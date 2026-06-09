'use strict';

const jwt = require('jsonwebtoken');
const cfg  = require('../config');

/**
 * Prüft JWT im Authorization-Header.
 * Setzt req.user = { id, name, roles: [] }
 */
function sessionAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Nicht angemeldet' });
  }

  try {
    req.user = jwt.verify(token, cfg.jwt.secret);
    next();
  } catch {
    return res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
  }
}

/**
 * Prüft ob der angemeldete User eine bestimmte Rolle hat.
 * Verwendung: requireRole('admin') oder requireRole('labmanager')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet' });
    const hasRole = roles.some(r => req.user.roles.includes(r));
    if (!hasRole) return res.status(403).json({ error: 'Keine Berechtigung' });
    next();
  };
}

module.exports = { sessionAuth, requireRole };
