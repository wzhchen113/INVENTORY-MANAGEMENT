## Test report for spec 033

### Acceptance criteria status

#### Track 1 — `src/store/useStore.test.ts` harness

- **AC1.1** File `src/store/useStore.test.ts` exists and is picked up by the `unit` jest project glob (`<rootDir>/src/store/**/*.test.ts`). → **PASS** — file is present; glob match confirmed in `jest.config.js:68`.

- **AC1.2** Harness mocks both module-import boundaries (`../lib/supabase`, `../lib/db`). → **PASS** — both mocked at lines 52-103 of `src/store/useStore.test.ts`. Additionally mocks `../lib/auth` (correct per architect §3 — the dynamic-import boundary; AC1.2 named only two but the auth mock is required and non-controversial).

- **AC1.3** Harness does NOT mock `../data/seed`. → **PASS** — no `jest.mock` for `data/seed` anywhere in the file.

- **AC1.4** Uses `useStore.getState()` / `useStore.setState()` vanilla API; no React renderer. → **PASS** — all state reads via `useStore.getState()`, mutations via `useStore.setState()`; no `@testing-library/react-hooks` import.

- **AC1.5** State isolation via `useStore.setState(INITIAL_STATE, true)` in `beforeEach`. → **PASS** — `INITIAL_STATE` captured at module-eval (line 116); `beforeEach` at lines 138-144 calls `jest.clearAllMocks()` then `useStore.setState(INITIAL_STATE, true)`.

- **AC1.6** Header comment matches the shape of `auth.test.ts` and `seedVarianceDates.test.ts`: spec citation, mocking strategy, hoisting caveat, per-block summary. → **PASS** — lines 1-45 carry all four required elements.

#### Track 2 — `deleteProfile` silent-branch tests

- **AC2.1** Three `it(...)` blocks covering default / silent / silent-on-error paths. → **FAIL** (see Test Run section) — the tests exist and are correctly written, but they cannot PASS in the current working tree state because the `jest.config.js` transformer is in the git stash and not on disk. The underlying logic is correct; the failure is a delivery gap. See Critical finding below.

- **AC2.2** `auth.deleteUser` mock via `jest.mock('../lib/auth', ...)` and import for assertion. → **PASS** (by design inspection) — `jest.mock('../lib/auth', () => ({ deleteUser: jest.fn(), ... }))` at line 72; `import { deleteUser } from '../lib/auth'` at line 107; cast to `jest.Mock` at line 119.

- **AC2.3** `Toast.show` mock is the global one from `tests/jest.setup.ts:19-27`; NOT redeclared. → **PASS** — no `jest.mock('react-native-toast-message', ...)` in `useStore.test.ts`; the test reads the global mock via `(Toast as any).show as jest.Mock` (line 120).

#### Track 3 — `canDelete` / `lastOfRole` pure-helper extraction + tests

- **AC3.1** `src/utils/userPermissions.ts` exports `canDeleteUser` and `deriveLastOfRole` with the correct named-arg signatures. → **PASS** — file exists; signatures match spec exactly; no React, Zustand, db, or supabase imports; only `../types` for `User['role']`.

- **AC3.2** `UsersSection.tsx` refactored to call helpers. → **PASS** (from stash, the committed change) — `import { canDeleteUser, deriveLastOfRole }` at line 14; `const lastOfRole = deriveLastOfRole(rawUsers)` at line 80; `const canDelete = canDeleteUser({...})` at lines 288-293. Byte-for-byte semantic preservation confirmed (see Notes section).

- **AC3.3** `userPermissions.test.ts` covers 11 `canDeleteUser` branches per spec matrix. → **PASS** — all 11 cases present and named to match the spec matrix exactly.

- **AC3.4** `userPermissions.test.ts` covers 5 `deriveLastOfRole` cases. → **PASS** — all 5 cases present, including the defensive empty-array case.

#### Track 4 — `tests/README.md` strictly-additive convention doc

- **AC4.1** README gains a "Store-action tests (spec 033)" subsection under Track 1. → **PASS** (from stash) — subsection exists at line 198 of the stashed version. Documents: location (`src/store/*.test.ts`), three-mock pattern (supabase, auth, db), snapshot-and-restore with code snippet, pointer to `src/store/useStore.test.ts`, and the dynamic-import-mock transformer rationale. Note: spec AC4.1 described a "two-mock pattern" but the actual implementation correctly documents three mocks (supabase + db + auth) — this is an improvement, not a deviation.

- **AC4.2** README addition is strictly additive; zero existing lines deleted. → **PASS** — `diff` of HEAD vs stash shows 0 deleted lines; 74 lines added only.

#### Track 5 — verification gates

- **AC5.1** `npx tsc --noEmit` exits 0. → **FAIL** — exits with code 2. However, identical TS2688 errors (`Cannot find type definition file for 'babel__core 2'`, etc.) exist on HEAD before spec 033 changes — confirmed by stash + re-check. Spec 033 introduced no new type errors. The TS2688 set is pre-existing environmental noise. The spec's stated intent ("no new type errors") is satisfied but the command itself exits non-zero on this machine. This is a pre-existing defect in the repo's typecheck gate, not a spec 033 regression.

- **AC5.2** `npm run typecheck:test` exits 0. → **PASS** — exits cleanly with no output.

- **AC5.3** `npm run typecheck` exits 0. → **FAIL** for the same pre-existing TS2688 reason as AC5.1. Not a spec 033 regression (identical failure on HEAD before any spec 033 changes apply).

- **AC5.4** `npm test -- --ci` PASS; file count 5 → 7; case count 35 → 54. → **FAIL** — current working tree produces 3 FAIL / 51 PASS (51 + 3 = 54 total, 7 files). The three `deleteProfile` tests fail because `jest.config.js` lacks the transformer. With the stash applied the developer claims 54/54 — this can be inferred from the transformer's presence in the stash and the fact that the first cached run did show 54/54. But in the on-disk state at the time of this review, AC5.4 is FAIL.

- **AC5.5** `npm run test:db` PASS. → **PASS** (per developer's report; no DB changes in this spec, sanity-only).

- **AC5.6** `npm run test:smoke` PASS. → **PASS** (per developer's report; no edge function or RPC changes).

- **AC5.7** Naming convention: `Foo.ts` → `Foo.test.ts`. → **PASS** — `useStore.ts` → `useStore.test.ts`; `userPermissions.ts` → `userPermissions.test.ts`.

---

### Test run

```
npm test -- --ci --no-cache
```

```
Test Suites: 1 failed, 6 passed, 7 total
Tests:       3 failed, 51 passed, 54 total
```

**Failing tests** (all in `src/store/useStore.test.ts`):

1. `deleteProfile > toasts info on success without opts, returns true, and clears cached members lists`
   — Expected `true`, received `false`. Root cause: `await import('../lib/auth')` inside `deleteProfile` (useStore.ts:795) throws "A dynamic import callback was invoked without --experimental-vm-modules" because `jest.config.js` does not have the transformer wired. The action's `catch` block fires, which calls `notifyBackendError` and returns `false`.

2. `deleteProfile > does NOT fire the info-toast with { silent: true }, returns true, and still clears cached members lists`
   — Expected `true`, received `false`. Same root cause.

3. `deleteProfile > surfaces the auth error via notifyBackendError regardless of { silent: true }, returns false, and does NOT clear cached members lists`
   — The test passes `false` and `Toast.show` error, but `text2` is the dynamic-import error message instead of `'cannot delete the last super_admin'`. The toast was fired but with the wrong error string.

**Root cause:** The `jest.config.js` transformer change (`transform: { '^.+\\.[jt]sx?$': '<rootDir>/tests/babel-jest-dynamic-import.js' }`) is present in `git stash@{0}` but NOT in the working tree's `jest.config.js`. The developer ran a test against a stale cache populated when the stash was not yet taken, which returned a false 54/54 PASS. When run fresh, the 3 `deleteProfile` tests fail.

**Passing tests** (51):
- All 16 `userPermissions.test.ts` cases PASS (no mocking needed — pure functions).
- All 5 pre-existing test files PASS.

---

### Notes

#### Critical finding — `jest.config.js` transformer change not on disk

The `transform:` addition to `jest.config.js` is in the git stash (`git stash@{0}`) but was never committed or left in the working tree. The developer verified "54/54 PASS" against a warm jest transform cache, not against a clean run. A fresh `npm test -- --ci` fails 3/54.

**Fix required:** apply the stash and confirm `jest.config.js` includes:
```js
transform: {
  '^.+\\.[jt]sx?$': '<rootDir>/tests/babel-jest-dynamic-import.js',
},
```
The `tests/babel-jest-dynamic-import.js` file IS on disk and correct. Only the jest config wire-up is missing from the working tree.

This is the sole blocker. Once `jest.config.js` is corrected, AC5.4 passes and all three `deleteProfile` tests should pass (the transformer logic is correct — verified by manual regex test and by the cached first run).

#### Transformer deviation assessment (point 4 from brief)

The `tests/babel-jest-dynamic-import.js` transformer is a reasonable and sustainable solution for this codebase. Assessment:

- **Sustainability:** The wrapper is small (82 lines), self-documenting, in-tree (no new package.json entry), and is the only correct option that avoids modifying production code. The `SCOPE` section explicitly documents computed-import non-handling. The `processAsync` delegation handles async transform paths correctly (confirmed `babel-jest` exposes it). Low maintenance burden.

- **Alternative: `babel-plugin-dynamic-import-node`** — would produce the same semantic result (rewrites `import()` to `require()` in CJS contexts) but adds a new devDependency. Per CLAUDE.md agent rules, new dev-deps require surfacing to the user. The in-tree transformer avoids that. If the plugin is later desired, it can replace the wrapper with a one-line `plugins: ['dynamic-import-node']` in `babel.config.js` and deletion of the wrapper.

- **Alternative: refactor `useStore.deleteProfile` to use static import** — explicitly out of scope per spec §"Out of scope: Refactoring useStore itself."

- **Alternative: `it.skip` the 3 cases** — would fail the +14 target and leave the spec 029 back-fill uncovered. Correctly rejected.

**Recommendation:** keep the in-tree transformer. It is the right tradeoff for this project. Document in a follow-up that `babel-plugin-dynamic-import-node` is the upstream equivalent if a future developer wants to consolidate.

#### Semantic preservation of `UsersSection.tsx` refactor (point 5 from brief)

The original `canDelete` expression (from HEAD before spec 033):
```ts
const canDelete = (isMaster
  ? !isSelf
  : !isSelf && user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin')
  && !(user.role === 'super_admin' && lastOfRole.super_admin)
  && !(user.role === 'master'      && lastOfRole.master);
```

The helper in `userPermissions.ts`:
```ts
return (isMaster
    ? !isSelf
    : !isSelf && targetRole !== 'admin' && targetRole !== 'master' && targetRole !== 'super_admin')
    && !(targetRole === 'super_admin' && lastOfRole.super_admin)
    && !(targetRole === 'master'      && lastOfRole.master);
```

These are byte-for-byte identical with `user.role` renamed to `targetRole`. The call site passes `targetRole: user.role`, so the substitution is a no-op. All three gates are preserved:
- Self gate: `!isSelf` in both branches. ✓
- Non-master peer-role gate: `admin`, `master`, `super_admin` exclusions on the non-master branch only. ✓
- Last-of-role suppression: both `super_admin` and `master` clauses apply uniformly. ✓

The 16 `userPermissions.test.ts` cases exhaustively verify the branch matrix and would catch any semantic drift. The refactor is correct.

For `deriveLastOfRole`, the original:
```ts
const lastOfRole = {
  super_admin: rawUsers.filter((u) => u.role === 'super_admin').length <= 1,
  master:      rawUsers.filter((u) => u.role === 'master').length <= 1,
};
```

Helper:
```ts
return {
  super_admin: users.filter((u) => u.role === 'super_admin').length <= 1,
  master:      users.filter((u) => u.role === 'master').length <= 1,
};
```

Identical expressions with `rawUsers` renamed to `users`. No semantic change.

#### `userPermissions.test.ts` quality (point 2 from brief)

- **`canDeleteUser` branches:** All 11 spec-mandated branches are present. The baseline object pattern (`const baseline = { isMaster: false, isSelf: false, targetRole: 'user', lastOfRole: {...} }` spread with per-case overrides) is clean and readable. No duplicative cases. Named-args style is consistent throughout.

- **`deriveLastOfRole` edge cases:** All 5 cases present. The empty-array defensive case is explicitly commented ("Zero of each role — count <= 1 holds"). The mixed-roles case (5 users + 2 super_admins + 0 masters) correctly pins that the counter ignores non-target rows.

- **Missing cases:** No significant gaps. The spec matrix is exhaustive for the existing boolean expression. One possible addition that is intentionally omitted (per spec §8 "No last-admin gate") is a last-admin case — the spec explicitly documents this omission, so it is not a gap.

- **Named-args style:** Confirmed consistent. Every `canDeleteUser({...})` call uses the object form.

#### `useStore.test.ts` quality (point 3 from brief)

- **3 `deleteProfile` cases:** All three are present and correctly named. The test structure matches architect §4 exactly.

- **State isolation:** `INITIAL_STATE` captured at line 116 (module-eval time, after mocks are hoisted); `useStore.setState(INITIAL_STATE, true)` in `beforeEach` at line 143. Correct.

- **Mock setup:** `jest.mock('../lib/supabase', ...)` at line 52; `jest.mock('../lib/auth', ...)` at line 72; `jest.mock('../lib/db', ...)` at line 83. All three boundaries mocked correctly. The supabase mock includes `auth.onAuthStateChange` (returns subscription object) which prevents potential crashes from store initialization — conservative and correct.

- **Does the test pass without the transformer?** NO. Confirmed by running `npm test -- --ci src/store/useStore.test.ts` with the current `jest.config.js` (without transformer): all 3 cases fail with "A dynamic import callback was invoked without --experimental-vm-modules".

#### Pre-existing `typecheck` failure (AC5.1, AC5.3)

`npm run typecheck` exits code 2 with 24 TS2688 errors (`Cannot find type definition file for 'babel__core 2'` etc.). These errors are identical before and after spec 033 changes — confirmed by stashing spec 033 and re-running. This is a pre-existing environmental issue in the project's tsconfig, not a spec 033 regression. It does not affect the test track (AC5.2 `typecheck:test` passes cleanly). Should be tracked as a separate cleanup item.

#### Test count gates (point 8 from brief — duplicate case check)

19 new cases: 11 `canDeleteUser` + 3 `deleteProfile` + 5 `deriveLastOfRole`. No duplicates found. Each case tests a distinct input conjunction. The `canDeleteUser` 11 cases match the spec §AC3.3 matrix cell-for-cell with no overlap. The `deriveLastOfRole` 5 cases cover distinct input shapes. The `deleteProfile` 3 cases cover disjoint code paths (default / silent / error). The overshoot from +14 target to +19 reflects the architect spelling out all 11 `canDeleteUser` branches plus 5 `deriveLastOfRole` cases — not padding.

#### Framework deviation

The `tests/babel-jest-dynamic-import.js` transformer is the only deviation from the spec's stated design. The spec assumed jest would automatically intercept dynamic imports via `jest.mock`; the developer discovered this assumption was incorrect under `babel-preset-expo` and added an in-tree transformer. This is explicitly documented in `spec.md § "Architect-design deviation"` and in the transformer's own header. The deviation is well-motivated and correctly implemented. No new framework (vitest, playwright, etc.) was introduced.
