import { Router } from 'express';
import { studentsCol } from '../firebase.js';
import { requireAuth } from '../auth.js';
import { buildCalendar, calendarToken, verifyCalendarToken } from '../calendar.js';

const router = Router();

function feedUrl(req, token) {
  // Cloud Run terminates TLS upstream, so trust the forwarded scheme when present.
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}/api/calendar/feed.ics?token=${encodeURIComponent(token)}`;
}

// Bearer-authenticated: the coach copies this once and pastes it into their
// calendar app.
router.get('/token', requireAuth, (req, res) => {
  const token = calendarToken(req.uid);
  res.json({ token, url: feedUrl(req, token) });
});

// Deliberately NOT behind requireAuth — calendar clients cannot send an
// Authorization header, so the signed token in the query string is the
// credential. It grants read-only access to this one feed and nothing else.
router.get('/feed.ics', async (req, res) => {
  const uid = verifyCalendarToken(req.query.token);
  if (!uid) return res.status(401).type('text/plain').send('Invalid or missing calendar token');

  const snap = await studentsCol(uid).get();
  const students = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const { ics } = buildCalendar(students);

  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="remindclient-lessons.ics"',
    // Subscribed clients poll; never let one serve a cached copy back to the
    // parent after the coach has moved a lesson.
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.send(ics);
});

export default router;
