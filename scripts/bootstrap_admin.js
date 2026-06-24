/**
 * One-time (or occasional) admin provisioning script.
 *
 * Why this exists: firestore.rules deliberately blocks every client-side
 * path to creating an `admins/{uid}` document — no signed-in user, no
 * matter what email they used, can write that doc from a browser. That
 * closed a real privilege-escalation hole (any authenticated user could
 * previously self-grant admin read access to users/orders/drivers/vendors).
 *
 * The only way to create an admin doc now is via the Firebase Admin SDK,
 * authenticated with a service-account key. That key lives only on this
 * machine (or wherever you choose to run this script) — it is never
 * bundled into the admin-dashboard, never sent to a browser, and the
 * Admin SDK bypasses Firestore rules entirely by design. That's what makes
 * this a genuine *server-side* authorization boundary instead of a client
 * check the page itself enforces.
 *
 * Setup (do this once):
 *   1. Firebase Console → Project Settings → Service Accounts →
 *      "Generate new private key". Save the downloaded JSON somewhere
 *      OUTSIDE this repo (e.g. ~/secrets/uni-eats-service-account.json).
 *      Never commit this file — it grants full admin access to the project.
 *   2. cd scripts && npm install
 *   3. Have the target user sign in to the admin dashboard's login screen
 *      at least once with their email/password (this creates their
 *      Firebase Auth account) — sign-in will be rejected with "not an
 *      authorized admin" until you run step 4. That's expected.
 *   4. Run this script:
 *      GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json" \
 *        node bootstrap_admin.js admin@example.com super_admin
 *
 * Usage:
 *   node bootstrap_admin.js <email> [role]
 *   role defaults to "super_admin" if omitted.
 *   Valid roles: super_admin, operations, finance, support, qa
 */

const admin = require('firebase-admin');

const VALID_ROLES = new Set(['super_admin', 'operations', 'finance', 'support', 'qa']);

async function main() {
  const [, , email, roleArg] = process.argv;
  const role = roleArg || 'super_admin';

  if (!email) {
    console.error('Usage: node bootstrap_admin.js <email> [role]');
    process.exit(1);
  }
  if (!VALID_ROLES.has(role)) {
    console.error(`Invalid role "${role}". Valid roles: ${[...VALID_ROLES].join(', ')}`);
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at your service-account ' +
        'JSON key — see the setup instructions at the top of this file.',
    );
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault() });

  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
  } catch (e) {
    console.error(
      `No Firebase Auth user found for ${email}. They need to sign up/sign in at least ` +
        'once (e.g. via the admin dashboard login screen) before you can grant admin access.',
    );
    process.exit(1);
  }

  const db = admin.firestore();
  await db.collection('admins').doc(userRecord.uid).set(
    {
      name: userRecord.displayName || email,
      email,
      role,
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  console.log(`✓ Granted "${role}" admin access to ${email} (uid: ${userRecord.uid}).`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
