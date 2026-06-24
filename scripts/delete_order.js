/**
 * One-off script to find (and optionally delete) an order by its
 * user-facing order number (e.g. "#D3296") — that string is NOT the
 * Firestore document ID (the doc ID is a random 8-char hex generated at
 * checkout, see checkout_screen.dart), so it can't be deleted by path alone.
 *
 * Uses the Firebase Admin SDK (bypasses Firestore rules by design) — same
 * setup as bootstrap_admin.js. Never commit a service-account key.
 *
 * Usage:
 *   Dry run (finds and prints the order, deletes nothing):
 *     GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json" \
 *       node delete_order.js "#D3296"
 *
 *   Actually delete it (only after confirming the dry-run output is right):
 *     GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json" \
 *       node delete_order.js "#D3296" --confirm
 */

const admin = require('firebase-admin');

async function main() {
  const [, , orderNumber, flag] = process.argv;
  const confirmed = flag === '--confirm';

  if (!orderNumber) {
    console.error('Usage: node delete_order.js <orderNumber> [--confirm]');
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at your service-account ' +
        'JSON key — see bootstrap_admin.js for where that key came from.',
    );
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const snap = await db.collection('orders').where('orderNumber', '==', orderNumber).get();

  if (snap.empty) {
    console.error(`No order found with orderNumber "${orderNumber}".`);
    process.exit(1);
  }
  if (snap.size > 1) {
    console.error(
      `Found ${snap.size} orders with orderNumber "${orderNumber}" — refusing to act ` +
        'automatically. Inspect these doc IDs manually:',
    );
    snap.docs.forEach((d) => console.error(`  ${d.id}`));
    process.exit(1);
  }

  const doc = snap.docs[0];
  const d = doc.data();
  console.log(`Found order ${orderNumber} → doc id "${doc.id}":`);
  console.log({
    status: d.status,
    orderType: d.orderType,
    userId: d.userId,
    vendorId: d.vendorId,
    restaurantName: d.restaurantName,
    customerName: d.customerName,
    total: d.total,
    createdAt: d.createdAt ? d.createdAt.toDate() : null,
  });

  if (!confirmed) {
    console.log('\nDry run only — nothing deleted. Re-run with --confirm to actually delete it.');
    process.exit(0);
  }

  await doc.ref.delete();
  console.log(`\n✓ Deleted order ${orderNumber} (doc id "${doc.id}").`);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
