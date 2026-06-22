# Security audit for spec 098 — staff weekly full-store inventory count

Reviewer: security-auditor
Scope: authn/authz (RLS), new RPCs `submit_weekly_count` / `weekly_count_status`,
`weekly-reminder-cron` edge function, `weekly_reminder_log` RLS, config.toml jwt
posture, input validation, data exposure. Read-only on code.

Verdict: **No Critical findings. Spec is clear to advance from a security standpoint.**
Two Should-fix items (one timing-attack hardening, one cross-store cron data-load
posture) and two Nits.

---

## Critical (BLOCKS merge)

None.

---

## Should-fix (before deploy)

- `supabase/functions/weekly-reminder-cron/index.ts:158` — Shared-bearer comparison
  `token !== want` is a non-constant-time string compare, same as the EOD cron it
  copies. The token is a 32-byte hex secret from `_edge_auth.cron_bearer`, so a
  remote timing attack across the network is impractical, but the CLAUDE.md edge-auth
  convention prefers constant-time comparison for bearer validation. Recommend
  `crypto.subtle.timingSafeEqual`-equivalent (or a length-checked XOR fold over the
  decoded bytes) before `!want` short-circuit. Low exploitability; flagged for parity
  with the project's "constant-time comparison preferred" rule. Note this is a
  pre-existing pattern inherited verbatim from `eod-reminder-cron`, so fixing it here
  without fixing EOD leaves drift — acceptable to defer both to a follow-up if logged.

- `supabase/functions/weekly-reminder-cron/index.ts:239,245` — The cron loads the
  ENTIRE `user_stores` and `push_subscriptions` tables into memory unscoped
  (`select(...)` with no filter), then groups in JS. Functionally correct (runs under
  `service_role`, which legitimately needs cross-store data for a cross-store cron),
  and it mirrors the EOD cron, so this is NOT a leakage finding — service_role is the
  right principal and the data never leaves the function. The concern is denial-of-
  service / memory pressure as `push_subscriptions` grows: an unbounded full-table
  pull on every daily fire. Recommend scoping `push_subscriptions` to the
  recipient set actually being reminded (only stores that are due today and not yet
  completed), or paginating. Should-fix, not Critical: no cross-tenant exposure, only
  a scaling footgun. Same caveat about EOD-cron parity applies.

---

## Nits

- `supabase/functions/weekly-reminder-cron/index.ts:339` — The uncaught-error 500
  envelope returns `stack: e?.stack?.slice(0, 600)`. The caller is always the cron
  holding the valid bearer (a 403 is returned before the try-block at :158), so this
  is not exposed to an unauthenticated client and the stack contains no secrets. Still,
  returning internal stack frames in a response body is a habit worth not forming;
  consider logging server-side and returning a generic `error` string. Informational.

- `supabase/migrations/20260622090000_weekly_count_kind_and_cadence.sql:290` — The
  `weekly_count_status` completed-test compares `(c.counted_at at time zone 'America/New_York')::date`
  against the window. This is the documented single-TZ assumption (design §9, matches
  the EOD cron). Not a security issue; noting it produces a window-boundary skew for
  any future non-Eastern store, which could cause a store to read `completed`/`overdue`
  one day off. Flagged as the known v1 limitation, not a finding.

---

## Confirmations (explicitly verified, all PASS)

- **Generic `submit_inventory_count` STILL rejects `'weekly'`.** Allowlist at
  `supabase/migrations/20260513000000_inventory_counts.sql:262` remains
  `('spot','open','mid_shift','close')`. The column CHECK was widened to admit
  `'weekly'` (`20260622090000:52-54`) but the generic RPC's in-body allowlist is
  unchanged, and a dedicated pgTAP regression (`submit_inventory_count_rejects_weekly.test.sql`)
  asserts 22023. Defense-in-depth intact — staff `'weekly'` rows can only be minted
  through `submit_weekly_count`. PASS.

- **`submit_weekly_count` — server-canonical attribution + auth gate + no escalation.**
  - Auth gate FIRST: `if not auth_can_see_store(p_store_id) then raise 42501`
    (`20260622090000:91-94`) — before any insert. Cross-store submit rejected.
  - `submitted_by = auth.uid()` hard-coded at insert (`:129`); no `submitted_by` /
    `kind` / `status` parameter is exposed to the client → no attribution forgery, no
    kind smuggling. `kind` is literal `'weekly'` (`:128`).
  - SECURITY INVOKER + `REVOKE EXECUTE FROM public, anon` + `GRANT TO authenticated`
    (`:198-199`). The revoke-from-public is present and load-bearing (anon inherits
    PUBLIC). PASS.
  - No `UPDATE inventory_items` anywhere in the body (advisory-snapshot guarantee).
    PASS.

- **Idempotency.** Store-scoped `(store_id, client_uuid)` lookup returns the existing
  row with `conflict:true` (`:106-118`), reusing the existing partial-unique index. A
  cross-store UUID collision returns the in-store match, not a 23505 leak. PASS.

- **Input validation in `submit_weekly_count`.** Non-empty JSON-array check →22023
  (`:98-102`); non-negative qty →22023 (`:153-157`); item-in-store check →23503
  (`:159-165`, prevents writing entries for another store's items even within an
  authorized store call); ≥1 non-blank required →22023 (`:182-184`). Entries are bound
  via `jsonb_to_recordset` (typed columns) — no dynamic SQL, no `EXECUTE`, no SQLi
  surface. PASS.

- **`weekly_count_status` — no cross-store leakage.** SECURITY INVOKER; the `scoped`
  CTE reads `public.stores` (clipped by `store_member_read_stores` /
  `auth_can_see_store`) and the lateral join reads `inventory_counts` (four-policy
  `auth_can_see_store` template). A staff caller passing another store's id gets no row
  (RLS clips the `stores` read); `p_store_id = null` returns only stores the caller can
  see. No privilege escalation — admins see all visible stores via
  `auth_can_see_store`'s admin short-circuit, staff see only `user_stores` stores.
  Pure read, `REVOKE FROM public, anon` + `GRANT TO authenticated` (`:312-313`). PASS.

- **`weekly-reminder-cron` — verify_jwt + shared-bearer gate.** `config.toml`
  (`:441-442`) pins `[functions.weekly-reminder-cron] verify_jwt = false`, and the
  parity pin for `eod-reminder-cron` (`:438-439`) also landed. The function validates
  the shared bearer itself (`:155-160`) via the `_edge_auth.cron_bearer` lookup under
  service_role — `_edge_auth` is RLS-enabled with NO permissive policy
  (`20260424211733_security_fixes.sql:139-148`), so anon/authenticated callers cannot
  read it and cannot forge the token. A 403 is returned before any work. This is NOT a
  per-user JWT and there is no auth-bypass path. PASS.

- **`weekly-reminder-cron` — escapeHtml on HTML body.** Inline five-char `escapeHtml`
  (`:34-41`) matches the canonical shape. Both interpolations in the HTML email body
  are wrapped: `escapeHtml(pushBody)` and `escapeHtml(APP_URL)` (`:310-311`). The
  subject (`:315`) and `to` address (`:213`) are not HTML and correctly unwrapped. The
  push payload (`:303-308`) is JSON, not HTML. PASS. (Notably the dev did NOT replicate
  the EOD cron's pre-existing un-escaped store-name gap.)

- **`weekly-reminder-cron` — no role gate needed / no destructive op.** The function
  is not user-invoked, gates on the shared bearer (not caller role), and performs no
  role-change / deletion. The `ADMIN_ROLES`/`auth_is_privileged` mirror rule and the
  last-of-role / self-guard rules do not apply. Recipient targeting unions
  `user_stores` members with `profiles.role in ('admin','master')` (`:226`) — this is
  recipient selection, not a caller role gate, so the `super_admin` omission here is
  cosmetic for *who gets reminded* (a super_admin who is not also a store member or
  admin/master would not receive a reminder), NOT a privilege issue. Low impact;
  noting for completeness, not raising as a finding since the spec scope is staff
  reminders and store membership is the eligibility basis.

- **`weekly_reminder_log` RLS.** Table is RLS-enabled (`20260622090100:45`) with a
  single SELECT policy scoped via `auth_can_see_store(store_id)` (`:50-52`) — no
  authenticated/anon caller can read another store's log. No insert/update/delete
  policy for authenticated, so only the cron (service_role, bypasses RLS) writes; a
  non-service caller cannot forge log rows. This is the deliberate 3-fewer-policies
  narrowing (mirrors `eod_reminder_log`), flagged in the design and confirmed correct.
  `revoke all from anon` (`:57`) present. PASS.

- **Permissive-policy lint (spec 051/053).** The single new permissive policy
  (`weekly_reminder_log_read`) uses `auth_can_see_store(store_id)`, NOT a trivially-wide
  predicate (`true` / `auth.uid() IS NOT NULL` / `auth.role()='authenticated'`), so it
  needs no spec-053 allowlist entry and does not neutralize any sibling scoped policy
  (it is the only policy on the table). No new permissive policy on any shared table
  (`stores`, `inventory_counts`, etc.) — the cadence column reuses the existing
  `privileged_update_stores` policy. PASS.

- **Admin cadence write authorization.** `updateStore(id, { weeklyCountDueDow })`
  (`src/lib/db.ts:96-107`) PATCHes `weekly_count_due_dow` through the existing
  `privileged_update_stores` policy (`auth_is_privileged() AND auth_can_see_brand`) —
  no new policy, correctly admin+brand gated server-side. The DB CHECK
  (`weekly_count_due_dow between 0 and 6`, `20260622090000:62-63`) bounds the value.
  The admin slice (`src/store/useStore.ts:2005-2026`) does NOT use the client-side
  `useRole()` value as a security boundary — enforcement is server-side RLS. PASS.

- **Staff write path attribution.** `useStaffStore.submitWeeklyCount`
  (`src/screens/staff/store/useStaffStore.ts:210-241`) calls `submit_weekly_count`
  with a client-minted `client_uuid` and `p_store_id`; it does NOT pass `submitted_by`
  or `kind` (the client cannot forge attribution — those are server-canonical in the
  RPC). PASS.

- **Secret handling.** No secret is logged. Service-role key, `cron_bearer`,
  `VAPID_PRIVATE`, and `RESEND_API_KEY` all come from `Deno.env.get(...)` /
  service-role-only DB reads and never appear in `console.*` or response bodies
  (verified `weekly-reminder-cron/index.ts:122,127,209,235` log only status codes,
  truncated Resend body text, user ids, and column error messages). No
  `EXPO_PUBLIC_*` secret introduced. PASS.

---

## Dependencies

No `package.json` / `package-lock.json` changes in this spec — `npm audit` skipped.
