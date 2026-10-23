# Release proposal: spec 167 (store-user audit trail + delete-user self-guard case fix)

## Re-synthesis after fix pass (2026-10-19)

This section supersedes the original proposal below, which is kept for history. Inputs read directly: `specs/167-store-user-audit-trail.md` (including both `## Files changed` fix-pass subsections) and the dated "Delta re-review (fix pass)" section in each of the four reviewer files: code-reviewer, security-auditor, test-engineer, backend-architect. I also checked the current `supabase/functions/delete-user/index.ts`, `src/lib/db.ts:5401` and `CLAUDE.md:73` to confirm the stale line references (D1 below).

### Verdict
verdict: SHIP_READY (conditional; the commit is the user's decision)
rationale: All four delta reviews report 0 Critical and 0 Should-fix, and the test-engineer reports 14/14 ACs PASS with 0 NOT TESTED, so the hard rules are met. Two conditions must still hold before ship: (1) the owner explicitly accepts security M2, or lands F1 with this change, and (2) the post-push CI gates on `main` are green.

**Condition 1: security M2 needs an explicit owner decision before or with ship.** The new `'Store user created'` / `'Store user password set'` rows put the target's **login username** in `item_ref`. The existing `store_member_read_audit_log` arm (`20260809000000_super_admin_policy_parity.sql:176-181`, `auth_can_see_store(store_id)`) lets any store member, including `role='user'` staff, read them. A staff JWT can `GET /rest/v1/audit_log?action=eq.Store user created` and list every colleague's username-only login handle in the store, along with password-reset events and the acting admin's id. That cuts against the spec 095 username anti-enumeration posture, and together with spec 165 L5 (8-character password floor) it helps a co-worker guess passwords. The exposure stays inside one store, and the security auditor rates it Medium and non-blocking. It is still a **new** exposure created by this spec. The owner must pick one:
- **(a) Land F1 first or together with this change:** a RESTRICTIVE SELECT policy on `audit_log`, `using (action not in ('Store user created','Store user password set') or public.auth_is_privileged())`. That needs a migration, and spec 167 is migration-free, so it would be a separate spec shipped alongside.
- **(b) Record an explicit risk acceptance:** for example, a line in the spec or in the commit message saying "M2 accepted until F1". The cost is that staff can enumerate in-store usernames via PostgREST until F1 lands.

I can't make this call; it belongs to the owner. Without (a) or (b), treat this as not ready to ship.

**Condition 2: CI gates.** I have no shell, so I ran nothing and could not see the current `main` gate state. The spec 167 change is uncommitted and unpushed, so no gate run covers it yet. After the user commits and pushes:
- the latest `main` run of `.github/workflows/test.yml` must be green;
- the latest `main` run of `.github/workflows/db-migrations-applied.yml` must be green. The spec has no migration, so it shouldn't move this gate, but it must be green as a branch-health signal;
- check `.github/workflows/e2e.yml` by hand. It is not yet in the CLAUDE.md gate list.

If either `test.yml` or `db-migrations-applied.yml` is red or in progress, this proposal does not stand as SHIP_READY. Surface the run URL and wait for user direction.

### Findings summary (from the delta sections, superseding the original counts)
- **code-reviewer:** 0 Critical, 0 Should-fix, 2 new Nits.
  - **Closed:** the `sd_psql` exit-status Should-fix (`smoke-edge-roles.sh:512-516` now returns psql's status). Two earlier nits are also closed: the manage-store-user log-hygiene header (`index.ts:22-26`) and the A7 "UPDATE THIS TALLY" note (`smoke-store-user.sh:566-570`).
  - **Still open, all optional:** six earlier nits (map-entry alignment; four copies of the audit-failure log shape / a `logAuditFailure` helper; the store-less `console.warn` living in the writer; the `zz_s165%` LIKE `_` wildcard; A3/A7 read-together coupling; the shared fixture helper, F7). Also the endpoint summary at `manage-store-user/index.ts:1-7`, which still doesn't mention the `audit_log` writes.
  - **New nits:** the spec number in the test title (acceptable as is). Out of scope: `AuditLogSection.tsx` / `PhoneAuditLog.tsx` now export non-component values, which disables React Fast Refresh for those modules in dev.
  - **Caveat:** this delta was by inspection only. The reviewer could not run jest or the smokes.
- **security-auditor:** 0 Critical, 0 High, 2 Medium, 2 Low.
  - **M1: CLOSED.** `delete-user/index.ts:26` has an inline `UUID_RE`, byte-identical to `manage-store-user/index.ts:50`. The check at `:179` runs right after trim and lowercase, before the self-guard at `:186-191` and before any read or side effect. Non-canonical spellings now get 400 `userId required`, so the self-delete / half-delete path is gone.
  - **Still open:** M2 (staff can read these rows, see Condition 1), M3 (the deferred integrity gap: forgeable or erasable rows), L1 (a profile-less super_admin's audit insert fails silently), L2 (raw `error.message`, now slightly narrower).
  - The temporary trigger in Arm AF was judged acceptable: local-only, removed on the normal path and on interruption, with a tiny blast radius. Optional hardening: set `AUDIT_TRIGGER_INSTALLED=1` *before* the install to close a millisecond window. Arm C has the same pattern.
  - No secret leaks in the new log assertions. "Nothing blocks."
- **test-engineer:** 14 PASS, 0 FAIL, 0 NOT TESTED out of 14 ACs.
  - **AC-11** now PASSes with automated tests: the new `src/screens/cmd/sections/__tests__/AuditLogSection.storeUser.spec167.test.tsx` covers `inferKind` returning `'user'`, desktop tones `ok`/`warn`, and phone tones equal to desktop. A new render case in `src/screens/cmd/sections/phone/__tests__/PhoneAuditLog.test.tsx` checks the displayed row text.
  - **AC-4** is now a committed regression test: Arm AF in `scripts/smoke-store-user.sh`.
  - **AC-8 / AC-13** add the braced and hyphenless own-id arms.
  - Runs: `npx jest` 230 suites / 2658 tests green. `typecheck` and `typecheck:test` clean. `smoke-store-user.sh` exit 0 (96 PASS, 0 FAIL, 1 SKIP; the SKIP is the unrelated username-resolve step). `smoke-edge-roles.sh` exit 0 (26 PASS). No `zz%` fixtures or triggers left behind.
  - **Residual, low risk:** no end-to-end render test of the desktop table with these rows (only helper-level checks). The test-engineer did not re-run the developer's proof that the pre-fix build half-deletes.
- **backend-architect (post-impl delta):** 0 Critical, 0 Should-fix, no contract drift.
  - **Closed:** S1 (the non-canonical UUID bypass) and M1 (the §4.4 design text; corrections are applied in the spec and marked "Corrected post-impl").
  - Arm AF is a new block §8.1 didn't specify, but it fits §8.1's constraints.
  - **Still open, already tracked:** M2 (non-atomic delete ordering → F4) and M3 (profile-less super_admin → F2).
  - **New:** D1, Nit: stale line references. See the follow-up list.

### What closed in the fix pass
1. AC-11 is NOT TESTED → PASS. This was the original release blocker.
2. Security M1 / architect S1: the canonical `UUID_RE` gate in delete-user, plus two Arm 8 smoke calls. The developer showed the pre-fix build fails them.
3. Code-reviewer Should-fix: `sd_psql` now propagates psql's exit status.
4. AC-4 manual-only → committed Arm AF (failure injection via a temporary `audit_log` trigger).
5. Architect M1: the §4.4 design text corrections are applied to the spec.
6. Nits: the log-hygiene header and the A7 tally note.

### Residual items (non-blocking, beyond Condition 1)
- Security M3, L1, L2 and architect M2/M3 are carried as follow-ups F1-F4 below.
- Optional nits from code-reviewer (listed above).
- **Commit hygiene** (from the git status at dispatch time; I did not re-check it):
  - The fix pass is **unstaged** on top of the staged implementation. The affected files are `MM` (`scripts/smoke-edge-roles.sh`, `scripts/smoke-store-user.sh`, `AuditLogSection.tsx`, `PhoneAuditLog.tsx`, `delete-user/index.ts`, `manage-store-user/index.ts`), plus ` M` `PhoneAuditLog.test.tsx`.
  - The new AC-11 test file `src/screens/cmd/sections/__tests__/AuditLogSection.storeUser.spec167.test.tsx` is **untracked**. If it isn't staged, the commit loses the coverage that cleared the blocker.
  - Spec 166 changes share `manage-store-user/index.ts` and `smoke-store-user.sh`, and `specs/166-send-email-hook-placeholder-drop.md` is staged. All test runs exercised the combined working tree. The user should decide whether 166 and 167 go in one commit or are split hunk by hunk.

### Recommended next steps (ordered)
1. **Owner decision on security M2** (Condition 1): either schedule F1 to ship with this change, or record an explicit risk acceptance. This comes first because it is the only open item that needs a human decision before ship.
2. **Stage the complete change set** (see Commit hygiene), including the untracked spec167 test file and the unstaged fix-pass hunks. Settle the spec 166 coordination. Per the user's standing preference, staging is fine, but **the commit is the user's decision**. Main Claude must not auto-commit.
3. **After the user commits and pushes:** confirm green on the latest `main` run of `test.yml` **and** `db-migrations-applied.yml` (`gh run list --branch main --workflow <file> --limit 1` for each). Check `e2e.yml` by hand.
4. **Prod deploy** (`supabase functions deploy manage-store-user delete-user`) stays the owner's call and is out of scope. It rides together with spec 165's undeployed `manage-store-user`. There is no migration, so the `db-migrations-applied` gate is unaffected.
5. Optional, same pass or later: the remaining code-reviewer nits and the D1 line-reference fixes. Neither changes behavior.

### Follow-ups (separate specs; F1 is gated by Condition 1, the rest do not block)
- **F1, Medium: `audit_log` visibility and integrity migration.** Covers security M2 + M3 and the spec 157 FUTURE-1 deferral.
  - A RESTRICTIVE SELECT policy that hides the two store-user actions from non-privileged store members. This closes M2.
  - RESTRICTIVE or append-only UPDATE/DELETE.
  - A RESTRICTIVE INSERT that reserves these action strings for `service_role`, which blocks forged rows.
  - Must pass the spec 053 permissive-policy lint.
  - Either ship it with spec 167, or the owner accepts M2 until it lands.
- **F2, Low: super_admin without a profile.** Security L1 + architect M3. In `manage-store-user`, `readCallerBrand` / `requireAdminCaller` should confirm a `profiles` row with `role='super_admin'` exists before the cross-brand short-circuit, otherwise return 403.
- **F3, Low (pre-existing; narrowed by the M1 fix): stop echoing `error.message` from delete-user.** Corrected current lines: `supabase/functions/delete-user/index.ts:109, 124, 244, 259, 273, 283`. The original proposal's list `102,117,235,250,264,274` is stale. Collapse these to fixed strings, the way `manage-store-user` does.
- **F4, Low (pre-existing): delete the auth user first in delete-user.** Architect M2. Run `auth.admin.deleteUser`, which cascades to `profiles` / `user_stores`, then delete `invitations`. Pairs with F3.
- **F5, Low (pre-existing): audit-row day grouping uses UTC.** In both audit views, the `toISOString().slice(0,10)` grouping key and the "row / last at" timestamps disagree with the local-time `formatDayLabel` / `formatTime`. Evening US events land under the next day's header.
- **F6: move `'User invite'` / `'User deleted'` to server-side writes.** These are still written client-side at `src/store/useStore.ts:3414-3452`.
- **F7, Nit: shared smoke fixture helper.** Extract the duplicated "create admin via `/auth/v1/admin/users` + profile insert" snippet (`smoke-store-user.sh` Arm 14 and `smoke-edge-roles.sh` Arm 8) into `scripts/lib`.
- **D1, Nit (architect): stale line references after the `UUID_RE` insertion shifted `delete-user/index.ts`.**
  - Spec §4.4 `spec:290` still cites "lines 102/117/226/241/255/265" for the raw `error.message` responses. They are now `:109/124/244/259/273/283`.
  - The release proposal's F3 list is corrected in this section. The original below is left as-is for history.
  - `src/lib/db.ts:5401`: the doc comment still points at `delete-user/index.ts:168-173` for the self-guard. It is now `:186-191`. This is pre-existing comment drift.
  - Also found while verifying, not in the architect's list: the CLAUDE.md self-guard convention bullet (`CLAUDE.md:73`) cites the same stale `delete-user/index.ts:168-173`. Correct value: `:186-191`. Editing CLAUDE.md is the user's call.
  - **Already fixed:** `## Files changed` `spec:457` now correctly cites `manage-store-user/index.ts:50` for `UUID_RE` (it was `:48`).
  - None of these affect behavior. Fix them opportunistically, or fold them into F3/F4, which rewrite those lines anyway.

### Out of scope for this review
- F1-F7 above, which are separate specs. F1 is tied to the M2 owner decision.
- Other spec 165 findings (L5 password floor, L6 brand-gate oracle).
- Prod deploy of both edge functions.
- The local `npx supabase status` darwin-arm64 CLI binary issue. It's an environment problem, not code.

---

## Original proposal (pre-fix-pass, kept for history)

## Verdict
verdict: FIXES_NEEDED
rationale: AC-11 is NOT TESTED, which the test-engineer contract (`.claude/agents/test-engineer.md:75-76`) says counts as a Critical for this proposal, so the hard rule blocks SHIP_READY. Separately, the architect and the security auditor both found that the L7 self-guard / half-delete class is only partly closed (non-canonical UUID spellings still get through), and both recommend a one-line fix inside this spec.

Inputs read directly: `specs/167-store-user-audit-trail.md` and all four files in `specs/167-store-user-audit-trail/reviews/` (code-reviewer, security-auditor, test-engineer, backend-architect). I also spot-checked `src/screens/cmd/sections/AuditLogSection.tsx` to confirm the AC-11 wiring and the day-grouping issue (see Out of scope).

CI gate note (CLAUDE.md "CI status check after every push to `main`"): this change is uncommitted and unpushed, so no gate run covers it yet. I ran nothing. After the fixes are committed and pushed, the latest `main` runs of both `.github/workflows/test.yml` and `.github/workflows/db-migrations-applied.yml` must be green before this can be called SHIP_READY. The spec has no migration, so `db-migrations-applied` should not be affected by this change. It must still be green as a branch-health signal. Per memory, also check `e2e.yml` by hand until the owner adds it to the gate list.

## Findings summary
- **code-reviewer:** 0 Critical, 1 Should-fix, 8 Nits.
  - Should-fix: in `scripts/smoke-edge-roles.sh:507/:543`, `sd_psql` pipes into `| tr -d ' '`, so the helper returns `tr`'s exit status and `ON_ERROR_STOP` never reaches the caller. If the disposable-admin profile insert fails, the script can't report it as a fixture failure. It shows up later as confusing 403-vs-400 failures instead. Fix: capture the psql output first and `|| return 1`.
  - Nits: stale log-hygiene header in `manage-store-user/index.ts:22-24`; four copies of the audit-failure log shape (suggests `logAuditFailure`); the store-less `console.warn` lives in the writer rather than the set_password caller; alignment in `formatAuditAction.ts` / `AuditLogSection.tsx`; the hard-coded A7 delta `7` needs an "update me" note; the `zz_s165%` LIKE wildcard; A3/A7 coupling; a duplicated admin-fixture snippet across the two smokes.
  - Conformance: AC-1 to AC-11 and AC-14 match the design. The pinned placeholder/reserved blocks are untouched.
- **security-auditor:** 0 Critical, 0 High, 3 Medium, 2 Low.
  - **M1:** the delete-user L7 fix only normalizes case and whitespace. Postgres/PostgREST still accept hyphenless, braced and hyphen-every-4 UUID spellings, so they:
    - get past the string self-guard, and
    - run the three cleanup deletes before `auth.admin.deleteUser` throws in auth-js `validateUUID`.
    - The result is a 500, with the profile deleted and the auth user orphaned but still holding its JWT role.
    - Fix (in scope, one line): a canonical `UUID_RE` gate that returns 400 `userId required`.
  - **M2:** store members (staff) can read the new rows through the `auth_can_see_store()` arm. That exposes colleagues' login usernames and password-reset events, against the spec 095 anti-enumeration posture. Two options:
    - (a) a RESTRICTIVE SELECT policy, which needs a migration, so it's a follow-up, or
    - (b) explicit risk acceptance.
  - **M3:** the deferred integrity gap. Any privileged caller can UPDATE or DELETE these rows, and store members can INSERT forged look-alike `'Store user password set'` rows. This is already listed as out of scope in the spec.
  - **L1:** a profile-less caller with a `super_admin` JWT keeps cross-brand create / set_password, and every audit insert for that caller fails silently (FK 23503).
  - **L2:** delete-user returns raw `error.message` (pre-existing).
  - Everything else was verified clean, with live-stack checks: secrets hygiene, write-after-success ordering, best-effort behaviour, store-scoped visibility, smoke safety.
- **test-engineer:** 12 PASS, 0 FAIL, 1 NOT TESTED, out of 14 ACs.
  - **AC-11 NOT TESTED (automated):** desktop and phone `ACTION_TONE` entries and desktop `inferKind -> 'user'`.
    - The diff is correct (I confirmed it at `AuditLogSection.tsx:35-36,71`).
    - But `ACTION_TONE` is `Partial<Record<...>>`, so typecheck doesn't enforce it, and no jest test, render test or e2e covers it.
    - Under `.claude/agents/test-engineer.md:75-76` this counts as **Critical** for release purposes.
  - **AC-4** passed, but only through a one-off manual run: a trigger-injected audit failure, scratch script outside the repo. There is no committed regression arm. The test-engineer classes this as a coverage gap, not a defect.
  - Test runs:
    - `npx jest`: 229 suites, 2652 tests, all green.
    - `typecheck` and `typecheck:test`: clean.
    - `smoke-store-user.sh`: 85 PASS, 0 FAIL, 1 SKIP. The SKIP is the existing username-resolve token step and is unrelated.
    - `smoke-edge-roles.sh`: 24 PASS.
- **backend-architect (post-impl):** 0 Critical, 1 Should-fix, 3 Minor. No contract drift. Every design section matches.
  - **S1:** the same finding as security M1. The architect owns it as a defect in their own §4.4 design ("No `UUID_RE` validation is added") and recommends landing the fix in spec 167: add `UUID_RE` before the self-guard, and extend Arm 8 with braced and hyphenless own-id calls that expect 400 `userId required`.
  - **M1:** the §4.4 design text has three inaccurate statements. The developer's supabase-js lowercase-only `validateUUID` finding is confirmed. The architect did not edit the spec text.
  - **M2:** delete-user deletes public rows before the auth user, so the operation isn't atomic. This is pre-existing. Follow-up: delete the auth user first, since it cascades.
  - **M3:** "every privileged role carries a profile" is assumed, not enforced. The best-effort design handles it, and no action is needed in this spec (overlaps security L1).

## Recommended next steps (ordered)

### In-spec fixes (land before commit)
1. **Critical (it clears the release blocker): add automated coverage for AC-11.** This is a frontend-developer task.
   - Export `inferKind` and `ACTION_TONE` from `src/screens/cmd/sections/AuditLogSection.tsx` (or move them to a small pure module). Do the same for `ACTION_TONE` from `src/screens/cmd/sections/phone/PhoneAuditLog.tsx`.
   - Add a jest case asserting:
     - `inferKind` returns `'user'` for both `'Store user created'` and `'Store user password set'`;
     - desktop tones are `ok` / `warn`;
     - phone tones are the same values as desktop.
   - An existing harness, `src/screens/cmd/sections/phone/__tests__/PhoneAuditLog.test.tsx`, could take a render-level assertion for the phone side.
   - After that, re-dispatch test-engineer to flip AC-11 to PASS. This is first because it's the only item that formally blocks SHIP_READY, and it doesn't touch the files in items 2-3.
2. **Should-fix, ranked just below Critical: canonical `UUID_RE` gate in `supabase/functions/delete-user/index.ts`.** Raised by security M1 and architect S1. This is a backend-developer task.
   - After normalization and **before** the self-guard and any read, add `if (!UUID_RE.test(userId)) -> 400 { error: "userId required" }`.
   - Copy `UUID_RE` inline, byte-identical to `manage-store-user/index.ts:48`, following the spec 027 §4.2 inline-not-shared rule.
   - `cannot delete self` stays byte-identical.
   - Why it ranks high even without a Critical label: it closes the remaining path to the self-delete / half-delete, recoverable-only-by-psql state that the CLAUDE.md self-guard rule exists to prevent. That is the stated purpose of L7 / AC-8. Both reviewers who looked at it ask for it in this spec, and it's one line on lines this spec already changes.
3. **Should-fix: extend `scripts/smoke-edge-roles.sh` Arm 8 and fix `sd_psql`'s exit status.** Code-reviewer Should-fix, plus the smoke half of item 2.
   - Fix `sd_psql` first, so fixture failures show up as fixture failures. The reviewer's suggested shape is `o=$(docker exec ... ) || return 1; printf '%s' "$o" | tr -d ' '`.
   - Then add two calls to Arm 8: the caller's own id in braces, and with the hyphens removed. Expect 400 `userId required` for both, and rerun the profile / auth.users / user_stores post-checks.
   - Item 2 should land first so the new arms go green. The smoke must also fail on a pre-fix build (the same proof style the developer used for the uppercase case).
4. **Coverage gap, recommended but not a gate: commit the AC-4 failure-injection arm.** Add it to `scripts/smoke-store-user.sh`, following the existing Arm C trigger pattern:
   - install a temporary `audit_log` BEFORE INSERT trigger that raises `P0001`;
   - assert create returns 201 and set_password returns 200, and that the account survives;
   - assert the logs carry the code but not the trigger's message;
   - remove the trigger in `cleanup()`.
   - If the owner adds this, update the A7 tally comment as well.
5. **Nits, optional, in the same pass if convenient:**
   - extend the log-hygiene header in `manage-store-user/index.ts:22-24` to mention the audit lines;
   - add a `logAuditFailure` helper;
   - add an "update when adding a success arm" comment by A7 (`smoke-store-user.sh:493-497`);
   - fix the alignment in `formatAuditAction.ts:26-27` and `AuditLogSection.tsx:35-36`.
   - Optionally, an architect pass could apply the §4.4 design text corrections from architect M1 to the spec. Editing the spec is the owner's or PM's call; this proposal does not edit it.
6. **Re-run verification:**
   - full `npx jest`, `npm run typecheck` and `npm run typecheck:test`;
   - both smokes, after restarting the edge runtime and checking the bind mount;
   - then re-dispatch test-engineer (AC-11, AC-8 arms) and security-auditor (M1 closure) for a delta review, then release-coordinator.
7. **After the user commits and pushes:** confirm the latest `main` run of both `test.yml` and `db-migrations-applied.yml` is green. Also check `e2e.yml` by hand.
   - Prod deploy (`supabase functions deploy manage-store-user delete-user`) stays the owner's call and is out of scope.
   - It goes out together with spec 165's undeployed function.
   - Coordinate the commit with the spec 166 working-tree changes to the same two files.

### Follow-ups (separate specs, do not block this ship once items 1-3 land)
- **F1, Medium: `audit_log` integrity / visibility migration.** Security M2 + M3, plus the spec 157 FUTURE-1 deferral. One migration spec covering:
  - a RESTRICTIVE SELECT policy hiding `'Store user created'` / `'Store user password set'` rows from non-privileged store members (closes the username-enumeration channel);
  - RESTRICTIVE or append-only UPDATE/DELETE on `audit_log`;
  - a RESTRICTIVE INSERT that reserves these action strings for `service_role` (blocks forged rows).
  - Must pass the spec 053 permissive-policy lint.
  - Until it lands, the owner should **explicitly accept** M2: staff can list in-store usernames through PostgREST. That is option (b) in security M2.
  - This should be the first follow-up, because M2 is a new exposure created by this spec.
- **F2, Low: super_admin without a profile.** Security L1 + architect M3. `readCallerBrand` / `requireAdminCaller` in `manage-store-user` should confirm that a `profiles` row with `role='super_admin'` exists, matching `auth_is_super_admin()`, before taking the cross-brand short-circuit. Otherwise return 403. This closes the silent audit-FK-failure hole for the most sensitive caller.
- **F3, Low (pre-existing): stop echoing `error.message` from delete-user.** Security L2. Collapse `delete-user/index.ts:102,117,235,250,264,274` to fixed strings, the way `manage-store-user` already does. That covers the `req.json()` SyntaxError and the auth-js `validateUUID` text.
- **F4, Low (pre-existing): delete the auth user first in delete-user.** Architect M2. Reorder so `auth.admin.deleteUser` runs first (it cascades to `profiles` / `user_stores`), then delete `invitations`. A transient GoTrue failure would then no longer leave public rows deleted while the auth user survives. Pairs naturally with F3.
- **F5, Low (pre-existing; not raised in any reviewer file, added at the dispatcher's request and checked by me in code): audit-row day grouping uses UTC.**
  - The grouping key is the UTC date: `new Date(e.timestamp).toISOString().slice(0, 10)` at `AuditLogSection.tsx:164` and `PhoneAuditLog.tsx:96`.
  - But `formatDayLabel` and `formatTime` render in local time.
  - The row and "last at" timestamps at `AuditLogSection.tsx:318,395` also print UTC via `toISOString()`.
  - Result: evening events in US time zones fall under the next day's group header, and displayed times disagree with each other.
  - This spec didn't introduce it, but the new rows inherit it.
- **F6: move `'User invite'` / `'User deleted'` to server-side writes.** Already listed as out of scope in the spec (`src/store/useStore.ts:3414-3452`).
- **F7, Nit: shared smoke fixture helper.** Extract the duplicated "create admin fixture via `/auth/v1/admin/users` + profile insert" snippet (`smoke-store-user.sh` Arm 14 and `smoke-edge-roles.sh` Arm 8) into a `scripts/lib` helper.

## Out of scope for this review
- The `audit_log` tamper / forgery / staff-visibility hardening (F1). It needs a migration, and the spec is explicitly migration-free.
- The super_admin-without-profile caller check (F2).
- delete-user raw `error.message` echoes (F3) and the non-atomic delete ordering (F4). Both pre-existing.
- The UTC-vs-local day grouping and timestamp display in both audit views (F5). Pre-existing display bug.
- Moving `'User invite'` / `'User deleted'` to server-side writes (F6), and the shared smoke-helper cleanup (F7).
- Other spec 165 findings (L5 password floor, L6 brand-gate oracle), prod deploy of both edge functions, and the `npx supabase status` darwin-arm64 CLI binary issue the test-engineer hit locally (environment, not code).
