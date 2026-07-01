## Test report for spec 105

### Acceptance criteria status

- AC1: Each entry row in the `entries.tsv` detail table renders a par-status indicator derived from comparing `actualRemaining` against the item's current par level → PASS — `InventoryCountSection.parStatus.test.tsx::parStateFor — the three states` + `InventoryCountSection.tsx:1549-1550` (client-side par join confirmed in code)

- AC2: At/above par (`actualRemaining >= parLevel`, par > 0): row shows a green check (✓) indicator; no reorder suggestion text → PASS — `InventoryCountSection.parStatus.test.tsx::parStateFor::at/above par → "above"` (covers exactly-at-par and above); `InventoryCountSection.tsx:1574-1580` renders `C.ok` ✓ with no suggestionText branch

- AC3: Below par (`actualRemaining < parLevel`, par > 0): row shows red dot inline + inline reorder suggestion (quantity/timing, no cost); 5-column phone layout preserved (no 6th column) → PASS — `InventoryCountSection.parStatus.test.tsx::parStateFor::below par → "below"` + `formatCountedReorderSuggestion::case item + non-case item`; `InventoryCountSection.tsx:1581-1587,1643-1655` (Note cell, no 6th column); `no $` asserted at test line 184

- AC4: Reorder suggestion for a below-par row computed using `actualRemaining` as on-hand basis, with live usage-forecast and live next-delivery (mixing historical on-hand with live timing) → PASS — `report_reorder_for_counted_onhand.test.sql::(2a-2d)` exercises the p_on_hand→par_replacement→suggested_qty→suggested_cases path with explicit numeric assertions; `InventoryCountSection.tsx:398-409` uses `buildCountedOnHandMap` to feed only below-par entries to the RPC

- AC5 (ARCHITECT-OWNED OQ-2): Architecture chose path (b) — new focused RPC `report_reorder_for_counted_onhand` (not parameterized engine, not client-side replication); implementation matches the design doc (security invoker, auth_can_see_store gate, flat item-keyed output, two documented deltas) → PASS — `supabase/migrations/20260702000000_report_reorder_for_counted_onhand.sql` implements exactly path (b); pgTAP suite `report_reorder_for_counted_onhand.test.sql` pins the two deltas

- AC6: No par set (`parLevel <= 0`) or item not resolvable: no indicator, no crash, no error toast, no reorder call → PASS — `InventoryCountSection.parStatus.test.tsx::parStateFor::no par set → "none"` + `unresolvable item is modeled by passing par 0 → "none"`; `buildCountedOnHandMap` excludes both cases; `InventoryCountSection.tsx:1588-1589` renders an empty `<View style={{ width: 12 }}/>` (no marker)

- AC7: Par comparison uses CURRENT `parLevel`, joined client-side from Zustand `inventory` array by `entry.itemId`. No new fetch and no migration introduced for the par join → PASS — `InventoryCountSection.tsx:369-375` builds `inventoryById` via `React.useMemo` from the Zustand `inventory` slice; no new fetch or migration for the join (verified: 0 new table columns, additive-only migration is for the RPC, not par storage)

- AC8: Indicator + suggestion are read-only display; no button, no write, no mutation; RPC is read-only → PASS — `fetchReorderForCountedOnHand` is a `{ kind: 'read' }` tracked call (`db.ts:3279`); no mutation path in `DetailFrame`; `InventoryCountSection.tsx:386-427` is inside a read-only `useEffect`

- AC9: `actualRemaining == null` on an entry: no indicator, no reorder call → PASS — `InventoryCountSection.parStatus.test.tsx::parStateFor::null/undefined total → "none"`; `buildCountedOnHandMap` excludes null-total rows (parStateFor returns 'none' → not included); `InventoryCountSection.tsx:1550` passes `e.actualRemaining` which may be null and parStateFor handles it

- AC10: Header caption states (a) par comparison is against current par AND (b) reorder suggestion mixes counted on-hand with live forecast+timing → PASS — `InventoryCountSection.tsx:1447-1463`: caption text "✓ / ● checked vs current par · reorder suggestion mixes this count's on-hand with live forecast + delivery timing" satisfies both bases. No jest test pins the exact caption string (see Notes).

- AC11: Indicator colors come from Cmd palette tokens via `useCmdColors()`: green from `ok` token, red from `danger` token. No hard-coded hex → PASS — `InventoryCountSection.tsx:1577` uses `C.ok`; lines 1584 and 1648 use `C.danger`; `grep -n '#[0-9a-fA-F]{3,6}'` finds zero occurrences in the par-indicator region

- AC12: Existing 5-column layout (ITEM | CASES | LOOSE UNITS | TOTAL | NOTE) unchanged; no 6th column added; indicator is inline on the item cell; suggestion inline in NOTE area → PASS — `InventoryCountSection.tsx:1490-1543` shows exactly 5 column headers; indicator is inside the existing `flex:1` item cell (`1573-1597`); suggestion is inside the existing `flex:1.2` note cell (`1634-1656`)

- AC13: Jest covers three par states + unresolvable-item + null-total edge cases; reorder-suggestion path exercised with a mocked RPC response; if OQ-2 lands as RPC, tested with mocked RPC → PASS — `InventoryCountSection.parStatus.test.tsx` 15 tests: `parStateFor` covers 3 states + 2 edge cases; `buildCountedOnHandMap` covers inclusion/exclusion logic; `formatCountedReorderSuggestion` covers case/non-case/timing; companion-fetch suite covers mocked-RPC flow, requested-but-absent collapse, failure degradation, and empty-map short-circuit

- AC14: OQ-2 resolved to a new RPC (option b), so pgTAP DB test covers: (1) counted-on-hand parameter path with expected `suggested_cases`/forecast shape, (2) `auth_can_see_store()` RLS gate → PASS — `report_reorder_for_counted_onhand.test.sql` 9 assertions: (2a-2d) pin par_replacement/suggested_qty/suggested_cases/suggested_units numerically; (5) asserts 42501 from a non-member caller; (6) empty fast-path; (3) multi-vendor min(days_until) collapse; (4) at/above-par item absent from items[]

### Test run

**pgTAP (scripts/test-db.sh):**
```
== supabase/tests/report_reorder_for_counted_onhand.test.sql ==
  PASS supabase/tests/report_reorder_for_counted_onhand.test.sql (9 assertion(s) passed)
...
✓ 59/59 DB test file(s) passed
```
59/59 PASS — 9 assertions in the spec 105 suite; all 7 sibling reorder suites also pass (no regression).

**Jest (npx jest):**
```
PASS component src/screens/cmd/sections/__tests__/InventoryCountSection.parStatus.test.tsx
  InventoryCountSection — spec 105 par status (module loads)
    ✓ is a real React component that imports + composes countHistoryPar
  parStateFor — the three states + null-total + unresolvable (OQ-1/OQ-4)
    ✓ at/above par (actualRemaining >= parLevel, par > 0) → "above" (green ✓)
    ✓ below par (actualRemaining < parLevel, par > 0) → "below" (red + suggestion)
    ✓ no par set (parLevel <= 0) → "none" (NO marker)
    ✓ null / undefined total → "none" (nothing to compare, no RPC)
    ✓ unresolvable item is modeled by passing par 0 (no inventory row) → "none"
  buildCountedOnHandMap — only below-par, resolvable, non-null rows
    ✓ includes ONLY below-par resolvable non-null entries (...)
    ✓ empty when nothing is below par → the section skips the RPC entirely
  formatCountedReorderSuggestion — quantity + timing, NO cost (OQ-5)
    ✓ case item → "order N cases · M unit · forecast … · deliver <date> (in N days)"
    ✓ non-case item → base-unit qty, singular "case" respected, no forecast line when 0
    ✓ singular "1 case" and unknown schedule (no date) fall back to the bare days label
    ✓ daysUntilLabel: today / tomorrow / in N days
  companion reorder fetch — map → mocked RPC → per-row suggestion
    ✓ sends only the below-par map and renders a suggestion for the returned item; ...
    ✓ degrades on RPC failure: par states still resolve, byItem is empty → ...
    ✓ empty below-par map short-circuits (the section never calls the RPC)

Test Suites: 75 passed, 75 total
Tests:       798 passed, 798 total
```
75/75 suites, 798/798 tests PASS. The lone `act(...)` warning is pre-existing noise from an unrelated staff `EODCount.tsx` focus effect (named in the frontend dev's verification notes) — not introduced by spec 105.

**TypeScript:** `npx tsc --noEmit` exits clean (no output).

### Notes

**Browser verification blocked (no inventory_count seed records).** `public.inventory_counts` has 0 rows in the prod-pulled seed. The history-detail `DetailFrame` is unreachable via the browser UI (empty list → no row to open). The frontend dev validated the live RPC math directly against the local DB (`below-par → suggested_qty 2 / suggested_cases 1 / suggested_units 450 / days_until 7 / next_delivery_date 2026-07-08, no cost fields; empty map → items:[]; non-member → 42501`). This gap is an acceptable tradeoff for v1 given: (a) all three states and both edge cases are covered by jest at the pure-function layer, (b) the pgTAP suite validates the RPC math against the real DB with numeric assertions, and (c) browser verification is structurally blocked (not a test quality issue). The gap is documented and accepted; no seed fixture is strictly required for SHIP_READY unless the release-coordinator requires UI smoke coverage.

**AC10 header caption: no jest pin on exact string.** The caption text at `InventoryCountSection.tsx:1462` satisfies both required bases (current par + live forecast/timing), but no jest test asserts its exact content. A full-render test driving `DetailFrame` with a mock detail object would require an `inventory_counts` fixture and a `@testing-library/react-native` render — additional setup not present. This is a minor gap; the caption's correctness is verified by code-review inspection rather than automated assertion. Not a BLOCK — the criterion is behavioral ("MUST state both") and the code satisfies it; an exact-string test would be regression coverage, not behavioral.

**`reports_anon_revoke` suite does not yet include `report_reorder_for_counted_onhand`.** The new function's `revoke execute ... from public, anon` is verified ad-hoc (`has_function_privilege('anon', ..., 'EXECUTE')` returns `f` against the local DB), and the pgTAP suite's 42501 RLS gate covers unauthorized callers. But the `reports_anon_revoke.test.sql` suite (which formally catalogues every report function's anon revocation) was not updated to include this function's signature. This is a minor coverage gap — not a BLOCK for ship-readiness, but should be noted for the next maintenance pass on that suite.

**Prod-apply pending (db-migrations-applied gate will be RED).** The migration `20260702000000_report_reorder_for_counted_onhand.sql` is applied to the local stack only. Until it is applied via MCP + the version row is inserted into `supabase_migrations.schema_migrations` on prod (`ebwnovzzkwhsdxkpyjka`), the `db-migrations-applied` CI gate will sit RED. This is a user-gated step per the prod-migration-via-MCP memory; it is not a test failure.

**pgTAP math coverage depth.** `usage_per_portion=0` in the test fixtures forces `usage_forecasted=0`, so `suggested_qty = par_replacement = 140`. The usage-forecast formula (`usage_per_portion * qty_per_day * days_until - on_hand`) is exercised only through the "no POS data" path. The engine suites in `report_reorder_list_cases.test.sql` carry broader usage-forecast coverage on the same CTE chain — those pass without regression, which is the shared-ground-truth mitigation the spec named. Adding a POS-driven usage forecast assertion to the spec 105 suite would strengthen it but is not required by the AC text.
