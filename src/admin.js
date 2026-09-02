import { db } from './firebase.js';

const ALLOWLIST = 'allowlist';

/**
 * Enforcement is opt-in, and off by default.
 *
 * The dashboard tells the admin in as many words that "all Google accounts can
 * sign in", so the allowlist must stay advisory until this is deliberately
 * switched on — otherwise adding the first coach would silently lock out
 * everyone else while the banner still claimed the door was open.
 */
export const allowlistEnforced = () =>
  String(process.env.ENFORCE_ALLOWLIST || '').toLowerCase() === 'true';

// Consulted on every authenticated request when enforcement is on, so it is
// cached rather than re-read each time. Writes invalidate it immediately on the
// instance that made the change.
const TTL_MS = 60_000;
let cached = null;

export function invalidateAllowlist() {
  cached = null;
}

export async function loadAllowlist() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached;

  const snap = await db.collection(ALLOWLIST).get();
  cached = {
    at: Date.now(),
    size: snap.size,
    emails: new Set(snap.docs.map((d) => String(d.data().email || d.id).trim().toLowerCase())),
    plans: new Map(snap.docs.map((d) => [
      String(d.data().email || d.id).trim().toLowerCase(),
      d.data().plan || 'free',
    ])),
  };
  return cached;
}

/** ADMIN_UID holds a comma-separated list, so more than one account can administer. */
export function adminUids() {
  return String(process.env.ADMIN_UID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const isAdmin = (uid) => adminUids().includes(uid);

/**
 * Applied after the ID token is verified. Admins are never subject to the
 * allowlist, so adding the first entry cannot lock the owner out.
 */
export async function allowlistPermits(user) {
  if (isAdmin(user.uid)) return { allowed: true, reason: 'admin' };
  if (!allowlistEnforced()) return { allowed: true, reason: 'enforcement-off' };

  const list = await loadAllowlist();
  if (list.size === 0) return { allowed: true, reason: 'empty' };

  const email = String(user.email || '').trim().toLowerCase();
  if (email && list.emails.has(email)) return { allowed: true, reason: 'allowlisted' };

  return { allowed: false, reason: 'not-allowlisted' };
}

/** Mounted after requireAuth, so req.uid is already proven. */
export function requireAdmin(req, res, next) {
  if (!adminUids().length) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'ADMIN_UID is not set on the server',
    });
  }
  if (!isAdmin(req.uid)) {
    return res.status(403).json({ error: 'forbidden', message: 'Admin access required' });
  }
  next();
}
