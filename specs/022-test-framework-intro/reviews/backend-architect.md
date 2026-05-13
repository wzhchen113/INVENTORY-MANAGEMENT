# Spec 022 backend-architect drift review

Mode: post-implementation drift review. Read-only. No `Status:` mutation.

This spec is infrastructure — no migrations, no `src/lib/db.ts` surface, no
realtime publication membership changes. The drift surface is the *tooling
shape* (config files, runner scripts, CI workflow, example tests). I read
each artifact and compared against §1-§13 of my own design.

## TL;DR

**No Critical drift. No blocker.** Everything material that the architect
prescribed landed; the two named divergences (`pg_prove` → raw `psql` TAP
parsing, `service_role` JWT → admin login round-trip) are *better* than the
sketches in the design — they ground the test runner in what the local
image actually ships instead of what the upstream Supabase docs promise.

The "demo hybrid-mocking pattern lives in docs, not in a wired test" path is
exactly the §11.5 fallback I prescribed for the case where component-test
mock surface would force testing `useStore.ts`. Acceptable.

## Drift inventory

### §1 — Dependency pins: **Faithful**

`package.json` devDeps match the design's pin table verbatim. Spot-check:

| Architect §1 prescription          | Landed pin               | Verdict   |
| ---------------------------------- | ------------------------ | --------- |
| `jest@^29.7.0`                     | `^29.7.0`                | Faithful  |
| `jest-expo@~54.0.0`                | `~54.0.0`                | Faithful  |
| `@testing-library/react-native@^13.0.0` | `^13.0.0`           | Faithful  |
| `@testing-library/jest-native@^5.4.3`   | `^5.4.3`            | Faithful  |
| `@types/jest@^29.5.12`             | `^29.5.12`               | Faithful  |
| `react-test-renderer@19.1.0` (exact) | `19.1.0` (exact)       | Faithful  |
| `@types/react-test-renderer@^19.1.0` | `^19.1.0`              | Faithful  |
| `ts-jest` NOT installed            | Absent from devDeps      | Faithful  |
| `jest-environment-jsdom` NOT installed | Absent (jest-expo transitive) | Faithful |

`jest-expo` brings the jsdom env transitively per design, confirmed by the
component project's `testEnvironment: 'jsdom'` setting working without a
direct dep.

The backend-dev surfaced one caveat: `@testing-library/jest-native`'s
install warns "deprecated — please use built-in Jest matchers in
testing-library/react-native v12.4+". The pin still works (5.4.3 is the
last v13-compatible major), but a follow-up cleanup spec to swap to the
built-in matchers is the right next move. Not blocking — this is exactly
the kind of churn the architect §11.1 risk callout predicted.

### §2 — `jest.config.js` shape: **Faithful with one approved drift**

Compared design §2 sketch line-by-line against `jest.config.js`:

- `RN_TRANSPILE_DEPS` allow-list: faithful, with one **additive drift**: dev added `react-native-worklets` (the runtime dep of `react-native-reanimated` since RN 0.76). My §2 list omitted it; the dev correctly anticipated that reanimated's transitive worklets package would trigger the same untranspiled-ESM symptom. Good catch — **Approved Drift**.
- `transformIgnorePatterns` regex shape: faithful (`node_modules/(?!(?:${...}|...)/)`).
- `moduleNameMapper` for `@/*`: faithful.
- `setupFiles` mention in design: I called it `setupFilesAfterEach`. Dev correctly used **`setupFilesAfterEnv`** (the actual jest property name — `setupFilesAfterEach` doesn't exist as a jest config key). This was a typo in my §2; the dev fixed it on the way through. **Approved Drift (architect typo correction).**
- Projects split (unit/node + component/jsdom): faithful, including the testMatch globs for each.
- The component project's `setupFilesAfterEnv` adds `@testing-library/jest-native/extend-expect`: faithful.
- **Additive drift**: dev added `modulePathIgnorePatterns: ['<rootDir>/.claude/worktrees/']` to prevent jest-haste-map's `package.json#name` collision when a stale worktree happens to be on disk. CLAUDE.md says `.claude/worktrees/` should be gitignored and agents never modify it — this guard belongs in the config file rather than as a runtime surprise. **Approved Drift, ship-it.**

### §3 — TypeScript strategy: **Faithful**

`tsconfig.test.json` exists with the prescribed shape (`extends: "./tsconfig.json"`, `types: ["jest", "node"]`, `noEmit: true`, `include` for test files + `tests/**/*.ts`).

`tsconfig.json` has the exclusion my §3 demanded: `"exclude": ["**/*.test.ts", "**/*.test.tsx", "tests/**/*"]`. This keeps Expo's bundler from graph-walking test files.

`package.json` has the `typecheck:test` script per §3, and it is correctly **not** wired into CI (the design explicitly said "not a CI gate; jest itself catches type errors via babel-jest").

The frontend-developer caveat noted that `typecheck:test` currently reports errors in `src/store/useStore.ts` and `src/lib/webPush.ts`. Verified — those errors exist on `main` independently of this spec; the test-program walks the same source graph as the base config. Non-blocking per the design's explicit "on-demand verification" framing, but I agree with the frontend-dev's recommendation that a follow-up store/webPush typecheck-cleanup spec would unlock `typecheck:test` as a CI-enforceable gate. Documented for spec 023.

### §4 — DB test mechanism: **Approved Drift**

Architect prescribed `pg_prove`. Landed: raw `psql -f` + TAP-output parsing.

**Verdict: Approved Drift, with a forward-compat note.**

The dev verified locally that `pg_prove` is NOT in the Supabase Postgres
image as of 2026-05-13 (only the pgtap SQL functions). Three options were
available:
- (a) Ship `pg_prove` via a sidecar container or `docker exec apt-get`. Bloats CI and bakes a tooling install into every test run.
- (b) Fall back to `supabase test db`. My §4 explicitly rejected this for two reasons that still hold.
- (c) Parse pgTAP's TAP output directly with bash + grep.

The dev picked (c). Reviewing `scripts/test-db.sh`:

- Hermetic isolation is preserved — each test file owns its own `begin; ... rollback;` frame, the wrapper just shells `psql -f - < $f`. ✓
- Pass/fail detection is robust: scans for `^not ok ` (any assertion failure) **and** `# Looks like you failed N tests of M` (the plan/finish mismatch line pgTAP emits when assertion count drifts). ✓
- Per-file `ON_ERROR_STOP=1`: catches syntax errors and unexpected `raise` outside of `throws_ok()`. ✓
- Per-file count summary (`(N assertion(s) passed)`): cosmetic but useful for output review. ✓
- Container-running sanity check up front (exits 2 if `supabase_db_imr-inventory` isn't running). ✓
- `CONTAINER=` env override for non-default project_id. ✓

**Robustness assessment: the TAP-parsing path is sufficient.** The two
failure modes — `not ok` lines and plan/finish mismatch — are pgTAP's
canonical TAP output. The bash `grep -q` checks are deterministic and the
script bubbles up the full psql output on failure for the operator to read.

**Recommendation NOT to install pg_prove via sidecar.** Reasons:
1. The dev's wrapper covers the same hermetic-isolation + pass/fail-summary properties the architect §4 cited as the case for pg_prove.
2. Adding an apt-install step to every CI run trades ~5-15s of build time for "use the docs-canonical tool", which is a poor trade.
3. If a future Supabase image bump ships `pg_prove` (the dev's `tests/README.md` already documents this — "the wrapper can be simplified to the two-line `docker exec ... pg_prove ...` form architect §4 sketched"), the migration is trivial.

The dev's divergence is documented in `tests/README.md` § "Divergence from the architect's prescribed shape" — exactly the place a future contributor will look.

### §5 — Hermetic isolation: **Faithful**

Both example DB tests follow the prescribed pattern:

`supabase/tests/report_run_cogs.test.sql` (lines 23-126):
- `begin;` (line 23), `create extension if not exists pgtap;` (line 24), `select plan(5);` (line 26), `select * from finish(); rollback;` (lines 125-126). ✓
- Stable seed lookup by `name` rather than hardcoded UUID (`select id from public.stores where name = 'Frederick' limit 1;`) — matches my §11.7 risk-mitigation prescription. ✓
- `set_config('request.jwt.claims', ..., true)` for RLS impersonation — transaction-local third arg per design. ✓
- Two scenarios in one file (auth-gate raises 42501 + envelope shape) per §9 prescription. ✓

`supabase/tests/inventory_counts_set_submitted_by.test.sql` (lines 22-114):
- Same framing: `begin;`, `create extension`, `select plan(3);`, `finish(); rollback;`. ✓
- Forged-INSERT then read-back pattern matches §9. ✓
- Stable seed lookup by name (Frederick). ✓
- JWT-claims `app_metadata.role` shape correct for `auth_is_admin()` reads. ✓
- Uses CTE `with ins as (insert ... returning id)` to capture the inserted row id — neat workaround for Postgres not accepting `create temp table ... as insert ... returning`. ✓

One omitted scenario from my §9: the second assertion I sketched (RLS prevents cross-store INSERT). The landed test files do NOT cover that — they cover the trigger override + a defense-in-depth `isnt()` confirming the forged value didn't persist. The architect prescription said "minimum 3 assertions, two scenarios"; the dev shipped 3 assertions but only the trigger-override scenario.

**Verdict: Approved Drift.** The trigger-override scenario is the *primary*
attack vector spec 019 closed. Cross-store INSERT rejection is gated by the
existing per-store RLS hardening (spec 011) and is covered by the
`report_run_cogs.test.sql` auth-gate test in a different shape (`throws_ok`
42501). Forward-compat note for spec 023: the cross-store INSERT scenario
should land as a sibling test file when retroactive coverage is added.

### §6 — CI workflow: **Faithful**

`.github/workflows/test.yml` matches the design's prescribed shape:

- `on: push: / pull_request:` triggers. ✓
- `jest` job: `actions/checkout@v4` + `actions/setup-node@v4` with node 20 + `cache: npm` + `npm ci` + `npm test -- --ci`. Faithful, including the `--ci` flag the design did not explicitly call for but which jest projects benefit from in CI (silences fully-interactive prompts). Minor positive drift.
- `db` job: `supabase/setup-cli@v1` + `supabase start` + `npm run test:db` + `supabase stop --no-backup` with `if: always()`. Faithful.

The `supabase stop --no-backup` with `if: always()` is an improvement over my §6 sketch — guarantees the stack stops even on test failure, freeing the CI runner. Minor positive drift.

**Timeout question (review prompt §11.b): is the cold-boot budget generous enough?**

The workflow does NOT set an explicit `timeout-minutes:` on either job. GitHub Actions' default job timeout is 360 minutes (6 hours) — comfortably above the architect's predicted ~60-90s `supabase start` boot. Even on a busy ubuntu-latest runner with image pulls, ~3-4 minutes is the realistic upper bound. **No timeout adjustment needed.** If observed flakes in the first few runs suggest otherwise, a later spec can add `timeout-minutes: 15` to the `db` job.

The design's §11.2 mitigation ("do NOT add the DB job to required-status-checks in v1") is a GitHub repo-settings concern not visible in `test.yml` — outside the workflow file's scope. The dev's `tests/README.md` re-states it under the "CI" section ("The DB job is NOT a required status check in v1; tighten once stability is observed"). ✓

**Workflow-scoped token caveat** (design §6 + spec AC): the dev surfaced this in their caveats. The file is on disk; user pushes manually if the token issue persists. No retry loop. ✓

**README cleanup (design §6 + AC)**: dev explicitly did NOT touch `README.md` because user-level instructions overrode the AC. Verified via grep — `db-migrations-applied.yml` still appears at `README.md:137` and `:224`. Caveat documented. **Acceptable** — this is a user-directed scope reduction.

### §7 — File naming + platform suffix: **Faithful**

Spot-check each pattern:

| Track + kind            | §7 path pattern                          | Landed file                                                                           | Verdict   |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- | --------- |
| Track 1 unit            | colocated `<file>.test.ts`               | `src/utils/relativeTime.test.ts`                                                      | Faithful  |
| Track 1 component       | colocated `<file>.test.tsx`              | `src/components/cmd/StatusPill.test.tsx`                                              | Faithful  |
| Track 1 platform suffix | `.web.test.tsx` / `.native.test.tsx`     | not used in v1 (per design)                                                           | Faithful  |
| Track 2 DB tests        | `supabase/tests/<name>.test.sql`         | `supabase/tests/report_run_cogs.test.sql`, `...inventory_counts_set_submitted_by.test.sql` | Faithful |
| Track 3 shell smokes    | `scripts/smoke-<area>.sh`                | `scripts/smoke-rpc.sh`                                                                | Faithful  |
| Test setup / helpers    | `tests/<name>.ts`                        | `tests/jest.setup.ts`                                                                 | Faithful  |

The component test's `testMatch` regex (`<rootDir>/src/components/**/*.test.tsx`) correctly picks up the deeply-nested colocated file.

### §8 — Documentation location: **Faithful**

`tests/README.md` is the canonical doc location (not `docs/testing.md`, not a CLAUDE.md edit). ✓

CLAUDE.md got the one-line edit my §8 prescribed: line 77 was changed from
"No jest/vitest, no `*.test.*` files..." to "**Test framework.** See
[tests/README.md](tests/README.md) — three tracks (jest, pgTAP DB tests,
shell smokes). v1 ships infra + 1-2 example tests per track; retroactive
coverage of past Criticals is a follow-up." Single-line, points at the new
doc, doesn't duplicate content. ✓

**Required content checklist** (§8 outline):

| §8 required content                          | Present in `tests/README.md`?                    | Notes                                                                       |
| -------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Three tracks overview (table + run cmds)     | Yes (lines 7-32)                                 | Table format is cleaner than my prose sketch — improvement.                |
| Hybrid mocking strategy (Q6 = D)             | Yes (lines 42-79)                                | Includes the rejected `supabase.ts` anti-pattern callout.                  |
| How to add a new test of each kind           | Yes (Tracks 1, 2, 3 each have an "add" section) | Track 2's checklist (lines 280-294) is unusually detailed — good.          |
| How CI runs them                             | Yes (lines 363-376)                              | Links to `.github/workflows/test.yml`.                                     |
| First follow-up coverage targets             | Yes (lines 378-399)                              | Table format with spec numbers, target file names. Better than my sketch. |
| Local edge runtime bind-mount gotcha (Track 3 troubleshooting) | Yes (lines 334-358)             | Copied verbatim from CLAUDE.md per §8 prescription.                       |
| Realtime publication gotcha pointer          | Yes (lines 360-361)                              | One-line pointer, no content duplication.                                  |
| **Transitive store-import gotcha**           | Yes (lines 81-111)                               | **Additive** — frontend-dev discovered this during impl and documented it. **Approved Drift, ship-it.** |

The "Transitive store-import gotcha" section captures something my design missed: any component that calls `useColors()` / `useCmdColors()` transitively imports `useStore` → `db.ts` → `supabase.ts`, which crashes at import time without `EXPO_PUBLIC_SUPABASE_URL` env vars. The frontend-dev's prescribed fix (mock the theme hook at test scope) is the cleanest cut point given CLAUDE.md's "don't refactor useStore" rule. This belongs in the architect's design retroactively — flagging for spec 023.

### §9 — Example test targets: **Faithful with one §11.5-sanctioned demotion**

| §9 target file                                          | Landed?  | Assertions | Pattern conformance |
| ------------------------------------------------------- | -------- | ---------- | ------------------- |
| `src/utils/relativeTime.test.ts`                        | Yes      | 9 (architect prescribed 3 + 1 optional) | Frozen clock via `useFakeTimers().setSystemTime()`. Faithful + bonus coverage. |
| `src/components/cmd/StatusPill.test.tsx`                | Yes      | 5 (architect prescribed 3) | Renders each `Status` value + override prop. Faithful + bonus. |
| `supabase/tests/report_run_cogs.test.sql`               | Yes      | 5 (architect prescribed 2-3) | Auth gate + envelope shape. Faithful + bonus. |
| `supabase/tests/inventory_counts_set_submitted_by.test.sql` | Yes  | 3 (architect prescribed 2) | Trigger override + defense-in-depth `isnt`. Cross-store INSERT scenario omitted (acceptable per §5 above). |
| `scripts/smoke-rpc.sh` smoke of `report_run('stub', ...)` | Yes    | 1 PASS/FAIL check (architect prescribed 1) | Logs in as `admin@local.test`. Asserts 200 + envelope shape + 2 stub columns. **Approved Drift** — see §10 below. |

**One discovered architect-prescription error in §9 (`relativeTime` assertion)**:

My §9 said "`relativeTime('2026-05-13T11:00:00Z')` with system time at
`2026-05-13T12:00:00Z` returns `'1h'`". The dev's test confirms this (line
33-35). But my optional 4th — "`relativeTime(new Date('2026-05-11T12:00:00Z'))`
returns `'2d'`" — has a subtle date-fns rounding edge I didn't validate.
The dev surfaced (caveat 1) that date-fns' strict mode rounds 90 seconds to
"2 minutes" (round-nearest, not round-down). The landed test locks the
**actual** behaviour rather than the architect's guess. **This is correct
behaviour** — assertions should reflect ground truth. **Approved Drift.**

**Hybrid-mocking demo demotion (review prompt §10):**

My §9 said "if the developer finds that `useStore` is hard to test in
isolation … the hybrid-mock demonstration moves to the `tests/README.md` as
a documented *pattern* with a minimal in-file example." The
frontend-developer hit exactly this case (`useStore` → `db.ts` →
`supabase.ts` import chain crashes at jest time without env vars).

The landed shape is correct per the §11.5 fallback:

- `StatusPill.test.tsx` demonstrates the **test-level theme-hook mock** at lines 26-38 (the actual hybrid-mocking-at-a-boundary pattern, just at the theme/colors boundary instead of db.ts because `StatusPill` doesn't call `db.ts`).
- `tests/README.md` documents the **canonical pattern** at lines 42-79 with a worked `jest.mock('@/lib/db', () => ({ fetchInventory: jest.fn().mockResolvedValue(...) }))` example. This is the pattern a future component test that *does* call `db.ts` will use.
- `tests/README.md` lines 81-111 additionally documents the transitive-store-import gotcha — newly discovered during implementation.

**Verdict: docs-only outcome for the `db.ts`-mocking demo is acceptable**
per the §11.5 fallback. The AC reads "demonstrates the hybrid mocking
pattern" which the documentation + working theme-hook mock together satisfy.
The architect-sanctioned fallback is invoked exactly as designed.

### §10 — Out-of-scope confirmations: **Faithful**

Verified each:

| §10 confirmation                                          | Verified?                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| No `src/lib/db.ts` changes                                | ✓ (git status shows `src/lib/db.ts` already M from spec 016 carry-over; no spec-022 hunks) |
| No migrations                                             | ✓ (pgtap is per-test `create extension if not exists`, no new migration file) |
| No `app.json` slug change                                 | ✓                                                                        |
| No legacy file edits (`useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, `AdminScreens.tsx`, `npm run db`) | ✓ — the `db` script is still in `package.json:11` untouched |
| No new edge functions, no `verify_jwt` toggle             | ✓                                                                        |
| No realtime publication membership changes                | ✓ (no new migration touches `supabase_realtime`; no `docker restart supabase_realtime_imr-inventory` deploy step introduced) |

**Service-role smoke divergence (review prompt §9 / dev caveat 3):**

My §9 sketched the smoke script using a service-role JWT as the bearer.
Landed: `admin@local.test` login round-trip.

**Verdict: Approved Drift, with strong endorsement.** The dev's analysis is
correct: `auth_is_admin()` reads from `app_metadata.role` (the JWT's
`app_metadata` claim), not from the PostgREST top-level `role`
discriminator. A service-role JWT passes the PostgREST gate but does NOT
flip `auth_is_admin()` to true — so my §9 sketch would have hit an RLS
denial on the first `report_run` template that calls
`auth_is_admin()`-protected helpers internally. The login-then-bearer
pattern matches `scripts/smoke-edge.sh` and is what every other smoke check
in the repo does. **The dev's divergence is more correct than my
prescription.**

### §11 — Risk callouts: which materialized?

| §11 risk                                                       | Materialized? | Notes                                                                                                              |
| -------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1. jest-expo 54 + RN 0.81 + React 19 bleeding-edge churn       | Partially      | `@testing-library/jest-native` deprecation warning surfaced (caveat 1). No actual breakage. Follow-up spec to swap to built-in matchers is queued. |
| 2. CI's `supabase start` cold-boot ~60-90s                     | Untested in this review | Workflow file present; not yet observed in a real CI run because the user pushes manually. No `timeout-minutes:` set on either job — default 360min is comfortable. **No adjustment needed.** |
| 3. pgTAP availability in Supabase image (assumed)              | Did not materialize | pgTAP 1.3.3 confirmed present 2026-05-13 (per `tests/README.md:266`). |
| 4. `transformIgnorePatterns` allow-list staleness              | Did not materialize | Dev's component test runs green; allow-list covers every transitively-imported RN/Expo dep. The added `react-native-worklets` entry was the only proactive add needed. Documented troubleshooting in `tests/README.md:162-167`. |
| 5. Hybrid-mocking demo forced into `useStore`-as-SUT territory | **Materialized** | Triggered the §11.5 fallback exactly as designed. Demo lives in `tests/README.md` docs + working theme-hook mock in `StatusPill.test.tsx`. **§11.5 worked as a safety net.** |
| 6. Workflow-scoped token issue                                 | Pre-existing per CLAUDE.md | Dev did not retry. User-managed push. |
| 7. Seed-data drift                                             | Did not materialize | Both DB tests use named-store lookups (`where name = 'Frederick'`). Mitigation prescribed in §11.7 was followed. |

**Risk #4 explicit verification (review prompt §11.c):** the
`RN_TRANSPILE_DEPS` allow-list in `jest.config.js:13-39` covers:
`react-native`, `@react-native`, `@react-native-async-storage`,
`@react-navigation`, `expo`, `expo-modules-core`, `expo-font`,
`expo-asset`, `expo-constants`, `expo-file-system`, `expo-sharing`,
`expo-sqlite`, `expo-notifications`, `@expo`, `@expo-google-fonts`,
`react-native-svg`, `react-native-toast-message`,
`react-native-gesture-handler`, `react-native-reanimated`,
**`react-native-worklets`** (drift add), `react-native-screens`,
`react-native-safe-area-context`, `react-native-web`,
`react-native-chart-kit`, `@dnd-kit`.

This is the conservative superset I prescribed plus the worklets add. Every
RN/Expo dep that appears in `package.json` dependencies is covered. The
two example tests transitively import `react-native-svg` and
`react-native-toast-message` (Toast is mocked globally; svg loads); the
component test passing green confirms the allow-list is sufficient.

### §12 — Frontend store impact: **Faithful**

Spec said "None". Verified — `src/store/useStore.ts` was NOT touched by
this spec. (`git status` shows it as `M` from a carry-over of an earlier
spec, but no spec-022 hunks land in it.) ✓

### §13 — Realtime impact: **Faithful**

Spec said "None". No new migration touches `supabase_realtime` membership.
No `docker restart supabase_realtime_imr-inventory` deploy step
introduced. ✓

## Forward-compat checklist (for the next test-adoption spec — 023?)

Items to address in the *next* spec that adopts the framework:

1. **Retroactive Critical coverage.** The five Criticals from specs
   016/018/019/020/021 listed in `tests/README.md:378-399` are the
   starting todo list. The DB test for spec 020 (per-vendor EOD
   consistency) should be the highest priority because it's the most
   recent and the migration shape is freshest in memory.

2. **`@testing-library/jest-native` swap.** Deprecated; drop the dep and
   migrate to built-in matchers in `@testing-library/react-native@^13`.
   One-spec-and-done; trivially reversible.

3. **Cross-store INSERT scenario for `inventory_counts`.** My §5 noted
   this scenario was prescribed but not landed in v1. Add a sibling test
   file under `supabase/tests/`.

4. **`useStore.ts` / `webPush.ts` type cleanup.** Currently
   `typecheck:test` reports errors from these two files. Once cleaned,
   `typecheck:test` becomes a viable CI gate. Sequencing: do this BEFORE
   wiring `typecheck:test` into CI.

5. **`db-migrations-applied.yml` README cleanup.** Per user-directed
   override in this spec, README still references the never-shipped
   workflow. A small standalone spec or doc-cleanup PR is the right
   vehicle.

6. **CI `timeout-minutes:` for the `db` job.** Default 360min is
   comfortable now; once observed run times are known, tighten to ~15min
   so a stuck container doesn't waste CI budget. Lazy add — wait for
   real signal.

7. **Documenting the transitive-store-import gotcha at architect-design
   time.** Spec 023's architect should pre-warn that any component using
   `useColors` / `useCmdColors` will need either a theme-hook mock OR a
   `<ThemeProvider>` wrapper in tests. The `tests/README.md` covers it
   reactively; the architect's design should reflect it proactively.

8. **`react-native-reanimated` jest mock.** Not needed for v1 (StatusPill
   doesn't use reanimated), but the moment a future test touches a
   reanimated-driven component, `tests/README.md:170-174` notes the
   package's official mock will be needed in `tests/jest.setup.ts`.

9. **Component-test boundary mock of `db.ts`.** No v1 example actually
   exercises the canonical `jest.mock('@/lib/db', ...)` pattern in a
   wired test (`StatusPill` doesn't call `db.ts`). The first
   spec-023-era component test that DOES call a `db.fetch*` helper is
   the canonical proof point.

## Block recommendation

**No.** No Critical drift. The framework lands working; the two named
divergences (pg_prove → psql TAP parsing; service_role → admin login) are
correctness improvements over the design, not regressions. The
hybrid-mocking demo demotion to docs is an architect-sanctioned §11.5
fallback. The README cleanup omission is a user-directed scope reduction.

Forward-compat items above are advisory for spec 023 — none are blocking
for shipping spec 022.

## Files reviewed

- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/022-test-framework-intro/spec.md`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/CLAUDE.md`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/package.json`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/jest.config.js`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tsconfig.json`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tsconfig.test.json`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tests/jest.setup.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tests/README.md`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/scripts/test-db.sh`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/scripts/smoke-rpc.sh`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/.github/workflows/test.yml`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/report_run_cogs.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/inventory_counts_set_submitted_by.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/utils/relativeTime.test.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/StatusPill.test.tsx`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/StatusPill.tsx` (reference — confirms `Status` type + `statusLabel` output)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/utils/relativeTime.ts` (reference — confirms function signature + null-handling)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/theme/statusColors.ts` (reference — confirms `Status = 'ok' | 'low' | 'out' | 'info'`, no `warn`)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/config.toml` (reference — confirms `project_id = "imr-inventory"` ⇒ container name `supabase_db_imr-inventory`)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260511120000_report_run_cogs.sql` (reference — confirms RPC target exists)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260513120000_inventory_counts_consistency.sql` (reference — confirms trigger target exists)

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 9
  forward-compat items for spec 023. No blocker on shipping spec 022.
payload_paths:
  - specs/022-test-framework-intro/reviews/backend-architect.md
