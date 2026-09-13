import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebase.js';
import { isAdmin } from './admin.js';

/*
 * The plan lifecycle.
 *
 * There is no self-serve trial. A new sign-up starts with plan 'none': they can
 * sign in and look around, but nothing is written or sent on their behalf until
 * the owner activates them from the admin dashboard after they pay. A trial
 * still exists, but only as something the owner grants by hand.
 *
 * A coach's record lives as fields on users/{uid}, not at users/{uid}/profile.
 * That path has an odd number of segments, so Firestore reads it as a
 * collection, not a document — it cannot hold these fields. The existing coach
 * fields (telegramChatId, telegramLinkToken) already sit on users/{uid}, so
 * this keeps one home for one coach.
 */

export const READONLY_DAYS = 30;    // after a trial ends, data stays readable
export const PURGE_WARN_DAYS = 30;  // then a deletion warning starts showing

/** What the owner can grant from the dashboard. */
export const GRANTABLE_PLANS = ['trial', 'monthly', 'annual'];

// The Starter tier, applied to owner-granted trials. Paid plans are uncapped.
export const TRIAL_DEFAULTS = {
  plan: 'trial',
  studentLimit: 20,
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
 * phase: 'active' | 'inactive' | 'expired' | 'purge-warning'
 *   active        — full use
 *   inactive      — signed up, not activated yet; reads only
 *   expired       — a granted trial ran out; reads only, data all still there
 *   purge-warning — reads only, and the UI starts warning about deletion
 */
export function planState(profile, { uid, now = Date.now() } = {}) {
  if (uid && isAdmin(uid)) {
    return { plan: 'admin', phase: 'active', canWrite: true, daysLeft: null, showBar: false };
  }

  const plan = profile?.plan;
  if (!plan) {
    // No plan field at all: an account from before billing existed that has
    // not signed in since. The scheduler asks about these too, and cutting off
    // their reminders without the coach ever seeing why would be the worst way
    // to find out. Their next sign-in writes a plan and they see the bar.
    return { plan: 'legacy', phase: 'active', canWrite: true, daysLeft: null, showBar: false };
  }
  if (plan === 'none') {
    return { plan: 'none', phase: 'inactive', canWrite: false, daysLeft: null, showBar: true };
  }
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

  // The owner may have added this email on the dashboard before the coach ever
  // signed up — they paid first. That grant is waiting on the allowlist.
  const email = String(user.email || '').trim().toLowerCase();
  const pending = email ? await db.collection('allowlist').doc(email).get() : null;
  const grant = pending?.exists && GRANTABLE_PLANS.includes(pending.data().plan)
    ? grantFields(pending.data().plan, pending.data().paid_until)
    : { plan: 'none' };

  const record = {
    email: user.email || null,
    displayName: user.name || null,
    ...grant,
    createdAt: FieldValue.serverTimestamp(),
  };

  // merge so an existing telegramLinkToken or chat id survives.
  await ref.set(record, { merge: true });

  const profile = { ...(snap.exists ? snap.data() : {}), ...record };
  cache.set(user.uid, { at: Date.now(), profile });
  console.log(`plan: new account ${user.email || user.uid} starts on '${record.plan}'`);
  return { profile, created: true };
}

/** 'YYYY-MM-DD' from the dashboard means the end of that day in Singapore. */
function endOfDay(value) {
  if (!value) return null;
  const s = String(value);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59+08:00`) : Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The fields a grant writes onto users/{uid}. */
function grantFields(plan, paidUntil) {
  const until = endOfDay(paidUntil);
  if (plan === 'trial') {
    return {
      ...TRIAL_DEFAULTS,
      trialStartDate: new Date().toISOString(),
      // A trial with no end date would never lapse, so the dashboard's date is
      // required here; fall back to a month rather than to forever.
      trialEndDate: until || new Date(Date.now() + 30 * DAY_MS).toISOString(),
      paidUntil: until,
    };
  }
  return { plan, paidUntil: until };
}

/** Owner activates (or changes) a coach's plan. Takes effect within a minute. */
export async function grantPlan(uid, { plan, paidUntil }) {
  await userRef(uid).set({ ...grantFields(plan, paidUntil), planUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  invalidatePlan(uid);
}

/** Owner removes access: back to read-only, data untouched. */
export async function revokePlan(uid) {
  await userRef(uid).set({ plan: 'none', planUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  invalidatePlan(uid);
}

/**
 * Blocks writes for an account without an active plan, and lets every read
 * through.
 *
 * Read-only rather than locked-out on purpose: a coach who has not paid yet
 * still needs to see their own students' phone numbers to chase a payment by
 * hand. Taking that away punishes the person we are trying to convert.
 */
export function requireActivePlan(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.plan?.canWrite !== false) return next();

  if (req.plan.phase === 'inactive') {
    return res.status(402).json({
      error: 'no_plan',
      message: 'Your account is not active yet. Choose a plan to start adding clients '
        + 'and sending reminders.',
    });
  }
  res.status(402).json({
    error: 'trial_expired',
    message: 'Your trial has ended. Your data is safe and still readable — '
      + 'choose a plan to start making changes again.',
  });
}

/** The scheduler asks this before sending on a coach's behalf. */
export async function coachCanSend(uid) {
  const snap = await userRef(uid).get();
  return planState(snap.exists ? snap.data() : null, { uid }).canWrite;
}
