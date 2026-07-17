# Security audit for spec 126

Staff "report-an-issue" → admin notification bell (`'issue'` type). The crux is
the anti-forgery boundary on a NEW staff-invokable write path that emits
notifications into admins'/super-admins' bells. Reviewed the migration, the RPC,
the edge-function issue branch, the staff carve-out helper, the admin bell
render, and the supporting RLS helpers.

Verdict: **no Critical, no High.** The forgery surface collapses cleanly to a
single server-side gate and the notification cannot be steered cross-brand or
mistyped by the client.

---

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `supabase/migrations/20260720000000_staff_reports_issue_notifications.sql:167-186`
  — no rate limit on `submit_staff_report`. A staff user can file arbitrarily
  many reports; each emits a `notifications` row and a `submission-push-fanout`
  enqueue that pushes to the brand's admins/masters AND every `super_admin`
  across all brands (`submission-push-fanout/index.ts:133-141`). This is a
  notification-spam / mild-DoS vector, not a data or privilege issue — human-paced
  in practice, and the message is bounded to 2000 chars. Acceptable for v1; note
  as backlog if abuse is observed.
- `supabase/functions/submission-push-fanout/index.ts:91` — the shared-bearer
  check uses a non-constant-time `token !== want` comparison. This is
  PRE-EXISTING spec-120 code (this spec only added the `issue` branch, not the
  gate) and is called out only for completeness; not a regression introduced
  here. The table backing the bearer is service-role-only, so the practical
  attack surface is low.

---

### Focus-area findings

**1. `submit_staff_report` RPC — anti-forgery (the crux): PASS**
- `security definer` with `set search_path = public` pinned
  (`20260720000000_...sql:125-126`). Good.
- `auth_can_see_store(p_store_id)` fires FIRST, before any write, raising `42501`
  (→ HTTP 403) on failure (`:137-140`). A staff member cannot file against a
  store/brand they don't belong to. `auth_can_see_store`
  (`20260517040000_...sql:88-108`) admits only super_admin, same-brand admin, or a
  `user_stores` membership row — and cross-brand `user_stores` is trigger-blocked
  (`20260509000000_...`), so the brand a report lands in is always the caller's own.
- `brand_id` and `store_name` are derived server-side from the `stores` row
  (`:156-157`); `reporter_name` from `profiles` at `auth.uid()` (`:163-164`);
  `reporter_user_id` = `auth.uid()` (`:170`); notification `actor_user_id` =
  `auth.uid()` and `type` = hardcoded `'issue'` (`:180`). NONE of brand / store /
  reporter / type is taken from client args. The client can only supply
  `p_store_id` (gated), `p_category` (CHECK-validated), and `p_message`
  (length-bounded). The client cannot forge a different notification type,
  actor, or cross-brand target.
- Category validated against the exact CHECK set, else `22023` → HTTP 400
  (`:143-147`); message trimmed and bounded to 1–2000 chars, else `22023`
  (`:149-153`). `v_brand is null` guard for brandless store (`:158-161`).
- `execute` revoked from `public, anon`, granted to `authenticated` (`:197-198`).
  The store-gate — not the grant — is the real control, as required. `enqueue_
  submission_push` stays revoked from authenticated and is reached only via the
  definer's own privileges inside the RPC, so the caller gains no direct access
  to the internal emitter.

**2. `staff_reports` RLS: PASS**
- RLS enabled (`:90`). NO client INSERT/UPDATE/DELETE policy — the only write
  path is the definer RPC (owner bypasses RLS); direct client writes default-deny.
- Single SELECT policy `privileged_brand_read_staff_reports` =
  `auth_is_privileged() AND auth_can_see_brand(brand_id)` (`:92-94`). A staff
  `user` role fails `auth_is_privileged()` (`20260509000000_...:235-239`) → cannot
  read the table directly, even for their own store. Other-brand admins fail
  `auth_can_see_brand`. Super_admin short-circuits to all brands. Matches the
  spec-120 `notifications` read policy exactly. Confirmed: staff cannot read
  `staff_reports`.
- Grants follow spec-097 (no revoke from anon/authenticated); RLS is the gate.
  Single non-trivially-wide permissive SELECT policy ⇒ passes the spec-053 lint
  with no allowlist edit.

**3. Notification integrity: PASS**
- The emitted `'issue'` row rides the existing `privileged_brand_read_
  notifications` policy (privileged + `auth_can_see_brand`). Because `brand_id`
  is derived from a store the caller was already authorized to see, the row lands
  ONLY in that brand's admins/masters + all super_admins — the exact spec-120
  recipient model. No cross-brand injection.
- `(type, source_id)` unique index (`20260715000000_...:51-52`) with
  `on conflict do nothing`; `source_id` = the fresh `staff_reports.id`, so two
  legitimate reports never collapse and there's no dedup-collision forgery.
- `body`/`category` are parameterized text values, never concatenated into SQL.
  The bell renders them as React Native `<Text>` (`NotificationBell.tsx:269,282`)
  — no HTML sink. The push builds its payload via `JSON.stringify`
  (`submission-push-fanout/index.ts:187`) — no HTML/Resend path. No XSS/injection.

**4. No new secret / grant / publication regression: PASS**
- No secrets in code, config, or logs. `expectedBearer` reads the token via
  service_role and never logs it; the RPC's `raise warning` carries `sqlerrm`,
  not tokens (`:188`). No `EXPO_PUBLIC_*` additions.
- No publication change — `public.notifications` is already published; adding a
  row type + nullable columns changes no membership (no realtime restart needed).
- `submission-push-fanout` config unchanged: `verify_jwt = false`
  (`config.toml:451-452`) with the self-validated shared-bearer gate intact
  (`index.ts:88-93`). No new edge function; no config entry required.
- Message free text is never interpolated into HTML or SQL unsafely (bell = RN
  Text, push = JSON string). Confirmed.

---

### Dependencies
No `package.json` changes — `npm audit` skipped.

---

Spec 126 does not introduce any Critical or High finding. From a security
standpoint it is clear to advance.
