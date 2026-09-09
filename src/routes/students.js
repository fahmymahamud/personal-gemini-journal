import crypto from 'node:crypto';
import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db, studentsCol, eventsCol } from '../firebase.js';
import { normalizeStudent, lessonsOf } from '../student-schema.js';
import { PENDING, confirmPayment, rejectPayment } from '../payments.js';
import { readReceipt } from '../storage.js';

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'RemindClientBot';

// Telegram's /start payload allows [A-Za-z0-9_-] up to 64 chars; base64url of
// 16 random bytes is 22, well inside that. Random and stored rather than
// derived, because the bot has to map a token back to one student and a hash
// cannot be reversed. Never accepted from the client — see student-schema.js,
// which deliberately does not list connectionToken as a writable field.
const newConnectionToken = () => crypto.randomBytes(16).toString('base64url');

const router = Router();

/**
 * Points every reminder at a lesson that actually exists.
 *
 * A reminder holds a lessonId, not a copy of the slot, so deleting a lesson
 * leaves any reminder aimed at it dangling. The frontend clears those as the
 * row is removed; this is the backstop for a client that did not, and for the
 * order the two arrays happen to arrive in.
 *
 * A payment reminder simply loses the link. A lesson reminder has nothing left
 * to describe, so it is rejected rather than quietly sending about a slot that
 * is no longer in the record.
 */
function checkReminderLessons(reminders, lessons) {
  const ids = new Set(lessons.map((lesson) => lesson.id));
  for (const [i, reminder] of reminders.entries()) {
    if (reminder.lessonId && ids.has(reminder.lessonId)) continue;
    if (reminder.type === 'lesson') {
      const err = new Error(
        `Reminder ${i + 1} is about a lesson that is no longer in the schedule — `
        + 'pick another lesson or switch it to a payment reminder');
      err.status = 400;
      throw err;
    }
    reminder.lessonId = null;
  }
  return reminders;
}

function serialize(doc) {
  const data = doc.data();
  const asIso = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v ?? null);
  return {
    id: doc.id,
    ...data,
    createdAt: asIso(data.createdAt),
    updatedAt: asIso(data.updatedAt),
  };
}

router.get('/', async (req, res) => {
  const snap = await studentsCol(req.uid).orderBy('name').get();
  res.json({ students: snap.docs.map(serialize) });
});

router.post('/', async (req, res) => {
  const student = normalizeStudent(req.body);
  if (student.autoReminders?.length) {
    checkReminderLessons(student.autoReminders, student.lessons || []);
  }
  const ref = await studentsCol(req.uid).add({
    ...student,
    // Redundant next to the path, but it keeps a future collection-group query
    // (the step-8 reminder bot) able to tell whose record it is holding.
    userId: req.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const doc = await ref.get();
  res.status(201).json({ student: serialize(doc) });
});

// Declared before '/:id' on purpose: Express matches in order, and
// '/:id' would otherwise swallow this and look up a student called
// "pending-verification".
router.get('/pending-verification', async (req, res) => {
  const snap = await studentsCol(req.uid).where('paymentStatus', '==', PENDING).get();
  const pending = snap.docs.map(serialize).sort((a, b) => {
    // Newest declaration first. Anything without a timestamp sorts last rather
    // than jumping the queue on a falsy compare.
    const at = (x) => Date.parse(x.paymentProof?.submittedAt || '') || 0;
    return at(b) - at(a);
  });
  res.json({ students: pending });
});

router.get('/:id', async (req, res) => {
  const doc = await studentsCol(req.uid).doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Student not found' });
  res.json({ student: serialize(doc) });
});

router.patch('/:id', async (req, res) => {
  const ref = studentsCol(req.uid).doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

  const updates = normalizeStudent(req.body, { partial: true });
  // Writing the lessons array retires the three fields it replaced, so a
  // record never carries two sources of truth for the same schedule.
  if (updates.lessons) {
    updates.lessonDay = FieldValue.delete();
    updates.lessonDays = FieldValue.delete();
    updates.lessonTime = FieldValue.delete();
    updates.location = FieldValue.delete();
  }
  // The schema drops lastSent/lastError on the way in, because a client must
  // not be able to re-arm a reminder that already fired. Carry the stored
  // values across by id, so editing a reminder's time does not also forget
  // that this week's message went out.
  if (updates.autoReminders) {
    const before = new Map(
      (doc.data().autoReminders || []).map((r) => [r.id, r]));
    updates.autoReminders = updates.autoReminders.map((r) => ({
      ...r,
      lastSent: before.get(r.id)?.lastSent ?? null,
      lastError: before.get(r.id)?.lastError ?? null,
    }));
    // Against the lessons this save leaves behind, which is the incoming array
    // when the schedule is part of the same PATCH and the stored one otherwise.
    checkReminderLessons(updates.autoReminders, updates.lessons ?? lessonsOf(doc.data()));
  }
  await ref.update({ ...updates, updatedAt: FieldValue.serverTimestamp() });
  res.json({ student: serialize(await ref.get()) });
});

/*
 * Verification is its own pair of endpoints rather than a PATCH.
 *
 * A PATCH that accepted paymentProof would let a client name its own verifier
 * and its own timestamp — an approval record that the approver can write is not
 * evidence of anything. Here the uid is taken from the verified token and the
 * time from the server clock, and the client supplies nothing at all.
 */
router.post('/:id/payment/confirm', async (req, res) => {
  const ref = studentsCol(req.uid).doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

  await confirmPayment(req.uid, req.params.id, req.uid);
  res.json({ student: serialize(await ref.get()) });
});

router.post('/:id/payment/reject', async (req, res) => {
  const ref = studentsCol(req.uid).doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

  await rejectPayment(req.uid, req.params.id);
  res.json({ student: serialize(await ref.get()) });
});

/*
 * Streams the receipt to the coach who owns the student.
 *
 * The bucket is private and public access is prevented, so this is the only way
 * to see one. Signed URLs would have been less code and more exposure: a link
 * that works for anyone holding it, expiring exactly when the record stops
 * being convenient to check.
 */
router.get('/:id/receipt', async (req, res) => {
  const doc = await studentsCol(req.uid).doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

  const path = doc.data().paymentProof?.path;
  if (!path) return res.status(404).json({ error: 'No receipt on file' });

  const file = await readReceipt(path);
  if (!file) return res.status(404).json({ error: 'Receipt is no longer stored' });

  res.set('Content-Type', file.contentType);
  res.set('Cache-Control', 'private, no-store');
  res.send(file.buffer);
});

// Returns the invite links for this student, minting the token on first ask so
// existing students do not need a migration.
router.post('/:id/telegram/link', async (req, res) => {
  const ref = studentsCol(req.uid).doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

  let token = doc.data().connectionToken;
  if (!token) {
    token = newConnectionToken();
    await ref.update({ connectionToken: token, updatedAt: FieldValue.serverTimestamp() });
  }

  res.json({
    token,
    copyUrl: `t.me/${BOT_USERNAME}?start=${token}`,
    deepLink: `tg://resolve?domain=${BOT_USERNAME}&start=${token}`,
  });
});

// Unlinks the student: clears the chat id and burns the token, so a previously
// shared invite link cannot silently reconnect someone later.
router.delete('/:id/telegram', async (req, res) => {
  const ref = studentsCol(req.uid).doc(req.params.id);
  if (!(await ref.get()).exists) return res.status(404).json({ error: 'Student not found' });

  await ref.update({
    telegramChatId: null,
    telegramName: null,
    telegramUsername: null,
    telegramLinkedAt: null,
    connectionToken: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  res.json({ student: serialize(await ref.get()) });
});

router.delete('/:id', async (req, res) => {
  const ref = studentsCol(req.uid).doc(req.params.id);
  if (!(await ref.get()).exists) return res.status(404).json({ error: 'Student not found' });

  // Everything pointing at this student goes with it — one-off lessons and the
  // per-occurrence overrides alike — or the calendar would keep drawing
  // entries for a student that no longer exists.
  const owned = await eventsCol(req.uid).where('studentId', '==', req.params.id).get();
  const batch = db.batch();
  for (const doc of owned.docs) batch.delete(doc.ref);
  batch.delete(ref);
  await batch.commit();

  res.status(204).end();
});

export default router;
