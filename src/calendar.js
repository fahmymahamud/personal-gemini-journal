import crypto from 'node:crypto';
import { DAY_INDEX, lessonDaysOf } from './student-schema.js';

const WEEKS_AHEAD = 8;
const LESSON_MINUTES = 60;
const PRODID = '-//ShiftedTech//RemindClient//EN';

// Lessons are stored as a local day and wall-clock time. Singapore has no DST
// and is a fixed UTC+8, so converting to UTC once here is exact and avoids
// shipping a VTIMEZONE block that calendar clients parse inconsistently.
const TZ_OFFSET_MINUTES = Number(process.env.CALENDAR_UTC_OFFSET_MINUTES ?? 480);

const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/* ── token ─────────────────────────────────────────────────────────────── */

function secret() {
  const value = process.env.CALENDAR_SECRET;
  if (!value) {
    const err = new Error('CALENDAR_SECRET is not set');
    err.status = 503;
    err.expose = true;
    throw err;
  }
  return value;
}

const sign = (uid) => crypto.createHmac('sha256', secret()).update(uid).digest('hex').slice(0, 32);

/**
 * Stable per-coach feed token. The uid travels in the token because a bare
 * hash cannot be reversed to say whose calendar was requested; the HMAC half
 * is what makes it unforgeable. Same uid + same secret always yields the same
 * token, so a subscribed URL keeps working until CALENDAR_SECRET is rotated.
 */
export const calendarToken = (uid) => `${uid}.${sign(uid)}`;

/** Returns the uid, or null. Compared in constant time to avoid leaking bytes. */
export function verifyCalendarToken(token) {
  if (typeof token !== 'string') return null;
  const cut = token.lastIndexOf('.');
  if (cut < 1) return null;

  const uid = token.slice(0, cut);
  const given = token.slice(cut + 1);
  const expected = sign(uid);

  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? uid : null;
}

/* ── ICS text helpers ──────────────────────────────────────────────────── */

// RFC 5545: backslash, semicolon and comma are escaped; newlines become \n.
const esc = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// RFC 5545 caps lines at 75 octets; continuations start with one space.
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // do not split a multi-byte character
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    out.push((start ? ' ' : '') + bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return out.join('\r\n');
}

/* ── event building ────────────────────────────────────────────────────── */

/**
 * First occurrence of one weekday at or after `from`, as a real UTC instant.
 * Returns null when the day or time is unusable.
 */
export function nextOccurrence(day, lessonTime, from = new Date()) {
  const dayIndex = DAY_INDEX[day];
  if (dayIndex === undefined) return null;

  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(lessonTime || '');
  if (!match) return null;
  const [, hh, mm] = match;

  // Work in the coach's local wall clock, then shift the whole thing to UTC.
  const localNow = new Date(from.getTime() + TZ_OFFSET_MINUTES * 60000);
  const localMidnight = Date.UTC(
    localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());

  let delta = (dayIndex - new Date(localMidnight).getUTCDay() + 7) % 7;
  let localStart = localMidnight + delta * 86400000 + (Number(hh) * 60 + Number(mm)) * 60000;

  // Today's slot already gone — take next week's.
  if (localStart <= localNow.getTime()) localStart += 7 * 86400000;

  return new Date(localStart - TZ_OFFSET_MINUTES * 60000);
}

function buildEvent(student, day, now) {
  const start = nextOccurrence(day, student.lessonTime, now);
  if (!start) return null;

  const end = new Date(start.getTime() + LESSON_MINUTES * 60000);
  const who = student.payerName ? `${student.name} (${student.payerName})` : student.name;
  const fee = student.feeAmount
    ? `${student.feeCurrency || 'SGD'} ${Number(student.feeAmount).toFixed(2)}`
    : 'not set';
  const status = student.paymentStatus || 'unpaid';

  const description = `Fee: ${fee} | Status: ${status}`
    + (student.location ? ` | Where: ${student.location}` : '')
    + (student.notes ? ` | Notes: ${student.notes}` : '');

  return [
    'BEGIN:VEVENT',
    `UID:${esc(student.id)}-${day}-${stamp(start).slice(0, 8)}@remindclient`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    // One event that repeats, bounded to the requested window. Emitting a
    // separate VEVENT per week AND an RRULE would duplicate every lesson.
    `RRULE:FREQ=WEEKLY;BYDAY=${ICS_DAYS[new Date(start.getTime() + TZ_OFFSET_MINUTES * 60000).getUTCDay()]};COUNT=${WEEKS_AHEAD}`,
    `SUMMARY:${esc(`Lesson — ${who}`)}`,
    ...(student.location ? [`LOCATION:${esc(student.location)}`] : []),
    `DESCRIPTION:${esc(description)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT1H',
    `DESCRIPTION:${esc(`${student.name} lesson in 1 hour — fee status: ${status}`)}`,
    'END:VALARM',
    'END:VEVENT',
  ];
}

/** Complete .ics document for one coach's students. */
export function buildCalendar(students, now = new Date()) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:RemindClient Lessons',
    'X-WR-TIMEZONE:Asia/Singapore',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];

  let scheduled = 0;
  for (const student of students) {
    // One VEVENT per weekday, each with its own BYDAY rule. A single event
    // with a multi-day BYDAY would also work, but separate ones let a client
    // move or cancel one weekly slot without touching the others.
    for (const day of lessonDaysOf(student)) {
      const event = buildEvent(student, day, now);
      if (event) { lines.push(...event); scheduled += 1; }
    }
  }
  lines.push('END:VCALENDAR');

  return { ics: lines.map(fold).join('\r\n') + '\r\n', scheduled };
}
