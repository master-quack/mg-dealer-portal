require('dotenv').config();
const fs = require('fs');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';

async function extractPaymentDetails(imagePath) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const fileBuffer = fs.readFileSync(imagePath);
  const base64Data = fileBuffer.toString('base64');
  const ext = imagePath.split('.').pop().toLowerCase();

  let fileBlock;
  if (ext === 'png') {
    fileBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Data } };
  } else if (ext === 'jpg' || ext === 'jpeg') {
    fileBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Data } };
  } else if (ext === 'pdf') {
    fileBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } };
  } else {
    throw new Error('Unsupported file type');
  }

  const prompt = `You are reading a bank payment confirmation screenshot (IBFT/Raast transfer receipt).
Extract the following fields and respond with ONLY valid JSON, no other text:

{
  "status": "success | failed | unclear",
  "sender_name": "name on the From Account, or null if not visible",
  "amount": "numeric amount only, no currency symbol or commas, or null if not visible",
  "transaction_date": "date/time as shown, or null if not visible",
  "transaction_type": "e.g. IBFT, Raast, or null if not visible",
  "to_account_name": "name on the To Account, or null if not visible",
  "bank_transaction_id": "the transaction/reference number printed on the slip, or null if not visible",
  "deposit_date": "the transaction date as YYYY-MM-DD, or null if not visible",
  "confidence": "high | medium | low",
  "needs_review": true or false,
  "review_reason": "brief reason if needs_review is true, otherwise null"
}

Set needs_review to true if: the status is not clearly "Success", any critical field (amount, sender name) is unclear or missing, or the image doesn't look like a valid payment confirmation at all.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let data;
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              fileBlock,
              { type: 'text', text: prompt }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${errText}`);
    }

    data = await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Extraction timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const rawContent = (data.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  // Strip markdown code fences
  let cleaned = rawContent.replace(/```json\s*|\s*```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to parse LLM response as JSON:', rawContent);
    return {
      status: 'unclear',
      sender_name: null,
      amount: null,
      transaction_date: null,
      transaction_type: null,
      to_account_name: null,
      bank_transaction_id: null,
      deposit_date: null,
      confidence: 'low',
      needs_review: true,
      review_reason: 'Could not parse extraction result'
    };
  }
}

module.exports = { extractPaymentDetails };
