require('dotenv').config();
const fs = require('fs');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'qwen/qwen3.8-27b';

async function extractPaymentDetails(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const ext = imagePath.split('.').pop().toLowerCase();
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

  const prompt = `You are reading a bank payment confirmation screenshot (IBFT/Raast transfer receipt).
Extract the following fields and respond with ONLY valid JSON, no other text:

{
  "status": "success | failed | unclear",
  "sender_name": "name on the From Account, or null if not visible",
  "amount": "numeric amount only, no currency symbol or commas, or null if not visible",
  "transaction_date": "date/time as shown, or null if not visible",
  "transaction_type": "e.g. IBFT, Raast, or null if not visible",
  "to_account_name": "name on the To Account, or null if not visible",
  "confidence": "high | medium | low",
  "needs_review": true or false,
  "review_reason": "brief reason if needs_review is true, otherwise null"
}

Set needs_review to true if: the status is not clearly "Success", any critical field (amount, sender name) is unclear or missing, or the image doesn't look like a valid payment confirmation at all.`;

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 400,
      reasoning_effort: "none"
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const rawContent = data.choices[0].message.content;

  
  // Strip <think>...</think> reasoning blocks and markdown code fences
  let cleaned = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  cleaned = cleaned.replace(/```json\s*|\s*```/g, '').trim();
  
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
      confidence: 'low',
      needs_review: true,
      review_reason: 'Could not parse extraction result'
    };
  }
}

module.exports = { extractPaymentDetails };
