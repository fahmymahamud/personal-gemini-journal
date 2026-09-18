import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';

import { requireAuth } from './src/auth.js';
import configRoutes from './src/routes/config.js';
import turnstileRoutes from './src/routes/turnstile.js';
import studentRoutes from './src/routes/students.js';
import chatRoutes from './src/routes/chat.js';
import eventRoutes from './src/routes/events.js';
import calendarRoutes from './src/routes/calendar.js';
import telegramRoutes, { webhookRouter as telegramWebhook } from './src/routes/telegram.js';
import whatsappRoutes, { webhookRouter as whatsappWebhook } from './src/routes/whatsapp.js';
import adminRoutes from './src/routes/admin.js';
import schedulerRoutes, { checkRouter as schedulerCheck } from './src/routes/scheduler.js';
import { requireAdmin } from './src/admin.js';
import { requireActivePlan } from './src/plan.js';
import meRoutes from './src/routes/me.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');

// helmet's non-CSP defaults (HSTS, X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, …) carry no compatibility risk for this app and are left
// enforced. The CSP is different: it has to name every origin the page
// actually loads from, and Firebase Auth's web SDK is easy to get wrong here
// — sign-in also opens a hidden iframe on the auth domain to sync session
// state, which a CSP with no frame-src silently breaks. Given this project
// just had a real sign-in incident, the CSP starts in Report-Only mode: the
// browser reports what it *would* have blocked (to /api/csp-report, logged
// below) without blocking anything. Once a few days of real traffic show zero
// reports, flip `reportOnly` to false.
const authDomain = process.env.FIREBASE_AUTH_DOMAIN;
app.use(helmet({
  // helmet's own default here is 'same-origin', which isolates this page's
  // browsing context group so thoroughly that a signInWithPopup() window can
  // no longer call back to window.opener with the signed-in user — the popup
  // just closes with nothing happening. 'same-origin-allow-popups' keeps the
  // isolation everywhere except that one, Google-sign-in-shaped hole.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: {
    reportOnly: true,
    directives: {
      defaultSrc: ["'self'"],
      // gstatic: the Firebase Auth SDK, imported as an ES module.
      // challenges.cloudflare.com: the Turnstile widget on the signup form.
      scriptSrc: ["'self'", 'https://www.gstatic.com', 'https://challenges.cloudflare.com'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // The <select> arrow is an inline data: SVG; nothing else uses data:.
      imgSrc: ["'self'", 'data:'],
      // The identitytoolkit/securetoken calls are the Auth SDK signing in and
      // refreshing tokens directly from the browser — never through this server.
      connectSrc: ["'self'", 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com'],
      // Firebase Auth's session-sync iframe (only if FIREBASE_AUTH_DOMAIN is
      // set), plus the Turnstile widget's own challenge iframe.
      frameSrc: [authDomain ? `https://${authDomain}` : null, 'https://challenges.cloudflare.com']
        .filter(Boolean),
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      reportUri: '/api/csp-report',
    },
  },
}));

// Where the Report-Only CSP above sends what it would have blocked. Browsers
// POST these with no Authorization header and a body type of
// application/csp-report, which express.json() below does not parse by
// default — hence its own narrow parser here.
app.post('/api/csp-report', express.json({ type: ['application/json', 'application/csp-report'] }),
  (req, res) => {
    console.warn('[csp-report]', JSON.stringify(req.body));
    res.status(204).end();
  });

app.use(express.json({ limit: '256kb' }));

// Access log. Records whether an Authorization header arrived and how long the
// token was — never the token itself — which is enough to tell "browser sent
// nothing" apart from "server rejected it".
// Credentials that travel in a query string — the calendar feed's signed token
// and Meta's webhook verify token — would otherwise be written to Cloud Logging
// in full, where they outlive the request and are readable by anyone with log
// access. The path and the fact a value was present are what make a log useful.
const REDACTED_PARAMS = new Set(['token', 'hub.verify_token']);

function safeUrl(originalUrl) {
  const cut = originalUrl.indexOf('?');
  if (cut === -1) return originalUrl;

  const params = new URLSearchParams(originalUrl.slice(cut + 1));
  for (const key of params.keys()) {
    if (REDACTED_PARAMS.has(key)) params.set(key, 'REDACTED');
  }
  return `${originalUrl.slice(0, cut)}?${params}`;
}

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const header = req.get('authorization');
    const auth = header
      ? `auth=Bearer(${(header.split(' ')[1] || '').length} chars)`
      : 'auth=NONE';
    console.log(`${req.method} ${safeUrl(req.originalUrl)} -> ${res.statusCode} ${Date.now() - started}ms ${auth}`);
  });
  next();
});

// Health probe — must stay unauthenticated.
// '/health', not '/healthz': Cloud Run's proxy layer swallows '/healthz' and
// answers it itself, so that path never reaches this process in production.
// '/healthz' stays registered so local tooling pointed at it still works.
const health = (req, res) => res.json({ ok: true });
app.get('/health', health);
app.get('/healthz', health);

app.use('/api/config', configRoutes);
// Unauthenticated on purpose: signup is exactly the request that arrives
// with no account yet to hold a token.
app.use('/api/turnstile', turnstileRoutes);
// Reads the caller's own plan. Outside requireActivePlan on purpose: an account
// without an active plan still has to be able to ask why.
app.use('/api/me', requireAuth, meRoutes);
// requireActivePlan lets every GET through and blocks mutations for an account
// without an active plan, so an unpaid coach keeps their own data in front of them.
app.use('/api/students', requireAuth, requireActivePlan, studentRoutes);
app.use('/api/chat', requireAuth, requireActivePlan, chatRoutes);
app.use('/api/events', requireAuth, requireActivePlan, eventRoutes);
// Must precede the authenticated mount below: Express matches in order, and
// Telegram cannot send an Authorization header.
// Must precede the authenticated mount: Express matches in order, and
// '/api/whatsapp' would otherwise swallow '/api/whatsapp/webhook' and hand
// Meta a 401 it cannot satisfy — Meta sends no Authorization header.
app.use('/api/whatsapp/webhook', whatsappWebhook);
app.use('/api/whatsapp', requireAuth, requireActivePlan, whatsappRoutes);
app.use('/api/telegram/webhook', telegramWebhook);
app.use('/api/telegram', requireAuth, requireActivePlan, telegramRoutes);
// Mounted without requireAuth: /feed.ics carries its own signed token because
// calendar clients cannot send an Authorization header. /token inside applies
// requireAuth itself.
app.use('/api/calendar', calendarRoutes);
// Same ordering rule as the webhooks above: Cloud Scheduler cannot send an
// Authorization header, so /check must be matched before the authenticated
// mount can swallow it. It carries X-Scheduler-Secret instead.
app.use('/api/scheduler/check', schedulerCheck);
app.use('/api/scheduler', requireAuth, requireActivePlan, schedulerRoutes);
app.use('/api/admin', requireAuth, requireAdmin, adminRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

// The /admin shell is public HTML on purpose: the browser needs to load it
// before Firebase Auth can mint a token, so a 403 here would make signing in
// impossible. Every /api/admin endpoint behind it is gated on ADMIN_UID.
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use(express.static(path.join(__dirname, 'public')));

// Express 5 forwards rejected promises from async handlers here automatically,
// so routes above can stay free of try/catch.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  // err.expose marks messages written for the coach to read and act on, so an
  // actionable 5xx (a bad GEMINI_MODEL, say) is not flattened to a generic line.
  const tellUser = status < 500 || err.expose === true;
  res.status(status).json({
    error: tellUser ? err.message : 'Something went wrong on the server',
  });
});

const port = process.env.PORT || 8080;
const server = app.listen(port, () => {
  console.log(`Personal Gemini Journal listening on http://localhost:${port}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use — another instance is probably still running.`);
    console.error('Find it with:  netstat -ano | findstr :' + port);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

// A listening socket should hold the process open indefinitely. If the loop
// ever drains anyway the process would just vanish with code 0 — and nodemon
// would report a bare "clean exit" with no cause. Say what happened instead.
process.on('beforeExit', (code) => {
  console.error(`Event loop drained unexpectedly (exit code ${code}). ` +
    `server.listening=${server.listening}, handles=${process.getActiveResourcesInfo().join(',')}`);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception — exiting:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection — exiting:', err);
  process.exit(1);
});

// Cloud Run sends SIGTERM before evicting an instance; close the listener so
// in-flight requests finish rather than being cut off mid-response.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received — shutting down`);
    server.close(() => process.exit(0));
  });
}
