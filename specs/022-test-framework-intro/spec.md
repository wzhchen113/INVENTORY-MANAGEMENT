# Spec 022: Test framework intro

Status: READY_FOR_REVIEW

## User story

As a developer (and as the test-engineer reviewer agent), I want a real
test framework wired into `imr-inventory` so that regressions in the JS/TS
layer (components, store, `src/lib/db.ts` helpers), the Postgres layer
(RPCs, RLS policies, consistency triggers), and the edge-function layer
(`supabase/functions/*`) get caught automatically — instead of being
re-discovered manually during reviewer audits — and so that future specs
can add `*.test.ts(x)` / `supabase/tests/*.sql` files alongside their
implementation work without first having to bootstrap a runner.

## Background — why now

The test-engineer agent has flagged "NO test framework wired up yet" on
every spec review since 016. CLAUDE.md "Gaps and unknowns" lists this
explicitly: "No jest/vitest, no `*.test.*` files. Only
`scripts/test-unit-conversion.ts` (one-off ts-node) and
`scripts/smoke-edge.sh` (curl smoke test)."

In parallel, specs 016 → 020 closed multiple Critical security findings
via consistency triggers and lateral-subquery RLS fixes whose proofs of
correctness lived in throwaway `psql` PoCs in chat. Those PoCs are not
checked in; nothing is stopping a future migration from regressing them.
A real DB test track converts those PoCs into permanent guards.

The recommendation surfaced by the user is a **three-track** setup, each
covering a different layer:

1. **jest-expo** for JS/TS unit + component tests. Conventional for
   Expo SDK 54 / RN 0.81 / React 19 projects. Lets us actually test
   React component behaviour and `src/lib/` / `src/store/` units.
2. **Supabase test DB / pgTAP-style DB tests** for RPC + RLS + trigger
   correctness against an isolated test schema. Migrations get validated
   in CI rather than only by manual psql.
3. **`scripts/smoke-*.sh`** shell scripts (curl/psql against the live
   local stack) for end-to-end RPC + edge-function smoke tests.
   Continues the existing `scripts/smoke-edge.sh` pattern.

This spec wires the **framework infrastructure only**. Retroactive
coverage for shipped Criticals (016/018/019/020/021) is out of scope —
those become a follow-up spec, with the targets listed in
`docs/testing.md` (or equivalent) so the next pass has an unambiguous
todo list.

## Acceptance criteria

All three tracks land in v1, each with 1-2 example tests demonstrating
the pattern. A GitHub Actions workflow runs Tracks 1 and 2 on every push
and PR.

### Track 1 — jest-expo (JS/TS)

- [ ] `package.json` declares `jest-expo` (or current Expo-blessed
      equivalent) plus `@testing-library/react-native`,
      `@testing-library/jest-native`, `@types/jest`, and any peer deps
      the architect identifies, all under `devDependencies`.
- [ ] `package.json` `scripts.test` runs the unit test suite end-to-end
      and exits non-zero on failure.
- [ ] `jest.config.js` (or `package.json` `jest:` block) exists with the
      Expo preset, `testEnvironment` set per architect (node vs. jsdom),
      a `transformIgnorePatterns` block that handles the RN + Expo
      package mix, and `moduleNameMapper` covering the `@/*` alias.
- [ ] **One unit test** exists and passes — covering a pure function
      from `src/utils/` (e.g. `convertToItemUnit`, so the existing
      `scripts/test-unit-conversion.ts` can later be deleted cleanly in
      a follow-up).
- [ ] **One component test** exists and passes — covering a small leaf
      component from `src/components/cmd/` (architect picks; e.g. a
      button or status pill). The component test demonstrates the
      hybrid mocking pattern (Q6 = D) by stubbing `src/lib/db.ts` at
      the boundary.
- [ ] `tsconfig.json` (or a `tsconfig.test.json`) recognises test files
      so `tsc --noEmit` does not error on them.
- [ ] Tests run on a clean clone via `npm ci && npm test` with no
      additional manual steps (no env vars, no docker required for
      Track 1).
- [ ] A `tests/README.md` (or `docs/testing.md`) documents the hybrid
      mocking strategy (mock at `db.ts` boundary for component/unit
      tests; real local Supabase for DB tests via `docker exec
      supabase_db_imr-inventory psql`) and explains where each kind of
      test belongs (per Q3 hybrid layout).

### Track 2 — Supabase DB tests

- [ ] A new directory `supabase/tests/` exists with at least **two**
      `.sql` test files demonstrating the chosen pattern (architect
      decides between Supabase's native `db.test` runner vs. raw
      pgTAP):
  - [ ] **One RPC test** — exercises a real RPC (architect picks; e.g.
        one from the `auth_*` or per-store helpers).
  - [ ] **One RLS smoke test** — exercises a per-store RLS policy or a
        consistency trigger from a shipped migration.
- [ ] `package.json` `scripts.test:db` (name TBD by architect) runs the
      DB test suite against the local Supabase stack (`docker exec
      supabase_db_imr-inventory psql ...` per the hybrid mocking
      decision) and exits non-zero on failure.
- [ ] DB tests run hermetically — they either spin up a temporary
      schema or wrap each test in a rolled-back transaction, so the
      local seed is not mutated and tests can run repeatedly.
- [ ] DB tests do not require any production secret; they run entirely
      against `supabase start`'s local stack.
- [ ] `tests/README.md` (or `docs/testing.md`) documents how to add a
      new DB test and the preconditions (`npm run dev:db` must be up,
      etc).

### Track 3 — Shell smoke scripts

- [ ] A `scripts/smoke-rpc.sh` (or similarly named) exists and follows
      the `scripts/smoke-edge.sh` shape — sectioned PASS / FAIL output,
      env-var driven, non-zero exit on first failure. **One example
      check** is sufficient for v1 (architect picks an RPC; happy-path
      invocation against the local stack).
- [ ] `package.json` `scripts.smoke` runs both `smoke-edge.sh` and the
      new RPC smoke script in sequence.
- [ ] The script runs against either the local stack (default) or a
      remote URL via `SUPABASE_URL=` override — same pattern as
      `smoke-edge.sh`.
- [ ] `tests/README.md` (or `docs/testing.md`) references the CLAUDE.md
      "Local edge runtime bind-mount captures CWD at boot" gotcha so
      smoke-script failures don't get misdiagnosed.

### CI

- [ ] `.github/workflows/test.yml` exists, runs on every push and every
      pull request, and contains at least two jobs:
  - [ ] **`jest` job** — runs Track 1 (`npm ci && npm test`) on
        ubuntu-latest. Exits non-zero on failure.
  - [ ] **`db` job** — boots the local Supabase stack (`supabase start`
        or equivalent per architect) and runs Track 2 (`npm run
        test:db`). Exits non-zero on failure.
- [ ] The workflow file replaces the long-pending
      `db-migrations-applied.yml` referenced in CLAUDE.md (i.e. once
      `test.yml` lands and passes, the `db-migrations-applied.yml`
      reference in README is either updated to point at the new file or
      removed — architect picks).
- [ ] **Push caveat:** if the workflow-scoped token permission issue
      noted in CLAUDE.md is still unresolved at merge time, the
      workflow file is committed locally and the user pushes it
      manually. The spec assumes either the token is fixed OR the user
      handles the manual push — agents do not retry the push loop.
- [ ] Track 3 (`smoke-rpc.sh`) is NOT wired into CI in v1 — smoke
      scripts continue to be manual-run, matching the current
      `smoke-edge.sh` posture.

### Documentation (cross-cutting)

- [ ] A new top-level `tests/README.md` (or `docs/testing.md` —
      architect picks the canonical location) documents:
  - The hybrid mocking strategy (D from Q6): mock `db.ts` at the
    boundary for jest tests; real local Supabase via `docker exec
    supabase_db_imr-inventory psql` for DB tests.
  - Where each kind of test lives (Q3 hybrid layout: colocated
    `Foo.test.tsx`, DB tests in `supabase/tests/`, shell smokes in
    `scripts/`).
  - How to run each track locally.
  - How CI runs each track.
  - The five Criticals from specs 016/018/019/020/021 listed as
    "first follow-up coverage targets" so the retroactive-coverage
    spec has an unambiguous starting point.

## In scope

- Picking a JS/TS test runner aligned with Expo SDK 54 (default:
  jest-expo).
- Wiring `package.json` scripts and a config file.
- 1-2 example tests per track that ship in v1 (Track 1: 1 unit + 1
  component; Track 2: 1 RPC + 1 RLS smoke; Track 3: 1 example RPC
  smoke).
- A test-writing guide in `tests/README.md` (or `docs/testing.md` —
  architect picks).
- `.github/workflows/test.yml` running Tracks 1 + 2 on push and PR.
- Hybrid mocking strategy: mock at `db.ts` boundary for unit/component
  tests; real local Supabase for DB tests.

## Out of scope (explicitly)

- **Retroactive test coverage** for shipped Criticals (016 dispatcher,
  018 variance, 019 inventory_counts triggers, 020 per-vendor
  consistency, 021 MIN-DOW lateral subquery). These become a follow-up
  spec; targets are listed in `tests/README.md` so the next pass has a
  todo list.
- **Visual regression / screenshot testing** (Percy, Chromatic,
  storybook-screenshot, etc.). Big setup, low marginal value while the
  UI is still moving — defer.
- **Browser / native E2E** via Detox, Maestro, or Playwright. Both
  valuable and both their own spec. The current pipeline relies on
  manual click-through plus `scripts/smoke-edge.sh`; that is acceptable
  for v1.
- **Performance benchmarks** (microbench, load test). Different
  motivation, defer.
- **Mutation testing** (Stryker etc.). Premature until baseline
  coverage exists.
- **Coverage thresholds enforced in CI.** Per Q5 default, coverage is
  unmeasured in v1. `jest --coverage` can be run on demand but no
  threshold is enforced. Rationale: easy to game, becomes a chore
  before baseline coverage exists.
- **Deleting `scripts/test-unit-conversion.ts` in this spec.** Once an
  equivalent jest test exists the cleanup is a one-line follow-up; do
  not bundle it here (avoids "did the cleanup also break something?"
  ambiguity during review).
- **Refactoring `src/store/useStore.ts` or `src/lib/db.ts` for
  testability.** Both are large; if a test forces an unrelated refactor
  the architect must surface that as a question rather than expanding
  scope inside this spec.
- **Wiring Track 3 (shell smokes) into CI.** Manual-run only in v1,
  matching the current `smoke-edge.sh` posture.
- **Modifying any legacy file**: `src/store/useSupabaseStore.ts`,
  `src/store/useJsonServerSync.ts`, `db.json`, `npm run db`,
  `src/screens/AdminScreens.tsx`. Per CLAUDE.md these are frozen.

## Open questions resolved

### Q1. Three tracks all at once, or staged?

⟪RESOLVED⟫ — **All three in v1** (jest-expo + Supabase DB tests + shell
smoke). User confirmed each layer needs its own track.

### Q2. CI provider.

⟪RESOLVED⟫ — **GitHub Actions** (PM default committed). Matches the
already-planned-but-not-pushed `db-migrations-applied.yml`.

### Q3. Test file location convention.

⟪RESOLVED⟫ — **Hybrid** (PM default committed). Unit + component tests
colocated next to file under test (`Foo.test.tsx`); DB tests in
`supabase/tests/`; shell smokes in `scripts/`.

### Q4. Retroactive test coverage scope.

⟪RESOLVED⟫ — **Framework only in v1.** 1-2 example tests per track to
demonstrate the pattern; future specs add their own tests. Retroactive
coverage for the five shipped Criticals (016/018/019/020/021) becomes a
follow-up spec, with the targets documented in `tests/README.md` for
unambiguity.

### Q5. Coverage targets.

⟪RESOLVED⟫ — **Unmeasured in v1** (PM default committed). `jest
--coverage` can be run on demand but no threshold is enforced.

### Q6. Mocking strategy for Supabase calls.

⟪RESOLVED⟫ — **Hybrid (option D).** Component / unit tests mock at the
`db.ts` boundary (stub `src/lib/db.ts` exports directly); DB tests use
real local Supabase via `docker exec supabase_db_imr-inventory psql`.
Strategy documented in top-level `tests/README.md` (or `docs/testing.md`)
so future contributors know the pattern.

### Q7. Should this spec include the GitHub Actions workflow file?

⟪RESOLVED⟫ — **Yes — `.github/workflows/test.yml` ships in v1.** Runs
jest-expo (Track 1) + DB tests (Track 2) on every push and PR. Replaces
the long-pending `db-migrations-applied.yml` reference in README.
**Caveat:** CLAUDE.md notes a workflow-scoped token permission issue
blocked the previous workflow push. This spec assumes that token is now
resolved OR the workflow file is committed locally and pushed manually
by the user. Agents do not retry the push loop.

## Dependencies

- New `devDependencies` will be added: at minimum `jest`, `jest-expo`,
  `@testing-library/react-native`, `@testing-library/jest-native`,
  `@types/jest`. Architect to confirm exact versions vs. Expo SDK 54
  compatibility.
- Track 2 depends on the local Supabase stack (`supabase start` /
  `npm run dev:db`) and possibly a pgTAP install in the test DB; the
  architect picks the exact mechanism. Tests invoke `docker exec
  supabase_db_imr-inventory psql ...` per the resolved hybrid mocking
  decision.
- CI job for Track 2 must boot Supabase on ubuntu-latest; architect
  picks between `supabase/setup-cli` action + `supabase start` vs. a
  postgres service container with migrations applied manually.
- No backend migrations needed for the framework itself.
- No edge-function changes for the framework itself. Track 3's example
  script may call an existing edge function or RPC, no function
  changes.

## Project-specific notes

- **Cmd UI section / legacy:** n/a — this spec is infrastructure, not
  a user-facing screen. No `src/screens/cmd/sections/*` changes
  expected. No `src/screens/AdminScreens.tsx` changes (off-limits per
  CLAUDE.md).
- **Per-store or admin-global:** n/a (infrastructure).
- **Realtime channels touched:** none.
- **Migrations needed:** no.
- **Edge functions touched:** none in v1.
- **Web/native scope:** the JS/TS test framework runs in Node (jest
  doesn't care about web vs. native runtime), but tests of
  RN-specific components may need to be marked as web-only or
  native-only via filename suffix. Architect decides convention.
- **`app.json` slug:** not touched (per CLAUDE.md, off-limits without
  explicit approval).
- **Tests:** this IS the tests spec. The test-engineer reviewer should
  treat this as foundational — once shipped, all subsequent specs can
  be reviewed against actual acceptance tests rather than reviewer-eye
  reads.
- **`@/*` alias:** the alias is defined in `tsconfig.json` but rarely
  used. Jest config must still support it so tests can import either
  style without surprise.
- **Strict TypeScript:** `tsconfig.json` has `strict: true`. Test code
  must type-check; the architect should decide whether to include
  tests in the main `tsc` pass or run a separate
  `tsconfig.test.json`.
- **Local edge runtime bind-mount gotcha:** Track 3 smoke script docs
  must reference the CLAUDE.md "Local edge runtime bind-mount captures
  CWD at boot" section so failures don't get misdiagnosed.
- **No CI on disk currently:** CLAUDE.md confirms no `.github/`
  directory exists in the repo. Architect must scaffold the directory
  from scratch for `.github/workflows/test.yml`.
- **Workflow-scoped token caveat:** CLAUDE.md flags that the previous
  workflow push hit a token-permission issue. Spec assumes that is
  resolved OR the user handles the manual push; agents do not retry.

## What's already there (for the architect)

- `scripts/test-unit-conversion.ts` — ad-hoc unit checker (`npx tsx`),
  not a framework. Hand-rolled `check()` / `approxEq()` helpers. Will
  be replaced by a jest version once Track 1 ships; do **not** delete
  in this spec.
- `scripts/smoke-edge.sh` — curl smoke for edge functions. Template
  for Track 3.
- `package.json` `scripts.test` — currently **absent** (verified — the
  script block has no `test` key). `npm test` today fails with
  "Missing script". Architect must add it.
- `tsconfig.json` strict mode is on. Test code must type-check.

## Backend Architecture

This is an infrastructure spec — there are no migrations, no edge function
changes, no `src/lib/db.ts` surface additions, and no realtime publication
membership changes. The "design" is the *tooling shape* for three test
tracks plus a CI workflow. Below: version pins, config-file shapes,
naming conventions, hermetic-isolation pattern, and explicit example-test
targets. The developer authors the actual config and test files against
these specs; no implementation code is committed here.

### 1. Dependency pins (Track 1)

Expo SDK 54 ships an opinionated `jest-expo` preset that already understands
the RN 0.81 + React 19.1 transform graph. Pin to the SDK 54-aligned majors.
Everything else hangs off compatibility with that preset.

| Package                               | Pin / range            | Why                                                                                                              |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `jest`                                | `^29.7.0`              | `jest-expo@~54` resolves to jest 29; jest 30 hasn't been validated against Expo SDK 54.                          |
| `jest-expo`                           | `~54.0.0`              | Lockstep with the Expo SDK major. Carries the babel transform + `react-native` jest preset.                       |
| `@testing-library/react-native`       | `^13.0.0`              | First major with React 19 support. `^12.x` peer-deps on React 18 and will warn/fail.                              |
| `@testing-library/jest-native`        | `^5.4.3`               | Matcher pack (`.toBeOnTheScreen()`, `.toHaveTextContent()`). Last version compatible with `@testing-library/react-native ^13`. |
| `@types/jest`                         | `^29.5.12`             | Matches jest 29 runtime types.                                                                                    |
| `react-test-renderer`                 | `19.1.0`               | **Must match the exact React version.** Anything else throws "Incompatible React versions" at render time.        |
| `@types/react-test-renderer`          | `^19.1.0`              | Type companion.                                                                                                  |
| `ts-jest`                             | **NOT INSTALLED**      | `jest-expo` uses `babel-jest` via `babel-preset-expo`; adding `ts-jest` would double-transform and break.         |

**Verify before committing the lockfile**: `npx jest-expo --version` should
print `54.x`. If npm resolves `@testing-library/react-native` below 13.0.0
because of a transitive React peer pin, the dev must pass `--legacy-peer-deps`
once; subsequent installs are clean.

**Do NOT add**:
- `jest-environment-jsdom` as an explicit dep — `jest-expo` brings it transitively for component tests.
- `@testing-library/user-event` — not yet 100% compatible with RN testing-library 13; defer to a follow-up.
- `enzyme` / `react-test-renderer` snapshot helpers — out of scope.

### 2. `jest.config.js` shape

A single config file at the repo root with a **projects** split so the
pure-TS units run under `node` (fast) while component tests run under the
Expo `jsdom` preset (RN-aware). This avoids paying for the heavier preset
on every `relativeTime`-style unit test.

```js
// jest.config.js (architect-prescribed shape — developer authors the file)
const path = require('path');

// Modules under node_modules/ that ship untranspiled ESM/Flow and therefore
// have to be NOT-ignored (i.e. transformed) for jest to import them. This is
// THE single most common source of jest-expo "Unexpected token 'export'" /
// "Cannot use import statement outside a module" failures. The list below is
// the conservative superset for SDK 54; the developer prunes as they verify.
const RN_TRANSPILE_DEPS = [
  'react-native',
  '@react-native',
  '@react-native-async-storage',
  '@react-navigation',
  'expo',
  'expo-modules-core',
  'expo-font',
  'expo-asset',
  'expo-constants',
  'expo-file-system',
  'expo-sharing',
  'expo-sqlite',
  'expo-notifications',
  '@expo',
  '@expo-google-fonts',
  'react-native-svg',
  'react-native-toast-message',
  'react-native-gesture-handler',
  'react-native-reanimated',
  'react-native-screens',
  'react-native-safe-area-context',
  'react-native-web',
  'react-native-chart-kit',
  '@dnd-kit',
];

const transformIgnorePatterns = [
  `node_modules/(?!(?:${RN_TRANSPILE_DEPS.join('|')})/)`,
];

const moduleNameMapper = {
  '^@/(.*)$': '<rootDir>/src/$1',
};

const baseProject = {
  preset: 'jest-expo',
  transformIgnorePatterns,
  moduleNameMapper,
  setupFilesAfterEach: ['<rootDir>/tests/jest.setup.ts'],
  // jest-expo configures babel-jest itself; do not override `transform`.
};

module.exports = {
  projects: [
    {
      ...baseProject,
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: [
        '<rootDir>/src/utils/**/*.test.ts',
        '<rootDir>/src/lib/**/*.test.ts',
        '<rootDir>/src/store/**/*.test.ts',
        '<rootDir>/src/hooks/**/*.test.ts', // hooks with no RN bridging
      ],
    },
    {
      ...baseProject,
      displayName: 'component',
      testEnvironment: 'jsdom',
      testMatch: [
        '<rootDir>/src/components/**/*.test.tsx',
        '<rootDir>/src/screens/**/*.test.tsx',
      ],
      setupFilesAfterEach: [
        '<rootDir>/tests/jest.setup.ts',
        '@testing-library/jest-native/extend-expect',
      ],
    },
  ],
};
```

**`tests/jest.setup.ts` global mocks** (developer to author — architect's
required content):

- `jest.mock('react-native-toast-message', () => ({ show: jest.fn(), hide: jest.fn() }))` — Toast is fired-and-forgotten throughout `useStore.ts` and `db.ts` error paths; without this stub, component tests crash trying to mount the native Toast container.
- `jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'))` — official mock from the package.
- **Do not** globally mock `src/lib/supabase.ts` — that's the boundary tests choose. Per-test files decide whether to mock `src/lib/db.ts` (component tests) or hit the real local stack (out-of-scope for jest; that's Track 2).

### 3. TypeScript strategy

**Decision: separate `tsconfig.test.json` extending the base.**

Rationale: `tsconfig.json` has `strict: true` and is consumed by Expo's
build pipeline (`npx expo export`). Including `*.test.ts(x)` in the main
program means the Expo bundler walks every test file looking for module
graph dependencies, slowing every dev-server start and bundle. The test
config inherits strict mode, adds `@types/jest`, and is consumed only by a
typecheck-only script and by editors via project references.

```json
// tsconfig.test.json (architect-prescribed shape)
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["jest", "node"],
    "noEmit": true
  },
  "include": [
    "src/**/*.test.ts",
    "src/**/*.test.tsx",
    "tests/**/*.ts"
  ]
}
```

Add `package.json` script `"typecheck:test": "tsc -p tsconfig.test.json --noEmit"`.
**Not** wired into CI in v1 — `jest` itself reports type errors via
`babel-jest`'s transform failure on bad TS. The script exists for editor
integration + on-demand verification. If CI growth pressure demands a
typecheck gate later, that's a follow-up.

**Do not** add `tsconfig.json` `include` rules for tests — explicitly exclude
via the test glob being absent from the base config. The base already covers
`src/**/*.ts(x)` so the dev must add `"exclude": ["**/*.test.ts", "**/*.test.tsx"]`
to `tsconfig.json` to keep Expo's bundler from accidentally pulling test
files into the production graph.

### 4. Supabase DB test mechanism (Track 2)

**Decision: raw pgTAP via `psql -f`, invoked through `docker exec
supabase_db_imr-inventory psql`, orchestrated by a shell script.**

Rejected alternative: `supabase test db`. The CLI runner does exist
(reads `supabase/tests/*.sql`, runs each in a transaction). The reasons
to NOT use it here:

1. It expects `pgTAP` extension preinstalled — fine on local, but in CI we'd still need to ship the extension binary (it's in the Supabase Postgres image so this is a non-issue, but documents-as-CLI-magic which is worse than documents-as-script).
2. The CLI wraps each file in `BEGIN; ROLLBACK;` but doesn't surface per-test pass/fail counts as cleanly as `pg_prove` does — and `pg_prove` is also already in the image.
3. Most importantly: a thin shell wrapper means the dev can iterate locally with the same command CI runs (`npm run test:db`), no second `npx supabase` CLI flag to remember. Mirrors how `scripts/smoke-edge.sh` is invoked.

**Shape of `scripts/test-db.sh`** (architect-prescribed):

```bash
#!/usr/bin/env bash
# scripts/test-db.sh — runs every .sql file under supabase/tests/ via pg_prove
# inside the running Supabase Postgres container.
#
# Preconditions:
#   - `npm run dev:db` is up (local) OR a `supabase start` has been run in CI.
#   - pgTAP is installed in the test DB (one-time setup; see migration note below).
#
# Hermetic isolation: each .sql file is wrapped in BEGIN; ... ROLLBACK; by
# pg_prove's --runtests flag, OR the test file itself uses pgTAP's
# `plan(N)`/`finish()` + an explicit transaction. We use the latter for
# explicitness — the test file owns its own txn.

set -euo pipefail
CONTAINER="${CONTAINER:-supabase_db_imr-inventory}"
TEST_DIR="$(cd "$(dirname "$0")/.."; pwd)/supabase/tests"

docker exec -i "$CONTAINER" \
  pg_prove -d postgres -U postgres --recurse --verbose \
  --ext .sql "$TEST_DIR"
```

**pgTAP install path**: pgTAP is bundled with the Supabase Postgres image
since at least 2025. The DB tests' first line is
`create extension if not exists pgtap;` per-test (cheap when already
installed). **No new migration is needed** — adding pgTAP via a real
migration would leak the testing extension into prod, which we don't want.

**Realtime publication note**: this spec does NOT touch
`supabase_realtime` membership. No `docker restart
supabase_realtime_imr-inventory` step is required. The publication
gotcha (CLAUDE.md "Realtime publication gotcha" memory) stays as it is
for future migration specs.

### 5. Hermetic isolation pattern (Track 2)

**Decision: per-test transaction rollback inside the .sql file itself,
combined with pgTAP `plan(N) ... finish()` framing.**

Rejected alternatives:
- Temp schema per test → forces `set search_path` gymnastics and breaks RLS helpers (`auth_can_see_store` is hard-pinned to `search_path = public, auth`).
- `supabase db reset` between tests → 30+ migrations, 286 KB seed, ~10-20s per reset. Untenable.

**Architect-prescribed per-file shape** (example, not committed code):

```sql
-- supabase/tests/example_rls_smoke.test.sql
begin;
create extension if not exists pgtap;
select plan(N);   -- exact assertion count

-- 1. Set up: as a non-admin user member of store A.
--    `auth.uid()` is mocked via set_config of the JWT claims.
select set_config('request.jwt.claims',
  json_build_object('sub', '<uuid-of-user>', 'role', 'authenticated')::text,
  true);

-- 2. Assertions.
select is(
  (select count(*) from public.inventory_items where store_id = '<store-A>'),
  <expected>::bigint,
  'store A member sees store A inventory'
);
select is(
  (select count(*) from public.inventory_items where store_id = '<store-B>'),
  0::bigint,
  'store A member is RLS-blocked from store B inventory'
);

select * from finish();
rollback;     -- absolute reset; the seed dataset is untouched.
```

Notes for the dev:

- The `request.jwt.claims` setting is how Supabase Postgres' RLS sees
  `auth.uid()`. `set_config(..., true)` makes it transaction-local — so
  the rollback cleans up that too.
- pgTAP's `plan(N)` is non-optional. A test file that runs fewer (or
  more) assertions than declared **fails** — this is what catches
  silently-dropped assertions.
- Test fixtures are written in the same `BEGIN`. They roll back with
  everything else.
- Real seed data (286 KB) is the substrate. We do NOT seed per-test —
  the seed represents a known-good "real" prod-mirror state. Tests
  assert against IDs known to be in the seed.

### 6. CI workflow (`.github/workflows/test.yml`)

**Decision: `supabase/setup-cli@v1` action + `supabase start` for the DB
job.** The lightweight "postgres service container + apply migrations
manually" path is rejected because:

- Tests assert against RLS using `auth.uid()`, which requires the GoTrue/auth role to be wired up properly. A bare Postgres service container has no `auth.*` schema, so every RLS-touching test would crash.
- `supabase start` on ubuntu-latest takes ~60-90s. Acceptable for the v1 cadence (not a per-second pipeline).

```yaml
# .github/workflows/test.yml (architect-prescribed shape)
name: test

on:
  push:
  pull_request:

jobs:
  jest:
    name: Track 1 — jest-expo
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm test

  db:
    name: Track 2 — Supabase DB tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
        # Brings up the full local stack: Postgres + Auth + Realtime + ...
      - run: npm run test:db
      - run: supabase stop --no-backup
        if: always()
```

**`db-migrations-applied.yml`**: per spec AC, this stale README reference
gets cleaned up. The architect-prescribed plan: the developer edits
`README.md` to point at the new `test.yml` (or removes the line
entirely — both acceptable). No separate workflow file is created.

**Token caveat**: per CLAUDE.md and the spec AC, if the workflow-scoped
token issue persists at merge time, the file lands on disk and the user
pushes manually. Agents do not retry the push.

### 7. File naming + platform-specific suffix

| Track       | Path pattern                                       | Example                                                         |
| ----------- | -------------------------------------------------- | --------------------------------------------------------------- |
| Track 1 unit       | colocated `<file>.test.ts`                  | `src/utils/relativeTime.test.ts`                                |
| Track 1 component  | colocated `<file>.test.tsx`                 | `src/components/cmd/StatusPill.test.tsx`                        |
| Track 1 web-only   | colocated `<file>.web.test.tsx`             | `src/components/cmd/WebOnlyThing.web.test.tsx` (none in v1)     |
| Track 1 native-only | colocated `<file>.native.test.tsx`         | n/a in v1                                                       |
| Track 2 DB tests    | `supabase/tests/<descriptive-name>.test.sql` | `supabase/tests/inventory_counts_submitted_by_override.test.sql`|
| Track 3 shell smokes | `scripts/smoke-<area>.sh`                | `scripts/smoke-rpc.sh`                                          |
| Test setup/helpers   | `tests/<name>.ts`                        | `tests/jest.setup.ts`                                           |

**Platform-suffix policy**: jest-expo's preset honors `.web.test.tsx` /
`.native.test.tsx` extensions automatically via its `testEnvironmentOptions`
+ `moduleFileExtensions` defaults. v1 does NOT ship a platform-specific
example test — the convention is documented for future use only. If a
component test in v1 *only* renders sensibly on web (e.g. anything
touching `Platform.OS === 'web'` branches with web-DOM assertions), it can
use the `.web.test.tsx` suffix without further config.

### 8. Documentation location

**Decision: `tests/README.md` is canonical.** Not `docs/testing.md`,
not a CLAUDE.md edit.

Reasons:

- `tests/` is a brand-new top-level directory created by this spec (alongside `tests/jest.setup.ts`). Co-locating the README with the setup file means a contributor opening the directory sees the docs immediately.
- `docs/` doesn't exist in the repo. Creating it just for one file is scope creep against the CLAUDE.md rule "Only do exactly what was asked".
- CLAUDE.md is for *project-wide invariants and gotchas*. Once `tests/README.md` exists, CLAUDE.md gets a **one-line pointer** at the bottom of "Gaps and unknowns" updating the "No test framework" line to "Tests under `tests/README.md`." Architect prescribes that single-line edit; no further CLAUDE.md changes.

**Required content** (architect-prescribed outline; the developer writes
the prose):

1. **Three tracks** — one short paragraph each with the run command.
2. **Hybrid mocking strategy (Q6 = D)** — component/unit tests mock at the `src/lib/db.ts` boundary using `jest.mock('@/lib/db')` or `jest.mock('../../lib/db')`. DB tests use real local Supabase via the `scripts/test-db.sh` wrapper. **Never** mock at the `src/lib/supabase.ts` layer for component tests — that's the level the architect rejects, because it forces re-implementing every Supabase client method in the mock.
3. **How to add a new test of each type** — file location, naming, what to assert.
4. **How CI runs them** — link to `.github/workflows/test.yml`.
5. **First follow-up coverage targets** — the five shipped Criticals from specs 016/018/019/020/021 listed by spec number, so the retroactive-coverage spec has a starting todo list.
6. **Local edge runtime bind-mount gotcha** — copy the CLAUDE.md "Local edge runtime bind-mount captures CWD at boot" note verbatim under a "Track 3 troubleshooting" subsection.
7. **Realtime publication gotcha pointer** — one line: "If a future test touches `supabase_realtime` publication membership, see CLAUDE.md > Realtime publication gotcha." (No content duplication.)

### 9. Per-track example test targets

These are the only test files that ship in v1. Each is sized to demonstrate
the pattern, not to provide coverage.

#### Track 1 unit example

**Target**: `src/utils/relativeTime.test.ts` covering
`src/utils/relativeTime.ts`.

Architect picks `relativeTime` over the spec's suggested `convertToItemUnit`
because:

- `relativeTime` is shorter (24 LOC), with a fully self-contained mocking story (just freeze the system clock via `jest.useFakeTimers().setSystemTime(...)`).
- `convertToItemUnit` is large (~280 LOC of unit-conversion logic) and would balloon to 20+ assertions to be meaningful — that converts the "example" into a quasi-retroactive coverage of `unitConversion.ts`, which the spec's Q4 explicitly defers. **Keeping `convertToItemUnit` in the follow-up coverage spec is correct.**
- The existing `scripts/test-unit-conversion.ts` continues to live until the follow-up coverage spec replaces it — spec AC explicitly forbids deleting it here.

**Assertions** (architect-prescribed; minimum 3):

1. `relativeTime('2026-05-13T11:00:00Z')` with system time at `2026-05-13T12:00:00Z` returns `'1h'`.
2. `relativeTime(null)` returns `''`.
3. `relativeTime('not-a-date')` returns `''` (invalid date branch).

Optional 4th: `relativeTime(new Date('2026-05-11T12:00:00Z'))` returns `'2d'`.

#### Track 1 component example

**Target**: `src/components/cmd/StatusPill.test.tsx` covering
`src/components/cmd/StatusPill.tsx`.

Architect picks `StatusPill` over `FilterChip` / `KbdHint`:

- `StatusPill` takes a `status` prop and renders different text/colors based on the `statusLabel(status)` lookup. There's something to assert beyond "the component renders".
- It uses `useCmdColors()` (a context-backed hook) — exercising it confirms the architect-prescribed `tests/jest.setup.ts` global setup wires theme/color providers correctly OR that the component renders standalone (it does, because the hook reads from a fallback when no provider is present).
- It uses `react-native-svg` indirectly through theme tokens. If `react-native-svg` is missing from `RN_TRANSPILE_DEPS` (section 2), this test fails fast with a clear "Unexpected token 'export'" — a useful canary for the transformIgnorePatterns config.

**Assertions** (architect-prescribed):

1. Rendering with `<StatusPill status="ok" />` shows the default `statusLabel('ok')` text.
2. Rendering with `<StatusPill status="warn" label="Custom" />` shows `'Custom'` (the `label` override prop wins).
3. The container's `accessibilityRole` / `testID` (whichever the developer adds during this work — the existing component has neither; adding a `testID="status-pill"` is acceptable as part of the test) is findable via `getByTestId('status-pill')`.

**Hybrid mocking demonstration**: `StatusPill` does NOT call `src/lib/db.ts`,
so it doesn't demonstrate the boundary mock by itself. The spec AC requires
"the component test demonstrates the hybrid mocking pattern". Architect's
prescription: **add a second component test file** that does. Suggested
target: `src/components/cmd/Avatar.test.tsx` IF `Avatar` reads from `db.ts`,
otherwise a hand-rolled tiny test that imports a `useStore` slice and
asserts the hook returns a mocked-`db.ts` value. Specifically:

```ts
// pseudo-shape (developer to author)
jest.mock('@/lib/db', () => ({
  fetchInventory: jest.fn().mockResolvedValue([{ id: 'i1', name: 'mocked' /* ... */ }]),
}));
// ... import the store, call its loader action, assert state mutated.
```

If the developer finds that `useStore` is hard to test in isolation
(very plausible — it's 51 KB with cross-slice coupling), they SHOULD
surface that as a follow-up question per CLAUDE.md "Refactoring
`src/store/useStore.ts` … out of scope" rather than refactoring. In that
case, the hybrid-mock demonstration moves to the `tests/README.md` as a
documented *pattern* with a minimal in-file example, and the AC is met
by the documentation rather than a passing component test.

#### Track 2 RPC example

**Target**: `supabase/tests/report_run_cogs.test.sql`.

Architect picks `report_run_cogs` (spec 017's RPC) because:

- It has both a positive path (return uniform envelope) and a clean negative path (`raise exception ... 42501` on unauthorized store).
- The migration `20260511120000_report_run_cogs.sql` is recent (2026-05-11) and the dev rev'd through architect review — high confidence that the contract documented in the migration is what's actually deployed.
- The dispatcher `report_run('cogs', ...)` is the same RPC the frontend calls in `db.runReport` ([src/lib/db.ts:1907](src/lib/db.ts)), so the test exercises the public-facing contract.

**Assertions** (architect-prescribed, pgTAP):

1. **Auth gate**: as a non-admin user with NO `user_stores` row for a target store, `report_run_cogs(<that-store>, '{}'::jsonb)` raises SQLSTATE `42501`. Use `throws_ok()`.
2. **Envelope shape**: as an admin (`set_config('request.jwt.claims', '{"role": "service_role"}', true)` or as a user with `user_stores` membership), calling the RPC returns a `jsonb` object with keys `kpis`, `columns`, `rows`, `series` — use pgTAP `has_jsonb_keys()` or assert each `?` test individually.
3. (Optional 3rd, if seed data supports it) `columns` array has 5 elements when `by = 'category'` (default), 6 when `by = 'item'`.

**Out of scope for v1**: full-numeric COGS%-correctness assertions. Those
are the follow-up coverage spec — they require curated seed data with
predictable revenue/cost values. The v1 test only proves the RPC's
**contract shape** and **auth gate** — exactly the two things that, if
broken, would silently corrupt the report UI.

#### Track 2 RLS / trigger example

**Target**: `supabase/tests/inventory_counts_submitted_by_override.test.sql`.

Architect picks the `inventory_counts_set_submitted_by` trigger (spec 020,
migration `20260513120000_inventory_counts_consistency.sql:54-70`) because:

- It's the most recent attribution-forgery fix and the test-engineer agent has flagged similar concerns repeatedly.
- The assertion is **mechanical** — INSERT a row with a forged `submitted_by`, then SELECT it back and confirm the column equals `auth.uid()`, not the forged value. No business-logic interpretation needed.
- It exercises both RLS and the trigger together, exactly the integration the framework needs to prove it can test.

**Assertions** (architect-prescribed, pgTAP):

1. **Trigger overrides forged `submitted_by`**: as user A (a member of store X), `insert into inventory_counts (store_id, kind, submitted_by, ...) values ('<store-X>', 'spot', '<user-B>', ...)`. Then `select submitted_by from inventory_counts where id = <returned-id>`. Assert the value equals `<user-A>` (not `<user-B>`). Use `is()`.
2. **RLS prevents cross-store INSERT**: as user A (member of store X only), attempt `insert into inventory_counts (store_id, ...) values ('<store-Y>', ...)`. Assert the insert raises SQLSTATE `42501` or returns zero rows depending on RLS USING vs WITH CHECK behavior. Use `throws_ok()`.

#### Track 3 shell smoke example

**Target**: `scripts/smoke-rpc.sh`.

Architect's pick: smoke `report_run` with `template_id = 'cogs'` against the
**local** stack (default). Reasons:

- COGS is the most-complex template the runner ships. If it loads and returns a non-error envelope, the simpler templates very likely do too.
- The script can run without a real admin session token by hitting `/rest/v1/rpc/report_run` with the local `service_role` key. CI does NOT run smoke scripts per spec AC, so the local-only posture is fine.
- Mirrors the `smoke-edge.sh` shape exactly — same `pass`/`fail`/`skip` printf helpers, same `SUPABASE_URL` env override.

**Single PASS/FAIL check** (architect-prescribed):

1. POST to `/rest/v1/rpc/report_run` with body `{ "p_template_id": "stub", "p_store_id": "<known-seed-store-uuid>", "p_params": {} }`. Expect HTTP 200, response body is JSON, has keys `kpis`/`columns`/`rows`/`series`.

Picked `'stub'` over `'cogs'` for the v1 smoke because `stub` always returns
a fixed-shape envelope independent of seed data — so the smoke script
stays stable as the seed evolves. The follow-up coverage spec can replace
this with a real-data COGS smoke once a fixture seed is curated.

### 10. Out-of-scope confirmations (architect agrees)

- **No `src/lib/db.ts` changes** for this spec — confirmed.
- **No migrations** for this spec — confirmed; pgTAP is per-test `create extension if not exists` to avoid leaking into prod.
- **No `app.json` slug touch** — confirmed (CLAUDE.md off-limits).
- **No edits to legacy files** (`useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, `AdminScreens.tsx`, `npm run db` script) — confirmed.
- **No new edge functions, no `verify_jwt` toggle** — confirmed.
- **No realtime publication changes** — confirmed.

### 11. Risks and tradeoffs

1. **jest-expo 54 + React 19 + RN 0.81 is bleeding-edge.** `@testing-library/react-native@13` only landed mid-2025 and has had peer-dep churn. **Mitigation**: pin majors per section 1, document `--legacy-peer-deps` as a fallback in `tests/README.md`. Risk of a follow-up "bump testing libraries" spec is medium — accept it.

2. **CI's `supabase start` cold-boot is ~60-90s.** On a busy day with concurrent PRs this is the dominant CI time. **Mitigation**: do NOT add the DB job to PR-blocking required-status-checks in v1 (the workflow runs but a developer can still merge if it's slow / flaky on first land). Tighten once stability is observed.

3. **pgTAP availability in the Supabase Postgres image is *assumed*.** If a future Supabase image bump drops it, every DB test breaks. **Mitigation**: `tests/README.md` documents `select extversion from pg_extension where extname = 'pgtap';` as the sanity check; if it returns empty, contributors install it manually with `create extension pgtap;` and file an issue.

4. **`transformIgnorePatterns` list will go stale.** Each new RN/Expo dep added to `package.json` may need adding to `RN_TRANSPILE_DEPS`. **Mitigation**: a test that imports `react-native-svg` and `react-native-toast-message` (already in the v1 example component test) gives early-warning. Document the symptom + the fix in `tests/README.md`.

5. **The "hybrid mocking pattern" demonstration may pull the test into `useStore.ts`-as-system-under-test territory.** CLAUDE.md forbids refactoring `useStore.ts` for testability. **Mitigation**: section 9's "Track 1 component" notes the fallback — if the boundary-mock demo is too invasive, it lands as documentation in `tests/README.md` instead of as a passing test. AC reading: "demonstrates the pattern" is met by code OR by documentation.

6. **Workflow-scoped token issue (CLAUDE.md).** The previous workflow push hit a token-permission failure. Spec AC explicitly says the file is committed locally and the user pushes manually if needed. Agents do not retry — confirmed.

7. **Seed-data drift.** The Track 2 examples assert against known seed IDs (stores, users). When the seed gets refreshed (next prod-mirror pull), those IDs change. **Mitigation**: tests use `select id from public.stores where name = 'Frederick' limit 1` style lookups rather than hardcoded UUIDs. Documented in the prescribed shape in section 5. (Note: the seed's "Frederick" store name is stable — the IDs are not.)

### 12. Frontend store impact

None. This spec adds tooling and example test files only. No
`src/store/useStore.ts` slice changes, no optimistic-then-revert touch.

### 13. Realtime impact

None. No `supabase_realtime` publication membership changes; no
`docker restart supabase_realtime_imr-inventory` deploy/dev step
introduced or removed by this spec.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement Spec 022 against the design above. Backend-developer
  owns: `jest.config.js`, `tsconfig.test.json`, `package.json` script +
  dep adds, `tests/jest.setup.ts`, `scripts/test-db.sh`,
  `scripts/smoke-rpc.sh`, `.github/workflows/test.yml`, the two
  `supabase/tests/*.sql` example tests (RPC + RLS), and the
  `tests/README.md`. Frontend-developer owns: `src/utils/relativeTime.test.ts`,
  `src/components/cmd/StatusPill.test.tsx`, and (if feasible per section
  9) the hybrid-mocking demo file; otherwise documents the pattern in
  `tests/README.md`. After implementation set `Status: READY_FOR_REVIEW`
  and list files changed under `## Files changed`.
payload_paths:
  - specs/022-test-framework-intro/spec.md

## Files changed (backend-developer)

### Tooling + config
- `package.json` — added jest / jest-expo / testing-library / react-test-renderer / @types/jest devDeps; added `test`, `test:db`, `test:smoke`, `test:all`, `typecheck:test` scripts.
- `package-lock.json` — regenerated by `npm install` for the new devDeps.
- `jest.config.js` (new) — projects split (unit/node + component/jsdom), `transformIgnorePatterns` allow-list per architect §2, `moduleNameMapper` for `@/*` alias, `modulePathIgnorePatterns` to skip stale `.claude/worktrees/` haste collisions.
- `tsconfig.json` — added `"exclude": ["**/*.test.ts", "**/*.test.tsx", "tests/**/*"]` so Expo's bundler doesn't graph-walk test files.
- `tsconfig.test.json` (new) — extends base, adds `["jest", "node"]` types, includes only test files.
- `tests/jest.setup.ts` (new) — global stubs for `react-native-toast-message` and `@react-native-async-storage/async-storage` per architect §2. NOT mocking supabase/db.ts here (per architect's anti-pattern guidance).

### DB tests (Track 2)
- `scripts/test-db.sh` (new) — walks `supabase/tests/*.test.sql`, runs each via `docker exec ... psql -f`, parses pgTAP TAP output. Divergence from architect §4: `pg_prove` is not in the local Supabase Postgres image (verified), so the wrapper invokes psql directly. Each test file owns its own `begin; ... rollback;` framing.
- `supabase/tests/report_run_cogs.test.sql` (new) — pgTAP test: auth-gate raises 42501 for foreign store; envelope shape has `kpis`/`columns`/`rows`/`series`. 5 assertions, all passing locally.
- `supabase/tests/inventory_counts_set_submitted_by.test.sql` (new) — pgTAP test: BEFORE INSERT trigger overrides forged `submitted_by` with `auth.uid()`. 3 assertions, all passing locally.

### Shell smoke (Track 3)
- `scripts/smoke-rpc.sh` (new) — smokes `report_run('stub', ...)` against the local stack. Logs in as `admin@local.test` rather than using service_role JWT, because `auth_is_admin()` reads `app_metadata.role` (not the top-level JWT `role` claim).

### CI
- `.github/workflows/test.yml` (new) — push + pull_request triggers; `jest` job (Track 1) and `db` job (Track 2 via `supabase/setup-cli@v1` + `supabase start`). YAML validated.

### Docs
- `tests/README.md` (new) — canonical three-track docs per architect §8: hybrid mocking strategy, how to run / add tests for each track, troubleshooting (transformIgnorePatterns drift; edge runtime bind-mount gotcha verbatim from CLAUDE.md), follow-up coverage target list pointing at Criticals from specs 016 / 018 / 019 / 020 / 021.
- `CLAUDE.md` — one-line edit per architect §8: replaced "No test framework" entry in "Gaps and unknowns" with a pointer to `tests/README.md`.

### Caveats surfaced to reviewers
- **`@testing-library/jest-native` is deprecated.** `npm install` warns: "Please use the built-in Jest matchers available in @testing-library/react-native v12.4+." The package still installs and works; architect pinned it explicitly in §1. Follow-up spec can swap to built-in matchers and drop the dep.
- **`pg_prove` divergence.** Architect §4 names `pg_prove`; the local Supabase Postgres image (verified 2026-05-13) does NOT ship it. `scripts/test-db.sh` falls back to raw `psql -f` + TAP-output parsing. Hermetic isolation, pass/fail summary, and CI behaviour are equivalent. Documented in `tests/README.md` § "Divergence from the architect's prescribed shape".
- **Service-role smoke divergence.** Architect §9 sketched `service_role` as the bearer token for `smoke-rpc.sh`. This repo's `auth_is_admin()` / `auth_can_see_store()` helpers read `app_metadata.role` from the user JWT — they do NOT honour the PostgREST top-level `role=service_role` claim. The smoke script logs in as `admin@local.test` instead, matching the `smoke-edge.sh` pattern. Same end-state (an authorized caller hits the stub runner and gets 200 + envelope).
- **Workflow-scoped token caveat (pre-existing per CLAUDE.md).** `.github/workflows/test.yml` is committed on disk; user pushes manually if the workflow-scoped token issue persists. Agents did not retry.
- **`README.md` left untouched.** The architect §6-end suggested updating README's stale `db-migrations-applied.yml` reference. The user-supplied task explicitly overrode this ("DO NOT touch it; leave for a separate user decision per CLAUDE.md"), so README is untouched in this PR.

## Files changed (frontend-developer)

### Track 1 example tests
- `src/utils/relativeTime.test.ts` (new) — Spec 022 §9 Track-1 unit example. 9 assertions locking the current behaviour of `relativeTime()`: epoch-ms / Date / ISO-string inputs all collapse to `<n><suffix>`; `null` / `undefined` / unparseable inputs return `''`. Uses `jest.useFakeTimers().setSystemTime(...)` so the assertions are deterministic across machines + clocks. Discovered during impl: `date-fns` strict mode rounds 90 s to "2 minutes" (round-nearest, not round-down) — assertion adjusted to lock the real behaviour rather than the architect's (untested) suggestion. All 9 tests pass green under `npm test`.
- `src/components/cmd/StatusPill.test.tsx` (new) — Spec 022 §9 Track-1 component example. 5 assertions: each of the four `Status` values (`ok` / `low` / `out` / `info`) renders the right `statusLabel(...)` text; the `label` override prop wins over the default and the default does NOT also appear. Uses `@testing-library/react-native` `render` + `getByText` / `queryByText` per the architect's anti-pattern guidance (no manual `react-test-renderer` snapshots). All 5 tests pass green under `npm test`.

### Hybrid mocking demonstration
- **Implemented as test-level mock** (architect §9 fallback path). The `StatusPill.test.tsx` file mocks `src/theme/colors` because the component's `useCmdColors()` hook transitively imports `useStore → db.ts → supabase.ts`, and `supabase.ts` crashes at import time without `EXPO_PUBLIC_SUPABASE_URL`. The architect's "mock at the `db.ts` boundary" pattern from `tests/README.md` is the prescribed shape for components that *use* `db.fetch*` helpers; `StatusPill` does not, so the demo lives in `tests/README.md` as a documented pattern with a working code sample (NOT a real wired test). Per architect §11.5 ("the hybrid-mocking pattern demonstration may pull the test into useStore-as-system-under-test territory") and CLAUDE.md ("Refactoring `src/store/useStore.ts` ... out of scope") — documentation-only demonstration is the architect-sanctioned outcome.

### Docs
- `tests/README.md` — appended a "Transitive store-import gotcha" subsection under the hybrid-mocking strategy. Captures the `useStore → supabase.ts` import chain that any component touching `useCmdColors` / `useColors` will hit at jest import time, plus the prescribed test-level theme-hook mock as the canonical fix. Future test authors hit this wall once; the doc keeps them from re-discovering it.

### Caveats surfaced to reviewers (frontend)
- **`npm run typecheck:test` reports pre-existing errors in `src/store/useStore.ts` and `src/lib/webPush.ts`.** Verified these errors also appear in plain `npx tsc --noEmit` (i.e. they exist on `main` before this spec touched anything). The `tsconfig.test.json` extends the base config and so the test-program walks the same source graph; nothing introduced here triggers them. Backend-dev's spec wording explicitly says `typecheck:test` is "for editor + on-demand verification, not a CI gate", so this is non-blocking. Follow-up: a separate cleanup spec for the store / webPush type drift would unblock `typecheck:test` from being a CI-enforceable gate.
- **No FE config changes needed.** Backend-dev's `jest.config.js`, `tests/jest.setup.ts`, and `tsconfig.test.json` worked as-shipped for both new test files. `transformIgnorePatterns` already covered every dep the component test transitively pulled in (verified by the StatusPill test passing without "Unexpected token export" errors). No patches requested.
