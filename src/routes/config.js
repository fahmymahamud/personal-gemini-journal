import { Router } from 'express';

const router = Router();

// Public on purpose: the browser needs this before anyone has signed in.
// These values identify the Firebase project, they do not authorise anything —
// access is still decided by Auth plus the uid-scoped paths on the server.
router.get('/', (req, res) => {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  };

  const missing = ['apiKey', 'authDomain', 'projectId', 'appId'].filter((k) => !config[k]);
  if (missing.length) {
    return res.status(503).json({
      error: `Server is missing Firebase web config: ${missing.join(', ')}. Check your .env against .env.example.`,
    });
  }
  res.json(config);
});

export default router;
