require('dotenv').config();
const db = require('./db');
const bcrypt = require('bcrypt');

console.log('Starting migration v5: audit log, session user link, password hashing...');

// --- 1. Link sessions to the finance user who created them (for the audit log) ---
const sessionCols = db.prepare("PRAGMA table_info(sessions)").all();
if (!sessionCols.some(c => c.name === 'finance_user_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN finance_user_id INTEGER');
  console.log('Added sessions.finance_user_id column.');
} else {
  console.log('sessions.finance_user_id already exists — skipping.');
}

// --- 2. Audit log of status changes: who changed what, when ---
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    finance_user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
console.log('audit_log table ready.');

// --- 3. Hash any plaintext finance_users passwords (idempotent) ---
// bcrypt hashes start with "$2"; anything else is treated as plaintext and rehashed.
const users = db.prepare('SELECT id, username, password FROM finance_users').all();
const rehash = db.prepare('UPDATE finance_users SET password = ? WHERE id = ?');
let rehashed = 0;
for (const u of users) {
  if (!u.password || !u.password.startsWith('$2')) {
    rehash.run(bcrypt.hashSync(u.password || '', 12), u.id);
    rehashed++;
    console.log(`Hashed password for user "${u.username}".`);
  }
}
console.log(`Rehashed ${rehashed} plaintext password(s); ${users.length - rehashed} already hashed.`);

console.log('Migration v5 complete.');
