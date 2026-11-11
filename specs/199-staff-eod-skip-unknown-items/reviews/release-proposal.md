# Release proposal: spec 199 (staff EOD submit skips unknown or cross-store items)

Release-coordinator, 2026-11-10. Built from the four reviewer files in `specs/199-staff-eod-skip-unknown-items/reviews/` (code-reviewer, security-auditor, test-engineer, backend-architect) and the spec, including `## Backend design` and `## Files changed`. I also read arm (55) of `supabase/tests/staff_submit_eod_skip_unknown.test.sql` and grepped the migration to confirm SF-1 myself.

## Verdict
verdict: FIXES_NEEDED
rationale: Nobody flagged a Critical or High and all 21 ACs pass, but there is one cheap Should-fix (SF-1: the R10 lock pin is satisfied by a comment), the hard dependency on spec 193 is still uncommitted, and I could not check either CI gate on `main` in this session, so the conditions for SHIP_READY aren't met yet.

### CI gate status (not verified)
- I had no shell in this run, so I could **not** run `gh run list --branch main --workflow test.yml --limit 1` or `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`.
- The last recorded check I found is in spec 193's release proposal: both gates green at `97f0f17`. `main` has moved since then (HEAD is `fa6171c`, spec 197), so that result is stale and doesn't count here.
- Under the CLAUDE.md hard rule, SHIP_READY needs both latest runs green. Whoever runs the commit step has to run both commands first (step 4 below), and check `e2e.yml` by hand.

## Findings summary
- **code-reviewer:** 0 Critical, 0 Should-fix, 7 Nits. The migration and client match the design block for block. Main nits:
  - The drain debounce timer isn't cleared on unmount, so a skipped notice can be lost if the screen unmounts within 400 ms. This gap existed before the spec.
  - The `6000` toast duration is a repeated literal.
  - Arm (51) reuses SK1's `test.r1` submission, so a failure in arm (1) cascades into it.
  - The pre-flight's `like '%eod_write_submission(%'` treats `_` as a wildcard. Harmless.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 2 Low. Ten local probes found no leak. A missing id and a cross-store id can't be told apart by envelope, refusal, side-effect evaluation or lock timing (P1-P3, L1). The store gate still refuses outsiders with 42501 before any lookup (P4/P5). Catalog posture is unchanged (C1, md5 `dce41928…` matches). Narrowing `isForbidden` doesn't make any real revocation retry forever.
  - Low 1: a legacy pre-2026-05-14 cross-store `eod_entries` row would put a foreign item's name into the calling store's `audit_log` as a `Count cleared` row. 0 such rows locally. Fix: a read-only count in the prod pre-check.
  - Low 2: there's no upper bound on `jsonb_array_length(p_entries)`. 100k ids took 154 ms and are bounded by the 8 s `statement_timeout`. Optional cap.
- **test-engineer:** 21 PASS, 0 FAIL, 0 NOT TESTED (AC-1 to AC-21).
  - New suite: 57/57. Full pgTAP: 107/107 files. Full `npx jest`: 308/308 suites, 3972/3972 tests.
  - Both typechecks are clean apart from local-only TS2688 noise from duplicate `@types/* 2` folders.
  - Not exercised: real R10 concurrency, because pgTAP can't run two sessions. Arm (55) is only a structural pin, and SF-1 shows that pin is weak.
  - Spec 193's uncommitted hunks coexist with 199's in the same files without failures.
- **backend-architect (post-impl):** 0 Critical, 1 Should-fix, 4 Minor. Every design item (D-1 to D-9, SR-1, §2.1-§2.7, §5.1-§5.6, prod-apply and rollback text) conforms.
  - **SF-1:** arm (55) asserts `prosrc ilike '%for key share%'`, but `prosrc` includes the comment at migration L259 (`-- because FOR KEY SHARE is not allowed alongside an aggregate.`). So the arm would still pass if a later rewrite (spec 185 is the likely one) dropped the real clause at L269. I confirmed this by reading both files.
  - M-1: no arm covers R9's legacy cross-store row.
  - M-2: if the confirmation refetch fails, the online locked view briefly shows skipped items as counted.
  - M-3: the spec 199 describe uses a `beforeAll` sleep of 500 ms, which is tied to the 400 ms debounce.
  - M-4: the reviewer couldn't confirm by diff that only arm (16) of `admin_submit_eod.test.sql` changed for 199.

## Recommended next steps (ordered)

### Fix before commit (cheap; fold in now)
1. **SF-1 (Should-fix). Tighten arm (55) so it pins the code, not the comment.** File: `supabase/tests/staff_submit_eod_skip_unknown.test.sql` L713-716. This is test-only: the migration, md5 and plan count (57) don't change. It comes first because it's the only remaining guard against the R10 race coming back silently, and spec 185 will rewrite this wrapper next. Replace the predicate with a comment-stripped, alias-anchored match:
   ```sql
   regexp_replace(prosrc, '--[^\n]*', '', 'g') ~* 'for\s+key\s+share\s+of\s+ii'
   ```
   Update the arm description to match, then re-run the suite (57/57 expected).
2. **Security Low 1 (no code change). Add the legacy cross-store row count to the §7 prod pre-check** in the spec runbook, or run it during the apply:
   ```sql
   select count(*) from eod_entries e
     join eod_submissions s on s.id = e.submission_id
     left join inventory_items i on i.id = e.item_id
    where i.store_id is distinct from s.store_id;
   ```
   If the count is non-zero, the owner decides whether to clean those rows up as `postgres` before applying. This is a read-only step, so it costs nothing to add.
3. **Optional nits, a few minutes each:**
   - a `NOTICE_TOAST_MS` constant for the repeated `6000`;
   - escape the `_` in the pre-flight `like` (`\_`), or switch to `strpos`;
   - give arm (51) its own seeded submission.

   Doing the pre-flight `like` fix now would change the migration file, but not the function bodies or md5s. It's fine to leave it out. Don't let these delay the commit.

### Commit and apply order (required; the hard dependency on spec 193)
4. **Re-check both CI gates on `main` before anything else.** Run `gh run list --branch main --workflow test.yml --limit 1` and `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`. Both must be green; check `e2e.yml` by hand. If either is red or still running, surface the run URL and stop.
5. **Spec 193 lands first: its own commit, then its prod apply.** 199's migration pre-flight raises SQLSTATE `55000` unless 193 is applied, so applying 199 to prod before 193 fails by design. Committing 199 first would leave a repo that can't apply its own migrations in order on a fresh DB only if 193 were missing. That can't happen as long as 193 is in the same or an earlier commit, but never commit 199 alone.
6. **Separate the shared-file hunks.** Two files hold both specs' uncommitted edits:
   - `src/screens/staff/hooks/useEodSubmit.test.ts`:
     - spec 193's hunks are its AC-9 and AC-10 arms;
     - spec 199's hunks are the L115-128 fixture message change (AC-21) and the `spec 199 skip unknown items` describe (about L538-836, after 193's arms).
   - `supabase/tests/admin_submit_eod.test.sql`:
     - spec 199's only hunk is arm (16), L327-328 (the key array gains `'skipped_item_ids'`, and the description is updated);
     - everything else in that file's diff belongs to spec 193.

   Review `git diff` on both files by hand. This also closes architect M-4. Then build each spec's commit from a temporary index (the shared-index procedure: temp `GIT_INDEX_FILE`, `read-tree HEAD`, `apply --cached` with only that spec's hunks), and test the exported tree before committing.
   - **Ordering trap:** 193's commit must **not** include 199's arm (16) hunk. A 193-only tree has no `skipped_item_ids` in the staff envelope, so 199's arm (16) would fail there.
   - 199's L115-128 fixture change only passes against 199's narrowed `isForbidden`, so it belongs in the 199 commit too.
   - Run full pgTAP and full `npx jest` on each exported tree, not just the combined working tree.
7. **Stage only 199's files** (listed in the spec's `## Files changed`). The working tree also holds unrelated staged and unstaged work from other sessions: specs 188, 192 and 196, the invite and auth files, `package.json` and the smoke scripts. None of it belongs in either commit. Don't commit until the owner says so.
8. **Prod apply for 199 (owner's go-ahead only, after 193 is on prod).** Follow the spec §7 runbook via the Supabase MCP, with step 2 above added to the pre-check.
   - Before applying: the prod wrapper md5 must be `a32251eb…` (193).
   - After applying: the wrapper md5 must be `dce41928eeea865f5c10ea34297a9b68`, and the writer and `admin_submit_eod` md5s must be unchanged (`f3ba9ae8…`, `27e88465…`).
   - Insert the exact version `20261110130000`.
9. **Push to `main` only after both prod applies.** Otherwise `db-migrations-applied.yml` goes red on a migration missing from prod. After the push, confirm both gates are green on `main` and check `e2e.yml` by hand.

### Follow-ups (not blocking; can ride with this spec or a later one)
10. **Architect M-1:** add a pgTAP arm for R9's legacy cross-store row. Disable the trigger in-transaction, seed X under S, send `[I1]`, and assert one `Count cleared` row naming X. This is about 15 lines, so it can be folded in now if wanted; otherwise make it a follow-up. The behaviour already follows from the unchanged writer.
11. **Security Low 2:** an optional payload-size cap, for example refusing more than 2000 elements with a constant 22023 message that follows the R5 rules, placed after O-1.

## Out of scope for this review
- **Unmount cleanup of `allSyncedTimerRef` / `skippedPendingRef`** (code-reviewer nit 1, architect M-3). This gap existed before the spec. The `beforeAll` sleep of 500 ms in the jest describe is a workaround for it. Fixing it with an unmount effect or fake timers belongs to a staff-hook hygiene pass; the design's §5.7 "Not changed" applies.
- **Architect M-2:** the online locked view synthesizes skipped items until the refetch lands. Fixing it needs the skipped ids, not just the count, on `Outcome`. It belongs with the spec 193 / 185 staff-queue follow-up.
- **R4 retry-forever / needs-attention UI** for an all-stale queued count. Spec 193 already named this follow-up (`attempts >= 5`).
- **Security informational:** the replay lookup (step 4) has no store filter on `client_uuid`. This existed before the spec and isn't practically exploitable (random v4 values held only by the device). It's a candidate for a future hardening pass.
- **`useEodSubmit.ts` header comment** says "one of four outcomes" while listing five. This also predates the spec.
- **Spec 185 sequencing:** 185 also rewrites `staff_submit_eod`. Whichever spec lands second must carry 199's skip block and the SF-1-tightened pin.
- **Local TS2688 noise** from duplicate `node_modules/@types/* 2` folders. It's local-only and not a CI issue.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 1 item (plus 1 zero-code runbook addition), top: SF-1, tighten pgTAP arm (55) to a comment-stripped `for\s+key\s+share\s+of\s+ii` match. Then commit spec 193 first with the shared-file hunks separated (199's arm (16) in admin_submit_eod.test.sql and its describe and fixture in useEodSubmit.test.ts go only in 199's commit), prod-apply 193 then 199, and push after both. CI gates on main were not verified in this session; re-check test.yml and db-migrations-applied.yml before committing.
payload_paths:
  - specs/199-staff-eod-skip-unknown-items/reviews/release-proposal.md
