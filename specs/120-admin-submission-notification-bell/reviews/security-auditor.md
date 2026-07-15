# Security audit for spec 120 — Brand-scoped submission notification bell

Scope reviewed: the migration `supabase/migrations/20260715000000_submission_notifications.sql`
(tables, RLS, SECURITY DEFINER emitter/enqueue/triggers, read RPCs, publication add),
the edge function `supabase/functions/submission-push-fanout/index.ts`,
`supabase/config.toml` (verify_jwt split), the db.ts helpers, and the push
content path (`public/sw.js`). Read-only; no files modified.

Verdict: **no Critical, no High.** The RLS scoping, the SECURITY DEFINER
lockdown, the shared-bearer gate, and the push-content path are all correct
against the threat model. Findings below are Low/informational.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `supabase/functions/submission-push-fanout/index.ts:172` — the uncaught-error
  branch returns `stack: e?.stack?.slice(0, 600)` to the caller. This leaks
  internal stack frames / file paths. Impact is bounded: this catch sits AFTER
  the bearer gate (`index.ts:79`), so only a caller holding the shared
  `cron_bearer` (i.e. pg_net / an operator) ever reaches it — an unauthenticated
  attacker gets a bare `403` first. Recommend dropping the `stack` field (or
  gating it on a debug env flag) to match the project rule that client-facing
  errors omit stack traces. Not a deploy blocker given the bearer gate.
- `supabase/functions/submission-push-fanout/index.ts:79` — bearer check uses a
  non-constant-time `token !== want` comparison (timing side-channel). This is
  **exactly the sanctioned reference pattern** — `eod-reminder-cron/index.ts:125`
  does the identical comparison — and CLAUDE.md/spec call constant-time
  "preferred," not required. Over the network with a high-entropy random shared
  bearer the side-channel is not practically exploitable. Flagged only for parity
  bookkeeping; no action needed unless the reference cron is also hardened.
- `supabase/migrations/20260715000000_submission_notifications.sql:93-94` — the
  `own_reads_insert` policy checks only `user_id = auth.uid()`; it does NOT
  require the target `notification_id` be visible to the caller under the
  notifications SELECT policy. A brand-A admin could therefore insert a
  `notification_reads` row for a brand-B `notification_id`. This is harmless: the
  row only affects the caller's OWN read state (their SELECT is clipped to
  `user_id = auth.uid()`, so no brand-B row content is ever returned), and the FK
  requires the uuid to already exist — a negligible existence-oracle on
  unguessable v4 uuids. No fix required; noted for completeness.

### Informational (not a security finding — surfaced for coordinator/architect)
- `master` role scoping is MORE restrictive than the spec's "Actors and scope"
  section. The spec says `master` should see ALL brands like `super_admin`, but
  `auth_can_see_brand()` (`20260509000000_multi_brand_schema_rls.sql:200`) gives
  `master` own-brand visibility only (no super_admin short-circuit), and the edge
  function (`index.ts:126-127`) likewise scopes `master` to `brand_id = notif.brand_id`.
  A tighter-than-spec grant is safe security-wise (no leak, no escalation) so this
  is **not** a security finding — but it is a functional deviation from the stated
  contract that the architect / code-reviewer should confirm is intended.

### Positive confirmations (the sensitive surfaces called out in the task)

1. **RLS on `notifications` (task item 1).** Single SELECT policy
   `privileged_brand_read_notifications` = `auth_is_privileged() AND
   auth_can_see_brand(brand_id)` (migration:80-82). Verified it is **AND, not OR**,
   and it is the ONLY policy on the table (no sibling permissive policy to leak
   via OR-composition; passes the spec-053 lint — no trivially-wide token).
   - staff `user`: `auth_is_privileged()` = false (not admin/master JWT, not
     super_admin) → the privileged conjunct denies them despite a real
     `brand_id`. The load-bearing conjunct works as designed.
   - brand-A admin: `auth_can_see_brand(brand-B)` = false (their `profiles.brand_id`
     is A) → zero brand-B rows even via a hand-crafted PostgREST query (RLS
     denies, not client filter). `auth_is_admin()` covers admin+master via JWT.
   - super_admin: `auth_can_see_brand()` short-circuits TRUE → all brands.
   - No client INSERT/UPDATE/DELETE policy exists; RLS-enabled + spec-097
     inherited grants ⇒ default-deny writes. A client cannot forge notifications.
   - `notification_reads` (migration:91-96): `own_reads_select/insert/delete` all
     scoped to `user_id = auth.uid()`; no UPDATE policy (read is insert-once,
     idempotent via ON CONFLICT). A viewer cannot read, mark, or infer another
     viewer's read receipts. Per-viewer isolation holds.

2. **SECURITY DEFINER `emit_submission_notification` (task item 2).** search_path
   pinned to `public` (migration:157). `EXECUTE` revoked from `public, anon,
   authenticated` (migration:187-188) — callable only by the SECURITY DEFINER
   trigger functions, not by clients. `brand_id` is DERIVED from the trusted
   `stores` join (migration:166), never from client input. Wrapped in an inner
   `BEGIN/EXCEPTION WHEN OTHERS` (migration:165, 182) so a notification/push
   failure logs a WARNING and cannot roll back or block the user's submission.
   `enqueue_submission_push` and all four `tg_notify_*` trigger functions are
   likewise SECURITY DEFINER + search_path-pinned + EXECUTE-revoked.

3. **Edge function `submission-push-fanout` (task item 3).** `verify_jwt = false`
   in config.toml (line 452), with a documented shared-bearer rationale. The
   function validates the bearer itself (`index.ts:76-81`): missing/wrong bearer,
   or an unconfigured `cron_bearer`, → HTTP 403 before any work. The expected
   bearer is read from `public._edge_auth` via service_role — and `_edge_auth` is
   RLS-enabled with ZERO policies (`20260424211733_security_fixes.sql:144`), so no
   client role can read it to forge the token. Recipient resolution is entirely
   server-side under service_role and derived from the notification's own
   `brand_id` (`index.ts:121-129`); the caller supplies only `notification_id`
   and cannot steer the push to arbitrary users. The submitter is always excluded
   (`index.ts:132`). 404/410 subscription cleanup is copied verbatim
   (`index.ts:44-47`). The pg_net enqueue passes the bearer in the
   `Authorization` header only (migration:130-138) and neither the SQL helper nor
   the function logs the token.

4. **Data exposure (task item 4).** `notifications` denormalizes only
   `actor_name` (coalesce of `profiles.username`/`name`) and `store_name` — no
   emails, no phone, no other PII. Cross-brand leakage is prevented at the DB by
   the RLS SELECT policy (item 1); a brand admin's feed can never include another
   brand's actor/store row.

5. **Push content injection (task item 5).** The payload `title`/`body`
   (`index.ts:150-155`) interpolate `actor_name`/`store_name`, but `public/sw.js`
   renders them via `self.registration.showNotification(title, options)` — the
   Web Notifications API treats title/body as PLAIN TEXT (no HTML parsing), so a
   crafted username cannot inject markup or script. `notificationclick` navigates
   to `data.url`, and the fan-out hardcodes `url: '/'` — no open-redirect via
   user-controlled input. No sanitization gap.

### Dependencies
No `package.json` change in this spec (edge function pins `web-push@3.6.7` and
`@supabase/supabase-js@2` via Deno import specifiers, matching the reference
cron). `npm audit` — skipped (no manifest change).

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low (all
  bearer-gated or negligible: stack-trace-in-500-body, non-constant-time bearer
  compare matching the sanctioned cron pattern, and a harmless own-read-state
  insert oracle), plus one informational functional deviation (master role
  scoped tighter than the spec's stated all-brands intent — safe, but
  architect/code-reviewer should confirm). RLS AND-scoping, SECURITY DEFINER
  lockdown, shared-bearer gate, and push-content path all verified correct.
  Nothing blocks merge.
payload_paths:
  - specs/120-admin-submission-notification-bell/reviews/security-auditor.md
