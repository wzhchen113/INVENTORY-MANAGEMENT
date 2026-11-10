# Release proposal: spec 186

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical and AC-1 to AC-27 pass locally, but the architect's two should-fixes and the auditor's M5 prod checks must land before the prod apply, the migration is not on prod, nothing is committed, and the two `main` gates are unconfirmed.

**Deadline:** the migration must be on prod before 2026-11-20. That is what protects the 2026-08-22 PO, even if the client release slips. A device whose clock runs fast reaches that PO early, so apply as soon as the owner agrees rather than working to the date.

## Findings summary
- **code-reviewer:** 0 Critical, 0 should-fix, 7 nits. All are comments or test readability. It read the code only and deferred the trigger question to the architect.
- **security-auditor:** 0 Critical, 0 High, 5 Medium, 8 Low. No new path lets a client delete anything it could not already delete. Top issues:
  - M5: the kept-record guarantee is proved only locally.
  - M1 to M4: older ways to lose kept records, none of them age-based.
  - L1: the store trigger has no demonstrated need.
- **test-engineer:** AC-1 to AC-27 PASS, 0 FAIL, 0 not tested. AC-28 to AC-31 are PENDING prod steps. Latest full runs: pgTAP 97 of 97 files, jest 3,771 of 3,771 tests. It lists 6 weak spots, none of which fails an AC.
- **backend-architect:** 0 Critical, 2 should-fix, 7 minor. The build matches the design. SF-1 removes the trigger, and SF-2 is the rollback contradiction.

### Limits on this evidence
- **Prod:** no reviewer ran a prod query. Every result describes the local schema.
- **Fresh build:** none has run. The body was applied with `psql`, and local CLIs (2.95.4, 3.0.0) differ from CI's 2.106.0. The first CI run comes after the prod apply. Watch `J-1` to `J-3` and the new P-2 on that run.
- **AC-13:** plain `npm run typecheck` exits 2 in this checkout, because of 24 empty `node_modules/@types/* 2` folders. The pass rests on a `tsc` run with explicit `--types` (0 errors). CI is the real proof.
- **AC-26:** the test report says it re-ran "four of the five rows", but its table covers three of the five plus one extra. The other two rest on the developer's record. This matters little, since SF-1 requires a full re-run.
- **Prod RI order:** the architect says the owner read it on 2026-11-08. The spec and the auditor say it is unread, and I found no recorded result in the spec or the session notes. The ruling stands either way, because both orders passed locally. Record the actual result or re-read it in step 3.

### Correction to the M4 impact
I found no caller of `db.deleteStore`. A search of `src/`, `supabase/functions/`, `scripts/` and `e2e/` finds only its definition, and spec 170 (F-170-2) recorded the same zero callers. So the auditor's probe of the statements stands, but "an admin deletes a store and the UI reports nothing" is not reachable from today's app. I did not check builds older than spec 170.

## Recommended next steps (ordered)

### Fixes before the prod apply

1. **Remove `stores_clear_waste_log_before_delete` (SF-1, should-fix; also L1).** This comes first because every later step verifies the result. Edit `20261108120000` under the same version, using the architect's change list:
   - **Migration:** remove the trigger and its function, and renumber the sections.
   - **`db.ts`:** update the comment above the `waste_log` delete.
   - **Test file:** plan 72 becomes 70, P-2 is replaced, P-3 is narrowed, and P-6 and T-3 are removed.
   - **Spec:** mark the superseded design text with a dated note.
   - **Shared local database:** run the architect's `drop trigger` and `drop function` by hand, because editing the file does not remove them. Do it when no other session is mid-run. No other file in the repo names these objects, so specs 187 to 189 do not depend on them.

2. **Fix the rollback contradiction (SF-2, should-fix).** Limit spec L560 to a prod apply that failed before commit. Once the migration has committed, the file and version row stay, and any rollback is a forward migration or an MCP change to the job alone. The policies stay unless the owner decides otherwise. Without this, the written rollback can restore the deletion this spec exists to stop.

3. **Extend the prod checks (M5, Medium; architect minor 5).** Add these to step 1 of "Prod apply". They are read-only, and the auditor says they must run before applying:
   - The auditor's four queries: all `cron.job` commands, DELETE and ALL policies on the eight kept tables, functions that delete from those tables, and triggers on `stores`.
   - The architect's checks: version `20261108120000` absent, no `stores_clear_waste_log_before_delete` in `pg_trigger`, and `server_version` recorded.
   - Expected `cron.job.username` is `postgres`, with a stop if it differs. Also verify the three policy comments.
   - **Run the auditor's queries locally first and use the output as the baseline (my addition).** The audit gives no expected results for them, and "0 rows" is wrong for the function query, since `staff_submit_eod` alone should match it (M3). Stop and ask the owner about anything prod has beyond that baseline.

4. **Correct wording while the file can still change (minor, nits).** After the apply, each of these would need a forward migration:
   - Migration L12-13: the margin sentence reads backwards (architect minor 1).
   - Migration L151: "harmless for audit_log (N3)" (architect minor 3, code-reviewer).
   - `useStore.ts:2244`: remove the stale "cleanup" tail (architect minor 2).
   - Spec L553: the age-limit rollback also has to change the policy comments and arms (architect minor 4).

   Do these only if they cost nothing extra. The other nits and test hardening do not hold the apply: the arm map, the `select;`, and the test engineer's A9 and A17-8 notes. Neither does the `proconfig` part of L7.

5. **Re-verify.** Run these one at a time, because a parallel jest and pgTAP run crashed a jest worker earlier.
   - The new pgTAP file, then the whole pgTAP suite.
   - Every AC-26 mutation against the 70-arm file, plus the new row: `waste_log_store_id_fkey` without CASCADE must fail A19-6 and A19-7. A19 now carries the store-delete guarantee and has never been shown to fail.
   - Full `npx jest` and `npm run typecheck:test`, plus the `typecheck` workaround above.
   - A search showing `tg_stores_clear_waste_log` survives only in spec history.
   - The security auditor reads the architect's ruling, then re-reads the migration and test file only. No full re-review is needed.

### Release, once the fixes are in

6. **Check the gates (main session, still to do).** I cannot run `gh`, so this is **not confirmed**. The main session will check the latest `test.yml` and `db-migrations-applied.yml` runs on `main`. No SHIP_READY can stand unless both are green. Do not assume anything about `c630c7f` (spec 178):
   - **Pushed and on prod:** nothing further.
   - **Pushed but not on prod:** the migration gate should already be red. Surface it and wait for direction.
   - **Not pushed:** this spec's push carries it too, along with any other unpushed commits. Spec 178's migration `20261108000000` must be on prod first, or the gate goes red.

   Spec 186's migration does not touch `order_approvals`, so spec 178's state does not block the prod apply. It affects only the push.

7. **Commit (owner runs it, staged by hunk).**
   - **`src/lib/db.ts`:** stage this spec's hunks only, and leave the spec 187 hunk near L2702.
   - **The index:** the status snapshot at the start of this session shows specs 188 and 189 already staged, so a plain `git commit` could sweep them in. Check `git diff --cached --name-only` right before committing.
   - **Not this spec's:** specs 187 to 189, `package.json`, `placeholderEmail*`, `delete-user`, `20261108130000_*`, and the other changed test files. Use the spec's "Files changed" list. I did not diff the other listed files for hunks from other sessions, so read each diff while staging.
   - **After the commit:** tell the spec 188 session its build can proceed. Until the prod apply is done, nobody should push `main`, or the migration gate goes red.

8. **Apply to prod (needs the owner's go-ahead; AC-28, AC-29).** Follow "Prod apply" and the additions as written, and stop on any failed check. Run the first-run query before and after applying, with its existing stops (`audit_would_prune` over 500, `invites_would_prune` over 4, or numbers that cannot be explained). Leave time before 08:47 UTC, so the second read comes before the job's first run.

9. **Push, then confirm the gates (AC-30, by 2026-11-20).** Confirm both gates are green and check `e2e.yml` by hand. If the client release slips past the date, the applied policies still protect the PO.

10. **Check after the deadline (AC-31, on or after 2026-11-21).** Run the read-only check that the 2026-08-22 PO still exists. After the first scheduled run, do the spec's checks and report the numbers to the owner.

### If the date gets tight
SF-2 and the M5 checks are cheap and must not be skipped. SF-1 is the only item that could stall, because of the re-verification. The architect calls the trigger "not dangerous": same rows, same authority, and it rolls back. So my recommendation is that if SF-1 is not finished in time, apply with the trigger and remove it by forward migration. Missing the date is the worse outcome. Neither the fixes nor M1 to M4 should push the apply close to 2026-11-20.

## What the owner must decide

| # | Decision | Needed by | Recommendation |
|---|---|---|---|
| 1 | **Go-ahead for the prod apply and push** (AC-28 to AC-31) | As soon as step 5 is done, before 2026-11-20 | Yes. Note that the fresh-build proof stays open until the first CI run on `main` (architect minor 7) |
| 2 | **M4: what should store deletion be?** | Hear it now. It does not hold this spec | See below |
| 3 | **M1 and M2: should "kept" also resist deliberate deletes by store members?** | After this spec | Yes, as one follow-up spec |

**Decision 2 (M4).** The owner should hear this now:
- A failed `deleteStore` removes that day's waste rows and every staff grant for the store, then leaves the store in place, and it reports no error (P6, local). Aged waste rows now survive it.
- A store with a counted item fails this way, which likely means every working store. The auditor's probe confirmed what spec L566 only called probable.
- So spec L24's "deliberate deletes keep working" holds for store deletion only when a store has no counted items and no PO lines. The design also notes that `hard_delete_brand` fails for any brand whose stores own items.
- It is not reachable from today's app, because nothing calls the function (see the correction above). So nothing needs doing before the release.

The choice is between two paths:
- **No store deletion wanted:** delete the dead function (spec 170's F-170-2). This is my recommendation, because it is the smallest fix and removes the hazard.
- **Store deletion wanted:** it needs its own spec, with the auditor's single-transaction RPC, and the owner must say what happens to a store's kept EOD and PO records. Today those records block the delete.

**Decision 3 (M1, M2).** The owner's "Keep" covers age-based deletion only, so these two do not break the decision, but "kept" is a weaker promise than it sounds. Today a store member can change a kept row's date and then delete it (M1), or remove lines under a received PO or a POS import while the parent stays (M2).

### M1 to M4: where each belongs

All four predate this spec and are not age-based deletion. None belongs in this spec, and none blocks it.

| Finding | Belongs in | Owner decision? |
|---|---|---|
| **M1:** a member can change a kept row's date, then delete it | Follow-up spec (date-immutability guard). Spec L264 scopes it out | **Yes,** decision 3 |
| **M2:** child rows of kept records have no delete protection | Follow-up spec, with M1. Narrow the `po_items` and `pos_import_items` delete policies | **Yes,** decision 3 |
| **M3:** `staff_submit_eod` can erase a kept EOD count at any age, with no audit row | Follow-up. Raise it with the spec 189 session now, see below | **No policy decision,** but tell the owner. Guarding against an empty payload only makes the server match the UI |
| **M4:** a failed `deleteStore` leaves a store half-cleared | Follow-up, or removal of the dead function | **Yes,** decision 2 |

**M3 timing.** Spec 189 is now `READY_FOR_ARCH`, not draft as the audit says, and its recommended option refactors `staff_submit_eod` into a shared writer. My search of it finds no empty-payload guard or `p_date` bound. Its architect should see M3 now, so the guards are designed in or explicitly deferred. Any `p_date` bound has to allow for the staff offline queue, which I did not trace.

## Out of scope for this review
- **Other security Lows, as follow-ups:**
  - L2: `SECURITY DEFINER` on the prune is unneeded. Harmless, and it matches the reference shape.
  - L3: a 1-hour fresh-row window instead of 24 hours. This is the architect's call, and it is cheapest before the apply, but it means reworking the A17 and A22 arms. I would not add it to this round.
  - L4: revoke `TRUNCATE` on the kept tables, `audit_log` and `invitations`. Check prod's ACL too.
  - L5: a super_admin can skip `hard_delete_brand`'s pre-flights.
  - L6: invitation deletes are unscoped (spec L264, L267).
- **L8:** the recipe link on kept POS lines becomes erasable. It belongs to spec 188.
- **Specs 187 to 189:** separate work. The auditor found no conflict with this spec's protections beyond M3 and L8.
- **Dependency baseline:** `npm audit` reports 46 advisories across the repo, 1 critical (`shell-quote`) and 17 high. This spec adds none, and reachability was not assessed. It needs a separate pass.
- **Existing problems noticed:**
  - `generate_po_number` computes `max()` under the caller's RLS and can fail with 23505 across brands.
  - `npx supabase` resolves to CLI 3.0.0, which refuses `config.toml`.
  - The stray `node_modules/@types/* 2` folders.
  - Spec 179's wording on RI firing, which led to the design's error.
  - The architect's optional probe of the queue model. The ruling does not wait on it.
- **"Consequences of keeping" (spec L273-286):** not bugs in this spec, each a possible follow-up.
