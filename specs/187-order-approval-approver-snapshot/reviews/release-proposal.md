# Release proposal: spec 187

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical and every AC passes, but the auditor's H1 lets one admin put their lines and approval permanently under another admin's name, which defeats the purpose of this spec, and the fix is cheapest now because the migration has not been applied.

Naming: "187-H1" and "187-H2" are this audit's findings. "164-H1", "164-H2" and "164-M2" are the older findings in `specs/164-profiles-insert-hardening/reviews/security-auditor.md`. They are different findings with similar labels.

## Findings summary
- **code-reviewer:** 0 Critical, 2 Should-fix, 9 Nits. It read the code and ran nothing. Top issues: `thrown` doubles as the "did it throw" flag in `delete-user`, and the near-identical `DeleteAuditCtx` and `DeleteAuditContext` names.
- **security-auditor:** 0 Critical, 2 High, 2 Medium, 7 Low. The M1 erase-and-return chain and L4 from the spec 178 audit are closed, but the columns can still end up false.
  - 187-H1: another admin's lines and approval stay under the first admin's name.
  - 187-H2: an older cross-brand hole now also reaches approver emails and approval rows.
  - M1: the snapshot's sources can be forged before approving. M2: deleting a store erases the record.
  - `delete-user` was only read, and no probe went through real HTTP or a signed JWT.
- **test-engineer:** AC-1 to AC-31 all PASS, 0 not tested. AC-23 to AC-29 are hand-run smokes that no CI repeats. Runs: pgTAP 97/97 files, jest 296 suites and 3,771 tests, `typecheck:test` exit 0. Its summary says two Should-fix items but it lists three:
  - The base typecheck fails here for an environmental reason.
  - `delete-user` has never been type-checked.
  - `smoke-edge-roles.sh` has not been run.
- **backend-architect:** 0 Critical, 6 Should-fix, 6 Nits, no behaviour drift. The Should-fix items cover the prod runbook, rollback, landing and stale spec text. It read the code and ran nothing.

A note on AC-31: passing ACs do not clear 187-H1. No AC covers a direct PATCH of a colleague's pending row, and the design's accepted risk describes the opposite case (Bob taking over and keeping Alice's lines).

### What I checked and what I am relaying
I had read and search tools only, so I ran nothing.

**Confirmed by reading:**
- 187-H1 in the guard. The re-stamp fires only when `approved_by` changes (migration L104-107), the refusal checks only for NULL (L172), and lines are frozen only outside pending (L180).
- `instacart-cart-link` writes `status: "approved"` through the caller-token client (L668-681).
- Every client write in `useStore.ts` (L4287, L4317, L4332, L4380) runs after `createOrderApproval` in the same action. L4437 is `approved -> ordered`, which the fix does not touch.
- `demote_profile_to_user` has only the privilege and self guards, with no later redefinition. The own-row `user_stores` policy has no later redefinition either.
- `audit_log_rls_hardening.test.sql` has no match for "186" or "retention". That settles the disagreement in the architect's favour: test-engineer L103 is wrong and the file can be staged whole.
- Local `main` and `origin/main` both point at c630c7f.

**Relayed, not verified by me:**
- **CI:** `test`, `db-migrations-applied` and `e2e` were green on `main` at c630c7f on 2026-11-08, per the main session. I cannot run `gh`. The hard rule on gates is met on that basis. These runs say nothing about spec 187, because none of it is committed.
- **Typecheck:** `npm run typecheck` fails on this machine only because of 24 empty `node_modules/@types/* 2` folders, and `tsc --types node,jest` exits 0. The test-engineer and the main session each confirmed this. My file search cannot see empty folders. This is not a spec defect and does not block. A run with `--types` is narrower than the real gate, so the first `test.yml` run is the actual proof.
- **Prod state** on 2026-11-08 comes from the spec: 0 approvals, 2 privileged profiles, 0 `User deleted` rows. Re-check it at apply time.
- **Probes and smoke results** come from the reviewers who ran them.

## Should 187-H2 block this spec?

**Recommendation: no, on three conditions. The owner decides (decision 1 below).** This departs from the auditor, who says to ship the `user_stores` fix "before or with" this spec.

**Are the root causes queued? Only in prose.** No spec file covers them, and the highest spec number on disk is 189.

| Root cause | Where it is recorded | Spec file |
|---|---|---|
| `user_stores` own-row writes (164-H1) | Spec 164 audit and release proposal ("the next spec after 164"). Specs 165 and 184 repeat that it is still open. Project memory has it too | None |
| `demote_profile_to_user` brand scope and last-of-role guard (164-H2) | Spec 164 audit and release proposal | None |
| JWT role trusted over `profiles` (164-M2) | Spec 164 audit and release proposal, paired with 164-H2 | None |

Spec 163 does not carry these. It only accepts the stale-JWT window for email reads (its R3). "Next spec" was written on 2026-10-08, and more than 20 specs have been numbered since. Treating these as queued would overstate what exists.

**Why it should not block:**
- **The hole is older than this spec.** By the auditor's account, the self-link and stale claim already gave this caller cross-brand access to these tables. Spec 187 adds emails and a more damaging forgery, not the access itself.
- **The two changes touch different objects.** The root causes live in a `user_stores` policy and a `demote_profile_to_user` RPC, and spec 187 touches neither.
- **Folding them in is not cheap.**
  - Dropping the own-row arm reverses arm (9) of `legacy_permissive_policy_dropout.test.sql`, which pins it as "the legitimate self-onboarding path".
  - It is a product question.
  - It needs a sweep of the pgTAP files that touch `user_stores` (23 mention the table today, though most should not depend on this arm).
- **Waiting has a cost.** Holding spec 187 leaves its M1 chain and the direct-delete bypasses open. Once approvals exist in prod, the apply stops at step 1, because existing rows would have NULL snapshots and the guard refuses a plain backfill.
- **Exposure at apply is nil.** Prod has 0 approvals and 0 `User deleted` rows, so there is nothing to read until use begins.

**Why it still matters:** the attack needs an existing privileged account and a token still live on a demoted login. One brand admin can set that up alone by inviting a second admin and demoting them. Separately, 164-H2 lets a brand admin demote the only super_admin, with psql the only recovery. That risk does not depend on spec 187 at all. Project memory also records a second prod brand. That note is 31 days old and I did not re-check it. The standing advice about no-store staff invites does not cover this route, because demotion also produces a NULL-brand profile.

**The conditions:**
1. The part of 187-H2 that lives in this spec's guard ships with this spec (step 2).
2. Both root-cause specs are written now, not left as notes (separate specs A and B).
3. The owner accepts the remaining exposure until spec A ships, listed under step 2.

## Recommended next steps (ordered)

### Fixes before any commit or prod step

All of these edit the unapplied migration `20261108130000` in place, or the files around it.

**1. Guard: who may change a pending row. High (187-H1). This spec.**
- **Why first:** it is the only finding that makes the record false through ordinary API writes, and the guard then refuses any repair of those rows. Steps 2 and 3 edit the same code.
- **Touches:** the guard in the migration and its function comment; new arms in `order_approvals_approver_snapshot.test.sql` and its plan count; D3 and the design's risk note in the spec.
- **Rule, for callers with a non-NULL `auth.uid()`:**
  - Refuse `pending -> approved` when `new.approved_by` is not the caller.
  - Refuse a change to `lines`, `line_count`, `est_total_cost` or `channel` on a pending row under the same condition.
  - Refuse rather than auto re-stamp, as the auditor argues.
  - Use the NULL-safe form from the `v_restamp` comment, so G1 to G5 are unaffected.
  - Keep `order approval has no approver` for a NULL approver, because AC-13 pins that message. Check NULL first.
  - Fire only when those columns actually change, so the FK's SET NULL (AC-5c) still passes.
- **Expected to pass:** by reading, the app's own writes, plus `order_approvals.test.sql` and `cross_store_item_rejection.test.sql`, since their direct updates run as the admin who made the row through the RPC. Nobody has run this change.
- **New behaviour to record in the spec:** if Bob re-stamps while Alice's flow is mid-way, her later write is refused. Instacart returns `writeback_failed`, and the other channels show a toast, possibly after a page has opened or a PO has been created. The row stays pending and a retry re-stamps.
- **For the architect to rule on (my reading, not probed, not in the audit):** `external_ref` and its expiry also stay writable by another admin on a pending row. Say whether they join the list. Re-mints on `approved` rows must keep working (AC-14b).
- **Routing:** backend-architect amends the design, then backend-developer builds. This enforces D3 as the owner accepted it, so it needs no new owner decision.

**2. Guard: the stale claim. High (the in-spec part of 187-H2). This spec, same edit as step 1.**
- **Touches:** the same guard block, plus pgTAP arms for a stale `admin` claim on a `user` profile, both same-brand and NULL-brand.
- **Change:** the re-stamp and the step 1 rule also require the caller's `profiles.role` to be `admin`, `master` or `super_admin`.
- **Closes:** a stale claim can no longer stamp, approve or edit lines on a pending row.
- **Remaining until spec A ships.** These all need the stale claim plus a self-link. This list is my reading of the proposed change, which nobody has run:
  - Reading approver emails and `User deleted` rows in a self-linked store.
  - Inserting rows in the caller's own true name (L4).
  - Advancing an already-approved row to `ordered`.

**3. Snapshot sources: add an id and refuse a blank name. Medium (187-M1). This spec, with the owner's nod (decision 2).**
- **Why now:** after `delete-user`, the pointer is NULL and a forged name is all that remains, which is the spec 178 problem moved from erasing to forging. Added later, rows written in between would have no id, and the guard refuses a backfill.
- **Touches:** the migration (new no-FK column such as `approved_by_id`, the stamp trigger, the guard's re-stamp and immutability checks, comments); pgTAP arms for AC-2 to AC-5; smoke AC-24; D1 in the spec.
- **Change:** store `nullif(btrim(name), '')` and fall back to the email.
- **Separate:** auditing privileged renames and email changes goes to the backlog (separate spec D).
- **Read-only check:** confirm prod's email-confirmation setting. The email half of this finding was simulated.

**4. `delete-user`: the `thrown` flag. Should-fix (code-reviewer). This spec.**
- **Touches:** `supabase/functions/delete-user/index.ts:513-546`.
- **Why:** throwing `undefined` would fall through to the 200 path. Use a separate flag or a single `authDeleteFailed` boolean.

**5. `delete-user`: the confusing type names. Should-fix (code-reviewer). This spec.**
- **Touches:** the same file. Rename to `DeleteAuditIds` and `DeleteAuditSnapshot`, with locals `ids` and `snapshot`.

**6. Correct the runbook and spec text. Should-fix (architect, auditor Lows). This spec, spec file only.**
- **SF-1, most important:** write `'20261108130000'` into Prod apply step 3, and mark L345 and L667 as superseded. Those lines name `20261108120000`, which is spec 186's. Inserting it would make spec 186 look applied when it may not be.
- **SF-2:** add the repo changes to Rollback. Without them, following it turns `test.yml` red.
- **SF-4:** record the file coupling (see step 10).
- **SF-5:** add a dated correction about spec 186, covering L210, L231-232, L347 and L359.
- **SF-6:** record the CLAUDE.md proposal under Follow-ups (decision 6).
- **Add `deno check`** beside the smoke run in "Prod-apply additions".
- **Add to Prod apply:** the deploy CLI (`npx supabase` resolves to 3.0.0 and refuses this repo's `config.toml`), a manual `e2e.yml` check, and that a push carrying both migrations needs both on prod first.
- **Wording:**
  - L4: "a client can never supply `approved_at`" is true only for UPDATE.
  - L5: a super_admin PATCH can promote a placeholder account, so correct the note. This is a note fix, with no code unless the architect wants it while in the guard.
  - L7: the 23503 row in the API contract and its risk note don't match what the auditor saw.
  - M2: "durable record" under Known limits (decision 3).

**7. Cheap nits, only while these files are open. Nit. This spec. None of them holds the release.**
- `if exists` on the policy drop, which makes the prod step re-runnable.
- Trim the "append-only" sentence in the RPC comment.
- Reflow the comment at `src/lib/db.ts:2703-2706`.
- Add a comment that the `Promise.race` abandons the call rather than cancelling it.
- Add the missing fixtures to the AC-29 scan.
- Note the `.abortSignal` addition in the implementation notes, and add the 42501 reason to the `removeUser` follow-up.
- The remaining code-reviewer nits are optional.

### Verify the fixes

**8. Re-run everything, one track at a time.**
- **The shared local database will not change on its own.** Editing the file doesn't touch it, and the file isn't re-runnable (`add column`, `create trigger`). Apply the delta by hand, confirm the live `prosrc` matches the file, and don't run `supabase db reset` while other sessions are using the stack. Recapture the md5 references for the prod check.
- **Mutations:** remove each new rule and confirm its arm goes red, as the spec did for the others.
- **Full suites:** pgTAP, `npx jest`, `npm run typecheck:test`, and the `tsc --types` workaround.
- **`scripts/smoke-delete-user.sh`:** no CI runs it.
- **`deno check supabase/functions/delete-user/index.ts`** (Docker image is fine, since Deno isn't installed here). This is required before deploy, because no type checker has ever seen this file and a type error would pass every smoke arm.
- **`smoke-edge-roles.sh`** once at a quiet time, because Arm 4 promotes `admin@local.test`. It covers the uppercase self-id refusal. The test-engineer rates this non-blocking.
- **Security auditor** re-runs its 187-H1 and 187-H2 probes against the changed guard. No full re-review is needed.

**9. Prove a fresh build before the prod apply (SF-3).** Nobody has run `supabase db reset`, and 97/97 ran on a shared database built by hand with both migrations present. Spec 187 alone has never run.
- With the owner's go-ahead, open a draft PR containing the commit you intend to land, built in a scratch worktree. Do not use `git stash`, including the `--keep-index` trick from spec 164's proposal, because it would pull other sessions' work out of this checkout.
- `test.yml` then does a real `supabase start` on CI's pinned CLI. `db-migrations-applied` will fail on that PR, which is expected.
- If the owner declines, record the accepted risk and watch the first `test.yml` run on `main`.

### Landing, only with the owner's go-ahead

Nothing has been committed or applied.

**10. Staging.** The list below comes from the status snapshot at the start of this session, so re-check it first. No reviewer had a full per-file diff, so read `git diff` for each "whole file" entry before staging it.

| Treatment | Paths |
|---|---|
| Stage whole | `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql`, `supabase/tests/order_approvals_approver_snapshot.test.sql`, `supabase/tests/audit_log_rls_hardening.test.sql`, `supabase/tests/profiles_rls_sweep.test.sql`, `supabase/tests/auth_can_see_store_brand_scope.test.sql`, `supabase/functions/delete-user/index.ts`, `scripts/smoke-delete-user.sh`, `package.json`, `src/lib/placeholderEmail.ts`, `src/lib/placeholderEmail.parity.test.ts`, `specs/187-order-approval-approver-snapshot.md`, `specs/187-order-approval-approver-snapshot/`, `specs/178-order-approvals-fk-set-null.md`, `specs/043-profiles-rls-sweep.md` |
| Stage by hunk | `src/lib/db.ts`: only the comment near L2703 |
| Leave out | `supabase/migrations/20261108120000_retention_prune_job.sql`, `supabase/tests/retention_prune_job.test.sql`, `src/store/useStore.ts`, the `useStore*` and `PhoneOrdering` test files, and `specs/186-*`, `specs/188-*`, `specs/189-*` |

- **The index already holds other work.** The snapshot shows `specs/188-*` and `specs/189-*` staged, so a bare `git commit` would carry them. Check `git diff --cached --stat` right before committing.
- **`git commit -- <paths>` is not a way around that for `db.ts`.** It commits the whole working copy, including spec 186's hunks. If the index can't be cleared with those sessions, leave the `db.ts` comment out. It is comment-only and nothing depends on it.
- **These must travel together:** the migration with `audit_log_rls_hardening`, `profiles_rls_sweep`, `auth_can_see_store_brand_scope` and the new test file. `delete-user/index.ts` goes with `placeholderEmail.parity.test.ts`. Either half alone turns `test.yml` red (SF-4).

**11. Order against spec 186.** Either order works, because the objects are separate. If they compete for time, spec 186 goes first: its deadline is 2026-11-20 and it has its own `FIXES_NEEDED` proposal. Spec 187 does not need to wait for it. Each version must be on prod before the push that commits it.

**12. Prod apply, per the corrected spec.**
1. Re-check `order_approvals` is empty, and stop if it isn't.
2. Apply the migration body.
3. Insert version `20261108130000`.
4. Verify md5, `prosecdef`, `proconfig`, owner and `proacl`, plus the post-apply checks. Add whatever step 3 of this plan introduces.
5. Deploy `delete-user`, only after the migration. Run first, it would write email-bearing rows that staff could read.
6. Push, then confirm `test`, `db-migrations-applied` and `e2e` on `main`.

### Owner decisions (not fixes)

1. **187-H2 sequencing.** Recommended: ship this spec without waiting, on the conditions above, and write specs A and B now. The alternative is to hold this spec for spec A. That is the auditor's position and the safer one for the tenant boundary, at the cost of the waiting risks above. The auditor also invites raising the severity. I kept it at High because this spec did not create the hole, but the boundary problem is real, and the place to act on that is spec A's priority.
2. **187-M1 scope (step 3).** It adds a column beyond the D1 you accepted. Recommended: yes.
3. **187-M2, deleting a store erases approvals and `User deleted` rows.** Recommended: accept it for now and correct the "durable record" wording. A refusal or a record outside the cascade would be a separate spec. Spec 186's proposal found no caller of `db.deleteStore`, but the auditor ran the delete directly, so it is reachable through the API.
4. **L1 and L6, the email.**
   - L1: a brand admin can read a super_admin's email in stores that super_admin approved in, and the address reaches privileged clients through `select('*')`. The spec flagged this as Low, and your acceptance should be recorded.
   - L6: there is no way to erase a deleted person's email from a snapshot without disabling the trigger. It follows from the design, so you should know before rows exist.
5. **L3, store-less targets.** The user story says "every user deletion", but a target with no store links and no approvals gets only a console line, and links can be removed first. Recommended: accept, since a NULL-store row would be readable across brands, and adjust the wording.
6. **CLAUDE.md bullet (SF-6).** Approve or decline the "profiles are deleted only through `delete-user`" rule. Worth having: a direct delete now removes 0 rows with no error.
7. **For spec A: do staff ever assign themselves stores?** I found no owner-side `user_stores` write in `src/`: the four `user_stores` reads are selects and the one delete is admin-side. Recommended: no. Sibling apps weren't available to check.
8. **Go-ahead** for the draft PR, the commit, the prod apply and the deploy.

## Out of scope for this review

**Separate specs to open now:**
- **A: remove `user_stores` own-row writes (164-H1). High.** By reading, this is what closes the cross-brand part of 187-H2, because a demoted NULL-brand caller could no longer link a foreign store. Touches the policy, arm (9) of `legacy_permissive_policy_dropout.test.sql`, a sweep of the pgTAP files that touch the table, and spec 164's wrong note at L159. Keep the read policy.
- **B: `demote_profile_to_user` brand scope and last-of-role guard, paired with 164-M2. High.** Touches the RPC, its tests, `BrandsSection.tsx:890` as the UI caller, and the invitation policies. This also meets the CLAUDE.md last-of-role rule.

**Later:**
- **C:** look-alike audit actions (L2), such as `'User deleted '`. They affect all five listed actions, so replace the block list with an allowlist of what clients may write.
- **D:** audit privileged renames and email changes (from 187-M1).
- **E:** `delete-user` trusts `app_metadata.role`, with nothing clearing it on a partial failure (L7), and returns raw `error.message` to admin callers (older than this spec).
- **F:** limit what a direct INSERT can set (L4). The spec lists part of this as out of scope.
- **Existing follow-ups:** `removeUser` and its dead audit call; `inferKind` and `ACTION_TONE` entries; a store-delete refusal if decision 3 goes the other way.
- **Environment:** the 24 empty `node_modules/@types/* 2` folders. They look safe to remove, but other sessions share this checkout, so that is the owner's call.
- **`package.json`:** the long `test:smoke` chain. **`app.json` slug:** not touched.

---

# Re-proposal 2026-11-09

This covers the "Backend design amendment (2026-11-09)" and "Amendment build (2026-11-09)" sections of the spec. It is based on the re-review sections appended to `security-auditor.md` ("Re-audit 2026-11-09"), `test-engineer.md` ("Re-review 2026-11-09") and `backend-architect.md` ("Re-review 2026-11-09"), and on `code-reviewer.md`, which has no re-review. The proposal above is left as it was.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical and all three gates on `main` are green at `15aefc4`. But the amendment's account of what a stale admin claim can still do is wrong in two places: M-R1 shows the claim can still insert a row that is already approved, and SF-R1 shows that spec 191 doesn't end that exposure. Both need an owner decision or a spec correction before commit. One small code fix is recommended.

The list is short. If the owner takes the text-only route for M-R1, no code changes before commit, only spec text and one test arm.

## Findings summary
- **code-reviewer** (no re-review): originally 0 Critical, 2 Should-fix, 9 Nits. Per the architect's re-review, both Should-fix items are fixed: the `authDeleteThrew` flag, and the `DeleteAuditIds` / `DeleteAuditSnapshot` types, which are now distinct enough that swapping them fails `deno check`. Fix 7 handled most of the nits. The auditor also read the `delete-user` diff and calls it behaviour-neutral. Nothing open from this reviewer.
- **security-auditor** (re-audit): 0 Critical, 0 High, 1 Medium, 2 Low, 1 Info.
  - 187-H1 is closed: each listed column, multi-row UPDATEs and upserts are all refused.
  - The in-spec part of 187-H2 is closed for pending rows, including the cross-brand NULL-brand shape.
  - The M1 fix holds: `approved_by_id` survives every path the auditor tried.
  - **M-R1 (Medium):** the pending-row rule covers UPDATE only. A stale `admin` claim can still INSERT a row that is already `approved` or `ordered`, with any channel and backdated timestamps. Attribution stays honest. This is wider than the accepted remainder in A1 and AC-37, and it means AC-35b and AC-35e don't prove that a stale claim can't approve.
  - **L-R1:** the blank-name test trims only ASCII spaces, so a tab, U+00A0 or U+200B is stored as the name.
  - **L-R2:** `ordered_at` can be rewritten on approved and ordered rows. This dates from spec 149, and the amendment doesn't widen it.
  - **Info:** another admin's `instacart-cart-link` call on someone else's pending row still mints a link upstream before the write-back is refused.
  - Everything was probed in rolled-back transactions. There was no real HTTP, no signed JWT, and the upserts were hand-written SQL.
- **test-engineer** (re-review): 0 Critical, 2 Should-fix, 4 Nits. Every new or changed AC passes. AC-2d, AC-33, AC-35 and AC-37 pass only in part.
  - Runs: new file 68/68; every named file green; jest 301 suites and 3,835 tests; `typecheck:test` exit 0; `smoke-delete-user.sh` all arms passed.
  - `npm run test:db` passed 100/100 once. A later run failed only `legacy_permissive_policy_dropout.test.sql`, because spec 195's migration is now on the shared stack. That file belongs to spec 195, not 187.
  - **S1:** AC-35 doesn't run every route against both stale-claim profile shapes. Missing: a1 PATCH re-stamp, a1 changing lines on someone else's row, and a4 re-stamping through the RPC.
  - **S2:** the test-engineer didn't reproduce the A5 mutation results, so they are the developer's alone. The table is internally consistent.
  - **Nits:** N1, trimming is pinned only on the RPC INSERT path. N2, AC-33 tries 2 of the 8 columns. N3, AC-37a pins only the RPC insert, not a direct INSERT.
  - The Handoff block at the end of `test-engineer.md` is still the first review's. The re-review section has none of its own. This is cosmetic.
- **backend-architect** (re-review): 0 Critical, 3 Should-fix, 8 Nits. The build matches A1 to A9, and the three departures it recorded are accepted. All six original Should-fix items and both of the code-reviewer's are fixed.
  - **SF-R1:** AC-37's "until spec 191" is false. Spec 191 changes only role-changing writes and leaves `auth_is_privileged()` alone, so neither AC-37 arm will ever flip. I confirmed this in `specs/191-demote-profile-brand-scope.md` L89, L214, L236 and L291.
  - **SF-R2:** the index holds spec 190's migration `20261109140000` and its tests. A bare commit would carry them, and `db-migrations-applied.yml` would then hard-fail.
  - **SF-R3:** Prod apply has no step 0 to check that a later migration hasn't redefined spec 187's objects.
  - **Nits:** Nit 1, a thrown `undefined` loses the JSON 500 shape. Nit 2, a lowercase sentence start in a comment. Nit 3 is the same as test N1. Nit 4, column comments aren't compared on prod. Nit 5, Rollback should list CLAUDE.md. Nit 6, A7 ran on `c630c7f` plus a pre-commit copy of spec 186. Nit 7, the `db.ts` line references are stale. Nit 8, the spec 186 text is stale again.

### Gates and hard rules
- **CI:** `test.yml`, `db-migrations-applied.yml` and `e2e.yml` are green on `main` at `15aefc4`, per the main session. I can't run `gh`, so this is relayed. Those runs don't cover spec 187, because none of it is committed.
- **Critical:** none from any reviewer. The hard rules would allow SHIP_READY. FIXES_NEEDED is my judgment on the open items, not a rule.

### What I checked by reading
- **SF-R1:** spec 191 is correctly described. It adds `auth_profile_is_privileged()` only for the demote RPC, the invitation policies and the profiles INSERT policy. It calls changing `auth_is_admin()` "a separate, later spec" (L89, L236, L291). It also says not to switch 187's inline check to its helper (L374).
- **M-R1:** the stamp trigger (migration L84-100) has no caller, status or role check. It only reads and assigns the snapshot.
- **Breakage from the M-R1 fix:** I grepped `supabase/tests/` for direct INSERTs into `order_approvals`. Every API-caller INSERT uses `pending` or the default: AC-2a, AC-2b, AC-2c and AC-2d, and T25, T27 and T38 to T41 in `cross_store_item_rejection`. On INSERT, the lines trigger fires before the stamp trigger, so the T arms still fail where they do today. Some fixtures insert non-pending rows as postgres: `retention_prune_job` (`ordered`), `order_approvals_fk_set_null` (`ordered`) and `report_last_order_context`. If an earlier block in one of those files leaves `request.jwt.claims` set, the new check would fire. `admin_submit_eod` clears its claims first. I didn't trace the other three, so the fix has to run every file. No file under `e2e/` mentions `order_approvals`.
- **`package.json`:** the working copy's `test:smoke` line ends with `&& bash scripts/smoke-delete-user.sh`. Spec 190's smoke isn't in it. I couldn't diff the rest of the file.

## Recommended next steps (ordered)

Each item is tagged **[code, this spec]**, **[text only]** or **[owner decision]**.

### Before commit

**1. M-R1: decide between an INSERT-time check in the stamp trigger and recording a wider acceptance. Medium. [owner decision; recommended: code, this spec]**
- **Why first:** the choice decides what items 2 and 3 say. It is also the only possible code change, and it's cheapest now, while the migration can still be edited in place and prod has 0 approvals.
- **Recommended: the code fix.** It finishes the in-spec part of 187-H2 that you already chose to close. The approved outcome of fix 2 was "a stale claim can no longer stamp, approve or edit lines on a pending row". Today the claim can still approve, by inserting the row already approved. It is also small:
  - In `tg_order_approvals_stamp_approver()`, when `auth.uid()` is not NULL, add two refusals.
  - First, `new.status` must be `'pending'`.
  - Second, the caller's `profiles.role` must be in `('admin','master','super_admin')`, using the same inline `exists` as block (a0) and its message `order approval caller is not an admin`.
  - Keep the check inline, as spec 187's guard comment and spec 191 L374 both say.
  - Put both checks before the snapshot reads, so a refused insert never reads `auth.users`. That keeps AC-2c's no-email property.
- **Not recommended here:** forcing `channel := vendor_order_channel(...)` and setting timestamps on the server. That is the existing L4 class, which you already put out of scope, and it widens the change. Leave it in the "Limit what a direct INSERT can set" follow-up.
- **Fixes the test plan needs:**
  - The auditor's note that "AC-37a stays green" holds only for the status check. With the role check, a1's stale-claim insert through the RPC is refused, so AC-37a flips from known gap to refusal.
  - AC-35b approves "its own pending row, from AC-37a". Under the fix that row is never created, so AC-35b needs a fixture row inserted as postgres.
  - New arms:
    - a stale claim's direct INSERT at `pending`, `approved` and `ordered` is refused
    - a real admin's direct INSERT at `approved` and at `ordered` is refused
    - postgres and `service_role` with no claims can still insert a non-pending row
  - Add one A5 mutation row for each new check.
- **Routing:** backend-architect writes a short amendment (A10), then backend-developer builds it. The security-auditor re-probes M-R1 only, and the test-engineer re-checks the AC-35 and AC-37 arms.
- **Alternative: text only.** Correct A1's "What 187-H2 still leaves open" and AC-37 to read "insert at any status, with any channel and timestamps". Note on AC-35 that it covers UPDATE only. Record your acceptance. Also add test N3's direct-INSERT known-gap arm, so a later spec that closes the gap has an arm to flip.

**2. AC-35 route coverage (S1), plus N1 and N3. Should-fix. [code, this spec: test file only]**
- Run the three AC-35 statements for both a1 (same brand) and a4 (NULL brand): RPC re-stamp, PATCH re-stamp, and lines on someone else's row. Approve-own is already covered for both.
- N1: have `b0` re-stamp one of A's pending rows with its padded name, so trimming is pinned on the re-stamp path too. This is the same as architect Nit 3.
- N3 depends on item 1. With the code fix it becomes one of the new refusal arms. With the text route it is the known-gap arm.
- Bundle this with item 1, since it's the same file and the same `plan()` change. If you take the text route for M-R1, this is still worth doing on its own.

**3. SF-R1: AC-37's "until spec 191" is false. Should-fix. [text only, plus an owner acknowledgment]**
- Make the change in AC-37, Dependencies, A1's open list, Follow-ups, the owner Q&A note, and the two test descriptions. Replace "spec 191" with "the `auth_is_admin()` / `auth_is_privileged()` convergence follow-up (named in spec 191, not yet filed)". Add that follow-up to Follow-ups.
- Do this after item 1. With the code fix, AC-37 is down to AC-37b (moving an approved row to `ordered`), plus reading approver emails in a store the caller can see and re-minting `external_ref` on approved rows. With the text route, it also carries M-R1's insert at any status.
- **What you need to know:** the exposure you accepted on 2026-11-09 ("until those ship") doesn't end when spec 191 ships. It lasts until the unfiled convergence spec ships. Spec 195 still ends the cross-brand reach. Within one brand, each case lasts at most `jwt_expiry` after a demotion, which is 3600 s locally; prod's value hasn't been checked. If you want a fixed end, file the convergence spec now.

**4. SF-R3: add a step 0 to Prod apply. Should-fix. [text only]**
- Before step 1, list the repo migrations whose version sorts after `20261108130000`. Grep them for `tg_order_approvals_guard`, `tg_order_approvals_stamp_approver`, `create_order_approval`, `order_approvals_stamp_approver_trg`, both restrictive `audit_log` policy names, and any `for delete` or `for all` policy on `public.profiles`. If any match, stop.
- Recapture the step 4 md5 references on the day of the apply. If item 1 lands, the stamp trigger's reference changes anyway.
- This matters because four sessions are writing migrations with later versions, including 189, 190, 194, 195 and 191's planned one. Today none of them touches spec 187's objects, according to the architect's grep and the overlap notes in specs 191 and 195.

**5. L-R1: non-ASCII whitespace names. Low. [owner decision; recommended: accept, plus a text-only Known limits line]**
- The row still carries the real email and id, so it isn't anonymous, and the gap is cosmetic.
- A code fix would edit both copies of the snapshot block, the stamp trigger and the guard's re-stamp branch. That means re-creating the guard, recapturing its md5, and adding new arms and mutation rows. The cost is more than a Low is worth.
- Record it under Known limits, for example "blank means ASCII whitespace only". Add the fix to Follow-ups.

**6. L-R2: `ordered_at` can be rewritten. Low. [owner decision; recommended: follow-up, text only]**
- It dates from spec 149, the amendment doesn't widen it, and the app never writes `ordered_at`.
- Add it to Follow-ups next to "Limit what a direct INSERT can set". The suggested fix is `ordered_at := now()` on the transition, with no `coalesce`, and a refusal for any other change.
- Also extend that follow-up's wording to "or a re-stamping PATCH", as the auditor asks. A takeover PATCH still skips the RPC's line validation and cost recompute.

**7. Small text nits. Nit. [text only]**
- Architect Nit 5: add CLAUDE.md to the repo changes under Rollback, because the accepted bullet becomes false if the policy is re-created.
- Nit 4: add a `col_description()` comparison for all three columns to step 5.
- Nit 7: update the `db.ts` line references to L2637-2643.
- Nit 8: add one dated line saying spec 186 is committed and on prod.
- Record that S2's A5 results weren't checked by the test-engineer.
- Nit 2, the lowercase comment: fix it only if item 1 edits the migration anyway.
- Nit 1, the thrown `undefined`: not recommended now. Any `delete-user` edit means re-running `deno check` and the smoke, and supabase-js doesn't throw `undefined`. Leave it as a follow-up.

### Verify (only if items 1 and 2 change code)

**8. Re-run, one track at a time.**
- Use the A6 method on the shared stack: a `create or replace` of `tg_order_approvals_stamp_approver` only. Don't reset or stop the stack. First run every pgTAP file with the change injected after its own `begin;`, as the amendment build did. That catches any fixture that inserts a non-pending row with claims still set.
- Confirm the live `prosrc` matches the file. Recapture the stamp trigger's md5. The guard's and the RPC's are unchanged unless item 5 goes the code route.
- Run the new file, the full pgTAP suite, `npx jest` and `npm run typecheck:test`. On the shared stack, a red `legacy_permissive_policy_dropout.test.sql` is spec 195's until that spec updates its arm (9). For a clean full-suite run of spec 187 alone, repeating A7 steps 1, 2, 3, 4 and 6 gives one. That is preferred but optional.
- `smoke-delete-user.sh` and `deno check` don't need re-running, because item 1 doesn't touch `delete-user`.

**The draft PR: I agree it's no longer needed.** SF-3 asked for a from-scratch `supabase start` on CI's pinned CLI. A7 did exactly that, on 2.106.0: 96/96 for spec 187 alone and 97/97 with spec 186, without touching the shared stack. A draft PR would also fail `db-migrations-applied` by design. Three things are left:
- A7 ran on `c630c7f` plus a pre-commit copy of spec 186's migration (architect Nit 6).
- A7 doesn't cover jest or the base typecheck in a clean `node_modules`. Spec 187's `src/` changes are only comments and one parity-test entry, though.
- If item 1 lands, it is a function-body change inside an existing `create or replace`, so the replay risk doesn't change.

The first `test.yml` run on `main` covers all three. If it is red, it gets surfaced and work stops, per CLAUDE.md.

### Landing, only with the owner's go-ahead

Nothing is committed or applied.

**9. Staging, refreshed for SF-R2. [owner go-ahead]** The status snapshot is from the start of this session, so re-check it. The spec 186 rows from the original table are gone, because spec 186 is committed in `15aefc4`.

| Treatment | Paths |
|---|---|
| Spec 187, whole file | `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql`, `supabase/tests/order_approvals_approver_snapshot.test.sql`, `supabase/tests/audit_log_rls_hardening.test.sql`, `supabase/functions/delete-user/index.ts`, `scripts/smoke-delete-user.sh`, `src/lib/placeholderEmail.ts`, `src/lib/placeholderEmail.parity.test.ts`, `specs/187-order-approval-approver-snapshot.md`, `specs/187-order-approval-approver-snapshot/` |
| Spec 187, read `git diff` first (another session may also have edited these) | `supabase/tests/profiles_rls_sweep.test.sql`, `supabase/tests/auth_can_see_store_brand_scope.test.sql` (spec 195 works on `user_stores` and store visibility), `package.json` (the only change should be the `smoke-delete-user.sh` append), `specs/043-profiles-rls-sweep.md`, `specs/178-order-approvals-fk-set-null.md` |
| Leave out of this commit | `src/lib/db.ts` (comment only, other sessions' hunks; see below) |
| Leave out: staged by other sessions | `supabase/migrations/20261109140000_po_number_sequence.sql`, `supabase/tests/generate_po_number_sequence.test.sql`, `supabase/tests/generate_po_number_malformed_guard.test.sql`, `supabase/tests/report_run_variance_formula.test.sql`, `scripts/smoke-po-number-concurrency.sh`, `tests/README.md`, `specs/188-*`, `specs/189-*`, `specs/190-*` and their reviews |
| Leave out: other sessions' unstaged work | `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql`, `supabase/tests/legacy_permissive_policy_dropout.test.sql`, `supabase/tests/report_last_order_context.test.sql`, the `eod_*` tests, `src/store/useStore.ts`, the EOD section and its tests, `src/lib/db.*.test.ts`, `e2e/staff-reorder.spec.ts`, `README.md`, `specs/164-*`, `specs/191-*`, `specs/195-*` |

- **How:** `git add` the untracked spec 187 files, then run `git commit -- <the spec 187 paths>` straight after. With paths given, git commits only those paths, from the working tree, and leaves spec 190's staged entries staged. Don't leave the added files sitting in the shared index, where another session's bare `git commit` could sweep them up.
- **`db.ts`:** a path-list commit takes the whole working copy, so leave the comment out. Nothing depends on it. It can ride along with the next commit that owns `db.ts`. The other way to include it is to stage it by hunk after clearing the index with the other sessions.
- **Before pushing:** `git show --stat HEAD` must list `20261108130000` as the only migration. `git log origin/main..HEAD` must show only commits whose migration versions are already on prod.
- **These go together:** the migration and the four pgTAP files; `delete-user/index.ts` and the parity test (SF-4).

**10. Prod apply, deploy and push. [owner go-ahead]** Follow the spec's Prod apply section with items 3 and 4 included:
- Step 0 (SF-R3).
- Check `order_approvals` is empty.
- Apply the migration body through MCP.
- Insert version `'20261108130000'`.
- Run step 4's checks against references recaptured that day. Run step 5's checks, including `approved_by_id` with no FK, the two new guard messages, and the column comments.
- Read prod's email-confirmation setting and record it (A8).
- Deploy `delete-user` with `npx supabase@2.106.0` or the MCP, only after the migration, then confirm `verify_jwt` is still true.
- Push.
- Confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.

Run `smoke-edge-roles.sh` once at a quiet time before the deploy. It isn't blocking.

### Owner decisions
1. **M-R1:** the code fix in item 1 (recommended), or recording the wider acceptance through the text route.
2. **SF-R1:** acknowledge that the stale-claim acceptance lasts until the unfiled `auth_is_admin()` convergence spec ships, not spec 191, and decide whether to file that spec now.
3. **L-R1:** accept with a Known limits line (recommended), or fix the code in this spec.
4. **L-R2:** a follow-up (recommended).
5. **The go-ahead** for the commit, the prod apply, the `delete-user` deploy and the push. I recommend skipping the draft PR (see above).

## Out of scope for this review
- **Spec 195:** its migration on the shared stack breaks arm (9) of `legacy_permissive_policy_dropout.test.sql`. That spec owes the test update. Spec 187 doesn't depend on `user_stores` own-row writes.
- **The `auth_is_admin()` / `auth_is_privileged()` convergence spec**, from SF-R1. Not yet filed.
- **Follow-ups already recorded in the spec and still open:** look-alike audit actions (L2); auditing renames and email changes (M1); `delete-user` trusting `app_metadata.role`; limiting direct INSERTs (L4), widened by item 6; planting `external_ref` on approved Instacart rows; a friendlier "belongs to another approver" toast; `removeUser`; `inferKind` and `ACTION_TONE`.
- **New candidates:** `ordered_at` freezing (L-R2), Unicode-aware blank names (L-R1), the JSON shape of a thrown `undefined` in `delete-user` (architect Nit 1), and the Instacart mint that is spent before a refused write-back (auditor Info).
- **Environment:** the 24 empty `node_modules/@types/* 2` folders, as before. **`app.json` slug:** not touched.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 7 items before commit, top: M-R1 (owner decision; recommended a small stamp-trigger check: pending only, plus `profiles.role` for API callers)
payload_paths:
  - specs/187-order-approval-approver-snapshot/reviews/release-proposal.md

---

# Final verdict (2026-11-10)

Release-coordinator, 2026-11-10. Covers the spec's "Re-proposal build (2026-11-09)", `security-auditor.md` "Re-audit 2 (2026-11-09)", `backend-architect.md` "Re-review 2 (2026-11-09)", and main Claude's text fixes for SF-R2-1 and L-R3 made after those reviews. The two proposals above are left as they were. Sources: the spec (API contract, Change, Out of scope, AC-35 to AC-38, Prod apply, Rollback, Re-proposal build, Follow-ups), the migration's header and stamp function (L1-150), all four review files, and the workflow triggers. I ran nothing.

## Verdict
verdict: SHIP_READY
rationale: Re-audit 2 closed M-R1 with 0 Critical, High or Medium, re-review 2 found 0 Critical, and both remaining items (SF-R2-1 and L-R3) are text-only fixes I verified in the files. What is left is the gated landing sequence below. This depends on `test.yml` and `db-migrations-applied.yml` still being green on `main` when main Claude re-checks before the push.

## Findings summary
- **code-reviewer:** no re-review since the first round. Both Should-fix items were fixed in the amendment build (architect re-review 1). Nothing open.
- **security-auditor (re-audit 2):** 0 Critical, 0 High, 0 Medium, 1 Low.
  - M-R1 is closed. About 20 INSERT shapes by stale-claim callers were refused, including upserts, multi-row inserts, `INSERT … SELECT`, writable CTEs and the RPC race branch.
  - Owner-level inserts and the app's RPC path are unchanged. H1, H2 and `approved_by_id` survival have not regressed.
  - **L-R3** (the L4 column lists were missing `external_ref`, `external_ref_expires_at` and `source_submission_id`): fixed, see below.
  - Still open and accepted: AC-37b (a stale claim can still move an approved row to `ordered`, until the unfiled convergence spec), L4 for real admins (follow-up), L-R1, L-R2, M2, L1 and L6.
  - Notes, not scored: non-privileged direct INSERTs now get P0001/400 instead of 42501/403; a trusted role carrying a user's `sub` gets the INSERT checks; a real admin's non-pending upsert is refused.
- **backend-architect (re-review 2):** 0 Critical, 1 Should-fix, 5 Nits.
  - Check order, messages, the inline role read and the NULL-uid gate all match the owner's decision. The md5 references and step 5 checks were updated. AC-35j's P0002 is acceptable.
  - **SF-R2-1:** fixed, see below.
  - Nits 1 to 5 are optional. Nit 5 is still open: migration L80-84 says an INSERT naming someone else "fails … with 42501", which now holds only for a privileged caller at `pending`. It is outside the function body, so it can be fixed before commit without changing any md5. Optional.
- **test-engineer:** no review of the re-proposal build. Its last round covered the 68-arm file. The items it raised (S1, N1, N3) were built as AC-35h to AC-35j, AC-8c and AC-38a to AC-38d. The 76-arm file was run 76/76 by the auditor and checked arm by arm against item 1 by the architect. S2 still stands for both A5 tables: the mutation results are the developer's alone.

### What I checked by reading
- **SF-R2-1:** the API contract (spec L563-567) now has a row for an API caller's INSERT at a non-`pending` status (`order approval must be inserted as pending`, HTTP 400, checked first). It also has a row for a non-privileged `profiles.role` (`order approval caller is not an admin`, HTTP 400, replacing the 42501/403 that staff and profile-less `admin` claims used to get). The "Caller with no profile row" row has the direct-INSERT clause.
- **L-R3:**
  - Spec L113 (Change) and L230 (Out of scope) list `external_ref`, `external_ref_expires_at` and `source_submission_id`, with dated notes.
  - The migration's comment at L98-100 lists them too, and L100-102 adds the auditor's "trusted role carrying a user's sub" sentence.
  - The comment is above `create or replace function` (L103). The body runs from `$$` at L108 to L131, so none of the body's bytes changed.
- **md5 unchanged:** an SQL `--` comment outside the function body is not stored in `prosrc` or `pg_get_functiondef`. The step 4 references (stamp `cdc18777…` / `45f14d61…`, guard `733e4f3e…` / `c89df6a4…`, RPC `3dd805dc…` / `a544d68d…`) still apply, and the shared stack needs no re-apply. I couldn't compute an md5 myself.
- **Stamp body** (L114-131): the status check, then the inline `profiles.role` check, both inside `if v_uid is not null` and before the `profiles` and `auth.users` reads. This matches what both reviewers describe.
- **Step 0 against today's disk:** the migrations after `20261108130000` are `20261109120000`, `…140000`, `…170000`, `…191000`, `…195000`, `…200000` and `…230000`. The architect has already cleared `…191000`, `…195000` and `…230000`. I grepped `…200000` and `…230000` for spec 187's objects and for policies on `public.profiles`. The only hit is a comment at `…230000` L64. Spec 198's `20261110120000` must be grepped at step 0 if it exists by then.

### Is a focused re-review needed?
**No. The evidence is enough.**
- Since the last two reviews, only text changed, and I verified it above.
- The one code change in the re-proposal build was reviewed twice: the auditor probed it beyond the test arms, and the architect read it against the owner's wording.
- The only gap is the test-engineer's independent reproduction of the A5 rows. The auditor's probes already show each new check refusing what it should, and that a missing check would leave the probes green. That gap is not worth another round.
- What is still unchecked is a fresh build of the M-R1 delta together with 191 and 195. The test branch (Landing step C) covers it.

## Recommended next steps (ordered)

### Spec 187, before its prod apply
1. **Optional, before commit:** architect Nit 5 (the migration L80-84 comment). Nits 1 to 4 are optional too. None changes an md5.
2. **Include it in the test-branch run** (Landing step C). 187's A7 fresh build covered 187 alone, before M-R1. This run covers the final file together with 191 and 195.
3. **`smoke-edge-roles.sh`, once, at a quiet time, before the `delete-user` deploy.** Recommended, not blocking (test-engineer). Arm 4 promotes `admin@local.test`, so it needs the owner's go-ahead. The same run also does spec 191's Arm 7b, whose result should be recorded in spec 191 in place of its waiver. If the owner skips it, record a waiver in spec 187 as spec 191 did.
   - Optional: re-run `scripts/smoke-delete-user.sh` once. The local stack now also has 191 and 195 applied, and the last recorded run may predate one of them.
4. **Prod steps 0 to 5** in the shared pre-check pass and apply order (Landing step D):
   - Step 0: grep every migration after `20261108130000`, including 198's if it is on disk.
   - Step 1: `order_approvals` count is 0. Stop if not.
   - Steps 2 and 3: the committed body, then version `'20261108130000'` (not `…120000`).
   - Steps 4 and 5: md5 references recaptured that day (expect the values above), plus `prosecdef`, `proconfig`, owner and `proacl`. Then the three columns, `approved_by_id` with no FK, the `col_description` values, both new messages in the stamp `prosrc`, no DELETE policy on `profiles`, and `User deleted` in both restrictive `audit_log` policies.
   - A8: read prod's email-confirmation setting and record it. The same reading serves spec 198.
5. **Deploy `delete-user`**, only after step 2 has applied and step 4 has been verified:
   - `deno check` passed on 2026-11-09 (`denoland/deno:2.1.4`), and the file hasn't changed since. After the commit, `git diff HEAD -- supabase/functions/delete-user/index.ts` must be empty, so the deploy ships the committed file.
   - Deploy with `npx supabase@2.106.0 functions deploy delete-user --project-ref ebwnovzzkwhsdxkpyjka`, or the MCP deploy. Never use bare `npx supabase`, which resolves to 3.0.0 and refuses this repo's `config.toml`.
   - Afterwards, confirm `verify_jwt` is still true.
   - Deletes between the apply and the deploy work as they do today and write no audit row.
6. **Push and gates:** Landing step E.

### Landing order for 187, 191 and 195
This section is the same in all three proposals. Every step needs the owner's go-ahead. Main Claude re-checks `test.yml` and `db-migrations-applied.yml` on `main` before every push. Relayed: both were green at `a66dd81`, which carries specs 190 and 194, so `20261109140000` and `20261109170000` are on prod.

**A. Before committing**
1. **Tell the spec 198 session** (migration `20261110120000`, being built now) not to edit 191's or 195's files until those commits exist. That means especially `supabase/tests/profiles_insert_hardening.test.sql` (198 must update its K-13 pin) and `specs/164-profiles-insert-hardening.md`. A path-limited commit takes the whole working copy of each path, so it would take 198's hunks too.
2. **Ask the other sessions to hold pushes to `main`** from step B until step E. Once these commits are on local `main`, any push carries three migrations prod doesn't have yet, and `db-migrations-applied.yml` goes red.
3. **Run `git diff` on each tracked file the commits take**, and confirm only that spec's hunks are present:
   - 187: `package.json` (the only change should be the `smoke-delete-user.sh` append), `supabase/tests/profiles_rls_sweep.test.sql`, `supabase/tests/auth_can_see_store_brand_scope.test.sql`, `specs/043-profiles-rls-sweep.md`, `specs/178-order-approvals-fk-set-null.md`
   - 191: `supabase/tests/profiles_insert_hardening.test.sql`, `scripts/smoke-edge-roles.sh`
   - 195: `supabase/tests/legacy_permissive_policy_dropout.test.sql`, `specs/164-profiles-insert-hardening.md`

**B. Three commits, one per spec, in migration-version order.** For each: `git add <paths>`, then `git commit -m "…" -- <paths>`. The index holds other sessions' staged work (specs 188, 189, 196 and 197, `README.md`, hunks in `src/lib/db.ts` and more), so a bare `git commit` would take it. After each commit, `git show --stat HEAD` must list exactly one migration.
1. **187** (`20261108130000`): the migration, `supabase/tests/order_approvals_approver_snapshot.test.sql`, `audit_log_rls_hardening.test.sql`, `profiles_rls_sweep.test.sql`, `auth_can_see_store_brand_scope.test.sql`, `supabase/functions/delete-user/index.ts`, `scripts/smoke-delete-user.sh`, `package.json`, `src/lib/placeholderEmail.ts`, `src/lib/placeholderEmail.parity.test.ts`, `specs/187-order-approval-approver-snapshot.md` and its directory, `specs/178-…md`, `specs/043-…md`, and `CLAUDE.md` with the accepted bullet (see below). Leave out `src/lib/db.ts`: the change there is comment-only and the file holds other sessions' hunks.
2. **191** (`20261109191000`): the migration, `supabase/tests/demote_profile_brand_scope.test.sql`, `supabase/tests/profiles_insert_hardening.test.sql`, `scripts/smoke-edge-roles.sh`, `specs/191-demote-profile-brand-scope.md` and its directory (reviews and `rollback.sql`). Leave out `README.md`.
3. **195** (`20261109195000`): the migration, `supabase/tests/user_stores_own_row_writes.test.sql`, `supabase/tests/legacy_permissive_policy_dropout.test.sql`, `specs/164-profiles-insert-hardening.md`, `specs/195-user-stores-own-row-writes.md` and its directory.
- Leave out everything else, including `20261109200000` (spec 196) and `20261109230000` (spec 197). I grepped both: neither touches an object of these three specs.

**C. One test branch, before anything touches prod.**
- `git push origin HEAD:refs/heads/test/ship-187-191-195`. This needs no checkout, so the shared working tree is untouched. Don't open a PR: a PR runs `db-migrations-applied.yml`, which would be red by design. A plain branch push runs only `test.yml` and `e2e.yml`.
- Both run on a fresh `supabase start` (CLI 2.106.0), and `e2e.yml` also runs `db reset`. Required: both green, and the Playwright report shows `e2e/invite.spec.ts` passed (191 C4). A pass that needed a retry counts as a flake, so note it.
- This is the first fresh build of 191 and 195, and the first of all three together. 187's A7 built 187 alone on `c630c7f`.
- If either is red: stop. Nothing is on prod, so the migrations can still be edited in place. Fix, amend the commit, and re-push the branch.
- Delete the branch once step E is green.

**D. Prod, through MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`.**
1. **All read-only pre-checks first, for all three, before any apply:** 187 steps 0 and 1, 191 H1, and 195 AC-R1 (P-1 to P-7). Resolve any stop before applying anything. That avoids applying 187 and then finding 191 blocked with its commit in the middle of the push.
   - Expected, not a stop: 191's H1 query (a) still lists `Admins can delete profiles` on prod, because 187 hasn't applied yet.
   - Read once and record: prod Auth's email-confirmation setting (187 A8, also a 198 pre-read) and `jwt_expiry` (191 H1).
2. **187:** steps 2 to 5 (body, version `'20261108130000'`, function checks against references recaptured that day, post-apply checks).
3. **187: deploy `delete-user`** (spec 187 step 6). Only after step 2. See item 5 above.
4. **191:** H2 (body, version `'20261109191000'`, function, policy and grant checks).
5. **195:** AC-R2 (body, version `'20261109195000'`, P-1 and comment checks).
- Version order matches the order CI just replayed on the branch. The objects don't overlap, so this is a preference, not a dependency.
- If an apply fails part-way, don't push until the set of commits equals the set of versions on prod. Removing 191's commit, the middle one, needs a rebase. That is the owner's call.

**E. Push `main`**, only after all three versions are in prod's `schema_migrations`. `git log origin/main..HEAD` must show only the three commits. Then confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand. If any is red or still running, surface the run URL and stop.

**F. Spec 198 afterwards.** Its `20261110120000` sorts after all three. It needs 191 on prod (it uses `auth_profile_is_privileged()`), and its commit comes after these three. If it changes `"Admins can manage all store links"` (follow-up X2), it also needs 195 on prod and must re-capture 195's T3 literal and the P-1 md5. Once 198 depends on the helper, 191's `rollback.sql` must roll 198 back first. Its header's `pg_depend` check covers that.

### CLAUDE.md: accepted by the owner on 2026-11-09
- Main Claude adds this bullet at landing, in 187's commit: "Profile rows are deleted only through the `delete-user` edge function. `public.profiles` has no DELETE policy, so a PostgREST delete removes 0 rows with no error. The one other service-role delete is `manage-store-user`'s compensation of an account it just created."
- Spec 187's Rollback table already says to remove or reword it if `Admins can delete profiles` is ever re-created.
- Spec 191's G3 sentence is separate and still needs the owner's confirmation. See spec 191's final verdict.

## Out of scope for this review
- **The `auth_is_admin()` / `auth_is_privileged()` convergence spec (X4 in spec 191's proposal):** still unfiled. It is the only end to AC-37b and the rest of the stale-claim exposure accepted on 2026-11-09. Specs 191 and 195 don't end it.
- **Spec 198** (invitations hardening): being designed, depends on 191. It touches none of 187's objects, but 187's step 0 must grep its migration if that migration exists at apply time.
- **Follow-ups recorded in the spec and still open:** L4 for real admins (`channel`, timestamps, counts, `external_ref`, `external_ref_expires_at`, `source_submission_id`), L-R1, L-R2, look-alike audit actions, rename and email auditing, `delete-user` trusting `app_metadata.role`, a thrown `undefined`, the planted `external_ref` URL, the friendlier toast, `removeUser`, and `inferKind` / `ACTION_TONE`.
- **Environment:** the empty `node_modules/@types/* 2` folders. **`app.json` slug:** not touched.

## Handoff
next_agent: NONE
prompt: SHIP_READY (2026-11-10 final). SF-R2-1 and L-R3 verified, md5s unchanged, no re-review needed. Before prod: test-branch run, step 0 (including 198's migration if it is on disk), an empty `order_approvals`, recaptured md5s, the A8 reading, and optionally `smoke-edge-roles.sh`. Apply first in 187 → 191 → 195, then deploy `delete-user` with `supabase@2.106.0`, and push once all three versions are on prod.
payload_paths:
  - specs/187-order-approval-approver-snapshot/reviews/release-proposal.md
