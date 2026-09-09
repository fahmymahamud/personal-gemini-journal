import { str, oneOf, time24, isoDate, ValidationError } from './student-schema.js';

export const EVENT_TYPES = ['lesson', 'note'];
// Per-occurrence edits to a recurring lesson. They live in the same collection
// as standalone events but are never drawn on their own — they modify or
// suppress the weekly entry they point at.
export const OCCURRENCE_TYPES = ['override', 'cancelled'];
export const DURATIONS = [30, 60, 90, 120];

/**
 * Deterministic id, so one date can only ever carry one override for one
 * lesson — saving twice corrects the first rather than stacking on it.
 *
 * The lesson id is part of it because a student can hold two slots on the same
 * weekday, and an edit to one must not move the other. Overrides written
 * before lessons had ids keep their bare `studentId_date` id and are still
 * read: the client falls back to that key when no lesson-specific record
 * stands against a slot.
 */
export const occurrenceId = (studentId, lessonId, date) => (lessonId
  ? `${studentId}_${lessonId}_${date}`
  : `${studentId}_${date}`);

function duration(value) {
  if (value === null || value === undefined || value === '') return 60;
  const num = Number(value);
  if (!DURATIONS.includes(num)) {
    throw new ValidationError(`duration must be one of: ${DURATIONS.join(', ')} minutes`);
  }
  return num;
}

/**
 * One document shape covers both kinds of event, with the fields the other
 * kind does not use left empty. Keeping a single shape means the calendar can
 * read `date` and `time` off any event without first branching on its type.
 *
 * studentName is deliberately NOT taken from the client — the route resolves
 * it from studentId against the coach's own students, so a stored event can
 * never claim a name the coach does not actually have on their roster.
 */
export function normalizeEvent(input = {}) {
  const type = oneOf(input.type, 'type', EVENT_TYPES);
  if (!type) throw new ValidationError('type is required');

  const date = isoDate(input.date, 'date');
  if (!date) throw new ValidationError('date is required');

  if (type === 'lesson') {
    const studentId = str(input.studentId, 'studentId', { max: 128, required: true });
    return {
      type,
      studentId,
      studentName: '',                 // filled in by the route
      location: str(input.location, 'location', { max: 200 }),
      date,
      time: time24(input.time, 'time') || '09:00',
      duration: duration(input.duration),
      title: '',
      notes: str(input.notes, 'notes', { max: 2000 }),
    };
  }

  return {
    type,
    studentId: null,
    studentName: '',
    location: '',
    date,
    time: '',                          // a note is about the day, not a moment
    duration: 0,
    title: str(input.title, 'title', { max: 200, required: true }),
    notes: str(input.notes, 'notes', { max: 2000 }),
  };
}

/**
 * One date's departure from a student's weekly slot: a changed time or venue,
 * or the lesson simply not happening. studentName is filled by the route, as
 * it is for a standalone lesson.
 */
export function normalizeOccurrence(input = {}) {
  const type = oneOf(input.type, 'type', OCCURRENCE_TYPES);
  if (!type) throw new ValidationError('type is required');

  const date = isoDate(input.date, 'date');
  if (!date) throw new ValidationError('date is required');

  const studentId = str(input.studentId, 'studentId', { max: 128, required: true });
  // Which of the student's slots this is about. Optional: a client that has not
  // been told about lessons yet still gets the old one-slot-per-day behaviour.
  const lessonId = str(input.lessonId, 'lessonId', { max: 32 }) || null;

  // A cancellation carries no detail — it only says "not this week".
  if (type === 'cancelled') {
    return { type, studentId, lessonId, studentName: '', date, time: '', location: '', note: '' };
  }

  return {
    type,
    studentId,
    lessonId,
    studentName: '',
    date,
    time: time24(input.time, 'time'),
    location: str(input.location, 'location', { max: 200 }),
    note: str(input.note, 'note', { max: 2000 }),
  };
}
