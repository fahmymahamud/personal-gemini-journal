/**
 * One-time (but idempotent) seed for the competition demo.
 *
 *   node scripts/seed-demo.js
 *
 * Creates the two demo Firebase Auth accounts if they are missing, then gives
 * the demo coach four students with varied payment statuses. Re-running it
 * updates the existing records rather than duplicating them, so it is safe to
 * run again after a Firestore wipe.
 */
import 'dotenv/config';
import { auth, studentsCol } from '../src/firebase.js';
import { FieldValue } from 'firebase-admin/firestore';
import { normalizeStudent } from '../src/student-schema.js';

// The demo password is deliberately shared with the judges, but it still does
// not belong in the source. It comes from the environment, and the script
// refuses to run without it rather than inventing a weak default.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!DEMO_PASSWORD) {
  console.error('DEMO_PASSWORD is not set. Add it to .env (see .env.example) and re-run.');
  process.exit(1);
}

const ACCOUNTS = [
  {
    email: process.env.DEMO_COACH_EMAIL || 'demo@remindclient.app',
    password: DEMO_PASSWORD,
    displayName: 'Demo Coach',
  },
  {
    email: process.env.DEMO_ADMIN_EMAIL || 'admin@remindclient.app',
    password: DEMO_PASSWORD,
    displayName: 'Admin',
  },
];

const STUDENTS = [
  { name: 'Ahmad Danial',   payerName: 'Mdm Rohana',  feeAmount: 240, paymentStatus: 'overdue', lessonDays: ['Mon', 'Thu'], lessonTime: '10:00', location: 'My home', studentPhone: '91230001', payerPhone: '91230002' },
  { name: 'Priya Krishnan', payerName: 'Mr Krishnan', feeAmount: 180, paymentStatus: 'paid',    lessonDays: ['Wed'],        lessonTime: '14:00', location: 'Zoom', studentPhone: '91230003', payerPhone: '91230004' },
  { name: 'Wei Ling',       payerName: 'Mdm Chen',    feeAmount: 200, paymentStatus: 'unpaid',  lessonDays: ['Mon', 'Fri'], lessonTime: '16:00', location: "Student's place", studentPhone: '91230005', payerPhone: '91230006' },
  { name: 'Marcus Tan',     payerName: 'Mr Tan',      feeAmount: 150, paymentStatus: 'paid',    lessonDays: ['Sat', 'Sun'], lessonTime: '09:00', location: 'Community centre', studentPhone: '91230007', payerPhone: '91230008' },
];

async function ensureAccount({ email, password, displayName }) {
  try {
    const existing = await auth.getUserByEmail(email);
    console.log(`  exists   ${email}  ->  ${existing.uid}`);
    return existing;
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    const created = await auth.createUser({ email, password, displayName, emailVerified: true });
    console.log(`  created  ${email}  ->  ${created.uid}`);
    return created;
  }
}

async function seedStudents(uid) {
  const col = studentsCol(uid);
  const existing = await col.get();
  const byName = new Map(existing.docs.map((d) => [d.data().name, d.ref]));

  for (const raw of STUDENTS) {
    const body = normalizeStudent({ ...raw, feeCurrency: 'SGD' });
    const ref = byName.get(raw.name);
    if (ref) {
      await ref.update({ ...body, updatedAt: FieldValue.serverTimestamp() });
      console.log(`  updated  ${raw.name}`);
    } else {
      await col.add({
        ...body,
        userId: uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`  added    ${raw.name}`);
    }
  }
}

async function main() {
  console.log('Firebase Auth accounts:');

  const users = [];
  for (const account of ACCOUNTS) users.push(await ensureAccount(account));
  const demoUser = users[0];
  const adminUser = users[1];

  console.log(`\nStudents for ${demoUser.email}:`);
  await seedStudents(demoUser.uid);

  console.log('\n─────────────────────────────────────────────');
  console.log('demo  uid :', demoUser.uid);
  console.log('admin uid :', adminUser.uid);
  console.log('\nADMIN_UID should be the comma-separated pair:');
  console.log(`ADMIN_UID=${process.env.PERSONAL_ADMIN_UID || '<your-personal-uid>'},${adminUser.uid}`);
  console.log('─────────────────────────────────────────────');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
