/**
 * One-time migration: stamp the vendorStatus=approved custom claim (plus
 * vendorRole/outletId/branchId) onto every EXISTING vendor account.
 *
 * Why this exists: the vendor onboarding flow gates access on custom claims,
 * and firestore.rules now provisions vendors/{uid} only via the Admin SDK on
 * approval. Vendors created under the OLD self-serve signup have a
 * vendors/{uid} doc but no claim. This backfills their claim so they keep
 * working (and so any future claim-gated rule treats them as approved) without
 * forcing a re-login — the app force-refreshes the token on next launch.
 *
 * Run it once per environment (test = unprefixed, live = live_ prefixed):
 *   GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json" \
 *     node backfill_vendor_claims.js test
 *   GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json" \
 *     node backfill_vendor_claims.js live
 *
 * Idempotent: re-running only re-sets the same claims. Safe to run again.
 */

const admin = require("firebase-admin");

async function main() {
  const env = process.argv[2] || "test";
  const prefix = env === "live" ? "live_" : "";
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error("GOOGLE_APPLICATION_CREDENTIALS is not set — point it at your service-account JSON key.");
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const snap = await db.collection(`${prefix}vendors`).get();
  console.log(`Found ${snap.size} vendor(s) in ${prefix || "(test)"}vendors.`);

  let ok = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    const uid = doc.id;
    const data = doc.data();
    try {
      const user = await admin.auth().getUser(uid);
      const next = {
        ...(user.customClaims || {}),
        vendorStatus: "approved",
        vendorRole: data.role || "vendor_admin",
        outletId: data.restaurantId || null,
        branchId: data.branchId || null,
        environment: env,
      };
      await admin.auth().setCustomUserClaims(uid, next);
      ok++;
      console.log(`  ✓ ${uid} (${data.email || "?"}) → approved`);
    } catch (e) {
      failed++;
      console.warn(`  ✗ ${uid}: ${e.message}`);
    }
  }

  console.log(`Done. ${ok} updated, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
