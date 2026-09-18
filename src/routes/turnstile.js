import { Router } from 'express';

const router = Router();

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const EXPECTED_ACTION = 'signup';

// Turnstile's site key is public (it's embedded in the page's own HTML), but
// it could be replayed from a copy of that HTML hosted anywhere. hostname
// pins a passing check to a browser that was actually on one of these pages.
const ALLOWED_HOSTNAMES = new Set([
  'personal-gemini-journal-359006588697.asia-southeast1.run.app',
  'localhost',
]);

/**
 * Gates account creation, not the Firebase call itself — createUser*() talks
 * straight from the browser to Google, this server is never in that path.
 * The frontend calls this first and only proceeds to create the account if
 * it comes back 200, so a normal signup always passes through here first.
 * Unauthenticated on purpose: there is no account yet to hold a token.
 */
router.post('/verify', async (req, res) => {
  const token = req.body?.token;
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return res.status(400).json({ error: 'Missing verification token' });
  }

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Fails closed: no secret configured means no way to check anything, and
    // signup is exactly the endpoint a missing secret must not silently open.
    console.error('TURNSTILE_SECRET_KEY is not set — refusing all signups until it is.');
    return res.status(503).json({ error: 'Signup verification is not configured' });
  }

  let result;
  try {
    const r = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret,
        response: token,
        // Cloud Run puts the original client IP first in this header.
        remoteip: (req.get('x-forwarded-for') || '').split(',')[0].trim(),
      }),
    });
    result = await r.json();
  } catch (err) {
    console.error('Turnstile siteverify request failed:', err.message);
    return res.status(503).json({ error: 'Could not reach the verification service — try again' });
  }

  if (!result.success || result.action !== EXPECTED_ACTION || !ALLOWED_HOSTNAMES.has(result.hostname)) {
    console.warn('Turnstile check refused:', JSON.stringify(result['error-codes'] || result));
    return res.status(403).json({ error: 'Verification failed — please try again' });
  }

  res.json({ ok: true });
});

export default router;
