/**
 * Seed the LIVE environment (`live_`-prefixed collections) with a small,
 * coherent, cross-referenced dataset so the admin dashboard's LIVE view is
 * non-empty for runtime validation of the Live/Test switch.
 *
 * Field shapes mirror exactly what admin-dashboard/public/index.html reads:
 *   live_users/{uid}       : name, email, phone, isBlocked
 *   live_restaurants/{rid} : name, adminSuspended
 *   live_vendors/{uid}     : restaurantId, email, name   (owner lookup)
 *   live_drivers/{uid}     : name, phone, totalTripsAllTime, rating, isSuspended
 *   live_orders/{id}       : status, total, userId, orderType, orderNumber,
 *                            customerName, restaurantName, vendorId,
 *                            items[{name, qty}], createdAt (server ts)
 *
 * These are the same top-level collections the apps write when
 * AppEnv.current == DataEnv.live. Seeding here does NOT touch test data.
 *
 * Setup:
 *   1. cd scripts && npm install   (if not already done)
 *   2. GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json" \
 *        node seed_live.js          # seed
 *      GOOGLE_APPLICATION_CREDENTIALS="..." node seed_live.js --clean   # remove
 *
 * Re-running seed is idempotent (fixed doc ids, merge writes).
 */

const admin = require('firebase-admin');

const RESTAURANTS = [
  { id: 'live_r001', name: 'Campus Grill', adminSuspended: false },
  { id: 'live_r002', name: 'Noodle Bar', adminSuspended: false },
];

const VENDORS = [
  { id: 'live_v001', restaurantId: 'live_r001', email: 'owner.grill@example.com', name: 'Grill Owner' },
  { id: 'live_v002', restaurantId: 'live_r002', email: 'owner.noodle@example.com', name: 'Noodle Owner' },
];

const USERS = [
  { id: 'live_u001', name: 'Aisha Khan', email: 'aisha@example.com', phone: '+974 5000 0001', isBlocked: false },
  { id: 'live_u002', name: 'Omar Ali', email: 'omar@example.com', phone: '+974 5000 0002', isBlocked: false },
  { id: 'live_u003', name: 'Sara Noor', email: 'sara@example.com', phone: '+974 5000 0003', isBlocked: false },
];

const DRIVERS = [
  { id: 'live_d001', name: 'Bilal R.', phone: '+974 6000 0001', totalTripsAllTime: 42, rating: 4.8, isSuspended: false },
  { id: 'live_d002', name: 'Yusuf M.', phone: '+974 6000 0002', totalTripsAllTime: 17, rating: 4.6, isSuspended: false },
];

// Orders spanning every dashboard bucket: delivered, cancelled, placed,
// preparing, and out-for-delivery — so KPIs and all sections populate.
const ORDERS = [
  { id: 'live_o001', orderNumber: '#L0001', status: 'delivered', total: 45.5, userId: 'live_u001', customerName: 'Aisha Khan', restaurantName: 'Campus Grill', vendorId: 'live_r001', orderType: 'delivery', items: [{ name: 'Zinger Burger', qty: 2 }, { name: 'Fries', qty: 1 }] },
  { id: 'live_o002', orderNumber: '#L0002', status: 'delivered', total: 28.0, userId: 'live_u002', customerName: 'Omar Ali', restaurantName: 'Noodle Bar', vendorId: 'live_r002', orderType: 'pickup', items: [{ name: 'Ramen', qty: 1 }] },
  { id: 'live_o003', orderNumber: '#L0003', status: 'cancelled', total: 15.0, userId: 'live_u003', customerName: 'Sara Noor', restaurantName: 'Campus Grill', vendorId: 'live_r001', orderType: 'delivery', items: [{ name: 'Wrap', qty: 1 }] },
  { id: 'live_o004', orderNumber: '#L0004', status: 'placed', total: 33.0, userId: 'live_u001', customerName: 'Aisha Khan', restaurantName: 'Noodle Bar', vendorId: 'live_r002', orderType: 'delivery', items: [{ name: 'Pad Thai', qty: 2 }] },
  { id: 'live_o005', orderNumber: '#L0005', status: 'preparing', total: 22.5, userId: 'live_u002', customerName: 'Omar Ali', restaurantName: 'Campus Grill', vendorId: 'live_r001', orderType: 'delivery', items: [{ name: 'Chicken Box', qty: 1 }] },
  { id: 'live_o006', orderNumber: '#L0006', status: 'enRoute', total: 51.0, userId: 'live_u003', customerName: 'Sara Noor', restaurantName: 'Noodle Bar', vendorId: 'live_r002', orderType: 'delivery', items: [{ name: 'Dumplings', qty: 3 }, { name: 'Soup', qty: 1 }] },
];

const ALL_DOCS = [
  ['live_restaurants', RESTAURANTS],
  ['live_vendors', VENDORS],
  ['live_users', USERS],
  ['live_drivers', DRIVERS],
  ['live_orders', ORDERS],
];

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at your service-account ' +
        'JSON key — see bootstrap_admin.js for how to obtain one.',
    );
    process.exit(1);
  }

  const clean = process.argv.includes('--clean');
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  for (const [col, docs] of ALL_DOCS) {
    for (const { id, ...data } of docs) {
      if (clean) {
        await db.collection(col).doc(id).delete();
        console.log(`✗ removed ${col}/${id}`);
      } else {
        // createdAt only meaningful on orders; harmless elsewhere but scope it.
        if (col === 'live_orders') data.createdAt = admin.firestore.FieldValue.serverTimestamp();
        await db.collection(col).doc(id).set(data, { merge: true });
        console.log(`✓ ${col}/${id}`);
      }
    }
  }

  console.log(clean ? '\nLIVE seed data removed.' : '\nLIVE seed data written. Switch the dashboard to LIVE to verify.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
