import crypto from 'node:crypto';
import { Router } from 'express';
import { checkDueReminders, testStudentReminders } from '../scheduler.js';

/* ═══════════════ GET /api/scheduler/check ═══════════════ */

// Called by Cloud Scheduler, never by a browser, so it carries a shared secret
// instead of a Firebase token. Mounted ahead of the authenticated router in
// server.js — Express matches in order, and Cloud Scheduler sends no
// Authorization header.
export const checkRouter = Router();

/**
 * Constant-time compare that does not leak the expected length.
 *
 * timingSafeEqual throws when the two buffers differ in size, so the raw
 * lengths are hashed to a fixed width first; without that, the throw itself
 * would answer "is my guess the right length?".
 */
function secretMatches(supplied, expected) {
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

checkRouter.get('/', async (req, res) => {
  const expected = process.env.SCHEDULER_SECRET;

  // Refusing outright when unset is the safe default: a blank secret would
  // otherwise make this endpoint world-callable the moment the env var went
  // missing, and anyone could drive the coach's Telegram sends.
  if (!expected) {
    console.error('scheduler: SCHEDULER_SECRET is not set — refusing to run the sweep');
    return res.status(503).json({ error: 'Scheduler is not configured' });
  }

  if (!secretMatches(req.get('x-scheduler-secret') || '', expected)) {
    console.warn('scheduler: rejected a check with a bad secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { checked, sent, failed, skipped } = await checkDueReminders();
  res.json({ checked, sent, failed, skipped });
});

/* ═══════════════ POST /api/scheduler/test/:studentId ═══════════════ */

// Authenticated, and scoped to req.uid by the collection path inside
// testStudentReminders — a coach can only ever test their own students.
const router = Router();

router.post('/test/:studentId', async (req, res) => {
  const out = await testStudentReminders(req.uid, req.params.studentId, {
    coachName: req.user?.name || null,
  });
  const { checked, sent, failed, skipped, results } = out;
  res.json({ checked, sent, failed, skipped, results });
});

export default router;
