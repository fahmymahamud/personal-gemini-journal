import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db, studentsCol } from '../firebase.js';

const router = Router();
const MAX_MESSAGE_CHARS = 4096;   // Telegram's own sendMessage limit

const CONNECTED_REPLY = "✅ You're now connected to RemindClient! Your tutor can "
  + 'send you lesson and payment reminders here. See you in class! 🎓';
const NO_TOKEN_REPLY = 'Hi! Please ask your tutor to share your personal connection link.';

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    const err = new Error('Telegram is not configured on the server — TELEGRAM_BOT_TOKEN is missing.');
    err.status = 503;
    err.expose = true;   // names the fix; the coach cannot do anything else about it
    throw err;
  }
  return token;
}

// { studentId, message } -> forwards the draft to that student's Telegram chat.
router.post('/send', async (req, res) => {
  const { studentId, message } = req.body || {};

  const text = String(message || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
  if (!studentId) return res.status(400).json({ error: 'studentId is required' });

  // Scoped to req.uid, so a coach can only ever message their own students.
  const doc = await studentsCol(req.uid).doc(String(studentId)).get();
  if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

  const student = doc.data();
  const chatId = student.telegramChatId;
  if (!chatId) {
    return res.status(400).json({ error: `${student.name} has no Telegram chat ID saved.` });
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    // Telegram's own wording is the useful part ("chat not found", "bot was
    // blocked by the user"), so pass it through rather than a generic failure.
    const err = new Error(`Telegram rejected the message: ${data.description || response.status}`);
    err.status = response.status === 400 || response.status === 403 ? 400 : 502;
    err.expose = true;
    throw err;
  }

  res.json({ sent: true, messageId: data.result?.message_id ?? null });
});

export default router;

/* ═══════════════════ webhook ═══════════════════ */

async function tell(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    // Never let a reply failure bubble: the webhook must still answer 200.
    console.error('webhook reply failed:', err.message);
  }
}

export const webhookRouter = Router();

// Public by necessity — Telegram cannot send an Authorization header. When
// TELEGRAM_WEBHOOK_SECRET is set, Telegram echoes it back in this header
// (registered via setWebhook's secret_token), which is what stops anyone who
// finds the URL from posting forged updates.
webhookRouter.post('/', async (req, res) => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected && req.get('x-telegram-bot-api-secret-token') !== expected) {
    console.warn('webhook: rejected update with bad secret token');
    return res.status(401).json({ ok: false });
  }

  // Answer immediately and unconditionally. A non-200 makes Telegram retry the
  // same update indefinitely, so every failure below is swallowed and logged.
  res.status(200).json({ ok: true });

  try {
    const message = req.body?.message || req.body?.edited_message;
    const chatId = message?.chat?.id;
    const text = String(message?.text || '').trim();
    if (!chatId || !text.startsWith('/start')) return;

    const payload = text.slice('/start'.length).trim();
    if (!payload) return void tell(chatId, NO_TOKEN_REPLY);

    // Collection-group query: students live under users/{uid}/students, so this
    // is the only way to find one by token without knowing the coach.
    const snap = await db.collectionGroup('students')
      .where('connectionToken', '==', payload).limit(1).get();

    if (snap.empty) {
      console.warn('webhook: no student matches the supplied connection token');
      return void tell(chatId, NO_TOKEN_REPLY);
    }

    const doc = snap.docs[0];
    await doc.ref.update({
      telegramChatId: String(chatId),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`webhook: connected chat ${chatId} to student ${doc.id}`);
    await tell(chatId, CONNECTED_REPLY);
  } catch (err) {
    console.error('webhook processing failed:', err);
  }
});
