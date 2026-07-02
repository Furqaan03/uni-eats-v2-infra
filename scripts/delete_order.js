/**
 * Find, list, or delete orders by their user-facing order number
 * (e.g. "#D3296") — that string is NOT the Firestore document ID (the doc ID
 * is a random 8-char hex generated at checkout, see checkout_screen.dart), so
 * it can't be deleted by path alone.
 *
 * Uses the Firebase Admin SDK (bypasses Firestore rules by design) — same
 * setup as bootstrap_admin.js. Never commit a service-account key.
 *
 * Environment: defaults to TEST (the `orders` collection). Pass --live to
 * target the LIVE dataset (`live_orders`) instead.
 *
 * Usage:
 *   List in-flight (live) orders so you can find one to remove:
 *     node delete_order.js --list                 # test env
 *     node delete_order.js --list --live          # live env
 *
 *   Dry run (finds and prints the order, deletes nothing):
 *     node delete_order.js "#D3296"
 *     node delete_order.js "#D3296" --live
 *
 *   Actually delete it (only after confirming the dry-run output is right):
 *     node delete_order.js "#D3296" --confirm
 *     node delete_order.js "#D3296" --live --confirm
 *
 *   Delete by Firestore doc id (for orders with no orderNumber field):
 *     node delete_order.js --id 12C7C3B0
 *     node delete_order.js --id 12C7C3B0 --confirm
 *     node delete_order.js --id 12C7C3B0 --live --confirm
 *
 * All commands require GOOGLE_APPLICATION_CREDENTIALS pointing at a
 * service-account JSON key — see bootstrap_admin.js for where that came from.
 */

const admin = require('firebase-admin');

// In-flight statuses (mirrors the dashboard's LIVE_ORDER_STATUSES).
const LIVE_STATUSES = ['placed', 'preparing', 'ready', 'assigned', 'pickedUp', 'enRoute'];

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const confirmed = args.includes('--confirm');
  const listMode = args.includes('--list');
  const idMode = args.includes('--id');
  const positional = args.find((a) => !a.startsWith('--')); // orderNumber, or doc id when --id
  const orderNumber = positional;
  const docId = positional;
  const col = live ? 'live_orders' : 'orders';

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at your service-account ' +
        'JSON key — see bootstrap_admin.js for where that key came from.',
    );
    process.exit(1);
  }
  if (!listMode && !positional) {
    console.error('Usage: node delete_order.js <orderNumber> [--live] [--confirm]   (or --list, or --id <docId>)');
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  // ---- Delete by Firestore doc id (orders with no orderNumber field) ----
  if (idMode) {
    const ref = db.collection(col).doc(docId);
    const doc = await ref.get();
    if (!doc.exists) {
      console.error(`No doc "${docId}" in ${col}.`);
      process.exit(1);
    }
    const d = doc.data();
    console.log(`Found ${col}/${docId}:`);
    console.log({
      status: d.status, orderNumber: d.orderNumber, orderType: d.orderType,
      restaurantName: d.restaurantName, customerName: d.customerName, total: d.total,
      createdAt: d.createdAt ? d.createdAt.toDate() : null,
    });
    if (!confirmed) {
      console.log('\nDry run only — nothing deleted. Re-run with --confirm to actually delete it.');
      process.exit(0);
    }
    await ref.delete();
    console.log(`\n✓ Deleted ${col}/${docId}.`);
    process.exit(0);
  }

  // ---- List mode: print every in-flight order in the chosen env ----
  if (listMode) {
    const snap = await db.collection(col).where('status', 'in', LIVE_STATUSES).get();
    if (snap.empty) {
      console.log(`No in-flight (live) orders in ${col}.`);
      process.exit(0);
    }
    console.log(`In-flight orders in ${col} (${snap.size}):`);
    snap.docs.forEach((d) => {
      const o = d.data();
      console.log(`  ${o.orderNumber || '(no #)'}  [${o.status}]  ${o.restaurantName || '—'} → ${o.customerName || '—'}  QAR ${o.total || 0}  (doc ${d.id})`);
    });
    console.log(`\nDelete one with: node delete_order.js "<orderNumber>"${live ? ' --live' : ''} --confirm`);
    process.exit(0);
  }

  // ---- Find / delete a specific order by orderNumber ----
  const snap = await db.collection(col).where('orderNumber', '==', orderNumber).get();

  if (snap.empty) {
    console.error(`No order found with orderNumber "${orderNumber}" in ${col}.`);
    process.exit(1);
  }
  if (snap.size > 1) {
    console.error(
      `Found ${snap.size} orders with orderNumber "${orderNumber}" in ${col} — refusing to act ` +
        'automatically. Inspect these doc IDs manually:',
    );
    snap.docs.forEach((d) => console.error(`  ${d.id}`));
    process.exit(1);
  }

  const doc = snap.docs[0];
  const d = doc.data();
  console.log(`Found order ${orderNumber} in ${col} → doc id "${doc.id}":`);
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
  console.log(`\n✓ Deleted order ${orderNumber} from ${col} (doc id "${doc.id}").`);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
