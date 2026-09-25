require('dotenv').config();
const db = require('./db');

console.log('Starting migration v6: bank transaction id, deposit date, MG Finance dealer...');

// --- 1. New submissions columns for the finance team ---
// bank_transaction_id: the transaction/reference (IBFT) number printed on the slip.
// deposit_date: the transaction date as YYYY-MM-DD (separate from extracted_date, the raw slip date).
// Guarded with PRAGMA table_info so this file is safe to run more than once.
const submissionCols = db.prepare("PRAGMA table_info(submissions)").all();

if (!submissionCols.some(c => c.name === 'bank_transaction_id')) {
  db.exec('ALTER TABLE submissions ADD COLUMN bank_transaction_id TEXT');
  console.log('Added submissions.bank_transaction_id column.');
} else {
  console.log('submissions.bank_transaction_id already exists — skipping.');
}

if (!submissionCols.some(c => c.name === 'deposit_date')) {
  db.exec('ALTER TABLE submissions ADD COLUMN deposit_date TEXT');
  console.log('Added submissions.deposit_date column.');
} else {
  console.log('submissions.deposit_date already exists — skipping.');
}

// --- 2. MG Finance becomes a real dealers row (SAP code 12000099) ---
// INSERT OR IGNORE keeps this idempotent: the dealer_name/sap_code UNIQUE constraints
// mean a second run is a no-op. The admin dealer-delete route refuses to remove it.
const result = db.prepare(
  "INSERT OR IGNORE INTO dealers (dealer_name, sap_code) VALUES ('MG Finance', '12000099')"
).run();
if (result.changes > 0) {
  console.log("Inserted 'MG Finance' dealer (SAP 12000099).");
} else {
  console.log("'MG Finance' dealer already exists — skipping.");
}

// Note: existing submissions already carry dealer_name = 'MG Finance' (the old hard-coded
// label), which matches the new row's name exactly, so no back-fill/rename is needed.

console.log('Migration v6 complete.');
