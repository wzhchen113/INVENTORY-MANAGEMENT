# Release proposal — Spec 041 (brand-scoped per-store visibility)

Round-4 final proposal. Overwrites the round-1 FIXES_NEEDED proposal at
the same path. Synthesized from four refreshed reviewer files in
`specs/041-brand-scoped-store-visibility/reviews/`: `code-reviewer.md`,
`security-auditor.md`, `test-engineer.md`, `backend-architect.md`.

## Verdict
verdict: SHIP_READY
rationale: Across four rounds of review the security-auditor identified
three distinct same-end-state-different-verb privilege-escalation
vectors (round-1 UPDATE, round-2 DELETE, round-3 TRUNCATE), all three
are now closed by complementary defenses live-verified against the
local DB; round-4 aggressive sweep across 13 additional escalation-path
categories found no new vectors, and every reviewer is clean of
Critical findings.

This spec is the strongest validation any spec in this project has
received. The 4-round, fail-closed review loop demonstrably caught
what a single-pass implementation would have shipped to prod — a
brand-admin one-PATCH escalation to full cross-brand visibility,
plus its two adjacent "same end-state, different verb" variants.
The 14-arm pgTAP file is the deepest RLS coverage in the suite to
date: it covers the brand-scope helper (arms 1-6), the BEFORE UPDATE
trigger (arms 7-9), the end-to-end chain proof (arm 10), the BEFORE
DELETE trigger (arms 11-13), and the TRUNCATE REVOKE (arm 14). Full
suite: 26/26 DB test files pass; typecheck clean.

## Findings summary

- **code-reviewer**: 0 Critical, 0 Should-fix, 3 Nits.
  - All four prior Criticals across rounds 1-3 resolved
    (`raise warning` → `raise exception`, misleading 012a citation
    comment, two-trigger privilege-escalation chain). The re-review
    notes the trigger pattern correctly mirrors `user_stores_brand_match`
    from 012a (`20260509000000:357-381`) with one deliberate
    `search_path` difference (`= public, auth` instead of `= public`),
    justified because the new function calls `auth.uid()`.
  - Three nits: (1) comment phrasing about `old.id = NULL` could be
    clearer about `auth.uid()` returning NULL, (2) `tg_op = 'UPDATE'`
    check inside the trigger function is a dead guard given the BEFORE
    UPDATE-only binding, (3) one missing comment in the test fixture.
    All cosmetic, none blocking.

- **security-auditor**: 0 Critical, 0 High new (1 High carry-forward
  NOT BLOCKING), 0 Medium new (2 Medium carry-forward NOT BLOCKING),
  8 Low. Round-3 Critical (TRUNCATE+INSERT bypass) is
  LIVE-VERIFIED-BLOCKED — `\dp public.profiles` confirms `arwdxtm`
  (lowercase d, no TRUNCATE) for `authenticated` and `anon`, while
  `postgres` and `service_role` retain `arwdDxtm`. Brand-admin
  TRUNCATE attempt fails with `permission denied for table profiles`
  (SQLSTATE 42501) before any trigger fires; CASCADE variant blocked
  identically.
  - Round-4 aggressively swept 13 additional escalation-path
    categories: DROP/ALTER/CREATE TRIGGER, COPY TO/FROM, INSERT ...
    ON CONFLICT DO UPDATE, INSERT FROM SELECT, `user_stores`
    cross-brand INSERT (including the TRUNCATE-then-INSERT variant —
    closed by the BEFORE INSERT trigger that fires on new rows
    regardless), direct `auth.users` tampering, all 25 public
    SECURITY DEFINER functions individually reviewed for profile
    mutation, direct `auth.users.role` update, `set_config` JWT
    spoofing, `set role` privilege escalation, schema-level CREATE
    on public/auth, grant-yourself-privileges, and
    `session_replication_role` bypass. Every path is closed by
    pre-existing or spec-041-introduced defenses.
  - The three same-end-state-different-verb attack paths from rounds
    1, 2, 3 are now all closed: round-1 UPDATE by
    `profiles_self_brand_lock` BEFORE UPDATE trigger; round-2 DELETE
    by `profiles_self_delete_lock` BEFORE DELETE trigger; round-3
    TRUNCATE by `revoke truncate on public.profiles from
    authenticated, anon`. Layered defense: triggers for surgical
    verb-bound blocking on row-level verbs, REVOKE for the
    privilege-layer block on TRUNCATE (the verb that doesn't fire
    row-level triggers).
  - The auditor states explicitly: "**Spec 041 cleared for
    release-coordinator.**"

- **test-engineer**: pgTAP single-file run: PASS (14 assertions
  passed, plan(14) matches). Full suite: 26/26 DB test files
  passed. `npm run typecheck` exits 0. AC1-AC5, AC8, AC9 all PASS;
  AC6 (shell smoke) and AC7 (cascade downstream tests) NOT TESTED
  but explicitly marked "not required as a CI gate" by the spec.
  Nits about INSERT path / PostgREST PATCH being indirectly
  covered are non-blocking — the INSERT path is structurally
  blocked from being the specific spec-041 escalation vector (PK
  collision, FK to `auth.users`, brand-admin cannot create new
  `auth.users` rows via PostgREST), and the trigger fires at the
  Postgres layer regardless of which client path admitted the
  UPDATE.

- **backend-architect**: 0 Critical, 0 Should-fix, 5 Minor (3
  carried forward from round 1, 2 new and bounded). Round-2 verdict
  on the trigger expansion: "well-conceived, structurally aligned
  with the sibling `user_stores_brand_match` trigger, and correctly
  scoped. SECURITY DEFINER is justified. The role-lock arm is
  appropriate defense-in-depth rather than scope creep, given that
  `brand_id` becoming a security boundary in spec 041 gave the
  attacker a trivial pivot to the role column." The five Minors are
  all optional polish — three carried forward, two new and bounded
  (test-file mid-transaction state-leak between arms 9 and 10; spec
  §9 documentation stale relative to the shipped 14-arm plan).
  Explicit recommendation: "SHIP."

## Recommended next steps (ordered)

1. **Commit the artifacts.** No environment changes, no edge function
   deploy, no secret rotation. Single migration + single pgTAP file,
   both self-contained:
   - `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`
     (new) — helper redefinition + `profiles_self_brand_lock` BEFORE
     UPDATE trigger + `profiles_self_delete_lock` BEFORE DELETE trigger
     + `revoke truncate on public.profiles from authenticated, anon`.
   - `supabase/tests/auth_can_see_store_brand_scope.test.sql` (new) —
     14-arm pgTAP plan covering helper (arms 1-6), UPDATE trigger
     (arms 7-9), end-to-end chain proof (arm 10), DELETE trigger
     (arms 11-13), TRUNCATE REVOKE (arm 14).
   - `specs/041-brand-scoped-store-visibility.md` (updated) — design,
     "Profile column-write lockdown" section, DELETE-path lockdown
     section, Truncate-path lockdown section.
   - `specs/041-brand-scoped-store-visibility/reviews/code-reviewer.md`
   - `specs/041-brand-scoped-store-visibility/reviews/security-auditor.md`
   - `specs/041-brand-scoped-store-visibility/reviews/test-engineer.md`
   - `specs/041-brand-scoped-store-visibility/reviews/backend-architect.md`
   - `specs/041-brand-scoped-store-visibility/reviews/release-proposal.md`
     (this file).

2. **Deploy notes for the operator** — none. The migration is
   self-contained DDL; no env-var changes, no edge-function
   re-deploy, no client-side ship. After `supabase db push` applies
   the migration in prod, the helper tightens at every call site
   (100+ policies cascade automatically) and the three triggers
   come online immediately. Verify post-deploy by re-running
   `bash scripts/test-db.sh` against the prod migration target if
   desired (the production-mirror seed at
   `supabase/seed.sql` pulled 2026-05-02 is the source of truth
   for the test fixtures).

3. **(Optional polish, follow-up — not blocking ship)**
   - Code-reviewer Nit #1: tighten the `old.id = NULL` comment phrasing.
   - Code-reviewer Nit #2: remove the dead `tg_op = 'UPDATE'` guard.
   - Code-reviewer Nit #3: add a one-line comment to test arm 5 about
     role persistence from arm 4.
   - Architect M1: add brand-A leg to super_admin positive control
     (bump `plan(14)` → `plan(15)` or collapse arm 3 into a single
     `ok(... and ...)`).
   - Architect M4: wrap arm 9 in a nested savepoint so mid-transaction
     state doesn't leak across arms.
   - Architect M5: extend spec §9 in-place to reflect the 14-arm plan
     (currently the canonical contract is split across §9, the
     "Profile column-write lockdown" section, and §12).

## Out of scope for this review

These belong in follow-up specs, NOT 041. The release-coordinator and
security-auditor agree they are non-blocking for the current ship:

- **`order_schedule` WRITE-side tightening** (security-auditor High,
  carry-forward NOT BLOCKING). Policy at
  `20260510020000_order_schedule_super_admin_rls.sql:28-31` still
  gates only on `auth_is_privileged()` with no `auth_can_see_store`
  check. Brand-admin can INSERT/UPDATE/DELETE foreign-brand
  schedule rows post-spec. Spec 041 §"Out of scope" explicitly
  defers direct-`auth_is_admin()` call sites to a separate spec.
  Recommended follow-up: audit every WRITE policy on per-store
  tables for the same pattern.

- **"Admins can update any profile" cross-brand admin write
  loophole** (security-auditor Medium, carry-forward NOT BLOCKING).
  Policy at `20260502071736_remote_schema.sql:390-395` lets brand-A
  admin PATCH brand-B users' `name`, `email`,
  `notifications_enabled`, etc. The new triggers correctly do NOT
  block cross-user writes (only self-writes), so this pre-existing
  policy gap survives. The role-escalation pivot is closed by the
  `profiles_sync_role` trigger; only non-security-load-bearing
  columns leak across brands. Recommended follow-up.

- **"Users can update own profile" structural with-check weakness**
  (security-auditor Medium, carry-forward NOT BLOCKING). Policy at
  `20260502071736_remote_schema.sql:417-422` still has no `with
  check` clause. Spec 041 closes the two highest-impact specific
  columns (`brand_id`, `role`) via triggers; any future
  security-load-bearing column added to `profiles` would silently
  re-open this hole. No such column exists today. Recommended
  follow-up: add a `with check` enumerating writable columns, or
  assert security-load-bearing columns are `not distinct from old`.

- **`user_stores` TRUNCATE-as-DoS** (security-auditor Low, NEW
  round-4 informational, NOT BLOCKING). `public.user_stores`
  retains TRUNCATE granted to `authenticated` and `anon`
  (`anon=arwdDxtm`, `authenticated=arwdDxtm`). The cross-brand
  privilege-escalation via user_stores is closed (the BEFORE
  INSERT trigger `user_stores_brand_match_trg` fires on any new
  row regardless and rejects cross-brand), but any authenticated
  user can TRUNCATE the table and wipe every staff-to-store
  assignment project-wide — a denial-of-service for the staff app.
  Pre-existing (not introduced by 041); 15 other public tables
  share the same destructive-DoS surface. Recommended follow-up:
  extend the round-3 REVOKE pattern to all destructive-action-
  sensitive tables in a separate spec.

- **Dependency backlog** (security-auditor Low). `npm audit
  --audit-level=high` reports 1 high `@xmldom/xmldom`, 5 moderate
  `dompurify`+`postcss`, 5 low. Carry-forward through specs 037,
  038, 039, 040, 041 — `package.json` last touched at spec 027.
  Not 041-specific.

## Handoff
next_agent: NONE
prompt: SHIP_READY. Round-4 final verify complete. Four rounds of review found and closed three distinct privilege-escalation vectors (round-1 UPDATE trigger, round-2 DELETE trigger, round-3 TRUNCATE REVOKE) — every reviewer is clean of Critical and Should-fix findings. 14/14 pgTAP arms pass; 26/26 full DB suite passes; typecheck clean. No operator steps required beyond `supabase db push` of the new migration. Strongest RLS coverage of any spec in this project to date; user confirms commit.
payload_paths:
  - specs/041-brand-scoped-store-visibility/reviews/release-proposal.md
