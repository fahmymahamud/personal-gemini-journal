import { auth } from './firebase.js';
import { allowlistPermits } from './admin.js';

// Verifies the Firebase ID token the browser sends on every API call and
// pins the request to that uid. Every route below /api (except /api/config)
// goes through here, so req.uid is always trustworthy downstream.
export async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const decoded = await auth.verifyIdToken(token);
    req.uid = decoded.uid;
    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
    };

    // Access control sits after identity, not instead of it: the token is
    // already proven valid, this only decides whether that person may in.
    // Inert until ENFORCE_ALLOWLIST=true — see allowlistEnforced() for why.
    const verdict = await allowlistPermits(req.user);
    if (!verdict.allowed) {
      console.warn(`allowlist: refused ${req.user.email || req.uid}`);
      return res.status(403).json({
        error: 'forbidden',
        message: 'This account is not on the access list. Ask the administrator to add you.',
      });
    }

    next();
  } catch (err) {
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired, please sign in again' });
    }
    console.error('Token verification failed:', err.message);
    res.status(401).json({ error: 'Invalid token' });
  }
}
