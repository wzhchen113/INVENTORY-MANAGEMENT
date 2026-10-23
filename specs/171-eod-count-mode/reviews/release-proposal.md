## Verdict
verdict: FIXES_NEEDED
rationale: No code fixes remain (0 Critical and 0 open Should-fix across all four reviewers, 22/22 ACs PASS), but the hard rule blocks SHIP_READY until the prod md5 pre-check and prod migration apply (architect S1) are done and both CI gates are green on `main` after the push. None of that has happened yet.

**Code-side verdict: SHIP_READY, pending only the owner-gated deploy steps in section B below.** The only open items are deploy preconditions. No developer or reviewer needs to be dispatched again. Every remaining step is a prod or git action that needs the owner's approval.

## Findings summary

This round's inputs:
- `code-reviewer.md` and `test-engineer.md` were re-run after Review-fix round 1.
- `security-auditor.md` and `backend-architect.md` are from round 0. They are still valid, because round 1 changed no SQL, migration, RPC, or data-path code. The one `db.ts` change in round 1 is the comment at L467.

- **code-reviewer** (re-review): 0 Critical, 0 Should-fix, 3 new nits (preference only, no action asked), plus 1 out-of-scope owner-UX note.
  - **The round-0 Critical is closed.** `PhoneKeypadSheet` now takes an optional `countMode`. When it is omitted, the sheet falls back to the legacy `eodBoxesFor(item.caseQty)` layout and never reads `item.eodCountMode`.
    - `PhoneWeeklyCount.tsx` is unmodified and does not pass the prop.
    - `PhoneEodCount.tsx:468` passes the same effective mode that `seatedField` clamps against.
    - grep confirms `PhoneEodCount` and `PhoneWeeklyCount` are the sheet's only two consumers.
  - **All 3 Should-fix items are closed:**
    - `eodBoxesFor` and `clampActiveField` were extracted to `src/lib/eodKeypad.ts` and re-exported from the staff barrel.
    - `itemTotal` now uses `liveModeById`.
    - The drawer uses `DEFAULT_EOD_COUNT_MODE`.
  - **All 7 round-0 nits are closed.** That includes the `db.ts:467` comment.
  - **`SelectField` change checked:** `options` was widened to `ReadonlyArray`. This is type-only and safe for all 9 caller sites.
  - **New nits (no action):**
    - Hoist the inline `effectiveEodCountMode` at `PhoneEodCount.tsx:468` next to `seatedField`.
    - The optional `countMode` prop is a quiet default. Fine with two consumers; revisit if a third appears.
    - The weekly regression arms sit in `PhoneWeeklyCount.test.tsx`, which is the right place.
  - **Still open, out of scope:** a submitted `cases_only` item shows an empty, dimmed UNITS box in the locked view. This follows AC-20 and the D7 legacy layout.

- **security-auditor** (round 0, still valid): 0 Critical, 0 High, 0 Medium, 2 Low.
  - **Low 1, deploy ordering (availability).** If the client ships before the migration is in prod, three things fail:
    - the admin `fetchInventory` embed and the staff vendor fetch return 400 (unknown column);
    - `createInventoryItem` returns PGRST202.

    The fix is to apply the migration first, which is step 9 below.
  - **Low 2, informational.** `eod_count_mode` only restricts UI input. `staff_submit_eod` and `eod_entries` do not enforce it, by design.
  - **Verified:**
    - Exactly one 13-arg RPC overload exists. It is still SECURITY INVOKER with `search_path=public`.
    - The `revoke all … from public, anon` + `grant execute … to authenticated` pair is a deliberate tightening.
    - The CHECK constraint is correct, RLS is unchanged, the staff embed is safe, and `pwa-catalog` does not expose the column.

- **test-engineer** (re-verification): **22 PASS, 0 FAIL, 0 NOT TESTED.**
  - **AC-9 is now PASS at both the helper and component level** (it was FAIL at component level in round 0).
    - 6 new `PhoneWeeklyCount` arms cover `units_only` × 3 and `cases_only` × 3 on a caseQty-24 item.
    - Mutation check: making the sheet's default arm read `item.eodCountMode` fails exactly those 6 tests. The file was then restored, with no unstaged diff.
  - **Test runs:**
    - full `npx jest`: 240/240 suites, 2967/2967 tests;
    - `npm run typecheck`: exit 0;
    - `npm run typecheck:test`: exit 0;
    - `npm run test:db`: 89/89;
    - `scripts/smoke-staff-eod.sh`: all checks passed.
  - **Non-blocking gaps (unchanged):**
    - Staff "advance" has no dedicated test. The shared `clampActiveField` covers it and is now unit-tested directly.
    - The staff app has not been checked in a browser, because local `order_schedule` fixtures don't exist.
    - There is no native testing.
    - Realtime delivery of a mode change was verified by hand only.

- **backend-architect** (post-impl, round 0, still valid): **no contract drift.** 0 Critical, 1 Should-fix (S1), 5 Minor.
  - **S1, release-gating deploy precondition (not code).** Three steps must happen before the push:
    - run the prod normalized-md5 pre-check of `create_inventory_item_with_catalog`;
    - apply the migration via MCP;
    - insert the `schema_migrations` row.

    These are steps 8 and 9 below.
  - **M1:** closed in round 1 (`itemTotal` → `liveModeById`, confirmed by code-reviewer).
  - **M4:** folded into the step 9 post-apply verification (`proacl` including `service_role`).
  - **M2, M3, M5:** out of scope, listed below.

**Gate state:**
- Nothing is pushed.
- Migration `20261023000000_catalog_eod_count_mode` is **not** applied to prod (`ebwnovzzkwhsdxkpyjka`).
- The md5 pre-check has **not** been run.
- Neither `test.yml` nor `db-migrations-applied.yml` has run on this change.

## Recommended next steps (ordered)

### A. Code: nothing remaining
No further developer work is needed before deploy. The 3 new code-reviewer nits are optional, and doing them now would mean re-running full jest. I recommend shipping without them.

### B. Owner-gated deploy steps
Each prod action needs the owner's explicit "yes, apply it". Project memory notes that prod `execute_sql` is soft-blocked as a production deploy without that.

**7. Baseline check (read-only, before touching prod).**
- Confirm that the latest runs of `test.yml` and `db-migrations-applied.yml` on `main` (HEAD `c2ac211`) are green:
  - `gh run list --branch main --workflow test.yml --limit 1`
  - `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`
- Also check `e2e.yml` by hand (project memory: it is not yet promoted to the checklist).
- If any of them is already red, stop and surface the run URL. Otherwise a red result after the push can't be attributed to this change.
- Confirm via MCP that prod already has every earlier repo migration, including `20261022000000` (spec 170):
  ```sql
  select version from supabase_migrations.schema_migrations order by version desc limit 5;
  ```

**8. Prod md5 pre-check (architect S1; read-only on prod).**
- **(a) Check the prod shape via MCP `execute_sql`:**
  - Exactly one overload, and it is the 12-arg signature:
    ```sql
    select oid::regprocedure from pg_proc where proname = 'create_inventory_item_with_catalog';
    ```
    Expected: `(uuid,uuid,text,text,text,numeric,numeric,text,numeric,numeric,jsonb,jsonb)`.
  - The column is not there yet. This query should return 0 rows:
    ```sql
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'catalog_ingredients' and column_name = 'eod_count_mode';
    ```
- **(b) Compute prod's normalized md5:**
  ```sql
  select md5(lower(regexp_replace(regexp_replace(
    pg_get_functiondef('public.create_inventory_item_with_catalog(uuid,uuid,text,text,text,numeric,numeric,text,numeric,numeric,jsonb,jsonb)'::regprocedure),
    '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));
  ```
- **(c) Compute the reference md5 locally.**
  - The local stack already has the 13-arg version, so the 12-arg reference has to be rebuilt in a throwaway transaction.
  - In `docker exec -it supabase_db_imr-inventory psql -U postgres`:
    1. `begin;`
    2. Paste the 12-arg `create or replace function public.create_inventory_item_with_catalog(...)` statement from `supabase/migrations/20260517000000_user_data_i18n_names.sql`, verbatim.
    3. Run the same md5 query as (b).
    4. `rollback;`
- **(d) Compare.** If the two md5s are equal, proceed to step 9. **If they differ, STOP.** The drop-and-recreate would overwrite undeclared prod drift. Diff the two `pg_get_functiondef` outputs and escalate to backend-architect before applying anything.

**9. Prod apply via Supabase MCP (owner-approved), BEFORE any push (D8).**
- **(a) Apply the migration.**
  - `execute_sql` the full contents of `supabase/migrations/20261023000000_catalog_eod_count_mode.sql`, verbatim, comments included. Stripped comments break the md5 comparison (project-memory trap).
  - Do **not** use `apply_migration`: it stamps the current timestamp, which would turn the drift gate red.
- **(b) Record the version:**
  ```sql
  insert into supabase_migrations.schema_migrations (version, name)
  values ('20261023000000', 'catalog_eod_count_mode')
  on conflict (version) do nothing;
  ```
  Then confirm the row exists with `select version from supabase_migrations.schema_migrations where version = '20261023000000';`.
- **(c) Post-apply verification** (prod via MCP, and local docker where a comparison is needed):
  1. **Column.** In `information_schema.columns`, `eod_count_mode` should show `data_type = 'text'`, `is_nullable = 'NO'`, and `column_default = '''cases_and_units''::text'`.
  2. **Constraint.** `pg_get_constraintdef` of `catalog_ingredients_eod_count_mode_check` should admit exactly the three literals.
  3. **Backfill.** `select eod_count_mode, count(*) from public.catalog_ingredients group by 1;` should return a single `cases_and_units` row and no NULLs.
  4. **Overload.** `select oid::regprocedure, prosecdef, proconfig, proacl from pg_proc where proname = 'create_inventory_item_with_catalog';` should return exactly **one** row:
     - the 13-arg signature ending in `jsonb,jsonb,text`;
     - `prosecdef = false`;
     - `proconfig = {search_path=public}`.
  5. **ACL (architect M4).** `proacl` should contain `authenticated=X` and `service_role=X`, with no `anon` entry and no bare `=X` (PUBLIC) entry.
     - Also check that `has_function_privilege('anon', '<13-arg>'::regprocedure, 'execute')` is false and `has_function_privilege('authenticated', …)` is true.
     - Project memory notes that the revoke was once silently ineffective, so this check matters.
  6. **Function fidelity.** Compute the normalized md5 of the 13-arg `pg_get_functiondef` on prod (MCP) and on local (docker). They must be equal. If they differ, re-run the `create or replace` with the verbatim body.
  7. **PostgREST cache.** If a PGRST202 mentioning `p_eod_count_mode` appears afterwards, run `notify pgrst, 'reload schema';` once.

**10. Stage and commit (the owner runs `git commit`; per project memory, agents stage but never commit).**
- **Include:**
  - The 30 already-staged implementation and test paths listed in the spec's `## Files changed`. That covers the migration, the pgTAP file, `src/lib/eodCountMode.ts` and `src/lib/eodKeypad.ts` with their tests, `db.ts`, `types/index.ts`, the admin desktop/phone/staff surfaces and their tests, `IngredientForm`/`Drawer` with their tests, `SelectField.tsx`, the staff `eodKeypad.ts` barrel, and `PhoneWeeklyCount.test.tsx`.
  - The spec, `specs/171-eod-count-mode.md`, re-added so the Review-fix round 1 section is included.
  - **The reviews directory** `specs/171-eod-count-mode/reviews/`, which has 5 files: `code-reviewer.md`, `security-auditor.md`, `test-engineer.md`, `backend-architect.md`, and this `release-proposal.md`.
  - Command: `git add specs/171-eod-count-mode.md specs/171-eod-count-mode/`
- **Exclude:** `specs/172-eod-no-need.md`. It is unrelated, has not been reviewed, and must stay untracked. Do not use `git add -A`, `git add .`, or `git add specs/`.
- **Before committing, check `git status`:**
  - there are no unstaged (` M` / `MM`) entries;
  - `?? specs/172-eod-no-need.md` is the only untracked path.
- If any source file changed after test-engineer's run, re-run the full `npx jest`, `npm run typecheck`, and `npm run typecheck:test` first.

**11. Push to `main`,** only after steps 8 and 9 have fully succeeded. Pushing first triggers a race where `db-migrations-applied` runs before the `schema_migrations` row exists and reports a false red (project memory, spec 121). Vercel then deploys the web client after the DB, as D8 requires.

**12. Post-push gate check (CLAUDE.md hard rule).**
- Run:
  - `gh run list --branch main --workflow test.yml --limit 1`
  - `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`
- Both must finish green. Also check `e2e.yml` by hand.
- If any run is red or still in progress, surface the run URL and wait for the owner. Do not continue pipeline work.
- If only `db-migrations-applied` is red:
  - First diff the repo's migrations against prod's `schema_migrations`. Per project memory, a red gate does not always mean drift; the CLI is pinned at 2.108.0.
  - If the version is present and this was the ordering race, run `gh run rerun <run_id>`.
- **SHIP_READY is reached only when both gates are green.**

**13. Optional post-deploy smoke on prod web (recommended).**
- Load the admin Inventory and EOD sections and confirm there are no 400s on the `catalog:` embed.
- Open the ingredient drawer on an item with case size > 1 and confirm the "EOD count" control renders.
- Leave every mode at `cases_and_units` unless the owner wants to set real values.

## Out of scope for this review
- **Server-side enforcement of `eod_count_mode`** in `staff_submit_eod` and `eod_entries` (security Low 2; the spec lists it as out of scope). Make it a follow-up spec if the owner wants it.
- **OQ-B / R5:** `updateInventoryItem` swallows the error from the `catalog_ingredients` update (`db.ts:492-499`) for every catalog field. A failed mode write therefore looks like an optimistic success. Needs a separate spec.
- **Architect M2:** the drawer always sends every catalog field, so saves are last-writer-wins on brand-wide fields. This belongs with OQ-B as a "send only dirty catalog fields" pass.
- **Spec-102 arm (b) residual** (§10.4, architect M5). The sequence is:
  1. save a draft with a cases value;
  2. the mode flips (via realtime);
  3. submit in the same session.

  The gate passes but the item is dropped. Making arm (b) mode-aware would change spec 102's cross-tab semantics.
- **Count export** still ignores the mode (owner decision 3).
- **Locked `cases_only` layout:** the empty, dimmed UNITS box in the read-only view follows AC-20, but the owner may want to look at it as a UX question (code-reviewer).
- **Architect M3:** add a `scripts/smoke-staff-eod.sh` arm that selects `eod_count_mode` through the real PostgREST embed.
- **Coverage gaps:**
  - staff app browser check (needs local `order_schedule` fixtures);
  - native testing;
  - a dedicated test for staff "advance" (AC-8);
  - an automated realtime mode-change probe.
- **Pre-existing, not from spec 171:**
  - TRUNCATE grants to anon and authenticated on `catalog_ingredients` (from the CLI image);
  - the spec-113 "ungated cost writer" finding on `create_inventory_item_with_catalog`.
- **`specs/172-eod-no-need.md`:** a separate, unreviewed spec. It is not part of this release.
