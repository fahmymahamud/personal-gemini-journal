import crypto from 'node:crypto';
import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db, studentsCol, eventsCol } from '../firebase.js';
import { normalizeStudent } from '../student-schema.js';

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'RemindClientBot';

// Telegram's /start payload allows [A-Za-z0-9_-] up to 64 chars; base64url of
// 16 random bytes is 22, well inside that. Random and stored rather than
// derived, because the bot has to map a token back to one student and a hash
// cannot be reversed. Never accepted from the client — see student-schema.js,
// which deliberately does not list connectionToken as a writable field.
const newConnectionToken = () => crypto.randomBytes(16).toString('base64url');

const router = Router();

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

router.get('/:id', async (req, res) => {
  const doc = await studentsCol(req.uid).doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Student not found' });
  res.json({ student: serialize(doc) });
});

router.patch('/:id', async (req, res) => {
  const ref = studentsCol(req.uid).doc(req.params.id);
  if (!(await ref.get()).exists) return res.status(404).json({ error: 'Student not found' });

  const updates = normalizeStudent(req.body, { partial: true });
  // Writing the array retires the single-day field it replaced, so a record
  // never carries two sources of truth for the same thing.
  if (updates.lessonDays) updates.lessonDay = FieldValue.delete();
  await ref.update({ ...updates, updatedAt: FieldValue.serverTimestamp() });
  res.json({ student: serialize(await ref.get()) });
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
