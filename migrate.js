const db = require('./db');

const columns = [
  "ALTER TABLE submissions ADD COLUMN extracted_sender_name TEXT",
  "ALTER TABLE submissions ADD COLUMN extracted_amount TEXT",
  "ALTER TABLE submissions ADD COLUMN extracted_date TEXT",
  "ALTER TABLE submissions ADD COLUMN extracted_status TEXT",
  "ALTER TABLE submissions ADD COLUMN extracted_transaction_type TEXT",
  "ALTER TABLE submissions ADD COLUMN extracted_to_account_name TEXT",
  "ALTER TABLE submissions ADD COLUMN needs_review INTEGER DEFAULT 0",
  "ALTER TABLE submissions ADD COLUMN review_reason TEXT"
];

for (const sql of columns) {
  try {
    db.exec(sql);
    console.log('OK:', sql);
  } catch (err) {
    if (err.message.includes('duplicate column name')) {
      console.log('SKIP (already exists):', sql);
    } else {
      console.error('FAILED:', sql, err.message);
    }
  }
}

console.log('Migration complete.');
