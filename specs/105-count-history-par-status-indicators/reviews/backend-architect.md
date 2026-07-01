# Spec 105 — Backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Spec: `specs/105-count-history-par-status-indicators.md`
Design authored by: backend-architect (option **b** — new isolated RPC)
Verdict: **Implementation matches the design. No Critical findings. 1 Should-fix, 4 Minor.**

The load-bearing requirement — the new RPC copies `report_reorder_list`'s
forecast/case/next-delivery CTE chain VERBATIM with EXACTLY the two named
deltas — **holds**. Every math CTE is byte-identical; the two deltas
(on-hand source, flat item-keyed output) are isolated exactly where the
design placed them. The FE consumes the contract as designed (client-side
current-par join, read-only companion fetch, inline suggestion, no 6th
column, dual-basis caption). Details below.

---

## Files reviewed

- `supabase/migrations/20260702000000_report_reorder_for_counted_onhand.sql` (new RPC)
- `supabase/migrations/20260630000100_report_reorder_list_multi_vendor.sql` (the copy source / engine)
- `supabase/tests/report_reorder_for_counted_onhand.test.sql` (pgTAP, 9 assertions)
- `src/lib/db.ts` (fetcher `fetchReorderForCountedOnHand` + `mapCountedReorderItem`, lines 3241-3323)
- `src/types/index.ts` (`CountedReorderItem`, lines 892-906)
- `src/screens/cmd/sections/countHistoryPar.ts` (pure helper module)
- `src/screens/cmd/sections/InventoryCountSection.tsx` (companion fetch + DetailFrame render + caption)
- `src/screens/cmd/sections/__tests__/InventoryCountSection.parStatus.test.tsx` (jest, 15 tests)

---

## Verbatim-copy verification (the primary check)

Diffed the new RPC's CTEs against the current `report_reorder_list` body
line-by-line. **Byte-identical** across every math/forecast/timing CTE:

| CTE | engine (…_multi_vendor.sql) | new RPC | verdict |
|-----|------|------|---------|
| depth-cap pre-walk `_walk` | 104-130 | 123-149 | identical (only the `raise notice` label text differs — cosmetic, "Reorder report" → "Counted-reorder report") |
| `direct_ri` | 137-141 | 155-159 | identical |
| `recursive_prep` | 143-162 | 161-180 | identical |
| `truncated_recipes` | 163-169 | 181-187 | identical |
| `prep_leaves` | 170-174 | 188-192 | identical |
| `all_ri` | 177-185 | 194-202 | identical |
| `recipe_meta` | 187-193 | 204-210 | identical |
| `pos_daily_per_item` (usage) | 309-326 | 248-265 | identical |
| `vendor_delivery_offsets` (next-delivery) | 349-403 | 269-319 | identical |
| `vendor_delivery` (A5 fallback) | 407-415 | 321-329 | identical |
| `par_replacement` | 452-454 | 352-354 | **identical** |
| `usage_forecasted` | 455-461 | 355-361 | **identical** |
| `suggested_qty` | 468-473 (per_item_suggested) | 368-373 | **identical** |
| `suggested_cases` (spec 088 ceil) | 486-488 | 383-385 | **identical** |
| `suggested_units` | 553-555 | 418-420 | **identical** |
| `flags` vocabulary | 493-506 | 386-396 | **identical minus `eod_missing_for_item`** (correctly dropped — Delta 1, no EOD path) |

**The `par_replacement` / `usage_forecasted` / `suggested_qty` /
`suggested_cases` / `suggested_units` math is byte-identical.** A history
suggestion will NOT diverge from what the real Reorder screen computes for
the same on-hand (subject to the multi-vendor collapse nuance in Should-fix
S1 below, which is a deliberate design choice, not accidental drift).

### The two deltas — both correct and isolated

**Delta 1 — on-hand source (`item_on_hand`, lines 221-235).** The engine's
three-branch EOD/stock `CASE` (…_multi_vendor.sql:231-269, reading
`latest_eod_per_vendor` + `eod_entries` + `current_stock`) is fully replaced
by `(p_on_hand ->> ii.id::text)::numeric`, with `where … and p_on_hand ?
ii.id::text` so items absent from the map produce no row. `latest_eod_per_vendor`
is dropped entirely (no orphan CTE). The `item_vendors` explosion is
preserved (`join public.item_vendors iv on iv.item_id = ii.id`), so delivery
timing still considers every vendor. `item_on_hand_source` and
`eod_missing_for_item` columns are correctly dropped. **Matches the design
verbatim.**

**Delta 2 — flat item-keyed output (`per_item_collapsed` +`item_rows`, lines
408-456).** The vendor-grouped envelope (`vendors_with_items` / `vendor_rows`
/ `kpi_calc`) is replaced by `distinct on (pif.item_id) … order by
pif.item_id, pif.days_until asc` — the soonest-truck collapse. `schedule_known`
is correctly lifted to item-grain via `bool_or(...) over (partition by
item_id)`. Cost fields (`cost_per_unit`, `estimated_cost`, `vendor_total_cost`,
`total_estimated_cost`), `item_name`, `i18n_names`, and `unit` are all
dropped from the payload. **Matches the design verbatim** — no `$` leaks.

### Engine parity of the boilerplate

- `security invoker` + `set search_path = public` (lines 78-79) — identical to engine (72-73). ✓
- Auth gate is the FIRST statement (lines 91-94), `auth_can_see_store(p_store_id)` raising `42501` — byte-identical to engine (85-88). ✓ Correctly `auth_can_see_store`, NOT `auth_is_admin()` — matches the per-store read semantic.
- Grants (lines 478-481): `revoke execute … from public, anon; grant execute … to authenticated;` — mirrors the engine's ACL. Correctly stated EXPLICITLY because this is a new signature (the engine relies on `create or replace` preserving its ACL). ✓
- Empty-map fast path (lines 100-106) returns `items: []` without scanning the recipe graph — matches design §"Request shape". ✓
- `as_of_date` resolution (lines 114-117) identical to engine (94-97) — live forecast/timing honored. ✓

**Historical-on-hand + live-forecast/timing semantic is honored:** on-hand
comes from `p_on_hand` (the count), while `pos_daily_per_item` uses the
trailing-7-day window as of `v_as_of_date` and `vendor_delivery` computes
offsets from `v_as_of_date` — both live. Confirmed.

---

## Frontend contract consumption

- **`db.ts` fetcher** (`fetchReorderForCountedOnHand`, 3271-3302): tracked read
  (`useInflight.getState().track`, `kind: 'read'`), calls
  `report_reorder_for_counted_onhand` with `{ p_store_id, p_on_hand, p_params }`,
  returns `Record<itemId, CountedReorderItem>`. Errors bubble (not swallowed)
  for the caller's `.catch`. **Matches design §"src/lib/db.ts surface" exactly.**
- **`mapCountedReorderItem`** (3304-3323): snake→camel, mirrors
  `mapReorderVendor`'s per-item block MINUS cost/vendor keys. `suggestedCases`
  null-preserving, `suggestedUnits` falls back to `suggested_qty`. ✓
- **`CountedReorderItem`** type (types/index.ts:892-906) is the cost-free
  subset the design specified — no `costPerUnit`/`estimatedCost`. ✓ Correctly
  a distinct type, not a reused `ReorderItem` (which would carry misleading `0`
  cost fields).
- **Client-side current-par join** (InventoryCountSection.tsx:369-376):
  `inventoryById` built from the Zustand `inventory` array filtered to
  `storeId` — no fetch for par (OQ-1). `parStateFor` (countHistoryPar.ts:53-60)
  implements the three states correctly incl. null-total and unresolvable →
  `none`. ✓
- **Read-only companion fetch** (379-427): fires inside the EXISTING
  lazy-detail effect after `detail` resolves; builds the below-par map via
  `buildCountedOnHandMap`, short-circuits on empty map (no RPC), `.catch` →
  `console.warn` + `reorderByItem = {}` (NO `notifyBackendError`, NO toast —
  read-only degradation). **Matches design §"Frontend store impact".** ✓
- **Inline, no 6th column** (1545-1656): ✓ (`C.ok`) / ● (`C.danger`) inline on
  the item cell; suggestion rendered in the existing NOTE cell below the note
  text. 5-column layout (ITEM | CASES | LOOSE UNITS | TOTAL | NOTE) preserved.
  Colors from `useCmdColors()` tokens — no hard-coded hex. ✓
- **Requested-but-absent → bare red dot** (1553): `suggestion = parState ===
  'below' ? reorderByItem[e.itemId] : undefined` — an item in the request but
  absent from the response renders the red ● with no text. Matches design
  §"items[] may be shorter than the request". ✓
- **Dual-basis caption** (1447-1463): "✓ / ● checked vs current par · reorder
  suggestion mixes this count's on-hand with live forecast + delivery timing"
  — states BOTH bases (current-par AND live-forecast/timing) as AC line 93
  requires. ✓
- **No cost in the suggestion string** (`formatCountedReorderSuggestion`,
  countHistoryPar.ts:119-147): quantity + timing only; jest asserts
  `not.toMatch(/\$/)`. ✓
- **db.ts carve-out honored:** the section reaches Supabase only via
  `fetchReorderForCountedOnHand` in `db.ts`. No direct `supabase.rpc` for this
  feature. ✓

---

## Findings

### Should-fix

**S1 — The multi-vendor collapse can surface a suggestion that differs from
what the manager would see on the real Reorder screen for the same vendor,
and the pgTAP suite does not cover it.**
`supabase/migrations/20260702000000_report_reorder_for_counted_onhand.sql:355-361, 408-431`

`usage_forecasted` multiplies by `vd.days_until` **per vendor** (line 358),
so for a multi-vendor item each vendor row computes a DIFFERENT
`usage_forecasted` (and therefore a different `suggested_qty`) proportional to
that vendor's delivery horizon. `per_item_collapsed` then picks the
**soonest-truck** row via `distinct on (item_id) order by item_id, days_until
asc` (lines 409-430) — which is the row with the SMALLEST `days_until` and
hence, when the forecast dominates the par gap, the SMALLEST `suggested_qty`.
Two consequences:

1. This is a genuine, defensible product decision (the design's §"De-explosion
   correctness" risk explicitly owns it: "soonest truck" = "when could I have
   this back at par"). But the surfaced `suggested_qty`/`suggested_cases` for a
   forecast-dominated multi-vendor item is then the *soonest vendor's* smaller
   number, whereas the real Reorder screen shows a separate card per vendor
   with each vendor's own (larger, for the later truck) number. The history
   badge and the Reorder screen will legitimately differ for such an item. The
   dual-basis caption covers the on-hand/timing basis but does not explain the
   "soonest vendor's quantity" collapse. Consider a one-clause caption addition
   or an accepted-caveat note — non-blocking, but worth a conscious call.

2. **Coverage gap:** pgTAP assertion (3) exercises the `min(days_until)`
   collapse, but the fixture sets `usage_per_portion = 0` for BOTH items
   (test.sql:142,146), so `usage_forecasted = 0` on every vendor row and
   `suggested_qty = par_replacement` (identical across vendors). The test
   therefore never exercises the case where per-vendor `days_until` makes
   `suggested_qty` differ across an item's vendors — i.e. the one case where
   "which row does the collapse pick?" actually changes the surfaced quantity.
   Recommend one added assertion: a multi-vendor item with `usage_per_portion >
   0` and a non-zero POS rate, asserting the collapsed `suggested_qty` equals
   the SOONEST vendor's forecast (not the max across vendors). This pins the
   collapse semantic against a future refactor that might otherwise silently
   switch to `max`/`order by days_until desc`.

This is the only finding with material behavioral weight. It is a
Should-fix (not Critical) because the collapse is a deliberate, documented
design decision and the `days_until` value itself is correctly tested.

### Minor

**M1 — Stale pgTAP header comment: `case_qty=40` vs the actual fixture's `24`.**
`supabase/tests/report_reorder_for_counted_onhand.test.sql:14-16`

The summary comment says "par=200, case_qty=40, on_hand=60 …
suggested_cases=ceil(140/40)=4, suggested_units=160." The actual fixture
(line 124) creates the CASE catalog with `case_qty 24`, and the executable
assertions (198-209) correctly test `ceil(140/24)=6` and `suggested_units=144`.
The assertions are internally consistent and correct; only the top-of-file
prose is stale. Fix the comment to `case_qty=24 → ceil(140/24)=6 →
suggested_units=144` so a future reader is not misled. No test-correctness
impact.

**M2 — Migration filename timestamp diverges from the design (already
disclosed).** Design §"Data model changes" named
`20260701000000_report_reorder_for_counted_onhand.sql`; the implementation
used `20260702000000_…` because `20260701000000` was already taken by spec
104. This is correctly disclosed in the spec's §"Files changed" filename-
correction note and is the right call (still dated after the latest on-disk
migration; no ordering hazard). Noted only for completeness — no action.

**M3 — Prod-apply pending (drift gate will sit RED until MCP-applied).** The
migration is applied to LOCAL only; it has NOT been pushed to prod
(`ebwnovzzkwhsdxkpyjka`). Per the project's `db-migrations-applied` gate and
the prod-migration-via-MCP memory, the gate will hard-fail RED for this
migration until it is applied via MCP + its version row is inserted into
`supabase_migrations.schema_migrations`. This is expected and user-gated per
the spec's §"Files changed" note; flagging it here so `release-coordinator`
does not read the red gate as a code defect. Deploy step, not a code finding.

**M4 — `todayIso()` is device-local, not store-local.** The companion fetch
passes `todayIso()` (InventoryCountSection.tsx:81-84, 400), which reads the
BROWSER/device date, not the store's timezone. The design §"src/lib/db.ts
surface" says "the FE passes the store-local today." This is the identical
approximation the existing `report_reorder_list` caller path already uses
(`fetchReorderSuggestions` is likewise handed a device-local today by its
callers), so it is consistent with the engine's live path and not a
regression — but the device-vs-store-tz caveat carries over. Non-blocking;
matches existing behavior.

---

## Acceptance-criteria trace (design-owned criteria)

- OQ-2 fork resolved to option (b), design pinned the path + shape, implementation matches → **AC line 56-69 satisfied.**
- Counted total as on-hand basis + live forecast/timing → **AC line 49-55 satisfied** (Delta 1 + live `as_of_date`).
- RPC is read-only, `security invoker`, `auth_can_see_store()`-gated → **AC line 84, 114-120 satisfied**; pgTAP assertion (5) covers the `42501` gate.
- No cost/$ field anywhere in payload, mapper, type, or suggestion string → **out-of-scope §"Any $ / cost figure" honored.**
- pgTAP covers counted-on-hand param path + case math + collapse + empty-map + RLS → **AC line 114-120 satisfied** (modulo the S1 forecast-collapse coverage gap).

No acceptance criterion is broken. The single behavioral nuance (S1) is a
documented design decision with a test-coverage gap, not a contract
violation.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix
  (multi-vendor forecast-collapse surfaces the soonest vendor's quantity and
  is not exercised by pgTAP), 4 Minor (stale pgTAP header comment; disclosed
  filename shift; prod-apply/drift-gate pending; device-local todayIso). The
  verbatim-copy-with-two-deltas discipline holds and the FE consumes the
  contract as designed.
payload_paths:
  - specs/105-count-history-par-status-indicators/reviews/backend-architect.md

---

## Resolution (applied by main Claude post-review)

- **M1 (stale pgTAP header `case_qty=40`) — FIXED.** Header prose now reads `case_qty=24 → ceil(140/24)=6 → suggested_units=144`, matching the executable assertions.
- **S1 (multi-vendor forecast-collapse pgTAP coverage gap) — DEFERRED as a follow-up.** The behavior is correct and intentional (the "soonest truck" collapse is a documented design decision, and `days_until` itself IS tested); S1 is a *regression-protection* coverage add (pin that the collapse surfaces the soonest vendor's forecast quantity), needing a POS-fixture + `usage_per_portion > 0` multi-vendor case. Tracked for a follow-up rather than blocking v1. The optional caption-caveat about "soonest vendor's quantity" is also deferred.
- **M2/M3/M4 — no action** (disclosed filename shift; prod-apply pending is user-gated + expected; device-local `todayIso()` matches the existing engine-path behavior).

Post-fix: tsc clean, jest 798/798, pgTAP 59/59.
