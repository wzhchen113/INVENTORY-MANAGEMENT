# Tests

Canonical docs for the test-framework infrastructure landed in
[spec 022](../specs/022-test-framework-intro/spec.md). Three independent
tracks, each covering a different layer:

| Track | What it covers                                            | Runner               | Where tests live                          |
| ----- | --------------------------------------------------------- | -------------------- | ----------------------------------------- |
| 1     | JS / TS unit + component (React Native) tests             | jest (jest-expo)     | colocated `*.test.ts(x)` next to source   |
| 2     | Postgres RPC + RLS + trigger correctness                  | psql + pgTAP         | `supabase/tests/*.test.sql`               |
| 3     | End-to-end RPC / edge-function shell smokes              | bash + curl + jq     | `scripts/smoke-*.sh`                      |

Tracks 1 and 2 plus the Track-1a and Track-1b typecheck gates run in CI
on every push and pull-request
([`.github/workflows/test.yml`](../.github/workflows/test.yml)). The
Track-1a typecheck job (spec 024) runs `npm run typecheck:test` and
gates on the test-reachable subset of the active graph. The Track-1b
typecheck job (spec 025) runs `npm run typecheck` against the base
tsconfig and gates on the full active app graph — closing the spec 024
§Q5a corollary coverage gap on the four Cmd UI component files surfaced
only by the base graph. Track 3 is manual-run only in v1, matching the
existing `scripts/smoke-edge.sh` posture.

## TL;DR — how to run each track locally

```bash
# Track 1 — jest (no docker required)
npm test

# Track 2 — DB tests (requires `npm run dev:db` running)
npm run test:db

# Track 3 — shell smokes (requires `npm run dev:db` running)
npm run test:smoke              # runs smoke-edge.sh, smoke-rpc.sh, smoke-edge-roles.sh

# Everything jest + DB:
npm run test:all
```

There is also a typecheck-only pass for tests. Spec 024 promoted this
from an editor-convenience script to a required CI gate (Track 1a above);
the same `npm run typecheck:test` invocation runs locally and in CI:

```bash
npm run typecheck:test
```

Spec 025 added a sibling `typecheck` script that runs against the base
tsconfig (Track 1b — the full active app graph, excludes
`supabase/functions/**`, `scripts/**`, and the test exclusions inherited
from Track 1a). Run locally before opening a PR:

```bash
npm run typecheck
```

The two scripts cover overlapping but distinct slices: `typecheck:test`
includes `tsconfig.test.json`'s test-only types (jest globals, etc.)
and rebases the include array to the test-reachable files; `typecheck`
runs the production-shaped graph excluding tests entirely.

## Hybrid mocking strategy (spec 022 Q6 = D)

The rule across the three tracks:

| Tier                                  | Boundary for stubbing                          | Rationale                                                                                                                |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Track 1 unit tests (`src/utils/...`)  | Mock at the **module under test's collaborators**, not at `db.ts` (units rarely touch DB). | Keeps unit tests truly unit-scoped.                                                                                       |
| Track 1 component tests               | Mock at the **`src/lib/db.ts` boundary**.       | One layer up from `supabase.ts` and one layer down from the screen. Re-implementing the Supabase client in a stub is the anti-pattern. |
| Track 2 DB tests                      | **No mocks.** Real local Supabase via `docker exec supabase_db_imr-inventory psql`.        | DB tests exist to catch RLS / trigger / RPC drift; mocking would undo the whole point.                                    |
| Track 3 shell smokes                  | **No mocks.** Real local stack via curl.        | Same as Track 2 — smoke-tests are end-to-end by definition.                                                               |

Concrete example for a component test (target: a screen or component
that loads data via `db.fetchInventory(...)`):

```ts
// src/screens/cmd/sections/InventorySection.test.tsx
jest.mock('@/lib/db', () => ({
  fetchInventory: jest.fn().mockResolvedValue([
    { id: 'i1', name: 'Mocked Item', /* ... */ },
  ]),
}));

import { render, waitFor, screen } from '@testing-library/react-native';
import { InventorySection } from './InventorySection';

test('renders the inventory list', async () => {
  render(<InventorySection storeId="00000000-0000-0000-0000-000000000001" />);
  await waitFor(() => {
    expect(screen.getByText('Mocked Item')).toBeOnTheScreen();
  });
});
```

**Do NOT** mock `src/lib/supabase.ts` for component tests — that's the
layer the architect rejected, because every component test would then
have to re-implement chained-builder semantics (`.from().select().eq()...`)
in the stub. The `src/lib/db.ts` boundary is one layer up and presents
a small set of named functions that are trivial to stub.

### Transitive store-import gotcha

If your component pulls a theme hook (e.g. `useColors()` /
`useCmdColors()` from [`src/theme/colors.ts`](../src/theme/colors.ts))
that *reads from `src/store/useStore.ts`*, the entire store import
graph — including `src/lib/db.ts` → `src/lib/supabase.ts` — comes along
for the ride. `src/lib/supabase.ts` crashes at import time when
`EXPO_PUBLIC_SUPABASE_URL` is unset (jest runs without `.env`).

**Decision tree — first thing to try when adding a component test** (spec 023 / B5):

1. **Prefer extracting the testable logic OUT of the component** so the
   store-import chain is never imported. This is the cleanest cut and
   produces a unit test that runs in the `node` env (no jsdom +
   RN-bridging overhead). Canonical example:
   [`src/utils/seedVarianceDates.test.ts`](../src/utils/seedVarianceDates.test.ts)
   — the helper was carved out of
   [`src/components/cmd/NewReportModal.tsx`](../src/components/cmd/NewReportModal.tsx)
   in spec 023 / B4 specifically to serve as the wired reference example
   of the [`src/lib/db.ts`-boundary mock pattern](#hybrid-mocking-strategy-spec-022-q6--d).
2. **If extraction isn't possible**, mock the theme hook at the test
   level. Canonical example:
   [`src/components/cmd/StatusPill.test.tsx`](../src/components/cmd/StatusPill.test.tsx)
   — see snippet below.
3. **If a future spec introduces a `<ThemeProvider>`**, the mock
   collapses to wrapping `render()` with the provider and the per-test
   stub goes away. Not on disk yet; documented for the future architect
   so the option doesn't get forgotten.

**Fix (option 2 above) — mock the theme hook in the test file** rather
than fighting the chain. CLAUDE.md forbids refactoring `useStore.ts`
for testability and the Spec 022 anti-pattern table forbids mocking
`supabase.ts` directly. The theme module is the cleanest cut point:

```ts
// src/components/cmd/StatusPill.test.tsx
jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    ok: '#3B6D11', okBg: '#EAF3DE',
    warn: '#854F0B', warnBg: '#FAEEDA',
    danger: '#791F1F', dangerBg: '#FCEBEB',
    info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));
```

Only re-export the keys + helpers the component under test actually
reads.

## Track 1 — jest (JS / TS)

Layout (hybrid colocation, spec 022 Q3 = C):

```
src/
  utils/
    relativeTime.ts
    relativeTime.test.ts            ← lives next to the function it tests
  components/
    cmd/
      StatusPill.tsx
      StatusPill.test.tsx           ← lives next to the component it tests
```

Two jest **projects** are configured in [`jest.config.js`](../jest.config.js):

- **unit** — `testEnvironment: 'node'`, picks up `src/utils/**/*.test.ts`,
  `src/lib/**/*.test.ts`, `src/store/**/*.test.ts`, `src/hooks/**/*.test.ts`.
  Fast — no DOM / RN bridging.
- **component** — `testEnvironment: 'jsdom'`, picks up
  `src/components/**/*.test.tsx`, `src/screens/**/*.test.tsx`. Slower but
  RN-aware via the `jest-expo` preset.

Platform-specific filename suffixes (`.web.test.tsx` / `.native.test.tsx`)
are honoured by the `jest-expo` preset's default resolver. v1 does not
ship a platform-specific example; the convention is documented for future
use only.

### How to add a new jest test

1. Create the file next to the source: `Foo.tsx` → `Foo.test.tsx`.
2. Import the symbol(s) under test by either relative path or the `@/`
   alias; both work via `moduleNameMapper` in `jest.config.js`.
3. If the source touches `react-native-toast-message` or
   `@react-native-async-storage/async-storage`, do nothing special — the
   global setup in [`tests/jest.setup.ts`](./jest.setup.ts) stubs both.
4. If the source touches `src/lib/db.ts`, mock at that boundary in the
   test file — see the hybrid-mocking example above.

### Store-action tests (spec 033)

Zustand store actions (`useStore`-slice mutations) get their own jest
shape:

- **State isolation.** Snapshot the initial store state at module-eval
  via `const INITIAL_STATE = useStore.getState();` (captured AFTER
  `jest.mock` hoists). Restore in `beforeEach` via
  `useStore.setState(INITIAL_STATE, true)` — the `true` flag triggers a
  full replace; without it Zustand merges nested objects and the reset
  is partial.
- **Mock boundaries.** Mock `../lib/supabase` to prevent the env-var
  crash at module-eval (same shape `src/lib/auth.test.ts` uses). Mock
  `../lib/db` with minimal stubs for whichever helpers the action under
  test calls. Mock `../lib/auth` if the action dynamically imports it.
- **Dynamic-import gotcha.** `useStore.deleteProfile` uses
  `await import('../lib/auth')` so the auth module isn't pulled into
  every consumer. `babel-preset-expo` preserves `import('x')`
  expressions for Metro chunking, so jest's mock registry doesn't catch
  them by default. The in-tree
  [`tests/babel-jest-dynamic-import.js`](./babel-jest-dynamic-import.js)
  transformer (wired in `jest.config.js`) rewrites literal-source
  dynamic imports to `Promise.resolve(require('literal'))` so
  `jest.mock` interception works. No new dev-dependency added.
- **Reference example.**
  [`src/store/useStore.test.ts`](../src/store/useStore.test.ts) — three
  cases for `deleteProfile`'s silent-toast branch (default fires the
  store toast, `{ silent: true }` suppresses it, error path still toasts
  via `notifyBackendError`).

### When NOT to add a jest test

- Logic that's purely a DB constraint, trigger, or RLS policy → Track 2.
- Behaviour that requires the real edge runtime → Track 3.
- Visual / layout regression — out of scope in v1, deferred to a future
  spec.

### Troubleshooting

- **"Unexpected token 'export'" or "Cannot use import statement outside a
  module"** from inside a `react-native-*` or `expo-*` dep: add that
  package to `RN_TRANSPILE_DEPS` in [`jest.config.js`](../jest.config.js).
  The list is the **allow-list** of node_modules that jest IS allowed to
  transform; jest's default is to skip all of `node_modules/`.
- **Peer-dep resolution warning on `@testing-library/react-native`**: the
  v13 major lines up with React 19; v12 peers on React 18 and will
  warn/fail. If `npm install` refuses to resolve v13, run it once with
  `--legacy-peer-deps`. Subsequent installs are clean.
- **Test runs hang inside `react-native-reanimated`**: reanimated needs
  its own jest mock; if a future test touches a reanimated-driven
  component, add the package's official mock to `tests/jest.setup.ts`.
  Not needed for the v1 example tests.

## Track 2 — Supabase DB tests (pgTAP)

Test files live under [`supabase/tests/`](../supabase/tests/) with the
naming pattern `<descriptive-name>.test.sql`. Two example tests ship in
v1:

- [`report_run_cogs.test.sql`](../supabase/tests/report_run_cogs.test.sql)
  — proves the auth gate (42501 for a foreign store) and the envelope
  shape (`{ kpis, columns, rows, series }`).
- [`inventory_counts_set_submitted_by.test.sql`](../supabase/tests/inventory_counts_set_submitted_by.test.sql)
  — proves the BEFORE INSERT/UPDATE trigger that closes the
  attribution-forgery vector on `inventory_counts.submitted_by` (spec
  019 round-2).

### Hermetic isolation pattern (spec 022 §5)

Each `.sql` file owns its own transaction frame plus pgTAP `plan(N) ...
finish()`:

```sql
begin;
create extension if not exists pgtap;
select plan(N);

-- ─── fixtures ──────────────────────────────────────────────────
-- ... lookup seed UUIDs by stable names (NOT hardcoded UUIDs that
-- drift when the seed gets refreshed), set JWT claims via
-- set_config('request.jwt.claims', ...).

-- ─── assertions ────────────────────────────────────────────────
select is(actual, expected, 'description');
select throws_ok(query, sqlstate, message_substring, 'description');

select * from finish();
rollback;
```

Notes:

- `plan(N)` is non-optional. A file that runs fewer or more assertions
  than declared **fails** — this is what catches silently-dropped
  assertions.
- The rollback is the absolute reset. The 286 KB seed is the substrate;
  tests never seed their own data when an equivalent row already exists.
- For RLS-touching tests, the JWT claim shape is:
  ```sql
  select set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '<user-uuid>',
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('role', 'user')  -- or 'admin' / 'master'
    )::text,
    true
  );
  ```
  The `auth.uid()` reads `sub`; `auth_is_admin()` reads
  `app_metadata.role`. `set_config(..., true)` is transaction-local so
  the rollback cleans it up too.

### Running

```bash
npm run dev:db                          # boot the local stack first
npm run test:db                         # walks supabase/tests/*.test.sql

# Or run one file:
bash scripts/test-db.sh supabase/tests/report_run_cogs.test.sql
```

[`scripts/test-db.sh`](../scripts/test-db.sh) shells out to `docker exec
supabase_db_imr-inventory psql -f -` for each file. The wrapper parses
pgTAP's TAP output and counts passes / fails per file.

### Divergence from the architect's prescribed shape

The spec's `## Backend Architecture` §4 names `pg_prove` as the runner.
The local Supabase Postgres image as of 2026-05 ships the `pgtap`
extension SQL functions but does **not** ship the `pg_prove` shell binary
(verified via `command -v pg_prove`). Rather than install pg_prove or
fall back to `supabase test db` (which architect §4 explicitly rejected),
[`scripts/test-db.sh`](../scripts/test-db.sh) uses raw `psql -f` and
inspects pgTAP's own TAP output (`ok N`, `not ok N`, `# Looks like you
failed`). Same hermetic isolation, no new binary required. If a future
Supabase image bump ships pg_prove, the wrapper can be simplified to the
two-line `docker exec ... pg_prove ...` form architect §4 sketched.

### pgTAP install path

pgTAP 1.3.3 ships with the local Supabase Postgres image (verified
2026-05-13). Each test file's first line is `create extension if not
exists pgtap;` — cheap when already installed, self-healing when not. No
migration adds the extension because we don't want the testing extension
leaking into prod.

Sanity check the extension is available:

```bash
docker exec supabase_db_imr-inventory \
  psql -U postgres -d postgres \
  -c "create extension if not exists pgtap; \
      select extversion from pg_extension where extname='pgtap';"
```

### How to add a new DB test

1. Pick a name: `supabase/tests/<short-thing-being-asserted>.test.sql`.
2. Frame the file with the `begin; ... finish(); rollback;` shape above.
3. Look up seed data by **name**, not hardcoded UUID
   (`select id from public.stores where name = 'Frederick' limit 1`).
   Seeds get refreshed; UUIDs drift.
4. Stash multi-statement values via `set_config('test.<key>', ..., true)`
   and read back with `current_setting('test.<key>', true)`. The
   transaction-local flag (third arg `true`) means rollback cleans these
   too.
5. If the assertion is about RLS / triggers, set
   `request.jwt.claims` to the appropriate user (see the shape above).
6. Run locally before opening the PR:
   `npm run test:db`.

### When NOT to add a DB test

- Logic that's purely TypeScript-side aggregation in `src/lib/db.ts` →
  Track 1 unit test, with the network mocked.
- Edge-function behaviour (Deno) → Track 3 smoke for now.

### Risks

The `supabase_db_imr-inventory` container name is the spec 022 default
because that's the project_id in
[`supabase/config.toml`](../supabase/config.toml). If a contributor
locally overrides the project_id, override `CONTAINER=` when invoking
the script:

```bash
CONTAINER=supabase_db_some-other-name npm run test:db
```

## Track 3 — Shell smokes

Manual-run scripts under `scripts/smoke-*.sh`. v1 ships three:

- [`scripts/smoke-edge.sh`](../scripts/smoke-edge.sh) — the original; CORS
  + JWT + happy-path checks for `fetch-breadbot-sales` edge function.
- [`scripts/smoke-rpc.sh`](../scripts/smoke-rpc.sh) — Spec 022 example;
  smokes `report_run('stub', ...)` against the local stack. Picks `stub`
  over `cogs` because the stub envelope is independent of seed data and
  therefore stable across seed refreshes.
- [`scripts/smoke-edge-roles.sh`](../scripts/smoke-edge-roles.sh) — Spec
  027; smokes the `send-invite-email` role gate with four arms (CORS
  preflight, no-auth 401, admin JWT, super_admin promoted JWT). Refuses
  to run against a non-local `SUPABASE_URL` because Arm 4 mutates state
  (`admin@local.test` → super_admin, reverted via EXIT trap).

```bash
npm run test:smoke               # runs all three
bash scripts/smoke-rpc.sh        # one of them
bash scripts/smoke-edge-roles.sh # the role-gate smoke
```

Each script accepts `SUPABASE_URL=` to point at a remote stack.
`smoke-rpc.sh` also accepts `ADMIN_TOKEN=` to skip the login round-trip
(useful when iterating against prod with a cached session).
`smoke-edge-roles.sh` accepts `ADMIN_BEARER=` and `SUPER_ADMIN_BEARER=`
to skip its login round-trips, plus `ADMIN_EMAIL=` / `ADMIN_PASSWORD=`.

### Track 3 troubleshooting — local edge runtime bind-mount

Copied verbatim from CLAUDE.md so smoke-script failures don't get
misdiagnosed:

> `supabase start` (via `npm run dev:db`) bind-mounts
> `<cwd>/supabase/functions/` into `supabase_edge_runtime_imr-inventory`
> at *container creation* time, not at every restart. If the stack was
> first booted from a since-deleted directory (e.g., a
> `.claude/worktrees/<name>/` worktree), the mount stays pinned there
> even after you `cd` back to the repo root and `docker restart`.
> Symptom: `pwa-catalog` and other edge functions return `503
> BOOT_ERROR` locally with otherwise unexplained "function source not
> found" errors in the runtime logs.
>
> **Sanity check before debugging an edge function locally:**
>
> `docker inspect supabase_edge_runtime_imr-inventory --format
> '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep functions`
>
> should print a path under the active repo root. If it points at
> `.claude/worktrees/` or any other stale path, run `npx supabase stop
> --no-backup && npm run dev:db` from the repo root to force a clean
> re-bind. Same shape as the realtime gotcha — `docker restart` alone
> won't help.

If a future smoke / DB test touches `supabase_realtime` publication
membership, also see CLAUDE.md > Realtime publication gotcha.

## CI

[`.github/workflows/test.yml`](../.github/workflows/test.yml) runs on
every push and every pull-request. Four jobs:

- **`jest`** — `actions/setup-node@v4` with node 20, `npm ci`, `npm test
  -- --ci`. Fails on any failing test.
- **`typecheck`** (spec 024 — Track 1a) — `actions/setup-node@v4` with
  node 20, `npm ci`, `npm run typecheck:test`. Gates on the
  test-reachable subset of the active graph (`tsc --noEmit -p
  tsconfig.test.json`).
- **`typecheck-base`** (spec 025 — Track 1b) — `actions/setup-node@v4`
  with node 20, `npm ci`, `npm run typecheck`. Gates on the full active
  app graph (`tsc --noEmit` against the base tsconfig). Exclusion set:
  `supabase/functions/**` (Deno-runtime URL imports), `scripts/**`
  (one-off ts-node), `**/*.test.ts(x)` + `tests/**` (covered by Track
  1a). Closes the spec 024 §Q5a corollary gap on the four Cmd UI
  component files surfaced only by the base graph.
- **`db`** — `supabase/setup-cli@v1`, `supabase start`, `npm run
  test:db`. The full local stack (~60-90s cold boot) is required because
  DB tests use `auth.uid()` through real JWT claims — a bare Postgres
  service container does not expose `auth.*`. The DB job is NOT a
  required status check in v1; tighten once stability is observed.

Track 3 is intentionally not wired into CI in v1 (per spec AC).

## Retroactive coverage status (spec 023)

The retroactive Critical-coverage gap from spec 022 §8 has been closed
by [spec 023](../specs/023-retro-test-coverage/spec.md). All 11
retroactive tests live under [`supabase/tests/`](../supabase/tests/) —
one `.test.sql` file per Critical, cited at the top of each file. Names
mirror the spec line; new tests follow the same hermetic-isolation
pattern documented above.

Future retroactive gaps land as their own specs; this section is the
landing page for "where is the test that pins X?".

## First follow-up Track 1 targets

- `src/utils/convertToItemUnit.ts` — replace the existing
  `scripts/test-unit-conversion.ts` with a proper jest test. Deletion of
  the legacy script is a one-line follow-up; spec 022 explicitly does
  NOT do it.
- `src/lib/db.ts` mapper functions — start with `mapItem` (the
  snake_case → camelCase pivot).
