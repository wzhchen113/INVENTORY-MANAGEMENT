// supabase/functions/auth-email-hook/index.ts
//
// Spec 166 — GoTrue "Send Email" auth hook. When enabled, GoTrue stops sending
// mail itself (no SMTP, no templates) and POSTs every auth email to this
// function as { user, email_data }. The function renders and delivers every
// non-placeholder mail itself, and DROPS any recipient that is a spec 165
// username-only placeholder address — closing spec 165 security finding M1
// (anyone with the anon key could make GoTrue send guaranteed hard bounces via
// POST /auth/v1/recover) and L1 (security notifications to placeholders).
//
// AUTH POSTURE — event-driven, NOT a user-invoked privileged op. GoTrue signs
// each call with a Standard Webhooks signature (SEND_EMAIL_HOOK_SECRET,
// "v1,whsec_<base64>", "|"-separated for rotation). verify_jwt = false is
// pinned in config.toml because there is no Supabase JWT; the signature check
// below REPLACES the gateway JWT check and FAILS CLOSED (secret unset or
// malformed → 500; missing / wrong / stale signature → 401). There is
// deliberately NO ADMIN_ROLES gate — there is no caller JWT to gate on.
//
// CONTRACT (spec 166 §3): POST only (405 otherwise); body > 64 KiB → 413;
// signed-but-malformed → 400; every leg a placeholder → 200 {} (nothing sent);
// all real legs handed to the transport with 2xx → 200 {}. A real recipient is
// NEVER answered with 200 unless the transport accepted it (D4): transport
// misconfigured / provider non-2xx / timeout / network error → 500, which
// GoTrue surfaces exactly like an SMTP failure today. 429/503 are never
// returned because GoTrue retries those (duplicate-send risk).
// Partial send is possible and intended: on a secure email_change with two
// real legs, leg 0 can be delivered and leg 1 fail → 500 after one mail has
// gone out. Do not "fix" this by answering 200 (D4). A GoTrue retry of the
// same webhook-id re-sends leg 0 with the same Idempotency-Key
// (<webhook-id>:0), which Resend de-duplicates (D13).
//
// ANTI-ENUMERATION: a dropped placeholder answers 200 {} — the same as a real
// send — so /auth/v1/recover keeps returning an identical 200 for placeholder,
// real and non-existent addresses.
//
// LOG HYGIENE: exactly one JSON line per request with the fixed key set
// { hook, action, outcome, recipients, dropped, status?, reason? }. Never
// logged: the body, any token / token hash / link, any address, user.id, the
// webhook-id, provider response bodies, or e.message.
//
// The spec 165 placeholder block, escapeHtml, and the spec 166 core block
// below are BYTE-IDENTICAL copies of src/lib/placeholderEmail.ts,
// src/utils/escapeHtml.ts and src/lib/authEmailHook.ts — enforced by
// src/lib/placeholderEmail.parity.test.ts and src/lib/authEmailHook.parity.test.ts
// (inline-not-shared, spec 027 §4.2).

// Transitive deps pinned with ?deps= (security L5): standardwebhooks@1.0.0
// declares @stablelib/base64 ^1.0.0 and fast-sha256 ^1.3.0, which esm.sh would
// otherwise resolve at deploy time. Versions = what those ranges resolved to on
// 2026-10-19 (npm view + esm.sh). Follow-up: npm: specifier + deno.lock.
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0?deps=@stablelib/base64@1.0.1,fast-sha256@1.3.0";

const SEND_EMAIL_HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET") ?? "";
const SEND_EMAIL_TRANSPORT = Deno.env.get("SEND_EMAIL_TRANSPORT") ?? "";
const SEND_EMAIL_FROM = Deno.env.get("SEND_EMAIL_FROM") ?? "";
const SEND_EMAIL_FROM_NAME = Deno.env.get("SEND_EMAIL_FROM_NAME") ?? "";
const MAILPIT_SEND_URL = Deno.env.get("MAILPIT_SEND_URL") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

const MAX_BODY_BYTES = 64 * 1024;
const TRANSPORT_TIMEOUT_MS = 2000;

// Spec 165 §3.2 — placeholder-email predicate. Byte-identical copy of the
// canonical block in src/lib/placeholderEmail.ts (parity-tested).
// BEGIN placeholder-email (spec 165)
const PLACEHOLDER_EMAIL_RE = /^u-[0-9a-f]{32}@no-email\.invalid$/;
function isPlaceholderEmail(email: unknown): boolean {
  return typeof email === "string" && PLACEHOLDER_EMAIL_RE.test(email.trim().toLowerCase());
}
// END placeholder-email (spec 165)

// Spec 028: HTML-escape EVERY interpolated value into the email body. Inlined
// per spec 028 §3 (not shared via _shared/) because `supabase functions deploy
// <name>` ships one function at a time and a shared module is invisible drift
// surface. Byte-identical mirror at src/utils/escapeHtml.ts.
function escapeHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

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

// D11 — base for GoTrue /verify links: the payload's site_url when it is the
// API external URL (path ends in /auth/v1), else the function's own
// SUPABASE_URL + "/auth/v1". Never any other host.
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
  const base = usableRedirect(redirectTo) ?? usableRedirect(siteUrl);
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

function renderMail(action: string, leg: Leg, p: HookPayload, supabaseUrl: string): PlannedMail | null {
  const d = p.email_data;
  let link = "";
  let code = "";
  if (action === "recovery") {
    const l = recoveryLink(d.redirect_to, d.site_url, leg.hash);
    if (l === null) return null;
    link = l;
  } else if (action === "reauthentication") {
    code = leg.code;
  } else if (isNotificationAction(action)) {
    // Plain notice: no link, no code.
  } else {
    // signup / invite are link-only: without a hash the mail is useless, so it
    // fails loudly (unlinkable) instead of shipping an empty notice.
    if ((action === "signup" || action === "invite") && leg.hash === "") return null;
    if (leg.hash !== "") {
      const base = verifyBase(d.site_url, supabaseUrl);
      const redirect = usableRedirect(d.redirect_to) ?? usableRedirect(d.site_url);
      if (base === null || redirect === null) return null;
      link = verifyLink(base, leg.hash, action, redirect);
    }
    // magiclink / email / email_change / unknown future types also show the
    // code when present; signup and invite are link-only.
    if (action !== "signup" && action !== "invite") code = leg.code;
  }
  const subject = subjectFor(action);
  const intro = introFor(action, p.user.new_email);
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

  return { to: leg.to.trim(), subject, html: html.join("\n"), text: text.join("\n") };
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
// END auth-email-hook-core (spec 166)

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type LogReason = "signature" | "payload" | "config" | "transport" | "timeout" | "unlinkable" | "size";

// Exactly one line per request. Every field is a sanitized enum or a count.
function logOutcome(entry: {
  action: string;
  outcome: "sent" | "dropped" | "failed" | "rejected";
  recipients: number;
  dropped: number;
  status?: number;
  reason?: LogReason;
}): void {
  const line: Record<string, string | number> = {
    hook: "auth-email-hook",
    action: entry.action,
    outcome: entry.outcome,
    recipients: entry.recipients,
    dropped: entry.dropped,
  };
  if (typeof entry.status === "number") line.status = entry.status;
  if (entry.reason !== undefined) line.reason = entry.reason;
  console.log(JSON.stringify(line));
}

function verifySignature(secrets: string[], body: string, headers: Record<string, string>): boolean {
  for (const secret of secrets) {
    try {
      new Webhook(secret).verify(body, headers);
      return true;
    } catch {
      // try the next secret (rotation); never log the error detail
    }
  }
  return false;
}

Deno.serve(async (req: Request): Promise<Response> => {
  let action = "unknown";
  let recipients = 0;
  let dropped = 0;
  try {
    // 1. Method.
    if (req.method !== "POST") {
      logOutcome({ action, outcome: "rejected", recipients, dropped });
      return jsonResponse(405, { error: "method not allowed" });
    }

    // 2. Secret (fail closed).
    const secrets = parseHookSecrets(SEND_EMAIL_HOOK_SECRET);
    if (secrets === null) {
      logOutcome({ action, outcome: "failed", recipients, dropped, reason: "config" });
      return jsonResponse(500, { error: "hook misconfigured" });
    }

    // 3. Size guard, before the HMAC. A declared Content-Length over the cap is
    // refused BEFORE buffering the body; the post-read byte check still covers
    // chunked / absent Content-Length.
    const declaredLength = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      logOutcome({ action, outcome: "rejected", recipients, dropped, reason: "size" });
      return jsonResponse(413, { error: "payload too large" });
    }
    const body = await req.text();
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      logOutcome({ action, outcome: "rejected", recipients, dropped, reason: "size" });
      return jsonResponse(413, { error: "payload too large" });
    }

    // 4. Standard Webhooks signature (constant-time compare + ±5 min tolerance).
    const headers = Object.fromEntries(req.headers);
    if (!verifySignature(secrets, body, headers)) {
      logOutcome({ action, outcome: "rejected", recipients, dropped, reason: "signature" });
      return jsonResponse(401, { error: "invalid signature" });
    }

    // 5. Payload shape.
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      raw = null;
    }
    const payload = parsePayload(raw);
    if (payload === null) {
      logOutcome({ action, outcome: "rejected", recipients, dropped, reason: "payload" });
      return jsonResponse(400, { error: "invalid payload" });
    }
    action = logAction(payload.email_data.email_action_type);

    // 6. Route, drop placeholders BEFORE render, render the real legs.
    const plan = planMails(payload, SUPABASE_URL);
    if (!plan.ok) {
      if (plan.reason === "invalid_payload") {
        logOutcome({ action, outcome: "rejected", recipients, dropped, reason: "payload" });
        return jsonResponse(400, { error: "invalid payload" });
      }
      logOutcome({ action, outcome: "failed", recipients, dropped, reason: "unlinkable" });
      return jsonResponse(500, { error: "delivery failed" });
    }
    recipients = plan.mails.length;
    dropped = plan.dropped;

    // 7. Every leg was a placeholder: nothing to send, same 200 as a send.
    if (plan.mails.length === 0) {
      logOutcome({ action, outcome: "dropped", recipients, dropped });
      return jsonResponse(200, {});
    }

    // 8. Transport config (fail closed for real recipients).
    const cfg = resolveTransport({
      transport: SEND_EMAIL_TRANSPORT,
      from: SEND_EMAIL_FROM,
      fromName: SEND_EMAIL_FROM_NAME,
      resendApiKey: RESEND_API_KEY,
      mailpitUrl: MAILPIT_SEND_URL,
      hookSecretRaw: SEND_EMAIL_HOOK_SECRET,
    });
    if (cfg === null) {
      logOutcome({ action, outcome: "failed", recipients, dropped, reason: "config" });
      return jsonResponse(500, { error: "delivery failed" });
    }

    // 9. Deliver sequentially (worst case ~2 × 2 s, inside GoTrue's hook timeout).
    const webhookId = req.headers.get("webhook-id") ?? "";
    for (let i = 0; i < plan.mails.length; i++) {
      const r = buildTransportRequest(cfg, plan.mails[i], webhookId + ":" + i);
      let res: Response;
      try {
        res = await fetch(r.url, {
          method: "POST",
          headers: r.headers,
          body: r.body,
          signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS),
        });
      } catch (e) {
        const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
        logOutcome({ action, outcome: "failed", recipients, dropped, reason: timedOut ? "timeout" : "transport" });
        return jsonResponse(500, { error: "delivery failed" });
      }
      // Never read the provider body into a log; just release it.
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      if (!isTransportSuccess(res.status)) {
        logOutcome({ action, outcome: "failed", recipients, dropped, status: res.status, reason: "transport" });
        return jsonResponse(500, { error: "delivery failed" });
      }
    }

    // 10. All sent.
    logOutcome({ action, outcome: "sent", recipients, dropped });
    return jsonResponse(200, {});
  } catch {
    // Spec 165 §4.5 precedent: never echo e.message.
    logOutcome({ action, outcome: "failed", recipients, dropped });
    return jsonResponse(500, { error: "internal error" });
  }
});
