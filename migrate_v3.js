const db = require('./db');

console.log('Starting migration v3: submission_notes table...');

db.exec(`
  CREATE TABLE IF NOT EXISTS submission_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    note_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (submission_id) REFERENCES submissions(id)
  )
`);
console.log('submission_notes table ready.');

console.log('Migration v3 complete.');
