# Release proposal: spec 172 (EOD "NO NEED")

Release-coordinator, 2026-10-23. Sources: the four reviewer files in this directory and `specs/172-eod-no-need.md` (ACs, §9 runbook, §11, §13 build split, Files changed). Context from the dispatcher: spec 171 is committed and shipped at `21effa6`, and all three CI gates are green on `main`. For 172, nothing is pushed, the migration is not applied to prod, and the prod normalized-md5 pre-check has not been run.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical and all 41 ACs pass. Two cheap should-fix code items remain, the main one closing a `current_stock = NULL` write path that the type widening opened. Nothing is committed yet, so both should land before the commit. After that, release is gated on the owner-run prod md5 pre-check and a DB-first apply.

## Findings summary
- **code-reviewer: 0 Critical, 4 Should-fix, 8 Nits.** No project-policy violations: no `db.ts` bypass, no color literals, no web-only APIs, no `app.json` change.
  - SF-3 (top issue): the three on-hand writers use different NO NEED predicates. `db.ts:1078` and the audit value at `useStore.ts:3064` gate on `entry.noNeed`, while `useStore.ts:3007` gates on `isNumericEodEntry`. Now that `actualRemaining` is `number | null`, a non-NO-NEED entry with a null total would pass the `db.ts` guard and write `current_stock = NULL`, and its audit value would read `"null <unit>"`. No current client builds that shape, so this is latent.
  - SF-1 / SF-2: the row write-back (`rowStateOf` / `commitRow` / clear-only) and "mark NO NEED, then advance" logic are each hand-copied across the admin and staff surfaces. These are maintainability findings.
  - SF-4: the same filter expression is computed twice at `ReconciliationSection.tsx:157`.
  - Confirmed: `PhoneWeeklyCount` is unaffected, and every `actualRemaining` consumer handles NO NEED.
- **security-auditor: 0 Critical, 0 High, 0 Medium, 2 Low.**
  - Low 1: NO NEED removes an item from variance/COGS and suppresses `eod_missing_for_item`, so it could hide shrinkage. It grants no new capability and every mark is audited with an actor from `auth.uid()`.
  - Low 2: `eod_entries` has no `(submission_id, item_id)` uniqueness, so a crafted duplicate payload causes report fan-out within the caller's own store. This is pre-existing.
  - Verified locally: posture and ACLs of both functions are preserved (`staff_submit_eod` gives anon, service_role and PUBLIC no EXECUTE), the CHECK holds, the cross-store trigger is intact, and the queue validator is correct.
  - Their ask: re-run the grant probe against **prod** after the apply, since no CI gate checks prod ACLs.
- **test-engineer: 41/41 ACs PASS, 0 FAIL, 0 NOT TESTED.**
  - Runs: jest 255 suites / 3175 tests, both typechecks exit 0, `test:db` 90/90 files (`eod_no_need.test.sql` 55/55), and the staff EOD smoke passes, including the new NO NEED step 8b.
  - SQL and client guards fail under mutation, so the tests are not vacuous.
  - Caveats (non-blocking): AC-10 is observable only at vendor level (D7 narrowing), and AC-14 has no golden-envelope diff.
  - The test-engineer added and staged `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.noNeed.spec172.test.tsx`.
  - Not verified: native rendering, and the prod md5 / prod apply.
- **backend-architect (post-impl): 0 Critical, no contract drift, 2 Should-fix (both deploy runbook, must close before push), 6 Minor.**
  - Migration matches the design hunk for hunk: S1-S5 and R1-R4, with bodies otherwise verbatim from the latest owners.
  - SF-1: the prod md5 pre-check is the release gate and has not been run.
  - SF-2: run `notify pgrst, 'reload schema'` unconditionally, then probe over REST. The three admin read mappers swallow errors, so a stale schema cache would blank the EOD views silently instead of raising an error.
  - M-1: pgTAP assertion (5) can never fail, because the CHECK makes its predicate unsatisfiable.
  - M-2: the runbook's `\d` is a psql meta-command that MCP cannot run. Also add the service_role EXECUTE probe.
  - M-3: rolling back the client drops whole queued staff submissions that contain a NO NEED entry, so drain queues before any client rollback.
  - M-4: Reconciliation shows "0 / 0, 100%" on an all-NO-NEED day.
  - M-5: the smoke leaves local residue.
  - M-6: confirms the accepted follow-ups.

No reviewer flagged a Critical. The verdict is FIXES_NEEDED because of the should-fix items below. The CI hard rule was not the reason: `main` at `21effa6` has all three gates green per the dispatcher.

## Recommended next steps (ordered)

### A. Code fixes (before commit; one backend-developer dispatch)

1. **SF-3: one NO NEED predicate across the on-hand writers.** Severity: should-fix, a latent data-integrity gap that 172's type widening introduced. Agent: **backend-developer**, because both `src/lib/db.ts` and `src/store/useStore.ts` are backend-owned under §13. It goes first because it is the only finding that can lead to a bad on-hand write.
   - `src/lib/db.ts` `submitEODCount` on-hand loop: replace `if (entry.noNeed) continue;` with `if (!isNumericEodEntry(entry)) continue;`. This narrows `actualRemaining` to `number` at the write site.
   - `src/store/useStore.ts` `submitEOD` audit value: derive it from the same `numeric` flag already computed at L3007. Keep `EOD_NO_NEED_AUDIT_VALUE` for NO NEED entries. Decide how a non-numeric, non-NO-NEED entry is audited; it must never read `"null <unit>"`.
   - The insert payload (`actual_remaining: e.noNeed ? null : …`) can stay as is. The read mappers never produce a null total for a non-NO-NEED row, so the new guard changes no current behavior.
   - Add one arm to `src/lib/db.eodNoNeed.test.ts`: a non-NO-NEED entry with `actualRemaining: null` performs no `inventory_items` update. Add a matching arm to `src/store/useStore.submitEOD.noNeed.spec172.test.ts`.
2. **SF-4: hoist the duplicated reconciled count.** Severity: should-fix (code-reviewer), effectively a nit. Agent: **backend-developer**; `ReconciliationSection.tsx` is in the backend half under §13. Bundle it with item 1.
   - `src/screens/cmd/sections/ReconciliationSection.tsx:157`: `const reconciled = latest?.entries?.filter(isNumericEodEntry).length ?? 0;`.
   - Do not fix the "0 / 0, 100%" display (architect M-4) here. It is listed as a follow-up below.
3. **(Optional, same dispatch) M-1: relabel or drop pgTAP assertion (5).** Severity: minor. Agent: **backend-developer**; `supabase/tests/eod_no_need.test.sql` is backend-owned.
   - It cannot fail, so it should not be counted as AC-1 evidence. AC-1 stays pinned by (3), (4) and (10).
   - If done, re-run `npm run test:db` and update the assertion count in the spec notes.
4. **Re-verify after the fixes.** Run full `npx jest` (not a subset), `npm run typecheck`, `npm run typecheck:test`, and `npm run test:db` if item 3 was done. Stage the result.
   - Stage only; the user runs the commit.
   - A re-review is not required for items 1-3. A focused code-reviewer pass on the two diffs is enough if the user wants one.

**Recommended deferral (user's call, not required for ship): code-reviewer SF-1 and SF-2 (duplication).** These are cross-surface refactors of UI paths that currently pass tests, and they would cross the §13 ownership line:
- SF-1 would add `applyEodRowState` / `patchRecord` to backend-owned `src/lib/eodNoNeed.ts` (**backend-developer**). **frontend-developer** would then adopt it in `EODCountSection.tsx` and staff `EODCount.tsx`.
- SF-2 would add `advanceUncountedAfterMark` to the shared keypad helper `lib/eodKeypad.ts` (spec 141) and lift the `allCounted` toast in `PhoneEodCount.tsx` (**frontend-developer**).

They protect a subtle "write only on change" rule and the just-marked-id advance trick from drifting apart. They fix no bug today. If the user wants them in 172, dispatch backend first (helper), then frontend (adoption), and re-run the full jest suite. Otherwise, carry them into the cleanup backlog.

### B. Owner-gated deploy (after A is staged; order is load-bearing: DB first, client second)

Prod project: `ebwnovzzkwhsdxkpyjka`, via Supabase MCP. Each step needs explicit owner approval. If any check fails, STOP and surface it; do not improvise.

5. **Prod pre-check (read-only, MCP `execute_sql`).** These are spec §9 step 3 checks (a) to (d):
   - (a) `select version from supabase_migrations.schema_migrations where version in ('20261023000000','20261024000000');` must return only `20261023000000`.
   - (b) The `information_schema.columns` probe for `eod_entries.no_need` must return 0 rows.
   - (c) `select count(*) from public.eod_entries;` sizes the CHECK scan.
   - (d) The normalized md5 (the §9 formula: strip comments, collapse whitespace, lowercase) must equal:
     - `staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)` = `c7a6f37994683f2c8317c9ee3146fc42`
     - `report_reorder_list(uuid,jsonb)` = `15eaff54265a3adb0f1bbd9283dea5e8`
   - **Any mismatch means STOP.** Prod has undeclared drift, and the recreate would clobber it. Surface this to the owner.
6. **Prod apply (MCP `execute_sql`, off-peak, not during closing hours).** The migration sets `lock_timeout = '5s'` on `eod_entries`, and staff write to that table all evening.
   - Execute the migration SQL. Prefer the exact pgTAP-tested bodies dumped from local.
   - Then run `insert into supabase_migrations.schema_migrations (version, name) values ('20261024000000','eod_entries_no_need') on conflict (version) do nothing;`.
   - **Do not use `apply_migration`**, because it mints its own timestamp.
   - If the ALTER hits the lock timeout, re-run off-peak.
7. **Prod post-verify (MCP).**
   - Normalized md5 equals `41220a3f9a7629c0b13579af3d280020` (`staff_submit_eod`) and `395f8831dbcaf91edcaf3c59227821a2` (`report_reorder_list`).
   - Column and CHECK: use `select pg_get_constraintdef(oid) from pg_constraint where conname = 'eod_entries_no_need_no_quantity_check';` and `select column_default, is_nullable, data_type from information_schema.columns where table_schema='public' and table_name='eod_entries' and column_name='no_need';`. Do not use `\d`, which MCP cannot run (architect M-2).
   - Permissions via `has_function_privilege`:
     - anon has **no** EXECUTE on either function;
     - authenticated **has** EXECUTE on both;
     - **service_role has no EXECUTE on `public.staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)`**.
   - Exactly one `pg_proc` row per function.
   - `prosecdef` is true for `staff_submit_eod` and false for `report_reorder_list`.
8. **Always reload the PostgREST schema, then probe over REST** (architect SF-2; unconditional, not only on PGRST204).
   - Run `notify pgrst, 'reload schema';`.
   - Then `GET /rest/v1/eod_entries?select=no_need&limit=1` with an admin JWT must return **200**. A 400 or PGRST204 means do not push.
9. **Commit** (the user confirms; main Claude does not auto-commit). The commit must contain:
   - every file under `## Files changed`, both halves, plus the code fixes from section A;
   - `supabase/migrations/20261024000000_eod_entries_no_need.sql` and `supabase/tests/eod_no_need.test.sql`;
   - the test-engineer's `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.noNeed.spec172.test.tsx`;
   - `specs/172-eod-no-need.md`, re-staged so it includes the latest notes;
   - the whole `specs/172-eod-no-need/reviews/` directory: `code-reviewer.md`, `security-auditor.md`, `test-engineer.md`, `backend-architect.md`, and `release-proposal.md`. It is currently untracked.

   Before committing, check `git status` for unstaged edits made after staging; the full status was truncated at `supabase/`. The spec's stale `## Handoff` block (`next_agent: backend-developer, frontend-developer`) is bookkeeping for the developer or PM to tidy. It does not block.
10. **Push to `main`.** Only after steps 5-8 pass. Pushing before the apply turns `db-migrations-applied` red, and a new client against the old DB writes `current_stock = NULL` through the old staff RPC.
11. **Check all three gates on `main`**, via `gh run list --branch main --workflow <file> --limit 1` for each of `test.yml`, `db-migrations-applied.yml` and `e2e.yml`. If any is red or in progress, surface the run URL and wait for the user.

**Rollback posture** (from §9 step 7 and architect M-3):
- Roll back the client first, never the DB first.
- Drain staff offline queues before rolling the client back. An older staff bundle drops any queued submission containing a NO NEED entry, including its numeric siblings.
- A DB rollback is roll-forward-only in practice and is a deliberate owner action.

## Out of scope for this review
- **Owner decision OQ-A / D7 (confirm, not blocking).** A cross-vendor NO NEED row on a vendor that has not submitted keeps `on_hand_source = 'stock'`, so it still shows STOCK FALLBACK. Reversing this is a one-line SQL change (R2(b)) and would flip pgTAP (42).
- **OQ-B follow-up.** `PhoneOrdering.tsx`, `reorderExport.ts` and `reorderExportStaff.ts` still print the stale on-hand for a `no_need` row. The flag is already in the payload, so the fix is display-only.
- **Architect M-4.** Reconciliation shows "0 / 0, 100% complete" on an all-NO-NEED day. It is cosmetic and needs a separate display decision.
- **Security Low 1 (shrinkage visibility).** Consider making NO NEED marks prominent in Reconciliation.
- **Security Low 2 / spec R5.** Add uniqueness on `eod_entries (submission_id, item_id)`, or dedupe in the RPC. Shares the spec 151 follow-up; needs a backfill check.
- **Code-reviewer nits:**
  - localize the hardcoded English `FlagChip` "NO NEED" with the existing `section.reorder.noNeed` key;
  - extract `isNoNeedRow` and drop the redundant `|| []` (staff `Reorder.tsx`, `lastOrderContext.ts`);
  - mixed snapshot sources in `onEditCurrentVendor`;
  - the `setNoNeed` vs `toggleNoNeed` gating split in `PhoneEodCount`;
  - the `NumericEODSubmission` cast in `eodNoNeed.ts:128`;
  - inconsistent `spec172` test-file naming;
  - the `eod-sheet-total` testID on the shared sheet.
- **Test hardening.** A golden-envelope pgTAP for AC-14 (byte-identical reorder output without NO NEED), and mutation-proofing of the `useStore.submitEOD` guard, `isValidEodEntry` and `useEodSubmit` paths.
- **Unverified surfaces.** Native iOS/Android rendering of the new controls, and the staff EOD screen in a real browser. Both are pre-existing, known gaps.
- **Pre-existing, unrelated to this diff:**
  - desktop Ordering shows "0 vendors" until REFRESH on first navigation after an EOD submit;
  - the desktop locked meta line shows `· total 0 <unit>` for submitted case-pack rows;
  - the `DashboardSection.tsx:1278` `% 5 + 30` proxy counts NO NEED entries (OQ-D);
  - `eod_vendor_has_below_par` reads pre-count `current_stock` (R4).
- **Backlog.** Deduplicate the three `db.ts` EOD read mappers (already on the cleanup backlog).
