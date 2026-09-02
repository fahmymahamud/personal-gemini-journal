import {
  auth, googleProvider, api,
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, signOut,
} from './firebase-client.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  students: [],
  selectedId: null,
  /** 'students' | 'calendar' — which view owns the main column. */
  view: 'calendar',
  /** First of the month currently drawn in the calendar grid. */
  calMonth: startOfMonth(new Date()),
  /** 'YYYY-MM-DD' of the open day panel, or null. */
  calDay: null,
  /** entryId of the pill that opened the day panel — pinned to the top. */
  calHighlight: null,
  /** One-off events the coach saved — lessons and notes, from Firestore. */
  events: [],
  /** True while the first student fetch is in flight — drives the skeletons. */
  loadingStudents: true,
  /** studentId (or '' for none) -> [{role, text, at}] — one thread per student. */
  threads: new Map(),
  usage: null,
  tab: 'overview',
  busy: false,
};

const threadKey = () => state.selectedId || '';
const currentThread = () => state.threads.get(threadKey()) || [];
const selectedStudent = () => state.students.find((s) => s.id === state.selectedId) || null;

/* ════════════════ auth (unchanged logic) ════════════════ */

const AUTH_MESSAGES = {
  'auth/invalid-credential': 'That email and password combination did not work.',
  'auth/invalid-email': 'That does not look like a valid email address.',
  'auth/user-not-found': 'No account with that email — try creating one.',
  'auth/wrong-password': 'Wrong password.',
  'auth/email-already-in-use': 'That email already has an account. Try signing in.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
  'auth/popup-blocked': 'Your browser blocked the popup. Allow popups and try again.',
  'auth/network-request-failed': 'Network problem — check your connection.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/operation-not-allowed': 'That sign-in method is not enabled for this project.',
  'auth/unauthorized-domain': 'This domain is not authorised in Firebase Auth.',
};
const authMessage = (err) => AUTH_MESSAGES[err?.code] || err?.message || 'Something went wrong.';

let signUpMode = false;

function showAuthError(message) {
  const el = $('#auth-error');
  el.textContent = message || '';
  el.hidden = !message;
}

$('#toggle-mode').addEventListener('click', () => {
  signUpMode = !signUpMode;
  $('[data-submit]').textContent = signUpMode ? 'Create account' : 'Sign in';
  $('[data-mode-text]').textContent = signUpMode ? 'Already have an account?' : 'New here?';
  $('#toggle-mode').textContent = signUpMode ? 'Sign in instead' : 'Create an account';
  $('#password').autocomplete = signUpMode ? 'new-password' : 'current-password';
  showAuthError('');
});

$('#email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showAuthError('');
  const submit = $('[data-submit]');
  submit.disabled = true;
  try {
    const fn = signUpMode ? createUserWithEmailAndPassword : signInWithEmailAndPassword;
    await fn(auth, $('#email').value.trim(), $('#password').value);
  } catch (err) {
    showAuthError(authMessage(err));
  } finally {
    submit.disabled = false;
  }
});

$('#google-btn').addEventListener('click', async () => {
  showAuthError('');
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    showAuthError(authMessage(err));
  }
});

$('#signout-btn').addEventListener('click', () => signOut(auth));

const initials = (name) => (name || '?')
  .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

onAuthStateChanged(auth, async (user) => {
  $('#auth-view').hidden = !!user;
  $('#app-view').hidden = !user;

  if (!user) {
    state.students = [];
    state.selectedId = null;
    state.threads.clear();
    state.events = [];
    state.usage = null;
    state.view = 'calendar';
    state.calDay = null;
    state.calMonth = startOfMonth(new Date());
    feedUrl = null;
    syncViewChrome();
    $('#student-search').value = '';
    renderStudents();
    renderSelection();
    return;
  }

  const label = user.displayName || user.email || '';
  $('#who').textContent = label;
  $('#avatar').textContent = initials(user.displayName || user.email);
  $('#password').value = '';
  // The calendar is the landing view: a coach opening the app wants today's
  // schedule, not an empty "select a student" panel. Painted first, with
  // skeletons, so the shell is on screen while the fetches are still in flight.
  state.calMonth = startOfMonth(new Date());
  state.loadingStudents = true;
  setView('calendar');

  await Promise.all([loadStudents(), loadEvents(), loadUsage(), revealAdminLink()]);
  renderCalendar();
});

// The server is the only authority on who is an admin; a 200 from the stats
// endpoint is the check. Any failure just leaves the link hidden.
async function revealAdminLink() {
  try {
    await api('/api/admin/stats');
    $('#admin-link').hidden = false;
  } catch {
    $('#admin-link').hidden = true;
  }
}

/* ════════════════ students ════════════════ */

async function loadStudents() {
  setStudentsState('loading');
  try {
    const { students } = await api('/api/students');
    state.students = students;
    state.studentsFailed = false;
    if (state.selectedId && !state.students.some((s) => s.id === state.selectedId)) {
      state.selectedId = null;
    }
    renderStudents();
    renderSelection();
    renderCalendar();
  } catch (err) {
    // The sidebar owns this failure — it shows a retry rather than a toast
    // the coach cannot act on.
    state.studentsFailed = true;
    setStudentsState('error');
    renderCalendar();   // otherwise the grid shimmers forever
    console.error('Could not load students', err);
  }
}

/** Exactly one of the sidebar's four bodies is on screen at any moment. */
function setStudentsState(mode) {
  state.loadingStudents = mode === 'loading';
  $('#students-skeleton').hidden = mode !== 'loading';
  $('#students-error').hidden = mode !== 'error';
  $('#student-list').hidden = mode !== 'list';
  $('#students-empty').hidden = mode !== 'empty';
}

$('#students-retry').addEventListener('click', loadStudents);

function renderStudents() {
  const query = $('#student-search').value.trim().toLowerCase();
  const matches = state.students.filter((s) =>
    !query || [s.name, s.payerName, s.notes].some((v) => (v || '').toLowerCase().includes(query)));

  const todayIndex = new Date().getDay();

  $('#student-list').replaceChildren(...matches.map((s) => {
    const li = document.createElement('li');
    li.className = 'student';
    li.classList.toggle('is-selected', s.id === state.selectedId);
    li.classList.toggle('is-today', lessonDaysOf(s).some((d) => CAL_DAY_INDEX[d] === todayIndex));
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const name = document.createElement('span');
    name.className = 'student-name';
    name.textContent = s.name;

    const payer = document.createElement('span');
    payer.className = 'student-payer';
    payer.textContent = s.payerName || 'Pays for themselves';

    li.append(name, payer, statusChip(s));

    // Searching is how a coach looks a student up, so a hit goes straight to
    // that student's Overview instead of merely toggling the row.
    const pick = () => (query ? focusStudent(s.id) : selectStudent(s.id));
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
    return li;
  }));

  setStudentsState(state.students.length ? 'list' : 'empty');
}

const STATUS_LABEL = { paid: 'Paid', unpaid: 'Due', overdue: 'Overdue' };

function statusChip(student, large = false) {
  const status = student.paymentStatus || 'unpaid';
  const chip = document.createElement('span');
  chip.className = `chip chip-${status}${large ? ' chip-lg' : ''}`;
  chip.textContent = STATUS_LABEL[status] || status;
  return chip;
}

$('#student-search').addEventListener('input', renderStudents);

// Sidebar click: toggles, so tapping the open student closes it again.
function selectStudent(id) {
  state.selectedId = state.selectedId === id ? null : id;
  state.view = 'students';
  if (isMobile()) setPane(state.selectedId ? 'detail' : 'students');
  syncViewChrome();
  renderStudents();
  renderSelection();
}

/**
 * Jump straight to one student's Overview — the calendar's way in, from a pill
 * in a date cell or a row in the day modal. Unlike selectStudent this never
 * toggles: arriving at a student you were already looking at should show that
 * student, not deselect them.
 */
function focusStudent(id) {
  state.selectedId = id;
  state.view = 'students';
  setTab('overview');
  if (isMobile()) setPane('detail');
  syncViewChrome();
  renderStudents();
  renderSelection();
}

const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

// Always two decimals — "S$240" reads like an estimate, "S$240.00" like a fee.
const CURRENCY_SYMBOL = { SGD: 'S$', USD: 'US$', MYR: 'RM', GBP: '£', EUR: '€', AUD: 'A$' };
function money(s) {
  if (!s.feeAmount) return '—';
  const code = (s.feeCurrency || 'SGD').toUpperCase();
  const symbol = CURRENCY_SYMBOL[code];
  const amount = Number(s.feeAmount).toFixed(2);
  return symbol ? `${symbol}${amount}` : `${code} ${amount}`;
}

/* ════════════════ selection / tabs ════════════════ */

function renderSelection() {
  const s = selectedStudent();
  const onCalendar = state.view === 'calendar';
  $('#calendar-pane').hidden = !onCalendar;
  $('#no-selection').hidden = onCalendar || !!s;
  $('#student-pane').hidden = onCalendar || !s;
  if (!s) return;
  renderOverview(s);
  renderChatHead(s);
  renderMessages();
  renderSuggestions();
}

function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('#tab-overview').hidden = tab !== 'overview';
  $('#tab-chat').hidden = tab !== 'chat';
  if (tab === 'chat') renderMessages();
}

$$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

function setPane(pane) {
  $('.layout').dataset.pane = pane;
  syncViewChrome();
}

// Two tabs only. Students covers both the list and a student's detail, so it
// stays lit while either is on screen and doubles as the way back to the list.
$$('.tabbar-btn').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.paneBtn === 'calendar') { setView('calendar'); return; }
  state.view = 'students';
  setPane('students');
  renderSelection();
}));

/* ════════════════ view switch (students ↔ calendar) ════════════════ */

function setView(view) {
  state.view = view;
  if (isMobile()) {
    setPane(view === 'calendar' ? 'calendar'
      : (state.selectedId ? 'detail' : 'students'));
  }
  syncViewChrome();
  renderSelection();
  if (view === 'calendar') renderCalendar();
}

// Keeps the navbar button and the mobile tab bar agreeing with the state
// without either of them owning it.
function syncViewChrome() {
  const onCalendar = state.view === 'calendar';
  const btn = $('#nav-calendar-btn');
  btn.classList.toggle('is-active', onCalendar);
  btn.setAttribute('aria-current', onCalendar ? 'page' : 'false');

  const pane = $('.layout').dataset.pane;
  for (const tab of $$('.tabbar-btn')) {
    const on = tab.dataset.paneBtn === 'calendar' ? pane === 'calendar' : pane !== 'calendar';
    tab.classList.toggle('is-active', on);
  }
}

$('#nav-calendar-btn').addEventListener('click', () => setView('calendar'));

/* ════════════════ overview ════════════════ */

function renderOverview(s) {
  $('#hero-name').textContent = s.name;
  $('#hero-payer').textContent = s.payerName ? `Paid by ${s.payerName}` : 'Pays for themselves';
  $('#hero-fee').textContent = money(s);

  const side = $('#hero-status');
  const status = s.paymentStatus || 'unpaid';
  side.className = `chip chip-lg chip-${status}`;
  side.textContent = STATUS_LABEL[status] || status;

  $('#info-due').textContent = s.paymentStatus === 'paid' ? 'Nothing due' : money(s);
  const days = lessonDaysOf(s);
  $('#info-lesson').textContent =
    [days.join(', '), s.lessonTime, s.location].filter(Boolean).join(' · ') || 'Not scheduled';
  $('#info-status').textContent = STATUS_LABEL[status] || status;
  $('#info-lastpaid').textContent = s.lastPaidDate || 'No record';

  renderConnect(s);

  $('#notes-block').hidden = !s.notes;
  $('#notes-body').textContent = s.notes || '';

  const link = $('#send-reminder-btn');
  const wa = waLink(s, defaultReminder(s));
  if (wa) { link.href = wa; link.removeAttribute('aria-disabled'); }
  else { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); }

  $('#mark-paid-btn').disabled = status === 'paid';
  $('#mark-paid-btn').textContent = status === 'paid' ? 'Already paid' : 'Mark as Paid';
}

/* ── connect telegram ── */

// studentId -> { copyUrl, deepLink }. Minted on demand and cached for the
// session so re-rendering the Overview does not re-hit the server.
const inviteLinks = new Map();

function renderConnect(s) {
  const linked = !!s.telegramChatId;
  $('#connect-linked').hidden = !linked;
  $('#connect-actions').hidden = linked;
  $('#connect-help').hidden = linked;
  if (linked) return;

  const open = $('#tg-open-btn');
  const cached = inviteLinks.get(s.id);
  if (cached) {
    open.href = cached.deepLink;
    open.removeAttribute('aria-disabled');
  } else {
    // No token yet: fetch one, then fill both buttons in.
    open.removeAttribute('href');
    open.setAttribute('aria-disabled', 'true');
    ensureInviteLink(s.id);
  }

  const copy = $('#tg-copy-btn');
  copy.classList.remove('is-copied');
  copy.textContent = '📋 Copy Link';
}

async function ensureInviteLink(studentId) {
  if (inviteLinks.has(studentId)) return inviteLinks.get(studentId);
  const data = await api(`/api/students/${studentId}/telegram/link`, { method: 'POST' });
  const link = { copyUrl: data.copyUrl, deepLink: data.deepLink };
  inviteLinks.set(studentId, link);
  // The coach may have switched students while this was in flight.
  if (state.selectedId === studentId) {
    const open = $('#tg-open-btn');
    open.href = link.deepLink;
    open.removeAttribute('aria-disabled');
  }
  return link;
}

let copyResetTimer;
$('#tg-copy-btn').addEventListener('click', async () => {
  const s = selectedStudent();
  if (!s) return;
  const btn = $('#tg-copy-btn');
  btn.disabled = true;
  try {
    const { copyUrl } = await ensureInviteLink(s.id);
    try {
      await navigator.clipboard.writeText(copyUrl);
    } catch {
      window.prompt('Copy this Telegram invite link:', copyUrl);
    }
    btn.classList.add('is-copied');
    btn.textContent = '✓ Copied!';
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.textContent = '📋 Copy Link';
    }, 2000);
  } catch (err) {
    toastError(err, "Couldn't create the invite link — try again");
  } finally {
    btn.disabled = false;
  }
});

$('#tg-disconnect-btn').addEventListener('click', async () => {
  const s = selectedStudent();
  if (!s || !confirm(`Disconnect ${s.name} from Telegram?`)) return;
  const btn = $('#tg-disconnect-btn');
  btn.disabled = true;
  try {
    await api(`/api/students/${s.id}/telegram`, { method: 'DELETE' });
    inviteLinks.delete(s.id);   // token was burned server-side
    toast(`${s.name} disconnected from Telegram`);
    await loadStudents();
  } catch (err) {
    toastError(err, "Couldn't disconnect — try again");
  } finally {
    btn.disabled = false;
  }
});

// Used for the Overview "Send Reminder" shortcut. Prefers the latest Gemini
// draft for this student so the button matches what the coach just refined.
function defaultReminder(s) {
  const thread = state.threads.get(s.id) || [];
  const lastModel = [...thread].reverse().find((t) => t.role === 'model');
  if (lastModel) return lastModel.text;
  const who = s.payerName || s.name;
  const amount = s.feeAmount ? ` of ${money(s)}` : '';
  return `Hi ${who}, just a gentle reminder about the outstanding lesson fee${amount} for ${s.name}. Thank you!`;
}

function waLink(student, text) {
  const phone = (student?.payerPhone || student?.studentPhone || '').replace(/\D/g, '');
  if (!phone) return null;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

$('#mark-paid-btn').addEventListener('click', async () => {
  const s = selectedStudent();
  if (!s) return;
  const btn = $('#mark-paid-btn');
  btn.disabled = true;
  try {
    await api(`/api/students/${s.id}`, {
      method: 'PATCH',
      body: { paymentStatus: 'paid', lastPaidDate: new Date().toISOString().slice(0, 10) },
    });
    toast('Marked as paid');
    await loadStudents();
  } catch (err) {
    toastError(err, "Couldn't update the payment — try again");
    btn.disabled = false;
  }
});

/* ════════════════ chat ════════════════ */

function renderChatHead(s) {
  $('#chat-subtitle').textContent = `Drafting for ${s.name}`;
  $('#new-thread-btn').hidden = currentThread().length === 0;
}

async function loadUsage() {
  try {
    const { usage } = await api('/api/chat/usage');
    state.usage = usage;
  } catch {
    state.usage = null;   // non-fatal: the bar just shows placeholders
  }
  renderQuota();
}

function renderQuota() {
  const u = state.usage;
  const text = $('#quota-text');
  const fill = $('#quota-fill');
  if (!u) {
    text.textContent = '— / 20 messages today';
    fill.style.width = '0%';
    return;
  }
  text.textContent = `${u.used} / ${u.limit} messages today`;
  const pct = u.limit ? Math.min(100, (u.used / u.limit) * 100) : 0;
  fill.style.width = `${pct}%`;
  fill.classList.toggle('is-low', pct >= 75 && pct < 100);
  fill.classList.toggle('is-full', pct >= 100);
}

const SUGGESTIONS = [
  'Draft a payment reminder',
  'Write a lesson reminder',
  'Make it more polite',
];

function renderSuggestions() {
  const items = currentThread().length ? [] : SUGGESTIONS;
  $('#suggestions').replaceChildren(...items.map((text) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggestion';
    btn.textContent = text;
    btn.addEventListener('click', () => send(text));
    return btn;
  }));
}

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function renderMessages() {
  const box = $('#messages');
  const thread = currentThread();

  if (!thread.length && !state.busy) {
    box.replaceChildren($('#chat-empty-tpl').content.cloneNode(true));
    return;
  }

  const student = selectedStudent();
  box.replaceChildren();

  thread.forEach((turn, i) => {
    const row = document.createElement('div');
    row.className = `msg msg-${turn.role}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = turn.text;
    row.append(bubble);

    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = clock(turn.at || Date.now());
    row.append(time);

    // Actions on the newest draft only — that is the one the coach will send.
    if (turn.role === 'model' && i === thread.length - 1) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'chip-action';
      copy.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      copy.append('Copy');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(turn.text); toast('Copied to clipboard'); }
        catch { toast('Could not copy — select the text manually', { error: true }); }
      });
      actions.append(copy);

      // Telegram only when the student actually has a chat id — a button that
      // cannot work is worse than no button.
      if (student?.telegramChatId) {
        const tg = document.createElement('button');
        tg.type = 'button';
        tg.className = 'chip-action chip-tg';
        tg.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M21.7 3.3 2.9 10.6c-.9.35-.9 1.6.02 1.9l4.6 1.44 1.77 5.3c.24.7 1.14.9 1.63.32l2.5-2.9 4.7 3.44c.6.44 1.46.12 1.62-.6l3.2-14.6c.17-.8-.6-1.47-1.35-1.15zM8.9 13.6l9.1-5.7-7.5 6.9-.3 3.1-1.3-4.3z"/></svg>';
        tg.append('Send via Telegram');
        tg.addEventListener('click', () => sendTelegram(tg, student.id, turn.text));
        actions.append(tg);
      }

      const link = waLink(student, turn.text);
      if (link) {
        const wa = document.createElement('a');
        wa.className = 'chip-action chip-wa';
        wa.href = link;
        wa.target = '_blank';
        wa.rel = 'noopener';
        wa.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.7 1-.9 1.2-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.5-.5c.1-.2.2-.3.3-.5 0-.2 0-.4 0-.5 0-.2-.7-1.6-.9-2.2-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5.1 4.4 1.9.8 2.6.9 3.5.7.6-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3z"/><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2z"/></svg>';
        wa.append('Send via WhatsApp');
        actions.append(wa);
      }
      row.append(actions);
    }
    box.append(row);
  });

  if (state.busy) {
    const row = document.createElement('div');
    row.className = 'msg msg-model';
    const bubble = document.createElement('div');
    bubble.className = 'bubble typing';
    bubble.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    row.append(bubble);
    box.append(row);
  }

  box.scrollTop = box.scrollHeight;
}

async function sendTelegram(btn, studentId, message) {
  if (btn.disabled) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await api('/api/telegram/send', { method: 'POST', body: { studentId, message } });
    btn.classList.add('is-sent');
    btn.textContent = 'Sent ✓';
    setTimeout(() => {
      btn.classList.remove('is-sent');
      btn.innerHTML = original;
      btn.disabled = false;
    }, 2000);
  } catch (err) {
    toastError(err, "Couldn't send — check the student's Telegram connection");
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

/* ════════════════ calendar view ════════════════ */

// Mirrors src/student-schema.js — the browser has no import path to it.
const LESSON_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CAL_DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const LONG_TO_SHORT = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
  Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
};

function toShortDay(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const titled = raw[0].toUpperCase() + raw.slice(1).toLowerCase();
  return LONG_TO_SHORT[titled] || (LESSON_DAYS.includes(titled) ? titled : null);
}

/**
 * The days a student teaches on, short codes in Mon-to-Sun order. Reads the
 * array, falling back to the deprecated single `lessonDay` so a record saved
 * before multi-day existed still lands on the calendar.
 */
function lessonDaysOf(student = {}) {
  const raw = Array.isArray(student.lessonDays) ? student.lessonDays : [student.lessonDay];
  const found = new Set();
  for (const value of raw) {
    const short = toShortDay(value);
    if (short) found.add(short);
  }
  return LESSON_DAYS.filter((day) => found.has(day));
}
// Google-Calendar-style cells: two event pills fit, the rest roll up into "+N more".
const MAX_PILLS = 2;

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const keyOf = (date) => dateKey(date.getFullYear(), date.getMonth(), date.getDate());

const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const DAY_FMT = new Intl.DateTimeFormat(undefined,
  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
// The modal header is already scoped by the month on screen behind it.
const DAY_TITLE_FMT = new Intl.DateTimeFormat(undefined,
  { weekday: 'long', day: 'numeric', month: 'long' });

// Earliest lesson first; a student with a day but no time sorts to the end.
const byLessonTime = (a, b) =>
  (a.lessonTime || '99:99').localeCompare(b.lessonTime || '99:99');

/**
 * Lessons are stored as recurring weekdays plus a wall-clock time, never as
 * dated rows — so a month's occurrences are derived by walking its days and
 * matching each day's weekday against every student's lessonDays. A student
 * teaching Mon/Wed/Fri lands on all three every week.
 */
function lessonsByDate(year, month) {
  const byDate = new Map();
  const scheduled = state.students
    .map((s) => ({ student: s, weekdays: new Set(lessonDaysOf(s).map((d) => CAL_DAY_INDEX[d])) }))
    .filter((entry) => entry.weekdays.size);
  if (!scheduled.length) return byDate;

  const lastDay = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= lastDay; day += 1) {
    const weekday = new Date(year, month, day).getDay();
    const hits = scheduled.filter((e) => e.weekdays.has(weekday)).map((e) => e.student);
    if (hits.length) byDate.set(dateKey(year, month, day), hits.sort(byLessonTime));
  }
  return byDate;
}

/* ── saved events and per-occurrence overrides ── */

// Overrides live in the same collection as standalone events but are never
// drawn on their own: they modify or suppress the weekly entry they point at.
const OCCURRENCE_TYPES = new Set(['override', 'cancelled']);
const occurrenceKey = (studentId, date) => `${studentId}_${date}`;

async function loadEvents() {
  try {
    const { events } = await api('/api/events');
    state.events = events;
  } catch {
    state.events = [];   // non-fatal: the recurring lessons still draw
  }
}

/** studentId_date -> the override or cancellation standing against it. */
function occurrenceMap() {
  const map = new Map();
  for (const event of state.events) {
    if (OCCURRENCE_TYPES.has(event.type)) map.set(occurrenceKey(event.studentId, event.date), event);
  }
  return map;
}

// Notes have no time, so they sort after the day's timed entries.
const byEventTime = (a, b) => (a.time || '99:99').localeCompare(b.time || '99:99');

function eventsByDate() {
  const map = new Map();
  for (const event of state.events) {
    if (OCCURRENCE_TYPES.has(event.type)) continue;   // not an entry of its own
    if (!map.has(event.date)) map.set(event.date, []);
    map.get(event.date).push(event);
  }
  for (const list of map.values()) list.sort(byEventTime);
  return map;
}

// A saved lesson takes its colour from the student's payment status as it
// stands now, not from whatever it was when the event was created.
const statusOf = (studentId) =>
  state.students.find((s) => s.id === studentId)?.paymentStatus || 'unpaid';

/**
 * One day's entries in display order: saved one-offs first, then the recurring
 * weekly lessons with any override for that exact date already folded in.
 * Both the grid cell and the day modal read this, so the two can never
 * disagree about what falls on a date, at what time, or whether it is off.
 */
function entriesFor(key, recurring, saved, occurrences) {
  const lessons = recurring.map((student) => {
    const standing = occurrences.get(occurrenceKey(student.id, key)) || null;
    const override = standing && standing.type === 'override' ? standing : null;
    return {
      kind: 'lesson',
      student,
      override,
      cancelled: !!standing && standing.type === 'cancelled',
      // The override wins field by field, so changing only the time keeps the
      // student's usual venue rather than blanking it.
      time: (override && override.time) || student.lessonTime || '',
      location: (override && override.location) || student.location || '',
      note: (override && override.note) || '',
    };
  });

  // Re-sorted here rather than upstream: an override can move a lesson to a
  // different hour, and the list should follow it.
  lessons.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

  return [
    ...saved.map((event) => ({ kind: 'event', event })),
    ...lessons,
  ];
}

/** Stable handle for one entry, used to highlight the one that was tapped. */
const entryId = (entry) =>
  (entry.kind === 'event' ? `event:${entry.event.id}` : `lesson:${entry.student.id}`);

// A month cell has room for a time and, at a push, a venue — the name would
// only ellipsise away. The day modal is where the detail lives.
function pillLabel(time, location) {
  return location ? `${time || '—'} · ${location}` : (time || '—');
}

function makePill(entry, key) {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'cal-pill';

  if (entry.kind === 'lesson') {
    const s = entry.student;
    pill.classList.add(`pill-${s.paymentStatus || 'unpaid'}`);
    const label = pillLabel(entry.time, entry.location);
    // The pencil says this date differs from the student's usual slot.
    pill.textContent = entry.override ? `✏️ ${label}` : label;
    pill.title = `${s.name} — ${label}${entry.override ? ' (edited)' : ''}`;
    pill.setAttribute('aria-label', `${s.name}, ${label}${entry.override ? ', edited' : ''}`);
  } else if (entry.event.type === 'note') {
    pill.classList.add('pill-note');
    pill.textContent = '📝 Note';
    pill.title = entry.event.title || 'Note';
    pill.setAttribute('aria-label', `Note: ${entry.event.title || ''}`);
  } else {
    const event = entry.event;
    // Same status colour as the recurring pills, set apart by the darker rim.
    pill.classList.add(`pill-${statusOf(event.studentId)}`, 'is-event');
    pill.textContent = pillLabel(event.time, event.location);
    pill.title = `${event.studentName} — ${pill.textContent}`;
    pill.setAttribute('aria-label', `${event.studentName}, ${pill.textContent}`);
  }

  // Every pill opens the day, with itself pulled to the top — tapping a lesson
  // shows what is on that day first, rather than jumping the coach somewhere
  // they may not have meant to go.
  pill.addEventListener('click', () => openDay(key, entryId(entry)));
  return pill;
}

function renderCalendar() {
  const year = state.calMonth.getFullYear();
  const month = state.calMonth.getMonth();

  $('#cal-title').textContent = MONTH_FMT.format(state.calMonth);

  // Nothing to plot at all — point at the one action that fixes that, rather
  // than drawing 35 empty boxes.
  const bare = !state.students.length && !state.events.length;
  $('#cal-skeleton').hidden = !state.loadingStudents;
  $('#cal-empty').hidden = state.loadingStudents || !bare;
  $('#cal-grid').hidden = state.loadingStudents || bare;
  if (state.loadingStudents || bare) return;

  const byDate = lessonsByDate(year, month);
  const eventMap = eventsByDate();
  const occurrences = occurrenceMap();
  const todayKey = keyOf(new Date());
  const lastDay = new Date(year, month + 1, 0).getDate();
  const lead = new Date(year, month, 1).getDay();   // Sun-first, matching the header
  // Floored at five rows: a 28-day February starting on a Sunday fits in four,
  // and the grid should not change height from one month to the next.
  const cellCount = Math.max(35, Math.ceil((lead + lastDay) / 7) * 7);

  const grid = $('#cal-grid');
  grid.replaceChildren();

  for (let i = 0; i < cellCount; i += 1) {
    const dayNum = i - lead + 1;

    // Leading and trailing cells belong to the neighbouring months. They hold
    // the grid's shape and nothing else.
    if (dayNum < 1 || dayNum > lastDay) {
      const filler = document.createElement('div');
      filler.className = 'cal-cell is-outside';
      filler.setAttribute('aria-hidden', 'true');
      grid.append(filler);
      continue;
    }

    const key = dateKey(year, month, dayNum);
    // A cancelled lesson is off the grid entirely; it stays visible in the day
    // modal, where it can be restored.
    const entries = entriesFor(key, byDate.get(key) || [], eventMap.get(key) || [], occurrences)
      .filter((entry) => !entry.cancelled);

    // A plain div, not a button: the pills inside are buttons of their own and
    // HTML forbids nesting them. The day's own click target is .cal-open, a
    // transparent layer sitting behind the cell's content.
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    cell.dataset.date = key;
    cell.classList.toggle('is-today', key === todayKey);
    cell.classList.toggle('is-selected', key === state.calDay);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'cal-open';
    open.setAttribute('aria-label', `${DAY_FMT.format(new Date(year, month, dayNum))} — `
      + (entries.length ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : 'nothing scheduled'));
    open.addEventListener('click', () => openDay(key));
    cell.append(open);

    const num = document.createElement('span');
    num.className = 'cal-date';
    num.textContent = String(dayNum);
    cell.append(num);

    const pills = document.createElement('span');
    pills.className = 'cal-events';
    for (const entry of entries.slice(0, MAX_PILLS)) pills.append(makePill(entry, key));
    cell.append(pills);

    if (entries.length > MAX_PILLS) {
      const more = document.createElement('span');
      more.className = 'cal-more';
      more.textContent = `+${entries.length - MAX_PILLS} more`;
      cell.append(more);
    }

    grid.append(cell);
  }
}

/* ── day detail modal ── */

const dayDialog = $('#day-dialog');

function openDay(key, highlight = null) {
  state.calDay = key;
  state.calHighlight = highlight;
  markSelectedCell();
  renderDayModal();
  dayDialog.showModal();
}

// Repaints the selection in place rather than rebuilding the grid, which would
// destroy the very element whose click handler is still running.
function markSelectedCell() {
  for (const cell of $$('#cal-grid .cal-cell')) {
    cell.classList.toggle('is-selected', cell.dataset.date === state.calDay);
  }
}

function renderDayModal() {
  const [year, month, day] = state.calDay.split('-').map(Number);
  const recurring = lessonsByDate(year, month - 1).get(state.calDay) || [];
  const saved = eventsByDate().get(state.calDay) || [];

  $('#day-title').textContent = DAY_TITLE_FMT.format(new Date(year, month - 1, day));

  let entries = entriesFor(state.calDay, recurring, saved, occurrenceMap());

  // The entry the coach tapped comes first, so what they pointed at is what
  // they see without scanning the list for it.
  const at = entries.findIndex((e) => entryId(e) === state.calHighlight);
  if (at > 0) entries = [entries[at], ...entries.slice(0, at), ...entries.slice(at + 1)];

  $('#day-empty').hidden = entries.length > 0;

  const list = $('#day-list');
  list.hidden = entries.length === 0;
  list.replaceChildren(...entries.map((entry) => {
    const row = entry.kind === 'event' ? savedEventRow(entry.event) : recurringLessonRow(entry);
    if (entryId(entry) === state.calHighlight) row.classList.add('is-highlighted');
    return row;
  }));
}

/** A one-off the coach added. Opens its own detail sheet for edit or delete. */
function savedEventRow(event) {
  const row = document.createElement('li');
  row.className = 'day-row is-event';

  const time = document.createElement('span');
  time.className = 'day-time';
  time.textContent = event.time || '—';

  const main = document.createElement('div');
  main.className = 'day-main';

  const name = document.createElement('span');
  name.className = 'day-name';
  name.textContent = event.type === 'lesson'
    ? `📚 ${event.studentName || 'Lesson'}`
    : `📝 ${event.title || 'Note'}`;

  const meta = document.createElement('span');
  meta.className = 'day-payer';
  meta.textContent = event.type === 'lesson'
    ? [event.location, event.duration ? `${event.duration} min` : ''].filter(Boolean).join(' · ')
    : (event.notes || '');

  main.append(name);
  if (meta.textContent) main.append(meta);

  const actions = document.createElement('div');
  actions.className = 'day-actions';
  const details = document.createElement('button');
  details.type = 'button';
  details.className = 'chip-action chip-view';
  details.textContent = 'Details';
  actions.append(details);

  row.addEventListener('click', () => openEventDetail(event.id));

  row.append(time, main, actions);
  return row;
}

/**
 * A weekly lesson, with this date's override already applied. Fee, status and
 * payer are deliberately absent — those belong to Overview; this row is about
 * the slot.
 */
function recurringLessonRow(entry) {
  const s = entry.student;
  const row = document.createElement('li');
  row.className = 'day-row';
  row.classList.toggle('is-cancelled', entry.cancelled);

  const time = document.createElement('span');
  time.className = 'day-time';
  time.textContent = entry.time || '—';

  const main = document.createElement('div');
  main.className = 'day-main';

  const name = document.createElement('span');
  name.className = 'day-name';
  name.textContent = s.name;
  main.append(name);

  const meta = [entry.location, entry.note].filter(Boolean).join(' · ');
  if (meta) {
    const where = document.createElement('span');
    where.className = 'day-payer';
    where.textContent = meta;
    main.append(where);
  }

  const side = document.createElement('div');
  side.className = 'day-side';
  if (entry.cancelled) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-cancelled';
    chip.textContent = 'Cancelled';
    side.append(chip);
  } else if (entry.override) {
    const badge = document.createElement('span');
    badge.className = 'edited-badge';
    badge.textContent = '✏️ edited';
    side.append(badge);
  }

  const actions = document.createElement('div');
  actions.className = 'day-actions';

  if (entry.cancelled) {
    // The only thing worth doing to a cancelled date is putting it back.
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'chip-action chip-view';
    restore.textContent = 'Restore';
    restore.addEventListener('click', (e) => {
      e.stopPropagation();
      restoreLesson(s.id);
    });
    actions.append(restore);
  } else {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'chip-action chip-icon';
    edit.title = 'Edit this lesson';
    edit.setAttribute('aria-label', `Edit this lesson for ${s.name}`);
    edit.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
    // Stop here, or the row's own handler would navigate out from under it.
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      openLessonModal(entry);
    });
    actions.append(edit);
  }

  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'chip-action chip-view';
  view.textContent = 'View Student';
  actions.append(view);

  // One handler on the row; View Student's click bubbles into it.
  row.addEventListener('click', () => {
    dayDialog.close();
    focusStudent(s.id);
  });

  row.append(time, main, side, actions);
  return row;
}

/* ── edit this lesson ── */

const lessonDialog = $('#lesson-dialog');
const lessonForm = $('#lesson-form');
let editingLesson = null;   // { studentId, date, name }

function showLessonError(message) {
  const el = $('#lesson-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function openLessonModal(entry) {
  const s = entry.student;
  const [year, month, day] = state.calDay.split('-').map(Number);
  const pretty = DAY_TITLE_FMT.format(new Date(year, month - 1, day));
  editingLesson = { studentId: s.id, date: state.calDay, name: s.name };

  lessonForm.reset();
  showLessonError('');

  $('#lesson-title').textContent = `Edit Lesson — ${s.name} · ${pretty}`;
  // The date is the occurrence being edited, so it is shown, not asked for.
  $('#lesson-date').value = pretty;
  $('#lesson-time').value = entry.time || '';
  $('#lesson-location').value = entry.location || '';
  $('#lesson-note').value = entry.note || '';
  lessonForm.elements.scope.value = 'single';

  lessonDialog.showModal();
}

$('[data-close-lesson]').addEventListener('click', () => lessonDialog.close());

lessonForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingLesson) return;
  showLessonError('');

  const data = Object.fromEntries(new FormData(lessonForm).entries());
  const save = $('#lesson-save');
  save.disabled = true;

  try {
    if (data.scope === 'future') {
      // Moves the weekly slot itself. Any override already standing on other
      // dates keeps its own time — those were deliberate exceptions.
      await api(`/api/students/${editingLesson.studentId}`, {
        method: 'PATCH',
        body: { lessonTime: data.time, location: data.location },
      });
      await loadStudents();
      toast('All future lessons updated');
    } else {
      await api('/api/events/occurrence', {
        method: 'PUT',
        body: {
          type: 'override',
          studentId: editingLesson.studentId,
          date: editingLesson.date,
          time: data.time,
          location: data.location,
          note: data.note,
        },
      });
      await loadEvents();
      toast('Lesson updated for this date');
    }
    lessonDialog.close();
    renderCalendar();
    if (state.calDay) renderDayModal();
  } catch (err) {
    showLessonError(err.message);
  } finally {
    save.disabled = false;
  }
});

$('#lesson-remove').addEventListener('click', async () => {
  if (!editingLesson) return;
  const [year, month, day] = editingLesson.date.split('-').map(Number);
  const pretty = DAY_TITLE_FMT.format(new Date(year, month - 1, day));
  if (!confirm(`Remove this lesson from ${pretty}? The student record stays unchanged.`)) return;

  const btn = $('#lesson-remove');
  btn.disabled = true;
  try {
    await api('/api/events/occurrence', {
      method: 'PUT',
      body: { type: 'cancelled', studentId: editingLesson.studentId, date: editingLesson.date },
    });
    await loadEvents();
    lessonDialog.close();
    renderCalendar();
    if (state.calDay) renderDayModal();
    toast('Lesson removed from this date');
  } catch (err) {
    showLessonError(err.message);
  } finally {
    btn.disabled = false;
  }
});

/** Deletes the cancellation, so the weekly lesson reappears on that date. */
async function restoreLesson(studentId) {
  try {
    await api(`/api/events/${occurrenceKey(studentId, state.calDay)}`, { method: 'DELETE' });
    await loadEvents();
    renderCalendar();
    renderDayModal();
    toast('Lesson restored');
  } catch (err) {
    toastError(err, "Couldn't restore the lesson — try again");
  }
}

/* ── event detail sheet ── */

const detailDialog = $('#event-detail-dialog');
let detailEventId = null;

const DETAIL_FIELDS = {
  lesson: [
    ['Time', (e) => e.time],
    ['Student', (e) => e.studentName],
    ['Location', (e) => e.location],
    ['Duration', (e) => (e.duration ? `${e.duration} min` : '')],
    ['Notes', (e) => e.notes],
  ],
  note: [
    ['Title', (e) => e.title],
    ['Note', (e) => e.notes],
  ],
};

function openEventDetail(id) {
  const event = state.events.find((e) => e.id === id);
  if (!event) return;
  detailEventId = id;

  $('#detail-title').textContent = event.type === 'lesson' ? '📚 Lesson' : '📝 Note';

  const body = $('#detail-body');
  body.replaceChildren();
  for (const [label, read] of DETAIL_FIELDS[event.type]) {
    const value = read(event);
    if (!value) continue;                 // an empty field is noise, not data
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    body.append(dt, dd);
  }

  detailDialog.showModal();
}

$('#detail-close').addEventListener('click', () => detailDialog.close());
detailDialog.addEventListener('click', (e) => {
  if (e.target === detailDialog) detailDialog.close();
});

$('#detail-edit').addEventListener('click', () => {
  const event = state.events.find((e) => e.id === detailEventId);
  if (!event) return;
  detailDialog.close();
  openEventModal(event);
});

$('#detail-delete').addEventListener('click', () => deleteEvent(detailEventId));

async function deleteEvent(id) {
  if (!confirm('Delete this event?')) return;
  try {
    await api(`/api/events/${id}`, { method: 'DELETE' });
    await loadEvents();
    detailDialog.close();
    renderCalendar();
    if (state.calDay) renderDayModal();
    toast('Event deleted');
  } catch (err) {
    toastError(err, "Couldn't delete the event — try again");
  }
}

$('#day-close').addEventListener('click', () => dayDialog.close());

// Clicking the backdrop. The dialog itself carries no padding, so any click
// that lands on the element rather than on .day-wrap came from outside the box.
dayDialog.addEventListener('click', (e) => {
  if (e.target === dayDialog) dayDialog.close();
});

// Covers every close path at once — the X, the backdrop and Escape.
dayDialog.addEventListener('close', () => {
  state.calDay = null;
  state.calHighlight = null;
  markSelectedCell();
});

/* ── add event ── */

const eventDialog = $('#event-dialog');
const eventForm = $('#event-form');
let eventType = 'lesson';

function showEventError(message) {
  const el = $('#event-error');
  el.textContent = message || '';
  el.hidden = !message;
}

// Neither branch's inputs carry `required`: the hidden half of the form would
// block submission on a field the coach cannot even see. Validation is done by
// hand below instead.
function setEventType(type) {
  eventType = type;
  for (const b of $$('.type-btn')) {
    const on = b.dataset.type === type;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  }
  $('#event-lesson-fields').hidden = type !== 'lesson';
  $('#event-note-fields').hidden = type !== 'note';
  showEventError('');
}

$$('.type-btn').forEach((b) => b.addEventListener('click', () => setEventType(b.dataset.type)));

function fillStudentOptions() {
  const select = $('#event-student');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select student';
  select.replaceChildren(placeholder, ...state.students.map((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    return opt;
  }));
}

// Opens on top of the day modal — dialogs stack in the top layer, so the day
// behind stays visible and is still there if the coach cancels.
// Passing an event switches the form to update mode.
let editingEventId = null;
let eventDate = null;

function openEventModal(existing = null) {
  eventDate = existing ? existing.date : state.calDay;
  if (!eventDate) return;
  editingEventId = existing?.id || null;

  const [year, month, day] = eventDate.split('-').map(Number);
  const pretty = DAY_TITLE_FMT.format(new Date(year, month - 1, day));

  eventForm.reset();
  fillStudentOptions();
  setEventType(existing?.type || 'lesson');
  showEventError('');

  $('#event-title').textContent = `${existing ? 'Edit' : 'Add'} Event — ${pretty}`;
  // The date is fixed by the entry being edited, or by the cell that was
  // clicked, so it is shown rather than asked for.
  $('#event-date-lesson').value = pretty;
  $('#event-date-note').value = pretty;

  if (existing) {
    if (existing.type === 'lesson') {
      eventForm.elements.studentId.value = existing.studentId || '';
      eventForm.elements.location.value = existing.location || '';
      eventForm.elements.time.value = existing.time || '09:00';
      eventForm.elements.duration.value = String(existing.duration || 60);
      eventForm.elements.notes.value = existing.notes || '';
    } else {
      eventForm.elements.title.value = existing.title || '';
      eventForm.elements.noteBody.value = existing.notes || '';
    }
  }

  $('#event-save').textContent = existing ? 'Save changes' : 'Save';
  eventDialog.showModal();
}

$('#day-add').addEventListener('click', () => openEventModal());
$('#day-add-empty').addEventListener('click', () => openEventModal());
$('[data-close-event]').addEventListener('click', () => eventDialog.close());

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showEventError('');

  const data = Object.fromEntries(new FormData(eventForm).entries());
  const body = eventType === 'lesson'
    ? {
      type: 'lesson',
      date: eventDate,
      studentId: data.studentId,
      location: data.location,
      time: data.time,
      duration: data.duration,
      notes: data.notes,
    }
    : { type: 'note', date: eventDate, title: data.title, notes: data.noteBody };

  if (eventType === 'lesson' && !body.studentId) {
    showEventError('Pick a student for this lesson.');
    return;
  }
  if (eventType === 'note' && !body.title.trim()) {
    showEventError('Give this note a title.');
    return;
  }

  const save = $('#event-save');
  save.disabled = true;
  try {
    if (editingEventId) await api(`/api/events/${editingEventId}`, { method: 'PATCH', body });
    else await api('/api/events', { method: 'POST', body });
    await loadEvents();
    eventDialog.close();
    dayDialog.close();     // its close handler clears the day selection
    renderCalendar();
    toast(editingEventId ? 'Event updated' : 'Event saved');
  } catch (err) {
    showEventError(err.message);
  } finally {
    save.disabled = false;
  }
});

function shiftMonth(delta) {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + delta, 1);
  state.calDay = null;   // the open day belonged to the month we just left
  renderCalendar();
}

$('#cal-prev').addEventListener('click', () => shiftMonth(-1));
$('#cal-next').addEventListener('click', () => shiftMonth(1));

/* ════════════════ calendar subscription ════════════════ */

const subDialog = $('#subscribe-dialog');
// The feed token is stable per coach, so one fetch covers the whole session.
let feedUrl = null;

$('#calendar-btn').addEventListener('click', async () => {
  const btn = $('#calendar-btn');
  btn.disabled = true;
  try {
    if (!feedUrl) ({ url: feedUrl } = await api('/api/calendar/token'));

    // webcal:// is what makes iOS hand the feed to Calendar rather than let
    // Safari render it as text. Only the scheme differs from the https URL.
    $('#sub-ios').href = feedUrl.replace(/^https:\/\//, 'webcal://');
    $('#sub-android').href =
      `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedUrl)}`;

    resetSubCopy();
    subDialog.showModal();
  } catch (err) {
    toastError(err, "Couldn't generate calendar link — try again");
  } finally {
    btn.disabled = false;
  }
});

$('[data-close-sub]').addEventListener('click', () => subDialog.close());

let subCopyTimer;
function resetSubCopy() {
  clearTimeout(subCopyTimer);
  const btn = $('#sub-copy');
  btn.classList.remove('is-copied');
  btn.textContent = '📋 Copy Link (advanced)';
}

$('#sub-copy').addEventListener('click', async () => {
  if (!feedUrl) return;
  try {
    await navigator.clipboard.writeText(feedUrl);
  } catch {
    // Clipboard is blocked outside a secure context or without permission —
    // show the URL so the coach can still copy it by hand.
    window.prompt('Copy this calendar feed URL:', feedUrl);
    return;
  }
  const btn = $('#sub-copy');
  btn.classList.add('is-copied');
  btn.textContent = '✓ Copied!';
  clearTimeout(subCopyTimer);
  subCopyTimer = setTimeout(resetSubCopy, 2000);
});

/* ════════════════ install to home screen (PWA) ════════════════ */

// Chrome fires this only when the app actually qualifies to be installed, so
// the button stays hidden everywhere it would not work — iOS Safari included,
// which is what the hint line underneath is for.
let deferredPrompt;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  for (const btn of $$('.install-btn')) btn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  for (const btn of $$('.install-btn')) btn.hidden = true;
  deferredPrompt = null;
});

$('#install-btn').addEventListener('click', () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  // The prompt is single-use: Chrome will not accept the same event twice.
  deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
});

// beforeinstallprompt needs a registered service worker with a fetch handler.
// Failure here costs only the install button; nothing else depends on it.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

async function send(text) {
  const message = text.trim();
  if (!message || state.busy) return;

  const key = threadKey();
  const history = currentThread();
  const studentId = state.selectedId;

  if (state.tab !== 'chat') setTab('chat');

  state.threads.set(key, [...history, { role: 'user', text: message, at: Date.now() }]);
  state.busy = true;
  $('#chat-input').value = '';
  autoGrow();
  $('#chat-send').disabled = true;
  renderMessages();
  renderSuggestions();

  try {
    // Send only what the API expects; `at` is client-side presentation only.
    const data = await api('/api/chat', {
      method: 'POST',
      body: { studentId, history: history.map(({ role, text }) => ({ role, text })), message },
    });
    state.threads.set(key, [
      ...state.threads.get(key),
      { role: 'model', text: data.reply, at: Date.now() },
    ]);
    if (data.usage) { state.usage = data.usage; renderQuota(); }
  } catch (err) {
    // Put the coach's text back so a failed send is never lost work.
    state.threads.set(key, history);
    $('#chat-input').value = message;
    toastError(err, 'AI is taking a break — try again in a moment');
    loadUsage();   // a 429 means the stored count moved; resync the bar
  } finally {
    state.busy = false;
    $('#chat-send').disabled = false;
    renderMessages();
    renderSuggestions();
    const s = selectedStudent();
    if (s) { renderChatHead(s); renderOverview(s); }
  }
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  send($('#chat-input').value);
});

const autoGrow = () => {
  const el = $('#chat-input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
};

$('#chat-input').addEventListener('input', autoGrow);
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#chat-input').value); }
});

$('#new-thread-btn').addEventListener('click', () => {
  state.threads.delete(threadKey());
  renderMessages();
  renderSuggestions();
  const s = selectedStudent();
  if (s) renderChatHead(s);
});

/* ════════════════ student modal ════════════════ */

const dialog = $('#student-dialog');
const form = $('#student-form');
let editingId = null;

function showDialogError(message) {
  const el = $('#dialog-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function openDialog(student) {
  editingId = student?.id || null;
  form.reset();
  showDialogError('');
  $('#dialog-title').textContent = student ? 'Edit Student' : 'Add Student';

  // A checkbox group is a RadioNodeList, not a single field — setting .value
  // on it would silently do the wrong thing, so it is filled separately.
  const dayBoxes = Array.from(form.querySelectorAll('input[name="lessonDays"]'));
  const selectedDays = student ? lessonDaysOf(student) : [];
  for (const box of dayBoxes) box.checked = selectedDays.includes(box.value);

  if (student) {
    for (const [key, value] of Object.entries(student)) {
      if (key === 'lessonDays' || key === 'lessonDay') continue;
      const field = form.elements[key];
      if (field) field.value = value ?? '';
    }
  } else {
    form.elements.feeCurrency.value = 'SGD';
    form.elements.paymentStatus.value = 'unpaid';
  }
  dialog.showModal();
}

$('#add-student-btn').addEventListener('click', () => openDialog(null));
$$('[data-add-student]').forEach((b) => b.addEventListener('click', () => openDialog(null)));
$('#edit-student-btn').addEventListener('click', () => {
  const s = selectedStudent();
  if (s) openDialog(s);
});
form.querySelector('[data-close]').addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showDialogError('');
  const data = new FormData(form);
  const body = Object.fromEntries(data.entries());
  // entries() keeps only the last checkbox of a repeated name; getAll keeps all.
  body.lessonDays = data.getAll('lessonDays');
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    if (editingId) {
      await api(`/api/students/${editingId}`, { method: 'PATCH', body });
      toast('Student saved');
    } else {
      const { student } = await api('/api/students', { method: 'POST', body });
      state.selectedId = student.id;
      toast('Student saved');
    }
    dialog.close();
    await loadStudents();
  } catch (err) {
    showDialogError(err.message);
  } finally {
    submit.disabled = false;
  }
});

// Deleting lives on Overview, not in the edit dialog — it is a different kind
// of act from correcting a phone number, and should not sit next to Save.
$('#delete-student-btn').addEventListener('click', async () => {
  const s = selectedStudent();
  if (!s) return;
  if (!confirm(`Delete ${s.name}? This removes all their data and cannot be undone.`)) return;

  const btn = $('#delete-student-btn');
  btn.disabled = true;
  try {
    // The server also clears this student's events and overrides.
    await api(`/api/students/${s.id}`, { method: 'DELETE' });
    state.threads.delete(s.id);
    state.selectedId = null;
    await Promise.all([loadStudents(), loadEvents()]);
    setView('calendar');
    toast('Student deleted');
  } catch (err) {
    toastError(err, "Couldn't delete the student — try again");
  } finally {
    btn.disabled = false;
  }
});

/* ════════════════ toast ════════════════ */

let toastTimer;

/** Teal with a check by default; red with a cross for anything that failed. */
function toast(message, { error = false, ms = 2500 } = {}) {
  const el = $('#toast');
  el.textContent = `${error ? '✕' : '✓'} ${message}`;
  el.classList.toggle('is-error', error);
  el.hidden = false;
  // Re-trigger the slide-up when one toast replaces another.
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/**
 * Every failure the coach sees is written for them, not copied from the wire.
 * `fallback` is the sentence for this particular action; a 4xx that the server
 * wrote deliberately (a validation message, a quota notice) is shown as-is,
 * because that text is already actionable.
 */
function toastError(err, fallback = 'Something went wrong — try again') {
  const useServerText = err?.status >= 400 && err?.status < 500 && err.message;
  toast(useServerText ? err.message : fallback, { error: true });
}

setTab('overview');
renderQuota();
renderMessages();
renderSuggestions();
