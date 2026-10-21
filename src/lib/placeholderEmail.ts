// src/lib/placeholderEmail.ts
//
// Spec 165 §3.2 — the ONE predicate that decides "this auth account is a
// username-only store user" (no real inbox). Accounts created by the
// `manage-store-user` edge function get a synthetic, non-deliverable address
// of the shape `u-<32 lowercase hex>@no-email.invalid` (RFC 2606 / RFC 6761
// reserve `.invalid`, so it can never be delivered).
//
// Inline-not-shared (spec 027 §4.2): the block between the BEGIN/END markers
// below is copied BYTE-IDENTICALLY into five Deno edge functions —
//   supabase/functions/manage-store-user/index.ts
//   supabase/functions/eod-reminder-cron/index.ts
//   supabase/functions/weekly-reminder-cron/index.ts
//   supabase/functions/send-welcome-email/index.ts
//   supabase/functions/auth-email-hook/index.ts (spec 166)
// — and src/lib/placeholderEmail.parity.test.ts fails the build on any drift.
// `export` stays OUTSIDE the block so the Deno copies can be module-private.
//
// Client screens must NOT call this to decide display — they read
// `User.loginKind` (set at the data layer). No other code may test for
// `no-email.invalid` / `.invalid` directly.
//
// Pure TS, no React / RN imports, so it lives in the fast node-env jest
// project.

// BEGIN placeholder-email (spec 165)
const PLACEHOLDER_EMAIL_RE = /^u-[0-9a-f]{32}@no-email\.invalid$/;
function isPlaceholderEmail(email: unknown): boolean {
  return typeof email === "string" && PLACEHOLDER_EMAIL_RE.test(email.trim().toLowerCase());
}
// END placeholder-email (spec 165)

export { PLACEHOLDER_EMAIL_RE, isPlaceholderEmail };
