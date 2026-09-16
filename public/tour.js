/*
 * Guided tour — a spotlight walk through every control in the app.
 *
 * Two decisions shape the whole thing.
 *
 * 1. Much of this UI is conditional. The verification card only exists while a
 *    payment is pending, Disconnect only once Telegram is linked, the install
 *    button only where the browser offers it. A tour that silently skipped
 *    those would teach a new coach — the person most likely to run it — the
 *    least. So every conditional step carries an `absent` line and is explained
 *    centre-screen when its element is not on the page.
 *
 * 2. It never opens a dialog. A <dialog> renders in the browser's top layer,
 *    above any overlay, so the spotlight would sit behind it and the effect
 *    would break. The dialogs are described at the button that opens them.
 *
 * The tour drives the app through the same functions the UI uses, passed in as
 * `ctx`, rather than synthesising clicks — a fake click would fire handlers
 * that save, send or delete.
 */

const CARD_GAP = 14;      // between the spotlight ring and the card
const EDGE = 12;          // keep the card this far off the viewport edge

/* ═══════════════════ steps ═══════════════════ */

function buildSteps(ctx) {
  const { setView, setTab, focusStudent, getStudents } = ctx;

  // Puts a student on screen so the Overview steps have something to point at.
  const withStudent = () => {
    const list = getStudents();
    if (!list.length) return;
    focusStudent(ctx.getSelectedId() || list[0].id);
  };
  const toOverview = () => { withStudent(); setTab('overview'); };

  return [
    {
      title: 'Welcome to RemindClient',
      body: 'A quick walk through every button on the page. Use Next and Back, '
        + 'or the arrow keys. Press Esc to leave at any point — nothing here changes your data.',
    },

    /* ── the top bar ── */
    {
      el: '#nav-calendar-btn',
      title: 'Clients and Calendar',
      body: 'Switches the main area between your client list and the month calendar. '
        + 'It stays lit while the calendar is showing.',
      absent: 'On a phone, the Clients and Calendar tabs along the bottom switch between the two.',
      before: () => setView('students'),
    },
    {
      el: '#verify-btn',
      title: 'Payment verifications',
      body: 'Appears with a red count when parents have said they paid. Open it to '
        + 'confirm or reject each one without leaving the page.',
      absent: 'A bell with a red count appears here when a parent taps “I’ve Paid” '
        + 'in Telegram. It stays hidden while there is nothing waiting, which is why '
        + 'you cannot see it right now.',
    },
    {
      el: '#settings-btn',
      title: 'Settings',
      body: 'Connect your own Telegram to confirm payment claims from your phone, '
        + 'add the app to your home screen, and subscribe to your lesson calendar.',
    },
    {
      el: '#admin-link',
      title: 'Admin',
      body: 'Opens the admin dashboard — coach totals, usage and the access list.',
      absent: 'An Admin link sits here for administrator accounts only. Yours is not one, '
        + 'so it stays hidden.',
    },
    {
      el: '#signout-btn',
      title: 'Sign out',
      body: 'Ends your session. Your clients and their history stay where they are.',
    },

    /* ── the client rail ── */
    {
      el: '.sidebar',
      title: 'Your clients',
      body: 'Every client you track, one name per line. '
        + 'Selecting one opens their full record beside it.',
      before: () => { setView('students'); ctx.showList(); },
      place: 'right',
    },
    {
      el: '#add-student-btn',
      title: 'Add Client',
      body: 'Opens a short form — name and phone are all that is required. '
        + 'Everything else is filled in afterwards on the client’s own page.',
    },
    {
      el: '#student-search',
      title: 'Search',
      body: 'Filters the list as you type. Useful once you are past a dozen clients.',
    },

    /* ── the client record ── */
    {
      el: '.tabs',
      title: 'Overview and AI Chat',
      body: 'Overview is the whole record — details, lessons, reminders, payments. '
        + 'AI Chat is where Gemini drafts messages for this client.',
      before: toOverview,
      absent: 'With a client selected, two tabs appear here: Overview for their record, '
        + 'and AI Chat for drafting messages. Add a client to see them.',
    },
    {
      el: '#overview-form .ov-grid',
      title: 'Client details',
      body: 'Name, phone, and who actually pays. The payer’s phone is the number '
        + 'reminders and Telegram invites go to.',
      before: toOverview,
      absent: 'The top of a client’s Overview holds their name, phone, and the payer’s '
        + 'details — the payer’s number is where reminders go.',
    },
    {
      el: '#add-lesson-btn',
      title: 'Lesson schedule',
      body: 'Add up to ten weekly slots — day, time and place. These fill the calendar '
        + 'and feed the lesson reminders.',
      before: toOverview,
      absent: 'A client’s Overview lets you add up to ten weekly lesson slots, which '
        + 'fill the calendar and feed lesson reminders.',
    },
    {
      el: '#reminders',
      title: 'Auto reminders',
      body: 'Two per client, repeating weekly. Pick payment or lesson, the day and the time. '
        + 'The switch saves the moment you flip it — no need to press Save.',
      before: toOverview,
      absent: 'Each client can carry two weekly auto-reminders — payment or lesson, on a day '
        + 'and time you choose. Their on/off switches save immediately.',
    },
    {
      el: '#connect-actions, #connect-linked',
      title: 'Telegram connection',
      body: 'Send the parent their personal link. When they tap Start in Telegram they are '
        + 'connected here, and reminders can reach them automatically.',
      before: toOverview,
      absent: 'Each client has a Telegram section. Sending the parent their personal link '
        + 'connects them, which is what lets reminders send on their own.',
    },
    {
      el: '#connect-actions, #connect-linked',
      title: 'What the parent sees',
      body: 'They never open this app. On connecting they get a short guide to the '
        + 'three buttons on every payment reminder, and can type /help in the chat to '
        + 'read it again. Nothing they type reaches you — the bot tells them so.',
      before: toOverview,
      absent: 'Parents never open this app. When they connect, the bot explains the three '
        + 'buttons on a payment reminder, and /help repeats it. Anything they type gets a '
        + 'reply saying the bot cannot pass messages on to you.',
    },
    {
      el: '#send-tg-btn',
      title: 'Send via Telegram',
      body: 'Sends a payment reminder to the linked chat right now, with the buttons that '
        + 'let the parent reply — I’ve Paid, Send Receipt, or Remind Me Later.',
      before: toOverview,
      absent: 'Once a client is linked, “Send via Telegram” sends a payment reminder '
        + 'immediately, carrying the buttons a parent taps to reply.',
    },
    {
      el: '#ov-draft',
      title: 'Draft in AI Chat',
      body: 'Jumps to the chat tab with this client already loaded, so Gemini drafts '
        + 'with their name, fee and schedule in view.',
      absent: 'Once a client is linked to Telegram, a “Draft in AI Chat” button takes you '
        + 'to the chat with their details already loaded.',
    },
    {
      el: '#tg-disconnect-btn',
      title: 'Disconnect',
      body: 'Unlinks the chat and burns the invite link, so an old link cannot quietly '
        + 'reconnect someone later.',
      absent: 'A Disconnect button appears once a client is linked. It unlinks the chat and '
        + 'burns the old invite so it cannot be reused.',
    },
    {
      el: () => document.querySelector('#tab-overview .ov-block:has(#mark-paid-btn) .ov-grid')
        || document.querySelector('#mark-paid-btn'),
      title: 'Payment tracking',
      body: 'The fee, the currency, the status and when they last paid. '
        + 'These drive the chips in the list and the rings on the calendar.',
      before: toOverview,
      absent: 'Fee, currency, payment status and last-paid date live on the Overview, and '
        + 'they are what the status chips and calendar markers read from.',
    },
    {
      el: '#verify-block',
      title: 'Payment verification',
      body: 'Shows when this client’s parent has claimed payment. View the receipt if they '
        + 'sent one, then Confirm or Reject — the parent is told either way.',
      absent: 'When a parent claims payment, an amber card appears here with their claim, '
        + 'any receipt they sent, and Confirm and Reject buttons. The parent hears back either way.',
    },
    {
      el: '#mark-paid-btn',
      title: 'Mark as Paid',
      body: 'The one-tap version, for when someone pays you in person or you have already '
        + 'checked your bank. It stamps today as the last paid date.',
      before: toOverview,
      absent: '“Mark as Paid” records a payment in one tap and stamps today as the last '
        + 'paid date — for cash in hand, or a transfer you have already checked.',
    },
    {
      el: '#ov-save',
      title: 'Save Changes',
      body: 'Stays greyed out until something actually changes, then saves the whole record '
        + 'at once. Reminder switches are the exception — they save on their own.',
      before: toOverview,
      absent: 'Save Changes sits at the foot of the Overview. It wakes up only when something '
        + 'has changed, and writes the whole record in one go.',
    },
    {
      el: '#delete-student-btn',
      title: 'Delete Client',
      body: 'Removes the client and everything attached — lessons, reminders and history. '
        + 'It asks first, and it cannot be undone.',
      before: toOverview,
      absent: 'Delete Client sits at the foot of the Overview. It removes the client and '
        + 'everything attached to them, after asking, and cannot be undone.',
    },

    /* ── AI chat ── */
    {
      el: '#chat-input',
      title: 'Ask Gemini',
      body: 'Ask for a draft in your own words — “chase last month’s fee, keep it warm” — '
        + 'then refine it: shorter, friendlier, add the PayNow number.',
      before: () => { withStudent(); setTab('chat'); },
      absent: 'The AI Chat tab drafts reminders for the selected client. You ask in plain '
        + 'words and refine the draft until it sounds like you.',
    },
    {
      el: '#suggestions',
      title: 'Quick prompts',
      body: 'One-tap starters for the things you ask for most, so a draft is one tap away.',
      before: () => { withStudent(); setTab('chat'); },
      absent: 'Quick prompt buttons sit above the message box as one-tap starters.',
    },
    {
      el: '.quota',
      title: 'Daily allowance',
      body: 'How many AI messages you have used today. It resets at midnight Singapore time.',
      before: () => { withStudent(); setTab('chat'); },
      absent: 'A counter above the chat shows your AI messages used today. It resets at '
        + 'midnight Singapore time.',
    },
    {
      el: '#new-thread-btn',
      title: 'New thread',
      body: 'Clears the conversation and starts a fresh draft for this client.',
      absent: 'Once a conversation has started, a “New thread” button clears it and starts '
        + 'a fresh draft.',
    },

    /* ── calendar ── */
    {
      el: '#cal-grid',
      title: 'The month',
      body: 'Every lesson as a pill, coloured by that client’s payment status. '
        + 'Tap a day to see it in full, add a one-off lesson, or jot a note.',
      before: () => setView('calendar'),
      absent: 'The calendar shows every lesson as a coloured pill. Tapping a day opens it '
        + 'in full, where you can add a one-off lesson or a note.',
    },
    {
      el: '.cal-head',
      title: 'Moving through months',
      body: 'The arrows step month by month. The legend underneath says what each '
        + 'pill colour means.',
      before: () => setView('calendar'),
    },

    /* ── close ── */
    {
      title: 'That is the whole app',
      body: 'The tour lives behind the question mark in the top bar whenever you want it again. '
        + 'A good first move: add a client, then send them their Telegram link.',
      after: () => { setView('students'); setTab('overview'); },
    },
  ];
}

/* ═══════════════════ engine ═══════════════════ */

let live = null;   // the running tour, so a second click cannot start two

export function startTour(ctx) {
  if (live) return;
  live = new Tour(ctx);
  live.start();
}

export function isTourRunning() {
  return !!live;
}

class Tour {
  constructor(ctx) {
    this.ctx = ctx;
    this.steps = buildSteps(ctx);
    this.i = 0;
    this.token = 0;
    this.build();
  }

  build() {
    const root = document.createElement('div');
    root.className = 'tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Guided tour');
    root.innerHTML = `
      <div class="tour-block"></div>
      <div class="tour-ring" hidden></div>
      <div class="tour-card" role="document">
        <p class="tour-count" aria-live="polite"></p>
        <h2 class="tour-title"></h2>
        <p class="tour-body"></p>
        <div class="tour-foot">
          <button class="btn btn-ghost btn-sm tour-skip" type="button">Skip tour</button>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm tour-back" type="button">Back</button>
          <button class="btn btn-primary btn-sm tour-next" type="button">Next</button>
        </div>
      </div>`;
    document.body.append(root);

    this.root = root;
    this.ring = root.querySelector('.tour-ring');
    this.card = root.querySelector('.tour-card');
    this.elCount = root.querySelector('.tour-count');
    this.elTitle = root.querySelector('.tour-title');
    this.elBody = root.querySelector('.tour-body');
    this.btnBack = root.querySelector('.tour-back');
    this.btnNext = root.querySelector('.tour-next');

    this.btnNext.addEventListener('click', () => this.go(1));
    this.btnBack.addEventListener('click', () => this.go(-1));
    root.querySelector('.tour-skip').addEventListener('click', () => this.end());
    root.querySelector('.tour-block').addEventListener('click', () => this.end());

    this.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.end(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(-1); }
    };
    // Re-measure rather than re-run: the step is already set up, only its
    // geometry moved.
    this.onMove = () => { if (this.frame) return; this.frame = requestAnimationFrame(() => {
      this.frame = null; this.place();
    }); };

    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onMove);
    window.addEventListener('scroll', this.onMove, true);
  }

  start() {
    this.returnTo = document.activeElement;
    this.show(0);
  }

  go(delta) {
    const next = this.i + delta;
    if (next < 0) return;
    if (next >= this.steps.length) return this.end();
    this.show(next);
  }

  /**
   * Rendering a step spans several frames, so a second Next can arrive while
   * the first is still waiting. Each run claims a token and abandons itself the
   * moment a newer one starts — without that, the slower of two overlapping
   * runs finishes last and paints the step the reader already moved past.
   */
  async show(i) {
    this.i = i;
    const token = ++this.token;
    const step = this.steps[i];

    try { step.before?.(); } catch { /* a step that cannot set up still explains itself */ }

    // Two frames: one for the app's own re-render, one for layout to settle.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (token !== this.token) return;

    this.target = resolve(step.el);
    if (this.target) {
      this.target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(r));
      if (token !== this.token) return;
    }

    this.elCount.textContent = `Step ${i + 1} of ${this.steps.length}`;
    this.elTitle.textContent = step.title;
    this.elBody.textContent = this.target || !step.absent ? step.body : step.absent;
    this.card.classList.toggle('is-note', !this.target && !!step.absent);

    this.btnBack.disabled = i === 0;
    this.btnNext.textContent = i === this.steps.length - 1 ? 'Done' : 'Next';

    this.place();
    this.btnNext.focus({ preventScroll: true });
  }

  place() {
    const step = this.steps[this.i];
    const rect = this.target?.getBoundingClientRect();

    // A target scrolled out of its own scroll container has a zero-ish box —
    // treat that as absent rather than spotlighting a sliver.
    if (!rect || rect.width < 2 || rect.height < 2) {
      this.ring.hidden = true;
      this.centre();
      return;
    }

    const pad = 6;
    Object.assign(this.ring.style, {
      top: `${rect.top - pad}px`,
      left: `${rect.left - pad}px`,
      width: `${rect.width + pad * 2}px`,
      height: `${rect.height + pad * 2}px`,
    });
    this.ring.hidden = false;

    const card = this.card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top;
    const below = rect.bottom + CARD_GAP;
    const above = rect.top - CARD_GAP - card.height;
    if (step.place === 'right' && rect.right + CARD_GAP + card.width < vw - EDGE) {
      top = clamp(rect.top, EDGE, vh - card.height - EDGE);
      this.card.style.left = `${rect.right + CARD_GAP}px`;
      this.card.style.top = `${top}px`;
      return;
    }
    if (below + card.height < vh - EDGE) top = below;
    else if (above > EDGE) top = above;
    else top = clamp((vh - card.height) / 2, EDGE, vh - card.height - EDGE);

    const left = clamp(rect.left + rect.width / 2 - card.width / 2,
      EDGE, Math.max(EDGE, vw - card.width - EDGE));
    this.card.style.top = `${top}px`;
    this.card.style.left = `${left}px`;
  }

  centre() {
    const card = this.card.getBoundingClientRect();
    this.card.style.top = `${clamp((window.innerHeight - card.height) / 2, EDGE, 1e4)}px`;
    this.card.style.left = `${clamp((window.innerWidth - card.width) / 2, EDGE, 1e4)}px`;
  }

  end() {
    if (live !== this) return;
    live = null;
    try { this.steps[this.steps.length - 1].after?.(); } catch { /* nothing to undo */ }
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onMove);
    window.removeEventListener('scroll', this.onMove, true);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.root.remove();
    try { this.returnTo?.focus({ preventScroll: true }); } catch { /* gone from the DOM */ }
  }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function resolve(el) {
  if (!el) return null;
  const found = typeof el === 'function' ? el() : document.querySelector(el);
  if (!found) return null;
  // offsetParent is null for display:none; a [hidden] ancestor counts too.
  return found.offsetParent || found.getClientRects().length ? found : null;
}
