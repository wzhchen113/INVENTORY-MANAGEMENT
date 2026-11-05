# Release proposal: spec 177 (reject cross-store line items)

Author: release-coordinator, 2026-10-26. Advisory only. Inputs: the spec (requirements, design §0-§12, `## Files changed`) and the four reviewer files in this directory (code-reviewer, security-auditor, test-engineer, backend-architect), read directly. Main Claude supplied one more fact: `git diff --numstat` on the two AC-16 files shows `17 0` (`order_approvals.test.sql`) and `10 0` (`report_last_order_context.test.sql`). Both are additions only. That closes the diff check the code-reviewer and the architect could not run.

## Verdict
verdict: SHIP_READY
rationale: No reviewer reports a Critical, High or Medium finding. AC-1 to AC-23 pass, and every gate passed locally (pgTAP 91/91 files and 1301 assertions, jest 266/266 suites and 3334 tests, both typechecks). The open items are either a test description that claims more than it proves or corrections to the runbook text. Neither changes shipped behaviour. The only remaining step is AC-24. It is owner-gated, and it must happen before the push.

**Conditions on this verdict. They are part of the ship plan, not optional:**
- **C-1. Prod apply before any push carrying `20261025000000`.** It needs the owner's explicit go-ahead ("Ask me before applying anything to prod"). If the push lands first, `db-migrations-applied.yml` goes red.
- **C-2. Run the §10 runbook with the architect's S-1 and S-2 corrections.** Do not run it as originally written (details below).
- **C-3. CI must be green on `main` before the push.** CLAUDE.md requires the latest `test.yml` and `db-migrations-applied.yml` runs on `main` to be green. I have no shell, so I could not check this. HEAD `8acecc4` (spec 175) is unpushed, so the latest runs on `main` belong to an earlier push. Run `gh run list --branch main --workflow test.yml --limit 1`, and the same for `db-migrations-applied.yml`, before pushing. If either is red, this verdict is suspended until the user decides how to proceed.

## Findings summary
- **code-reviewer:** 0 Critical, 1 Should-fix, 8 Nits.
  - Should-fix: arms T16, T34 and T48 are described as pinning the D-4 in-function short-circuit, but they don't. T16 and T34 use same-store rows, so the full check passes even without the short-circuit. T48's function has no short-circuit at all. If the short-circuit were deleted, all three would stay green. The header line "every acceptance arm re-reads the row" also says more than these three arms do.
  - Nits:
    - the PROD-APPLY header should say "requires PG >= 16 (`pg_input_is_valid`)";
    - T28 and T29 use `do $$ perform $$` instead of `lives_ok`;
    - `pg_temp.l177` should be `stable`, not `immutable`;
    - T02 is out of order in the file;
    - the T49-T51 probes are copy-pasted;
    - the null-`item_id` message wording;
    - `is distinct from` where `<>` would do;
    - the `report_last_order_context` wrapper covers all eleven rows. That is permitted by AC-16, and nobody should "tighten" it.
  - The AC-16 check by inspection was clean, and the numstat above now confirms it.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 1 Low.
  - L1: the documented residual is wider than the spec says. `order_approvals.lines[].item_id` has no FK, so two more moves can re-home an approval's lines after the fact. One is delete-then-reinsert with the same id in another store. The other is a PATCH of `inventory_items.id`. Both were verified locally and rolled back.
  - Impact is low. It needs a two-store caller, it forges no new line, and readers stay store-scoped. `po_items` is not exposed, because its FK is NO ACTION on delete and on update.
  - Requested fix: no code change. Add one sentence to design §11.3 so the follow-up locks both `id` and `store_id` on `inventory_items`.
  - Verified clean:
    - write-path coverage, including upsert, `UPDATE … FROM`, multi-row atomic batches, `ON CONFLICT DO UPDATE SET lines`, and duplicate-key jsonb;
    - the SECURITY INVOKER posture cannot falsely accept a write;
    - `search_path` cannot be shadowed;
    - `proacl` has no PUBLIC, anon or authenticated entry;
    - the error messages give no existence oracle;
    - malformed input cannot escape the stable 22023;
    - the fixture trigger-disable is transactional and confined to the test.
- **test-engineer:** 23 PASS (AC-1 to AC-23), 0 FAIL, 0 NOT TESTED, 1 PENDING (AC-24, owner-gated prod apply).
  - Gates: `scripts/test-db.sh` 91/91 files and 1301 assertions; full `npx jest` 266/266 suites and 3334/3334 tests; `typecheck` and `typecheck:test` both exit 0.
  - AC-7 and AC-16: the existing `po_items` writer suites pass unmodified, and the two fixture edits are within the allowance.
  - The developer's negative control shows the new file has teeth: with the triggers disabled, 32 of 54 arms fail.
  - Note: the AC-6 and AC-14 entries cite T16 and T34 as "pass-through short-circuit". That repeats the overclaim the code-reviewer flagged. The ACs themselves are still met by T17-T20 and T35-T36.
- **backend-architect (post-impl):** 0 Critical, 2 Should-fix, 4 Minor. No contract drift.
  - The developer's CASE-guard deviation in `order_approvals_lines_check_store()` (D-A) is **accepted**. The migration file is the authority, and the recorded md5 `71491c6f…` hashes the CASE-wrapped body.
  - S-1: runbook Step 2 contradicts itself. Running a `pg_get_functiondef` dump would create the three functions but drop the triggers, revokes and comments. The md5 check would still pass, yet nothing would fire. Corrected step: run the full committed file verbatim in one `execute_sql` call.
  - S-2: the Step 5 probe has placeholders and relies on `begin … rollback` holding across MCP calls. If the rollback were lost, a real prod row could be corrupted. It is replaced with a self-contained DO block that always raises. Expect `PROBE OK: po_items: item store mismatch with parent purchase order`.
  - M-1: recompute the local md5s against the committed file before comparing them with prod.
  - M-2: Steps 2 and 3 are not atomic. Confirm the `schema_migrations` row exists before pushing.
  - M-3: stage spec 177's paths explicitly so they stay separate from spec 176.
  - M-4: the wrapper covers all fixture rows. Informational only.

### Do the named items block ship?
- **code-reviewer Should-fix (T16/T34/T48 overclaim): does NOT block.**
  - Shipped behaviour is correct, and the migration has the short-circuit.
  - No acceptance criterion requires the short-circuit to be proven. N1 is a "non-blocking" architect note, and AC-6, AC-14 and AC-19 are each met by other arms.
  - It isn't a bug or a regression. It is a test that is described as stronger than it is.
  - Recommended, cheap, and safe to do before the commit: soften the descriptions of the three arms and the header's anti-vacuity line to "pass-through is accepted". `plan()` stays the same, and T16 and T34 stay the same.
  - The stronger version would make T16 and T34 cross-store first and then prove the pass-through. That is a reasonable follow-up, but it is not needed for ship.
- **architect S-1 and S-2 (runbook): do NOT block the code. They DO block running the prod apply as originally written.**
  - Both are text corrections to §10, and no shipped file changes.
  - When the owner approves, main Claude must use the corrected Step 2 (verbatim file) and the replacement Step 5 (the always-raise DO probe) from `reviews/backend-architect.md`. Do not use the original §10 text.
  - S-1 is the more dangerous of the two. Without the correction, prod could end up with three verified functions and no triggers, a silent no-op that the md5 check would pass.

## Recommended next steps (ordered)
1. **(Optional, before commit) Soften the T16/T34/T48 descriptions** in `supabase/tests/cross_store_item_rejection.test.sql`, and the header line 13 claim, to "pass-through is accepted". Drop the "short-circuit" wording. Make no assertion or `plan()` change, then re-run `scripts/test-db.sh` for that file. While editing, the PG >= 16 note for the migration's PROD-APPLY header is worth adding too. Editing the migration header changes the file but not the function bodies, so the recorded md5s still hold. Re-run pgTAP anyway (M-1). The user decides on this. Skipping it does not block ship.
2. **(Optional) Add the security L1 sentence to design §11.3.** The follow-up `inventory_items` lock should cover both `id` and `store_id`, and id reuse after a delete cannot be closed without an FK or a tombstone. This is doc only.
3. **Commit spec 177 with its paths staged explicitly (M-3).** The paths are:
   - `specs/177-cross-store-item-rejection.md`
   - `specs/177-cross-store-item-rejection/`
   - `supabase/migrations/20261025000000_cross_store_item_rejection.sql`
   - `supabase/tests/cross_store_item_rejection.test.sql`
   - `supabase/tests/order_approvals.test.sql`
   - `supabase/tests/report_last_order_context.test.sql`

   Spec 176 is already staged and SHIP_READY. Commit it on its own first, and do not use `git add -A`. The user runs the commit.
4. **Get the owner's explicit go-ahead for the prod apply (AC-24).** Do not proceed without it.
5. **Run the §10 runbook on `ebwnovzzkwhsdxkpyjka` with the architect's corrections:**
   - Step 1: read-only pre-check as written. Expect:
     - PG 17.x;
     - only `20261024000000` at or above the cutoff;
     - 3 × NULL from `to_regprocedure`;
     - 0 bad `po_items` rows and 0 `order_approvals` rows;
     - `po_items.item_id` FK `confdeltype` = `a`;
     - the expected existing triggers.

     STOP on any surprise.
   - Step 2 (**S-1**): run the full committed migration file verbatim in a single `execute_sql` call. Do not use `apply_migration`, and do not use a `pg_get_functiondef` dump.
   - Step 3: insert the exact version `20261025000000`. Then confirm with a select that exactly one row exists (**M-2**).
   - Step 4: normalized-md5 for all three functions, privilege and `prosecdef` checks, and `pg_trigger` presence with `tgenabled = 'O'`. Compare against **freshly recomputed** local values (**M-1**). The recorded values are `ec2c92ef…`, `71491c6f…` and `d357ad34…`.
   - Step 5 (**S-2**): the always-raise DO probe. `PROBE OK` means proceed. `PROBE FAILED` means stop and do not push. `PROBE SKIPPED` means fall back to Step 4 plus the local pgTAP run.
6. **Confirm CI is green on `main` before pushing (C-3).** Check the latest `test.yml` and `db-migrations-applied.yml` runs. If either is red or in progress, surface the run URL and wait for the user.
7. **Push.** Spec 175 (`8acecc4`), spec 176 and spec 177 can go in one push, but only after steps 5.2 to 5.4 succeed. If the user wants spec 175 and 176 out before the owner approves the prod apply, push them without the spec 177 commit.
8. **After the push:** confirm the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green, and check `e2e.yml` by hand (project memory: it is not yet in the CLAUDE.md gate checklist). If any run is red, surface the run URL and wait for the user.

## Out of scope for this review
- **The `inventory_items` re-homing residual** (spec "Out of scope", design §11.3, security L1). A two-store user can PATCH `inventory_items.store_id` or `inventory_items.id`, or delete an item and reinsert it with the same id in another store. This is a follow-up spec: an immutability trigger on `inventory_items` covering `id` and `store_id`, plus a decision on id reuse after a delete.
- **Orphan-header cleanup ignores a failed DELETE** (design §6 R-4 finding, Minor, pre-existing). In `createPurchaseOrderDraft` and `upsertVendorDraftOrder`, an empty draft header can be left behind if the cleanup DELETE fails. The new trigger makes this path reachable on a cross-store bug. It belongs with the deferred atomic-replace RPC follow-up.
- **`tg_order_approvals_guard` vs FK `ON DELETE SET NULL`** (design §11 risk 8, pre-existing, latent). The guard treats `approved_by` and `source_submission_id` as always immutable, but an FK SET NULL action fires BEFORE UPDATE triggers. So deleting a profile that approved an order, or the `eod_submissions` row an approval points at, should fail. It is latent today because prod has 0 approvals. It deserves its own question to the owner.
- **Non-canonical uuid spellings in `order_approvals.lines`** (security verification note). Braced or unhyphenated uuids pass the RPC and the trigger, but the read-side regex in `report_last_order_context` skips them. This is a data-quality gap with no tenancy impact, and it predates this spec.
- **Spec 176 client Lows L1/L2/L3.** These are tracked separately, as the spec says.
- **Strengthening T16 and T34 to really prove the short-circuit** (cross-store-first variant). This is optional test hardening, if the user wants it beyond the description fix in step 1.

## Handoff
next_agent: NONE
prompt: SHIP_READY. The conditions are the owner-gated prod apply (AC-24) run with the architect's S-1/S-2 runbook corrections BEFORE any push carrying 20261025000000, and green `test.yml` + `db-migrations-applied.yml` on main before and after the push. The code-reviewer's T16/T34/T48 description overclaim does not block; fixing the wording before commit is optional.
payload_paths:
  - specs/177-cross-store-item-rejection/reviews/release-proposal.md
