require('dotenv').config();
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { extractPaymentDetails } = require('./extract');

const app = express();
const PORT = process.env.PORT || 3000;

// --- File upload config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
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
      console.error('Email send failed:', err.message);
    } else {
      console.log('Notification email sent:', info.messageId);
    }
  });
}

// --- Basic auth middleware for finance dashboard ---
function financeAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Finance Dashboard"');
    return res.status(401).send('Authentication required.');
  }
  const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (user === process.env.FINANCE_USER && pass === process.env.FINANCE_PASSWORD) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Finance Dashboard"');
  return res.status(401).send('Invalid credentials.');
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', financeAuth, express.static(path.join(__dirname, 'uploads')));

// --- Dealer-facing: the upload form itself (protected) ---
// Disconnected: dealer submissions now come in via WhatsApp (dealer-whatsapp project).
// Left in place in case the web form is needed again later.
// app.get('/', dealerAuth, (req, res) => {
//   res.sendFile(path.join(__dirname, 'public', 'index.html'));
// });


// Serve remaining static assets (CSS/JS if split out later) without auth on the root
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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
// --- Finance-facing: list all submissions ---
app.get('/api/submissions', financeAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
  res.json(rows);
});

// --- Finance-facing: update status ---
app.patch('/api/submissions/:id/status', financeAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['Received', 'Verified', 'Resolved'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  db.prepare(`
    UPDATE submissions SET status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, req.params.id);

  res.json({ success: true });
});

// --- Finance-facing: export selected submissions to Excel ---
app.post('/api/submissions/export', financeAuth, (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { ids, startDate, endDate } = req.body;

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
    console.error('Export failed:', err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// --- Finance dashboard page (protected) ---

app.get('/finance', financeAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'finance.html'));
});

app.listen(PORT, () => {
  console.log(`Dealer portal running on port ${PORT}`);
});
