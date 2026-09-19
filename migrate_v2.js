const db = require('./db');

console.log('Starting migration v2: dealers cleanup + phones + outbox...');

// --- Step 1: Rebuild dealers table with sap_code, drop username/password ---
db.exec(`
  CREATE TABLE IF NOT EXISTS dealers_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealer_name TEXT NOT NULL UNIQUE,
    sap_code TEXT UNIQUE
  )
`);

db.exec('DROP TABLE IF EXISTS dealers');
db.exec('ALTER TABLE dealers_new RENAME TO dealers');
console.log('dealers table rebuilt with sap_code column.');

// --- Step 2: Insert the 24 dealers from the spreadsheet ---
const dealerList = [
  ['MG Center', '12000000'],
  ['MG Capital', '12000001'],
  ['MG City', '12000002'],
  ['MG Lounge', '12000003'],
  ['MG Lyallpur', '12000004'],
  ['MG Khyber', '12000005'],
  ['MG Sialkot', '12000006'],
  ['Al Futaim Motors', '12000007'],
  ['MG Multan', '12000008'],
  ['MG Gujrat', '12000009'],
  ['MG Sargodha', '12000010'],
  ['MG Queens', '12000020'],
  ['MG Rawalpindi', '12000021'],
  ['MG-Riverside', '12000022'],
  ['MG Sukkar', '12000030'],
  ['MG Heritage', '12000031'],
  ['MG Prestige Pvt Ltd', '12000032'],
  ['MG Legacy', '12000040'],
  ['MG Oriental', '12000041'],
  ['MG Jhelum', '12000042'],
  ['MG Avenue', '12000043'],
  ['MG Gujranwala', '12000044'],
  ['MG South', '12000045'],
  ['MG Crown', '12000046'],
];

const insertDealer = db.prepare('INSERT INTO dealers (dealer_name, sap_code) VALUES (?, ?)');
for (const [name, code] of dealerList) {
  insertDealer.run(name, code);
  console.log(`Inserted: ${name} (${code})`);
}

// --- Step 3: dealer_phones table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS dealer_phones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealer_id INTEGER NOT NULL,
    phone_number TEXT NOT NULL UNIQUE,
    FOREIGN KEY (dealer_id) REFERENCES dealers(id)
  )
`);
console.log('dealer_phones table ready.');

// --- Step 4: outbox table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT NOT NULL,
    message TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
console.log('outbox table ready.');

console.log('Migration v2 complete.');
