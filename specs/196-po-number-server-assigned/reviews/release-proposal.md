# Release proposal: spec 196 (po-number-server-assigned)

Written by release-coordinator, 2026-11-09. This is advisory; the owner decides.
Sources: the spec (requirements, ACs, Backend design D-1 to D-15, Implementation
notes, Files changed), all four reviewer files in this folder (read directly),
spec 190's and spec 194's release proposals and spec 190's "Fix round 1" notes
(for the dependency state), and a grep of the migration header for the lock-level
wording. Facts supplied by main Claude are marked "(main Claude)". The spec's
`Status:` was not changed.

## Verdict
verdict: SHIP_READY
rationale: No reviewer found a Critical, High, Medium or contract drift, 19 of 19 local ACs pass, and both required gates are green at their latest `main` run, so spec 196's own files need no change. Shipping still depends on order: spec 190 has to reach prod first, and the AC-16 working-tree hunk has to be in the same commit as the 196 migration.

Read this as "SHIP_READY for spec 196's content, gated on order". Spec 196 has
no code or test fix to make. It can't go out on its own, though. It needs spec
190's trigger and formatter (the migration's dependency `DO` block refuses to
apply without them), and the push needs every migration in the pushed tree to
be on prod. Nothing below asks for a change to the migration's SQL or to any
pgTAP assertion.

Gate facts (main Claude, latest runs on `main`, 2026-11-10T03:36Z, commit
`15aefc4`):
- `test.yml`: success, run 42750558373
- `db-migrations-applied.yml`: success, run 42750558466
- Both runs are on `15aefc4` (spec 186) and **don't include** this spec, spec
  190, 194 or 195. So the SHIP_READY hard rule is met (the latest run of each
  gate is green), but CI hasn't checked this change yet. AC-22 stays open until
  the post-push runs.
- The owner hasn't approved a commit or a prod apply yet.

## Findings summary
- **code-reviewer:** 0 Critical, 0 Should-fix, 6 Nits.
  - The migration matches D-2/D-3 statement for statement. `plan(68)` was
    recounted and matches. Every refusal is pinned by SQLSTATE and message,
    every allowed UPDATE by `ok:1`, and every read-back runs as postgres.
  - Nits:
    1. `try_sql` arms hard-code fixture uuid literals instead of using
       `pg_temp.pid(n)`.
    2. The AC-12 `jwt` / `auth.` regexes also scan comments inside `prosrc`.
    3. The AC-5 stash assumes a single session (no concurrent `nextval`).
    4. The fail-closed "bad trigger wiring" branch has no test arm.
    5. `drop trigger if exists` takes ACCESS EXCLUSIVE, but spec D-2 item 2 and
       D-13 #6 call it SHARE ROW EXCLUSIVE. This is wording only. The migration
       header makes no lock-level claim (checked).
    6. The test header's block index skips block B.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 2 Low, 2 informational.
  - The spec 190 Medium (clients squatting on explicit PO numbers) is closed.
    Every path was enumerated and found closed or out of reach: PostgREST
    insert, bulk insert, PATCH and upsert; DEFINER and INVOKER writers;
    views, rules and inheritance; pg_graphql; realtime; edge functions; client
    code; role escalation (`authenticator` grants, `session_replication_role`,
    `pg_parameter_acl`, the custom access-token hook); and column collation.
  - Low #1: the accepted DEFINER residual has been checked only against the
    repo and local, not prod. D-11 has no prod check for a DEFINER function,
    view or rule that writes `purchase_orders`, and prod has had dashboard
    drift before. The auditor gives a read-only query to add to D-11 step 1.
  - Low #2 (spec 190 object, not introduced here): `anon`, or a storeless
    `authenticated` user, can advance the global sequence. `set_po_number`
    calls `nextval()` before RLS `WITH CHECK` refuses the row. The impact is
    cosmetic (gaps only, never `54000`). Possible follow-up: revoke
    INSERT/UPDATE/DELETE on `purchase_orders` from `anon`.
  - `npm audit` baseline: 46 advisories, all pre-existing or transitive, none
    from 196.
- **test-engineer:** 19 PASS (AC-1 to AC-19), 0 FAIL, 3 NOT TESTED (AC-20 to
  AC-22: prod apply, prod verify and CI after push, all owner-gated).
  - The full pgTAP suite was re-run: 103/103 files pass.
  - Two AC-19 mutations were spot-checked (trigger dropped: 20 failures; no-op
    body: 15). The other four come from the developer's record.
  - jest and typecheck:test were not re-run. The developer reported 301
    suites / 3836 tests and a clean `typecheck:test`, and no TypeScript
    changed.
  - Gaps, none blocking: no runtime `anon` arm (by design, spec 067) and no
    wiring-branch arm.
- **backend-architect (post-impl):** 0 Critical, no contract drift, 1
  Should-fix, 4 Minor. The handoff line says "6 findings", but the body lists
  5. Treated as 5.
  - **SF-1 (staging hazard, not a code defect):**
    `supabase/tests/report_run_variance_formula.test.sql` is `MM`. The index
    holds spec 190's comment edit. The spec 196 fixture edit is unstaged on
    top. If the 196 migration is committed without the working-tree version,
    that file fails at its PO insert and `test.yml` goes red. The reverse is
    safe: the 196 hunk also passes under 190 alone.
  - M-1: the AC-14 literal-compare arm compares two constants and can't fail.
    The real protection is the first-BEFORE-INSERT arm.
  - M-2: the AC-6 P8 read-back pins `total_cost`'s scale (`'42.00/true'`).
  - M-3: block C has no explicit staff anti-vacuity arm. The AC-5 and AC-6
    staff successes already prove visibility.
  - M-4: same point as code-reviewer nit 2. It fails in the safe direction and
    is acceptable.
  - The AC-19 failure counts were re-derived and match the arm list.

## Recommended next steps (ordered)

Every step below needs the owner's explicit go-ahead where marked. Per project
memory, Claude stages and reports, and never runs `git commit` or a prod write
without the owner's word.

### A. Before prod apply (no code change)

1. **Finish spec 190's remaining pre-apply item first (inherited, spec 190
   architect S-2).** Spec 190's fix round 1 has landed (spec 190 "Fix round 1"
   notes). Its one open pre-apply item is the fresh-database proof of AC-14.
   Spec 196 was also applied with `psql` to the running shared stack, so one
   fresh replay should cover 190, 194, 195 and 196 together. Either:
   - (a) run `npx supabase db reset` and then `bash scripts/test-db.sh`, once
     the other sessions are done with the shared database; or
   - (b) push the stack to a branch or PR so `test.yml` boots a fresh database.
     `db-migrations-applied` failing on that PR before the prod apply is
     expected there.

   Record the result in spec 190 and in this spec. This comes first because the
   prod apply has to happen before the `main` push, so a fresh-database failure
   found only after the push would leave prod applied and `main` red.
2. **Add security Low #1's read-only pre-check to the prod run (Low; do it
   now).** Run the auditor's two queries (DEFINER functions whose body mentions
   `purchase_orders` and `po_number`, and the count of views or rewrite rules on
   `purchase_orders`) on prod as part of D-11 step 1. STOP if any DEFINER row
   other than `generate_po_number` has `writes_po_number = t`, or if the
   view/rule count is non-zero. The cheapest option is to paste them into D-11
   step 1 of the spec. Running them in the apply session works too. This is
   recommended now because it is the only prod-side proof that the
   owner-accepted residual is empty, and it costs two read-only queries.
3. **(Optional, spec text only) Correct the lock-level wording** in D-2 item 2
   and D-13 #6, from SHARE ROW EXCLUSIVE to ACCESS EXCLUSIVE (code-reviewer
   nit 5). Then whoever runs the apply knows that reads on `purchase_orders`
   are blocked too during the short, `lock_timeout`-bounded window. The
   migration file needs no change.

### B. Staging and commit (owner-gated)

4. **Stage set for spec 196 (SF-1 is required here):**
   - `supabase/migrations/20261109200000_po_number_server_assigned.sql`
   - `supabase/tests/po_number_server_assigned.test.sql`
   - `supabase/tests/report_run_variance_formula.test.sql`, the **working-tree
     version**: run `git add` on the whole file, which folds the 196 hunk into
     the index on top of spec 190's staged comment hunk
   - `specs/196-po-number-server-assigned.md` and
     `specs/196-po-number-server-assigned/reviews/`

   Leave out other sessions' dirty paths. Check `git diff --cached` before
   committing. The index already holds staged files from specs 188, 189, 190
   and 194.
5. **Commit grouping with spec 190.** Two shapes are acceptable:
   - **Preferred: two consecutive commits in one push.** Spec 190's commit
     first: its migration, its two pgTAP files, the smoke script,
     `tests/README.md`, its spec and its reviews. Then the 196 commit. Spec
     190's commit may carry either version of the variance file, but the 196
     commit must contain the final working-tree version. The simplest route is
     to `git add` the full file in 190's commit, which is safe because the 196
     hunk passes under 190.
   - **Alternative: one combined 190+196 commit.**

   In both cases, never put the 196 migration in a commit whose tree has the
   old variance file. Push 190 and 196 together, not 196 alone.

### C. Prod apply (owner-gated, Supabase MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`)

6. **Spec 190 first.** Follow its D-9 runbook in full: pre-checks, apply, the
   `20261109140000` version row (not `apply_migration`), and its post-checks,
   including the `last_value` check. Run it as a separate `execute_sql` call
   from 196's. Finish 190's verification before step 8 (196 D-11 step 0).
7. **The other on-disk migrations that will be in the pushed tree.** Spec 194's
   `20261109170000_kept_records_delete_hardening.sql` is already staged, so a
   plain commit from the current index carries it. It also needs its own
   AC-34/AC-35 runbook (spec 194 proposal items 6-8). `20261109195000` is on
   disk too (main Claude listed it under spec 194; it is
   `user_stores_drop_own_row_writes.sql`, which the specs folder attributes to
   spec 195). The rule is general: **every migration file in the pushed tree
   must be in prod `schema_migrations` before the push**, or the drift gate goes
   red. Before pushing, diff the repo's `supabase/migrations/` against prod's
   `schema_migrations`. Other files on disk to check are `20261109120000`
   (spec 189), `20261109191000` and `20261108130000`. Neither 194 nor 195 is a
   functional dependency of 196, so their order relative to 196 doesn't matter.
   Only "on prod before push" matters.
8. **Spec 196 apply (D-11).**
   - Step 0: confirm `20261109140000` is present and `20261109200000` is
     absent.
   - Step 1: the read-only pre-checks, plus the Low #1 queries from item 2.
   - Step 2: send the committed migration file **verbatim** in one
     `execute_sql` call. Don't send a `pg_get_functiondef` dump or use
     `apply_migration`. Retry on `55P03`.
   - Step 3: insert `('20261109200000', 'po_number_server_assigned', '{}')`
     into `supabase_migrations.schema_migrations`. Optionally put it before the
     final `commit;` in the text sent.
   - Step 4 (AC-21): the normalized md5 must equal local
     `f64474e39f32bb6b2a8c90995295b9eb`. Also check `prosecdef f`, `proconfig
     {search_path=public}`, owner `postgres`, and a non-NULL `proacl` with no
     `anon=`, `authenticated=` or `=` entry. `has_function_privilege` must be
     false for `public`, `anon` and `authenticated`. The trigger listing must
     match local. AC-15 must hold on prod. Insert and update no PO.

### D. Push and CI (owner-gated)

9. **Push only after steps 6-8 are confirmed**, plus any step 7 migrations in
   the tree. Then confirm that the latest `main` runs of **both** `test.yml`
   and `db-migrations-applied.yml` are green (AC-22), and check `e2e.yml` by
   hand. If either required gate is red or still running, surface the run URL
   and stop.

### E. Low and nit items: fix now or leave

- **Fix now:** security Low #1 (item 2). It is a read-only prod check that
  needs no code edit.
- **Optional now, cheap:** the lock-wording correction (item 3). If the test
  file is touched for any other reason before commit, the AC-5 single-session
  comment (code-reviewer nit 3) and architect M-2's scale-proof
  `(total_cost = 42)` read-back can go in the same edit. Either one means
  re-running `bash scripts/test-db.sh supabase/tests/po_number_server_assigned.test.sql`.
  Neither changes the migration or the prod md5.
- **Leave:**
  - code-reviewer nits 1, 2, 4 and 6;
  - architect M-1, M-3 and M-4.

  They are low-risk, the read-backs already catch them, or they fail in the
  safe direction.
- **Separate follow-up:** security Low #2 (anon can advance the sequence). See
  below.

## Out of scope for this review
- **Security Low #2: unauthenticated or storeless callers can advance the
  global PO sequence** through `set_po_number`'s `nextval()` before RLS
  `WITH CHECK`. This is spec 190's object, and the impact is cosmetic. The
  candidate fix (revoke INSERT/UPDATE/DELETE on `purchase_orders` from `anon`)
  belongs with the other spec 190 Low items. It might also fit the TRUNCATE
  revoke work in `specs/197-revoke-client-truncate.md`, if that spec widens to
  `anon` write grants.
- **Spec 190 audit Lows** (the `54000` hint text, the cross-brand volume
  signal, the TRUNCATE grant, rollback above PO-1000). Excluded by this spec's
  out-of-scope list.
- **D-14 "noticed, not changed":** spec 190 D-4 point 6 is stale once 196
  lands. The `retention_prune_job.test.sql:259` INVOKER comment is stale (spec
  190/186 cleanup). The AC-12 "anon has no policy" wording was corrected in D-5.
- **Closing the SECURITY DEFINER RPC route.** The owner accepted it. Any future
  DEFINER RPC that writes `po_number` must be reviewed against this rule.
- **Pre-existing `npm audit` advisories** (46, including 1 critical
  `shell-quote`). None is attributable to 196, and dependency hygiene is a
  separate pass.
