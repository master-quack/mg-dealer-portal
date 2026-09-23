require('dotenv').config();
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const db = require('./db');
const logger = require('./logger');
const { uploadsDir } = require('./config');
const cookieParser = require('cookie-parser');
const { createSession, getSession, destroySession } = require('./sessions');
const { extractPaymentDetails } = require('./extract');

function queueOutboxMessage(dealerName, message) {
  const dealer = db.prepare('SELECT id FROM dealers WHERE dealer_name = ?').get(dealerName);
  if (!dealer) {
    logger.warn(`No matching dealer found for "${dealerName}" — skipping notification.`);
    return;
  }
  const phone = db.prepare('SELECT phone_number FROM dealer_phones WHERE dealer_id = ? LIMIT 1').get(dealer.id);
  if (!phone) {
    logger.warn(`No phone number on file for dealer "${dealerName}" — skipping notification.`);
    return;
  }
  db.prepare('INSERT INTO outbox (phone_number, message) VALUES (?, ?)').run(phone.phone_number, message);
  logger.info(`Queued outbox message to ${phone.phone_number}: ${message}`);
}

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Behind the Cloudflare tunnel: trust the proxy so secure cookies and the
// rate limiter see the real client IP from X-Forwarded-* headers.
app.set('trust proxy', 1);

// --- File upload config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.pdf'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPG, or PDF files are allowed'));
    }
  }
});

// --- Email setup ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
});

function notifyFinance(submission) {
  const reviewLine = submission.needs_review
    ? `\n⚠ NEEDS REVIEW: ${submission.review_reason || 'See dashboard for details'}\n`
    : '';

  const mailOptions = {
    from: `"Dealer Portal" <${process.env.SMTP_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject: `${submission.needs_review ? '[REVIEW NEEDED] ' : ''}New submission from ${submission.dealer_name}`,
    text:
`A new payment submission has been received.
${reviewLine}
Dealer (logged in as): ${submission.dealer_name}
PBO Reference: ${submission.pbo_reference}

--- Extracted from screenshot ---
Status: ${submission.extracted_status || 'N/A'}
Sender name on bank account: ${submission.extracted_sender_name || 'N/A'}
Amount: ${submission.extracted_amount || 'N/A'}
Transaction Type: ${submission.extracted_transaction_type || 'N/A'}
Transaction Date: ${submission.extracted_date || 'N/A'}
Paid to (account name): ${submission.extracted_to_account_name || 'N/A'}

Notes from dealer: ${submission.notes || '(none)'}

Status: Received
Submitted at: ${submission.created_at}

Log in to the dashboard to review and update the status.`
  };
  transporter.sendMail(mailOptions, (err, info) => {
    if (err) {
      logger.error({ err }, 'Email send failed');
    } else {
      logger.info({ messageId: info.messageId }, 'Notification email sent');
    }
  });
}

// --- Session auth middleware for finance dashboard ---
function financeAuth(req, res, next) {
  const token = req.cookies.session;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = session.finance_user_id
    ? db.prepare('SELECT id, name, username FROM finance_users WHERE id = ?').get(session.finance_user_id)
    : null;
  req.financeUser = user || { id: null, name: null, username: 'unknown' };
  return next();
}

// --- Basic auth middleware for dealers ---
function dealerAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Dealer Portal"');
    return res.status(401).send('Authentication required.');
  }
  const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
  const [username, password] = decoded.split(':');
  const dealer = db.prepare('SELECT * FROM dealers WHERE username = ? AND password = ?').get(username, password);
  if (dealer) {
    req.dealer = dealer; // attach dealer info to the request for later use
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Dealer Portal"');
  return res.status(401).send('Invalid credentials.');
}

app.use(pinoHttp({ logger }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', financeAuth, express.static(uploadsDir));

// --- Dealer-facing: the upload form itself (protected) ---
// Disconnected: dealer submissions now come in via WhatsApp (dealer-whatsapp project).
// Left in place in case the web form is needed again later.
// app.get('/', dealerAuth, (req, res) => {
//   res.sendFile(path.join(__dirname, 'public', 'index.html'));
// });


// Serve remaining static assets (CSS/JS if split out later) without auth on the root
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// --- Rate limiter for login: guards against brute-force attempts ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

// --- Login: validates credentials against finance_users, creates session, sets cookie ---
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = db.prepare('SELECT * FROM finance_users WHERE username = ?').get(username);
  const passwordOk = user && await bcrypt.compare(password, user.password);
  if (!user || !passwordOk) {
    logger.warn({ username }, 'Failed login attempt');
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  const { token, expiresAt } = createSession(user.id);
  res.cookie('session', token, {
    httpOnly: true,
    secure: isProd,       // requires HTTPS in production; allows http for local dev
    sameSite: 'strict',
    expires: new Date(expiresAt)
  });
  logger.info({ username: user.username, userId: user.id }, 'Finance user logged in');
  return res.json({ success: true });
});

// --- Logout: destroys session, clears cookie ---
app.post('/api/logout', (req, res) => {
  const token = req.cookies.session;
  if (token) destroySession(token);
  res.clearCookie('session');
  res.json({ success: true });
});

// Disconnected: dealer submissions now come in via WhatsApp (dealer-whatsapp project).
// Left in place in case the web form is needed again later.
/*
// --- Dealer-facing: submit a new payment ---
app.post('/api/submissions', dealerAuth, upload.single('screenshot'), async (req, res) => {
  try {
    const { pbo_reference, notes } = req.body;
    if (!pbo_reference || !req.file) {
      return res.status(400).json({ error: 'PBO reference number and screenshot are required.' });
    }

    const dealerName = req.dealer.dealer_name;
    const screenshotPath = path.join(__dirname, 'uploads', req.file.filename);

    let extracted;
    try {
      extracted = await extractPaymentDetails(screenshotPath);
    } catch (err) {
      console.error('LLM extraction failed:', err.message);
      extracted = {
        status: 'unclear',
        sender_name: null,
        amount: null,
        transaction_date: null,
        transaction_type: null,
        to_account_name: null,
        needs_review: true,
        review_reason: 'Automatic extraction failed — please review manually'
      };
    }

    const stmt = db.prepare(`
      INSERT INTO submissions (
        dealer_name, pbo_reference, payment_type, amount, notes, screenshot_filename,
        extracted_sender_name, extracted_amount, extracted_date, extracted_status,
        extracted_transaction_type, extracted_to_account_name, needs_review, review_reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      dealerName,
      pbo_reference,
      extracted.transaction_type || 'Unspecified',
      extracted.amount || null,
      notes || null,
      req.file.filename,
      extracted.sender_name || null,
      extracted.amount || null,
      extracted.transaction_date || null,
      extracted.status || null,
      extracted.transaction_type || null,
      extracted.to_account_name || null,
      extracted.needs_review ? 1 : 0,
      extracted.review_reason || null
    );

    const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(result.lastInsertRowid);
    notifyFinance(submission);
    res.json({ success: true, id: result.lastInsertRowid, extracted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

*/

// --- Finance-facing: list all dealers (for filter dropdown) ---
app.get('/api/dealers', financeAuth, (req, res) => {
  const rows = db.prepare('SELECT id, dealer_name FROM dealers ORDER BY dealer_name').all();
  res.json(rows);
});

// --- Finance-facing: list all submissions ---
app.get('/api/submissions', financeAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
  res.json(rows);
});

// --- Finance-facing: update status ---
app.patch('/api/submissions/:id/status', financeAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['Received', 'Posted in SAP', 'Rejected'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!submission) {
    return res.status(404).json({ error: 'Submission not found.' });
  }

  db.prepare(`
    UPDATE submissions SET status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, req.params.id);

  // Audit: record who changed the status and from what to what.
  db.prepare(`
    INSERT INTO audit_log (submission_id, finance_user_id, username, action, old_status, new_status)
    VALUES (?, ?, ?, 'status_change', ?, ?)
  `).run(req.params.id, req.financeUser.id, req.financeUser.username, submission.status, status);

  if (status === 'Posted in SAP' || status === 'Rejected') {
    const message = `Your PBO ${submission.pbo_reference} has been ${status}.`;
    queueOutboxMessage(submission.dealer_name, message);
  }

  res.json({ success: true });
});

// --- Finance-facing: audit history (status changes) for a submission ---
app.get('/api/submissions/:id/audit', financeAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT username, action, old_status, new_status, created_at
    FROM audit_log WHERE submission_id = ? ORDER BY created_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// --- Finance-facing: add a note to a submission (logged, notifies dealer) ---
app.post('/api/submissions/:id/note', financeAuth, (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'Note text is required.' });
  }

  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!submission) {
    return res.status(404).json({ error: 'Submission not found.' });
  }

  db.prepare(`
    INSERT INTO submission_notes (submission_id, note_text) VALUES (?, ?)
  `).run(req.params.id, note.trim());

  const message = `Note regarding your PBO ${submission.pbo_reference}: ${note.trim()}`;
  queueOutboxMessage(submission.dealer_name, message);

  res.json({ success: true });
});

// --- Finance-facing: get notes history for a submission ---
app.get('/api/submissions/:id/notes', financeAuth, (req, res) => {
  const notes = db.prepare(`
    SELECT * FROM submission_notes WHERE submission_id = ? ORDER BY created_at DESC
  `).all(req.params.id);
  res.json(notes);
});

// --- Finance-facing: export selected submissions to Excel ---
app.post('/api/submissions/export', financeAuth, (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { ids, startDate, endDate, dealers } = req.body;

    let rows;
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      rows = db.prepare(`SELECT * FROM submissions WHERE id IN (${placeholders}) ORDER BY created_at DESC`).all(...ids);
    } else if (startDate && endDate) {
      rows = db.prepare(`
        SELECT * FROM submissions
        WHERE date(created_at) BETWEEN date(?) AND date(?)
        ORDER BY created_at DESC
      `).all(startDate, endDate);
      if (dealers && dealers.length > 0) {
        rows = rows.filter(r => dealers.includes(r.dealer_name));
      }
    } else {
      return res.status(400).json({ error: 'Select entries or a date range to export.' });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No submissions match that selection.' });
    }

    const exportRows = rows.map(r => ({
      'ID': r.id,
      'Dealer': r.dealer_name,
      'PBO Reference': r.pbo_reference,
      'Status': r.status,
      'Notes': r.notes || '',
      'Extracted Status': r.extracted_status || '',
      'Extracted Sender': r.extracted_sender_name || '',
      'Extracted Amount': r.extracted_amount || '',
      'Extracted Date': r.extracted_date || '',
      'Extracted Type': r.extracted_transaction_type || '',
      'Extracted To Account': r.extracted_to_account_name || '',
      'Needs Review': r.needs_review ? 'Yes' : 'No',
      'Review Reason': r.review_reason || '',
      'Submitted At': r.created_at,
      'Last Updated': r.updated_at
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Submissions');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="submissions_export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'Export failed');
    res.status(500).json({ error: 'Export failed.' });
  }
});

// --- Finance-facing: export Home summary (dealer counts) to Excel ---
app.post('/api/summary/export', financeAuth, (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { startDate, endDate, dealers } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'A date range is required to export the summary.' });
    }

    let rows = db.prepare(`
      SELECT * FROM submissions
      WHERE date(created_at) BETWEEN date(?) AND date(?)
    `).all(startDate, endDate);

    if (dealers && dealers.length > 0) {
      rows = rows.filter(r => dealers.includes(r.dealer_name));
    }

    const allDealerRows = db.prepare('SELECT dealer_name FROM dealers ORDER BY dealer_name').all();
    const dealersToInclude = dealers && dealers.length > 0
      ? allDealerRows.filter(d => dealers.includes(d.dealer_name))
      : allDealerRows;

    let grandReceived = 0, grandPosted = 0, grandRejected = 0, grandVerified = 0;

    const summaryRows = dealersToInclude.map(d => {
      const dealerRows = rows.filter(r => r.dealer_name === d.dealer_name);
      const total = dealerRows.length;
      const posted = dealerRows.filter(r => r.status === 'Posted in SAP').length;
      const rejected = dealerRows.filter(r => r.status === 'Rejected').length;
      const verified = dealerRows.filter(r => !r.needs_review && String(r.extracted_status || '').toLowerCase() === 'success').length;

      grandReceived += total;
      grandPosted += posted;
      grandRejected += rejected;
      grandVerified += verified;

      return {
        'Dealer': d.dealer_name,
        'Received': total,
        'Posted in SAP': posted,
        'Rejected': rejected,
        'Verified': verified,
        'Total': total
      };
    });

    summaryRows.push({
      'Dealer': 'TOTAL',
      'Received': grandReceived,
      'Posted in SAP': grandPosted,
      'Rejected': grandRejected,
      'Verified': grandVerified,
      'Total': grandReceived
    });

    const worksheet = XLSX.utils.json_to_sheet(summaryRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Summary');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="dealer_summary_export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'Summary export failed');
    res.status(500).json({ error: 'Export failed.' });
  }
});

// --- Finance dashboard page (protected) ---

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'finance.html'));
});

// --- Global error handler: log details, return a generic message ---
app.use((err, req, res, next) => {
  (req.log || logger).error({ err }, 'Unhandled request error');
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const server = app.listen(PORT, () => {
  logger.info(`Dealer portal running on port ${PORT}`);
});

// --- Graceful shutdown: stop accepting connections, close the DB, then exit ---
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    try { db.close(); } catch (e) { /* already closed */ }
    logger.info('Shutdown complete.');
    process.exit(0);
  });
  // Force-exit if connections don't drain in time.
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
