## Test report for spec 022

### Acceptance criteria status

#### Track 1 — jest-expo

- AC1-1: `package.json` declares `jest-expo`, `@testing-library/react-native`, `@testing-library/jest-native`, `@types/jest`, `react-test-renderer`, and `@types/react-test-renderer` under `devDependencies` → PASS — all present at the pinned majors from the architect's table (jest-expo ~54.0.0, @testing-library/react-native ^13.0.0, @testing-library/jest-native ^5.4.3, @types/jest ^29.5.12, react-test-renderer 19.1.0). Note: `jest-expo` carries `jest` as a peer; the explicit `jest ^29.7.0` devDep confirms pinning.

- AC1-2: `package.json` `scripts.test` runs the unit test suite and exits non-zero on failure → PASS — `"test": "jest"`. CI call uses `npm test -- --ci` which adds the `--ci` flag (fail-on-missing-snapshot, deterministic output). Verified: `npm test -- --ci` exits 0, 14 tests pass.

- AC1-3: `jest.config.js` exists with Expo preset, `testEnvironment` split, `transformIgnorePatterns`, and `moduleNameMapper` for `@/*` → PASS — projects split (unit/node, component/jsdom), `jest-expo` preset, architect's `RN_TRANSPILE_DEPS` allow-list, `'^@/(.*)$': '<rootDir>/src/$1'`. Developer added `react-native-worklets` to the allow-list (not in the architect's prescribed list) — correct forward-compat addition, not a deviation.

- AC1-4: One unit test exists and passes covering a pure function from `src/utils/` → PASS — `src/utils/relativeTime.test.ts` (9 assertions, all pass). Note: architect picked `relativeTime` over the spec's suggested `convertToItemUnit`; the spec explicitly deferred `convertToItemUnit` to the follow-up coverage spec. This is correct per the spec's Q4 resolution.

- AC1-5: One component test exists and passes covering a leaf component from `src/components/cmd/` → PASS — `src/components/cmd/StatusPill.test.tsx` (5 assertions, all pass). The hybrid-mocking demonstration is realized as documentation in `tests/README.md` (the "Transitive store-import gotcha" section) per the architect-sanctioned fallback (spec §11.5). The AC text permits "the pattern demonstrated by documentation rather than a passing component test" in this case; the README includes a working code sample. The StatusPill test itself mocks at `../../theme/colors`, not at `db.ts`, because StatusPill does not call `db.ts` directly — this is correctly explained in both the test file's comment and the README.

- AC1-6: `tsconfig.json` or `tsconfig.test.json` recognises test files so `tsc --noEmit` does not error on them → PASS (with caveat) — `tsconfig.test.json` exists, extends the base, includes `src/**/*.test.ts(x)` and `tests/**/*.ts`. `tsconfig.json` adds `"exclude": ["**/*.test.ts", "**/*.test.tsx", "tests/**/*"]` so Expo's bundler does not graph-walk test files. `typecheck:test` fails on pre-existing errors in `src/store/useStore.ts` and `src/lib/webPush.ts` — verified these errors also appear on plain `npx tsc --noEmit` (present on `main` before spec 022 touched anything). The spec and the architect (§3) explicitly say `typecheck:test` is not a CI gate in v1. Pre-existing errors are not a regression from this spec.

- AC1-7: Tests run on a clean clone via `npm ci && npm test` with no extra steps → PASS (by design) — Track 1 requires no docker, no env vars. Jest passes with the default stub setup and no `.env`. Verified locally.

- AC1-8: `tests/README.md` documents hybrid mocking strategy, file layouts, per-track run commands → PASS — `tests/README.md` is comprehensive: three-track table, TL;DR run commands, full hybrid-mocking strategy section, "Transitive store-import gotcha", per-track how-to-add and when-not-to-add sections, `transformIgnorePatterns` troubleshooting, pgTAP divergence note, Track 3 troubleshooting with CLAUDE.md bind-mount gotcha verbatim, CI section, follow-up coverage targets table.

#### Track 2 — Supabase DB tests

- AC2-1: `supabase/tests/` exists with at least two `.sql` test files → PASS — `report_run_cogs.test.sql` (5 assertions) and `inventory_counts_set_submitted_by.test.sql` (3 assertions).

- AC2-2: One RPC test → PASS — `report_run_cogs.test.sql` exercises `public.report_run_cogs(uuid, jsonb)`. Auth gate (42501 for foreign store) and envelope shape (kpis/columns/rows/series) both pass.

- AC2-3: One RLS smoke test → PASS — `inventory_counts_set_submitted_by.test.sql` exercises the BEFORE INSERT/UPDATE trigger that closes the attribution-forgery vector. Trigger override assertion and defense-in-depth assertion both pass.

- AC2-4: `package.json` `scripts.test:db` runs DB tests and exits non-zero on failure → PASS — `"test:db": "bash scripts/test-db.sh"`. Verified: 2/2 files pass locally.

- AC2-5: DB tests run hermetically → PASS — each `.sql` file owns its own `begin; ... rollback;` transaction. The seed substrate is untouched. `plan(N)` framing enforces assertion count. `on commit drop` temp tables are belt-and-suspenders inside the rollback.

- AC2-6: DB tests require no production secret → PASS — tests use only the local Supabase stack. Seed UUIDs (22222222..., 33333333...) are local-only stable constants. Stores looked up by name, not hardcoded UUID.

- AC2-7: `tests/README.md` documents how to add a new DB test and preconditions → PASS — dedicated "How to add a new DB test", "When NOT to add a DB test", "Running", and "Risks" subsections in the Track 2 section.

#### Track 3 — Shell smoke scripts

- AC3-1: `scripts/smoke-rpc.sh` exists, follows `smoke-edge.sh` shape, non-zero exit on first failure, one example check → PASS — three PASS/FAIL checks: login, HTTP 200, envelope keys. Non-zero exit on any failure. Sectioned PASS/FAIL/SKIP output matches `smoke-edge.sh`.

- AC3-2: `package.json` `scripts.smoke` runs both smoke scripts → FAIL (minor naming deviation) — the script is named `"test:smoke"` not `"smoke"`. The spec AC literally says `scripts.smoke`. Functionally equivalent; both scripts are run in sequence and exit propagates correctly. This is a naming mismatch against the AC, not a behavioral gap.

- AC3-3: Script runs against local (default) or remote via `SUPABASE_URL=` override → PASS — `SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"` default. Also accepts `ADMIN_TOKEN=` to skip the login round-trip for remote calls.

- AC3-4: `tests/README.md` references CLAUDE.md bind-mount gotcha → PASS — Track 3 troubleshooting section copies the CLAUDE.md note verbatim and adds the realtime gotcha pointer.

#### CI

- AC4-1: `.github/workflows/test.yml` exists, runs on every push and PR, has `jest` job and `db` job → PASS — both triggers (`push`, `pull_request`), both jobs present. `jest` job: checkout, node@20, `npm ci`, `npm test -- --ci`. `db` job: checkout, `supabase/setup-cli@v1`, `supabase start`, `npm run test:db`, `supabase stop --no-backup` (always).

- AC4-2: `jest` job runs Track 1, exits non-zero on failure → PASS — `npm test -- --ci` propagates exit code.

- AC4-3: `db` job boots local Supabase stack and runs Track 2 → PASS — `supabase/setup-cli@v1` + `supabase start` + `npm run test:db`. Full stack required because tests use `auth.uid()` via JWT-claim injection; a bare Postgres service container would not expose `auth.*`. Architect correctly rejected the service-container alternative (spec §6).

- AC4-4: Workflow replaces or supersedes the `db-migrations-applied.yml` reference → PARTIAL — spec AC says "the stale README reference is either updated to point at the new file or removed". The developer noted this was deferred by a user instruction at PR time. README still has the stale reference. Not strictly a test-track failure (the workflow file exists and runs), but the documentation cleanup remains pending. Calling this NOT TESTED for the documentation sub-criterion specifically.

- AC4-5: No `timeout-minutes` on CI jobs → noted by code-reviewer as a should-fix. `db` job in particular could block a CI slot for up to 6 hours if `supabase start` hangs. Agreed this is a should-fix but it does not constitute a broken acceptance criterion.

- AC4-6: Push caveat (workflow-scoped token issue) → acknowledged — file is committed locally, user pushes manually if token issue persists. Spec AC explicitly allows this path. Flagged as a known caveat.

#### Documentation

- AC5-1: `tests/README.md` documents hybrid mocking strategy → PASS (same as AC1-8 above).
- AC5-2: Where each kind of test lives → PASS.
- AC5-3: How to run each track locally → PASS.
- AC5-4: How CI runs each track → PASS.
- AC5-5: Five Criticals from specs 016/018/019/020/021 listed as first follow-up targets → PASS — "First follow-up coverage targets" section with a table mapping each spec number to a concrete DB test target.

---

### Test run

#### Track 1 (jest)

```
$ npm test -- --ci
PASS component src/components/cmd/StatusPill.test.tsx
PASS unit src/utils/relativeTime.test.ts
Test Suites: 2 passed, 2 total
Tests:       14 passed, 14 total
Time:        0.488 s, estimated 1 s
```

14/14 PASS. Both projects (unit/node, component/jsdom) green.

#### Track 2 (DB tests)

```
$ npm run test:db
== supabase/tests/inventory_counts_set_submitted_by.test.sql ==
  PASS supabase/tests/inventory_counts_set_submitted_by.test.sql (3 assertion(s) passed)
== supabase/tests/report_run_cogs.test.sql ==
  PASS supabase/tests/report_run_cogs.test.sql (5 assertion(s) passed)
✓ 2/2 DB test file(s) passed
```

8 total pgTAP assertions across 2 files. All pass.

#### Track 3 (shell smokes)

```
$ npm run test:smoke
== CORS preflight ==
  PASS OPTIONS returns 200
  PASS has access-control-allow-origin
  PASS allows POST
  PASS allows authorization header
== POST without Authorization header ==
  PASS no-auth POST returns 401
  SKIP unmapped-store check (reason: no BOBBY_TOKEN)
  SKIP valid-POST check (reason: no BOBBY_TOKEN)
✓ all checks passed

== login as admin@local.test ==
  PASS got admin access_token (762 chars)
== report_run(template=stub) against http://127.0.0.1:54321 ==
  PASS POST /rpc/report_run returns 200
  PASS response has kpis/columns/rows/series
  PASS stub envelope.columns has 2 entries
✓ all checks passed
```

All checks green (2 SKIP in smoke-edge.sh are pre-existing, require BOBBY_TOKEN, not new).

#### Developer experience probe

Ad-hoc test file written at `src/utils/relativeTime.devexp.test.ts` (immediately deleted after the run — not committed) to validate the iteration loop:

```
$ npm test -- --ci --testPathPattern="relativeTime.devexp"
PASS unit src/utils/relativeTime.devexp.test.ts
Tests: 1 passed
Time: 0.303 s
```

From blank file to green test: under 3 minutes including reading the existing test to understand the fake-timer pattern. The iteration loop is fast — jest picks up new files in the existing project automatically, no config changes needed.

---

### Verdict

**APPROVE with two follow-ups queued for spec 023.**

All three tracks run green locally. The framework realization matches the standing recommendation faithfully. The specific findings below are all non-blocking on ship.

---

### Does it match the standing recommendation?

Yes, with high fidelity. The standing recommendation since spec 016 has been three tracks:

1. jest-expo for JS/TS unit + component tests.
2. Supabase DB / pgTAP-style tests against a real local stack.
3. Shell smokes for edge-function / RPC end-to-end.

All three shipped. The version pinning is exact (jest 29 + jest-expo 54 for Expo SDK 54 + React 19 compatibility). The hybrid-mocking strategy (mock at `db.ts` boundary for jest; real Postgres for DB tests) is clearly documented and correctly enforced. The `begin; ... rollback;` hermetic isolation pattern is in place. The CI shape (Track 1 + Track 2 automated; Track 3 manual) is what was asked for.

### Will future specs benefit from this?

Yes. The specific items I have been marking NOT TESTED on prior reviews can now flip to PASS or FAIL:

- RLS policy correctness (specs 019, 020, 021) — DB test pattern is demonstrated; a new `.test.sql` file is the only addition needed.
- Trigger correctness (spec 019 round-2) — `inventory_counts_set_submitted_by.test.sql` is the template.
- RPC contract shape (spec 016, 017, 018) — `report_run_cogs.test.sql` is the template.
- JS-layer helpers in `src/lib/db.ts` — `relativeTime.test.ts` demonstrates the unit pattern; `db.ts` mapper functions are next.

One week from now reviewing spec 023, I would be able to write and run Track 2 assertions instead of marking them NOT TESTED.

### Are the example tests instructive?

**`relativeTime.test.ts`**: Yes, strong template. Demonstrates fake timer setup/teardown via `jest.useFakeTimers()` / `jest.setSystemTime()` and the important nuance that `date-fns` strict mode rounds 90s to "2 minutes" (not "1 minute"). The developer locked actual behavior rather than assumed behavior — exactly right.

**`StatusPill.test.tsx`**: Yes, with one important clarification for future authors. The test mocks at `../../theme/colors` rather than at `db.ts` — this is the correct cut point *for this component* because StatusPill does not call `db.ts` directly. Future authors might read this and think "mock the theme module" is the general pattern. The README's "Transitive store-import gotcha" section addresses this directly and is well-written. The key is that the mock path is determined by where the import chain hits an unresolvable dep (`supabase.ts` without `EXPO_PUBLIC_SUPABASE_URL`), not by a fixed rule. This is subtle but the README explains it correctly.

The architect's §11.5 fallback (hybrid-mock demo via documentation instead of a wired test) is the right call here given the CLAUDE.md prohibition on refactoring `useStore.ts`. The README sample code is clear and complete.

**`report_run_cogs.test.sql`**: Yes, strong template. The fixture pattern (`do $$ begin ... perform set_config('test.key', ..., true); end $$;`) is the right shape for multi-step fixture setup. The auth-gate `throws_ok()` and envelope `is(array_agg(...), ...)` patterns cover the two most common DB test assertions. The `create temp table on commit drop as` temp-table pattern for reading RPC output into assertions is a useful idiom. One note: the `throws_ok()` call passes `null` as the message-pattern argument — this means any error message is accepted. For future tests the pattern should narrow the message-pattern argument when possible (the spec's own AC acknowledged this is acceptable for v1).

**`inventory_counts_set_submitted_by.test.sql`**: Yes. The INSERT-with-forged-column / read-back / compare pattern is the exact shape needed for every future trigger test. The CTE + temp-table workaround for `INSERT ... RETURNING` into a temp table is well-commented. The defense-in-depth second assertion (confirming the forged value is NOT persisted) is a good habit that costs one pgTAP `isnt()` call.

**`smoke-rpc.sh`**: Yes. Three checks (login, HTTP status, JSON envelope) follow the `smoke-edge.sh` shape exactly. The `ADMIN_TOKEN=` shortcut for iterating against a cached session is a quality-of-life addition beyond what `smoke-edge.sh` has. The explanation of why `service_role` JWT doesn't work with this project's `auth_is_admin()` is correct and worth preserving for maintainers.

### Coverage gap awareness — priority retroactive targets for spec 023

In priority order, the five Criticals from prior specs that lack test coverage:

| Priority | Spec | Critical | Suggested test |
| -------- | ---- | -------- | -------------- |
| 1 | 019 | `inventory_counts` cross-store item_id reject + UPDATE/DELETE deny | Sibling to the existing `inventory_counts_set_submitted_by.test.sql`; add assertions for the `item_id` cross-store check and the append-only enforcement. These are the two trigger arms not yet covered. |
| 2 | 016 | Dispatcher auth gate — every `when` arm of `report_run` | Extend `report_run_cogs.test.sql` or add a dispatcher-level test; the existing cogs test covers only the cogs arm. |
| 3 | 020 | Per-vendor EOD consistency triggers | New `eod_submissions_consistency.test.sql`. Pattern is identical to the inventory_counts trigger test. |
| 4 | 021 | MIN-DOW lateral-subquery RLS | New `order_schedule_min_dow.test.sql`. Requires two JWT personas (store A vs store B). |
| 5 | 018 | Variance template auth gate + missing-cost flagging | New `report_run_variance.test.sql`. The missing-cost assertion requires seed data with known cost gaps; may need a fixture insert within the transaction. |

Track 1 priority targets: `src/utils/convertToItemUnit.ts` (retire `scripts/test-unit-conversion.ts`) and `src/lib/db.ts` mapper functions (`mapItem` snake_case → camelCase pivot).

### `pg_prove` fallback assessment

The psql-direct fallback in `scripts/test-db.sh` is robust enough for the current two test files. The script correctly:

- Uses `-v ON_ERROR_STOP=1` to fail fast on a SQL syntax error or `raise exception` that escapes the `begin/rollback` frame.
- Scans for `^not ok ` lines (pgTAP assertion failures).
- Scans for `# Looks like you failed` (pgTAP aggregate failure message).
- Reports `ok N` pass counts.

One gap flagged by the code-reviewer: the script's comment on the `# Looks like you failed` grep says "plan/finish mismatch" but that message is actually for assertion failures. The plan-count mismatch messages (`# Looks like you planned N tests but only ran M` / `# Looks like you ran N tests but only planned M`) are NOT caught by the current greps. This means a test file that silently runs fewer assertions than declared (e.g. an assertion inside a `DO $$` block that's never reached) would produce a false PASS from the shell wrapper. The `plan(N)` guard inside the SQL file is the first line of defense; the shell script fails to be the second. This is a should-fix, not blocking, and the code-reviewer already flagged it.

If `pg_prove` is available in a future Supabase image, the wrapper can simplify to two lines. Until then the psql fallback is acceptable, with the plan-mismatch grep gap documented.

### CI workflow practicality

The workflow is appropriately minimal for v1. Two observations:

1. **No `timeout-minutes`** on either job. The code-reviewer already flagged this. A hung `supabase start` in CI can hold a slot for 6 hours. Suggest `timeout-minutes: 15` on the jest job and `timeout-minutes: 30` on the db job. Not blocking, but a real operational risk once there are concurrent PRs.

2. **`db` job is not a required status check in v1** — this is the correct call (per the architect's risk §2). The job runs and produces signal, but a slow or flaky Supabase cold-boot does not block merge. Tighten once stability is observed.

3. **No `permissions:` block** — security-auditor flagged this as medium. A one-line `permissions: { contents: read }` addition is cheap defense-in-depth. Not blocking.

### The `db-migrations-applied.yml` legacy

The new `test.yml` is a functional supersession of the never-pushed `db-migrations-applied.yml`. The CLAUDE.md "CI workflow" note still says "pending re-push when token is updated" and the README still references `db-migrations-applied.yml`. Both are now stale. The developer deferred the README cleanup per a user instruction at PR time. This should be resolved: either update the README to reference `test.yml` or remove the line. Not a blocker on this spec's AC, but the next developer to read the README will be confused.

### Notes

- **`scripts.smoke` vs `scripts.test:smoke` (AC3-2)**: The spec AC literally names `scripts.smoke`; the implementation uses `scripts.test:smoke`. Functionally identical but the AC text fails literally. This is the only criterion where the implementation diverges from the spec's stated name. Recommend the release-coordinator treat this as a minor naming deviation rather than a behavior gap — both scripts run, both exit codes propagate, the README documents `npm run test:smoke`. The name `test:smoke` is arguably better UX (groups with `test`, `test:db`, `test:all`).

- **`@testing-library/jest-native` deprecation**: npm warns during install that the package is deprecated ("Please use the built-in Jest matchers in @testing-library/react-native v12.4+"). The matchers still work; this is a clean-up target for a follow-up spec to remove the dep and use built-in matchers.

- **`tsconfig.test.json` `"exclude": []`**: The code-reviewer flagged that an explicit empty array overrides TypeScript's built-in default exclusions (removing `node_modules` from the excluded set). Fix: remove the key entirely or add `"node_modules"` explicitly. Since `typecheck:test` is not a CI gate in v1 the impact is limited, but the fix is one character.

- **pgTAP install state**: `create extension if not exists pgtap` succeeds on first run (pgTAP 1.3.3 is available in the image as a built-in). The extension is absent from `pg_extension` before first install (`select extversion ...` returns 0 rows) but the `CREATE EXTENSION` path works correctly. This is expected behavior — `create extension if not exists` handles it cleanly.

- **Workflow-scoped token issue**: The `.github/workflows/test.yml` file is committed on disk. Whether it runs in GitHub depends on whether the user's token has `workflow` scope. Per CLAUDE.md and spec AC, this is the user's responsibility to push manually if needed. No agent action required.

---

### Spec 023 queue (priority-ordered)

Items to spec next, in priority order:

1. **Retroactive coverage for 5 Criticals** (specs 016, 018, 019, 020, 021) — high priority. The `tests/README.md` follow-up table provides the exact todo list. All five are Track 2 DB tests following the patterns established by spec 022. Spec 019's trigger coverage is the most urgent (attribution-forgery vector; the existing test covers only one of three trigger arms).

2. **`test-db.sh` plan-mismatch grep fix** — medium priority. Add a third grep matching `# Looks like you planned\|# Looks like you ran` so the shell wrapper catches silent assertion-count drift. One-line fix; bundle into the retroactive coverage spec or as a standalone patch.

3. **CI hardening** — low priority. Add `timeout-minutes` to both jobs; add `permissions: { contents: read }` to the workflow. Bundle into a CI-hygiene PR.

4. **`@testing-library/jest-native` migration** — low priority. Drop the deprecated dep; switch to built-in matchers from `@testing-library/react-native` v13. Non-breaking, but wait until baseline coverage exists so the migration is a controlled swap.
