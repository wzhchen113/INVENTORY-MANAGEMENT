# Spec 033: useStore.test.ts harness + back-filled coverage

Status: READY_FOR_REVIEW

## User story

As the test-engineer reviewer (and as a future contributor adding a
Zustand-store action), I want a working `src/store/useStore.test.ts`
scaffold plus the back-filled jest coverage that specs 029-031 deferred,
so that:

1. The store layer stops being a "skip the test, can't stand up the
   harness" black hole — the next dev who adds a store action has a
   precedent file to copy.
2. The three load-bearing behaviors deferred by specs 029-031
   (`deleteProfile` silent branch, `UserRow.canDelete` role-gate matrix,
   `lastOfRole` derivation) are locked in by jest unit tests rather than
   relying only on code review + manual browser smoke.
3. The test-count gate rises from 35 to ~49, keeping the trajectory
   spec 022 / 023 set for the jest track.

This is a pure-test spec — no production code is added except a small
pure-helper module (`src/utils/userPermissions.ts`) that lifts the
already-existing `canDelete` and `lastOfRole` derivations out of
`UsersSection.tsx` so they become testable in isolation. The helper
module is a refactor with zero behavior change.

## Acceptance criteria

### Track 1 — `src/store/useStore.test.ts` harness

- [ ] **AC1.1** A new file `src/store/useStore.test.ts` exists and is
  picked up by the existing jest `unit` project (which already includes
  `<rootDir>/src/store/**/*.test.ts` per
  [jest.config.js:67](../../jest.config.js)). No `jest.config.js`
  change is required; the test-match glob already covers this path.

- [ ] **AC1.2** The harness mocks the **two** module-import boundaries
  that would otherwise blow up `node`-env jest at import time:
  - `jest.mock('../lib/supabase', () => ({ supabase: { ... stubbed ... } }))`
    — `src/lib/supabase.ts` reads `process.env.EXPO_PUBLIC_SUPABASE_URL`
    at module-eval time and crashes when unset (jest runs without
    `.env`). Same boundary `src/lib/auth.test.ts` mocks.
  - `jest.mock('../lib/db', () => ({ ...named exports stubbed... }))` —
    every action in `useStore.ts` that calls `db.fetchX` /
    `db.insertX` / `db.deleteX` must resolve through the mock instead
    of a real network call. The mock surface only needs to cover the
    named exports the tests exercise (test-engineer's call which —
    keep the mock surface minimal per spec 022's hybrid-mock rule).

- [ ] **AC1.3** The harness does NOT mock `../data/seed`. The seed
  module at [src/data/seed.ts](../../src/data/seed.ts) is a thin
  empty-array exports file (10 lines, all `export const X: T[] = []`
  / `[] as ...`); it imports zero runtime dependencies. Importing it
  is free.

- [ ] **AC1.4** The harness uses `useStore.getState()` to read state
  and `useStore.setState()` (or returned action references) to drive
  mutations. No React renderer (`@testing-library/react-hooks` /
  `react-test-renderer`) is added — Zustand's vanilla `getState` /
  `setState` API is sufficient for action-shape assertions and is the
  established pattern for testing Zustand without a renderer. (Adding a
  renderer is out of scope; if a future test needs hook subscription
  shape, it lands in its own spec.)

- [ ] **AC1.5** State isolation between tests is enforced via
  `beforeEach`:
  ```ts
  // Snapshot the initial state once at module-eval, then restore on every test.
  const INITIAL_STATE = useStore.getState();

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState(INITIAL_STATE, true); // second arg `true` = replace, not merge
  });
  ```
  The architect refines the exact shape — there are two viable
  alternatives (per-test factory vs. snapshot-and-restore); pick one
  and document why in the design doc.

- [ ] **AC1.6** The harness file carries a header comment in the
  same shape as `src/lib/auth.test.ts:1-29` and
  `src/utils/seedVarianceDates.test.ts:1-26`: spec citation, mocking
  strategy explanation, hoisting caveat (jest.mock hoists above
  imports), and a one-liner per `describe` / `it` block summarizing
  the case under test.

### Track 2 — `deleteProfile` silent-branch tests (back-fill from spec 029)

- [ ] **AC2.1** `useStore.test.ts` covers `deleteProfile` with three
  `it(...)` blocks:
  - `deleteProfile(id)` (no `opts`) → `Toast.show` called once with
    `{ type: 'info', text1: 'Profile deleted' }`. Return value `true`.
    The cached-list cleanup (`brandAdminsByBrandId`) still runs — seed
    a row in `brandAdminsByBrandId['brand-1']` and assert it's gone
    after the call.
  - `deleteProfile(id, { silent: true })` → `Toast.show` NOT called
    for the info-toast (assert `toast.show` mock called zero times
    OR called only with non-info types — concrete assertion is the
    architect's call). Return value `true`. Cached-list cleanup still
    runs.
  - `deleteProfile(id, { silent: true })` when the underlying
    `auth.deleteUser` returns `{ error: 'boom' }` → `Toast.show` IS
    called via `notifyBackendError` (the error path is unconditional —
    the `silent` flag does NOT suppress error toasts). Return value
    `false`. This is the load-bearing test — locks in spec 029
    architect §3 "Error path unchanged" guarantee.

- [ ] **AC2.2** The `auth.deleteUser` mock is set up via
  `jest.mock('../lib/auth', () => ({ deleteUser: jest.fn() }))` and
  the test reaches it via `import { deleteUser } from '../lib/auth'`
  followed by `(deleteUser as jest.Mock).mockResolvedValue(...)`. The
  dynamic `import('../lib/auth')` inside `deleteProfile`
  ([src/store/useStore.ts:795](../../src/store/useStore.ts)) resolves
  to the same mocked module — verified in design.

- [ ] **AC2.3** The `Toast.show` mock is the global one already set up
  in [tests/jest.setup.ts:19-27](../../tests/jest.setup.ts) — the
  harness does NOT redeclare it. The test assertions reference the
  same module to read call counts.

### Track 3 — `canDelete` / `lastOfRole` pure-helper extraction + tests (back-fill from specs 030 + 031)

- [ ] **AC3.1** A new module `src/utils/userPermissions.ts` exports
  two pure functions:
  ```ts
  export function canDeleteUser(args: {
    isMaster: boolean;
    isSelf: boolean;
    targetRole: 'super_admin' | 'master' | 'admin' | 'user';
    lastOfRole: { super_admin: boolean; master: boolean };
  }): boolean;

  export function deriveLastOfRole(
    users: ReadonlyArray<{ role: string }>,
  ): { super_admin: boolean; master: boolean };
  ```
  The exact function signatures are the architect's call (named-arg
  object vs. positional) but they MUST be pure: same inputs → same
  output, no side effects, no React/store imports. The implementation
  is a verbatim lift of the existing logic in
  [src/screens/cmd/sections/UsersSection.tsx:76-79](../../src/screens/cmd/sections/UsersSection.tsx)
  (`lastOfRole`) and lines 284-288 (`canDelete`).

- [ ] **AC3.2** `src/screens/cmd/sections/UsersSection.tsx` is updated
  to consume the helpers — the inline `canDelete` derivation and the
  inline `lastOfRole` derivation are replaced with calls to
  `canDeleteUser({...})` and `deriveLastOfRole(rawUsers)`. Behavior
  is byte-for-byte identical; this is a pure refactor.

- [ ] **AC3.3** A new test file `src/utils/userPermissions.test.ts`
  covers `canDeleteUser` with at minimum the following branches:
  - Master role, self row → `false` (master cannot delete self).
  - Master role, peer non-master row → `true`.
  - Master role, peer master row, NOT last master → `true`.
  - Master role, peer master row, IS last master → `false`.
  - Master role, peer super_admin row, NOT last super_admin → `true`.
  - Master role, peer super_admin row, IS last super_admin → `false`.
  - Non-master admin, self row → `false`.
  - Non-master admin, peer user row → `true`.
  - Non-master admin, peer admin row → `false`.
  - Non-master admin, peer master row → `false`.
  - Non-master admin, peer super_admin row → `false`.

  (Architect may merge / split cells; the matrix above is the
  test-engineer's minimum branch coverage — every conjunction in the
  existing `canDelete = (isMaster ? ... : ...) && !(... lastOfRole ...)
  && !(... lastOfRole ...)` expression has at least one passing and
  one failing input.)

- [ ] **AC3.4** The same test file covers `deriveLastOfRole` with:
  - Empty array → `{ super_admin: true, master: true }` (zero of each
    role, count <= 1 holds, so the helper hides the DELETE button
    defensively — matches the existing inline expression).
  - One super_admin, two masters → `{ super_admin: true, master: false }`.
  - Two super_admins, one master → `{ super_admin: false, master: true }`.
  - Zero super_admins, zero masters → `{ super_admin: true, master: true }`.
  - Mixed roles where the count is computed correctly regardless of
    other roles present (e.g. five `user` rows + two `super_admin` rows
    + zero masters → `{ super_admin: false, master: true }`).

### Track 4 — `tests/README.md` strictly-additive convention doc

- [ ] **AC4.1** [tests/README.md](../../tests/README.md) gains a new
  subsection inside the existing "Track 1 — jest (JS / TS)" section,
  titled "Store-action tests" (or architect's choice — name in design).
  The subsection documents:
  - Where store-action tests live (`src/store/*.test.ts`).
  - The two-mock pattern (`jest.mock('../lib/supabase', ...)` +
    `jest.mock('../lib/db', ...)`) with a code snippet skeleton.
  - How to reset Zustand state in `beforeEach`
    (snapshot-and-restore via `useStore.setState(INITIAL_STATE, true)`).
  - A pointer to `src/store/useStore.test.ts` as the wired reference
    example, in the same style the existing README points at
    `src/utils/seedVarianceDates.test.ts` for the `db.ts`-boundary
    pattern.

- [ ] **AC4.2** The addition is strictly additive — no existing
  documentation lines are deleted or rewritten beyond minor adjacency
  cleanup (e.g. a "see also" cross-link). The existing three-track
  table, hybrid mocking strategy doc, and platform-specific suffix
  note all stay.

### Track 5 — verification gates

- [ ] **AC5.1** `npx tsc --noEmit` exits 0 (no new type errors).
- [ ] **AC5.2** `npm run typecheck:test` exits 0 (test-graph
  typechecks; jest globals and mock types resolve).
- [ ] **AC5.3** `npm run typecheck` exits 0 (base-graph typecheck
  passes; the new `src/utils/userPermissions.ts` and the updated
  `UsersSection.tsx` typecheck cleanly).
- [ ] **AC5.4** `npm test -- --ci` PASS:
  - Jest test-file count rises from 5 → 7-8 (architect's call on
    exact split — the harness adds `src/store/useStore.test.ts` plus
    `src/utils/userPermissions.test.ts`; the `canDelete` /
    `lastOfRole` cases may merge into a single file or split).
  - Jest test-case count rises from 35 → ~49 (target: +14 cases —
    ~3 deleteProfile + ~6 canDelete + ~5 lastOfRole). Hard floor:
    +12 cases. Architect refines if the matrix expands.
  - All existing tests continue to pass.
- [ ] **AC5.5** `npm run test:db` PASS (sanity only — no DB changes).
- [ ] **AC5.6** `npm run test:smoke` PASS (sanity only — no edge
  function changes).
- [ ] **AC5.7** Code-review grep: every new `*.test.ts` file matches
  the existing colocated naming convention (`Foo.ts` →
  `Foo.test.ts`).

## In scope

- `src/store/useStore.test.ts` — new jest test harness covering the
  three `deleteProfile` branches.
- `src/utils/userPermissions.ts` — new pure-helper module lifting
  `canDeleteUser` and `deriveLastOfRole` out of `UsersSection.tsx`.
- `src/utils/userPermissions.test.ts` — jest unit tests covering the
  branch matrix above.
- `src/screens/cmd/sections/UsersSection.tsx` — refactor to consume
  the new helpers (zero behavior change; verified by existing manual
  smoke + the new unit tests).
- `tests/README.md` — additive subsection documenting the store-action
  test convention.

## Out of scope (explicitly)

- **Refactoring `useStore` itself.** The store is ~51 KB / 1900+
  lines; we do not split it, type-tighten it, or trim its action
  surface in this spec. The harness mocks dependencies but does not
  change the store. (Per CLAUDE.md spec 022 carve-out: refactoring
  useStore for testability is forbidden; this spec mocks at the
  module boundary instead, which is the established pattern.)
- **Coverage for `inventoryByStoreId` / catalog / recipe / vendor
  domain.** Those slices live in `useStore.ts` but cover a different
  surface (data-fetching wrappers, optimistic-then-revert paths).
  They each warrant their own spec. This spec is scoped to the
  user-management slice because that's where specs 029-031 deferred
  coverage — keeping the spec focused.
- **Reports backlog.** The Cmd UI Reports section has multiple
  unwritten reports (variance follow-ups, etc.); tracked separately.
- **Migrating any existing tests to a different runner.** All four
  existing jest tests (`relativeTime`, `StatusPill`,
  `seedVarianceDates`, `escapeHtml`, `auth`) stay where they are.
- **Component test for `UsersSection.tsx` itself.** Rendering the
  full section as a jsdom component would require mocking the
  theme module + the entire store import chain (the "transitive
  store-import gotcha" documented in tests/README.md:101-129). Out
  of scope; the unit-test slice through `userPermissions.ts` covers
  the same logic without the rendering cost.
- **Adding `@testing-library/react-hooks` or `react-test-renderer`.**
  The Zustand `getState` / `setState` API is sufficient for
  action-shape assertions. If a future spec needs hook-subscription
  testing, it lands in its own spec.
- **Touching `useRole()` placeholder.** Per CLAUDE.md's
  "Placeholder behavior (intentional)" — `useRole.ts` hardcodes
  `'admin'` and is intentionally untouched until the staff-app split
  is fully cut over. `useIsMaster` (spec 029) is the predicate the
  tests exercise.
- **Adding a jest setup for `Platform` / `react-native` mocking
  beyond what jest-expo already provides.** The preset is sufficient;
  the harness does not need additional global setup.

## Open questions resolved

- Q1: Should `canDelete` extraction land in `src/utils/userPermissions.ts`
  (new module) or `src/hooks/useRole.ts` (existing)?
  → **A: new module (`src/utils/userPermissions.ts`).** Rationale:
  the logic is pure (no React/store imports), so it fits the `utils/`
  convention. `useRole.ts` is reserved for React hooks that read the
  Zustand store (`useIsSuperAdmin`, `useIsMaster`); folding non-hook
  pure functions into it muddies the file's purpose. The PM brief
  lean matches: "new module, since it's pure logic not React-coupled."

- Q2: Should the harness mock `data/seed`?
  → **A: no.** `src/data/seed.ts` is a 10-line empty-array-exports
  file with zero runtime dependencies (verified —
  [src/data/seed.ts](../../src/data/seed.ts) only imports `User`,
  `Store`, etc. from `../types`, all type-only). Importing it is
  free. The two boundaries that DO need mocking are
  `../lib/supabase` (crashes on missing env at module-eval) and
  `../lib/db` (would otherwise fire real PostgREST RPCs).

- Q3: Should `useStore.test.ts` use `useStore.getState()` or
  `@testing-library/react-hooks`?
  → **A: `useStore.getState()` / `useStore.setState()`.** Rationale:
  Zustand's vanilla API is renderer-agnostic; action invocations are
  callable directly off the state object. Adding a renderer would
  pull in jsdom + an additional dev dependency for zero new
  assertion power on action-shape tests. The auth.test.ts precedent
  (spec 032) uses the equivalent pattern — directly invoking the
  exported `deleteUser` function without a hook wrapper.

- Q4: Should the harness reset state via per-test factory or
  snapshot-and-restore?
  → **A: snapshot-and-restore.** Rationale: the factory pattern
  (`createStore()` returning a fresh Zustand instance) would require
  refactoring `useStore.ts` itself to export a factory rather than a
  singleton, which is explicitly out of scope. Snapshot-and-restore
  uses Zustand's built-in `setState(state, true)` to replace the
  current state — no production-code change. Architect finalizes
  the exact restore shape (full state object vs. selected slices)
  in the design doc.

- Q5: Should the `userPermissions.ts` helper take a named-arg object
  or positional args?
  → **A: architect's call.** PM lean: named-arg object, because the
  call site has four booleans plus a role string, and positional
  ordering is easy to misremember. Architect makes the final call;
  the spec only requires that the function be pure and that the
  signature is documented. Note: `lastOfRole` field name MUST match
  the existing `UsersSection.tsx` shape (`{ super_admin, master }`)
  so the refactor is a no-op.

- Q6: Should the test file count rise to exactly 8, or is 7
  acceptable?
  → **A: architect's call within the floor.** The hard floor is
  +12 test cases (35 → 47). The PM target is +14 (35 → 49). If the
  architect splits store-action tests and helper tests into two
  files, count = 7. If they additionally pull the `lastOfRole`
  cases into a third file, count = 8. Either shape satisfies AC5.4
  as long as the case count floor holds.

## Dependencies

- **No new packages.** `jest-expo`, `jest`, `@types/jest`,
  `ts-jest` (via `jest-expo`'s `babel-preset-expo`) are all already
  installed. No `@testing-library/react-hooks` needed.
- **No new migrations.** This spec is pure-frontend / pure-test.
- **No edge function changes.** `delete-user` and friends are
  untouched.
- **Existing files referenced by tests:**
  - [src/store/useStore.ts:792-825](../../src/store/useStore.ts)
    (`deleteProfile` implementation).
  - [src/screens/cmd/sections/UsersSection.tsx:76-79](../../src/screens/cmd/sections/UsersSection.tsx)
    (`lastOfRole` derivation).
  - [src/screens/cmd/sections/UsersSection.tsx:284-288](../../src/screens/cmd/sections/UsersSection.tsx)
    (`canDelete` derivation).
  - [src/lib/auth.test.ts](../../src/lib/auth.test.ts) (mocking
    precedent).
  - [src/utils/seedVarianceDates.test.ts](../../src/utils/seedVarianceDates.test.ts)
    (`db.ts`-boundary mock precedent).
  - [tests/jest.setup.ts](../../tests/jest.setup.ts) (the global
    `Toast.show` + AsyncStorage mocks the harness inherits).

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. The
  `UsersSection.tsx` file the refactor touches lives at
  `src/screens/cmd/sections/`. No legacy admin surface to route
  around (spec 025 deleted it).

- **Per-store or admin-global:** Admin-global. None of the
  behaviors under test are per-store; `canDeleteUser` and
  `deriveLastOfRole` operate on the global user list.
  `deleteProfile` calls the `delete-user` edge function which
  enforces self-delete refusal and (per spec 031)
  last-super-admin / master refusal server-side. The unit tests
  here cover the UI-layer mirror of those gates.

- **Realtime channels touched:** None. `UsersSection` uses
  on-mount + post-action `fetchAllUsers` (not realtime — per the
  comment in UsersSection.tsx:17-19). The store doesn't subscribe
  to a profiles channel either. No realtime publication gotcha.

- **Migrations needed:** No.

- **Edge functions touched:** None. The `delete-user` edge function
  is exercised end-to-end by `scripts/smoke-edge-roles.sh` (Track 3)
  and pinned server-side by the spec 031 pgTAP test. This spec only
  pins the client-side mirror.

- **Web/native scope:** Both. Pure-TS unit tests run in `node` jest
  env and apply regardless of platform. No `Platform.OS` branching
  is exercised by the tests.

- **Test track:** Jest only (Track 1). No pgTAP (Track 2) — no DB
  changes. No shell smoke (Track 3) — no edge function or RPC
  changes. The `npm run test:db` and `npm run test:smoke` gates run
  as sanity checks (per spec 022's verification posture).

- **`app.json` slug:** Not touched. No build-identifier work.

- **Mocking strategy posture (spec 022 §6 = D, hybrid):**
  - The `useStore.test.ts` harness mocks at the **module-import
    boundaries** the store crosses (`../lib/supabase` and
    `../lib/db`). This is the spec 022 "unit test mocks at the
    module under test's collaborators" rule for unit tests where
    the unit IS the store.
  - The `userPermissions.test.ts` tests mock NOTHING — the helpers
    are pure and have no collaborators. This is the cleanest
    possible unit test shape.

- **Hoisting caveat (from spec 023 §5 / spec 032 §4):**
  `jest.mock(...)` is hoisted above all `import` statements. The
  harness file documents this in a header comment so the next dev
  reading it doesn't reorder mocks below imports and break the
  resolution.

- **Snapshot-and-restore state isolation:** Zustand stores are
  singletons in the Node process; `useStore.getState()` returns the
  live state object across tests. Without explicit reset,
  test-order dependencies creep in. The harness MUST capture the
  initial state at module-eval and restore via
  `useStore.setState(INITIAL_STATE, true)` in `beforeEach` (second
  arg `true` = replace, not merge; otherwise nested objects merge
  and reset is partial).

- **Test-count gates (Track 5):** existing count is 5 test files /
  35 cases. Target after this spec: 7-8 test files / ~49 cases.
  The architect may refine the exact target but MUST honor the +12
  case floor.

## Architect design

### 1. Decisions resolved (Q3–Q6)

#### Q3 — State isolation: snapshot-and-restore (option a)

Confirmed. Capture the initial state object once at module-eval time,
restore via `useStore.setState(INITIAL_STATE, true)` in `beforeEach`. The
second positional `true` is the **replace** flag (Zustand's documented
`setState(partial, replace?)` shape); without it, nested objects merge
and the reset is partial.

Rejected (b): `zustand` does not ship a `mockReset` helper at v4. There
is a `zustand/vanilla`-test helper in the v4 docs that requires
refactoring the store to expose a factory; that refactor is **explicitly
out of scope** per spec §"Out of scope".

Rejected (c): `jest.isolateModules` per test reboots the entire
`useStore.ts` graph (~1900 lines) plus every transitive `db.ts` import on
every `it()`. Materially slower; semantically equivalent to the snapshot
form once we restore correctly. Not worth the cost.

**Snapshot mechanism (exact shape):**

The harness captures the snapshot **after** mocks are declared (jest
hoists `jest.mock` above imports, so the moment `useStore` is imported,
the mocked `../lib/db` and `../lib/supabase` are already in scope). The
snapshot is computed once, at module-eval time:

```ts
// Pseudocode for the design — implementor authors the .ts.
// Position this block AFTER the imports of useStore and the mocked
// modules; jest.mock hoists above imports, so by the time `useStore`
// is evaluated, the mocks are already in place.
const INITIAL_STATE = useStore.getState();

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState(INITIAL_STATE, true); // replace, not merge
});
```

**Coupling concern.** `INITIAL_STATE` is the **whole** state object
(actions + data slices). Restoring the whole object on every test
preserves action references — actions are part of state in Zustand's
shape, so a "replace with initial" includes them. The implementor does
NOT enumerate fields by hand; the snapshot is opaque. This satisfies
"no coupling to internal-only fields" from the PM's question — the test
file never names a field directly; it just snapshots once and restores.

**One ordering subtlety.** Some store actions (`login`, `loadFromSupabase`)
fire promise chains via `db.fetchStores().then(...)`. With the mocked
`db` returning `mockResolvedValue([])` by default, the chains resolve
into noop state writes after the synchronous body returns. If a test
calls one of these actions and then runs an assertion synchronously,
that's the implementor's responsibility to `await` correctly — but for
`deleteProfile` (the only action under test), the promise is the
function's own return value and `await` is unambiguous.

#### Q4 — Vanilla API: `useStore.getState()` / `useStore.setState()` (option a)

Confirmed. Per the PM brief and the `auth.test.ts` precedent. No React
renderer is added. Action invocations:

```ts
// Read state:        useStore.getState().brandAdminsByBrandId
// Seed state:        useStore.setState({ brandAdminsByBrandId: {...} })
// Invoke action:     await useStore.getState().deleteProfile('user-1')
```

This matches `auth.test.ts:55-56`'s pattern of importing a function and
calling it directly. No `@testing-library/react-hooks` and no
`react-test-renderer` are added to `package.json`.

#### Q5 — `userPermissions.ts` named-args object

Confirmed. The call site already has the shape the helper consumes:

- `isMaster: boolean` (from `useIsMaster()`)
- `isSelf: boolean` (computed in `UserRow` from `currentUserId === user.id`)
- `targetRole: User['role']`
- `lastOfRole: { super_admin: boolean; master: boolean }` (derived from
  `rawUsers` in the parent section)

Positional ordering of four-plus fields is fragile under future
additions (e.g. spec 03X adds a `targetBrandId` gate). Named-args is the
ergonomic and the standard for predicates in this codebase. Confirms the
PM lean.

#### Q6 — Test-file split: option B (two files)

Confirmed. The pure helpers belong with their module:

- `src/store/useStore.test.ts` — the harness itself plus the three
  `deleteProfile` cases. Total: **3** `it()` blocks.
- `src/utils/userPermissions.test.ts` — pure-function coverage. Total:
  **~11** `it()` blocks for `canDeleteUser` plus **~5** for
  `deriveLastOfRole`. Total: **~16** cases in the helper file.

This satisfies AC5.4's 7-file target (5 existing + 2 new = 7) and the
+14 case PM target (3 + 16 = 19, comfortably above the +12 floor).
Combining everything into one file mixes module-collaborator-mocked
tests with zero-collaborator pure-function tests in one file — harder
to read; the harness header would have to caveat that the pure-function
cases don't use the mocks. Two files keep each test's import graph
minimal.

---

### 2. `userPermissions.ts` API

#### Module location

`src/utils/userPermissions.ts` — per spec Q1 resolution. No React, no
store, no `db.ts`, no `supabase` imports. Types-only import from
`../types` for `User['role']`.

#### Signatures

```ts
/**
 * Spec 030/031 — UX-layer mirror of the server-side DELETE gates the
 * `delete-user` edge function enforces (self-delete refusal, peer-role
 * gate for non-master admins) and `public.assert_not_last_of_role`
 * enforces (no deletion of the last super_admin / master). Hides the
 * DELETE button when the server would refuse. The server is the
 * authoritative gate; this helper is a UX hint, NOT security.
 *
 * Lifted verbatim from UsersSection.tsx:284-288 (spec 033 §AC3.1) —
 * implementation MUST preserve the existing boolean expression
 * byte-for-byte so the refactor is a no-op.
 *
 * @param args.isMaster     - true iff caller role is 'master' or 'super_admin'
 *                            (from useIsMaster()).
 * @param args.isSelf       - true iff the target row is the caller's own
 *                            profile row.
 * @param args.targetRole   - role of the target profile row.
 * @param args.lastOfRole   - `{ super_admin, master }` flags; each is
 *                            true when the global count of rows with
 *                            that role is <= 1. Derived from
 *                            `deriveLastOfRole(rawUsers)` below.
 * @returns                 - true iff the caller may delete the target.
 */
export function canDeleteUser(args: {
  isMaster: boolean;
  isSelf: boolean;
  targetRole: User['role'];
  lastOfRole: { super_admin: boolean; master: boolean };
}): boolean;

/**
 * Spec 031 — derive last-of-role flags from a user list. Counts rows
 * per role; returns true when the count is <= 1 (zero or one — the
 * defensive empty-array case still hides the DELETE button rather than
 * showing it).
 *
 * Lifted verbatim from UsersSection.tsx:76-79.
 *
 * @param users  the FULL fetched user array (rawUsers), NOT the visible
 *               subset — counts must match what the server sees for the
 *               caller's brand scope.
 * @returns      `{ super_admin, master }` boolean flags.
 */
export function deriveLastOfRole(
  users: ReadonlyArray<{ role: User['role'] }>,
): { super_admin: boolean; master: boolean };
```

#### Implementation note (for the developer)

The function bodies are direct copies of the existing inline
expressions in `UsersSection.tsx`. The implementor MUST verify that
after refactor:

```ts
// Before (UsersSection.tsx:284-288):
const canDelete = (isMaster
  ? !isSelf
  : !isSelf && user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin')
  && !(user.role === 'super_admin' && lastOfRole.super_admin)
  && !(user.role === 'master'      && lastOfRole.master);

// After (semantically identical):
const canDelete = canDeleteUser({
  isMaster,
  isSelf,
  targetRole: user.role,
  lastOfRole,
});
```

`User['role']` is `'super_admin' | 'master' | 'admin' | 'user'`
(confirmed via `src/types/index.ts`). The helper does NOT defensively
handle unknown role strings — the type-system upstream rules them out,
and adding `default: false` would diverge from the existing inline
expression (which falls through to the canDelete-only check on unknown
roles, returning true if isMaster && !isSelf).

---

### 3. Mock boundaries for `useStore.test.ts`

The harness mocks at **two** module-import boundaries (matching the
spec 022 hybrid-mocking strategy and `auth.test.ts`'s shape):

1. **`jest.mock('../lib/supabase', () => ({ supabase: { ... } }))`** —
   prevents the env-read crash at import time. Stub `supabase` to an
   object exposing only the methods the code paths under test reach:

   - `auth.getSession: jest.fn()` (consumed transitively by
     `deleteProfile` → `import('../lib/auth')` → `callEdgeFunction`)
   - other supabase methods that store actions reach can be stubbed
     as `jest.fn()` on demand. The minimal surface for the
     `deleteProfile` cases is just `auth.getSession`.

   Note that for the `deleteProfile` tests, the supabase stub is
   actually only reached indirectly via the mocked `../lib/auth` (see
   #2 below) — the `deleteProfile` test path never touches
   `supabase.*` directly because the dynamic `import('../lib/auth')`
   inside `deleteProfile` resolves to the mocked auth module, which
   returns synthesized results. The supabase mock exists to prevent
   `supabase.ts` from crashing on env-read at module-eval time when
   `useStore.ts` imports it (see line 17 of useStore.ts:
   `import { supabase } from '../lib/supabase';`).

2. **`jest.mock('../lib/auth', () => ({ deleteUser: jest.fn() }))`** —
   the dynamic-import boundary inside
   [`src/store/useStore.ts:795`](../../src/store/useStore.ts):
   `const { deleteUser } = await import('../lib/auth');`. Jest
   resolves `import('../lib/auth')` to the same mocked module
   identity that the top-level `jest.mock` declares — this is jest's
   default behavior (dynamic imports go through the same module
   registry as static `import` statements). **Verified pattern**
   against existing usage. The test reads the mock via
   `import { deleteUser } from '../lib/auth'` at the top of the file
   (after the `jest.mock` call — which is hoisted above all imports).

3. **`jest.mock('../lib/db', () => ({ ... }))`** — needed only because
   `useStore.ts` imports `db` as a namespace (`import * as db from
   '../lib/db'`). The `deleteProfile` action itself does NOT call any
   `db.X` method directly (it dispatches purely to `auth.deleteUser`
   and mutates local state). But the **initial-state** lambda
   `login: (user) => { ... db.fetchStores().then(...) }` runs `db.X`
   chains, and any other store-init paths that fire during test setup
   also need `db.*` to not crash. The minimal mock surface returns a
   reasonable default for every name `useStore.ts` reads off `db`. The
   simplest shape, lifted from the `auth.test.ts` precedent for the
   supabase mock, is to declare a **proxy-style mock** that returns
   `jest.fn().mockResolvedValue([])` for every key — but the
   conservative pattern is to enumerate the names the action paths
   under test actually reach:

   ```ts
   // Pseudocode for the design — minimal surface for the three
   // deleteProfile cases. The implementor may add named entries on
   // demand if a test path reaches a new db.* name.
   jest.mock('../lib/db', () => ({
     // Reached by `loadFromSupabase` and `login` chains — won't fire
     // during deleteProfile tests, but the namespace import would
     // crash on access otherwise. The default `jest.fn()` returns
     // undefined; combined with the early returns in `deleteProfile`,
     // this is safe.
     fetchStores: jest.fn().mockResolvedValue([]),
     fetchAllForStore: jest.fn().mockResolvedValue({
       brand: null, catalogIngredients: [], inventory: [],
       recipes: [], prepRecipes: [], vendors: [], wasteLog: [],
       auditLog: [], eodSubmissions: [],
     }),
     cleanupOldRecords: jest.fn().mockResolvedValue(undefined),
     // ... any additional names a test path reaches.
   }));
   ```

   This is consistent with spec 022 §6 (D — hybrid mocking): the unit
   under test is the **store**, the collaborators are the **module
   imports**, and we stub at the module-import boundary.

4. **`react-native-toast-message`** — already mocked globally in
   [`tests/jest.setup.ts:19-27`](../../tests/jest.setup.ts).
   **Confirmed.** The harness does NOT redeclare it. The test reads
   call counts via `import Toast from 'react-native-toast-message'`
   at the top of the file and asserts on `(Toast.show as jest.Mock)`
   — same pattern as if the global mock were declared inline.

5. **`@react-native-async-storage/async-storage`** — already mocked
   globally in `tests/jest.setup.ts:29-36`. Not redeclared.

#### Mock-import hoisting caveat

The harness header comment MUST call out the standard caveat (per spec
023 §5 and spec 032 §4): `jest.mock(...)` is **hoisted** above all
`import` statements at compile time. The implementor writes mock
declarations at the top of the file, then `import` the mocked symbols
back via standard `import` for assertion use. Same shape as
[`src/lib/auth.test.ts:46-59`](../../src/lib/auth.test.ts).

---

### 4. Test count breakdown

#### `src/store/useStore.test.ts` — 3 cases

`describe('deleteProfile', () => { ... })`:

1. **`it('toasts info on success without opts, returns true, and clears cached members lists')`**
   — sets up `(deleteUser as jest.Mock).mockResolvedValue({ error: null })`.
   Seeds state with
   `useStore.setState({ brandAdminsByBrandId: { 'brand-1': [{ id: 'u1', ... }, { id: 'u2', ... }] } })`.
   Calls `await useStore.getState().deleteProfile('u1')`. Asserts
   return value is `true`; `Toast.show` called once with
   `{ type: 'info', text1: 'Profile deleted', ... }`; final
   `useStore.getState().brandAdminsByBrandId['brand-1']` equals
   `[{ id: 'u2', ... }]` (the u1 row was filtered out).

2. **`it('does NOT fire the info-toast with { silent: true }, returns true, and still clears cached members lists')`**
   — same setup, but
   `await useStore.getState().deleteProfile('u1', { silent: true })`.
   Asserts return value is `true`; cached-list cleanup ran identically
   to case 1; `(Toast.show as jest.Mock).mock.calls` does NOT include
   a call with `text1: 'Profile deleted'`. (Concrete assertion:
   `expect((Toast.show as jest.Mock)).not.toHaveBeenCalledWith(expect.objectContaining({ text1: 'Profile deleted' }))`.)

3. **`it('surfaces the auth error via notifyBackendError regardless of { silent: true }, returns false, and does NOT clear cached members lists')`**
   — `(deleteUser as jest.Mock).mockResolvedValue({ error: 'cannot delete the last super_admin' })`.
   Calls `await useStore.getState().deleteProfile('u1', { silent: true })`.
   Asserts return value is `false`; `Toast.show` called once with
   `type: 'error'`, `text1: 'Delete profile failed'`,
   `text2: 'cannot delete the last super_admin'` (the
   `notifyBackendError` shape from useStore.ts:25-34);
   `brandAdminsByBrandId` is **unchanged** (the cleanup runs after the
   error-return, so the early return preserves state). This is the
   spec 029 architect §3 "error path unchanged" lock-in.

#### `src/utils/userPermissions.test.ts` — 16 cases

`describe('canDeleteUser', () => { ... })` — 11 cases per spec AC3.3:

1. `it('master cannot delete self')` — `{ isMaster: true, isSelf: true, ... }` → `false`.
2. `it('master can delete peer non-master row')` — `{ isMaster: true, isSelf: false, targetRole: 'user', lastOfRole: { super_admin: false, master: false } }` → `true`.
3. `it('master can delete peer master row when not last master')` — `{ targetRole: 'master', lastOfRole: { master: false, super_admin: false } }` → `true`.
4. `it('master cannot delete peer master row when it is the last master')` — `{ targetRole: 'master', lastOfRole: { master: true, super_admin: false } }` → `false`.
5. `it('master can delete peer super_admin row when not last super_admin')` — `{ targetRole: 'super_admin', lastOfRole: { super_admin: false, master: false } }` → `true`.
6. `it('master cannot delete peer super_admin row when it is the last super_admin')` — `{ targetRole: 'super_admin', lastOfRole: { super_admin: true, master: false } }` → `false`.
7. `it('non-master admin cannot delete self')` — `{ isMaster: false, isSelf: true, targetRole: 'admin', lastOfRole: { super_admin: false, master: false } }` → `false`.
8. `it('non-master admin can delete peer user row')` — `{ isMaster: false, isSelf: false, targetRole: 'user', lastOfRole: { super_admin: false, master: false } }` → `true`.
9. `it('non-master admin cannot delete peer admin row')` — `{ targetRole: 'admin' }` → `false`.
10. `it('non-master admin cannot delete peer master row')` — `{ targetRole: 'master' }` → `false`.
11. `it('non-master admin cannot delete peer super_admin row')` — `{ targetRole: 'super_admin' }` → `false`.

`describe('deriveLastOfRole', () => { ... })` — 5 cases per spec AC3.4:

12. `it('returns { super_admin: true, master: true } for an empty array (defensive)')` — `[]` → `{ super_admin: true, master: true }`.
13. `it('flags master:false when two masters exist')` — one super_admin + two masters → `{ super_admin: true, master: false }`.
14. `it('flags super_admin:false when two super_admins exist')` — two super_admins + one master → `{ super_admin: false, master: true }`.
15. `it('returns both true with zero super_admins and zero masters')` — five users only → `{ super_admin: true, master: true }`.
16. `it('counts only rows with the matching role')` — five users + two super_admins + zero masters → `{ super_admin: false, master: true }`.

#### Total

**3 + 16 = 19 new cases.** Existing count: 35. New total: **54** cases.
Comfortably above the +12 floor and +14 PM target. The PM's "~49 cases"
target was conservative; the spelled-out matrix above naturally lands
higher. File count: 5 existing + 2 new = **7** test files (matches
AC5.4 "7-8 test files").

---

### 5. Refactor scope for `UsersSection.tsx`

Three edits, all behavior-preserving:

1. **Add imports** at the top of `UsersSection.tsx`:
   ```ts
   import { canDeleteUser, deriveLastOfRole } from '../../../utils/userPermissions';
   ```

2. **Replace the inline `lastOfRole` derivation** at
   [UsersSection.tsx:76-79](../../src/screens/cmd/sections/UsersSection.tsx):
   ```ts
   // Before:
   const lastOfRole = {
     super_admin: rawUsers.filter((u) => u.role === 'super_admin').length <= 1,
     master:      rawUsers.filter((u) => u.role === 'master').length <= 1,
   };
   // After:
   const lastOfRole = deriveLastOfRole(rawUsers);
   ```
   The contextual comment at lines 70-75 (spec 031 explainer) stays.

3. **Replace the inline `canDelete` derivation** inside `UserRow` at
   [UsersSection.tsx:284-288](../../src/screens/cmd/sections/UsersSection.tsx):
   ```ts
   // Before:
   const canDelete = (isMaster
     ? !isSelf
     : !isSelf && user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin')
     && !(user.role === 'super_admin' && lastOfRole.super_admin)
     && !(user.role === 'master'      && lastOfRole.master);
   // After:
   const canDelete = canDeleteUser({
     isMaster,
     isSelf,
     targetRole: user.role,
     lastOfRole,
   });
   ```
   The contextual comment at lines 274-283 (spec 025/030/031 explainer)
   stays — it documents the policy that `canDeleteUser` enforces.

#### Byte-for-byte semantic preservation check

The implementor MUST manually verify, by reading both expressions side
by side, that:

- **Self gate:** `!isSelf` appears in BOTH branches (master and
  non-master). The helper preserves this.
- **Non-master peer-role gate:** the three exclusions (`admin`,
  `master`, `super_admin`) appear ONLY on the non-master branch. The
  helper preserves this.
- **Last-of-role suppression:** the two `&& !( ... )` clauses apply to
  BOTH branches uniformly (master and non-master alike). The helper
  preserves this.

The `canResetPassword` derivation at UsersSection.tsx:298-300 is NOT
touched by this spec — spec 030/031 deferred it as well, but the PM
intentionally scoped this spec to the DELETE gate only. Reset-password
extraction is a follow-up.

---

### 6. Cross-cutting confirmations

- **No migrations.** No schema changes. The pgTAP test
  `supabase/tests/delete_user_last_of_role.test.sql` (spec 031) is the
  server-side pin; this spec adds the client-side mirror only.
- **No edge functions.** `delete-user` is untouched.
- **No realtime.** `UsersSection` uses on-mount + post-action
  `fetchAllUsers` (see UsersSection.tsx:17-20). No publication
  membership change, no `docker restart supabase_realtime_imr-inventory`
  needed.
- **No `src/lib/db.ts` changes.** The helper is pure; the test mocks
  `db.ts` at the module-import boundary.
- **No `jest.config.js` changes.** The
  [`<rootDir>/src/store/**/*.test.ts`](../../jest.config.js) and
  `<rootDir>/src/utils/**/*.test.ts` globs already cover both new
  files (confirmed at line 65 and 67).
- **`tests/README.md` additive subsection.** Insert under "Track 1 —
  jest (JS / TS)" (line 151) a new subsection titled **"Store-action
  tests"** documenting:
  - Where store-action tests live (`src/store/*.test.ts`).
  - The three-mock pattern (`jest.mock('../lib/supabase', ...)`,
    `jest.mock('../lib/db', ...)`, `jest.mock('../lib/auth', ...)`
    when dynamic-import boundaries exist).
  - Snapshot-and-restore via
    `const INITIAL_STATE = useStore.getState();` +
    `useStore.setState(INITIAL_STATE, true);` in `beforeEach`.
  - Pointer to `src/store/useStore.test.ts` as the wired example, in
    the same style the existing README points at
    `src/utils/seedVarianceDates.test.ts` for the db-boundary pattern.
  - The addition is strictly additive — no existing lines deleted.

---

### 7. Verification gates

Matches PM list verbatim (AC5.1–AC5.7):

- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npm run typecheck:test` exits 0 (test-graph typecheck — jest
      globals, `as jest.Mock` casts, etc. resolve).
- [ ] `npm run typecheck` exits 0 (base-graph typecheck — the new
      `userPermissions.ts` and the updated `UsersSection.tsx` typecheck
      cleanly).
- [ ] `npm test -- --ci` PASS:
  - File count rises from 5 to **7**.
  - Case count rises from 35 to **54** (≥ +12 floor; ≥ +14 PM target).
  - All existing tests still pass.
- [ ] `npm run test:db` PASS (sanity — no DB changes).
- [ ] `npm run test:smoke` PASS (sanity — no edge function or RPC
      changes).
- [ ] Grep check: every new `*.test.ts` follows the
      `Foo.ts` → `Foo.test.ts` colocation convention. The two new
      files satisfy this (`useStore.ts` → `useStore.test.ts`;
      `userPermissions.ts` → `userPermissions.test.ts`).

---

### 8. Risks and tradeoffs

- **Snapshot-and-restore lock-in.** The harness assumes the initial
  state object is referentially stable after capture. If a future
  refactor of `useStore.ts` makes some initial fields lazy-init or
  mutates them at module-load (e.g. reading `localStorage` synchronously
  for dark-mode), `INITIAL_STATE` may capture post-init values rather
  than true initial. The implementor should grep `useStore.ts` for any
  `localStorage.getItem` / `AsyncStorage.getItem` calls **outside**
  function bodies before declaring `INITIAL_STATE` and confirm they're
  all inside action closures (verified: none at module top-level —
  the only init effect is the `darkMode: false` default at line 408).
- **`db.ts` mock surface drift.** If a future store action under test
  reaches a `db.X` name not enumerated in the mock, the test will
  throw `TypeError: db.X is not a function` at runtime. The harness
  header should call out the "enumerate on demand" rule and point at
  the existing skeleton as the example. The three `deleteProfile`
  cases do not touch any `db.X` directly, so the minimal surface
  proposed in §3 is sufficient.
- **Inline-vs-helper drift after refactor.** Once `canDelete` /
  `lastOfRole` live in `userPermissions.ts`, the spec 029-031
  contextual comments in `UsersSection.tsx` are pointer comments to
  the helper, not the logic itself. A future spec that modifies the
  policy must update BOTH the helper AND any test that pins the
  matrix. The pgTAP test (spec 031) is the server-side gate, so the
  server enforces correctness regardless of what the client does; the
  unit test here only locks the client mirror.
- **Helper purity.** `canDeleteUser` and `deriveLastOfRole` must
  remain pure. The implementor must not, in a moment of expediency,
  fold `useIsMaster()` or `useStore.getState()` into the helper —
  that would break the test (no React env) and undo the entire
  point of the extraction.
- **No "last-admin" gate.** The existing `canDelete` expression does
  NOT suppress deletion of the last admin (only super_admin and
  master). This is intentional per spec 031 (admin is not a
  load-bearing role for the project's continued operation). The
  helper preserves this — the test matrix does NOT include a
  "last admin" branch. If a future spec adds an admin gate, both
  helper and matrix update together.

## Handoff

next_agent: frontend-developer
prompt: Implement Spec 033 against the design in this spec. Land the
  two new test files (`src/store/useStore.test.ts`,
  `src/utils/userPermissions.test.ts`), the new pure-helper module
  (`src/utils/userPermissions.ts`), the refactor of
  `src/screens/cmd/sections/UsersSection.tsx` to consume the helpers
  byte-for-byte equivalently, and the additive "Store-action tests"
  subsection in `tests/README.md`. Confirm jest test count rises to
  54 cases / 7 files. Run all verification gates listed in §7 of the
  design. After implementation, set Status: READY_FOR_REVIEW and list
  files changed under ## Files changed.
payload_paths:
  - specs/033-store-test-harness/spec.md

## Files changed

- `src/utils/userPermissions.ts` — **new.** Pure-helper module exporting
  `canDeleteUser` and `deriveLastOfRole`. Logic lifted byte-for-byte
  from `UsersSection.tsx:76-79` and `:284-288`. No React, no Zustand,
  no `db.ts`, no `supabase` imports — types-only import from `../types`.
- `src/utils/userPermissions.test.ts` — **new.** 16 jest cases (11
  `canDeleteUser` × 5 `deriveLastOfRole`) covering the architect's §5
  matrix.
- `src/store/useStore.test.ts` — **new.** Zustand store-action harness;
  3 cases for the `deleteProfile` silent branch (spec 029 back-fill).
  Uses snapshot-and-restore via `useStore.setState(INITIAL_STATE, true)`
  in `beforeEach`. Mocks `../lib/supabase`, `../lib/auth`, `../lib/db`
  at the module-import boundary.
- `src/screens/cmd/sections/UsersSection.tsx` — **modified** (refactor).
  Imports `canDeleteUser` and `deriveLastOfRole` from the new helper
  module; replaces the inline `lastOfRole` derivation and the inline
  `canDelete` predicate with helper calls. Behavior preserved
  byte-for-byte. Existing spec 025/030/031 contextual comments retained;
  spec 033 pointer comments added.
- `tests/README.md` — **modified** (additive). Adds a "Store-action
  tests (spec 033)" subsection under "Track 1 — jest (JS / TS)"
  documenting the three-mock pattern, snapshot-and-restore state
  isolation, and the dynamic-import-mock transformer. Existing
  table, hybrid-mocking docs, and platform-suffix note untouched.
- `tests/babel-jest-dynamic-import.js` — **new.** Custom jest
  transformer that wraps `babel-jest` and rewrites
  `import('literal')` → `Promise.resolve(require('literal'))` so
  `jest.mock(...)` factories intercept dynamic imports (which
  `babel-preset-expo` otherwise preserves as native ESM). Required to
  make the architect's `useStore.test.ts` design (§3 — "Jest resolves
  `import('../lib/auth')` to the same mocked module identity") work
  under this codebase's `jest-expo + babel-preset-expo` configuration.
  No new dev-dependency; no production-code change.
- `jest.config.js` — **modified** (one-line addition). Wires the new
  transformer via `transform: { '^.+\\.[jt]sx?$': '<rootDir>/tests/babel-jest-dynamic-import.js' }`
  on the `baseProject`. Applies to both `unit` and `component` test
  projects. Documented inline with a pointer to the transformer file.

### Verification gates run

- `npm test -- --ci` — PASS (**7** files / **54** tests, up from 5 / 35).
- `npm run typecheck:test` — exit 0.
- `npm run typecheck` — exit 0 (pre-existing `@types/* 2` environmental
  cruft ignored per spec policy).
- `npm run test:db` — 15/15 PASS.
- `npm run test:smoke` — PASS (Arms 1-6 all green).
- Browser preview verification: not run (preview MCP tools unavailable
  in this agent session; the refactor is mechanical with byte-for-byte
  helper equivalence verified by code reading and proven by the 16
  helper unit tests). The dev server at `localhost:8081` is currently
  running for a reviewer who wants to spot-check.

### Architect-design deviation (surfaced for reviewer awareness)

Architect §3 stated:

> Jest resolves `import('../lib/auth')` to the same mocked module
> identity that the top-level `jest.mock` declares — this is jest's
> default behavior. **Verified pattern**.

This assumption is **not true** under this codebase's `jest-expo +
babel-preset-expo` configuration. `babel-preset-expo` deliberately
preserves `import('x')` expressions (so Metro can produce code-split
chunks on web). Under jest's `node` env, the dynamic import goes
through Node's native ESM loader, which does NOT consult jest's
module registry — so the `jest.mock('../lib/auth', ...)` factory is
bypassed. Symptom: "A dynamic import callback was invoked without
--experimental-vm-modules".

Fix applied: small in-tree jest transformer at
`tests/babel-jest-dynamic-import.js` that wraps `babel-jest` and
rewrites `import('literal')` → `Promise.resolve(require('literal'))`.
No new library dependency. No production-code change in `useStore.ts`.
The architect's design intent (mock at the module-import boundary,
not refactor the store) is preserved.

Alternatives considered and rejected:
- Refactoring `useStore.ts:795` to use `require()` — explicitly
  out of scope per spec §"Out of scope: Refactoring useStore itself".
- Installing `babel-plugin-dynamic-import-node` — adds a new
  dev-dependency, which the agent rules forbid without flagging.
- Skipping the 3 `deleteProfile` cases with `it.skip` — fails the
  user's hard-coded "test count rises to 54" gate.

Reviewer call: if the transformer wrapper is unwanted, the next
sweep can either (a) install `babel-plugin-dynamic-import-node` and
delete the wrapper, or (b) skip the 3 deleteProfile cases and accept
the deferred coverage (the harness scaffold + helper coverage still
land).
