# Spec 170 release proposal: audit_log RLS hardening

## Re-synthesis after fix pass (2026-10-22)

This section supersedes the original proposal below. The original is kept for history. I read these inputs directly:
- `specs/170-audit-log-rls-hardening.md`, including decision 9, AC-22/AC-23, §12, §13, the follow-ups and both `## Files changed` subsections;
- the dated "Delta re-review (fix pass)" section in each of the four reviewer files (code-reviewer, security-auditor, test-engineer, backend-architect).

I also spot-checked that main Claude's post-review edits actually landed:
- **DM-1 (stale spec counts): fixed.** The spec now says four rollback drops (`:186`), "four rows added" (`:256`), "Three INSERT restrictive policies" (`:258`), "Arm map (54)" (`:371`), plan 54 in the ordering note (`:417`), `…0004` aged in §10b (`:423`), `plan(54)` in §11 (`:445`), and "(a) / (b) / (c) / (f)" in §13 (`:482`). The original-pass `Files changed` entry (`:501`) still says `plan(45)`. That is historical and is superseded by the fix-pass entry at `:512`.
- **DM-2 (migration header): fixed.** Migration `:57` now reads "FORCE RLS would make (b)/(c) refuse those writers ((f) would not: they omit created_at)". The edit is comment-only.
- **Security L6: added.** The §12 pre-check (`:464`) has the read-only `null_dated` / `future_dated` count query, plus the instruction to clean up and record any non-zero rows as postgres before the apply.

I have no shell. I did not run `gh`, `git`, pgTAP or jest, and I do not certify CI state.

### Verdict
verdict: SHIP_READY (conditional; the commit is the user's decision)
rationale: All four delta reviews report 0 Critical and 0 Should-fix, the test-engineer reports 23/23 ACs PASS, and what remains is Low, Minor, Nit or owner-deferred follow-ups. Ship still depends on three conditions: the §12 prod apply runs before the push, and both CI gates on `main` are green before and after the push.

**Condition A: CI gate state is not verified by this proposal.** Under the CLAUDE.md hard rule, SHIP_READY does not stand if the latest `main` run of `.github/workflows/test.yml` or `.github/workflows/db-migrations-applied.yml` is red or in progress. Check both before pushing:
```
gh run list --branch main --workflow test.yml --limit 1
gh run list --branch main --workflow db-migrations-applied.yml --limit 1
```
If either is red, surface the run URL and wait for user direction. Check `e2e.yml` by hand as well (project memory: it is not yet in the gate checklist).

**Condition B: rollout order (§12).** Apply to prod via Supabase MCP first, then push. Pushing first hard-fails `db-migrations-applied.yml` until the apply. See step 3 below.

### Findings summary (delta counts supersede the originals)

**code-reviewer: 0 Critical, 0 Should-fix, 2 new Nits (plus the earlier optional Nits).**
- **Closed:** the AL-8 vacuity Should-fix. Fixture `…0004` is aged to 91 days, so only `auth_is_privileged()` can refuse. The stale "sharpest arms" / AL-7 UPDATE-policy prose is fixed. The `db.ts:179` comment nit is also closed.
- **Checked clean:** policy (f), C-1..C-8 and D-10. The arm arithmetic (S 7 + F 1 + R 4 + I 16 + W 6 + U 2 + C 8 + D 10 = 54) matches `plan(54)`.
- **New Nits:**
  - The D-10 comment records a one-time negative-control result (`audit_log_rls_hardening.test.sql:626-628`) that no CI run re-checks.
  - The migration's shape-list heading (`:11`) cites "Open questions resolved" while (f) comes from decision 9. Decision 9 sits inside that section of the spec, so the heading is accurate as written. I treat this nit as moot.
- **Unchanged, optional:** S-7 overload sensitivity, S-3/S-4 deparse pins, W-3/W-4 `detail` literal pins.

**security-auditor: 0 Critical, 0 High, 0 Medium, 4 Low (L1, L2, L4, L6), 1 Informational (L5). "Nothing blocks."**
- **M1: closed** by policy (f), `audit_log_restrict_insert_created_at_now`.
  - Rejected with `42501`:
    - explicit future, past, NULL, `'infinity'`, `'-infinity'`, `'tomorrow'`, `clock_timestamp()` and `now() + 1µs`;
    - multi-row inserts and `INSERT … SELECT`;
    - `ON CONFLICT DO NOTHING` / `DO UPDATE`;
    - `MERGE`;
    - `COPY FROM`;
    - real PostgREST requests (403 / `42501`), including upserts.
  - Still accepted, as intended: omitted `created_at`, `DEFAULT`, and the `addAuditEvent` request shape.
  - DEFINER and service_role writers are unaffected.
- **L3: closed (documented).** The spec Risks now say immutability holds per row, not per store or actor.
- **New L6 (Low):** (f) is not retroactive. NULL- or future-dated rows already on prod would stay pinned at the top of the feed and become impossible to delete through the API once the age gate lands. Local count is 0/0; prod was not checked. **Now addressed in procedure** by the §12 pre-check (see step 3a).
- **Open:**
  - L1, the exact-string blocklist; owner-deferred as F-170-6.
  - L2, privileged on-behalf attribution; accepted under decision 3 (F-170-4).
  - L4, TRUNCATE grant; owner-deferred as F-170-5.
  - L5, informational: store-less rows are visible across brands.
- **Disclosure from the auditor:** one PostgREST probe committed 2 local rows (server-clock `created_at`). The auditor deleted both as postgres right away, and the local count is back to 4. Prod was not touched.

**test-engineer: 23/23 ACs PASS, 0 FAIL, 0 NOT TESTED.**
- **Closed:** prior Finding 1, AC-14 scope unproven. D-10 is now the only behavioral catcher of mutant M6 (`auth_can_see_store(store_id) or true`). It also catches M1 and the spec-157 policy.
- **AC-22 / AC-23 are mutation-verified:**
  - dropping (f) fails C-1..C-3 and C-5..C-7;
  - the mutants `is null or = now()`, `<= now()` and `>= now() - 1 day` each fail their targeted arms;
  - the positive arms C-4 and C-8 each fail under a mutant.
- **AL-8 re-age is mutation-verified:** dropping `auth_is_privileged()` now fails PAR::AL-8 and NEW::D-7.
- **Runs:**
  - pgTAP 88/88 files: new file 54/54, parity 20/20, lint 5/5, actor cascade 13/13;
  - jest 234 suites / 2849 tests, green in all 5 runs;
  - `typecheck` and `typecheck:test` exit 0;
  - all four AC-21 smokes exit 0.
- **Residual, Info:**
  - The developer reported a jest worker crash about once in three runs. The test-engineer ran jest 5 times and never reproduced it, so the suite involved is unknown.
  - The +3 jest tests (2846 → 2849) are attributed to other staged work, not to spec 170.
  - The `addAuditEvent` path was not driven through PostgREST by the test-engineer, but the security-auditor's PostgREST probe covered that request shape.

**backend-architect (post-impl delta): 0 Critical, 0 Should-fix, no contract drift. 2 new Minors, both since fixed by main Claude.**
- **SF-1: closed.** The architect rates D-10's wide-SELECT-probe mechanism as better than the original `where true` design: it has a visibility precondition, a dedicated fixture `…0027`, and no collateral deletes.
- **M-2: closed.** D-4 is labelled as SELECT-masked.
- **M-1: unchanged.** S-7 overload sensitivity; the architect requires no change.
- **M-3: strengthened** by the AL-8 re-age.
- **Decision 9 / policy (f) conforms:**
  - The name and predicate match the spec verbatim.
  - `created_at` is `timestamptz default now()`, so the default and the check share one transaction clock.
  - No RLS-subject writer sets `created_at`.
  - C-7 closes the "insert pre-aged, then delete" compose-attack.
- **Counts match between spec and code:** 7 policies, 5 `spec 170:` comments, 0 UPDATE policies, `plan(54)`, parity `plan(20)`.
- **DM-1** (stale spec counts) and **DM-2** (migration header `:57`): fixed post-review by main Claude; verified above.

**Critical count across all reviewers: 0. No Should-fix remains open.** Nothing in the reviewer files triggers the Critical hard rule. The remaining SHIP_READY gate is CI state (Condition A).

### What closed in the fix pass
| Item | Source | Closed by |
|---|---|---|
| D-4 does not isolate the DELETE scope clause | test-engineer F1, architect SF-1 | D-10 (wide-SELECT probe, visibility precondition, fixture `…0027`); mutation-verified against M6, M1 and spec 157 |
| D-4 message overstates what it proves | architect M-2 | D-4 comment and message relabelled "SELECT-masked; D-10 isolates" |
| AL-8 passes vacuously; stale AL-7/AL-8 prose | code-reviewer Should-fix | Fixture `…0004` aged 91 days; prose rewritten; mutation-verified |
| `db.ts:179` comment inaccurate | code-reviewer Nit | Comment-only change |
| Client-settable / NULL `created_at` pins undeletable rows | security M1 | Policy (f), owner decision 9; C-1..C-8; AC-22/AC-23 |
| Undocumented privileged erase paths | security L3 | Sentence in spec Risks |
| Stale spec counts | architect DM-1 | Main Claude spec edit (verified) |
| Migration header lists (f) among FORCE-RLS refusers | architect DM-2 | Main Claude comment-only edit (verified) |
| Existing NULL/future rows on prod not handled | security L6 (new) | §12 pre-check added (procedure; prod count still unknown) |

### Residual items (non-blocking)
- **Security L6 (Low): procedural until the prod pre-check runs.** If the prod count is non-zero, those rows must be removed and recorded as postgres **before** the apply. After the apply nobody can delete them through the API.
- **Code-reviewer Nits (optional):**
  - the D-10 provenance comment;
  - S-7 `count(*) = 5` overload sensitivity (also architect M-1);
  - S-3/S-4 deparse-literal pins;
  - W-3/W-4 `detail` literal pins.

  Revisit these only if they flake or mislead.
- **Unreproduced jest worker crash** (developer report). CI `test.yml` is the backstop. If it shows up there, triage it separately; there is no evidence it relates to spec 170, since no jest-tracked file is in the 170 diff.
- **Silent semantics, by design:** API UPDATE and DELETE of a fresh row return 0 rows without an error. Admin purge skips store-less rows (N2). Client clock skew at the 90-day boundary is harmless (N3).

### Recommended next steps (ordered)
1. **Verify the commit contents (commit hygiene).** The index is shared with other specs:
   - Per main Claude, spec 167/168/169 work is staged in the same index. The session-start snapshot shows the spec 167 files staged. The recent log already has commits for spec 168 (`3508960`) and spec 169 (`55c5059`), so confirm which non-170 paths are still staged with `git diff --cached --stat`.
   - The spec 170 fix-pass edits are **unstaged on top of the staged originals** (`AM`/`MM`). Main Claude will re-stage them. This proposal file will also show as modified after this write and needs re-staging too.
   - **The spec 170 file set:**
     - `specs/170-audit-log-rls-hardening.md`
     - `specs/170-audit-log-rls-hardening/reviews/` (5 files, this one included)
     - `supabase/migrations/20261022000000_audit_log_rls_hardening.sql`
     - `supabase/tests/audit_log_rls_hardening.test.sql`
     - `supabase/tests/super_admin_policy_parity.test.sql`
     - `src/lib/db.ts`
   - **`src/lib/db.ts` is the one shared-surface file.** Before committing, `git diff --cached src/lib/db.ts` plus `git diff src/lib/db.ts` together should show only the `deleteStore` hunks: the line removal plus the two comments. Spec 167 declares no `db.ts` change, so any other hunk does not belong to spec 170 and needs a decision.
   - Keep the 170 commit separate from the 167 commit, so neither picks up the other's files.
   - **Ship-order coupling with spec 167.** Spec 167's own proposal makes its ship conditional on landing F1 (this spec) together with it, or on an explicit M2 risk acceptance. Spec 170's (a) policy is that F1. If spec 167's `manage-store-user` writer is deployed before spec 170 is applied to prod, staff can read store-user rows during the gap. The cleanest order is to apply 170 to prod before or together with deploying 167. The owner decides the order.
   - The commit is the user's decision. Main Claude does not auto-commit.
2. **Pre-push CI check (Condition A).** Confirm that the latest `main` runs of `test.yml` and `db-migrations-applied.yml` are both green, and check `e2e.yml` by hand. If either gate is red or in progress, stop and surface the run URL.
3. **Prod apply via Supabase MCP FIRST (spec §12, project `ebwnovzzkwhsdxkpyjka`). Push only after this.**
   - a. **Pre-check (read-only):**
     - `pg_policies` for `audit_log` returns exactly the four spec 157 policies;
     - `relforcerowsecurity` is false;
     - **L6:** `select count(*) filter (where created_at is null) as null_dated, count(*) filter (where created_at > now()) as future_dated from public.audit_log;`. If either count is non-zero, remove those rows as postgres before the apply and record what was removed.
     - Optionally, while there, record prod's TRUNCATE grant state for F-170-5 (security L4).
   - b. **Apply:** run the migration body verbatim, with `begin/commit` intact.
   - c. **Record:** `insert into supabase_migrations.schema_migrations (version, name) values ('20261022000000', 'audit_log_rls_hardening');`. The version must byte-match the filename.
   - d. **Post-check:** S-1 returns **seven** rows, including `audit_log_restrict_insert_created_at_now/INSERT/RESTRICTIVE`, and the S-6 comment count is **5**.

   Applying before the push only hits the gate's warn path (exit 0, "prod has an entry not in repo"). Pushing first hard-fails `db-migrations-applied.yml` until the apply.
4. **Push to `main`, then the post-push CI check.** Per CLAUDE.md, confirm that the latest `main` run of **both** `test.yml` and `db-migrations-applied.yml` is green, with `gh run list --branch main --workflow <file> --limit 1` for each. Check `e2e.yml` by hand. If any of them is red or in progress, surface the run URL and wait for user direction. SHIP_READY does not stand while either gate is red.
5. **Optional, non-blocking follow-ups** (see the next subsection): open specs for F-170-5 and F-170-6 when convenient.

### Follow-ups (not blocking ship)
- **F-170-1 remainder (optional):** `alter table public.audit_log alter column created_at set not null`. This closes the NULL variant for service_role too. Do it only after the step-3a prod NULL count is 0.
- **F-170-2:** delete or wire the dead `db.deleteStore` (zero callers).
- **F-170-3:** move the PO RPCs' audit writes (`'PO received'`, `'PO price change'`, `'PO closed short'`, `'PO cancelled'`) behind a DEFINER helper so they can join the server-only list.
- **F-170-4 / security L2:** brand-scope the privileged on-behalf `user_id` exemption. Consider refusing NULL-actor rows for DEFINER-only action names. Accepted under decision 3.
- **F-170-5 / security L4:** `revoke truncate on public.audit_log from anon, authenticated`, plus a `has_table_privilege` arm. Check how it interacts with `public_grants_explicit.test.sql`. The owner declined to fold it in (decision 9).
- **F-170-6 / security L1:** a positive allowlist or CHECK on `action` to replace the exact-string blocklist. Pairs with F-170-3. The owner declined to fold it in (decision 9).

### Out of scope for this review
- **Security L3, long-term:** a true append-only trail, either an actor snapshot in the row or an archive table outside the cascade.
- **Security L4, broader:** the TRUNCATE revoke sweep across the other 46 public tables, as its own spec (per spec 041).
- **Security L5:** store-less rows visible across brands to privileged callers. This belongs to the separate `audit_log` visibility audit, which is already out of scope in the spec.
- A reciprocal comment on the 90-day literal in `cleanupOldRecords`. AC-18 requires that function to stay unchanged.
- Already out of scope in the spec: moving `'User invite'` / `'User deleted'` server-side, the configurable retention window, FORCE RLS, and the `app.json` slug.

---

*The original pre-fix-pass proposal (2026-10-22) follows unchanged. Its verdict and counts are superseded by the section above.*

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer found a Critical, and all 21 acceptance criteria pass locally. But two cheap in-scope test-sharpness fixes are still open: D-4 does not isolate the DELETE scope clause, and AL-8 now passes vacuously. Security M1 also needs an owner decision before the prod apply, and the commit and push are not yet sequenced against the db-migrations-applied gate.

## Findings summary

- **code-reviewer: 0 Critical, 1 Should-fix, 7 Nits** (2 of the nits are out of scope).
  - Should-fix: `super_admin_policy_parity.test.sql` AL-8 (`:328-337`) deletes fixture `…0004`, which is still fresh (`:137`). Since spec 170 nobody can API-delete a fresh row, so the arm passes whether or not the privilege gate works. Its prose is also stale: the header at `:63-73` calls AL-7/AL-8 "the sharpest arms", and the AL-7 comment at `:312-316` says the UPDATE policy is what refuses, but no UPDATE policy exists any more.
  - Nits:
    - S-7 `count(*) = 5` breaks if any of the five writers gains an overload.
    - S-3/S-4 pin deparsed literals that may change across PG versions.
    - W-4 and W-3 pin the exact `detail` strings their RPCs write.
    - The `db.ts:179` comment "Delete all related data first" is now slightly inaccurate.
    - Out of scope: the 90-day literal in `cleanupOldRecords` has no comment pointing back to the policy.
    - Out of scope: `deleteStore` has no callers.
  - All project-policy checks are clean: helpers, no `auth_is_admin`, begin/commit, idempotent, rollback block, AC-2 comments, plan count.

- **security-auditor: 0 Critical, 0 High, 1 Medium, 5 Low** (L5 is informational).
  - The full dispatch checklist was verified by live rolled-back probes plus pgTAP. Nothing grants new access, and every permissive predicate touched is a strict subset of the one it replaces. Restrictive policies cover `anon`, and no hidden RLS-subject writer exists.
  - **M1:** staff can insert a self-attributed row with `created_at` set to the future (2099) or to NULL.
    - Under the new age gate, nobody can delete that row through the API. A NULL row is never deletable, and because `ORDER BY created_at DESC` puts NULLs first, it sorts to the top of the feed.
    - 100 such rows push every real event out of the admin feed (`limit 100`).
    - Spec 170 is what removed the REST-side fix (the old unscoped DELETE).
    - Fix: a RESTRICTIVE INSERT `with check (created_at = now())`. This also rejects explicit NULL. Optional: `alter column created_at set not null`.
    - The auditor recommends this before or alongside the prod apply, or as the very next migration. It should not wait in the backlog.
  - **L1:** list (b) blocks exact strings only. Variants in case, whitespace, or label text get through, e.g. `'order missed'` renders the same as the real row in `en`. Fix: a positive allowlist or CHECK on `action`.
  - **L2:** privileged callers can attribute a row to any profile, or to NULL. NULL mimics DEFINER "system" rows. Owner decision 3 accepted this risk.
  - **L3:** two privileged erase paths remain by design: the `user_id` FK's ON DELETE SET NULL, and the store/brand cascade. "Nobody can erase a recent row" holds per row, not per store or per actor. Fix: one sentence in the spec's Risks.
  - **L4:** pre-existing. `anon`/`authenticated` hold TRUNCATE on `audit_log`, and TRUNCATE ignores RLS. Not reachable today. Optional fold-in: `revoke truncate … from anon, authenticated` plus a `has_table_privilege` arm.
  - **L5:** informational, pre-existing. Store-less rows are readable by any privileged caller in any brand.

- **test-engineer: 21/21 ACs PASS, 0 FAIL, 0 NOT TESTED. 1 Medium coverage gap.**
  - Run results:
    - pgTAP 88/88 files (new file 45/45, parity 20/20, lint 5/5).
    - jest 234 suites / 2846 tests.
    - Both typechecks exit 0.
    - All four AC-21 smokes exit 0.
    - N4 confirmed: no smoke touches `audit_log` through PostgREST.
  - **Finding 1 (Medium):** D-4 (AC-14) cannot prove the new DELETE store/brand scope.
    - A DELETE whose WHERE references a column also applies the SELECT policies. `store_member_read_audit_log` already hides brand-B rows from a brand-A admin.
    - Mutation test: mutant M6 (`auth_can_see_store(store_id) or true`) passes all 45 arms.
    - The other three predicate clauses (age gate, privilege, store-less arm) are each caught by a mutation.
    - Recommended Option A: an in-transaction `probe_wide_select` permissive SELECT `using (true)`, then an admin delete of a fresh 91-day brand-B fixture, read back as postgres. `plan(45)` becomes `plan(46)`.
  - Info: the db-migrations-applied gate goes red on push until prod has the migration.

- **backend-architect (post-impl): 0 Critical, 1 Should-fix, 3 Minor. No contract drift.**
  - The DDL, names, kinds, comments, header, rollback, `deleteStore`, the §10b amendment, and the 45-arm order all match the design.
  - **SF-1:** the same D-4 masking as test-engineer Finding 1. The architect owns it as a gap in the design, not developer drift.
    - Proposed shape: arm D-10. A column-free `delete … where true` as admin, placed after every other read-back. It asserts the brand-B row survives and an in-scope control row `…0027` is gone. Run a one-time, uncommitted spec-157 negative control to confirm the arm can fail.
  - Minor:
    - M-1: the S-7 overload brittleness (same as the code-reviewer nit).
    - M-2: the D-4 message overstates what it proves.
    - M-3: AL-6/AL-10 aged-row parity verified as sharp.
  - The architect rates SF-1 as not blocking but cheap to close in this PR.

**Critical count across all reviewers: 0.** No Critical rule applies. The verdict is FIXES_NEEDED because two reviewers independently recommend closing the D-4 gap in this PR, the AL-8 vacuity is a should-fix inside the same file this spec already amends, and M1 needs an owner decision before the prod apply.

## Recommended next steps (ordered)

### (a) In-scope fixes (within the owner-approved decisions; backend-developer, no new owner approval needed)

1. **Make the DELETE scope clause behaviorally proven** (Medium / Should-fix, raised by both test-engineer F1 and architect SF-1). This is first because the brand scope is this spec's stated closure of spec 157 FUTURE-1, and today a logically dead version of the clause passes every arm.
   - Add the wide-SELECT-probe arm (test-engineer Option A) to `supabase/tests/audit_log_rls_hardening.test.sql` and bump `plan(45)` to `plan(46)`. Note the bump in the header, as §10a allows.
     - As postgres, inside the admin block: `create policy probe_wide_select on public.audit_log for select using (true);`. The test transaction rolls it back. The spec-053 lint runs in its own file, so it never sees the probe.
     - Use a **fresh** 91-day brand-B fixture, not D-4's `…0023`. Then, as the admin brand-A JWT, `delete … where id = <new fixture>`.
     - Read back as postgres: the row survives.
   - Run the architect's one-time, uncommitted negative control: recreate the spec-157 `using (auth_is_privileged())` DELETE policy and confirm the new arm fails. Do the same against mutant M6 if convenient. Record "verified against a spec 157 negative control" in the arm comment.
   - Alternative if the developer prefers it: the architect's D-10 shape (`where true`, in-scope control `…0027`, placed after every read-back). Either one closes the gap. Pick one; adding both is not needed.
   - Keep D-4 as the PostgREST-shaped AC-14 arm. Reword its message and comment (`:686-690`) to say it is SELECT-masked and that the new arm is the one that isolates the clause (architect M-2).
2. **Make AL-8 sharp again** (Should-fix, code-reviewer). In `supabase/tests/super_admin_policy_parity.test.sql`:
   - Age fixture `a5000157-…-000000000004` (`:137`) to `now() - interval '91 days'` in the fixture insert. The plain user can still SELECT it through the Towson grant, so the read-back stays meaningful. `plan(20)` is unchanged.
   - Rewrite the stale prose:
     - header `:63-73` ("sharpest arms");
     - AL-7 comment `:312-316` (should say it is now covered by default-deny, since there is no UPDATE policy);
     - the `:123` fixture-note cross-reference, if it is affected.
   - This is the same file and the same N1 amendment the spec already approved.
3. **Stale and overstating comments** (Nit). Fold these into the same pass:
   - `src/lib/db.ts:179`: "Delete all related data first" becomes "Delete the non-cascading related data first", or merge it with the new line-185 comment.
   - Optional hint on S-7 explaining that an overload causes the count failure (code-reviewer nit / architect M-1). No logic change is needed; architect M-1 says the loud failure is acceptable.
4. **Doc-only Risks sentence** (security L3). One sentence in the spec's §13 Risks: the `user_id` FK SET NULL and the store/brand cascade are privileged erase paths that remain by design, so immutability holds per row, not per store or per actor. This is a spec text edit for the developer or PM to make. The release-coordinator does not edit the spec.
5. **Re-verify after 1-4:**
   - `bash scripts/test-db.sh`, expecting 88/88 files with the new file at 46/46;
   - full `npx jest`, `npm run typecheck`, `npm run typecheck:test`;
   - the four AC-21 smokes;
   - a re-run of the code-reviewer and test-engineer, or at minimum the test-engineer.

### (b) Scope additions: each needs explicit owner approval (not in the approved decisions; do not fold in without a yes)

6. **Security M1: RESTRICTIVE `created_at = now()` INSERT check, covering the NULL variant** (Medium). Decide **before the prod apply**. Spec 170 removes the REST-side cleanup, so shipping 170 without M1 creates a window where staff-planted future-dated or NULL rows can only be removed with psql or MCP.
   - Shape: `create policy "audit_log_restrict_insert_created_at_server_clock" on public.audit_log as restrictive for insert with check (created_at = now());` plus a `comment on policy` citing spec 170 (or the follow-up spec).
   - The auditor confirmed no RLS-subject writer sets `created_at`. DEFINER and service_role writers bypass RLS, and pgTAP aged fixtures insert as postgres.
   - Optional companion: `alter table public.audit_log alter column created_at set not null`. This is a schema change, so first check `count(*) where created_at is null` = 0 on prod.
   - If folded into 170, these change:
     - S-1 expects 7 policy rows and S-6 a comment count of 5;
     - the §12 post-check lists change the same way;
     - the rollback block needs one more `drop policy if exists`;
     - new pgTAP arms (staff insert with a future, past, and NULL `created_at` gets `42501`; an omitted `created_at` still succeeds) raise the plan count.
   - If not folded in, the owner should commit to it as the **immediately next** migration (F-170-1, upgraded from backlog per the auditor), ideally applied to prod together with 170.
7. **Security L4: `revoke truncate on public.audit_log from anon, authenticated`** (Low, pre-existing, defense in depth). Zero runtime impact, since no writer truncates. Pin it with a `has_table_privilege('authenticated','public.audit_log','TRUNCATE') = false` arm. This adds a deliberate table-level REVOKE, which architect §7 had chosen to avoid for UPDATE, so `public_grants_explicit.test.sql` interactions should be checked. The 46-table sweep stays a separate spec. Check prod's grant state during the §12 pre-check either way.
8. **Security L1: positive action allowlist** (Low). This replaces list (b)'s exact-string blocklist with an allowlist or CHECK of canonical client-writable actions. It is a larger change that needs a full list of every client action string, and it pairs naturally with F-170-3. **Recommendation: do not fold into 170.** Treat it as its own spec (see Follow-ups).

### (c) Rollout and commit sequencing (owner)

9. **Commit hygiene.** Spec 170's four files are untracked or unstaged, while the spec 167, 168, and 169 files are staged in the same index:
   - untracked: `supabase/migrations/20261022000000_audit_log_rls_hardening.sql`, `supabase/tests/audit_log_rls_hardening.test.sql`, `specs/170-audit-log-rls-hardening.md`, `specs/170-audit-log-rls-hardening/`;
   - unstaged modified: `supabase/tests/super_admin_policy_parity.test.sql`, `src/lib/db.ts`.

   Make sure the 170 commit holds exactly the spec 170 files and nothing else, and that a 167/169 commit does not pick up 170's work by accident. Check `git diff src/lib/db.ts` first: it should be the single `deleteStore` hunk. When and how to commit is the user's decision. Main Claude does not auto-commit.
10. **Prod apply before push (spec §12).** Apply to prod via Supabase MCP on `ebwnovzzkwhsdxkpyjka`:
    - run the §12 pre-check;
    - apply the migration body verbatim with `begin/commit` intact;
    - insert `'20261022000000', 'audit_log_rls_hardening'` into `supabase_migrations.schema_migrations`;
    - run the post-check (S-1 rows and S-6 count, adjusted if 6 or 7 are folded in).

    Only then push to `main`. Pushing first hard-fails `db-migrations-applied.yml` until the apply. Applying first only triggers the gate's warn path (exit 0).
11. **Post-push CI check.** Confirm the latest run on `main` of **both** `test.yml` and `db-migrations-applied.yml` is green: `gh run list --branch main --workflow <file> --limit 1`. Per project memory, also check `e2e.yml` by hand. This proposal does not certify CI state. The release-coordinator did not run `gh`, and per CLAUDE.md SHIP_READY cannot be claimed while either gate on `main` is red or in progress. If one is red, surface the run URL and wait for user direction.

Once steps 1-5 are done (plus 6/7 if the owner approves them) and reviewers re-confirm with no Critical, this would become SHIP_READY, conditional on steps 10-11.

## Out of scope for this review

- **F-170-1** (security M1). Tracked above in (b), item 6. If not folded in, it becomes the next migration, not a backlog item.
- **F-170-2:** delete or wire the dead `db.deleteStore`, which has no callers.
- **F-170-3:** move the PO RPCs' audit writes (`'PO received'`, `'PO price change'`, `'PO closed short'`, `'PO cancelled'`) behind a DEFINER helper so they can join the server-only list.
- **Security L1:** a positive allowlist or CHECK on `action` in place of the exact-string blocklist. Pairs with F-170-3.
- **F-170-4 / security L2:** brand-scope the privileged on-behalf `user_id` exemption, and refuse NULL-actor rows for DEFINER-only action names. Accepted under owner decision 3.
- **Security L3 (long-term):** a true append-only trail, either by snapshotting actor name and role into the row or by an archive table outside the cascade.
- **Security L4 (broader):** the TRUNCATE revoke sweep across the other 46 public tables. This is a separate spec, as spec 041 recommended.
- **Security L5:** cross-brand visibility of store-less rows to privileged callers. This goes in the separate `audit_log` visibility audit the spec already lists as out of scope.
- Client-side reciprocal comment on the 90-day literal in `cleanupOldRecords` (`db.ts:5997`). AC-18 requires that function to stay unchanged.
- Making S-3/S-4 robust to deparse changes, and loosening the W-3/W-4 `detail` literal pins. Revisit only if they flake.
- Moving `'User invite'` / `'User deleted'` server-side, the configurable retention window, and FORCE RLS. These are already listed as out of scope in the spec.
