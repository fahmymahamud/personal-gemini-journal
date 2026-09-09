// Imported for its side effect: it is what calls initializeApp(). Without it
// this module works only when something else happened to load firebase.js
// first, which is a load-order coincidence rather than a guarantee.
import './firebase.js';
import { getStorage } from 'firebase-admin/storage';

// A plain regional bucket, private and with public access prevented. Receipts
// are payment records belonging to one coach, so nothing here is ever served
// straight from the bucket: reads go through GET /api/students/:id/receipt,
// which checks the caller owns the student first.
//
// Signed URLs were the obvious alternative and are deliberately not used. They
// need iam.serviceAccounts.signBlob on the runtime account, they leak the
// object to anyone the link reaches, and they expire — so the in-app view
// would break a week after the receipt arrived.
const BUCKET = process.env.RECEIPTS_BUCKET || 'elemental-component-27dgj-receipts';

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;   // 5MB, per spec

const ALLOWED = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

const bucket = () => getStorage().bucket(BUCKET);

/** Sniffs the real type from magic bytes — a caption is not evidence. */
export function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Stores one receipt and returns its object path.
 *
 * The type is taken from the bytes rather than from anything Telegram said, so
 * a renamed executable cannot land in the bucket wearing a .jpg.
 */
export async function saveReceipt({ uid, studentId, buffer }) {
  if (!buffer?.length) throw Object.assign(new Error('Empty receipt'), { status: 400 });
  if (buffer.length > MAX_RECEIPT_BYTES) {
    throw Object.assign(new Error('Receipt is larger than 5MB'), { status: 413, expose: true });
  }

  const contentType = detectImageType(buffer);
  if (!contentType) {
    throw Object.assign(new Error('Only JPEG, PNG or WebP images are accepted'),
      { status: 415, expose: true });
  }

  const path = `receipts/${uid}/${studentId}/${Date.now()}.${ALLOWED.get(contentType)}`;
  await bucket().file(path).save(buffer, {
    contentType,
    resumable: false,
    metadata: { cacheControl: 'private, max-age=0' },
  });
  return { path, contentType, bytes: buffer.length };
}

/** Reads a receipt back for the owning coach. Returns null when it is gone. */
export async function readReceipt(path) {
  const file = bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [meta] = await file.getMetadata();
  const [buffer] = await file.download();
  return { buffer, contentType: meta.contentType || 'application/octet-stream' };
}

export { BUCKET };
