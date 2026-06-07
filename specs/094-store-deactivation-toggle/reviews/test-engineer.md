## Test report for spec 094 (store-deactivation-toggle)

> **Re-review** — two Criticals from the prior FIXES_NEEDED verdict have been addressed.
> This report supersedes the previous test-engineer.md.

---

### Acceptance criteria status

- **AC1: An authorized admin can toggle a store between active/inactive from an inline control on each store row in StoresTab. The toggle persists stores.status and the new value is reflected on the row on next render.**
  - Persistence path (db.updateStore writes status, useStore.updateStore delegates): PASS — `src/lib/db.updateStore.test.ts::updateStore maps status into the UPDATE body` + `src/store/useStore.updateStore.test.ts::optimistically flips status locally and delegates to db.updateStore with status`
  - UI wiring (include-inactive fetch, ACTIVE pill rendered, DEACTIVATE affordance present, pill flips after toggle): PASS — `src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx::loads the include-inactive list and renders the ACTIVE pill for an active store` + `::DEACTIVATE: confirms via confirmAction, then calls updateStore({status:inactive}) and flips the pill`

- **AC2: Toggling to inactive shows a confirm dialog before persisting (confirmAction); re-activating may skip confirm.**
  - confirmAction called on deactivate with correct title, message, and confirm label: PASS — `StoresTab.toggle.test.tsx::DEACTIVATE: confirms via confirmAction ...`
  - confirmAction NOT called on re-activate: PASS — `StoresTab.toggle.test.tsx::ACTIVATE: does NOT confirm ...`
  - Cancelling the dialog does not call updateStore: PASS — `StoresTab.toggle.test.tsx::DEACTIVATE cancelled: does NOT call updateStore and the pill stays ACTIVE`

- **AC3: The status change persists via the standard db.ts path — db.ts updateStore writes stores.status AND useStore.updateStore includes status in dbUpdates.**
  - PASS — `src/lib/db.updateStore.test.ts::updateStore maps status into the UPDATE body and filters by id` + `src/store/useStore.updateStore.test.ts::optimistically flips status locally and delegates to db.updateStore with status`

- **AC4: The admin Brands > Stores list shows BOTH active and inactive stores via a separate include-inactive fetch path. The existing global fetchStores .eq('status','active') filter is UNCHANGED and the global stores cache remains active-only.**
  - fetchStoresIncludingInactive returns both: PASS — `src/lib/db.updateStore.test.ts::returns both active and inactive stores, mapped snake to camel` + `::does NOT apply a status filter`
  - fetchStores active-only filter unchanged: PASS — implementation at `src/lib/db.ts:49` is unchanged; confirmed by code read.
  - No global cache leakage: PARTIALLY TESTED — `StoresTab.toggle.test.tsx` confirms the mock for `fetchStoresIncludingInactive` is separate from the `useStore` mock and `updateStore` is the only store method consumed by `StoresTab`. No dedicated assertion verifies `useStore.getState().stores` is untouched after calling `fetchStoresIncludingInactive`, but the implementation routes the result into `useState` (not `useStore.setState`). Minor gap only; not a blocker.

- **AC5: Setting a store inactive suppresses ALL store-tied notification streams. The existing eod-reminder-cron gate (.eq('status','active') at eod-reminder-cron/index.ts:188) already suppresses Track 1 and Track 2; this criterion is to confirm/preserve that gate.**
  - PASS — `supabase/tests/stores_privileged_update_status.test.sql` arms (7) and (8) now pin the cron gate:
    - Arm (7): inactive store is EXCLUDED by `where status = 'active'` (suppression assertion)
    - Arm (8): active store IS INCLUDED by `where status = 'active'` (inclusion sanity — prevents false-pass by empty result)
  - Both arms passed in the current run (8/8 assertions in the file).

- **AC6: The toggle is reversible — re-activating sets status='active' and the store resumes receiving notifications on the next cron run.**
  - Persistence reversibility: PASS — `stores_privileged_update_status.test.sql::arm (2): brand admin can re-activate the store (reversibility AC)`
  - Resume receiving notifications: PASS (follows from AC5 — cron gate is pinned; re-activation puts the store back in the active-store query set, as confirmed by arm (8)).

- **AC7: No store data is deleted by deactivation — inventory, recipes, EOD history, sales are preserved; only stores.status changes.**
  - NOT TESTED by a dedicated test. The implementation is a single-column PATCH with no cascades or triggers gated on status. Low risk in practice, but not covered by automation. Classified as a Minor gap (not a blocker) — same standing as the prior review.

- **AC8: The status update is gated to admin/master/super_admin server-side (RLS policy and/or RPC mirroring auth_is_privileged()), not UI-only. A non-privileged caller's status update is rejected by the backend.**
  - PASS — `supabase/tests/stores_privileged_update_status.test.sql` covers all six role/privilege arms:
    - Arm (1): admin of brand flips active→inactive (admitted)
    - Arm (2): admin flips inactive→active (reversibility)
    - Arm (3): master JWT of brand flips status (admitted)
    - Arm (4): non-privileged (role=user) UPDATE affects 0 rows (rejected)
    - Arm (5): cross-brand admin UPDATE affects 0 rows (rejected)
    - Arm (6): super_admin flips ANY brand's store (admitted via auth_is_super_admin short-circuit)

---

### Test run

**jest (npm test)**
```
Test Suites: 60 passed, 60 total
Tests:       598 passed, 598 total
Time: ~2.4 s
```
New spec-094 jest tests: `src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx` (4 tests) — all PASS.
Prior spec-094 jest tests: `src/lib/db.updateStore.test.ts` (8 tests) + `src/store/useStore.updateStore.test.ts` (3 tests) — all PASS.

**pgTAP (npm run test:db)**
```
44/44 DB test file(s) passed
stores_privileged_update_status.test.sql: 8 assertion(s) passed (was 6; arms 7+8 added)
```

**Shell smokes (npm run test:smoke)**
```
smoke-edge.sh: all checks passed
smoke-rpc.sh: all checks passed
smoke-edge-roles.sh: all checks passed
```

**Typecheck**
`npm run typecheck` — clean (0 errors)
`npm run typecheck:test` — clean (0 errors)

---

### Prior Criticals — closure verification

**Critical 1 (AC1+AC2): No jest test for StoresTab toggle UI**
Closed. `src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx` adds 4 tests that directly drive the rendered `StoresTab` component (named export added at `BrandsSection.tsx:1051`):
- Test 1 confirms `fetchStoresIncludingInactive` is called on mount and the ACTIVE pill renders.
- Test 2 confirms `confirmAction` is called with the expected title/message/label and, on confirm, `updateStore('store-1', { status: 'inactive' })` is called and the pill flips to INACTIVE.
- Test 3 confirms that when the confirm dialog is cancelled (`onConfirm` is never invoked), `updateStore` is not called and the pill stays ACTIVE.
- Test 4 confirms that for an inactive store the ACTIVATE button does NOT invoke `confirmAction`, calls `updateStore('store-2', { status: 'active' })`, and the pill flips to ACTIVE.
All 4 pass.

**Critical 2 (AC5): No regression pin for eod-reminder-cron gate**
Closed. Arms (7) and (8) added to `supabase/tests/stores_privileged_update_status.test.sql` reproduce the cron's exact `where status = 'active'` filter under the RLS-bypassing postgres role (mirroring the service-role context the cron runs under). Arm (7) asserts an inactive store is excluded; arm (8) asserts an active store is included, preventing a false-pass by an empty result set. Both arms pass.

---

### Remaining minor gaps (non-blocking)

| Gap | AC | Severity |
|---|---|---|
| No explicit test that fetchStores global cache is untouched after fetchStoresIncludingInactive call | AC4 partial | Minor — implementation routes to useState, not useStore; correct by construction |
| No explicit test that status flip leaves related data (inventory_items, eod_submissions, etc.) untouched | AC7 | Minor — implementation is a single-column PATCH with no cascades; trivially correct |

Both minor gaps were present in the prior review. Neither is a blocker for SHIP_READY.

---

### Verdict

**Both prior Criticals are genuinely closed.** All three test tracks pass with no regressions. The only remaining gaps are Minor (AC4 partial global-cache note and AC7 no-cascade assertion), both inherited from the prior review and not blockers. This spec may proceed to SHIP_READY evaluation.
