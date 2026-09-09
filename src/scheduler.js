import { db } from './firebase.js';
import { sendTelegramMessage } from './telegram.js';
import { runChat } from './gemini.js';
import { lessonDaysOf } from './student-schema.js';

/* ═══════════════════ policy ═══════════════════ */

// Cloud Scheduler calls the sweep every 5 minutes, so a reminder is "due" for
// the 5 minutes following its nominal time. Keep the two numbers in step: a
// window shorter than the cron interval drops reminders whose minute falls
// between two runs; a longer one sends the same reminder on two runs.
const WINDOW_MINUTES = 5;

// A weekly reminder must not fire twice in the same week. Six days rather than
// seven leaves slack for a sweep that runs slightly early, without ever
// reaching back far enough to allow a second send in one week.
const RESEND_GUARD_DAYS = 6;

// Hard ceiling per sweep. The real protection against a runaway loop is not the
// send count but the fact that lastSent is written before the next candidate is
// considered; this is the backstop for the case where that write fails.
const MAX_SENDS_PER_RUN = 100;

const TZ = process.env.SCHEDULER_TZ || 'Asia/Singapore';

/* ═══════════════════ time ═══════════════════ */

// hourCycle h23 matters: with hour12:false some ICU builds report midnight as
// hour "24", which would put every 00:xx reminder 1440 minutes out.
const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** The weekday name and minutes-since-midnight at `date`, read in TZ. */
export function zoned(date) {
  const p = Object.fromEntries(PARTS.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/** Firestore Timestamp | ISO string | epoch ms -> epoch ms, or null. */
function toMillis(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Is this reminder due at `now`?
 *
 * The weekday is compared at the reminder's *nominal* moment rather than at
 * `now`, so a 23:58 Monday reminder still matches on the sweep that runs at
 * 00:01 on Tuesday. Comparing against today's weekday would silently drop
 * every reminder set in the last few minutes of a day.
 */
export function isDue(reminder, now) {
  if (!reminder?.enabled) return false;

  const at = toMinutes(reminder.time);
  if (at === null) return false;

  const here = zoned(now);
  const elapsed = (here.minutes - at + 1440) % 1440;
  if (elapsed >= WINDOW_MINUTES) return false;

  const nominal = new Date(now.getTime() - elapsed * 60_000);
  return zoned(nominal).day === reminder.day;
}

/** True while the weekly guard still covers this reminder. */
export function sentRecently(reminder, now) {
  const last = toMillis(reminder?.lastSent);
  return last !== null && now.getTime() - last < RESEND_GUARD_DAYS * 86_400_000;
}

/* ═══════════════════ message text ═══════════════════ */

const SIGNATURE = '— sent by RemindClient';

const money = (s) => `${s.feeCurrency || 'SGD'} ${Number(s.feeAmount || 0).toFixed(2)}`;
const addressee = (s) => s.payerName || s.name || 'there';

export function paymentTemplate(s) {
  return `Hi ${addressee(s)}, gentle reminder that ${s.name}'s fee of `
    + `${money(s)} is due. Thank you! 🙏 ${SIGNATURE}`;
}

export function lessonTemplate(s) {
  const when = [lessonDaysOf(s).join('/'), s.lessonTime].filter(Boolean).join(' ') || 'soon';
  return `Hi ${addressee(s)}, reminder that ${s.name} has a lesson tomorrow `
    + `(${when}). See you there! 📚 ${SIGNATURE}`;
}

/**
 * The text to send for one reminder.
 *
 * Payment reminders are drafted by Gemini so they read like the coach wrote
 * them; every failure path — no key, quota spent, empty reply — falls back to
 * the template rather than skipping the send, because a slightly plainer
 * reminder that arrives beats a perfect one that does not. Lesson reminders are
 * template-only: they carry no judgement, only a time.
 */
export async function buildMessage(student, reminder, { coachName = null } = {}) {
  if (reminder.type !== 'payment') return { text: lessonTemplate(student), source: 'template' };

  try {
    const reply = await runChat({
      history: [],
      student,
      coachName,
      message: 'Draft a short, polite payment reminder for this student, addressed to whoever '
        + 'pays. State the amount owing. Two sentences at most. Reply with the message text '
        + 'only — no greeting line of your own, no sign-off, no quotation marks.',
    });
    const text = String(reply || '').trim();
    if (!text) throw new Error('empty draft');
    return { text: `${text} ${SIGNATURE}`, source: 'gemini' };
  } catch (err) {
    console.warn(`scheduler: Gemini draft failed for ${student.name}, using template — ${err.message}`);
    return { text: paymentTemplate(student), source: 'template' };
  }
}

/* ═══════════════════ the sweep ═══════════════════ */

/**
 * Sends the reminders that are due on one student document.
 *
 * All of a student's outcomes are folded into a single write. Writing per
 * reminder would let the second send of a pair overwrite the first's lastSent,
 * which is exactly the bookkeeping that stops a double-send next sweep.
 *
 * @param {'due'|'force'} mode 'force' ignores the clock and the weekly guard,
 *   which is what the test endpoint wants; it still requires enabled and a chat.
 */
async function processStudent(doc, { now, mode, coachName, budget }) {
  const student = doc.data();
  const reminders = Array.isArray(student.autoReminders) ? student.autoReminders : [];
  const out = { sent: 0, failed: 0, skipped: 0, results: [] };
  if (!reminders.length) return out;

  const next = reminders.map((r) => ({ ...r }));
  let touched = false;

  for (const reminder of next) {
    const note = (status, detail) => out.results.push({
      studentId: doc.id, reminderId: reminder.id, type: reminder.type, status, detail,
    });

    if (!reminder.enabled) { out.skipped++; note('skipped', 'disabled'); continue; }
    if (mode === 'due') {
      if (!isDue(reminder, now)) { out.skipped++; continue; }
      if (sentRecently(reminder, now)) { out.skipped++; note('skipped', 'already sent this week'); continue; }
    }
    if (!student.telegramChatId) { out.skipped++; note('skipped', 'no Telegram link'); continue; }
    if (budget.left <= 0) { out.skipped++; note('skipped', 'send cap reached'); continue; }

    budget.left--;
    const { text, source } = await buildMessage(student, reminder, { coachName });
    const result = await sendTelegramMessage(student.telegramChatId, text);
    touched = true;

    if (result.ok) {
      reminder.lastSent = new Date(now).toISOString();
      reminder.lastError = null;
      out.sent++;
      note('sent', source);
    } else {
      // lastSent is deliberately left alone on failure, so the next sweep
      // inside the window retries rather than treating this as done.
      reminder.lastError = `${new Date(now).toISOString()}: ${result.description}`;
      out.failed++;
      note('failed', result.description);
    }
  }

  if (touched) await doc.ref.update({ autoReminders: next });
  return out;
}

const merge = (into, from) => {
  into.sent += from.sent;
  into.failed += from.failed;
  into.skipped += from.skipped;
  into.results.push(...from.results);
};

/**
 * Every coach's students, in one pass.
 *
 * A collection-group read of every student is the honest shape here: the due
 * set is decided by fields inside an array of objects, which Firestore cannot
 * index or filter on. At this scale that is a handful of documents per sweep;
 * if the roster ever grows past a few thousand, the fix is a flat
 * `dueReminders` collection keyed by weekday, not a cleverer query.
 */
export async function checkDueReminders({ now = new Date() } = {}) {
  const snap = await db.collectionGroup('students').get();
  const budget = { left: MAX_SENDS_PER_RUN };
  const totals = { checked: snap.size, sent: 0, failed: 0, skipped: 0, results: [] };

  for (const doc of snap.docs) {
    merge(totals, await processStudent(doc, { now, mode: 'due', coachName: null, budget }));
  }

  const { results, ...counts } = totals;
  console.log(`scheduler: ${JSON.stringify(counts)}`);
  return totals;
}

/** One student, on demand, ignoring the clock — the Test Send button. */
export async function testStudentReminders(uid, studentId, { coachName = null } = {}) {
  const ref = db.collection('users').doc(uid).collection('students').doc(studentId);
  const doc = await ref.get();
  if (!doc.exists) {
    const err = new Error('Student not found');
    err.status = 404;
    throw err;
  }

  const budget = { left: MAX_SENDS_PER_RUN };
  const out = await processStudent(doc, { now: new Date(), mode: 'force', coachName, budget });
  return { checked: 1, ...out };
}

export { WINDOW_MINUTES, RESEND_GUARD_DAYS, MAX_SENDS_PER_RUN, TZ };
