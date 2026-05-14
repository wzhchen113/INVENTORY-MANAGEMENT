## Test report for spec 029

### Acceptance criteria status

#### Item 1 — Shared `useIsMaster` hook

- AC1a: `useIsMaster(): boolean` exported from `src/hooks/useRole.ts`, reads `useStore((s) => s.currentUser?.role)`, returns true iff role is `'master'` or `'super_admin'` → **PASS** — `src/hooks/useRole.ts:45–48` matches the architect §1 spec exactly.

- AC1b: `UsersSection.tsx` no longer defines a local `useIsMaster`; imports from `'../../../hooks/useRole'` and uses it at the existing call site → **PASS** — import confirmed at line 13; no local declaration found; `const isMaster = useIsMaster()` at line 38.

- AC1c: `InviteUserDrawer.tsx` no longer derives `isMaster` inline; imports `useIsMaster` from `'../../hooks/useRole'` and calls it once at the top of the component → **PASS** — import at line 10; `const isMaster = useIsMaster()` at line 55; previous `currentUser?.role === …` derivation and the `currentUser` selector are both gone (confirmed by grep: zero `currentUser` hits in InviteUserDrawer.tsx).

- AC1d: Grepping for `currentUser?.role === 'master' || currentUser?.role === 'super_admin'` returns zero matches outside `src/hooks/useRole.ts` → **PASS** — grep confirmed one hit only: `TitleBar.tsx:41`, which is the wider `isAdmin = 'admin' || 'master' || 'super_admin'` predicate explicitly carved out by architect §2 as a different predicate, not the literal two-part `isMaster` form being tracked by this AC.

- AC1e: `useIsMaster` carries a JSDoc comment in the same shape as `useIsSuperAdmin`, documenting the three gate sites → **PASS** — `src/hooks/useRole.ts:29–44` contains the JSDoc block matching the architect §1 spec verbatim; lists all three gate sites (invite-drawer role-picker, UsersSection peer-row filter, UsersSection UserRow delete + reset-password gate generosity).

#### Item 2 — Drop the dead `isMaster ? 'user' : 'user'` ternary

- AC2a: `InviteUserDrawer.tsx` form-reset effect sets `role: 'user'` unconditionally — identity ternary removed → **PASS** — `src/components/cmd/InviteUserDrawer.tsx:68` is plain `role: 'user'`; no ternary present.

- AC2b: The comment above the line describes both master and non-master defaulting to `'user'` (per the spec's one-word-tweak requirement) → **PASS** — comment at lines 65–67 reads "both master and non-master admins default new invites to `role='user'`; master can switch to admin via the role picker below (non-master admins do not see the picker at all)."

- AC2c: `isMaster` dependency in the effect's deps array removed since it is no longer referenced inside the effect → **PASS** — deps array at line 72 is `[visible]`; `isMaster` correctly dropped because no in-effect reference remains. The file-scope `isMaster` variable is still present (used in the JSX role-picker render at line 256), so the symbol itself is not orphaned.

- AC2d (manual smoke): Opening drawer as non-master admin hides role picker and sends `role='user'`; opening as master/super_admin shows picker defaulting to 'user', switching to 'admin' wires brandId → **MANUAL-ONLY, awaiting Main Claude's browser run** — Code path verified: `{isMaster ? (<role picker …>) : null}` at line 256 is the sole conditional; non-master path emits nothing; `role: 'user'` default is set unconditionally in the effect.

#### Item 3 — Single toast on self-delete

- AC3a: `useStore.deleteProfile` accepts optional `opts?: { silent?: boolean }` second argument; `StoreState` interface updated → **PASS** — `src/store/useStore.ts:153` reads `deleteProfile: (profileId: string, opts?: { silent?: boolean }) => Promise<boolean>`. JSDoc at lines 146–152 documents the new branch.

- AC3b: When `opts?.silent === true`, `Toast.show({ type: 'info', text1: 'Profile deleted', … })` is skipped; behavior otherwise identical (cache cleanup + boolean return) → **PASS** — `src/store/useStore.ts:812`: `if (!opts?.silent) { Toast.show(…) }`. Cache cleanup (`brandAdminsByBrandId` filter) at lines 802–807 runs unconditionally. Error path at line 821 routes through `notifyBackendError` unconditionally.

- AC3c: Default (no opts, or `opts.silent !== true`) preserves existing `'Profile deleted'` info toast → **PASS** — the `if (!opts?.silent)` guard preserves identical toast call (same `type`, `text1`, `text2`, `visibilityTime`) for the no-opts and `{ silent: false }` paths.

- AC3d: `UsersSection.handleConfirmDelete` passes `{ silent: true }` when target is self → **PASS** — `src/screens/cmd/sections/UsersSection.tsx:106`: `const ok = await deleteProfile(target.id, isSelf ? { silent: true } : undefined)`.

- AC3e (manual smoke, self-delete): Triggering self-delete shows exactly ONE success toast (`'Account deleted' / 'Signing out…'`); no info toast; window navigates to `/` after ~1.5s → **MANUAL-ONLY, awaiting Main Claude's browser run** — Code path: store's `'Profile deleted'` toast is suppressed via `silent: true`; component fires `Toast.show({ type: 'success', text1: 'Account deleted', … })` at lines 110–115; `logout()` at line 116; `setTimeout(() => { window.location.href = '/' }, 1500)` at lines 117–119.

- AC3f (manual smoke, peer-delete): Deleting another user shows exactly ONE info toast (`'Profile deleted'` from store); local list refreshes → **MANUAL-ONLY, awaiting Main Claude's browser run** — Code path: `deleteProfile(target.id, undefined)` → `!opts?.silent` is true → store toast fires; then `refresh().catch(() => {})` at line 122.

- AC3g: No other call site of `deleteProfile` introduces `silent: true`; repo-wide grep confirms only `UsersSection` self-delete branch passes it → **PASS** — grep for `deleteProfile(` returned exactly two call sites: `UsersSection.tsx:106` (self-delete path with `{ silent: true }`) and `BrandsSection.tsx:999` (`deleteProfile(target.id)` — no opts, preserves existing behavior).

#### Cross-cutting verification gates

- AC-CC1: `npx tsc --noEmit` exits 0 (excluding pre-existing TS2688 noise) → **PASS** — zero new real errors from spec 029 files; all TS2688 errors are duplicate `node_modules/@types/<pkg> 2/` directory noise pre-existing on main.

- AC-CC2: `npm run typecheck:test` exits 0 → **PASS** — exit code 0 confirmed.

- AC-CC3: `npm test -- --ci` PASSes; no existing tests broken → **PASS** — 4 suites / 24 tests PASS. No `deleteProfile` test exists in the jest suite (see Notes).

- AC-CC4: `npm run test:db` PASSes → **PASS** — 14/14 DB test files pass (sanity only; no DB changes in spec).

- AC-CC5: `npm run test:smoke` PASSes → **PASS** — all smoke arms pass (sanity only; no edge function changes).

---

### Test run

```
npm test -- --ci
  PASS component src/components/cmd/StatusPill.test.tsx
  PASS unit src/utils/escapeHtml.test.ts
  PASS unit src/utils/relativeTime.test.ts
  PASS unit src/utils/seedVarianceDates.test.ts
  Test Suites: 4 passed, 4 total
  Tests:       24 passed, 24 total

npm run test:db
  ✓ 14/14 DB test file(s) passed

npm run test:smoke
  ✓ all checks passed
```

Typecheck: `npx tsc --noEmit` — only pre-existing TS2688 noise (duplicate `@types/<pkg> 2/` dirs), zero new errors.
`npm run typecheck:test` — exit 0, clean.

---

### Notes

#### On the deferred `useStore.test.ts` (architect §5)

The frontend developer correctly identified that no `useStore.test.ts` scaffold exists. The store's 1900+ lines and transitive imports (`data/seed`, `lib/db`, `lib/supabase`, `Platform`, `AsyncStorage`) make a first-time harness setup non-trivial for a polish spec. The defer is **acceptable as a ship-ready decision** given:

1. The `if (!opts?.silent)` conditional is the only new code branch in the spec.
2. The TypeScript interface change is fully type-checked (tsc + typecheck:test both pass).
3. Both callers are statically visible and verified by grep: the `BrandsSection.tsx:999` no-opts call compiles without change and is untouched.
4. The manual browser smokes (AC3e, AC3f) cover the runtime behavior that the jest test would have locked in.

Recommendation: scope a follow-up spec to stand up a `useStore.test.ts` harness with a `createTestStore()` factory that mocks `lib/auth`, `lib/db`, `lib/supabase`, and `Toast`. Once that exists, the AC3 silent-branch test is ~30 lines. The `canDelete` / `canResetPassword` helper extraction deferred in this spec's "Out of scope" section would also become cheap at that point.

#### On the three manual-only ACs

Three ACs (AC2d, AC3e, AC3f) are flagged **MANUAL-ONLY, awaiting Main Claude's browser run**. These are not blocking if Main Claude's preview runs go green. The code paths for all three are fully deterministic from the implementation (documented above under each AC). There is no ambiguity in the logic — the only question is runtime rendering, which requires a browser. If any smoke fails during Main Claude's run, the failure should be treated as a Critical and returned to the frontend developer.

#### Regression risk: `BrandsSection.tsx` caller

`BrandsSection.tsx:999` calls `deleteProfile(target.id)` with no second argument. The widened signature `opts?: { silent?: boolean }` is fully backward-compatible (opts is optional), and the TypeScript compiler confirms zero new errors at that call site. The toast, cache-cleanup, and error paths are all identical on the no-opts path — verified by reading the implementation. No regression risk.

#### Predicate-divergence follow-up (non-blocking)

Architect §2 flagged two other role predicate shapes outside scope of this spec:

- `'admin' || 'master'` (missing `super_admin`): `TimezoneBar.tsx:24`, `DashboardSection.tsx:732` — potential super-admin omission, same class of bug as spec 027's edge-function gap. Not a regression introduced by spec 029, but worth a PM question before the next role-related spec ships.
- `'admin' || 'master' || 'super_admin'` (wider predicate): `TitleBar.tsx:41`, `useStore.ts:480`, `BrandsSection.tsx:880`, `UsersSection.tsx:293` — correctly identified as a different predicate (`isPrivileged` / `isAnyAdmin`), not in scope.

These are informational. Neither is a Critical for spec 029 release.
