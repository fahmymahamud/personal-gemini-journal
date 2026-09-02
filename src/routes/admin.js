import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db, studentsCol } from '../firebase.js';
import { allowlistEnforced, invalidateAllowlist, loadAllowlist } from '../admin.js';
import { usageDay } from '../rate-limit.js';

const router = Router();
const ALLOWLIST = 'allowlist';
const PLANS = ['trial', 'monthly', 'annual'];
const PAGE_SIZE = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const normEmail = (value) => String(value || '').trim().toLowerCase();

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Coaches are enumerated from Firebase Auth, not the `users` collection.
 * users/{uid} documents are never written — they exist only as parents of the
 * students and usage subcollections — so a .get() on that collection returns
 * zero. Auth is also the only source of email and last sign-in time.
 */
async function listCoaches() {
  const out = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    out.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return out;
}

const iso = (value) => {
  if (!value) return null;
  const d = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

router.get('/stats', async (req, res) => {
  const day = usageDay();
  const cutoff = new Date(Date.now() - WEEK_MS);

  // Named explicitly because these two failure modes are indistinguishable in
  // a generic 500: listing Auth users needs an Identity Toolkit role on the
  // runtime service account, which Firestore access alone does not grant.
  let users;
  try {
    users = await listCoaches();
  } catch (cause) {
    console.error('admin/stats: listing Firebase Auth users failed —', cause.message);
    const err = new Error(
      'Could not list Firebase Auth users. The Cloud Run service account needs '
      + 'roles/firebaseauth.viewer on this project.');
    err.status = 502;
    err.expose = true;
    throw err;
  }

  const [studentCount, perCoach] = await Promise.all([
    db.collectionGroup('students').count().get(),
    Promise.all(users.map(async (u) => {
      const [usageSnap, recentSnap] = await Promise.all([
        db.collection('users').doc(u.uid).collection('usage').doc('chat').get(),
        // "Active" means they actually touched a student, which is a better
        // signal than a sign-in that may just be a background token refresh.
        studentsCol(u.uid).where('updatedAt', '>=', cutoff).limit(1).get(),
      ]);
      const usage = usageSnap.exists ? usageSnap.data() : null;
      return {
        messagesToday: usage?.date === day ? (usage.count || 0) : 0,
        activeThisWeek: !recentSnap.empty,
      };
    })),
  ]);

  res.json({
    totalCoaches: users.length,
    totalStudents: studentCount.data().count,
    totalMessagesToday: perCoach.reduce((n, c) => n + c.messagesToday, 0),
    activeThisWeek: perCoach.filter((c) => c.activeThisWeek).length,
    day,
    enforcementOn: allowlistEnforced(),
  });
});

router.get('/coaches', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);

  let users;
  try {
    users = await listCoaches();
  } catch (cause) {
    console.error('admin/coaches: listing Firebase Auth users failed —', cause.message);
    const err = new Error(
      'Could not list Firebase Auth users. The Cloud Run service account needs '
      + 'roles/firebaseauth.viewer on this project.');
    err.status = 502;
    err.expose = true;
    throw err;
  }

  const list = await loadAllowlist();

  users.sort((a, b) =>
    new Date(b.metadata.lastSignInTime || 0) - new Date(a.metadata.lastSignInTime || 0));

  const start = (page - 1) * PAGE_SIZE;
  const slice = users.slice(start, start + PAGE_SIZE);

  const coaches = await Promise.all(slice.map(async (u) => {
    const count = await studentsCol(u.uid).count().get();
    const email = normEmail(u.email);
    return {
      uid: u.uid,
      email: u.email || null,
      displayName: u.displayName || null,
      studentCount: count.data().count,
      lastActive: u.metadata.lastSignInTime || null,
      plan: list.plans.get(email) || 'free',
    };
  }));

  res.json({
    coaches,
    page,
    pageSize: PAGE_SIZE,
    total: users.length,
    totalPages: Math.max(1, Math.ceil(users.length / PAGE_SIZE)),
  });
});

router.get('/allowlist', async (req, res) => {
  const snap = await db.collection(ALLOWLIST).get();
  const entries = snap.docs.map((d) => {
    const data = d.data();
    return {
      email: data.email || d.id,
      plan: data.plan || 'trial',
      paid_until: data.paid_until || null,
      created_at: iso(data.created_at),
      added_by: data.added_by || null,
    };
  }).sort((a, b) => a.email.localeCompare(b.email));

  res.json({ entries, enforcementOn: allowlistEnforced() });
});

router.post('/allowlist', async (req, res) => {
  const email = normEmail(req.body?.email);
  if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    throw badRequest('A valid email address is required');
  }

  const plan = String(req.body?.plan || 'trial').trim().toLowerCase();
  if (!PLANS.includes(plan)) throw badRequest(`plan must be one of: ${PLANS.join(', ')}`);

  const paidUntil = String(req.body?.paid_until || req.body?.paidUntil || '').trim();
  if (paidUntil && Number.isNaN(Date.parse(paidUntil))) {
    throw badRequest('paid_until must be a valid date');
  }

  // The email is the document id, so re-adding a coach updates their plan
  // rather than creating a duplicate, and the auth gate is a set lookup.
  await db.collection(ALLOWLIST).doc(email).set({
    email,
    plan,
    paid_until: paidUntil || null,
    added_by: req.uid,
    created_at: FieldValue.serverTimestamp(),
  }, { merge: true });

  invalidateAllowlist();
  res.status(201).json({
    entry: { email, plan, paid_until: paidUntil || null, added_by: req.uid },
  });
});

router.delete('/allowlist/:email', async (req, res) => {
  const email = normEmail(decodeURIComponent(req.params.email));
  const ref = db.collection(ALLOWLIST).doc(email);
  if (!(await ref.get()).exists) {
    return res.status(404).json({ error: 'not_found', message: 'Not on the allowlist' });
  }

  await ref.delete();
  invalidateAllowlist();
  res.status(204).end();
});

export default router;
