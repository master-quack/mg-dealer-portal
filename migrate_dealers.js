const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS dealers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    dealer_name TEXT NOT NULL
  )
`);

console.log('Dealers table ready.');
