import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebase.js';

export const CHAT_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT || 20);

// Days roll over at local midnight, not UTC — a Singapore coach's "today"
// should not reset at 8am. en-CA formats as YYYY-MM-DD, which sorts naturally.
const TZ = process.env.RATE_LIMIT_TZ || 'Asia/Singapore';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

// Exported so the admin dashboard reports "today" on the same clock the limiter
// counts on — otherwise the two disagree for eight hours a day.
export const usageDay = today;

const usageRef = (uid) => db.collection('users').doc(uid).collection('usage').doc('chat');

/**
 * Counts one Gemini call against this coach's daily allowance.
 *
 * Runs in a transaction because two concurrent requests would otherwise both
 * read 19 and both be allowed through. Throws a 429 when the day's allowance is
 * spent; the stored counter resets on the first call of a new local day.
 *
 * Charged before the Gemini call rather than after, so a request that fails
 * upstream still costs quota — otherwise a failing key could be retried without
 * limit, which is exactly the runaway spend this guards against.
 */
export async function consumeChatQuota(uid) {
  const ref = usageRef(uid);
  const day = today();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const used = data?.date === day ? (data.count || 0) : 0;

    if (used >= CHAT_DAILY_LIMIT) {
      const err = new Error(
        `Daily limit of ${CHAT_DAILY_LIMIT} Gemini messages reached. Resets at midnight ${TZ}.`);
      err.status = 429;
      err.expose = true;   // the coach can act on this: wait, or raise the limit
      throw err;
    }

    tx.set(ref, {
      date: day,
      count: used + 1,
      limit: CHAT_DAILY_LIMIT,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { used: used + 1, limit: CHAT_DAILY_LIMIT, remaining: CHAT_DAILY_LIMIT - used - 1 };
  });
}

/** Read-only view of today's usage, for surfacing remaining calls in the UI. */
export async function readChatQuota(uid) {
  const snap = await usageRef(uid).get();
  const data = snap.exists ? snap.data() : null;
  const used = data?.date === today() ? (data.count || 0) : 0;
  return { used, limit: CHAT_DAILY_LIMIT, remaining: Math.max(0, CHAT_DAILY_LIMIT - used) };
}
