const path = require('path');
const fs = require('fs');

// Where the SQLite DB, uploads, and backups live.
// In production this is set to /data (outside the repo) via the systemd unit / .env.
// Falls back to the repo root so local development works with no extra setup.
const DATA_DIR = process.env.DATA_DIR || __dirname;

const dbPath = path.join(DATA_DIR, 'dealer-portal.db');
const uploadsDir = path.join(DATA_DIR, 'uploads');
const backupsDir = path.join(DATA_DIR, 'backups');

// Make sure the directories exist before anything tries to use them.
for (const dir of [DATA_DIR, uploadsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { DATA_DIR, dbPath, uploadsDir, backupsDir };
