import { Router } from 'express';
import { studentsCol } from '../firebase.js';
import { runChat } from '../gemini.js';
import { consumeChatQuota, readChatQuota } from '../rate-limit.js';

const router = Router();

// Read-only, so the quota bar has a value on page load rather than only after
// the coach's first message of the day.
router.get('/usage', async (req, res) => {
  res.json({ usage: await readChatQuota(req.uid) });
});

// Multi-turn: the browser keeps the transcript and posts it back each time,
// so the server stays stateless and survives Cloud Run cold starts.
// { studentId?, history: [{role, text}], message } -> { reply, history }
router.post('/', async (req, res) => {
  const { studentId, history = [], message } = req.body || {};

  let student = null;
  if (studentId) {
    const doc = await studentsCol(req.uid).doc(String(studentId)).get();
    if (!doc.exists) return res.status(404).json({ error: 'Student not found' });
    student = { id: doc.id, ...doc.data() };
  }

  // After the student lookup so a bad studentId costs no quota, but before the
  // Gemini call so a failing upstream cannot be retried without limit.
  const usage = await consumeChatQuota(req.uid);

  const reply = await runChat({
    history,
    message,
    student,
    coachName: req.user.name || req.user.email,
  });

  res.json({
    reply,
    usage,
    history: [...history, { role: 'user', text: message }, { role: 'model', text: reply }],
  });
});

export default router;
