const crypto = require('crypto');
const db = require('./db');

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSession(financeUserId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, finance_user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, financeUserId ?? null, expiresAt);
  return { token, expiresAt };
}

// Returns the session row (incl. finance_user_id) if valid, otherwise null.
// Expired sessions are deleted as a side effect.
function getSession(token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return session;
}

function validateSession(token) {
  return getSession(token) !== null;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = { createSession, getSession, validateSession, destroySession };
