const crypto = require('crypto');
const db = require('./db');

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt);
  return { token, expiresAt };
}

function validateSession(token) {
  if (!token) return false;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return false;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = { createSession, validateSession, destroySession };
