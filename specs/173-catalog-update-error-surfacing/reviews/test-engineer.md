## Test report for spec 173

### Acceptance criteria status
- AC-1 (lookup error rejects): PASS. `src/lib/db.updateInventoryItem.catalogErrors.spec173.test.ts::AC-1: a lookup error is thrown raw and no catalog_ingredients op runs`. Also covered by the AC-5/AC-6 loop case "AC-1 lookup error (PGRST116)".
- AC-2 (missing catalog_id rejects): PASS. Same file, `AC-2: a missing catalog_id (%s) throws and issues no catalog UPDATE`. It runs three variants (data null, catalog_id null, catalog_id undefined) and pins the D3 string.
- AC-3 (catalog UPDATE error rejects): PASS. Same file, `AC-3: a catalog UPDATE error (CHECK 23514) is thrown raw with its message intact`. It asserts code `23514` and the message.
- AC-4 (0-row UPDATE rejects): PASS. Same file, `AC-4: a 0-row catalog UPDATE ... select('id') is chained`, plus `AC-4: a null data array ... also throws`. It pins the D3 string and asserts `select('id')` was chained on `catalog_ingredients`.
- AC-5 (no half-write): PASS. Same file, `AC-5/AC-6 (%s)` loop over 5 failure variants. It uses a mixed payload (`name`, `parLevel`, `vendorId`, `vendors[]`) and asserts zero `inventory_items` update ops and zero `item_vendors` ops.
- AC-6 (rejection carries a non-empty message): PASS. Same loop asserts `typeof message === 'string'` and a non-empty length for every case. AC-1 and AC-3 additionally pin the original code and message via `toMatchObject`. The store test also asserts that the toast `text2` equals the rejection message.
- AC-7 (happy path unchanged): PASS. Same file, `AC-7: a 1-row catalog UPDATE resolves; catalog -> per-store -> item_vendors order holds`. It asserts op-index ordering, the demote/upsert/delete counts, and the `eq('id', CATALOG_ID)` target.
- AC-8 (no catalog fields, no catalog work): PASS. Same file, `AC-8: %s issues no catalog_id lookup and no catalog op, even with a poisoned lookup`. It covers `{ parLevel: 5 }` and a vendors-only payload. The lookup and the catalog table are poisoned, and the call still resolves with no `select('catalog_id')` and no `catalog_ingredients` op.
- AC-9 (existing db tests pass, assertions unchanged): PASS. `src/lib/db.eodCountMode.test.ts` and `src/lib/db.updateInventoryItemPrimarySwitch.test.ts` both pass. The only diff to the first is one added mock line (`tableResults.catalog_ingredients = { data: [{ id: CATALOG_ID }], error: null }`), which the AC allows because the 0-row check needs it. The second file is untouched.
- AC-10 (store reverts and toasts): PASS. `src/store/useStore.updateItem.catalogRevert.spec173.test.ts::reverts to the pre-edit snapshot and toasts once (PostgREST-shaped rejection | Error rejection)`. Part (a) asserts the optimistic `'New'` synchronously and that no toast has fired yet. Part (b) asserts `toEqual` against the pre-edit snapshot. Part (c) asserts exactly one `Toast.show` with `type: 'error'`, `text1: 'Update item failed'`, and `text2` equal to the rejection message.
- AC-11 (gates green, staged not committed): PASS. Full `npx jest`, `npm run typecheck`, and `npm run typecheck:test` all passed. `git status` shows the changes staged (`A`/`M` in the index) and nothing committed.

Summary: 11 PASS, 0 FAIL, 0 NOT TESTED.

### Test run
- Targeted: `npx jest` on the two spec173 files, `db.eodCountMode.test.ts`, and `db.updateInventoryItemPrimarySwitch.test.ts` gave 4 suites passed and 33 tests passed.
- Full: `npx jest` gave 257 suites passed and 3194 tests passed, with 0 failures. This matches the developer's reported count.
- `npm run typecheck` (tsc --noEmit) passed with no errors.
- `npm run typecheck:test` passed with no errors.
- The `console.warn` output in the store test is the expected `notifyBackendError` call.

### Notes
- Red-on-old reasoning (reasoned only; I did not touch `src/lib/db.ts` or run the old code).
  - At HEAD the catalog block ignores the lookup `error` and skips the write when `catalogId` is falsy. It also ignores the UPDATE result.
  - So at HEAD the AC-1, AC-2, AC-3, and AC-4 tests would all resolve instead of rejecting, and the `rejects` assertions would fail. The AC-5/AC-6 loop would also fail because no `caught` value would exist.
  - The AC-4 `select('id')` chain assertion would fail at HEAD.
  - AC-7 and AC-8 would pass on old code, as they should, since they pin unchanged behavior. The AC-7 `eq` assertion passes either way.
  - The store test (AC-10) mocks `db.updateInventoryItem`. It is a regression pin on the existing revert and toast path, not a red-on-old test. This matches the spec's D6 design. The real link, db rejecting where it used to resolve, is covered by the db-level tests.
- All tests use a mocked supabase builder, as the spec explicitly directs (jest only, no pgTAP). The project's real-DB policy is not exercised, so the RLS-denial case (AC-4) is verified only at the mock level (`data: []`, `error: null`). Nothing in the spec asks for DB-level coverage, because there is no DB change. As a residual risk, whether PostgREST actually returns `[]` for an RLS-filtered UPDATE with `.select('id')` was not verified against the local stack. It is documented PostgREST behavior and the spec states it as a given.
- Optional gap, not an AC: the "Mixed payloads are now all-or-nothing" and "non-privileged editors now see errors" behavior changes (design D7) are intended and covered by the AC-5 tests. The audit event still fires on failure (pre-existing, out of scope).
- No new framework was introduced. I made no edits to source or tests, and I did not touch `app.json`.
