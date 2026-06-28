/**
 * One-time backfill for the userDirectory collection.
 *
 * Why this exists: wallet transfers resolve a recipient's uid via
 * userDirectory/{lowercased email or universityId} -> {uid}, written going
 * forward by createUserProfile() on every signup. Accounts created before
 * that change have no directory entry yet, so transfers to them would fail
 * lookup even though the account is real. Run this once after deploying the
 * transfer feature to backfill every existing users/{uid} doc.
 *
 * Setup:
 *   GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json" \
 *     node backfill_user_directory.js
 */

const admin = require('firebase-admin');

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

  const usersSnap = await db.collection('users').get();
  let written = 0;
  const batchSize = 400;
  let batch = db.batch();
  let opsInBatch = 0;

  for (const doc of usersSnap.docs) {
    const data = doc.data();
    const uid = doc.id;
    const email = (data.email || '').trim().toLowerCase();
    const universityId = (data.universityId || '').trim().toLowerCase();

    if (email) {
      batch.set(db.collection('userDirectory').doc(email), { uid }, { merge: true });
      opsInBatch++;
      written++;
    }
    if (universityId) {
      batch.set(db.collection('userDirectory').doc(universityId), { uid }, { merge: true });
      opsInBatch++;
      written++;
    }
    if (opsInBatch >= batchSize) {
      await batch.commit();
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) await batch.commit();

  console.log(`✓ Backfilled ${written} directory entries from ${usersSnap.size} users.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
