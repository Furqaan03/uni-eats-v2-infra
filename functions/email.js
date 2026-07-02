"use strict";

// Resend email delivery + templates for the vendor onboarding lifecycle.
// The password-reset / OTP functions referenced in the original spec never
// existed in this codebase, so there is nothing to avoid touching here — this
// is the project's first email integration.

const logger = require("firebase-functions/logger");
const { RESEND_API_KEY, RESEND_FROM } = require("./config");

// Lazy import so a missing key never crashes cold start.
function client() {
  const key = RESEND_API_KEY.value();
  if (!key) return null;
  const { Resend } = require("resend");
  return new Resend(key);
}

// Minimal shared shell so every email looks consistent without a template dep.
function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#0f0f12;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e7e7ea">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px">
      <h1 style="color:#ff5a1f;font-size:20px;margin:0 0 8px">Uni Eats</h1>
      <h2 style="font-size:22px;margin:16px 0 12px;color:#fff">${title}</h2>
      <div style="font-size:15px;line-height:1.6;color:#c7c7cc">${bodyHtml}</div>
      <p style="font-size:12px;color:#6b6b70;margin-top:32px">Uni Eats · UDST Campus</p>
    </div></body></html>`;
}

function button(url, label) {
  return `<a href="${url}" style="display:inline-block;background:#ff5a1f;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;margin:16px 0">${label}</a>`;
}

// Sends one email. Returns { sent: bool, skipped?: bool, error?: string }.
// Never throws — email failure must not roll back an approval.
async function send(to, subject, html) {
  const c = client();
  if (!c) {
    logger.warn("RESEND_API_KEY unset — email skipped", { to, subject });
    return { sent: false, skipped: true };
  }
  try {
    const { data, error } = await c.emails.send({
      from: RESEND_FROM.value(),
      to,
      subject,
      html,
    });
    if (error) {
      logger.error("Resend error", { to, subject, error });
      return { sent: false, error: String(error) };
    }
    logger.info("Email sent", { to, subject, id: data && data.id });
    return { sent: true };
  } catch (e) {
    logger.error("Email send threw", { to, subject, err: String(e) });
    return { sent: false, error: String(e) };
  }
}

const templates = {
  invite({ contactName, downloadUrl, loginUrl }) {
    return {
      subject: "Your Uni Eats vendor access is ready",
      html: shell(
        "You're invited to Uni Eats",
        `<p>Hi ${contactName || "there"},</p>
         <p>Your outlet has been set up on Uni Eats. Download the vendor app and
         you'll be signed in automatically to finish onboarding:</p>
         <p>1. Download the app: ${button(downloadUrl, "Download the app")}</p>
         <p>2. Then open your one-time sign-in link (valid for 1 hour):</p>
         <p>${button(loginUrl, "Open & sign in")}</p>
         <p>Once in, you'll confirm your details, set a password, and upload your
         documents. We'll review and email you the moment you're approved.</p>`
      ),
    };
  },

  approved({ contactName }) {
    return {
      subject: "You're approved — Uni Eats is live for you",
      html: shell(
        "You're approved 🎉",
        `<p>Hi ${contactName || "there"},</p>
         <p>Your Uni Eats vendor account is approved and full access is now live.
         Open the app — you'll be taken straight into your dashboard, no re-login
         needed.</p>`
      ),
    };
  },

  needsChanges({ contactName, note }) {
    return {
      subject: "Action needed on your Uni Eats application",
      html: shell(
        "A quick fix is needed",
        `<p>Hi ${contactName || "there"},</p>
         <p>We reviewed your application and need a change before we can approve:</p>
         <blockquote style="border-left:3px solid #ff5a1f;padding-left:12px;color:#fff">${note || "Please re-check your documents."}</blockquote>
         <p>Open the vendor app to re-upload and resubmit.</p>`
      ),
    };
  },

  rejected({ contactName, note }) {
    return {
      subject: "Update on your Uni Eats application",
      html: shell(
        "Application update",
        `<p>Hi ${contactName || "there"},</p>
         <p>Unfortunately we're unable to approve your application at this time.</p>
         ${note ? `<blockquote style="border-left:3px solid #6b6b70;padding-left:12px">${note}</blockquote>` : ""}
         <p>If you believe this is a mistake, reply to this email to reach our team.</p>`
      ),
    };
  },

  bounceNotice({ email, registrationId }) {
    return {
      subject: `Vendor onboarding email bounced: ${email}`,
      html: shell(
        "An onboarding email bounced",
        `<p>The onboarding email to <b>${email}</b> bounced (registration
         <code>${registrationId}</code>). This vendor will not receive their
         download/sign-in link — please reach them another way or correct the
         address.</p>`
      ),
    };
  },

  escalation({ email, registrationId, hours }) {
    return {
      subject: `Vendor application pending ${hours}h+: ${email}`,
      html: shell(
        "A vendor application is waiting",
        `<p>Registration <code>${registrationId}</code> (${email}) has been
         pending review for over ${hours} hours. Please action it in the admin
         dashboard.</p>`
      ),
    };
  },
};

module.exports = { send, templates };
