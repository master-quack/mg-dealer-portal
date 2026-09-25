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
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 0);

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
  if (!user) {
    destroySession(token);
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.financeUser = user;
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

app.use(pinoHttp({
  logger,
  autoLogging: { ignore: (req) => req.url === "/api/submissions" && req.method === "GET" },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode })
  }
}));
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
    secure: process.env.COOKIE_SECURE !== 'false', // HTTPS only unless COOKIE_SECURE=false
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

// Duplicate guard: the bank transaction id (IBFT/reference number) plus the PBO reference
// together identify one real payment. If an earlier, non-Rejected submission already has the
// same pair, this new one is a duplicate. Empty/null ids never block (many rows have no id yet).
// Returns the blocking submission row, or null.
function findBlockingDuplicate(bankTransactionId, pboReference) {
  const id = (bankTransactionId || '').trim();
  const pbo = (pboReference || '').trim();
  if (!id || !pbo) return null;
  return db.prepare(`
    SELECT id, dealer_name, status FROM submissions
    WHERE bank_transaction_id = ? AND pbo_reference = ? AND status != 'Rejected'
    ORDER BY id ASC LIMIT 1
  `).get(id, pbo) || null;
}

// created_at is stored in UTC (datetime('now')). The finance team works in UTC+5, so aging is
// measured from the local (UTC+5) calendar date of when WhatsApp received the slip.
function localDateUtc5(utcDateTimeStr) {
  if (!utcDateTimeStr) return null;
  const d = new Date(String(utcDateTimeStr).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCHours(d.getUTCHours() + 5);
  return d.toISOString().slice(0, 10);
}

// Whole days between the deposit date and the local received date. null if no valid deposit_date.
function agingDays(createdAt, depositDate) {
  if (!depositDate || !/^\d{4}-\d{2}-\d{2}$/.test(depositDate)) return null;
  const local = localDateUtc5(createdAt);
  if (!local) return null;
  const a = new Date(local + 'T00:00:00Z');
  const b = new Date(depositDate + 'T00:00:00Z');
  return Math.round((a - b) / 86400000);
}

// --- Finance-facing: manually create a submission from the dashboard ---
// Mirrors the WhatsApp intake (dealer-whatsapp/index.js): extraction is best-effort
// and never blocks the save. The dealer is decided server-side.
app.post('/api/admin/submissions', financeAuth, upload.single('screenshot'), async (req, res) => {
  try {
    const { pbo_reference, dealer_name, post_as_mg, amount, payment_type, notes, bank_transaction_id, deposit_date } = req.body;

    if (!pbo_reference || !pbo_reference.trim()) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'PBO reference is required.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'An attachment is required.' });
    }

    // Decide the dealer name server-side. "Post as MG Finance" uses a fixed label
    // that is deliberately NOT a row in the dealers table; otherwise the dealer_name
    // must exactly match a registered dealer.
    const postAsMg = post_as_mg === 'true' || post_as_mg === true || post_as_mg === 'on' || post_as_mg === '1';
    let dealerName;
    if (postAsMg) {
      dealerName = 'MG Finance';
    } else {
      const dealer = db.prepare('SELECT dealer_name FROM dealers WHERE dealer_name = ?').get((dealer_name || '').trim());
      if (!dealer) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Unknown dealer — select a registered dealer or post as MG Finance.' });
      }
      dealerName = dealer.dealer_name;
    }

    // Best-effort extraction: any failure (including a missing API key) falls back
    // to needs_review and carries on, exactly like the WhatsApp intake.
    const screenshotPath = path.join(uploadsDir, req.file.filename);
    let extracted;
    try {
      extracted = await extractPaymentDetails(screenshotPath);
    } catch (err) {
      logger.error({ err: err.message }, 'Manual submission extraction failed');
      extracted = {
        status: 'unclear', sender_name: null, amount: null, transaction_date: null,
        transaction_type: null, to_account_name: null, needs_review: true,
        review_reason: 'Automatic extraction failed, please review manually'
      };
    }

    // Operator-provided amount / payment type override the extracted values.
    let finalAmount = extracted.amount || null;
    if (amount !== undefined && amount !== null && String(amount).trim() !== '') {
      const n = Number(amount);
      if (!Number.isNaN(n)) finalAmount = n;
    }
    const finalPaymentType = (payment_type && payment_type.trim())
      ? payment_type.trim()
      : (extracted.transaction_type || 'Unspecified');

    // Operator-typed bank transaction id / deposit date override the extracted values.
    const finalBankTransactionId = (bank_transaction_id && bank_transaction_id.trim())
      ? bank_transaction_id.trim()
      : (extracted.bank_transaction_id || null);
    // Only accept a deposit_date that looks like YYYY-MM-DD; otherwise store null.
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    let finalDepositDate = null;
    if (deposit_date && isoDate.test(deposit_date.trim())) {
      finalDepositDate = deposit_date.trim();
    } else if (extracted.deposit_date && isoDate.test(String(extracted.deposit_date).trim())) {
      finalDepositDate = String(extracted.deposit_date).trim();
    }

    // Block duplicates once the final bank transaction id is known (same id + same PBO,
    // not already Rejected). Delete the just-uploaded file so it doesn't orphan, then 409.
    const blocker = findBlockingDuplicate(finalBankTransactionId, pbo_reference);
    if (blocker) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(409).json({
        error: `Duplicate: bank transaction ID ${finalBankTransactionId} with PBO ${pbo_reference.trim()} was already submitted as #${blocker.id} (${blocker.dealer_name}, ${blocker.status}).`
      });
    }

    // Same columns as the WhatsApp intake; status defaults to 'Received'.
    const result = db.prepare(`
      INSERT INTO submissions (
        dealer_name, pbo_reference, payment_type, amount, notes, screenshot_filename,
        extracted_sender_name, extracted_amount, extracted_date, extracted_status,
        extracted_transaction_type, extracted_to_account_name, needs_review, review_reason,
        bank_transaction_id, deposit_date
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dealerName, pbo_reference.trim(), finalPaymentType, finalAmount, (notes && notes.trim()) || null, req.file.filename,
      extracted.sender_name || null, extracted.amount || null, extracted.transaction_date || null,
      extracted.status || null, extracted.transaction_type || null, extracted.to_account_name || null,
      extracted.needs_review ? 1 : 0, extracted.review_reason || null,
      finalBankTransactionId, finalDepositDate
    );

    // Audit: record the manual entry against the finance user who created it. No email.
    db.prepare(`
      INSERT INTO audit_log (submission_id, finance_user_id, username, action, old_status, new_status)
      VALUES (?, ?, ?, 'Manual entry', NULL, ?)
    `).run(result.lastInsertRowid, req.financeUser.id, req.financeUser.username, 'Received');

    logger.info({ id: result.lastInsertRowid, dealer_name: dealerName, by: req.financeUser.username }, 'Manual submission created');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    logger.error({ err }, 'Manual submission failed');
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ============================================================
// Admin: dealers, phone numbers, and finance users
// ============================================================

// --- List dealers with their phone numbers ---
app.get('/api/admin/dealers', financeAuth, (req, res) => {
  const dealers = db.prepare('SELECT id, dealer_name, sap_code FROM dealers ORDER BY dealer_name').all();
  const phoneStmt = db.prepare('SELECT phone_number FROM dealer_phones WHERE dealer_id = ? ORDER BY id');
  for (const d of dealers) {
    d.phones = phoneStmt.all(d.id).map(p => p.phone_number);
  }
  res.json(dealers);
});

// --- Add a dealer (with optional phone numbers) ---
app.post('/api/admin/dealers', financeAuth, (req, res) => {
  const dealer_name = (req.body.dealer_name || '').trim();
  const sap_code = (req.body.sap_code || '').trim();
  const phones = Array.isArray(req.body.phones) ? req.body.phones : [];
  if (!dealer_name || !sap_code) {
    return res.status(400).json({ error: 'Dealer name and SAP code are required.' });
  }

  const exists = db.prepare('SELECT id FROM dealers WHERE dealer_name = ? OR sap_code = ?').get(dealer_name, sap_code);
  if (exists) {
    return res.status(409).json({ error: 'A dealer with that name or SAP code already exists.' });
  }

  const create = db.transaction(() => {
    const result = db.prepare('INSERT INTO dealers (dealer_name, sap_code) VALUES (?, ?)').run(dealer_name, sap_code);
    const dealerId = result.lastInsertRowid;
    const addPhone = db.prepare('INSERT INTO dealer_phones (dealer_id, phone_number) VALUES (?, ?)');
    for (const p of phones) {
      const num = String(p).trim();
      if (num) addPhone.run(dealerId, num);
    }
    return dealerId;
  });
  const id = create();
  logger.info({ dealer_name, by: req.financeUser.username }, 'Dealer added');
  res.json({ success: true, id });
});

// --- Remove a dealer (and its phone numbers) ---
app.delete('/api/admin/dealers/:id', financeAuth, (req, res) => {
  const dealer = db.prepare('SELECT * FROM dealers WHERE id = ?').get(req.params.id);
  if (!dealer) return res.status(404).json({ error: 'Dealer not found.' });
  // MG Finance (SAP 12000099) is a protected system dealer used by the "Post as MG Finance"
  // path; it must never be deleted.
  if (dealer.sap_code === '12000099' || dealer.dealer_name === 'MG Finance') {
    return res.status(400).json({ error: 'MG Finance is a protected dealer and cannot be deleted.' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM dealer_phones WHERE dealer_id = ?').run(dealer.id);
    db.prepare('DELETE FROM dealers WHERE id = ?').run(dealer.id);
  })();
  logger.info({ dealer_name: dealer.dealer_name, by: req.financeUser.username }, 'Dealer removed');
  res.json({ success: true });
});

// --- Add a phone number to a dealer ---
app.post('/api/admin/dealers/:id/phones', financeAuth, (req, res) => {
  const phone_number = (req.body.phone_number || '').trim();
  if (!phone_number) return res.status(400).json({ error: 'Phone number is required.' });
  const dealer = db.prepare('SELECT id FROM dealers WHERE id = ?').get(req.params.id);
  if (!dealer) return res.status(404).json({ error: 'Dealer not found.' });
  const dup = db.prepare('SELECT id FROM dealer_phones WHERE dealer_id = ? AND phone_number = ?').get(dealer.id, phone_number);
  if (dup) return res.status(409).json({ error: 'This number is already on file.' });
  db.prepare('INSERT INTO dealer_phones (dealer_id, phone_number) VALUES (?, ?)').run(dealer.id, phone_number);
  res.json({ success: true });
});

// --- Remove a phone number from a dealer ---
app.delete('/api/admin/dealers/:id/phones', financeAuth, (req, res) => {
  const phone_number = (req.body.phone_number || '').trim();
  if (!phone_number) return res.status(400).json({ error: 'Phone number is required.' });
  db.prepare('DELETE FROM dealer_phones WHERE dealer_id = ? AND phone_number = ?').run(req.params.id, phone_number);
  res.json({ success: true });
});

// --- List finance users (never returns password hashes) ---
app.get('/api/admin/users', financeAuth, (req, res) => {
  const rows = db.prepare('SELECT id, name, username, email, phone FROM finance_users ORDER BY name').all();
  res.json(rows);
});

// --- Add a finance user (bcrypt-hashed password) ---
app.post('/api/admin/users', financeAuth, async (req, res) => {
  const name = (req.body.name || '').trim();
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const email = (req.body.email || '').trim();
  const phone = (req.body.phone || '').trim();
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Name, username, and password are required.' });
  }
  const exists = db.prepare('SELECT id FROM finance_users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(`
    INSERT INTO finance_users (name, username, password, email, phone) VALUES (?, ?, ?, ?, ?)
  `).run(name, username, hash, email || null, phone || null);
  logger.info({ username, by: req.financeUser.username }, 'Finance user added');
  res.json({ success: true, id: result.lastInsertRowid });
});

// --- Remove a finance user (never remove the last one) ---
app.delete('/api/admin/users/:id', financeAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM finance_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const count = db.prepare('SELECT COUNT(*) c FROM finance_users').get().c;
  if (count <= 1) {
    return res.status(400).json({ error: 'Cannot remove the last finance user — at least one must remain.' });
  }
  db.prepare('DELETE FROM sessions WHERE finance_user_id = ?').run(user.id);
  db.prepare('DELETE FROM finance_users WHERE id = ?').run(user.id);
  logger.info({ username: user.username, by: req.financeUser.username }, 'Finance user removed');
  res.json({ success: true });
});

// --- Reset a finance user's password ---
app.post('/api/admin/users/:id/password', financeAuth, async (req, res) => {
  const password = req.body.password || '';
  if (!password || password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  }
  const user = db.prepare('SELECT id, username FROM finance_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE finance_users SET password = ? WHERE id = ?').run(hash, user.id);
  db.prepare('DELETE FROM sessions WHERE finance_user_id = ?').run(user.id);
  logger.info({ username: user.username, by: req.financeUser.username }, 'Finance user password reset');
  res.json({ success: true });
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
      'Bank Transaction ID': r.bank_transaction_id || '',
      'Deposit Date': r.deposit_date || '',
      'Aging (days)': agingDays(r.created_at, r.deposit_date) ?? '',
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

    const registeredNames = db.prepare('SELECT dealer_name FROM dealers ORDER BY dealer_name').all().map(d => d.dealer_name);
    // Include any dealer_name that only exists in submissions (e.g. 'MG Finance',
    // which is deliberately not a row in the dealers table).
    const extraNames = [...new Set(rows.map(r => r.dealer_name))].filter(n => !registeredNames.includes(n)).sort();
    let dealerNames = [...registeredNames, ...extraNames];
    if (dealers && dealers.length > 0) {
      dealerNames = dealerNames.filter(n => dealers.includes(n));
    }

    let grandReceived = 0, grandPosted = 0, grandRejected = 0, grandVerified = 0;
    let grandReceivedAmt = 0, grandPostedAmt = 0, grandRejectedAmt = 0, grandVerifiedAmt = 0;

    // Sum the amount column, skipping values that aren't numeric.
    const sumAmount = arr => arr.reduce((s, r) => {
      const n = Number(r.amount);
      return Number.isFinite(n) ? s + n : s;
    }, 0);

    const summaryRows = dealerNames.map(name => {
      const dealerRows = rows.filter(r => r.dealer_name === name);
      const postedRows = dealerRows.filter(r => r.status === 'Posted in SAP');
      const rejectedRows = dealerRows.filter(r => r.status === 'Rejected');
      const verifiedRows = dealerRows.filter(r => !r.needs_review && String(r.extracted_status || '').toLowerCase() === 'success');
      const total = dealerRows.length;
      const posted = postedRows.length;
      const rejected = rejectedRows.length;
      const verified = verifiedRows.length;
      const receivedAmt = sumAmount(dealerRows);
      const postedAmt = sumAmount(postedRows);
      const rejectedAmt = sumAmount(rejectedRows);
      const verifiedAmt = sumAmount(verifiedRows);

      grandReceived += total;
      grandPosted += posted;
      grandRejected += rejected;
      grandVerified += verified;
      grandReceivedAmt += receivedAmt;
      grandPostedAmt += postedAmt;
      grandRejectedAmt += rejectedAmt;
      grandVerifiedAmt += verifiedAmt;

      return {
        'Dealer': name,
        'Received': total,
        'Received Amount (PKR)': receivedAmt,
        'Posted in SAP': posted,
        'Posted Amount (PKR)': postedAmt,
        'Rejected': rejected,
        'Rejected Amount (PKR)': rejectedAmt,
        'Verified': verified,
        'Verified Amount (PKR)': verifiedAmt,
        'Total': total,
        'Total Amount (PKR)': receivedAmt
      };
    });

    summaryRows.push({
      'Dealer': 'TOTAL',
      'Received': grandReceived,
      'Received Amount (PKR)': grandReceivedAmt,
      'Posted in SAP': grandPosted,
      'Posted Amount (PKR)': grandPostedAmt,
      'Rejected': grandRejected,
      'Rejected Amount (PKR)': grandRejectedAmt,
      'Verified': grandVerified,
      'Verified Amount (PKR)': grandVerifiedAmt,
      'Total': grandReceived,
      'Total Amount (PKR)': grandReceivedAmt
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
