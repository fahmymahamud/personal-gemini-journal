export const PAYMENT_STATUSES = ['paid', 'unpaid', 'overdue'];

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
 * order. Falls back to the deprecated single `lessonDay` so a record written
 * before the array existed still lands on the calendar.
 */
export function lessonDaysOf(student = {}) {
  const raw = Array.isArray(student.lessonDays) ? student.lessonDays : [student.lessonDay];
  const found = new Set();
  for (const value of raw) {
    const short = toShortDay(value);
    if (short) found.add(short);
  }
  return LESSON_DAYS.filter((day) => found.has(day));
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
  // Accepts the array, or the deprecated single value, and always emits the
  // array — so a PATCH from an old client still upgrades the record.
  if (!partial || has('lessonDays') || has('lessonDay')) {
    const raw = has('lessonDays') ? input.lessonDays : input.lessonDay;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const found = new Set();
    for (const value of list) {
      const short = toShortDay(value);
      if (!short) throw new ValidationError(`lessonDays must contain only: ${LESSON_DAYS.join(', ')}`);
      found.add(short);
    }
    out.lessonDays = LESSON_DAYS.filter((day) => found.has(day));
  }
  set('lessonTime', () => time24(input.lessonTime, 'lessonTime'));
  set('location', () => str(input.location, 'location', { max: 200 }));
  set('feeAmount', () => money(input.feeAmount, 'feeAmount'));
  set('feeCurrency', () => (str(input.feeCurrency, 'feeCurrency', { max: 3 }) || 'SGD').toUpperCase());
  set('paymentStatus', () => oneOf(input.paymentStatus, 'paymentStatus', PAYMENT_STATUSES, { fallback: 'unpaid' }));
  set('lastPaidDate', () => isoDate(input.lastPaidDate, 'lastPaidDate'));
  set('telegramChatId', () => str(input.telegramChatId, 'telegramChatId', { max: 64 }) || null);
  set('notes', () => str(input.notes, 'notes', { max: 2000 }));

  if (partial && Object.keys(out).length === 0) {
    throw new ValidationError('No updatable fields supplied');
  }
  return out;
}

export { ValidationError };
