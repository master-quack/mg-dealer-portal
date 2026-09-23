# MG Dealer Payment Portal

Express + better-sqlite3 app for the MG finance team to review dealer payment
submissions. Served to the internet via a Cloudflare named tunnel.

## Runtime

- **Port:** `3050` (see `.env`)
- **Process:** managed by systemd — `dealer-portal.service` (`Restart=always`).
- **Tunnel:** `dealer-portal-tunnel.service`.
- **Data:** the SQLite DB and uploaded screenshots live under **`/data`** (set via
  `DATA_DIR`), outside the repo. Local dev falls back to the repo root when
  `DATA_DIR` is unset.

```
sudo systemctl status dealer-portal
sudo systemctl restart dealer-portal
journalctl -u dealer-portal -f        # structured JSON logs (pino)
```

## Data layout (`/data`)

```
/data/dealer-portal.db     SQLite database
/data/uploads/             payment screenshots
/data/backups/             nightly backups (14-day retention)
```

## Backups

Nightly at 02:00 via `dealer-portal-backup.timer` → `backup.js`:
- SQLite-safe online backup of the DB (`db-<timestamp>.sqlite`)
- tarball of uploads (`uploads-<timestamp>.tgz`)
- prunes anything in `/data/backups` older than 14 days.

Run one on demand: `sudo systemctl start dealer-portal-backup.service`
Check schedule: `systemctl list-timers dealer-portal-backup.timer`

## Finance users

Login is validated against the `finance_users` table with **bcrypt-hashed**
passwords; `/api/login` is rate-limited (10 attempts / 15 min per IP).

Add a user:
```
node add_finance_user.js "Full Name" username 'password' [email] [phone]
```

Status changes are recorded in the `audit_log` table (who, old→new status, when)
and shown in the per-submission Audit Trail in the dashboard.

## Migrations

Schema changes are applied by numbered scripts, run once in order:
```
node migrate.js && node migrate_v2.js && node migrate_v3.js \
  && node migrate_v4.js && node migrate_v5.js
```
All are idempotent / safe to re-run.

## Dev-only scripts — DO NOT run in production

- `seed_demo.js` — inserts ~50 fake submissions dated today.
- `seed_dealers.js` — inserts test dealers with basic-auth creds (deprecated).

These are git-ignored. For handover, `purge_demo.js` clears all transactional
data (submissions, notes, audit log, outbox, sessions) while **keeping** dealers,
dealer phone numbers, and finance users:
```
node purge_demo.js            # dry run — shows what would be deleted
node purge_demo.js --confirm  # actually delete
```
