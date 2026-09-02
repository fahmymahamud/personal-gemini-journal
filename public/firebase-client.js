import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';

// Config comes from the server so nothing project-specific is baked into this file.
const res = await fetch('/api/config');
if (!res.ok) {
  const { error } = await res.json().catch(() => ({}));
  throw new Error(error || 'Could not load Firebase config from the server');
}

const app = initializeApp(await res.json());
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
};

// Every API call carries a fresh ID token; the server re-verifies it each time.
export async function api(path, { method = 'GET', body } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');

  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${await user.getIdToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry the status through: callers need to tell "you may not" (403) apart
    // from "it broke" (500), which otherwise look identical at this layer.
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.error || null;
    throw err;
  }
  return data;
}
