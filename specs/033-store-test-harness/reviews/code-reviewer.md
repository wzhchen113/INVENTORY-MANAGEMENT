# Code review for Spec 033

## Summary

- 0 Critical
- 1 Should-fix (RESOLVED by Main Claude pre-commit)
- 3 Nits

## Critical

None. No direct Supabase calls outside `db.ts`, no legacy file recreation, no slug changes, no wrong optimistic pattern.

## Should-fix

### S1 — Transformer cache-key omits wrapper file content (RESOLVED)

`tests/babel-jest-dynamic-import.js:63-64` delegated `getCacheKey` and `getCacheKeyAsync` verbatim from `babel-jest` without mixing in the wrapper file's own content (`DYNAMIC_IMPORT_RX` regex + `rewrite` function). `babel-jest`'s upstream cache key hashes its own source — NOT the wrapper's — so a future edit to the regex or rewrite logic would not invalidate jest's transform cache; users would get stale transformed output until they manually ran `jest --clearCache`.

**Resolution applied by Main Claude before commit:** added `THIS_FILE_HASH` constant (SHA-1 of the wrapper file at module-eval) and `mixCacheKey()` helper that folds it into both `getCacheKey()` and `getCacheKeyAsync()` results. Tested with `npx jest --clearCache && npm test -- --ci` — 54/54 PASS.

## Nits

### N1 — Unnecessary `as any` intermediary in test

`src/store/useStore.test.ts:120` — `(Toast as any).show as jest.Mock` uses an unnecessary `any` intermediary. The `react-native-toast-message` type declaration defines `show` on the Toast namespace — `Toast.show` is already typed. Drop the `(... as any)` wrapper:

```ts
// Preferred (matches auth.test.ts:59 pattern):
const toastShowMock = Toast.show as jest.Mock;
// Or:
const toastShowMock = jest.mocked(Toast.show);
```

### N2 — Transformer SCOPE comment understates coverage

`tests/babel-jest-dynamic-import.js:36-37` says "none exist in src/ today" regarding computed-source dynamic imports, and implies literal imports only exist in `useStore.ts`. In fact:
- `src/components/cmd/Sidebar.tsx:42` — `import('./SidebarEditMode')`
- `src/screens/cmd/sections/ReorderSection.tsx:457-458` — `import('jspdf')` and `import('jspdf-autotable')`

The rewrite is harmless for those files in the current test suite (no component tests for them yet), but the comment creates a false sense of safety. Revise to say "all literal-source dynamic imports in `src/` are intentionally covered" rather than implying there's only one.

### N3 — Minor comment imprecision

`src/store/useStore.test.ts:116` — comment says "this file never names an internal-only field directly" as rationale for opaque snapshot. The next block (`makeUser`) constructs a `User` shape typed against the public `User` interface and seeds `brandAdminsByBrandId` by name — that's not an internal field, so the comment is fine as a policy statement, but the word "directly" slightly overstates it since the test references `brandAdminsByBrandId` by name on multiple lines.

## Coverage notes (no findings)

- `userPermissions.ts` extraction is byte-for-byte equivalent to the pre-refactor inline expressions (only `user.role` → `targetRole` rename and named-arg destructuring).
- `UsersSection.tsx` refactor preserves render order, prop flow, and memoization.
- `useStore.test.ts` correctly captures `INITIAL_STATE` after `jest.mock` hoists and resets via `useStore.setState(INITIAL_STATE, true)` in `beforeEach`.
- Mocks for `../lib/supabase`, `../lib/auth`, `../lib/db` use minimal-surface stubs — no JWTs, tokens, real UUIDs, or PII.
- `tests/README.md` addition is strictly additive (no existing prose rewritten).
- Test count gate: 35 → 54 (+19 vs +14 target), strong overshoot from the 16 `userPermissions` cases + 3 `useStore` cases.
