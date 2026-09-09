import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebase.js';

// The four payment-verification transitions live here rather than in a route,
// because both the Telegram webhook and the in-app buttons drive exactly the
// same state machine. Two copies of it would drift, and the half that drifted
// would be the one nobody watches — the bot.

export const PENDING = 'pending_verification';

export const studentRef = (uid, studentId) =>
  db.collection('users').doc(uid).collection('students').doc(studentId);

export const followupsCol = (uid, studentId) => studentRef(uid, studentId).collection('followups');

const nowIso = () => new Date().toISOString();

/**
 * Parent says they have paid, or has sent a screenshot.
 *
 * Written as one blind update rather than read-modify-write: the only field
 * that depends on prior state is awaitingReceipt, and clearing it
 * unconditionally is correct in both paths.
 */
export function declarePayment(uid, studentId, { type, receiptPath = null }) {
  return studentRef(uid, studentId).update({
    paymentStatus: PENDING,
    awaitingReceipt: false,
    paymentProof: {
      type,                       // 'self_declared' | 'screenshot'
      path: receiptPath,          // object path in the receipts bucket, or null
      submittedAt: nowIso(),
      submittedVia: 'telegram',
      verifiedBy: null,
      verifiedAt: null,
    },
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Parent tapped Send Receipt; the next photo from their chat is the receipt. */
export function awaitReceipt(uid, studentId) {
  return studentRef(uid, studentId).update({
    awaitingReceipt: true,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Coach accepts the declaration.
 *
 * verifiedBy is stamped from the authenticated coach here, never from anything
 * the caller supplied — an approval that can name its own approver is not a
 * record of anything.
 */
export function confirmPayment(uid, studentId, coachUid) {
  const at = nowIso();
  return studentRef(uid, studentId).update({
    paymentStatus: 'paid',
    lastPaidDate: at.slice(0, 10),
    awaitingReceipt: false,
    'paymentProof.verifiedBy': coachUid,
    'paymentProof.verifiedAt': at,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Coach rejects it. The proof is dropped entirely: keeping a rejected receipt
 * on the record invites a later reader to treat it as evidence of payment.
 */
export function rejectPayment(uid, studentId) {
  return studentRef(uid, studentId).update({
    paymentStatus: 'unpaid',
    paymentProof: null,
    awaitingReceipt: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** "Remind me later" — a one-off, three days out, alongside the weekly rules. */
export function scheduleFollowup(uid, studentId, { days = 3 } = {}) {
  const sendAt = new Date(Date.now() + days * 86_400_000);
  return followupsCol(uid, studentId).add({
    sendAt: sendAt.toISOString(),
    type: 'payment',
    message: null,
    sent: false,
    sentAt: null,
    createdAt: FieldValue.serverTimestamp(),
  }).then(() => sendAt);
}

/**
 * The coach's own chat id, for payment notifications.
 * Stored on the user document; there is no separate profile doc in this schema.
 */
export async function coachChatId(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? (snap.data().telegramChatId || null) : null;
}

/**
 * Resolves a student by document id *and* proves the chat asking about it is
 * the one linked to that student.
 *
 * This is the whole authorisation story for parent-side callbacks: callback_data
 * carries a student id, and anyone who can message the bot can send any id they
 * like. Without this check a parent could confirm another family's payment.
 */
export async function studentForChat(studentId, chatId) {
  const snap = await db.collectionGroup('students').get();
  const match = snap.docs.find(
    (d) => d.id === studentId && String(d.data().telegramChatId || '') === String(chatId));
  if (!match) return null;
  return { doc: match, uid: match.ref.parent.parent.id, student: match.data() };
}

/**
 * Every student reachable on one chat — siblings share a parent's chat, so this
 * is a list rather than a single record.
 *
 * Fetch-and-filter, like studentForChat above, rather than
 * .where('telegramChatId', '==', chatId). A collection-group filter needs an
 * index that has to be provisioned separately, and a missing one throws at
 * runtime: the receipt handler shipped with exactly that query and swallowed
 * every photo a parent sent. At this roster size the read is trivial; past a
 * few thousand students the answer is a chat->student map document, not a
 * cleverer query.
 */
export async function studentsForChat(chatId) {
  const snap = await db.collectionGroup('students').get();
  const want = String(chatId);
  return snap.docs
    .filter((d) => String(d.data().telegramChatId || '') === want)
    .map((doc) => ({ doc, uid: doc.ref.parent.parent.id, student: doc.data() }));
}

/** Same lookup for coach-side callbacks: the chat must be the coach's own. */
export async function studentForCoachChat(studentId, chatId) {
  const users = await db.collection('users').where('telegramChatId', '==', String(chatId)).get();
  for (const user of users.docs) {
    const doc = await studentRef(user.id, studentId).get();
    if (doc.exists) return { doc, uid: user.id, student: doc.data() };
  }
  return null;
}
