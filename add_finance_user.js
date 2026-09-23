require('dotenv').config();
const db = require('./db');
const bcrypt = require('bcrypt');

// Usage: node add_finance_user.js <name> <username> <password> [email] [phone]
const [, , name, username, password, email, phone] = process.argv;

if (!name || !username || !password) {
  console.error('Usage: node add_finance_user.js <name> <username> <password> [email] [phone]');
  console.error('  (wrap arguments containing spaces in quotes)');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM finance_users WHERE username = ?').get(username);
if (existing) {
  console.error(`A finance user with username "${username}" already exists (id ${existing.id}).`);
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
const result = db.prepare(`
  INSERT INTO finance_users (name, username, password, email, phone)
  VALUES (?, ?, ?, ?, ?)
`).run(name, username, hash, email || null, phone || null);

console.log(`Created finance user "${username}" (id ${result.lastInsertRowid}).`);
