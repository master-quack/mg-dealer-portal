require('dotenv').config();
const db = require('./db');
const crypto = require('crypto');

console.log('Starting migration v4: finance_users table...');

db.exec(`
  CREATE TABLE IF NOT EXISTS finance_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
console.log('finance_users table ready.');

// Migrate the existing .env-based credentials as the first user, if not already present
const existing = db.prepare('SELECT * FROM finance_users WHERE username = ?').get(process.env.FINANCE_USER);
if (!existing && process.env.FINANCE_USER && process.env.FINANCE_PASSWORD) {
  db.prepare(`
    INSERT INTO finance_users (name, username, password) VALUES (?, ?, ?)
  `).run('Finance Admin', process.env.FINANCE_USER, process.env.FINANCE_PASSWORD);
  console.log(`Migrated existing .env user "${process.env.FINANCE_USER}" into finance_users.`);
} else {
  console.log('User already exists or .env credentials not found — skipping seed.');
}

console.log('Migration v4 complete.');
