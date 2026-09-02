import {
  auth, api, onAuthStateChanged, signOut,
} from './firebase-client.js';

const $ = (sel) => document.querySelector(sel);

const STATES = ['loading', 'denied', 'error', 'ok'];
function show(state, detail) {
  STATES.forEach((s) => { $(`#state-${s}`).hidden = s !== state; });
  if (state === 'denied' && detail) $('#denied-detail').textContent = detail;
  if (state === 'error' && detail) $('#error-detail').textContent = detail;
}

$('#signout-btn').addEventListener('click', () => signOut(auth));
$('#denied-signout').addEventListener('click', () => signOut(auth));
$('#error-retry').addEventListener('click', () => { show('loading'); load(); });

let coachPage = 1;

onAuthStateChanged(auth, async (user) => {
  // Not signed in at all: this page has no login form of its own, so send them
  // to the app to sign in there.
  if (!user) { window.location.replace('/'); return; }

  $('#who').textContent = `Signed in as ${user.email || user.uid}`;
  // The token is only ever minted inside this callback, i.e. after auth state
  // is confirmed — api() reads auth.currentUser, which is populated by now.
  console.log('[admin] signed in as', user.email, '| uid', user.uid);
  show('loading');
  await load();
});

const fmtDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};
const fmtDay = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value)
    : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
};

const cell = (text, cls) => {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
};

const PLAN_LABEL = { free: 'Free', trial: 'Trial', monthly: 'Monthly', annual: 'Annual' };

function planBadge(plan) {
  const key = String(plan || 'free').toLowerCase();
  const span = document.createElement('span');
  span.className = `plan plan-${key}`;
  span.textContent = (key === 'annual' ? '★ ' : '') + (PLAN_LABEL[key] || plan);
  return span;
}

async function load() {
  try {
    const stats = await api('/api/admin/stats');
    renderStats(stats);
    await Promise.all([loadCoaches(), loadAllowlist()]);
    show('ok');
  } catch (err) {
    // 403 is the only status that means "not an admin". Anything else is a
    // server fault, and calling that "Access Denied" sends the reader hunting
    // for a permissions bug that does not exist.
    console.error('[admin] dashboard load failed', err.status, err.code, err.message);
    if (err.status === 403) {
      show('denied', 'This account does not have administrator access.');
    } else {
      show('error', `${err.status ? err.status + ' — ' : ''}${err.message}`);
    }
  }
}

// Each figure replaces its "—" with a short rise, so the numbers read as
// having arrived rather than as having always been there.
function setStat(id, value) {
  const el = $(id);
  el.textContent = value;
  el.classList.remove('is-in');
  void el.offsetWidth;
  el.classList.add('is-in');
}

function renderStats(s) {
  setStat('#stat-coaches', s.totalCoaches);
  setStat('#stat-students', s.totalStudents);
  setStat('#stat-messages', s.totalMessagesToday);
  setStat('#stat-active', s.activeThisWeek);

  const banner = $('#enforcement-banner');
  if (s.enforcementOn) {
    banner.className = 'banner banner-on';
    banner.textContent = '🔒 Access control is enforced — only the accounts listed below can sign in.';
  } else {
    banner.className = 'banner';
    banner.textContent = '⚠️ Access control is currently open — all Google accounts can sign in. '
      + 'Enable enforcement in src/auth.js when ready to launch.';
  }
}

async function loadCoaches() {
  const data = await api(`/api/admin/coaches?page=${coachPage}`);
  const body = $('#coach-rows');

  if (!data.coaches.length) {
    const tr = document.createElement('tr');
    const td = cell('No coaches yet', 'muted-cell');
    td.colSpan = 5;
    tr.append(td);
    body.replaceChildren(tr);
  } else {
    body.replaceChildren(...data.coaches.map((c) => {
      const tr = document.createElement('tr');
      tr.append(cell(c.email || c.uid), cell(String(c.studentCount)), cell(fmtDate(c.lastActive)));

      const planTd = document.createElement('td');
      planTd.append(planBadge(c.plan));
      tr.append(planTd);

      const actions = document.createElement('td');
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'btn btn-ghost btn-sm';
      view.textContent = 'View';
      view.disabled = true;
      view.title = 'Not implemented yet';
      actions.append(view);
      tr.append(actions);
      return tr;
    }));
  }

  $('#coach-page-info').textContent =
    `${data.total} total · page ${data.page} of ${data.totalPages}`;
  $('#coach-pager').hidden = data.totalPages <= 1;
  $('#coach-prev').disabled = data.page <= 1;
  $('#coach-next').disabled = data.page >= data.totalPages;
}

$('#coach-prev').addEventListener('click', async () => { coachPage -= 1; await loadCoaches(); });
$('#coach-next').addEventListener('click', async () => { coachPage += 1; await loadCoaches(); });

async function loadAllowlist() {
  const { entries } = await api('/api/admin/allowlist');
  const body = $('#allow-rows');

  if (!entries.length) {
    const tr = document.createElement('tr');
    const td = cell('Nobody on the allowlist yet.', 'muted-cell');
    td.colSpan = 5;
    tr.append(td);
    body.replaceChildren(tr);
    return;
  }

  body.replaceChildren(...entries.map((e) => {
    const tr = document.createElement('tr');
    tr.append(cell(e.email));

    const planTd = document.createElement('td');
    planTd.append(planBadge(e.plan));
    tr.append(planTd);

    tr.append(cell(fmtDay(e.paid_until)), cell(e.added_by || '—', 'mono-cell'));

    const actions = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger btn-sm';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove ${e.email} from the allowlist?`)) return;
      remove.disabled = true;
      try {
        await api(`/api/admin/allowlist/${encodeURIComponent(e.email)}`, { method: 'DELETE' });
        toast(`${e.email} removed`);
        await loadAllowlist();
      } catch (err) {
        toast(err.message || 'Something went wrong — try again', { error: true });
        remove.disabled = false;
      }
    });
    actions.append(remove);
    tr.append(actions);
    return tr;
  }));
}

/* ── add coach modal ── */

const dialog = $('#coach-dialog');
const form = $('#coach-form');

// Trial = +3 months, monthly = +1 month, annual = +1 year, from today.
function paidUntilFor(plan) {
  const d = new Date();
  if (plan === 'trial') d.setMonth(d.getMonth() + 3);
  else if (plan === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function syncPaidUntil() {
  form.elements.paid_until.value = paidUntilFor(form.elements.plan.value);
}

$('#add-coach-btn').addEventListener('click', () => {
  form.reset();
  $('#coach-error').hidden = true;
  form.elements.plan.value = 'trial';
  syncPaidUntil();
  dialog.showModal();
});

form.elements.plan.addEventListener('change', syncPaidUntil);
form.querySelector('[data-close]').addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#coach-error');
  err.hidden = true;
  const body = Object.fromEntries(new FormData(form).entries());
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await api('/api/admin/allowlist', { method: 'POST', body });
    dialog.close();
    toast(`${body.email} added`);
    await Promise.all([loadAllowlist(), loadCoaches()]);
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

let toastTimer;
function toast(message, { error = false, ms = 2500 } = {}) {
  const el = $('#toast');
  el.textContent = `${error ? '✕' : '✓'} ${message}`;
  el.classList.toggle('is-error', error);
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

show('loading');
