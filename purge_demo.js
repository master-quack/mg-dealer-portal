require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { uploadsDir } = require('./config');

// One-shot cleanup for handover: wipes all transactional data so the client
// starts fresh, while PRESERVING dealers, dealer phone numbers, and finance
// user accounts. Safe to run more than once.
//
// Usage: node purge_demo.js            (dry run — reports what would be deleted)
//        node purge_demo.js --confirm  (actually deletes)

const confirm = process.argv.includes('--confirm');

const KEEP = ['dealers', 'dealer_phones', 'finance_users'];
// Delete child tables (which reference submissions) before submissions itself
// so foreign-key constraints are satisfied.
const CLEAR = ['submission_notes', 'audit_log', 'outbox', 'sessions', 'submissions'];

function count(table) {
  try {
    return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  } catch {
    return '(table missing)';
  }
}

console.log('--- Current row counts ---');
for (const t of [...CLEAR, ...KEEP]) {
  console.log(`  ${t.padEnd(18)} ${count(t)}`);
}

if (!confirm) {
  console.log('\nDry run. Re-run with --confirm to delete the CLEAR tables above.');
  console.log(`Will DELETE: ${CLEAR.join(', ')}`);
  console.log(`Will KEEP:   ${KEEP.join(', ')}`);
  process.exit(0);
}

const purge = db.transaction(() => {
  for (const t of CLEAR) {
    db.prepare(`DELETE FROM ${t}`).run();
    // Reset AUTOINCREMENT counters so ids start from 1 again.
    db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(t);
  }
});
purge();

// Remove the demo placeholder screenshot(s) from uploads, if present.
let filesRemoved = 0;
if (fs.existsSync(uploadsDir)) {
  for (const f of fs.readdirSync(uploadsDir)) {
    if (f === 'demo-placeholder.jpg') {
      fs.unlinkSync(path.join(uploadsDir, f));
      filesRemoved++;
    }
  }
}

console.log('\n--- After purge ---');
for (const t of [...CLEAR, ...KEEP]) {
  console.log(`  ${t.padEnd(18)} ${count(t)}`);
}
console.log(`Demo upload files removed: ${filesRemoved}`);
console.log('Purge complete. Dealers, phones, and finance users preserved.');
