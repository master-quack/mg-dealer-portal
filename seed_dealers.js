const db = require('./db');

const dealers = [
  { username: 'mg_lounge', password: 'lounge123', dealer_name: 'MG Lounge' },
  { username: 'mg_capital', password: 'capital123', dealer_name: 'MG Capital' }
];

const stmt = db.prepare(`
  INSERT OR IGNORE INTO dealers (username, password, dealer_name)
  VALUES (?, ?, ?)
`);

for (const d of dealers) {
  const result = stmt.run(d.username, d.password, d.dealer_name);
  if (result.changes > 0) {
    console.log('Added:', d.username, '->', d.dealer_name);
  } else {
    console.log('Already exists:', d.username);
  }
}
