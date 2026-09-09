// pending_verification is set by the server when a parent declares payment
// over Telegram. It is listed here so that saving a student who is mid-review
// round-trips the status instead of silently dropping them back to unpaid.
export const PAYMENT_STATUSES = ['paid', 'unpaid', 'overdue', 'pending_verification'];

// Canonical stored form is the short code. Students created before lessons
// could span several days hold a single full-name `lessonDay` instead, so
// everything reads days through lessonDaysOf() rather than off the field.
export const LESSON_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Weekday number as Date.getDay() reports it, keyed by short code. */
export const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const LONG_TO_SHORT = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
  Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
};

/** 'Monday' | 'mon' | 'Mon' -> 'Mon'. Returns null for anything else. */
export function toShortDay(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const titled = raw[0].toUpperCase() + raw.slice(1).toLowerCase();
  if (LONG_TO_SHORT[titled]) return LONG_TO_SHORT[titled];
  return LESSON_DAYS.includes(titled) ? titled : null;
}

/**
 * The days a student has lessons on, always as short codes in Mon-to-Sun
 * order. Reads the `lessons` array first, then the deprecated `lessonDays`,
 * then the even older single `lessonDay`, so a record written at any point in
 * this schema's life still lands on the calendar.
 */
export function lessonDaysOf(student = {}) {
  const raw = Array.isArray(student.lessons) && student.lessons.length
    ? student.lessons.map((lesson) => lesson?.day)
    : (Array.isArray(student.lessonDays) ? student.lessonDays : [student.lessonDay]);
  const found = new Set();
  for (const value of raw) {
    const short = toShortDay(value);
    if (short) found.add(short);
  }
  return LESSON_DAYS.filter((day) => found.has(day));
}

/* ── lessons ── */

// One student, several slots: Monday at home and Wednesday on Zoom are two
// different lessons, each with its own venue — and a reminder can be pointed
// at one of them specifically.
export const MAX_LESSONS = 10;

/**
 * A student's lesson slots, in the order the coach arranged them.
 *
 * Records written before the array existed carry a single `lessonTime` and
 * `location` spread across `lessonDays`. Those are unfolded here into one
 * lesson per day, so every reader sees the same shape and no stored document
 * needs rewriting before it can be read.
 */
export function lessonsOf(student = {}) {
  if (Array.isArray(student.lessons) && student.lessons.length) {
    const out = [];
    student.lessons.forEach((raw, i) => {
      const day = toShortDay(raw?.day);
      if (!day) return;
      out.push({
        id: String(raw?.id || `les${i + 1}`),
        day,
        time: typeof raw.time === 'string' ? raw.time : '',
        location: typeof raw.location === 'string' ? raw.location : '',
      });
    });
    return out;
  }

  return lessonDaysOf(student).map((day, i) => ({
    id: `les${i + 1}`,
    day,
    time: student.lessonTime || '',
    location: student.location || '',
  }));
}

/** "Mon 09:00 — My home": how one lesson is named in a dropdown or a message. */
export function lessonLabel(lesson) {
  if (!lesson) return '';
  const when = [lesson.day, lesson.time].filter(Boolean).join(' ');
  return lesson.location ? `${when} — ${lesson.location}` : when;
}

/* ── auto reminders ── */

export const REMINDER_TYPES = ['payment', 'lesson'];
export const MAX_AUTO_REMINDERS = 2;

// Reminders repeat weekly, so one carries a weekday name rather than a date.
// Stored in full ('Monday') because that is what the scheduler compares against
// Intl's `weekday: 'long'` output.
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const SHORT_TO_LONG = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};

/** 'mon' | 'Mon' | 'Monday' -> 'Monday'. Returns null for anything else. */
export function toLongDay(value) {
  const short = toShortDay(value);
  return short ? SHORT_TO_LONG[short] : null;
}

const DEFAULT_COUNTRY_CODE = '65'; // Singapore

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// Canonical phone form is E.164 with a leading '+'. wa.me links strip the '+'.
// A bare 8-digit local number is assumed Singaporean, which is the whole user base.
export function toE164(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) return `+${digits}`;
  if (digits.length === 8) return `+${DEFAULT_COUNTRY_CODE}${digits}`;
  return `+${digits}`;
}

export function str(value, field, { max = 500, required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return '';
  }
  const out = String(value).trim();
  if (required && !out) throw new ValidationError(`${field} is required`);
  if (out.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer`);
  return out;
}

export function oneOf(value, field, allowed, { fallback = '' } = {}) {
  const out = str(value, field);
  if (!out) return fallback;
  const match = allowed.find((a) => a.toLowerCase() === out.toLowerCase());
  if (!match) throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  return match;
}

export function time24(value, field) {
  const out = str(value, field, { max: 5 });
  if (!out) return '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out)) {
    throw new ValidationError(`${field} must be in 24-hour HH:MM format`);
  }
  return out;
}

export function isoDate(value, field) {
  const out = str(value, field, { max: 10 });
  if (!out) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out) || Number.isNaN(Date.parse(out))) {
    throw new ValidationError(`${field} must be a valid YYYY-MM-DD date`);
  }
  return out;
}

function money(value, field) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new ValidationError(`${field} must be a number of 0 or more`);
  }
  return Math.round(num * 100) / 100;
}

/**
 * Validates the lesson list a client sent.
 *
 * Order is the coach's, and it is kept: the rows are labelled "Lesson 1",
 * "Lesson 2" on screen, and sorting them into weekday order behind the coach's
 * back would renumber rows they had just arranged.
 */
export function normalizeLessons(value, field = 'lessons') {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
  if (value.length > MAX_LESSONS) {
    throw new ValidationError(`${field} allows at most ${MAX_LESSONS} lessons`);
  }

  const seen = new Set();
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new ValidationError(`${field}[${i}] must be an object`);

    const id = str(raw.id, `${field}[${i}].id`, { max: 32 }) || `les${i + 1}`;
    if (seen.has(id)) throw new ValidationError(`${field} has two lessons with id "${id}"`);
    seen.add(id);

    const day = toShortDay(raw.day);
    if (!day) throw new ValidationError(`${field}[${i}].day must be one of: ${LESSON_DAYS.join(', ')}`);

    return {
      id,
      day,
      // A slot the coach has not pinned to an hour yet is allowed: it still
      // belongs on the calendar as that day's lesson.
      time: time24(raw.time, `${field}[${i}].time`),
      location: str(raw.location, `${field}[${i}].location`, { max: 200 }),
    };
  });
}

/**
 * The lessons implied by a body that still speaks the old language — a set of
 * days, one time, one venue. The Add Client dialog is the live caller.
 */
function lessonsFromLegacyInput(input) {
  const raw = Object.prototype.hasOwnProperty.call(input, 'lessonDays')
    ? input.lessonDays : input.lessonDay;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);

  const found = new Set();
  for (const value of list) {
    const short = toShortDay(value);
    if (!short) throw new ValidationError(`lessonDays must contain only: ${LESSON_DAYS.join(', ')}`);
    found.add(short);
  }

  return LESSON_DAYS.filter((day) => found.has(day)).map((day, i) => ({
    id: `les${i + 1}`,
    day,
    time: input.lessonTime ?? '',
    location: input.location ?? '',
  }));
}

/**
 * Validates the reminder list a client sent.
 *
 * `lastSent` and `lastError` are deliberately NOT read from the input. They are
 * the scheduler's own record of what happened, and a client that round-trips a
 * student it fetched five minutes ago would otherwise silently roll them back —
 * re-arming a reminder that already fired. students.js merges the stored values
 * back in by id after this runs.
 */
export function normalizeAutoReminders(value, field = 'autoReminders') {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
  if (value.length > MAX_AUTO_REMINDERS) {
    throw new ValidationError(`${field} allows at most ${MAX_AUTO_REMINDERS} reminders`);
  }

  const seen = new Set();
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new ValidationError(`${field}[${i}] must be an object`);

    const id = str(raw.id, `${field}[${i}].id`, { max: 32 }) || `rem${i + 1}`;
    if (seen.has(id)) throw new ValidationError(`${field} has two reminders with id "${id}"`);
    seen.add(id);

    const day = toLongDay(raw.day);
    if (!day) throw new ValidationError(`${field}[${i}].day must be one of: ${DAY_NAMES.join(', ')}`);

    const time = time24(raw.time, `${field}[${i}].time`);
    if (!time) throw new ValidationError(`${field}[${i}].time is required`);

    const type = oneOf(raw.type, `${field}[${i}].type`, REMINDER_TYPES, { fallback: 'payment' });

    // Which lesson this reminder is about. A payment chase is about the month
    // rather than any one slot, so it may leave this empty; a lesson reminder
    // that cannot say which lesson has nothing to remind anyone of.
    const lessonId = str(raw.lessonId, `${field}[${i}].lessonId`, { max: 32 }) || null;
    if (type === 'lesson' && !lessonId) {
      throw new ValidationError(
        `Reminder ${i + 1} is a lesson reminder — choose which lesson it is for`);
    }

    return {
      id,
      enabled: raw.enabled === true || raw.enabled === 'true',
      day,
      time,
      type,
      lessonId,
      // The coach's own words, drafted in AI Chat and pasted in. Empty means
      // "write one for me" — see scheduler.buildMessage.
      message: str(raw.message, `${field}[${i}].message`, { max: 2000 }),
      lastSent: null,
      lastError: null,
    };
  });
}

// Builds the full, defaulted document body from whatever the client sent.
// `partial: true` (PATCH) only returns the keys actually present in the input.
export function normalizeStudent(input = {}, { partial = false } = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const out = {};
  const set = (key, build, { requiredOnCreate = false } = {}) => {
    if (partial && !has(key)) return;
    out[key] = build(requiredOnCreate && !partial);
  };

  set('name', (required) => str(input.name, 'name', { max: 120, required }), { requiredOnCreate: true });
  set('studentPhone', (required) => {
    const phone = toE164(str(input.studentPhone, 'studentPhone', { max: 32, required }));
    if (required && !phone) throw new ValidationError('studentPhone is required');
    return phone || '';
  }, { requiredOnCreate: true });

  set('payerName', () => str(input.payerName, 'payerName', { max: 120 }));
  set('payerPhone', () => toE164(str(input.payerPhone, 'payerPhone', { max: 32 })) || '');
  // Accepts the lessons array, or the day/time/venue trio it replaced, and
  // always emits the array — so the Add Client dialog, which still asks for a
  // set of days and one time, writes a record in the current shape.
  if (!partial || has('lessons') || has('lessonDays') || has('lessonDay')) {
    out.lessons = has('lessons')
      ? normalizeLessons(input.lessons)
      : normalizeLessons(lessonsFromLegacyInput(input));
  }
  set('feeAmount', () => money(input.feeAmount, 'feeAmount'));
  set('feeCurrency', () => (str(input.feeCurrency, 'feeCurrency', { max: 3 }) || 'SGD').toUpperCase());
  set('paymentStatus', () => oneOf(input.paymentStatus, 'paymentStatus', PAYMENT_STATUSES, { fallback: 'unpaid' }));
  set('lastPaidDate', () => isoDate(input.lastPaidDate, 'lastPaidDate'));
  set('telegramChatId', () => str(input.telegramChatId, 'telegramChatId', { max: 64 }) || null);
  set('notes', () => str(input.notes, 'notes', { max: 2000 }));
  set('autoReminders', () => normalizeAutoReminders(input.autoReminders));

  if (partial && Object.keys(out).length === 0) {
    throw new ValidationError('No updatable fields supplied');
  }
  return out;
}

export { ValidationError };
