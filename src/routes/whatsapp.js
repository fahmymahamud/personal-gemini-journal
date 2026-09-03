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
