/**
 * One-time (or occasional) voucher provisioning script — for seeding demo
 * data or fixing a code from outside the app. Vouchers live in Firestore
 * (vouchers/{code}, scoped to a restaurantId), and firestore.rules
 * cross-checks an order's discount against the real doc before allowing the
 * write. A vendor can now create/edit their own restaurant's codes directly
 * from the app's Promotions screen — this script is for admin-side
 * provisioning only (seeding, or fixing a code without going through a
 * vendor account).
 *
 * Setup:
 *   1. cd scripts && npm install (if not already done for bootstrap_admin.js)
 *   2. GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json" \
 *        node seed_vouchers.js
 *
 * Edit the VOUCHERS list below to add/retire codes, then re-run.
 */

const admin = require('firebase-admin');

const VOUCHERS = [
  { code: 'WELCOME10', type: 'percent', value: 10, min: 0, active: true, restaurantId: 'r001' },
  { code: 'SAVE5', type: 'flat', value: 5, min: 20, active: true, restaurantId: 'r001' },
  { code: 'UDST15', type: 'percent', value: 15, min: 30, active: true, restaurantId: 'r001' },
];

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at your service-account ' +
        'JSON key — see bootstrap_admin.js for how to obtain one.',
    );
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  for (const v of VOUCHERS) {
    const { code, ...data } = v;
    await db.collection('vouchers').doc(code).set(data, { merge: true });
    console.log(`✓ ${code}: ${JSON.stringify(data)}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
