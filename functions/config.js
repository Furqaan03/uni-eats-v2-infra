"use strict";

// Centralised params/secrets and small shared helpers.
// Secrets are provisioned out-of-band (never in source):
//   firebase functions:secrets:set RESEND_API_KEY
// Non-secret config has safe defaults and can be overridden per-deploy.

const { defineSecret, defineString } = require("firebase-functions/params");

// Resend API key — required for real email sends. Until set, email functions
// short-circuit (logged) instead of throwing, so the rest of the engine works.
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// Verified sender — must be on a domain verified in Resend or mail lands in
// spam. Do NOT use onboarding@resend.dev in production.
const RESEND_FROM = defineString("RESEND_FROM", {
  default: "Uni Eats <noreply@theunieats.com>",
});

// Where ops/rep escalations and bounce notices go.
const OPS_EMAIL = defineString("OPS_EMAIL", { default: "" });

// Durable landing page that detects platform and serves the right build.
const DOWNLOAD_URL = defineString("DOWNLOAD_URL", {
  default: "https://theunieats.com/vendor/download",
});

// Deep-link base the app registers; the auto-login link appends ?rid=&t=&env=.
// Matches the custom scheme in AndroidManifest.xml + iOS Info.plist. Switch to
// an https Universal/App Link once the website hosts assetlinks.json / AASA.
const DEEP_LINK_BASE = defineString("DEEP_LINK_BASE", {
  default: "unieats-vendor://onboarding",
});

// test → unprefixed collections; live → live_ prefixed. Mirrors the app's
// AppEnv + the customer/admin Live/Test switch. `restaurants` and `admins`
// are shared (never prefixed).
function prefixFor(env) {
  return env === "live" ? "live_" : "";
}

// Collection name honouring the env prefix (for env-scoped collections).
function col(env, name) {
  return `${prefixFor(env)}${name}`;
}

module.exports = {
  RESEND_API_KEY,
  RESEND_FROM,
  OPS_EMAIL,
  DOWNLOAD_URL,
  DEEP_LINK_BASE,
  prefixFor,
  col,
};
