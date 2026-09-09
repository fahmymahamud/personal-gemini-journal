import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebase.js';
import { isAdmin } from './admin.js';

/*
 * The trial lifecycle.
 *
 * A coach's record lives as fields on users/{uid}, not at users/{uid}/profile.
 * That path has an odd number of segments, so Firestore reads it as a
 * collection, not a document — it cannot hold these fields. The existing coach
 * fields (telegramChatId, telegramLinkToken) already sit on users/{uid}, so
 * this keeps one home for one coach.
 */

export const TRIAL_DAYS = 30;
export const READONLY_DAYS = 30;    // after expiry, data stays readable
export const PURGE_WARN_DAYS = 30;  // then a deletion warning starts showing

export const TRIAL_DEFAULTS = {
  plan: 'trial',
  studentLimit: 15,
  aiMessagesPerDay: 20,
  autoRemindersPerStudent: 2,
};

const DAY_MS = 86_400_000;
const userRef = (uid) => db.collection('users').doc(uid);

/** Firestore Timestamp | ISO string | epoch ms -> epoch ms, or null. */
function toMillis(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Where a coach stands, derived rather than stored.
 *
 * Storing a status string would mean something had to write it the moment a
 * trial lapsed — a cron job whose failure silently grants free access forever.
 * Deriving it from the dates means the answer is correct even if nothing has
 * run for a month.
 *
 * phase: 'active' | 'expired' | 'purge-warning'
 *   active        — full use
 *   expired       — reads only; the data is all still there
 *   purge-warning — reads only, and the UI starts warning about deletion
 */
export function planState(profile, { uid, now = Date.now() } = {}) {
  if (uid && isAdmin(uid)) {
    return { plan: 'admin', phase: 'active', canWrite: true, daysLeft: null, showBar: false };
  }

  const plan = profile?.plan || 'trial';
  if (plan !== 'trial') {
    // Anything the owner has marked as paying is simply active. Billing is
    // manual today, so there is no expiry to compute.
    return { plan, phase: 'active', canWrite: true, daysLeft: null, showBar: false };
  }

  const ends = toMillis(profile?.trialEndDate);
  if (!ends) {
    // A trial record with no end date is a bug, not a licence. Treat it as
    // active so nobody is locked out by our own missing field, and say so.
    console.warn(`plan: trial with no trialEndDate for ${uid || 'unknown'}`);
    return { plan: 'trial', phase: 'active', canWrite: true, daysLeft: null, showBar: false };
  }

  const msLeft = ends - now;
  const daysLeft = Math.ceil(msLeft / DAY_MS);

  if (msLeft > 0) {
    return { plan: 'trial', phase: 'active', canWrite: true, daysLeft, showBar: true };
  }

  const daysOver = Math.floor(-msLeft / DAY_MS);
  const phase = daysOver >= READONLY_DAYS ? 'purge-warning' : 'expired';
  return {
    plan: 'trial',
    phase,
    canWrite: false,
    daysLeft: 0,
    showBar: true,
    // Days until the owner would delete the data, if they choose to. Nothing
    // deletes anything on its own — see the note in the route.
    daysToPurge: Math.max(0, READONLY_DAYS + PURGE_WARN_DAYS - daysOver),
  };
}

/* ═══════════════ per-instance cache ═══════════════ */

// Every authenticated request needs the plan, and re-reading the document each
// time would double the read count for no benefit. Short TTL so an upgrade
// takes effect within a minute without anyone restarting anything.
const TTL_MS = 60_000;
const cache = new Map();

export function invalidatePlan(uid) {
  cache.delete(uid);
}

/**
 * Loads the coach's record, creating it on first sight.
 *
 * Returns { profile, created } so the caller can fire the sign-up notification
 * exactly once — the create is the only reliable "this person is new" signal we
 * get, because Firebase Auth accounts can predate this code.
 */
export async function ensureProfile(user) {
  const hit = cache.get(user.uid);
  if (hit && Date.now() - hit.at < TTL_MS) return { profile: hit.profile, created: false };

  const ref = userRef(user.uid);
  const snap = await ref.get();

  // A document may exist from an earlier feature (a Telegram link token) without
  // ever having held a plan. That is still a first sign-up as far as billing is
  // concerned, so the test is for the plan field, not for the document.
  if (snap.exists && snap.data().plan) {
    const profile = snap.data();
    cache.set(user.uid, { at: Date.now(), profile });
    return { profile, created: false };
  }

  const now = new Date();
  const trial = {
    email: user.email || null,
    displayName: user.name || null,
    ...TRIAL_DEFAULTS,
    trialStartDate: now.toISOString(),
    trialEndDate: new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString(),
    createdAt: FieldValue.serverTimestamp(),
  };

  // merge so an existing telegramLinkToken or chat id survives.
  await ref.set(trial, { merge: true });

  const profile = { ...(snap.exists ? snap.data() : {}), ...trial };
  cache.set(user.uid, { at: Date.now(), profile });
  console.log(`plan: started a ${TRIAL_DAYS}-day trial for ${user.email || user.uid}`);
  return { profile, created: true };
}

/**
 * Blocks writes once a trial has lapsed, and lets every read through.
 *
 * Read-only rather than locked-out on purpose: a coach who has not paid yet
 * still needs to see their own students' phone numbers to chase a payment by
 * hand. Taking that away punishes the person we are trying to convert.
 */
export function requireActivePlan(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.plan?.canWrite !== false) return next();

  res.status(402).json({
    error: 'trial_expired',
    message: 'Your free trial has ended. Your data is safe and still readable — '
      + 'choose a plan to start making changes again.',
  });
}

/** The scheduler asks this before sending on a coach's behalf. */
export async function coachCanSend(uid) {
  const snap = await userRef(uid).get();
  return planState(snap.exists ? snap.data() : null, { uid }).canWrite;
}
