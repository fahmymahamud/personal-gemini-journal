import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { eventsCol, studentsCol } from '../firebase.js';
import { normalizeEvent, normalizeOccurrence, occurrenceId } from '../event-schema.js';

const router = Router();

function serialize(doc) {
  const data = doc.data();
  const asIso = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v ?? null);
  return { id: doc.id, ...data, createdAt: asIso(data.createdAt), updatedAt: asIso(data.updatedAt) };
}

// The whole set, oldest date first. Single-field ordering needs no composite
// index, and a coach's calendar is small enough that the client can hold it
// all and switch months without another round trip.
router.get('/', async (req, res) => {
  const snap = await eventsCol(req.uid).orderBy('date').get();
  res.json({ events: snap.docs.map(serialize) });
});

router.post('/', async (req, res) => {
  const event = normalizeEvent(req.body);

  // A lesson event names a student, so the student must be one of this
  // coach's own — the path scoping makes that check enough.
  if (event.type === 'lesson') {
    const student = await studentsCol(req.uid).doc(event.studentId).get();
    if (!student.exists) return res.status(400).json({ error: 'Student not found' });
    event.studentName = student.data().name || '';
  }

  const ref = await eventsCol(req.uid).add({
    ...event,
    userId: req.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  res.status(201).json({ event: serialize(await ref.get()) });
});

/**
 * Upsert one date's departure from a student's weekly slot. Addressed by a
 * deterministic id rather than added, so re-saving the same date corrects the
 * existing override instead of stacking a second one beside it.
 */
router.put('/occurrence', async (req, res) => {
  const occurrence = normalizeOccurrence(req.body);

  const student = await studentsCol(req.uid).doc(occurrence.studentId).get();
  if (!student.exists) return res.status(400).json({ error: 'Student not found' });
  occurrence.studentName = student.data().name || '';

  const ref = eventsCol(req.uid).doc(occurrenceId(occurrence.studentId, occurrence.date));
  await ref.set({
    ...occurrence,
    userId: req.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  res.json({ event: serialize(await ref.get()) });
});

// A full replace, not a merge: the edit form is pre-filled with everything and
// sends it all back, so validating the whole body keeps one code path.
router.patch('/:id', async (req, res) => {
  const ref = eventsCol(req.uid).doc(req.params.id);
  if (!(await ref.get()).exists) return res.status(404).json({ error: 'Event not found' });

  const event = normalizeEvent(req.body);
  if (event.type === 'lesson') {
    const student = await studentsCol(req.uid).doc(event.studentId).get();
    if (!student.exists) return res.status(400).json({ error: 'Student not found' });
    event.studentName = student.data().name || '';
  }

  // createdAt is untouched — the event is being corrected, not recreated.
  await ref.update({ ...event, updatedAt: FieldValue.serverTimestamp() });
  res.json({ event: serialize(await ref.get()) });
});

router.delete('/:id', async (req, res) => {
  const ref = eventsCol(req.uid).doc(req.params.id);
  if (!(await ref.get()).exists) return res.status(404).json({ error: 'Event not found' });
  await ref.delete();
  res.status(204).end();
});

export default router;
