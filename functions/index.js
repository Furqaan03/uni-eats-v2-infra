"use strict";

// =============================================================================
// Uni Eats v2 — Vendor onboarding approval engine + email + auto-login tokens.
//
// Security backbone: custom claims (vendorStatus, vendorRole, outletId,
// branchId) are set ONLY here, via the Admin SDK — never by any client. The
// vendor profile doc (vendors/{uid}) that unlocks Firestore access is likewise
// created only here, on approval. See ../firestore.rules.
//
// Env split mirrors the app's AppEnv: test → unprefixed collections,
// live → live_ prefixed. Both are handled by parallel triggers.
// =============================================================================

const crypto = require("crypto");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const { RESEND_API_KEY, DOWNLOAD_URL, DEEP_LINK_BASE, OPS_EMAIL, col } = require("./config");
const emailer = require("./email");

admin.initializeApp();
const db = admin.firestore();

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const RESEND_MAX_PER_DAY = 3;
const LOCK_STALE_MS = 5 * 60 * 1000; // a lock older than this is considered dead

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

async function assertAdmin(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  const adminDoc = await db.doc(`admins/${uid}`).get();
  if (!adminDoc.exists) throw new HttpsError("permission-denied", "Admin only.");
  return uid;
}

async function getOrCreateAuthUser(email) {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      return await admin.auth().createUser({ email });
    }
    throw e;
  }
}

// Merge (never clobber) custom claims on a user.
async function mergeClaims(uid, claims) {
  const user = await admin.auth().getUser(uid);
  const next = { ...(user.customClaims || {}), ...claims };
  await admin.auth().setCustomUserClaims(uid, next);
  return next;
}

function deepLink(env, registrationId, secret) {
  const q = new URLSearchParams({ rid: registrationId, t: secret, env });
  return `${DEEP_LINK_BASE.value()}?${q.toString()}`;
}

// Best-effort FCM to whatever device tokens the app parked on the doc.
async function pushRefresh(tokens, title, body) {
  const list = (tokens || []).filter(Boolean);
  if (list.length === 0) return;
  try {
    await admin.messaging().sendEachForMulticast({
      tokens: list,
      notification: { title, body },
      data: { type: "vendor_status_changed" },
    });
  } catch (e) {
    logger.warn("pushRefresh failed", { err: String(e) });
  }
}

// ---------------------------------------------------------------------------
// Callable: inviteVendor (admin/rep) — Phase 2 server side.
// Creates the auth user + pending claims + registration doc, mints a
// single-use auto-login token, and emails the download + sign-in links.
// ---------------------------------------------------------------------------
exports.inviteVendor = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  await assertAdmin(request);
  const d = request.data || {};
  const env = d.env === "live" ? "live" : "test";
  const email = normalizeEmail(d.email);
  if (!email) throw new HttpsError("invalid-argument", "email required.");
  if (!d.outletId) throw new HttpsError("invalid-argument", "outletId required.");

  const role = ["vendor_admin", "branch_manager", "staff"].includes(d.role)
    ? d.role
    : "vendor_admin";

  const user = await getOrCreateAuthUser(email);
  await mergeClaims(user.uid, {
    vendorStatus: "pending",
    vendorRole: role,
    outletId: d.outletId,
    branchId: d.branchId || null,
    environment: env,
  });

  const secret = crypto.randomBytes(24).toString("hex");
  const now = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + TOKEN_TTL_MS);

  const ref = db.collection(col(env, "registrations")).doc();
  await ref.set({
    type: "vendor",
    status: "pending",
    environment: env,
    contactName: d.contactName || "",
    email,
    phone: d.phone || "",
    outletId: d.outletId,
    outletName: d.outletName || "",
    branchId: d.branchId || null,
    location: d.location || "",
    role,
    documents: [],
    detailsConfirmed: false,
    passwordSet: false,
    uid: user.uid,
    invitedByRepId: (request.auth && request.auth.uid) || null,
    commissionTerms: d.commissionTerms || null,
    adminNote: "",
    processingLock: null,
    autoLogin: { hash: sha256(secret), expiresAt, consumed: false },
    resendCount: 0,
    resendWindowStart: now,
    notificationSentAt: now,
    submittedAt: now,
    reviewedAt: null,
  });

  const tpl = emailer.templates.invite({
    contactName: d.contactName,
    downloadUrl: DOWNLOAD_URL.value(),
    loginUrl: deepLink(env, ref.id, secret),
  });
  await emailer.send(email, tpl.subject, tpl.html);

  return { registrationId: ref.id, uid: user.uid };
});

// ---------------------------------------------------------------------------
// Callable: consumeLoginToken (public — the user isn't signed in yet).
// Validates the single-use secret from the deep link and returns a Firebase
// custom token the app signs in with. Marks the token consumed atomically.
// ---------------------------------------------------------------------------
exports.consumeLoginToken = onCall(async (request) => {
  const d = request.data || {};
  const env = d.env === "live" ? "live" : "test";
  const rid = String(d.registrationId || "");
  const secret = String(d.secret || "");
  if (!rid || !secret) throw new HttpsError("invalid-argument", "Missing token.");

  const ref = db.collection(col(env, "registrations")).doc(rid);
  const uid = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Unknown link.");
    const data = snap.data();
    const al = data.autoLogin || {};
    if (al.consumed) throw new HttpsError("failed-precondition", "expired");
    if (!al.expiresAt || al.expiresAt.toMillis() < Date.now()) {
      throw new HttpsError("failed-precondition", "expired");
    }
    if (al.hash !== sha256(secret)) throw new HttpsError("permission-denied", "Bad token.");
    tx.update(ref, { "autoLogin.consumed": true });
    return data.uid;
  });

  if (!uid) throw new HttpsError("failed-precondition", "No account on this link.");
  const customToken = await admin.auth().createCustomToken(uid);
  return { customToken };
});

// ---------------------------------------------------------------------------
// Callable: resendLoginLink (public) — rate-limited re-issue of the auto-login
// link (max 3 / 24h per registration). Used by the "link expired" screen.
// ---------------------------------------------------------------------------
exports.resendLoginLink = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  const d = request.data || {};
  const env = d.env === "live" ? "live" : "test";
  const rid = String(d.registrationId || "");
  if (!rid) throw new HttpsError("invalid-argument", "registrationId required.");

  const ref = db.collection(col(env, "registrations")).doc(rid);
  const secret = crypto.randomBytes(24).toString("hex");

  const email = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Unknown application.");
    const data = snap.data();

    const nowMs = Date.now();
    const windowStartMs = data.resendWindowStart ? data.resendWindowStart.toMillis() : 0;
    let count = data.resendCount || 0;
    let windowStart = data.resendWindowStart || admin.firestore.Timestamp.now();
    if (nowMs - windowStartMs > 24 * 60 * 60 * 1000) {
      count = 0;
      windowStart = admin.firestore.Timestamp.now();
    }
    if (count >= RESEND_MAX_PER_DAY) {
      throw new HttpsError("resource-exhausted", "Too many requests. Try again later.");
    }

    const expiresAt = admin.firestore.Timestamp.fromMillis(nowMs + TOKEN_TTL_MS);
    tx.update(ref, {
      autoLogin: { hash: sha256(secret), expiresAt, consumed: false },
      resendCount: count + 1,
      resendWindowStart: windowStart,
    });
    return data.email;
  });

  const tpl = emailer.templates.invite({
    contactName: "",
    downloadUrl: DOWNLOAD_URL.value(),
    loginUrl: deepLink(env, rid, secret),
  });
  await emailer.send(email, tpl.subject, tpl.html);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Callable: reviewRegistration (admin) — Phase 6 server side.
// Writes the decision onto the doc; the status-change trigger below runs all
// side effects (claims, vendor provisioning, email) idempotently.
// ---------------------------------------------------------------------------
exports.reviewRegistration = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  const adminUid = await assertAdmin(request);
  const d = request.data || {};
  const env = d.env === "live" ? "live" : "test";
  const rid = String(d.registrationId || "");
  const action = String(d.action || "");
  const note = String(d.note || "").trim();
  if (!rid) throw new HttpsError("invalid-argument", "registrationId required.");

  const statusByAction = {
    approve: "approved",
    needs_changes: "needs_changes",
    reject: "rejected",
  };
  const nextStatus = statusByAction[action];
  if (!nextStatus) throw new HttpsError("invalid-argument", "Unknown action.");
  if ((action === "needs_changes" || action === "reject") && !note) {
    throw new HttpsError("invalid-argument", "A note is required for this action.");
  }

  const ref = db.collection(col(env, "registrations")).doc(rid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Unknown application.");
  if (snap.data().status === "approved") {
    // Guard double-tap alongside the trigger's lock.
    throw new HttpsError("failed-precondition", "Already approved.");
  }

  await ref.update({
    status: nextStatus,
    adminNote: note,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewedBy: adminUid,
  });
  return { ok: true, status: nextStatus };
});

// ---------------------------------------------------------------------------
// Status-change trigger — the real approval engine. Registered per-env.
// ---------------------------------------------------------------------------
async function handleStatusChange(env, event) {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!before || !after) return;
  if (before.status === after.status) return; // only react to real transitions

  const ref = event.data.after.ref;

  // Idempotency: claim a processing lock in a transaction. A duplicate
  // delivery (at-least-once) or double review write sees a fresh lock and
  // exits without repeating side effects.
  const acquired = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const lock = data.processingLock;
    if (lock && lock.at && Date.now() - lock.at.toMillis() < LOCK_STALE_MS) {
      return false;
    }
    if (data.lastNotifiedStatus === after.status) return false; // already handled
    tx.update(ref, {
      processingLock: { at: admin.firestore.Timestamp.now(), status: after.status },
    });
    return true;
  });
  if (!acquired) {
    logger.info("Status change already being processed — skipping", { id: ref.id });
    return;
  }

  try {
    const contactName = after.contactName || "";
    if (after.status === "approved") {
      // 1. Ensure the auth user exists (may already, from the magic-link).
      const user = after.uid
        ? await admin.auth().getUser(after.uid)
        : await getOrCreateAuthUser(normalizeEmail(after.email));

      // 2. Provision the vendor profile + restaurant ownership (Admin SDK,
      //    bypasses rules — the ONLY writer of vendors/{uid}).
      await db.collection(col(env, "vendors")).doc(user.uid).set(
        {
          email: normalizeEmail(after.email),
          restaurantId: after.outletId,
          restaurantName: after.outletName || "",
          restaurantLocation: after.location || "",
          role: after.role || "vendor_admin",
          branchId: after.branchId || null,
          authProvider: "onboarding",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      await db.collection(col(env, "restaurants")).doc(after.outletId).set(
        { ownerUid: user.uid },
        { merge: true }
      );

      // 3. Flip claims to approved.
      await mergeClaims(user.uid, {
        vendorStatus: "approved",
        vendorRole: after.role || "vendor_admin",
        outletId: after.outletId,
        branchId: after.branchId || null,
        environment: env,
      });

      // 4. Notify.
      const tpl = emailer.templates.approved({ contactName });
      await emailer.send(normalizeEmail(after.email), tpl.subject, tpl.html);
      await pushRefresh(after.fcmTokens, "You're approved", "Tap to open your dashboard.");
    } else if (after.status === "needs_changes") {
      if (after.uid) await mergeClaims(after.uid, { vendorStatus: "needs_changes" });
      const tpl = emailer.templates.needsChanges({ contactName, note: after.adminNote });
      await emailer.send(normalizeEmail(after.email), tpl.subject, tpl.html);
      await pushRefresh(after.fcmTokens, "Action needed", after.adminNote || "Please re-check your documents.");
    } else if (after.status === "rejected") {
      if (after.uid) await mergeClaims(after.uid, { vendorStatus: "rejected" });
      const tpl = emailer.templates.rejected({ contactName, note: after.adminNote });
      await emailer.send(normalizeEmail(after.email), tpl.subject, tpl.html);
    } else if (after.status === "pending") {
      // Resubmission from needs_changes → back to pending for re-review.
      if (after.uid) await mergeClaims(after.uid, { vendorStatus: "pending" });
    }

    await ref.update({
      processingLock: null,
      lastNotifiedStatus: after.status,
    });
  } catch (e) {
    logger.error("handleStatusChange failed", { id: ref.id, err: String(e) });
    // Release the lock so a retry can pick it up.
    await ref.update({ processingLock: null }).catch(() => {});
    throw e;
  }
}

exports.onRegistrationStatusChange = onDocumentUpdated(
  { document: "registrations/{docId}", secrets: [RESEND_API_KEY] },
  (event) => handleStatusChange("test", event)
);

exports.onLiveRegistrationStatusChange = onDocumentUpdated(
  { document: "live_registrations/{docId}", secrets: [RESEND_API_KEY] },
  (event) => handleStatusChange("live", event)
);

// ---------------------------------------------------------------------------
// Scheduled: escalate applications stuck pending > 48h.
// ---------------------------------------------------------------------------
async function escalateEnv(env) {
  const ops = OPS_EMAIL.value();
  if (!ops) return;
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 48 * 60 * 60 * 1000);
  const q = await db
    .collection(col(env, "registrations"))
    .where("type", "==", "vendor")
    .where("status", "==", "pending")
    .where("submittedAt", "<", cutoff)
    .get();
  for (const doc of q.docs) {
    const data = doc.data();
    if (data.escalatedAt) continue;
    const tpl = emailer.templates.escalation({
      email: data.email,
      registrationId: doc.id,
      hours: 48,
    });
    await emailer.send(ops, tpl.subject, tpl.html);
    await doc.ref.update({ escalatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
}

exports.escalatePendingRegistrations = onSchedule(
  { schedule: "every 6 hours", secrets: [RESEND_API_KEY] },
  async () => {
    await escalateEnv("test");
    await escalateEnv("live");
  }
);

// ---------------------------------------------------------------------------
// Resend bounce webhook. On email.bounced, flag the registration and notify
// the inviting rep / ops so a dead address doesn't silently kill onboarding.
// Protect with a shared secret in the URL: ?key=<BOUNCE_WEBHOOK_SECRET>.
// ---------------------------------------------------------------------------
exports.resendBounceWebhook = onRequest(
  { secrets: [RESEND_API_KEY] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    try {
      const body = req.body || {};
      if (body.type !== "email.bounced") {
        res.status(200).send("ignored");
        return;
      }
      const email = normalizeEmail(
        (body.data && (body.data.to || (body.data.email && body.data.email.to))) || ""
      );
      if (!email) {
        res.status(200).send("no-email");
        return;
      }
      const ops = OPS_EMAIL.value();
      for (const env of ["test", "live"]) {
        const q = await db
          .collection(col(env, "registrations"))
          .where("email", "==", email)
          .get();
        for (const doc of q.docs) {
          await doc.ref.update({ bouncedAt: admin.firestore.FieldValue.serverTimestamp() });
          if (ops) {
            const tpl = emailer.templates.bounceNotice({ email, registrationId: doc.id });
            await emailer.send(ops, tpl.subject, tpl.html);
          }
        }
      }
      res.status(200).send("ok");
    } catch (e) {
      logger.error("bounce webhook failed", { err: String(e) });
      res.status(500).send("error");
    }
  }
);
