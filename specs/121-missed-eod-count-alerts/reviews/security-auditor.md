# Security audit for spec 121 — Missed EOD count alerts

Scope: the `missed_eod` extension of the spec-120 notification system. Spec-120's
RLS, push fan-out, and emitter were already audited clean; this pass confirms the
extension does not weaken any of those guarantees and introduces no new exposure.

## Result

No Critical, no High, no Medium. One Low (informational). All four focus areas
from the dispatch confirmed safe. Spec 121 is clear to advance.

---

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
- `supabase/functions/eod-reminder-cron/index.ts:386-388` and
  `supabase/functions/submission-push-fanout/index.ts:178-180` — the uncaught-error
  handlers echo `e.stack?.slice(0,600)` into the JSON response body. This is a
  pre-existing spec-120/reminder-cron pattern, NOT introduced by spec 121, and the
  only caller is `pg_net` / `pg_cron` (internal, service-role, shared-bearer-gated) —
  never a browser. No PII or secret is in that stack. Noted for completeness only;
  not a spec-121 finding and not blocking.

---

## Focus-area confirmations

### 1. `emit_missed_count` — SECURITY DEFINER hardening (migration §Part 2)
`supabase/migrations/20260716000000_missed_eod_notification_type.sql:50-93` is a
byte-for-byte parallel of the audited `emit_submission_notification`:
- `security definer` + `set search_path = public` pinned (lines 57-58) — no
  search-path hijack surface.
- `revoke execute ... from public, anon, authenticated` (lines 92-93); `service_role`
  retains execute (revokes don't touch it), which is exactly what lets the cron call
  it and nothing else. No client can forge a miss.
- Brand is derived from the trusted `stores` join (`select s.brand_id ... where s.id =
  p_store_id`, lines 67-68), never from client/caller input. Null brand → early
  `return` (line 69), so a storeless/brandless row is never emitted.
- Exception-safe: inner `begin/exception when others → raise warning` (lines 66-89)
  mirrors the spec-120 emitter, so a miss-detection failure never rolls back or
  breaks the cron run.
- INSERT is fully parameterized (lines 77-79) — `p_vendor_name` lands in `actor_name`
  via a bound value, no dynamic SQL / no `EXECUTE`, so the denormalized vendor string
  carries zero injection risk.
- The emitted row is a plain `public.notifications` row carrying the store's
  `brand_id`, so it is governed by the SAME spec-120 SELECT policy
  `privileged_brand_read_notifications`
  (`auth_is_privileged() AND auth_can_see_brand(brand_id)`,
  `20260715000000_submission_notifications.sql:80-82`). No new policy, no `USING
  (true)`. pgTAP arms 5-7 (`supabase/tests/missed_eod_notifications.test.sql:156-205`)
  exercise this on the inherited policy: brand-A admin sees the brand-A miss (arm 5),
  gets zero rows for a brand-B miss (arm 6), super_admin sees both brands (arm 7).
  Staff `user` denial is inherited from the `auth_is_privileged()` conjunct (spec-120
  coverage). Confirmed.

### 2. No new exposure
- The CHECK widen (`migration:22-27`) only ADDS `'missed_eod'` to the allowed `type`
  set; it touches no policy and no grant. RLS is unchanged and type-agnostic.
- Vendor name → `actor_name` is deliberate display-slot reuse (documented in the
  migration header, lines 38-44). It is a display string already sourced from
  `order_schedule.vendor_name` (DB-side), not new PII and not caller-controlled.
- No new table, column, index, grant, or realtime-publication change. Confirmed
  against the migration — Part 1 and Part 2 are the only DDL.

### 3. Push branch — no recipient broadening
`supabase/functions/submission-push-fanout/index.ts:118-137` recipient resolution is
untouched: `super_admin` (all brands) ∪ `admin`/`master` WHERE `brand_id =
notif.brand_id`, minus `actor_user_id`. For a miss `actor_user_id` is NULL, so the
`if (notif.actor_user_id)` guard at line 133 is falsy → no deletion happens. Crucially
this does NOT widen the recipient set — it only skips the "exclude the submitter" step,
which is correct because a miss has no submitter. Brand scoping is still enforced by the
`.eq('brand_id', notif.brand_id)` filter (line 128). The `missed_eod` copy branch
(lines 154-159) changes only title/body strings, not recipients. Confirmed no
cross-brand leak.

### 4. Cron Track 3 — auth and server-side-only emit
`supabase/functions/eod-reminder-cron/index.ts:339-380` runs inside the existing
shared-bearer gate (lines 141-146): the function reads `cron_bearer` from the
RLS-locked, service-role-only `_edge_auth` table and constant-compares it to the
request bearer; anon-key callers cannot read that table, so an unauthorized caller
gets 403 and cannot spam misses. `verify_jwt = false` is declared for
`eod-reminder-cron` and `submission-push-fanout` in `supabase/config.toml:438-439,
451-452`, both matched by their own bearer gate — consistent with the CLAUDE.md
`staff-*`/cron posture. Detection reads only trusted server tables
(`order_schedule`, `eod_submissions`, `stores`) via the service-role client and calls
`emit_missed_count` server-side (line 369); the emitter is revoked from all client
roles, so the emit path is unreachable from a browser. Confirmed.

### Post-midnight helper note (not a security finding)
`minutesSinceDeadline` (`index.ts:65-74`) is a correctness helper, not an authz
control; the architect flagged the after-midnight sign bug. It is TS-only with no SQL
surface, so it is correctly out of pgTAP scope
(`missed_eod_notifications.test.sql:20-26`). Its coverage debt is a test-engineer
concern, not a security one — noted, not owned here.

## Dependencies
No `package.json` changes in this spec — `npm audit` skipped.

## Verdict
No Critical, no High, no Medium, one informational Low (pre-existing stack echo, not
spec-121). All four spec-120 guarantees (SECURITY DEFINER hardening, inherited RLS
brand scoping, push recipient scoping, cron bearer gate) hold. Spec 121 does not
BLOCK.
