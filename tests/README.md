# Tests

Canonical docs for the test-framework infrastructure landed in
[spec 022](../specs/022-test-framework-intro/spec.md). Four independent
tracks, each covering a different layer (Track 4 — browser E2E — added in
[spec 078](../specs/078-e2e-playwright-framework.md)):

| Track | What it covers                                            | Runner               | Where tests live                          |
| ----- | --------------------------------------------------------- | -------------------- | ----------------------------------------- |
| 1     | JS / TS unit + component (React Native) tests             | jest (jest-expo)     | colocated `*.test.ts(x)` next to source   |
| 2     | Postgres RPC + RLS + trigger correctness                  | psql + pgTAP         | `supabase/tests/*.test.sql`               |
| 3     | End-to-end RPC / edge-function shell smokes              | bash + curl + jq     | `scripts/smoke-*.sh`                      |
| 4     | Browser E2E — the running web app through a real browser  | Playwright (chromium) | top-level `e2e/*.spec.ts`                 |

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

# Track 4 — browser E2E (requires `npm run dev:db` running; boots the web
# server itself via playwright.config.ts `webServer`)
npm run e2e                     # headless chromium
npm run e2e:headed              # headed (watch the browser)
npm run e2e:ui                  # Playwright UI mode (time-travel debugger)

# Everything jest + DB:
npm run test:all
```

> **First-time E2E setup:** install the chromium browser binary once with
> `npx playwright install --with-deps chromium`. CI does this per-run.

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

## Track 4 — Browser E2E (Playwright)

Spec 078 added a fourth track: **browser E2E via Playwright**, run against
the **web build** (react-native-web → the same surface Vercel ships). Both
the admin Cmd UI and the staff EOD app run on react-native-web, so a single
web-target suite covers the vast majority of application logic — a real
signed-in session, the navigation shell, RLS, and the live Supabase stack
composing into a working flow. The other three tracks never exercise the
running app through a browser (component tests mock at the `src/lib/db.ts`
boundary).

### What it covers

Spec 078 landed the framework + broad-but-shallow v1 coverage; spec 079
deepened the highest-value flows from "does it render?" to "does it behave?"
and flake-proofed every spec (see the flake checklist below).

- **auth.** Real UI sign-in for the admin branch (lands on the Cmd shell) and
  the staff branch (`manager@local.test`, role=`user`, lands on the
  StorePicker), plus a bad-credentials case.
- **staff EOD + offline queue.** Online submit, then the offline → queue →
  drain cycle via `context.setOffline()` (the staff connectivity hook reads
  `navigator.onLine` / the DOM `online`/`offline` events on web, which
  `setOffline` flips). **Spec 079 deepenings:** (a) the online case now proves
  **persistence** — it reloads the same (store, vendor, today) and asserts the
  `eod-prefill-banner` ("Last submitted at HH:MM") renders, then does the
  suite's ONE service-role read (below) to confirm the row + the filled
  value; (b) a separate **scroll guard** at a 375×812 mobile viewport asserts
  the Submit footer stays in-viewport and the `eod-item-list` scrolls
  internally while the document body does not (the spec-072 react-native-web
  layout regression — jest cannot reproduce a viewport-sized DOM).
- **invite-user.** Master opens the Users section, fills the invite drawer,
  submits, and asserts the drawer closes on success. **Spec 079 deepening:** a
  **durable-effect** assertion that the run-unique invited email
  (`e2e-invite+<runId>@local.test`) renders as a row in the Users list —
  keyed off this run's email, never a row count.
- **dashboard / reorder / audit-log.** Read-heavy structural assertions (the
  section-root container renders), not seed-value assertions. **Spec 079
  deepening (reorder):** exercises the action surface that exists — clicks
  **Refresh** (outside the export gate; the guaranteed floor) and asserts the
  loading→loaded transition completes, and defensively asserts the CSV/PDF
  export controls are enabled when the selected store's reorder payload has
  vendors. No durable DB mutation is asserted (the Reorder section has none —
  no mark-ordered / generate-PO). No file-download event is asserted
  (excluded from v1 as a flake surface).
- **dark mode.** One `colorScheme: 'dark'` smoke that also seeds the
  `darkMode` localStorage pref and asserts the shell paints a dark background.
- **dashboard attention-queue weekly window** (`e2e/dashboard-window.spec.ts`,
  spec 080). Guards the spec-074 Monday-reset window on the per-store
  `unconfirmed_po` ("VENDOR order missed (DATE)") rows in a real browser — the
  integration-render layer over the ~8 deterministic jest tests
  (`cmdSelectors.unconfirmedPoWindow.test.ts` + `weekWindow.test.ts`, which pin
  the LOGIC and are untouched). FULL coverage: an in-window miss renders on the
  dedicated store's card (`toBeVisible`), and a before-this-Monday miss is
  FILTERED out (`toHaveCount(0)` — proving the window actually drops older
  misses, both directions). Un-blocked by spec 081, which made the dashboard
  rule genuinely per-store (`db.fetchOrderScheduleForStores` +
  `scheduleByStore[s.id]`), so a dedicated-store fixture deterministically
  drives its OWN card. Two isolation patterns this spec establishes for future
  date-windowed E2Es:
  - **Dedicated-store + date-scoped teardown.** The fixture creates a
    throwaway store (`SEED.e2eWindowStoreId`, brand `2a…01`, status active) and
    seeds `order_schedule` rows on the run-computed in/out-of-window weekdays —
    it does NOT reuse Towson / Frederick / Charles / Reisters because all four
    are pgTAP `missed_order_audit_rpc` fixture anchors, and a persisted
    `order_schedule` row on a shared store would be counted by a later local
    `record_missed_orders_for_day` pgTAP run (the exact cross-track collision
    `global-teardown.ts` exists to prevent). `global-teardown.ts` drops the
    dedicated store store-scoped + FK-ordered (children before parent), keyed on
    the dedicated id so it can never touch the four anchors. The fixture INSERT
    lives in the spec's `test.beforeAll` (NOT `global-setup.ts`) because the
    target dates are `now`-relative and the spec already imports the production
    `weekWindow.ts` helpers — co-locating setup with the date math keeps it in
    one file, while teardown stays centralized for hygiene.
  - **Positive-Monday assertion (reusable deterministic-clock-E2E note).** The
    spec-074 window `[thisMonday, today)` is EMPTY on Monday morning, so a
    naive in-window assertion would have nothing to assert 1/7 of CI days.
    Rather than `test.skip()` on Monday (which proves nothing that day), this
    spec asserts the windowed-EMPTY state — zero `unconfirmed_po` rows on the
    dedicated card even though it has a scheduled+unsubmitted vendor on the
    out-of-window date. That turns Monday into a genuine Monday-reset proof and
    keeps the guard meaningful every day. The `isMonday` branch is computed
    deterministically from the same `getWeekWindow` the fixture uses (flake
    checklist #2 — never a caught timeout). A future date-windowed E2E should
    follow this positive-empty pattern rather than skipping on the empty day.

### The single service-role read (the lone UI-only exception)

Every E2E assertion is UI-only / black-box EXCEPT one: the EOD persistence
case (`e2e/eod.spec.ts`) performs a single **service-role read** of
`eod_submissions` for (Towson, today, US FOOD) as a belt-and-suspenders proof
that the online submit persisted server-side. The `eod-prefill-banner` reload
assertion is the UI-only PRIMARY persistence signal; the service read is the
ONE precise spot-check on the highest-value persistence flow. It is the lone
exception to the UI-only rule and is **not a pattern to spread** — every other
spec stays black-box.

The read goes through `e2e/fixtures/db.ts` `serviceRoleClient()` — the shared
service-role client (LOCAL stack only, guarded by `assertLocalStack`) that
`global-setup.ts` (the order_schedule fixture) and `global-teardown.ts` also
use. Spec 079 EXTRACTED this helper from `global-setup.ts` into
`e2e/fixtures/db.ts` (a third consumer landed) — the client, the key, and the
prod-URL guard are unchanged; it was de-duplicated, not newly introduced. The
read keys off the (store, date, vendor) tuple + the value this run submitted
(not a row count), so it converges on a non-reset local DB — `staff_submit_eod`
upserts on that tuple, so a re-run overwrites rather than duplicates.

### Where tests live

A top-level **`e2e/`** directory (Playwright convention; keeps the config,
`.auth/` storageState, fixtures, and specs together and distinct from the
jest colocation + the `supabase/tests/` pgTAP files):

```
playwright.config.ts          ← repo root (Playwright's default discovery)
e2e/
  global-setup.ts             ← OQ-4 runtime fixture (order_schedule rows)
  auth.setup.ts               ← `setup` project: per-role storageState
  auth.spec.ts                ← Phase 1 sign-in smoke (AC-S1/S2/S3)
  eod.spec.ts                 ← Phase 2 EOD submit + offline queue
  invite.spec.ts              ← Phase 3 invite-user
  dashboard.spec.ts           ← Phase 4 dashboard
  dashboard-window.spec.ts    ← spec 080 attention-queue weekly-window guard
  reorder.spec.ts             ← Phase 4 reorder
  audit.spec.ts               ← Phase 4 audit log
  dark-mode.spec.ts           ← cross-cutting dark-mode smoke
  fixtures/constants.ts       ← seed UUIDs, demo accounts, storageState paths, SIDEBAR_NAV
  fixtures/db.ts              ← shared service-role client + assertLocalStack + todayIso (079)
  .auth/                      ← per-role storageState JSON (gitignored)
  tsconfig.json               ← scopes TS for the e2e tree (base excludes e2e/**)
```

### How to run locally

```bash
npm run dev:db                                      # 1. boot the local stack FIRST
npx playwright install --with-deps chromium         # 2. one-time browser binary
npm run e2e                                          # 3. run the suite
```

`npm run e2e` boots ONLY the Expo web dev server (via the config's
`webServer`), not the DB stack — the dev stack + its data are yours.
`e2e:headed` watches the browser; `e2e:ui` opens the time-travel debugger.
Cold Metro bundling is slow on the first run (the `webServer.timeout` is
180s); `reuseExistingServer` reuses a 8081 you already have up locally.

### Selector strategy: `testID` → `data-testid`

react-native-web maps RN `testID` props to the DOM `data-testid` attribute,
and the config sets `testIdAttribute: 'data-testid'`, so
`page.getByTestId('signin-email')` addresses an RN `testID="signin-email"`
directly. Spec 078 added the missing selectors on the login inputs, the Cmd
shell anchor, the Dashboard/Reorder/AuditLog/Users section roots, the Users
invite trigger, and the InviteUserDrawer fields (the EOD selectors already
existed). Spec 079 added the `nav-${item.id}` sidebar nav testIDs
(`nav-Dashboard` / `nav-Reorder` / `nav-AuditLog` / `nav-Users`), the
`eod-item-list` scroll-container testID, and the `reorder-export-csv` /
`reorder-export-pdf` / `reorder-refresh` action testIDs.

**Navigate by `getByTestId`, never `getByText`.** Section navigation in the
Cmd shell has no URL/linking; spec 078 originally clicked the stable sidebar
**label text**, but spec 079 replaced that with the `nav-*` testIDs
(`e2e/fixtures/constants.ts` `SIDEBAR_NAV`) — label text is i18n/copy-fragile
and can match a stray occurrence of the same string elsewhere on screen. The
ONE place a `getByText` is correct is the invite durable-effect assertion,
which matches the run-unique email the test itself created (test-authored
content, not chrome). The *assertion* targets are always testIDs.

### Data-isolation strategy

Runs against the local `dev:db` stack + the committed `supabase/seed.sql`
(same pattern as Tracks 2/3). The broad flows mutate data, so:

- **CI runs `supabase db reset` once before the suite** — a clean,
  deterministic seed every run. Locally, `npm run e2e` does NOT reset; local
  re-run safety comes from uniquification (below).
- **Invite uses a run-unique email** — `e2e-invite+<runId>@local.test` —
  so a local re-run doesn't collide on a prior run's invited user. The
  assertion keys off the success signal for that email, never a row count.
- **EOD keys off the same run's queued item** (its `client_uuid` + the
  queue-indicator state), which is naturally idempotent.
- **The `order_schedule` weekday fixture** (`e2e/global-setup.ts`) is an
  E2E-only runtime insert via a **service-role** client — NOT a seed edit.
  The committed seed has zero `order_schedule` rows, so the EOD "today"
  screen would otherwise render empty; the fixture schedules two vendors on
  Towson for all seven weekdays (idempotent `on conflict do nothing`) so the
  EOD specs always have vendor chips + items regardless of the run weekday.
  The service-role key is the LOCAL stack's well-known demo key, env-sourced
  (`SUPABASE_SERVICE_ROLE_KEY`), never committed, and only ever pointed at
  the local/CI stack.

### The poison-queue guard (storageState + the offline queue)

Playwright `storageState` serializes `localStorage`, and the staff offline
queue lives in `localStorage` under `imr-staff:eod-queue:v2` (bumped from
`:v1` in spec 086 when the queued `entries` shape gained Cases/Units). Two
guards keep a stale queue from poisoning later runs:

1. The **auth-setup never submits EOD**, so the saved `staff.json` carries
   auth tokens but no queue key.
2. The **EOD specs clear the queue key in `beforeEach`** (via
   `addInitScript`) — defense in depth.

If a future refactor moves the queue out of `localStorage` (e.g. to
IndexedDB), guard #2 must follow.

### Flake-proofing checklist (Track 4)

Every E2E spec MUST follow these. The suite must hold <5% flake to earn the
AC-PROMO1 promotion; one flaky spec blocks the 20-green streak for the whole
suite. (Spec 079 added this checklist as the durable artifact that keeps the
suite clean as it grows.)

1. **Navigate by `getByTestId`, never `getByText`.** Sidebar sections use the
   `nav-<SectionId>` testIDs (`nav-Dashboard`, `nav-Reorder`, `nav-AuditLog`,
   `nav-Users`). Label text is i18n/copy-fragile and can match a stray
   occurrence elsewhere on screen. Reference: `e2e/fixtures/constants.ts`
   `SIDEBAR_NAV`.
2. **No fixed `waitForTimeout`/sleep.** Use web-first auto-retrying assertions
   (`await expect(locator).toBeVisible()` / `.toHaveCount(0)` / `.toBeEnabled()`)
   or `expect.poll(...)` for non-DOM conditions (e.g. `navigator.onLine`).
   A fixed sleep is either too short (flake) or too slow (wasted CI time).
3. **Assert the destination before interacting.** After any navigation, assert
   the target `*-root` testID is visible before clicking inside it. Never
   assume "the click worked."
4. **Assert absence with `toHaveCount(0)`, never a timeout.** Proving a thing
   is gone (queue drained, drawer closed) uses `expect(locator).toHaveCount(0)`
   (auto-retries up to the expect timeout), not a sleep-then-check.
5. **Each test starts from clean per-test state.** Playwright gives each test a
   fresh `BrowserContext` (fresh localStorage). storageState carries auth ONLY
   (the setup project never submits EOD). The EOD specs additionally clear the
   offline-queue key (`imr-staff:eod-queue:v2`) in `beforeEach` via
   `addInitScript` — defense against localStorage bleed.
6. **Key mutating-flow assertions off THIS run's unique input, never an
   absolute row count.** Invite uses `e2e-invite+<runId>@local.test`; EOD reads
   the row for `(store, today, vendor)` and asserts presence + the value this
   run submitted. A non-reset local DB must not break a re-run.
7. **Reproduce viewport-specific layout at the right viewport.** The scroll
   guard runs at 375×812 (`test.use({ viewport })`); the default Desktop Chrome
   viewport would pass it vacuously.
8. **Service-role DB access stays in the `e2e/` tree** via
   `e2e/fixtures/db.ts` `serviceRoleClient()` (LOCAL-stack only, guarded by
   `assertLocalStack`). It is the lone exception to UI-only assertions and is
   used by exactly one assertion (EOD persistence). Do not spread it.

### CI + promotion criteria

[`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) runs on every
push and pull-request, **separate from `test.yml`** and **non-blocking** in
v1 (advisory — a red run does NOT block merge or SHIP_READY; the CLAUDE.md
"CI status check" rule is scoped to `test.yml` only). It mirrors `test.yml`'s
`db` job stack boot, runs `supabase db reset`, installs the chromium binary,
runs `npm run e2e`, and uploads the HTML report + traces as an artifact
(`if: always()`).

**Promotion to a required check (AC-PROMO1):** flip `e2e.yml` to gating only
when BOTH hold, on the user's call — **≥ 20 consecutive green runs on
`main`** AND **observed flake rate < 5%** (a run that goes green only on a
Playwright retry counts as a flake; `trace: 'on-first-retry'` makes retries
visible in the report). When promoted, the follow-up adds it to the
required-checks set and extends the CLAUDE.md CI rule to name `e2e.yml`.

### When NOT to add an E2E test

- Pure DB constraint / trigger / RLS behavior → Track 2.
- A unit of TypeScript logic with no browser surface → Track 1.
- Native-only behavior (true device gestures, native push registration) —
  out of scope; Playwright is web-only (locked decision).
- Visual-regression / screenshot diffs — intentionally deferred (RN-web
  pixel output is noisy across OS/font stacks).

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

Track 4 (browser E2E) runs in a **separate** workflow,
[`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) — NOT folded
into `test.yml` (locked decision). It is **non-blocking** in v1 (advisory
until the promotion criteria in the Track 4 section are met). See that
section for the boot/reset/artifact shape and the gating-flip rule.

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
