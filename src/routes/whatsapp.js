import crypto from 'node:crypto';
import { Router } from 'express';
import { studentsCol } from '../firebase.js';
import { toE164 } from '../student-schema.js';

const router = Router();
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v18.0';
const MAX_MESSAGE_CHARS = 4096;

// Meta's code for "recipient is not on the test-number allowlist". On a
// development WhatsApp app only pre-registered numbers can be messaged, so
// this is the error a coach is overwhelmingly most likely to hit.
const NOT_A_TEST_RECIPIENT = 131030;

function config() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    // 503 rather than 500: the client treats it as "API unavailable" and falls
    // back to opening wa.me, which is the whole point of keeping that path.
    const err = new Error('WhatsApp Cloud API is not configured on the server.');
    err.status = 503;
    err.expose = true;
    err.code = 'whatsapp_not_configured';
    throw err;
  }
  return { token, phoneId };
}

// { studentId, message } -> sends to the payer via the WhatsApp Cloud API.
router.post('/send', async (req, res) => {
  const { studentId, message } = req.body || {};

  const text = String(message || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
  if (!studentId) return res.status(400).json({ error: 'studentId is required' });

  // Scoped to req.uid, so a coach can only ever message their own students.
  const doc = await studentsCol(req.uid).doc(String(studentId)).get();
  if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

  const student = doc.data();
  // Same normaliser the student form uses: bare 8-digit numbers are assumed
  // Singaporean, anything with a + keeps its own country code.
  const e164 = toE164(student.payerPhone || student.studentPhone);
  if (!e164) {
    return res.status(400).json({
      error: `${student.name} has no phone number on file.`,
    });
  }

  const { token, phoneId } = config();
  // Graph wants digits only — a leading + is rejected on the `to` field.
  const to = e164.replace(/\D/g, '');

  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    const meta = data.error || {};
    const code = meta.code ?? meta.error_subcode;

    if (code === NOT_A_TEST_RECIPIENT) {
      const err = new Error(
        "This number hasn't been added as a test recipient yet. "
        + 'Add it under WhatsApp → API Setup in the Meta dashboard, or use the wa.me fallback.');
      err.status = 400;
      err.expose = true;
      err.code = 'not_test_recipient';
      throw err;
    }

    // Meta's own wording is the useful part ("Unsupported post request",
    // "Invalid OAuth access token"), so surface it rather than a generic line.
    const err = new Error(meta.message
      ? `WhatsApp rejected the message: ${meta.message}`
      : `WhatsApp send failed (HTTP ${response.status})`);
    err.status = response.status >= 500 ? 502 : 400;
    err.expose = true;
    err.code = 'whatsapp_error';
    throw err;
  }

  res.json({
    sent: true,
    messageId: data.messages?.[0]?.id ?? null,
    to: e164,
  });
});

export default router;

/* ── Meta webhooks ──────────────────────────────────────────────────────────
 * Both endpoints are public by necessity: Meta cannot send an Authorization
 * header. Mounted separately in server.js, ahead of the authenticated
 * /api/whatsapp mount, or requireAuth would reject the dashboard's calls.
 */
export const webhookRouter = Router();

/**
 * Constant-time compare, so a wrong token cannot be narrowed byte by byte.
 * Differing lengths short-circuit — timingSafeEqual throws across sizes — and
 * leak only the length, which is not worth protecting here.
 */
function verifyTokenMatches(given) {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expected || typeof given !== 'string') return false;

  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Called once when the webhook is saved in the Meta dashboard. Echoing
// hub.challenge back as plain text is what completes the handshake.
webhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && verifyTokenMatches(req.query['hub.verify_token'])) {
    console.log('whatsapp: webhook verification succeeded');
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }

  console.warn(`whatsapp: verification rejected (mode=${mode || 'none'})`);
  res.sendStatus(403);
});

/** Best effort — the payload shape varies by field, so nothing is assumed. */
function summarise(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      // An inbound reply from a parent.
      for (const message of value.messages || []) {
        out.push({
          kind: 'reply',
          from: message.from || 'unknown',
          text: message.text?.body ?? `[${message.type || 'non-text'}]`,
        });
      }

      // Delivery receipts: sent / delivered / read / failed.
      for (const status of value.statuses || []) {
        out.push({ kind: 'status', from: status.recipient_id || 'unknown', text: status.status });
      }
    }
  }
  return out;
}

webhookRouter.post('/', (req, res) => {
  // Answer first, unconditionally. Meta retries any non-200 with backoff and
  // eventually disables the subscription, so nothing below may reach the
  // response — every failure is swallowed and logged instead.
  res.sendStatus(200);

  try {
    const items = summarise(req.body);
    if (!items.length) return void console.log('whatsapp: update carried no messages or statuses');

    for (const item of items) {
      // A parent's phone number is personal data. The last four digits are
      // enough to match against a student without writing the number to logs.
      const masked = String(item.from).replace(/.(?=.{4})/g, '•');
      if (item.kind === 'reply') {
        console.log(`whatsapp: reply from ${masked}: ${item.text.slice(0, 200)}`);
      } else {
        console.log(`whatsapp: delivery ${item.text} for ${masked}`);
      }
    }
  } catch (err) {
    console.error('whatsapp: could not parse update', err);
  }
});
