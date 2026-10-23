## Code review for spec 173

Scope reviewed: staged diff for `src/lib/db.ts` (catalog block of `updateInventoryItem`), the one-line mock change in `src/lib/db.eodCountMode.test.ts`, and the two new spec173 test files. I also read `useStore.updateItem` (`src/store/useStore.ts:2277-2329`) to confirm the revert and toast path the store test pins. The change implements D1-D6 as designed and I found no bugs.

### Critical
None.

- No `supabase.from` or `supabase.rpc` calls were added outside `db.ts`.
- No legacy files were touched.
- `app.json` was not touched.
- No new realtime channels were added.
- Both new test files follow the jest track and the `*.specNNN.test.ts` pattern.
- `updateItem` is still the only production caller of `updateInventoryItem` (grep confirmed). The new rejections therefore reach the existing optimistic-then-revert and `notifyBackendError` path, with no new `useStore.ts` code.

### Should-fix
None.

### Nits
- `src/lib/db.ts:487-492` — The old comment ("Resolve the catalog_id for this row before updating.") now sits directly above a long spec-173 comment, and the two read as one muddled block. Merge them into one comment that leads with the "why": every catalog failure throws here, before the per-store and `item_vendors` writes, so there is no half-write. The `.single()` / PGRST116 sentence is a good "why" and should stay.
- `src/lib/db.ts:504-506` — The comment is good. The final clause ("A no-op edit still matches its row and returns 1") restates N2 from the spec. Fine to keep, but it is the sort of thing that goes stale if PostgREST semantics change.
- `src/lib/db.updateInventoryItem.catalogErrors.spec173.test.ts:129-197` — The AC-1 to AC-4 inputs are arranged twice: inline in the individual `it`s, and again in `FAILURE_CASES` for the AC-5/6 loop. Each arrangement is one or two lines, so this is not worth refactoring. If a fifth failure mode is added later, only one of the two lists will be updated by accident. A comment tying `FAILURE_CASES` to the individual tests would be enough.
- `src/lib/db.updateInventoryItem.catalogErrors.spec173.test.ts:162-164` — The AC-4 assertion pins the entire `select` op list on `catalog_ingredients` with `toEqual([...])`. It will fail if anyone later adds an unrelated `select` on that table in the same function. Asserting `toContainEqual` would pin exactly "`select('id')` was chained" and nothing more.
- `src/store/useStore.updateItem.catalogRevert.spec173.test.ts:113-115` — `expect(snapshot).toBeDefined()` followed by `{ ...snapshot! }` is fine. Since `ITEM` is already in scope, `pre` could be built from it directly and the lookup dropped. Cosmetic.
- (out-of-scope) `src/store/useStore.ts:2317` — The `'Item edit'` audit event still fires on a failed update, so the audit log records an edit that was reverted. D7 already calls this out as pre-existing. It is noted here only so it is not forgotten.
- (out-of-scope) `src/lib/db.ts:471` — `catalogUpdates: any` and `perStore: any` are pre-existing. This diff did not introduce them.

### Verified, no action
- The check order is correct: `lookupError` is checked before the `catalog_id` check, so a null `data` produces the raw PostgREST error rather than the "no catalog link" message.
- `.select('id')` is chained before `.abortSignal(signal)`, which matches the design.
- `if (!updated || updated.length === 0)` handles both a null and an empty array.
- Both thrown strings match D3 byte for byte, and the tests pin them via shared constants.
- The `db.eodCountMode.test.ts` change is a single line, as D5 specified. The existing assertions are untouched.
- The store test asserts (a) the optimistic value, (b) a `toEqual` revert to the pre-edit snapshot, and (c) exactly one `Toast.show` call with the expected `text1` and `text2`. It covers both a PostgREST-shaped rejection and an `Error`.
- The mocks follow the project pattern: the store test mocks `../lib/supabase`, `../lib/auth`, and `../lib/db`, and `addAuditEvent` resolves so it does not add a second toast.
- No inline colors, `Alert`, or `window` usage, and no web-only APIs.

Summary: 0 Critical, 0 Should-fix, 7 Nits (2 of them out-of-scope notes).
