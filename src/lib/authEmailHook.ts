// src/lib/authEmailHook.ts
//
// Spec 166 §4 / D9 — jest-only CANONICAL of the pure logic inside the GoTrue
// Send Email hook edge function (supabase/functions/auth-email-hook/index.ts):
// payload validation, recipient routing (incl. the email_change "swapped hash"
// pairing), the spec 165 placeholder drop, subjects, links, HTML/Text render,
// hook-secret parsing, transport-config resolution, transport request
// building, delivery-outcome classification (spec 168) and Standard Webhooks
// signature verification (spec 169).
//
// This module is NOT imported by the edge function (different bundle — Deno
// vs. the app). The block between the BEGIN/END markers below is copied
// BYTE-IDENTICALLY into the function, and src/lib/authEmailHook.parity.test.ts
// fails the build on any drift — so the code jest exercises here is literally
// the code that ships (same posture as src/utils/escapeHtml.ts, spec 028, and
// the spec 165 placeholder-email block).
//
// The block is pure TS: no imports, no Deno.*, no fetch, no console, no
// export. It references two free identifiers that each side defines OUTSIDE
// the block: `isPlaceholderEmail` (spec 165 predicate) and `escapeHtml`
// (spec 028). Here they are imported; in Deno they are the inline copies.
// It also uses runtime globals that behave identically in Node >= 20 (jest)
// and the Deno 2 edge runtime: `crypto.subtle`, `TextEncoder`, `atob`, `btoa`.
// Never import node's `crypto` module here; it would shadow the global.
//
// Never write the literal placeholder domain in this file: the spec 165 lint
// (placeholderEmail.parity.test.ts) forbids it outside the predicate module.

import { isPlaceholderEmail } from './placeholderEmail';
import { escapeHtml } from '../utils/escapeHtml';

// BEGIN auth-email-hook-core (spec 166)
type HookEmailData = {
  token: string;
  token_hash: string;
  redirect_to: string;
  email_action_type: string;
  site_url: string;
  token_new: string;
  token_hash_new: string;
  old_email: string;
};
type HookPayload = { user: { email: string; new_email: string }; email_data: HookEmailData };
type Leg = { to: string; hash: string; code: string };
type PlannedMail = { to: string; subject: string; html: string; text: string };
type Plan =
  | { ok: true; action: string; mails: PlannedMail[]; dropped: number }
  | { ok: false; reason: "invalid_payload" | "unlinkable" };
type TransportConfig =
  | { kind: "mailpit"; url: string; from: string; fromName: string }
  | { kind: "resend"; apiKey: string; from: string; fromName: string };

const HOOK_EMAIL_DATA_FIELDS = [
  "token",
  "token_hash",
  "redirect_to",
  "email_action_type",
  "site_url",
  "token_new",
  "token_hash_new",
  "old_email",
] as const;

const RESEND_API_URL = "https://api.resend.com/emails";
const HOOK_FOOTER = "I.M.R — Inventory Management for Restaurant";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Missing / null → "" ; any other non-string → null (reject the payload).
function readStringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : null;
}

function parsePayload(raw: unknown): HookPayload | null {
  if (!isRecord(raw) || !isRecord(raw.user) || !isRecord(raw.email_data)) return null;
  const email = readStringField(raw.user, "email");
  const newEmail = readStringField(raw.user, "new_email");
  if (email === null || newEmail === null) return null;
  const d: Record<string, string> = {};
  for (const key of HOOK_EMAIL_DATA_FIELDS) {
    const v = readStringField(raw.email_data, key);
    if (v === null) return null;
    d[key] = v;
  }
  if (d.email_action_type === "") return null;
  return {
    user: { email, new_email: newEmail },
    email_data: {
      token: d.token,
      token_hash: d.token_hash,
      redirect_to: d.redirect_to,
      email_action_type: d.email_action_type,
      site_url: d.site_url,
      token_new: d.token_new,
      token_hash_new: d.token_hash_new,
      old_email: d.old_email,
    },
  };
}

function isNotificationAction(action: string): boolean {
  return /_notification$/.test(action);
}

// Spec 166 §3.2. Returns null when the request has no deliverable leg at all
// (→ 400 invalid payload). Placeholder legs are NOT removed here — planMails
// drops them, so routing stays testable on its own.
function routeLegs(p: HookPayload): Leg[] | null {
  const d = p.email_data;
  const action = d.email_action_type;
  const legs: Leg[] = [];
  if (action === "email_change") {
    if (p.user.new_email.trim() === "") return null;
    if (d.token_hash_new !== "" && p.user.email.trim() !== "") {
      // Secure change: the hash fields are "swapped" relative to the address.
      legs.push({ to: p.user.email, hash: d.token_hash_new, code: d.token });
      legs.push({ to: p.user.new_email, hash: d.token_hash, code: d.token_new });
    } else {
      legs.push({ to: p.user.new_email, hash: d.token_hash, code: d.token_new !== "" ? d.token_new : d.token });
    }
  } else if (action === "email_changed_notification") {
    legs.push({ to: d.old_email.trim() !== "" ? d.old_email : p.user.email, hash: "", code: "" });
  } else if (isNotificationAction(action)) {
    legs.push({ to: p.user.email, hash: "", code: "" });
  } else {
    legs.push({ to: p.user.email, hash: d.token_hash, code: d.token });
  }
  const kept = legs.filter((leg) => leg.to.trim() !== "");
  return kept.length > 0 ? kept : null;
}

function subjectFor(action: string): string {
  switch (action) {
    case "recovery":
      return "Reset your password";
    case "signup":
      return "Confirm your email";
    case "invite":
      return "You have been invited to I.M.R";
    case "magiclink":
      return "Your sign-in link";
    case "email":
      return "Your sign-in code";
    case "email_change":
      return "Confirm your email change";
    case "reauthentication":
      return "Your verification code";
    case "password_changed_notification":
      return "Your password was changed";
    case "email_changed_notification":
      return "Your email address was changed";
    case "phone_changed_notification":
      return "Your phone number was changed";
    case "identity_linked_notification":
      return "A sign-in method was linked to your account";
    case "identity_unlinked_notification":
      return "A sign-in method was removed from your account";
    case "mfa_factor_enrolled_notification":
      return "A verification method was added to your account";
    case "mfa_factor_unenrolled_notification":
      return "A verification method was removed from your account";
    default:
      return "Account notification";
  }
}

function parseHttpUrl(s: string): URL | null {
  if (s === "") return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// A redirect target is usable when it parses as a URL and is not a
// script/data/file scheme. Other schemes stay allowed so a future native
// `<scheme>://reset-password` deep link (spec 085 Q1) keeps working. The raw
// string is returned unchanged (link parity with the `{{ .RedirectTo }}`
// template).
function usableRedirect(s: string): string | null {
  if (s === "") return null;
  try {
    const u = new URL(s);
    if (u.protocol === "javascript:" || u.protocol === "data:" || u.protocol === "vbscript:" || u.protocol === "file:") {
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

// The redirect fallback rule, defined once: redirect_to if usable, else
// site_url if usable, else null.
function resolveRedirect(redirectTo: string, siteUrl: string): string | null {
  return usableRedirect(redirectTo) ?? usableRedirect(siteUrl);
}

// D11 — base for GoTrue /verify links. GoTrue's hook site_url is the APP Site
// URL (spec 166 architect m1, proven by smoke S6b on GoTrue v2.189.0), so in
// practice the SUPABASE_URL + "/auth/v1" fallback is the live branch, and it is
// correct for prod (the function's SUPABASE_URL is the project API URL). The
// API-shaped site_url branch (path ends in /auth/v1) remains as a defensive
// branch. Never any other host.
function verifyBase(siteUrl: string, supabaseUrl: string): string | null {
  const site = parseHttpUrl(siteUrl);
  if (site !== null && /\/auth\/v1\/?$/.test(site.pathname)) {
    return site.origin + site.pathname.replace(/\/+$/, "");
  }
  const fn = parseHttpUrl(supabaseUrl);
  if (fn !== null) return fn.origin + fn.pathname.replace(/\/+$/, "") + "/auth/v1";
  return null;
}

// Spec 085 parity: `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`.
function recoveryLink(redirectTo: string, siteUrl: string, hash: string): string | null {
  if (hash === "") return null;
  const base = resolveRedirect(redirectTo, siteUrl);
  if (base === null) return null;
  const sep = base.indexOf("?") >= 0 ? "&" : "?";
  return base + sep + "token_hash=" + encodeURIComponent(hash) + "&type=recovery";
}

// Mirrors GoTrue's default {{ .ConfirmationURL }}.
function verifyLink(base: string, hash: string, action: string, redirectTo: string): string {
  return (
    base +
    "/verify?token=" +
    encodeURIComponent(hash) +
    "&type=" +
    encodeURIComponent(action) +
    "&redirect_to=" +
    encodeURIComponent(redirectTo)
  );
}

function introFor(action: string, newEmail: string): string {
  switch (action) {
    case "recovery":
      return "We received a request to reset the password for your I.M.R account. Use the link below to choose a new password.";
    case "signup":
      return "Confirm your email address to finish setting up your I.M.R account.";
    case "invite":
      return "You have been invited to join I.M.R. Use the link below to accept the invitation and set up your account.";
    case "magiclink":
      return "Use the link below to sign in to I.M.R.";
    case "email":
      return "Use the code below to sign in to I.M.R.";
    case "email_change":
      return "Confirm that you want to change the email address on your I.M.R account to " + newEmail + ".";
    case "reauthentication":
      return "Enter this code in I.M.R to confirm it is you.";
    default:
      if (isNotificationAction(action)) {
        return subjectFor(action) + ". If you did not make this change, contact your administrator right away.";
      }
      return "There is an update about your I.M.R account.";
  }
}

function linkLabelFor(action: string): string {
  switch (action) {
    case "recovery":
      return "Set a new password";
    case "signup":
      return "Confirm email";
    case "invite":
      return "Accept invitation";
    case "magiclink":
    case "email":
      return "Sign in";
    case "email_change":
      return "Confirm email change";
    default:
      return "Open link";
  }
}

type LinkAndCode = { link: string; code: string };
type RenderedBody = { subject: string; html: string; text: string };

// Why the action types differ (spec 166 §3.3):
//   * recovery: the spec 085 link <redirect>?token_hash=…&type=recovery, which
//     the app redeems itself, NOT a /verify link; no code.
//   * reauthentication: code only; GoTrue has no /verify link for it.
//   * signup / invite: link-only (/verify). With no hash the mail is useless,
//     so it is unlinkable rather than an empty notice.
//   * *_notification: a plain notice with no link and no code (routeLegs also
//     blanks both).
//   * magiclink / email / email_change / unknown future types: a /verify link
//     when a hash exists AND the code when present.
// null = unlinkable (planMails → 500 "delivery failed").
function resolveLinkAndCode(action: string, leg: Leg, d: HookEmailData, supabaseUrl: string): LinkAndCode | null {
  if (action === "recovery") {
    const link = recoveryLink(d.redirect_to, d.site_url, leg.hash);
    if (link === null) return null;
    return { link, code: "" };
  }
  if (action === "reauthentication") return { link: "", code: leg.code };
  if (isNotificationAction(action)) return { link: "", code: "" };
  const linkOnly = action === "signup" || action === "invite";
  if (leg.hash === "") return linkOnly ? null : { link: "", code: leg.code };
  const base = verifyBase(d.site_url, supabaseUrl);
  const redirect = resolveRedirect(d.redirect_to, d.site_url);
  if (base === null || redirect === null) return null;
  return { link: verifyLink(base, leg.hash, action, redirect), code: linkOnly ? "" : leg.code };
}

// Subject + HTML/Text body for one mail. An empty link or code is omitted.
function renderBody(action: string, newEmail: string, link: string, code: string): RenderedBody {
  const subject = subjectFor(action);
  const intro = introFor(action, newEmail);
  const label = linkLabelFor(action);

  const html: string[] = [];
  html.push('<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f6;">');
  html.push(
    '<div style="max-width:520px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;background:#ffffff;">',
  );
  html.push('<h2 style="margin:0 0 16px;font-size:20px;">I.M.R</h2>');
  html.push('<p style="margin:0 0 16px;line-height:1.5;">' + escapeHtml(intro) + "</p>");
  if (link !== "") {
    html.push(
      '<p style="margin:0 0 16px;"><a href="' +
        escapeHtml(link) +
        '" style="display:inline-block;padding:10px 18px;background:#111;color:#ffffff;text-decoration:none;border-radius:6px;">' +
        escapeHtml(label) +
        "</a></p>",
    );
    html.push(
      '<p style="margin:0 0 16px;font-size:12px;color:#555;word-break:break-all;">If the button does not work, open this link: ' +
        escapeHtml(link) +
        "</p>",
    );
  }
  if (code !== "") {
    html.push('<p style="margin:0 0 16px;">Your code: <strong style="font-size:18px;letter-spacing:2px;">' + escapeHtml(code) + "</strong></p>");
  }
  if (!isNotificationAction(action)) {
    html.push('<p style="margin:0 0 16px;font-size:12px;color:#555;">If you did not request this, you can safely ignore this email.</p>');
  }
  html.push('<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px;">');
  html.push('<p style="margin:0;font-size:12px;color:#888;">' + escapeHtml(HOOK_FOOTER) + "</p>");
  html.push("</div></body></html>");

  const text: string[] = ["I.M.R", "", intro, ""];
  if (link !== "") text.push(label + ": " + link, "");
  if (code !== "") text.push("Your code: " + code, "");
  if (!isNotificationAction(action)) text.push("If you did not request this, you can safely ignore this email.", "");
  text.push("--", HOOK_FOOTER);

  return { subject, html: html.join("\n"), text: text.join("\n") };
}

function renderMail(action: string, leg: Leg, p: HookPayload, supabaseUrl: string): PlannedMail | null {
  const lc = resolveLinkAndCode(action, leg, p.email_data, supabaseUrl);
  if (lc === null) return null;
  const b = renderBody(action, p.user.new_email, lc.link, lc.code);
  return { to: leg.to.trim(), subject: b.subject, html: b.html, text: b.text };
}

// Routes the legs, DROPS placeholder legs before any render, then renders only
// the surviving real legs.
function planMails(p: HookPayload, supabaseUrl: string): Plan {
  const legs = routeLegs(p);
  if (legs === null) return { ok: false, reason: "invalid_payload" };
  const action = p.email_data.email_action_type;
  const real: Leg[] = [];
  let dropped = 0;
  for (const leg of legs) {
    if (isPlaceholderEmail(leg.to)) dropped += 1;
    else real.push(leg);
  }
  const mails: PlannedMail[] = [];
  for (const leg of real) {
    const mail = renderMail(action, leg, p, supabaseUrl);
    if (mail === null) return { ok: false, reason: "unlinkable" };
    mails.push(mail);
  }
  return { ok: true, action, mails, dropped };
}

function logAction(action: unknown): string {
  return typeof action === "string" && /^[a-z_]{1,64}$/.test(action) ? action : "unknown";
}

// "v1,whsec_<base64>" parts separated by "|" (rotation). Returns the base64
// parts (prefix stripped), or null when unset or ANY part is malformed. A part
// must also be strict padded base64 (length % 4 === 0 and atob-decodable, so
// no misplaced "="): a mis-pasted secret then fails closed as 500 "hook
// misconfigured" instead of masquerading as a 401 "invalid signature".
function parseHookSecrets(raw: string | undefined): string[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  const out: string[] = [];
  for (const part of raw.split("|")) {
    const m = /^v1,whsec_([A-Za-z0-9+/=]{32,88})$/.exec(part);
    if (m === null || m[1].length % 4 !== 0) return null;
    try {
      atob(m[1]);
    } catch {
      return null;
    }
    out.push(m[1]);
  }
  return out;
}

// ---- Standard Webhooks verification (spec 169) ----------------------------
// Everything from here to verifyWebhook is the verifier group: behavioural
// parity with standardwebhooks@1.0.0 Webhook.verify, built on WebCrypto
// (crypto.subtle) so the function has no third-party import. The clock is a
// parameter so jest can pin the ±300 s boundaries; the caller passes the real
// clock.

// Accepted clock skew either side of nowSeconds, inclusive.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// The JS Date range in seconds (8.64e15 ms either side of the epoch). The
// clock guard in verifyWebhook keeps nowSeconds within this range less the
// tolerance, so every accepted timestamp lies inside the JS Date range too,
// which is what makes the signed text equal the library's.
const MAX_DATE_SECONDS = 8.64e12;

// Header record as received; names are matched case-insensitively.
type WebhookHeaders = Record<string, string | undefined>;

// Strict padded base64 → bytes. Throws unless [A-Za-z0-9+/]+ with at most two
// trailing "=" and length % 4 === 0 (the parseHookSecrets shape). On that set
// atob gives the same bytes as @stablelib/base64@1.0.1 (both drop
// non-canonical trailing bits).
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new Error("bad base64");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Standard padded base64 of raw bytes.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Constant-time compare of the UTF-8 bytes of two strings; a length mismatch
// is false at once (signature length is public).
function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// base64(HMAC-SHA256(key, "<id>.<timestamp>.<body>")), UTF-8, without the
// "v1," prefix. May throw (bad key); verifyWebhook treats that as a non-match.
// Only typed-array views are handed to crypto.subtle (never a bare buffer).
async function signWebhook(secret: string, msgId: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msgId + "." + timestamp + "." + body));
  return bytesToBase64(new Uint8Array(mac));
}

// Standard Webhooks gate: true iff the request carries a fresh signature made
// with ANY of `secrets`. Never throws or rejects: any error is false.
//
// Accepts only when all of these hold:
//   - webhook-id, webhook-timestamp and webhook-signature are present and
//     non-empty (header names are case-insensitive);
//   - the parsed timestamp is within ±300 s of nowSeconds, inclusive;
//   - some "v1,<sig>" entry equals the expected signature under some secret
//     (secrets tried in order);
//   - the body is JSON.
//
// Library quirks replicated on purpose (each also noted at its line):
//   - parseInt timestamp: the header is read with parseInt(_, 10) and the
//     signed text uses that parsed integer, never the raw header text;
//   - lax commas: only the first two comma fields of an entry count, and a
//     comma-less "v1" is an empty, never-matching candidate;
//   - non-JSON → 401: a correctly signed non-JSON body is a verify failure
//     (401), not a 400 from the payload-shape step.
//
// Any divergence from the library must be fail-closed: reject where the
// library would accept, never accept where it would reject.
async function verifyWebhook(
  secrets: readonly string[],
  body: string,
  headers: WebhookHeaders,
  nowSeconds: number,
): Promise<boolean> {
  try {
    // A non-integer or out-of-range clock would open both bounds: refuse.
    if (
      !Number.isSafeInteger(nowSeconds) ||
      Math.abs(nowSeconds) > MAX_DATE_SECONDS - WEBHOOK_TOLERANCE_SECONDS
    ) {
      return false;
    }
    const lowered = new Map<string, string | undefined>();
    for (const k of Object.keys(headers)) lowered.set(k.toLowerCase(), headers[k]);
    const msgId = lowered.get("webhook-id");
    const msgTs = lowered.get("webhook-timestamp");
    const msgSig = lowered.get("webhook-signature");
    if (
      typeof msgId !== "string" || msgId === "" ||
      typeof msgTs !== "string" || msgTs === "" ||
      typeof msgSig !== "string" || msgSig === ""
    ) {
      return false;
    }
    // parseInt on purpose (library parity): "1700000000abc" parses to
    // 1700000000, and the signed text below uses this parsed integer, never
    // the raw header. Tightening it (Number(), a digits-only regex) would
    // break parity with the library.
    const ts = parseInt(msgTs, 10);
    if (Number.isNaN(ts)) return false;
    if (nowSeconds - ts > WEBHOOK_TOLERANCE_SECONDS) return false; // too old
    if (ts > nowSeconds + WEBHOOK_TOLERANCE_SECONDS) return false; // too new
    // Lax like the library: only parts[0] and parts[1] count, so
    // "v1,<sig>,extra" still offers <sig>, and a comma-less "v1" becomes an
    // empty candidate that never equals a 44-character MAC. The lax shape also
    // tolerates GoTrue's ", " join of a repeated signature header.
    const candidates: string[] = [];
    for (const entry of msgSig.split(" ")) {
      const parts = entry.split(",");
      if (parts[0] !== "v1") continue;
      candidates.push(parts.length > 1 ? parts[1] : "");
    }
    for (const secret of secrets) {
      // null sentinel, never "": a failed signing must not match a "v1," entry.
      let expected: string | null = null;
      try {
        expected = await signWebhook(secret, msgId, ts, body);
      } catch {
        expected = null;
      }
      if (expected === null) continue;
      for (const candidate of candidates) {
        if (timingSafeEqualString(candidate, expected)) {
          // The library JSON-parses the payload after a match, so a signed
          // non-JSON body is a verify failure (401), not a 400 from the
          // payload-shape step. The parse result is discarded on purpose.
          // Returning false here instead of trying the next secret is
          // equivalent: whether the body parses does not depend on the secret.
          try {
            JSON.parse(body);
            return true;
          } catch {
            return false;
          }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// D7 tripwire: the committed local dev secret is public by design.
function isLocalDevSecret(raw: string): boolean {
  return raw.indexOf("LOCAL/DEV/ONLY") >= 0;
}

function resolveTransport(env: {
  transport?: string;
  from?: string;
  fromName?: string;
  resendApiKey?: string;
  mailpitUrl?: string;
  hookSecretRaw?: string;
}): TransportConfig | null {
  const from = env.from ?? "";
  const fromName = env.fromName ?? "";
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(from)) return null;
  if (/[<>"\r\n]/.test(fromName)) return null;
  if (env.transport === "mailpit") {
    const url = env.mailpitUrl ?? "";
    if (parseHttpUrl(url) === null) return null;
    return { kind: "mailpit", url, from, fromName };
  }
  if (env.transport === "resend") {
    const apiKey = env.resendApiKey ?? "";
    if (apiKey === "") return null;
    if (/@resend\.dev$/i.test(from)) return null;
    if (isLocalDevSecret(env.hookSecretRaw ?? "")) return null;
    return { kind: "resend", apiKey, from, fromName };
  }
  return null;
}

function buildTransportRequest(
  cfg: TransportConfig,
  mail: PlannedMail,
  idempotencyKey: string,
): { url: string; headers: Record<string, string>; body: string } {
  if (cfg.kind === "mailpit") {
    const fromObj: Record<string, string> = { Email: cfg.from };
    if (cfg.fromName !== "") fromObj.Name = cfg.fromName;
    return {
      url: cfg.url,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: fromObj,
        To: [{ Email: mail.to }],
        Subject: mail.subject,
        HTML: mail.html,
        Text: mail.text,
      }),
    };
  }
  return {
    url: RESEND_API_URL,
    headers: {
      Authorization: "Bearer " + cfg.apiKey,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: cfg.fromName !== "" ? cfg.fromName + " <" + cfg.from + ">" : cfg.from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
  };
}

function isTransportSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

// One transport attempt, reduced to runtime-neutral facts: the name of the
// error the network call threw, or the HTTP status it answered with.
type TransportAttempt = { kind: "threw"; errorName: string } | { kind: "status"; status: number };
type DeliveryResult = { ok: true } | { ok: false; reason: "timeout" | "transport"; status?: number };

// A timeout / abort is "timeout"; any other throw is "transport" with no
// status; a non-2xx answer is "transport" with its status.
function classifyDelivery(attempt: TransportAttempt): DeliveryResult {
  if (attempt.kind === "threw") {
    if (attempt.errorName === "TimeoutError" || attempt.errorName === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "transport" };
  }
  if (isTransportSuccess(attempt.status)) return { ok: true };
  return { ok: false, reason: "transport", status: attempt.status };
}
// END auth-email-hook-core (spec 166)

export type {
  HookEmailData,
  HookPayload,
  Leg,
  PlannedMail,
  Plan,
  TransportConfig,
  LinkAndCode,
  RenderedBody,
  TransportAttempt,
  DeliveryResult,
  WebhookHeaders,
};
export {
  RESEND_API_URL,
  parsePayload,
  routeLegs,
  planMails,
  subjectFor,
  verifyBase,
  recoveryLink,
  verifyLink,
  logAction,
  parseHookSecrets,
  isLocalDevSecret,
  resolveTransport,
  buildTransportRequest,
  isTransportSuccess,
  resolveRedirect,
  resolveLinkAndCode,
  renderBody,
  classifyDelivery,
  base64ToBytes,
  timingSafeEqualString,
  signWebhook,
  verifyWebhook,
};
