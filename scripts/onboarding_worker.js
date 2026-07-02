/**
 * Vendor onboarding worker — Spark-plan replacement for the Cloud Functions
 * approval engine (functions/index.js), which cannot deploy without Blaze.
 *
 * The dashboard queues actions by writing registrations docs directly
 * (admin-gated by firestore.rules); this worker performs every privileged
 * side effect with the Admin SDK: auth users, custom claims, custom tokens
 * (magic links), vendor provisioning, and Resend emails.
 *
 * What it processes per pass:
 *   1. emailQueued == true            → create auth user + pending claims,
 *                                       mint 1h custom token, send invite email.
 *   2. resendQueued == true           → re-mint token, resend invite (3/24h cap).
 *   3. status approved/needs_changes/rejected not yet notified
 *                                     → provision vendor + claims + email
 *                                       (mirrors handleStatusChange in functions).
 *   4. resubmitted needs_changes→pending → claims back to pending.
 *
 * Usage (from scripts/, after `npm install`):
 *   node onboarding_worker.js                 # one pass over TEST env
 *   node onboarding_worker.js --env live      # one pass over LIVE env
 *   node onboarding_worker.js --watch         # keep running, poll every 30s
 *
 * Config: scripts/.env (gitignored) — RESEND_API_KEY, RESEND_FROM,
 * SERVICE_ACCOUNT, DOWNLOAD_URL, DEEP_LINK_BASE.
 *
 * NOTE: when the project upgrades to Blaze and functions deploy, stop using
 * this worker — the dashboard already prefers the callables and only falls
 * back to queue-writes when they're unavailable.
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// ---- tiny .env loader (no extra deps) ----
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv();

const ENV = process.argv.includes('--env')
  ? (process.argv[process.argv.indexOf('--env') + 1] === 'live' ? 'live' : 'test')
  : 'test';
const WATCH = process.argv.includes('--watch');
const col = (name) => (ENV === 'live' ? 'live_' : '') + name;

const RESEND_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Uni Eats <onboarding@resend.dev>';
const DOWNLOAD_URL = process.env.DOWNLOAD_URL || 'https://theunieats.com/vendor/download';
const DEEP_LINK_BASE = process.env.DEEP_LINK_BASE || 'unieats-vendor://onboarding';
const RESEND_MAX_PER_DAY = 3;

const keyPath = process.env.SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath || !fs.existsSync(keyPath)) {
  console.error('Service-account key not found. Set SERVICE_ACCOUNT in scripts/.env');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(keyPath) });
const db = admin.firestore();

// ---- email (Resend REST via global fetch; never throws) ----
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) { console.warn(`  [email skipped — no RESEND_API_KEY] ${subject} → ${to}`); return false; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`  [email FAILED ${res.status}] ${subject} → ${to}:`, body.message || body); return false; }
    console.log(`  [email sent] ${subject} → ${to} (${body.id || 'ok'})`);
    return true;
  } catch (e) { console.error(`  [email threw] ${subject} → ${to}:`, e.message); return false; }
}

// Templates mirror functions/email.js so vendors see identical mails.
const shell = (title, body) => `<!doctype html><html><body style="margin:0;background:#0f0f12;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e7e7ea">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <h1 style="color:#ff5a1f;font-size:20px;margin:0 0 8px">Uni Eats</h1>
    <h2 style="font-size:22px;margin:16px 0 12px;color:#fff">${title}</h2>
    <div style="font-size:15px;line-height:1.6;color:#c7c7cc">${body}</div>
    <p style="font-size:12px;color:#6b6b70;margin-top:32px">Uni Eats · UDST Campus</p>
  </div></body></html>`;
const button = (url, label) => `<a href="${url}" style="display:inline-block;background:#ff5a1f;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;margin:16px 0">${label}</a>`;

const templates = {
  invite: (name, loginUrl) => ({
    subject: 'Your Uni Eats vendor access is ready',
    html: shell("You're invited to Uni Eats", `<p>Hi ${name || 'there'},</p>
      <p>Your outlet has been set up on Uni Eats. Download the vendor app and you'll be signed in automatically to finish onboarding:</p>
      <p>1. Download the app: ${button(DOWNLOAD_URL, 'Download the app')}</p>
      <p>2. Then open your one-time sign-in link (valid for 1 hour):</p>
      <p>${button(loginUrl, 'Open & sign in')}</p>
      <p>Once in, you'll confirm your details, set a password, and upload your documents. We'll review and email you the moment you're approved.</p>`),
  }),
  approved: (name) => ({
    subject: "You're approved — Uni Eats is live for you",
    html: shell("You're approved 🎉", `<p>Hi ${name || 'there'},</p>
      <p>Your Uni Eats vendor account is approved and full access is now live. Open the app — you'll be taken straight into your dashboard, no re-login needed.</p>`),
  }),
  needsChanges: (name, note) => ({
    subject: 'Action needed on your Uni Eats application',
    html: shell('A quick fix is needed', `<p>Hi ${name || 'there'},</p>
      <p>We reviewed your application and need a change before we can approve:</p>
      <blockquote style="border-left:3px solid #ff5a1f;padding-left:12px;color:#fff">${note || 'Please re-check your documents.'}</blockquote>
      <p>Open the vendor app to re-upload and resubmit.</p>`),
  }),
  rejected: (name, note) => ({
    subject: 'Update on your Uni Eats application',
    html: shell('Application update', `<p>Hi ${name || 'there'},</p>
      <p>Unfortunately we're unable to approve your application at this time.</p>
      ${note ? `<blockquote style="border-left:3px solid #6b6b70;padding-left:12px">${note}</blockquote>` : ''}
      <p>If you believe this is a mistake, reply to this email to reach our team.</p>`),
  }),
};

// ---- auth helpers ----
async function getOrCreateAuthUser(email) {
  try { return await admin.auth().getUserByEmail(email); }
  catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    return admin.auth().createUser({ email, emailVerified: false });
  }
}
async function mergeClaims(uid, claims) {
  const user = await admin.auth().getUser(uid);
  await admin.auth().setCustomUserClaims(uid, { ...(user.customClaims || {}), ...claims });
}

// The magic link: the custom token IS the `t` param (the vendor app signs in
// with it directly — no consumeLoginToken callable exists on Spark). Firebase
// custom tokens expire after 1 hour; single-use is not enforceable without a
// server, which is an accepted Spark-plan tradeoff.
async function mintLoginLink(regId, uid) {
  const token = await admin.auth().createCustomToken(uid, {});
  return `${DEEP_LINK_BASE}?rid=${regId}&t=${encodeURIComponent(token)}&env=${ENV}`;
}

// ---- processors (each idempotent; returns true if it acted) ----
async function processInvite(doc) {
  const g = doc.data();
  if (g.emailQueued !== true) return false;
  console.log(`- invite: ${g.email} (${doc.id})`);
  const user = await getOrCreateAuthUser(g.email);
  await mergeClaims(user.uid, {
    vendorStatus: 'pending', vendorRole: g.role || 'vendor_admin',
    outletId: g.outletId || null, branchId: g.branchId || null, environment: ENV,
  });
  const loginUrl = await mintLoginLink(doc.id, user.uid);
  const tpl = templates.invite(g.contactName, loginUrl);
  await sendEmail(g.email, tpl.subject, tpl.html);
  await doc.ref.update({
    uid: user.uid, emailQueued: false,
    autoLogin: { expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3600e3), consumed: false },
    notificationSentAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return true;
}

async function processResend(doc) {
  const g = doc.data();
  if (g.resendQueued !== true) return false;
  console.log(`- resend: ${g.email} (${doc.id})`);
  const winStart = g.resendWindowStart ? g.resendWindowStart.toMillis() : 0;
  const fresh = Date.now() - winStart > 24 * 3600e3;
  const count = fresh ? 0 : (g.resendCount || 0);
  if (count >= RESEND_MAX_PER_DAY) {
    console.warn(`  rate-limited (${count}/24h) — skipping`);
    await doc.ref.update({ resendQueued: false });
    return true;
  }
  const uid = g.uid || (await getOrCreateAuthUser(g.email)).uid;
  const loginUrl = await mintLoginLink(doc.id, uid);
  const tpl = templates.invite(g.contactName, loginUrl);
  await sendEmail(g.email, tpl.subject, tpl.html);
  await doc.ref.update({
    uid, resendQueued: false, resendCount: count + 1,
    resendWindowStart: fresh ? admin.firestore.FieldValue.serverTimestamp() : (g.resendWindowStart || admin.firestore.FieldValue.serverTimestamp()),
    autoLogin: { expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3600e3), consumed: false },
  });
  return true;
}

async function processStatusChange(doc) {
  const g = doc.data();
  const actionable = ['approved', 'needs_changes', 'rejected'];
  const resubmitted = g.status === 'pending' && g.lastNotifiedStatus === 'needs_changes';
  if (!actionable.includes(g.status) && !resubmitted) return false;
  if (g.lastNotifiedStatus === g.status) return false;
  console.log(`- status ${g.status}: ${g.email} (${doc.id})`);

  if (g.status === 'approved') {
    const user = g.uid ? await admin.auth().getUser(g.uid) : await getOrCreateAuthUser(g.email);
    await db.collection(col('vendors')).doc(user.uid).set({
      email: g.email, restaurantId: g.outletId, restaurantName: g.outletName || '',
      restaurantLocation: g.location || '', role: g.role || 'vendor_admin',
      branchId: g.branchId || null, authProvider: 'onboarding',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (g.outletId) {
      await db.collection(col('restaurants')).doc(g.outletId).set({ ownerUid: user.uid }, { merge: true });
    }
    await mergeClaims(user.uid, {
      vendorStatus: 'approved', vendorRole: g.role || 'vendor_admin',
      outletId: g.outletId || null, branchId: g.branchId || null, environment: ENV,
    });
    const tpl = templates.approved(g.contactName);
    await sendEmail(g.email, tpl.subject, tpl.html);
    await doc.ref.update({ uid: user.uid, lastNotifiedStatus: 'approved' });
  } else if (g.status === 'needs_changes') {
    if (g.uid) await mergeClaims(g.uid, { vendorStatus: 'needs_changes' });
    const tpl = templates.needsChanges(g.contactName, g.adminNote);
    await sendEmail(g.email, tpl.subject, tpl.html);
    await doc.ref.update({ lastNotifiedStatus: 'needs_changes' });
  } else if (g.status === 'rejected') {
    if (g.uid) await mergeClaims(g.uid, { vendorStatus: 'rejected' });
    const tpl = templates.rejected(g.contactName, g.adminNote);
    await sendEmail(g.email, tpl.subject, tpl.html);
    await doc.ref.update({ lastNotifiedStatus: 'rejected' });
  } else if (resubmitted) {
    if (g.uid) await mergeClaims(g.uid, { vendorStatus: 'pending' });
    await doc.ref.update({ lastNotifiedStatus: 'pending' });
  }
  return true;
}

async function pass() {
  const snap = await db.collection(col('registrations')).get();
  let acted = 0;
  for (const doc of snap.docs) {
    try {
      if (await processInvite(doc)) { acted++; continue; }
      if (await processResend(doc)) { acted++; continue; }
      if (await processStatusChange(doc)) acted++;
    } catch (e) {
      console.error(`! ${doc.id} failed:`, e.message);
    }
  }
  console.log(`[${new Date().toISOString()}] ${ENV}: ${snap.size} registrations scanned, ${acted} processed.`);
}

async function main() {
  console.log(`Onboarding worker — env: ${ENV.toUpperCase()}${WATCH ? ', watch mode (30s)' : ''}`);
  await pass();
  if (WATCH) setInterval(() => pass().catch((e) => console.error('pass failed:', e.message)), 30_000);
  else process.exit(0);
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });
