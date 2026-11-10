# Release proposal: spec 190 (po-number-sequence)

Written by release-coordinator, 2026-11-09. This is advisory; the owner decides.
Sources: the four reviewer files in this folder (read directly), the spec, the
migration's header, trigger body and comments, and
`scripts/smoke-po-number-concurrency.sh` (lines 80-139, read to confirm the
code-reviewer's smoke findings). Main Claude also supplied some facts, which are
marked "(main Claude)" below.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer found a Critical, and the migration and pgTAP logic match the design with no drift, but a few small Should-fix items remain open in this spec. The prod privilege post-check can miss a PUBLIC grant, the concurrency smoke can flake and keeps running after a failed precondition, and AC-14 hasn't yet passed on a freshly reset database. All of these are spec-text or test-script edits. None of them changes the migration's SQL or a test assertion.

Read this as "nearly ready". About an hour of edits stands between this and
SHIP_READY. Prod is not failing today (spec "Prod exposure"), so there is no
emergency that would justify skipping them.

## Findings summary

- **code-reviewer**: 0 Critical, 3 Should-fix, 6 Nits plus 2 out-of-scope notes.
  - Should-fix: `scripts/smoke-po-number-concurrency.sh:92-125`. The "B finished
    while A was still open" check relies on A's fixed 3 s sleep, so it can
    false-fail on a busy Docker Desktop. Confirmed in the script.
  - Should-fix: `:100-105`. When A never reaches `pg_sleep`, the script prints
    FAIL but still runs B, so the later checks are meaningless. Confirmed: no
    `exit` on that branch.
  - Should-fix: the smoke isn't in `test:smoke` and isn't listed in the Track 3
    section of `tests/README.md`. It should be documented as manual-only.
  - Nits:
    - the migration header lists `greatest` as a shadowable function (it is an
      expression);
    - say why the formatter pins `search_path`;
    - the variable `v_n` is used once;
    - split the combined anti-vacuity `ok()` checks so a failure shows which
      fact broke;
    - the malformed-guard header overstates "does NOT reset";
    - the "previous + 1" assertions can flake on a shared database;
    - helper duplication (leave as is).
  - Matches the design step for step. Plan count 57 checked by hand.

- **security-auditor**: 0 Critical, 0 High, 1 Medium, 5 Low.
  - Medium, follow-up spec, not a regression: any store member can still squat
    on PO numbers with explicit `po_number` values, through INSERT or UPDATE
    (column grants plus `store_member_*` policies). That makes generated
    inserts in any brand fail with `54000`, once per 100 squatted numbers.
    Before this spec the same act caused a permanent cross-tenant outage. Now it
    is bounded and clears itself. The fix is a BEFORE INSERT OR UPDATE OF
    `po_number` guard for client roles (`'po_number is server-assigned'`).
    Validating explicit numbers is out of scope for spec 190.
  - Low, in spec: three gaps in the D-9 prod checklist.
    1. Prod's table owner and `rolbypassrls` (the DP-1 query) aren't checked.
    2. The `anon=` / `authenticated=` string check misses a PUBLIC (`=X/...`)
       grant.
    3. The sequence owner isn't checked.
  - Low, in spec: D-11 #4 wrongly says anon and authenticated have no TRUNCATE.
    The sequence-reset vector is still closed, because `RESTART IDENTITY` needs
    sequence ownership and PostgREST has no TRUNCATE verb. Correct the wording.
  - Low, in spec: "rollback is safe" holds only while every generated number is
    below 1000. Qualify the rollback note.
  - Low, optional: the `54000` hint shows operator guidance (sequence name,
    `setval()`) to end users through the toast.
  - Low, by design: global numbering gives a cross-brand volume signal. The
    owner accepted it (Q1). No action.
  - Low, follow-up spec: TRUNCATE is granted to anon and authenticated on
    `public` tables. Main Claude confirmed it read-only on prod: 52 tables.
  - Verified clean: the DEFINER body takes no caller input, the `search_path`
    pin, the grants against the spec 097 defaults, nothing is callable, the RLS
    bypass is intended and pinned, the loop is bounded, the migration is safe,
    and the tests are hermetic.

- **test-engineer**: 15 PASS, 0 FAIL, 1 NOT TESTED.
  - AC-1 to AC-15 pass, and DP-1 to DP-6 pass (57/57 in the new file, 8/8 in the
    guard file).
  - Full pgTAP run: 99/99 files, on the state applied with psql (not a fresh
    reset).
  - Concurrency smoke passes.
  - AC-16 (prod rollout) is NOT TESTED. It is gated on the owner's go-ahead, so
    it is expected, not a defect.
  - Jest and typecheck weren't re-run by the test-engineer. They rely on the
    developer's run (299 suites / 3826 tests; `typecheck:test` exit 0). No
    TypeScript changed.
  - Non-blocking weaknesses:
    - the shared-database window between reading `seq_next()` and inserting
      (AC-9, AC-10, DP-6);
    - the smoke covers only postgres-role sessions;
    - multi-skip is exercised only through DP-6.
  - Fresh-CI behaviour was judged by reading the tests and is expected to pass.
    It can't be simulated locally without lowering the sequence.
  - Main Claude independently re-ran the sequence file (57/57), the guard file
    (8/8), `po_loop` (30/30) and the smoke (pass). It also confirmed that the
    original same-brand store-manager `23505` repro now gets a fresh number.

- **backend-architect** (post-impl): 0 Critical, no contract drift, 2
  Should-fix, 6 Minor, 1 noticed-not-changed.
  - S-1: the D-9 and migration-header (lines 65-66) prod ACL check should use
    `has_function_privilege` / `has_sequence_privilege`, as DP-2 and DP-3 do,
    so a PUBLIC grant is caught. This overlaps the security-auditor's D-9 Low
    #2.
  - S-2: AC-14 hasn't been shown on a clean database or through the CLI
    `ExecBatch` path. The migration was applied with psql to an existing
    database, and spec 194's `20261109170000` has landed since. Main Claude has
    not run `npx supabase db reset` (see step 5 below).
  - M-1: add pre-checks for `current_user`, for the sequence and formatter not
    already existing, and for the version not already being recorded.
  - M-2: let the AC-16 post-check tolerate live traffic.
  - M-3 (optional): make the prod apply and the version insert atomic.
  - M-4: the spec 186 citation of `:38` is stale. The line is now `:70`.
  - M-5: add spec 194 to the D-9 ordering note.
  - M-6: put a header note about shared-database flakes in both test files.
  - Prod-apply answer: use MCP `execute_sql` plus a manual
    `schema_migrations` insert of `20261109140000`. Do NOT use
    `apply_migration`, which writes its own version and turns
    `db-migrations-applied.yml` red. `begin; … commit;` is safe on both the CLI
    and MCP paths.

No reviewer flagged a Critical. No CI gate has run on this change yet: nothing
is committed or pushed (main Claude).

## Recommended next steps (ordered)

### A. In-spec fixes (before commit and prod apply)

None of these changes the migration's SQL statements, the function bodies or
any pgTAP assertion. They are spec text, migration header comments and the
smoke script. Prod hasn't been touched, so editing comments in the migration
file is still safe. The normalized md5 covers function bodies only.

1. **Tighten the D-9 prod verification. Should-fix (architect S-1; security
   D-9 Lows #1-#3; architect M-1, M-2).** This comes first because it is the
   only prod-side proof of the D-4 SECURITY DEFINER posture, and the next prod
   step depends on it. Edit spec D-9 and the migration header pointer (lines
   57-66):
   - Replace the `anon=` / `authenticated=` string check with the six
     `has_function_privilege` / `has_sequence_privilege` calls from architect
     S-1 (all expected false). Optionally also assert that no ACL entry starts
     with `=`.
   - Add the DP-1 query to the prod checks: `purchase_orders` owner equals the
     function owner, or the owner has `rolbypassrls`. Also check that the
     sequence owner is `postgres`.
   - Add the M-1 read-only pre-checks:
     - `select current_user` (expect `postgres`);
     - `to_regclass` / `to_regprocedure` for the sequence and formatter (expect
       null);
     - no row in `schema_migrations` for `20261109140000`.
   - Reword AC-16 / D-9 per M-2:
     - expect `last_value = <pre-check max>` and `is_called = true`;
     - if `last_value` is higher, explain it by POs created after the apply;
     - always check `last_value + 1 >` the current numeric max.

     The header's literal "last_value 19 / is_called true" (line 63) should get
     the same qualifier.
   - Optional (M-3): put the `schema_migrations` insert before the final
     `commit;` in the text sent through `execute_sql`, so the body and its
     version row commit together.

2. **Harden the concurrency smoke. Should-fix (code-reviewer #1 and #2).**
   - In `scripts/smoke-po-number-concurrency.sh:100-105`, on `A_READY != 1`,
     print `a.out` and `exit 1`. Don't go on to B.
   - At `:86` and `:112-125`, either lengthen A's `pg_sleep` (for example to
     8 s) or time B directly and require B to finish well within A's sleep.

   Do #2 before #3 so the README entry describes the final script.

3. **Document the smoke. Should-fix (code-reviewer #3).** Add one line to the
   Track 3 section of `tests/README.md` saying:
   - it is manual-only;
   - it needs the local `supabase_db_imr-inventory` container (it uses
     `docker exec psql`, not curl);
   - it is not in `test:smoke`;
   - each run moves the local sequence up.

   Note: `package.json` already has an unrelated `test:smoke` edit in the
   working tree from another spec. Don't add this smoke to `test:smoke` here,
   and don't stage that `package.json` change as part of 190.

4. **Correct the facts in the spec text. Low (security).**
   - D-11 #4: replace "anon and authenticated have no TRUNCATE (spec 097)" with
     the real reason the reset vector is closed. `TRUNCATE … RESTART IDENTITY`
     needs ownership of the sequence, and no client surface exposes TRUNCATE.
     Point to the follow-up spec in part C. The sequence comment at migration
     `:186` makes no TRUNCATE-privilege claim and needs no change.
   - "Prod apply → Rollback" and D-10: add "safe only while every generated
     number is below 1000. Once any `PO-1000` or higher exists, the old
     `lpad(…, 3)` body collides on every insert, so rolling back would restore
     a permanent outage." Do the same in the migration header's ROLLBACK
     paragraph (lines 68-73).
   - D-9 ordering note: add spec 194 (`20261109170000`) as independent (M-5).

5. **Prove AC-14 on a fresh database before the prod apply. Should-fix
   (architect S-2). Not done; the owner schedules it.**
   - Main Claude has not run `npx supabase db reset`. The shared local database
     holds the applied state for in-flight specs 187, 189 and 194, and a reset
     would wipe it. Don't treat this as done.
   - Options, in order of preference:
     - (a) Once the 187/189/194 sessions are finished with the shared database,
       the owner runs `npx supabase db reset`, then the full
       `bash scripts/test-db.sh`, and records the result in the spec.
     - (b) Push the change to a branch or PR so `test.yml` boots a fresh stack.
       It exercises the CLI path from an empty table (`setval(1,false)`) and
       runs the whole pgTAP suite without touching main. Expect
       `db-migrations-applied` to fail on that PR until the prod apply; that is
       expected for a PR and is not a red main.
   - Avoid relying only on main's post-push `test.yml` as the clean-DB proof.
     The prod apply has to happen before the push (or the drift gate goes red),
     so a clean-DB failure found then would leave prod applied and main red.

6. **Nits, optional, batch them with #1-#4.**
   - Migration header line 44: drop `greatest` from the shadowing list.
   - Add a comment on why the formatter pins `search_path`.
   - Add the M-6 / code-reviewer shared-database flake note to both test
     headers.
   - Soften the malformed-guard "does NOT reset" comment (it can't discriminate
     on a fresh sequence; AC-5 covers it).
   - Split the combined anti-vacuity `ok()` checks.
   - Optionally make the `54000` hint generic or move it to `raise log`
     (security Low). This one edits the function body, so the md5 changes. Do
     it before the prod apply or not at all.

### B. Ship sequence after part A (owner-gated)

7. Re-run the two spec 190 pgTAP files and the hardened smoke after the edits.
   If a nit touched the function body, also re-apply the migration locally.
8. **The owner's explicit go-ahead (Q6)**, then the prod apply through Supabase
   MCP `execute_sql` on project `ebwnovzzkwhsdxkpyjka`:
   - run the tightened D-9 pre-checks;
   - apply the body;
   - insert the exact version `20261109140000` / `po_number_sequence` into
     `supabase_migrations.schema_migrations` (NOT `apply_migration`);
   - run the post-checks, including the AC-16 check with no PO inserted.
9. The owner commits only spec 190's files:
   - the migration;
   - the two pgTAP files;
   - the `report_run_variance_formula` comment edit;
   - the smoke script;
   - `tests/README.md`, if step 3 was done;
   - the spec.

   The index already holds other specs' staged files (188, 189 and others).
   Check `git diff --cached` before committing. Don't auto-commit.
10. After the push, confirm that the latest `main` runs of **both** `test.yml`
    and `db-migrations-applied.yml` are green. Also check `e2e.yml` by hand
    (project memory: it isn't in the gate checklist yet). If either required
    gate is red or still running, stop and surface the run URL.

### C. Follow-up specs (not blocking 190)

- **Server-assigned `po_number` guard.** From security Medium. A BEFORE
  INSERT OR UPDATE OF `po_number` trigger refuses non-NULL or changed values
  when `current_user in ('anon','authenticated')`, with the `P0001` error
  `'po_number is server-assigned'`. It closes the number-squatting and
  explicit-number race paths (D-7 residual). Check first that no client path
  sends an explicit `po_number`: spec 190 says none does today.
- **Revoke TRUNCATE from anon and authenticated on `public` tables.** From
  security Low; main Claude confirmed it affects 52 tables on prod. Add a pgTAP
  probe for future tables, since `public_grants_explicit.test.sql` doesn't
  cover TRUNCATE. It can't be reached through PostgREST today, so it is
  hygiene and not urgent.

## Out of scope for this review

- Security Medium (PO-number squatting through explicit `po_number`
  INSERT/UPDATE) and the TRUNCATE-grant hygiene: separate specs, as in part C.
- `supabase/tests/retention_prune_job.test.sql:259-262` stale workaround
  comment: belongs to spec 186's build. Clean it up when 186 is committed.
- `specs/186-retention-purge-server-job.md` lines 182, 355 and 727 cite
  `generate_po_number_malformed_guard.test.sql:38`. The delete is now at
  `:70`. Whoever next touches spec 186 should fix it (architect M-4).
- `src/utils/index.ts:114` `generatePONumber()` is dead code with the old
  3-digit shape and no importers. Put it on the cleanup backlog (architect,
  noticed-not-changed).
- Cross-brand PO volume signal from global numbering: the owner accepted it
  (Q1). Recorded for a future multi-tenant privacy review.
- Local `node_modules/@types/* 2` duplicate directories break the base
  `npm run typecheck` locally. Environment artefact, not CI.
- Four specs are numbered 190 (D-11 #8). Specs 193/194/195 appear to have been
  renumbered already. The PM should confirm nothing else still collides.
