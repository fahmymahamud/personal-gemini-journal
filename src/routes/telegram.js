import crypto from 'node:crypto';
import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db, studentsCol } from '../firebase.js';
import {
  sendTelegramMessage, sendTelegramPhoto, answerCallback, editMessageText,
  editMessageCaption, fetchTelegramFile, parseCallbackData,
  payerButtons, coachButtons, MAX_MESSAGE_CHARS,
} from '../telegram.js';
import {
  declarePayment, awaitReceipt, confirmPayment, rejectPayment,
  scheduleFollowup, coachChatId, studentForChat, studentForCoachChat,
} from '../payments.js';
import { saveReceipt, MAX_RECEIPT_BYTES } from '../storage.js';

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'RemindClientBot';

const router = Router();

const CONNECTED_REPLY = "✅ You're now connected to RemindClient! Your tutor can "
  + 'send you lesson and payment reminders here. See you in class! 🎓';
const NO_TOKEN_REPLY = 'Hi! Please ask your tutor to share your personal connection link.';

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

  // Same keyboard the scheduler attaches, so a hand-sent chase can be answered
  // the same way an automatic one can.
  const result = await sendTelegramMessage(chatId, text, {
    replyMarkup: payerButtons(String(studentId)),
  });
  if (!result.ok) {
    // Telegram's own wording is the useful part ("chat not found", "bot was
    // blocked by the user"), so pass it through rather than a generic failure.
    const err = new Error(`Telegram rejected the message: ${result.description}`);
    err.status = result.status === 400 || result.status === 403 ? 400 : 502;
    err.expose = true;
    throw err;
  }

  res.json({ sent: true, messageId: result.messageId });
});

/*
 * Mints the coach's own connection link.
 *
 * The token is random and stored on the user document rather than being the
 * uid: a deep link gets forwarded and pasted around, and there is no reason for
 * an account identifier to travel with it. It is single-use — the webhook
 * deletes it on connect.
 */
router.post('/coach/link', async (req, res) => {
  const ref = db.collection('users').doc(req.uid);
  const snap = await ref.get();

  let token = snap.exists ? snap.data().telegramLinkToken : null;
  if (!token) {
    token = crypto.randomBytes(16).toString('base64url');
    await ref.set({ telegramLinkToken: token }, { merge: true });
  }

  res.json({
    token,
    copyUrl: `t.me/${BOT_USERNAME}?start=coach_${token}`,
    deepLink: `tg://resolve?domain=${BOT_USERNAME}&start=coach_${token}`,
  });
});

/** Where the coach's notifications currently go, if anywhere. */
router.get('/coach', async (req, res) => {
  const snap = await db.collection('users').doc(req.uid).get();
  res.json({ connected: !!(snap.exists && snap.data().telegramChatId) });
});

router.delete('/coach', async (req, res) => {
  await db.collection('users').doc(req.uid).set({
    telegramChatId: null,
    telegramLinkToken: FieldValue.delete(),
  }, { merge: true });
  res.json({ connected: false });
});

export default router;

/* ═══════════════════ webhook ═══════════════════ */

async function tell(chatId, text) {
  // Never let a reply failure bubble: the webhook must still answer 200.
  // sendTelegramMessage resolves rather than throws, but botToken() inside it
  // still can, so the guard stays.
  try {
    const result = await sendTelegramMessage(chatId, text);
    if (!result.ok) console.error('webhook reply failed:', result.description);
  } catch (err) {
    console.error('webhook reply failed:', err.message);
  }
}

export const webhookRouter = Router();

const money = (st) => `${(st.feeCurrency || 'SGD').toUpperCase()} ${Number(st.feeAmount || 0).toFixed(2)}`;
const payerOf = (st) => st.payerName || st.name || 'Someone';
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/**
 * Tells the coach a declaration has arrived, with the accept/reject pair.
 * Silent when the coach has not linked their own Telegram — that is a setup
 * gap, not an error, and the declaration is still visible in the app.
 */
async function notifyCoach(uid, studentId, student, { photoFileId = null } = {}) {
  const chat = await coachChatId(uid);
  if (!chat) {
    console.log(`webhook: coach ${uid} has no Telegram linked — in-app only`);
    return;
  }

  const line = photoFileId
    ? `${payerOf(student)} sent a receipt for ${student.name}'s fee of ${money(student)}.`
    : `${payerOf(student)} says they've paid ${student.name}'s fee of ${money(student)}.`;

  const markup = coachButtons(studentId);
  const out = photoFileId
    ? await sendTelegramPhoto(chat, photoFileId, { caption: line, replyMarkup: markup })
    : await sendTelegramMessage(chat, line, { replyMarkup: markup });

  if (!out.ok) console.error(`webhook: could not notify coach ${uid} — ${out.description}`);
}

/** Strips the keyboard off whatever the tap came from and records the outcome. */
async function closeOut(message, suffix) {
  if (!message) return;
  const chatId = message.chat?.id;
  const id = message.message_id;
  if (message.photo) {
    await editMessageCaption(chatId, id, `${message.caption || ''}\n\n${suffix}`.trim());
  } else {
    await editMessageText(chatId, id, `${message.text || ''}\n\n${suffix}`.trim());
  }
}

/* ═══════════════ parent-side taps ═══════════════ */

async function onPaid(query, studentId) {
  const found = await studentForChat(studentId, query.message.chat.id);
  if (!found) return void answerCallback(query.id, 'That reminder is no longer valid.');

  await declarePayment(found.uid, studentId, { type: 'self_declared' });
  await answerCallback(query.id, 'Thank you! Your tutor has been notified. 🙏');
  await closeOut(query.message, '✅ Marked as paid — pending verification');
  await notifyCoach(found.uid, studentId, found.student);
}

async function onReceipt(query, studentId) {
  const found = await studentForChat(studentId, query.message.chat.id);
  if (!found) return void answerCallback(query.id, 'That reminder is no longer valid.');

  await awaitReceipt(found.uid, studentId);
  await answerCallback(query.id, 'Send me the screenshot now — just send the photo in this chat.');
  await sendTelegramMessage(query.message.chat.id,
    '📸 Go ahead and send the payment screenshot in this chat.');
}

async function onLater(query, studentId) {
  const found = await studentForChat(studentId, query.message.chat.id);
  if (!found) return void answerCallback(query.id, 'That reminder is no longer valid.');

  await scheduleFollowup(found.uid, studentId, { days: 3 });
  await answerCallback(query.id, "No problem! I'll remind you again in 3 days. 🙏");
  await closeOut(query.message, `⏰ Will remind again on ${inDays(3)}`);
}

/* ═══════════════ coach-side taps ═══════════════ */

// Resolved through the coach's own chat id, so a parent who guesses a
// confirm:<id> payload finds nothing: their chat is not on any user document.
async function onConfirm(query, studentId) {
  const found = await studentForCoachChat(studentId, query.message.chat.id);
  if (!found) return void answerCallback(query.id, 'Only the tutor can confirm this.');

  await confirmPayment(found.uid, studentId, found.uid);
  await answerCallback(query.id, 'Payment confirmed ✅');
  await closeOut(query.message, `✅ Confirmed on ${today()}`);

  if (found.student.telegramChatId) {
    await sendTelegramMessage(found.student.telegramChatId,
      'Your payment has been confirmed. Thank you! 🙏');
  }
}

async function onReject(query, studentId) {
  const found = await studentForCoachChat(studentId, query.message.chat.id);
  if (!found) return void answerCallback(query.id, 'Only the tutor can reject this.');

  await rejectPayment(found.uid, studentId);
  await answerCallback(query.id, "Payment rejected. The student's status is back to unpaid.");
  await closeOut(query.message, `❌ Rejected on ${today()}`);

  if (found.student.telegramChatId) {
    await sendTelegramMessage(found.student.telegramChatId,
      "Your tutor hasn't received the payment yet. Please check and try again. "
      + 'If you believe this is an error, please contact your tutor directly.');
  }
}

const HANDLERS = {
  paid: onPaid, receipt: onReceipt, later: onLater, confirm: onConfirm, reject: onReject,
};

async function handleCallback(query) {
  const parsed = parseCallbackData(query.data);
  if (!parsed || !query.message?.chat?.id) {
    console.warn('webhook: rejected malformed callback_data');
    return void answerCallback(query.id, 'Sorry, that button is no longer valid.');
  }
  await HANDLERS[parsed.action](query, parsed.studentId);
}

/* ═══════════════ receipt photos ═══════════════ */

/**
 * A photo only means something while a student on this chat is waiting to send
 * one, so the flag is what routes it. Anything else is ignored rather than
 * guessed at.
 */
async function handlePhoto(message) {
  const chatId = String(message.chat.id);
  const snap = await db.collectionGroup('students')
    .where('telegramChatId', '==', chatId).where('awaitingReceipt', '==', true).get();

  if (snap.empty) return;

  const doc = snap.docs[0];
  const uid = doc.ref.parent.parent.id;
  const student = doc.data();

  // photo[] is ascending by size; the last is the largest Telegram kept.
  const largest = message.photo[message.photo.length - 1];
  if (largest.file_size && largest.file_size > MAX_RECEIPT_BYTES) {
    return void sendTelegramMessage(chatId, 'That image is over 5MB — please send a smaller one.');
  }

  const file = await fetchTelegramFile(largest.file_id);
  if (!file.ok) {
    console.error(`webhook: receipt download failed — ${file.description}`);
    return void sendTelegramMessage(chatId, "Sorry, I couldn't read that image. Please try again.");
  }

  let saved;
  try {
    saved = await saveReceipt({ uid, studentId: doc.id, buffer: file.buffer });
  } catch (err) {
    console.error(`webhook: receipt rejected — ${err.message}`);
    return void sendTelegramMessage(chatId, err.expose ? err.message
      : "Sorry, I couldn't save that image. Please try again.");
  }

  await declarePayment(uid, doc.id, { type: 'screenshot', receiptPath: saved.path });
  await sendTelegramMessage(chatId, 'Receipt received! Your tutor has been notified. 🙏');
  // The coach gets the same photo by file_id — no re-upload, no public URL.
  await notifyCoach(uid, doc.id, student, { photoFileId: largest.file_id });
  console.log(`webhook: receipt stored for student ${doc.id} (${saved.bytes} bytes)`);
}

/* ═══════════════ /start ═══════════════ */

// Coaches link their own chat with a coach_-prefixed token. The token is
// random and stored on the user document rather than being the uid itself:
// a uid in a link that gets forwarded around is an account identifier leaking
// into a parent's chat history for no reason.
async function startCoach(chatId, token) {
  const users = await db.collection('users').where('telegramLinkToken', '==', token).limit(1).get();
  if (users.empty) return void tell(chatId, NO_TOKEN_REPLY);

  await users.docs[0].ref.update({
    telegramChatId: String(chatId),
    telegramLinkToken: FieldValue.delete(),   // single use
    telegramLinkedAt: FieldValue.serverTimestamp(),
  });
  console.log(`webhook: connected chat ${chatId} to coach ${users.docs[0].id}`);
  await tell(chatId, "✅ You're connected. Payment confirmations will arrive here.");
}

async function startStudent(chatId, chat, payload) {
  // Collection-group query: students live under users/{uid}/students, so this
  // is the only way to find one by token without knowing the coach.
  const snap = await db.collectionGroup('students')
    .where('connectionToken', '==', payload).limit(1).get();

  if (snap.empty) {
    console.warn('webhook: no student matches the supplied connection token');
    return void tell(chatId, NO_TOKEN_REPLY);
  }

  // Record WHO connected, not just the chat id. A coach testing their own
  // invite link binds the student to their own account, and a bare
  // "Connected to Telegram" hides that until reminders quietly arrive in the
  // wrong inbox. Showing the name makes a mis-bind obvious at a glance.
  const displayName = [chat.first_name, chat.last_name].filter(Boolean).join(' ')
    || chat.username || `chat ${chatId}`;

  const doc = snap.docs[0];
  await doc.ref.update({
    telegramChatId: String(chatId),
    telegramName: displayName,
    telegramUsername: chat.username || null,
    telegramLinkedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log(`webhook: connected chat ${chatId} (${displayName}) to student ${doc.id}`);
  await tell(chatId, CONNECTED_REPLY);
}

/* ═══════════════ the webhook ═══════════════ */

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
    if (req.body?.callback_query) return void await handleCallback(req.body.callback_query);

    const message = req.body?.message || req.body?.edited_message;
    if (!message?.chat?.id) return;

    if (Array.isArray(message.photo) && message.photo.length) {
      return void await handlePhoto(message);
    }

    const chatId = message.chat.id;
    const text = String(message.text || '').trim();
    if (!text.startsWith('/start')) return;

    const payload = text.slice('/start'.length).trim();
    if (!payload) return void tell(chatId, NO_TOKEN_REPLY);

    if (payload.startsWith('coach_')) {
      return void await startCoach(chatId, payload.slice('coach_'.length));
    }
    await startStudent(chatId, message.chat, payload);
  } catch (err) {
    console.error('webhook processing failed:', err);
  }
});
