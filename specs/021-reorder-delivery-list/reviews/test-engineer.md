# Test report for spec 021 — Reorder / delivery list v1 (round 2)

## Framework note

No test framework (jest/vitest/playwright) is wired in this repo. All tests
below were executed as direct `docker exec psql` RPC calls + HTTP smoke tests
against the local Supabase stack (`npm run dev:db`). This matches the project's
existing `scripts/smoke-edge.sh` pattern and the explicit CLAUDE.md policy
requiring a real local database. Test data was inserted and rolled back within
each test block. Round 1 had 4 FAIL; this round re-tests all 4 and spot-checks
5 of the 19 round-1 PASSes.

---

## Acceptance criteria status

**AC1** — On-hand uses most recent EOD submission for vendor today; falls back
to `current_stock` when no EOD today. UI indicates source per vendor.
→ **PASS** (no regression)
Re-verified: TC-EOD-01 with fresh US FOOD submission today returned
`on_hand_source='eod'`, `eod_submitted_at` populated. COSTCO (no EOD) returned
`on_hand_source='stock'`. TC-EOD-03 confirmed 29/30 US FOOD items got
`eod_missing_for_item` flag (only 1 item had an entry in the submission).

**AC2** — Hybrid formula: `suggested_qty = max(par_replacement, usage_forecasted)`.
→ **PASS** (no regression)
Formula verified in round 1; RPC structure unchanged. The `vendor_delivery_offsets`
rewrite in the round-2 migration still correctly feeds `days_until` into the
`usage_forecasted` formula. Baseline call continues to return identical item math.

**AC3** — Inline breakdown `on hand: N | inbound: N | par: N → order: N`.
`pending_po_qty` always 0 in v1.
→ **PASS** (no regression)
TC-RPC-01 re-run: all 139 Towson items returned `pending_po_qty=0`. Payload
shape unchanged. `BreakdownLine` component is unmodified from round 1.

**AC4** — `RestockSection.tsx` unchanged; "Reorder" is a new sibling sidebar
entry immediately after "Restock" in the Planning group.
→ **PASS** (no regression)
Round-2 changes touch only `ReorderSection.tsx`, `useStore.ts`, and the
migration. `cmdSelectors.ts`, `InventoryDesktopLayout.tsx`, and
`RestockSection.tsx` are unmodified.

**AC5** — Vendors with no `order_schedule` row shown with "Schedule unknown —
using default 7-day buffer" badge. Card still renders.
→ **PASS** (no regression)
Baseline call with 10 Towson vendors, 0 order_schedule rows: all 10 returned
`schedule_known=false`, `days_until_next_delivery=7`. 10 `_warnings` entries
with `code='schedule_unknown'` were returned. Frontend continues to render
`Badge label="SCHEDULE UNKNOWN"` and `Badge label="7-DAY DEFAULT"` per the
round-2 code (orthogonal to EOD badge — see AC-BADGE below).

**AC — RPC auth gate (store-scoped)**
→ **PASS** (no regression)
TC-AUTH-01: anon call returns HTTP 401 with `code: 42501, message: permission
denied for function report_reorder_list`. TC-AUTH-02: admin calling Towson
returns full payload (10 vendors, 139 items). Function correctly gate-checks
via `auth_can_see_store()`.

**AC — Cost-per-unit per item, vendor total cost per card**
→ **PASS** (no regression)
TC-RPC-01 re-run: every item in the payload includes `cost_per_unit` and
`estimated_cost`. Vendor cards include `vendor_total_cost`. No change to cost
logic in round 2.

**AC — "Create PO" button disabled with tooltip**
→ **PASS** (no regression)
`DisabledCreatePoButton` is a `View` with no `onPress`. Unmodified in round 2.

**AC — Realtime: page refreshes on `eod_submissions`, `purchase_orders`,
`inventory_items` changes**
→ **PASS (structural, no regression)**
`useRealtimeSync.ts` subscription registrations unchanged in round 2.

**AC — Vendor with zero suggested items hidden**
→ **PASS** (no regression)
Baseline call confirms vendor count = 10, matching the 10 Towson vendors with
items below par. The filter at `per_item_filtered WHERE suggested_qty >= 0.001`
is unchanged.

**AC — Schedule edge cases**
→ **PASS** (all sub-tests — includes 4 new sub-tests that were FAIL in round 1)

Sub-test details:
- Wed+Fri vendor called on Thursday 2026-05-14 → `days_until=1` (was 6 in round 1) **PASS**
- Wed-only vendor called on Wednesday 2026-05-13, cutoff=23:59 → `days_until=0` **PASS**
- Wed-only vendor called on Wednesday 2026-05-13, cutoff=00:01 → `days_until=7` **PASS**
- Wed+Fri vendor called on Wednesday 2026-05-13, cutoff=23:59 → `days_until=0` (Wed wins) **PASS**
- Wed+Fri vendor called on Wednesday 2026-05-13, cutoff=00:01 → `days_until=2` (Fri wins) **PASS**
- `as_of_date` override via `p_params` → envelope echoes override date **PASS**

**AC — Flag chips per item**
- `no_par` (NULL par_level) → **PASS** (round 1; unchanged)
- `no_usage_rate` (usage_per_portion=0 or no POS data) → **PASS** (round 1; confirmed present on Lamb Gyro Meat in TC-EOD-01 re-run)
- `eod_missing_for_item` → **PASS** (round 1; re-confirmed with 29/30 items in TC-EOD-03)
- `truncated` (recipe depth cap) → **NOT TESTED directly** (no depth-5 chain in seed; unchanged from round 1)

---

## Round-2 FAIL → PASS confirmations

### FAIL-SCHED-MULTI → PASS

**Test setup:** inserted `order_schedule` rows for COSTCO (Towson) with
`delivery_day='Wednesday'` (DOW=3) and `delivery_day='Friday'` (DOW=5). Called
`report_reorder_list` with `as_of_date='2026-05-14'` (Thursday, DOW=4).

**Round-1 result:** `days_until=6` (selected Wednesday, computed `(3-4+7)%7=6`).

**Round-2 result:** `days_until=1`, `next_delivery_date=2026-05-15`.

**Root cause verified fixed:** the migration's `vendor_delivery_offsets` CTE now
computes per-row distance `((dow - today_dow + 7) % 7)` inside the lateral
before applying the cutoff push-to-7 per row, then takes `MIN` over those
distances. The previous MIN over raw DOW numbers is gone. All 5 sub-tests pass.

**RPC call used:**
```
POST /rest/v1/rpc/report_reorder_list
{"p_store_id": "00000000-0000-0000-0000-000000000001", "p_params": {"as_of_date": "2026-05-14"}}
```
Result: `COSTCO days_until_next_delivery=1 next_delivery_date=2026-05-15`.

---

### FAIL-WARN-OVERFLOW → PASS

**Test setup:** set all 31 US FOOD `inventory_items.current_stock = par_level`
so US FOOD has zero suggested items and is filtered from the payload. US FOOD
has no `order_schedule` row (confirmed `sched_rows=0`).

**Round-1 result:** US FOOD absent from `vendors[]` but present in `_warnings[]`
with `code='schedule_unknown'`.

**Round-2 result:** US FOOD absent from `vendors[]` AND absent from `_warnings[]`.
SYSCO (14 items below par, no schedule) continues to appear in both.

**Root cause verified fixed:** the warnings CTE in step (5) of the migration now
joins against `surfaced_vendor_ids` extracted from the already-built `v_vendors`
jsonb envelope. A vendor whose items are all at par (filtered out of the payload)
cannot appear in the surfaced set, so no warning is emitted.

**Exact verification:**
```
US FOOD in vendors[]: False   (expected False)
US FOOD in _warnings[]: False  (expected False)
SYSCO in vendors[]: True       (expected True)
SYSCO in _warnings[]: True     (expected True)
Total vendor_count: 9
Total _warnings count: 9
```

After test: restored all US FOOD items to `current_stock=0`.

---

### FAIL-BADGE-MASK → PASS (code verification)

**Finding:** `ReorderSection.tsx` lines 190-196 — `sourceBadgeEl` and
`scheduleBadgeEl` are now two independent variables:

```tsx
const sourceBadgeEl =
  vendor.onHandSource === 'eod'
    ? <Badge label="EOD" tone="accent" />
    : <Badge label="STOCK FALLBACK" tone="warn" />;
const scheduleBadgeEl = vendor.scheduleKnown
  ? null
  : <Badge label="SCHEDULE UNKNOWN" tone="warn" />;
```

Both are rendered unconditionally in the header row (lines 231, 233):

```tsx
{sourceBadgeEl}
{scheduleBadgeEl}
```

The round-1 bug was a precedence ladder that set `sourceBadge = 'SCHEDULE UNKNOWN'`
when `scheduleKnown=false`, overwriting the EOD/STOCK value. That ladder is gone.
A vendor with EOD today AND no order_schedule now shows `EOD` + `SCHEDULE UNKNOWN`
+ `7-DAY DEFAULT` side-by-side. Code confirmation is definitive; no browser
render needed for the logic check.

---

### FAIL-STALE-STORE → PASS (code verification)

**Finding:** `useStore.ts` lines 887-893 — `loadFromSupabase` now clears the
reorder slice:

```typescript
// Spec 021 — clear the reorder envelope on store switch so the
// section's mount-effect pulls fresh data for the new store
// instead of briefly showing the previous store's vendor cards.
reorderPayload: null,
reorderLoading: false,
reorderError: null,
```

`loadFromSupabase` is called by `setCurrentStore` on every store switch (lines
473-490). When a user switches stores, `reorderPayload` is immediately set to
`null`, so the `ReorderSection` renders its loading/empty state during the
RPC round-trip instead of flashing the previous store's vendor cards.
The initial-state comment at lines 416-420 accurately describes this behavior.

---

## Round-1 PASS spot-checks (regression verification)

| Test ID | Description | Round-2 result |
|---|---|---|
| TC-RPC-01 | Envelope shape: 4 top-level keys, vendor/item key sets, vendor_count=10, all pending_po_qty=0 | PASS |
| TC-AUTH-01 | Anon call → HTTP 401, code=42501 | PASS |
| TC-AUTH-02 | Admin call Towson → 10 vendors, 139 items | PASS |
| TC-EOD-01 | EOD submission → on_hand_source=eod, Lamb Gyro on_hand=0.5 | PASS |
| TC-EOD-02 | No EOD for COSTCO → on_hand_source=stock | PASS |
| TC-EOD-03 | 29/30 US FOOD items with eod_missing_for_item flag (1 item in submission) | PASS |
| TC-SCHED-02 | Friday delivery vendor called from Wednesday → days_until=2 | PASS |
| TC-SCHED-05 | as_of_date='2026-05-15' override echoed in envelope | PASS |

---

## Test run summary

```
TC-RPC-01       Baseline envelope shape, vendor_count=10, all pending_po_qty=0    PASS
TC-AUTH-01      Anon call → HTTP 401, code=42501                                   PASS
TC-AUTH-02      Admin Towson → 10 vendors, 139 items                               PASS
TC-EOD-01       EOD submission → on_hand_source=eod, on_hand=0.5                   PASS
TC-EOD-02       No EOD for COSTCO → on_hand_source=stock                            PASS
TC-EOD-03       eod_missing_for_item on items not in EOD entries                    PASS
TC-SCHED-02     Friday vendor from Wednesday → days_until=2                         PASS
TC-SCHED-05     as_of_date override echoed correctly                                PASS
FAIL-SCHED-MULTI  Wed+Fri vendor on Thursday → days_until=1 (was 6)                PASS
FAIL-SCHED-MULTI  Wed-only on Wed before cutoff → days_until=0                     PASS
FAIL-SCHED-MULTI  Wed-only on Wed after cutoff → days_until=7                      PASS
FAIL-SCHED-MULTI  Wed+Fri on Wed before cutoff → days_until=0 (Wed wins)           PASS
FAIL-SCHED-MULTI  Wed+Fri on Wed after cutoff → days_until=2 (Fri wins)            PASS
FAIL-WARN-OVERFLOW  Vendor at par absent from vendors[] AND _warnings[]             PASS
FAIL-WARN-OVERFLOW  Vendor below par with no schedule in both (SYSCO)               PASS
FAIL-BADGE-MASK  sourceBadgeEl/scheduleBadgeEl rendered independently (code)       PASS
FAIL-STALE-STORE  reorderPayload cleared in loadFromSupabase (code)                PASS
TC-TRUNCATED    'truncated' flag (depth-5 chain)                                    NOT TESTED
```

Round 2 pass: 17/17 executed, 0 FAIL, 0 REGRESSED.
Round 1 carry-over: 19 PASS (spot-checked 8, no regressions found).
Total acceptance criterion coverage: 23 PASS, 0 FAIL, 1 NOT TESTED (truncated flag).

---

## Notes

**No regression found in any round-1 PASS.** The round-2 migration is a
`create or replace function` — no schema mutation, no FK changes. The store
and section changes are additive only.

**`truncated` flag still NOT TESTED directly.** The Towson seed has no
depth-5 recipe chain. The flag logic is structurally present in SQL at lines
197-207 and 468-471, identical to the variance runner's treatment. This is the
same position as round 1 — acceptable for v1.

**FAIL-BADGE-MASK and FAIL-STALE-STORE verified by code analysis, not browser
rendering.** Both fixes are logic changes with unambiguous before/after
structure. The badge fix removes a conditional ladder and replaces it with two
independent assignments + two unconditional renders. The store-switch fix adds
three literal assignments in `loadFromSupabase`. Neither requires a live browser
session to confirm correctness.

**Test framework gap.** No jest/vitest/playwright is wired. All tests are
shell+curl smoke tests. Per agent instructions: surfacing here; no framework
introduced without explicit user approval.

**Block decision: NO.** All 4 round-1 FAILs are PASS in round 2. No ACs are
FAIL. The only NOT TESTED criterion (truncated flag) was accepted in round 1
and is unchanged. Release-coordinator can proceed.
