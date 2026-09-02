import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Application Default Credentials, never a service-account key file — key
// creation is blocked by org policy, and GOOGLE_APPLICATION_CREDENTIALS is
// deliberately left unset so ADC resolves on its own:
//   local     -> gcloud auth application-default login
//   Cloud Run -> the runtime service account, off the metadata server
// Either way no credential ever lands in the repo.
if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID,
  });
}

export const auth = getAuth();
export const db = getFirestore();

// Per-user isolation lives in the path itself: a coach can only ever address
// documents beneath their own uid, so a forgotten filter cannot leak data.
export const studentsCol = (uid) => db.collection('users').doc(uid).collection('students');
export const eventsCol = (uid) => db.collection('users').doc(uid).collection('events');
