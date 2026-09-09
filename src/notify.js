import { db } from './firebase.js';
import { sendTelegramMessage } from './telegram.js';
import { adminUids } from './admin.js';

/*
 * Sign-up notifications, on two channels.
 *
 * Nothing in here is allowed to affect the person signing up. Every call is
 * wrapped, every failure is logged and swallowed, and the whole thing is fired
 * without being awaited by the request. A coach must never be kept waiting —
 * or worse, refused — because the owner's inbox is unreachable.
 *
 * Email deliberately adds no dependency. nodemailer would mean a package plus a
 * Gmail App Password in Secret Manager; Resend and SendGrid are both a single
 * authenticated POST, which fetch already does. If neither is configured the
 * notification is logged and the Telegram side still fires.
 */

const OWNER_EMAIL = process.env.SIGNUP_NOTIFY_EMAIL || 'fahmymahamud@gmail.com';

const fmtDate = (d) => new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: process.env.SCHEDULER_TZ || 'Asia/Singapore',
}).format(d);

/** The owner's own chat: an explicit env wins, else the admin's linked chat. */
async function ownerChatId() {
  if (process.env.ADMIN_TELEGRAM_CHAT_ID) return String(process.env.ADMIN_TELEGRAM_CHAT_ID);
  for (const uid of adminUids()) {
    const snap = await db.collection('users').doc(uid).get();
    const chat = snap.exists ? snap.data().telegramChatId : null;
    if (chat) return String(chat);
  }
  return null;
}

async function viaTelegram({ email, displayName, at }) {
  const chat = await ownerChatId();
  if (!chat) {
    console.log('signup: no owner Telegram chat linked — skipping the Telegram notice');
    return;
  }
  const who = displayName ? `${email} (${displayName})` : email;
  const out = await sendTelegramMessage(chat, `🆕 New sign-up: ${who} — Trial started ${fmtDate(at)}`);
  if (!out.ok) console.error(`signup: Telegram notice failed — ${out.description}`);
}

function emailBody({ email, displayName, at }) {
  return 'New user signed up for RemindClient.\n\n'
    + `Name: ${displayName || '(not given)'}\n`
    + `Email: ${email}\n`
    + `Date: ${fmtDate(at)}\n`
    + 'Plan: Trial (30 days)\n\n'
    + 'Log in to admin dashboard to view.';
}

/**
 * Resend if a key is present, otherwise a generic webhook (Apps Script bound to
 * a Sheet, Zapier, Make — anything that accepts a JSON POST), otherwise a log
 * line. The webhook fallback is what makes this useful before any email account
 * exists: the sign-up still lands somewhere the owner can read later.
 */
async function viaEmail(payload) {
  const subject = `New RemindClient Sign-up: ${payload.email}`;
  const text = emailBody(payload);

  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'RemindClient <onboarding@resend.dev>',
        to: [OWNER_EMAIL],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      console.error(`signup: Resend rejected the email (${res.status}) ${await res.text().catch(() => '')}`);
    }
    return;
  }

  if (process.env.SIGNUP_WEBHOOK_URL) {
    const res = await fetch(process.env.SIGNUP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: OWNER_EMAIL, subject, text, ...payload, at: payload.at.toISOString() }),
    });
    if (!res.ok) console.error(`signup: webhook rejected the notice (${res.status})`);
    return;
  }

  // Not an error: email is opt-in. The line below is the record until a key or
  // a webhook is configured, and Cloud Logging keeps it.
  console.log(`signup: [email not configured] ${subject} :: ${text.replace(/\n+/g, ' | ')}`);
}

/**
 * Fire-and-forget. Returns immediately; both channels run in the background and
 * cannot reject, so an unhandled rejection can never take the process down.
 */
export function notifySignup(user) {
  const payload = {
    email: user.email || '(no email)',
    displayName: user.name || null,
    at: new Date(),
  };

  Promise.allSettled([viaTelegram(payload), viaEmail(payload)]).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') console.error('signup: notification failed —', r.reason?.message || r.reason);
    }
  });
}
