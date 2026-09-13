import { Router } from 'express';
import { planState } from '../plan.js';
import { isAdmin } from '../admin.js';

const router = Router();

/**
 * What the browser needs to draw the plan bar and disable what it must.
 *
 * The plan is recomputed here rather than trusted from the client, and the
 * client's copy is advisory: every write is checked again server-side by
 * requireActivePlan. A hidden button is a courtesy, not a control.
 */
router.get('/', (req, res) => {
  const state = req.plan || planState(req.profile, { uid: req.uid });
  res.json({
    uid: req.uid,
    email: req.user?.email || null,
    displayName: req.user?.name || null,
    isAdmin: isAdmin(req.uid),
    trialEndDate: req.profile?.trialEndDate || null,
    limits: {
      students: req.profile?.studentLimit ?? null,
      aiMessagesPerDay: req.profile?.aiMessagesPerDay ?? null,
      autoRemindersPerStudent: req.profile?.autoRemindersPerStudent ?? null,
    },
    ...state,
  });
});

export default router;
