# Spec 088 — Backend-architect drift review (post-implementation)

Mode: post-implementation review (read-only). Reviewing the UNSTAGED implementation
(`git diff HEAD` + untracked) against the `## Backend design (architect)` section of
`specs/088/spec.md` — Decision B (server rounds the whole-case cost, FE formats the
`N cases · M units` display only).

Verdict up front: **MATCHES DESIGN.** Every contract point in the design landed verbatim.
No Critical, no Should-fix. Two Minor observations, both pre-existing / non-actionable for
this spec. Files reviewed:

- `supabase/migrations/20260602000000_reorder_suggested_cases.sql` (new)
- `supabase/migrations/20260514130000_report_reorder_list.sql` (baseline, for byte diff)
- `supabase/tests/report_reorder_list_cases.test.sql` (new)
- `src/types/index.ts` (`ReorderItem`)
- `src/lib/db.ts` (`mapReorderVendor` / `fetchReorderSuggestions`)
- `src/screens/cmd/sections/ReorderSection.tsx`
- `src/utils/reorderDayFilter.ts` (confirmed prod code UNMODIFIED)
- `src/utils/reorderDayFilter.test.ts` (fixture type-completeness fix only)
- `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx` (new)

---

## Critical

None.

## Should-fix

None.

## Minor

### M1 — `suggested_units` is recomputed inline in the JSON object rather than carried as a `per_item_filtered` column (cosmetic; behavior identical)
The design (§1 hunk 3) specified `suggested_units` as a derived key
`case when pif.suggested_cases is not null then pif.suggested_cases * pif.case_qty else pif.suggested_qty end`.
The implementation places exactly that expression inline in the `jsonb_build_object`
(migration lines 496-498) instead of materializing it as a named column in
`per_item_filtered` alongside `suggested_cases`/`estimated_cost`. The computed value is
byte-identical and there is only ONE call site, so this is purely stylistic — the design's
stated intent ("one server-authoritative M so the FE never re-derives cases × qty") is fully
satisfied because the FE reads `suggested_units` from the JSON, not a re-derivation. Not worth
changing. Flagging only because the design described it as a column; an equivalent inline
expression is an acceptable, even leaner, realization. No drift in observable output (pgTAP
assertions 2 and 6 pin `suggested_units = 72` and `48`, migration test lines 200-205 / 228-233).

### M2 — per-vendor `total qty` rollup left in base units (as the design's flagged open question prescribed; restating so the release-coordinator records the deliberate non-change)
`VendorCard`'s `itemTotal` still sums raw `i.suggestedQty` (ReorderSection.tsx line 245,
displayed line 297). This is the exact "non-blocking open question" the design surfaced
(spec.md "Open question surfaced (non-blocking)"): the ACs scope cases to the SUGGESTED figure
+ Est $ only, so the rollup was intentionally NOT switched to `suggestedUnits`. The
implementation correctly did NOT silently change it. This is a MATCH, recorded here as a Minor
purely so it is not mistaken for an omission downstream. If product later wants the rollup in
ordered-units, switch the reduce to `i.suggestedUnits` — a one-line follow-up, not a defect.

---

## Point-by-point confirmation against the design contract

**Migration — additive `create or replace`, three hunks, signature byte-identical.** CONFIRMED.
- Hunk (1): `coalesce(ci.case_qty, 1)::numeric as case_qty` added to `per_item`'s select list
  from the EXISTING `ci` join (`join public.catalog_ingredients ci on ci.id = ioh.catalog_id`,
  unchanged at line 412). No new join, no new scan. (migration line 389)
- Hunk (2): in `per_item_filtered`, `suggested_cases = case when pis.case_qty > 1 then
  ceil(pis.suggested_qty / pis.case_qty) else null end` (lines 435-437) and the case-rounded
  `estimated_cost = case when pis.case_qty > 1 then (ceil(...) * pis.case_qty * pis.cost_per_unit)
  else (pis.suggested_qty * pis.cost_per_unit) end` (lines 438-440). Exactly the specified
  expressions. The null/≤1 branch is the original `suggested_qty * cost_per_unit` verbatim.
- Hunk (3): three additive JSON keys `case_qty` / `suggested_cases` / `suggested_units`
  (lines 494-498), inserted between `suggested_qty` and `cost_per_unit`. `suggested_qty` key
  retained unchanged for back-compat.
- Signature `report_reorder_list(p_store_id uuid, p_params jsonb default '{}'::jsonb) returns
  jsonb language plpgsql security invoker set search_path = public` is byte-for-byte identical
  to the baseline (compared lines 63-70 of the new migration against 101-108 of the baseline).
- NO grant/revoke statements in the new migration (explicit comment lines 597-600). `create or
  replace` preserves the baseline's `revoke … from public, anon` + `grant … to authenticated`
  ACL. No anon-lockdown churn. CONFIRMED.
- I diffed the rest of the body (depth-cap walk, the par/forecast hybrid math,
  `suggested_qty = greatest(par_replacement, usage_forecasted)`, the next-delivery DOW math,
  the vendor filter, the warnings block, the final envelope) against the baseline: identical
  apart from the three hunks. No collateral change to the math. CONFIRMED scope-clean.

**Cost-integrity chain (the crux of Decision B).** CONFIRMED — holds by construction.
- `vendor_total_cost = sum(pif.estimated_cost)` (migration line 476) — inherits the per-item
  rounding; no separate unrounded path exists.
- `kpis.total_estimated_cost = sum(vwi.vendor_total_cost)` (line 536) — inherits transitively.
- FE does NOT recompute cost: per-row Est $ reads `item.estimatedCost` (ReorderSection.tsx
  line 363); per-vendor `est cost` reads `vendor.vendorTotalCost` (line 302); the KPI card
  reads `kpis.totalEstimatedCost` (line 820) where `kpis = computeReorderKpis(primary)`
  (line 673) and `computeReorderKpis` sums `v.vendorTotalCost` (reorderDayFilter.ts line 182).
  No `Math.ceil`/cost arithmetic anywhere in the FE render path.
- `src/utils/reorderDayFilter.ts` production code is UNMODIFIED — `computeReorderKpis` still
  sums `vendorTotalCost` unchanged. CONFIRMED (the only diff in that file's neighborhood is the
  `.test.ts` fixture, M-note below). The "EST. TOTAL == sum of visible per-row Est $" invariant
  therefore holds across spec 087's day filter (the filter only selects WHICH `vendorTotalCost`
  values get summed; it never recomputes them). Pinned by jest
  `ReorderSectionCases.test.tsx` lines 327-365 (mixed case+non-case, and after a vendor drop).
- `exportPayload` (ReorderSection.tsx line 684) spreads `reorderPayload`, swaps in `primary`
  (server-rounded `vendorTotalCost`/`estimatedCost` ride along) + the recomputed `kpis`, so
  CSV rows, PDF tables, and the PDF footer all read the same server-rounded numbers. CONFIRMED.

**Field-name contract agreement.** CONFIRMED. Report exposes `case_qty` / `suggested_cases` /
`suggested_units` (migration lines 494-498); FE `mapReorderVendor` maps them to `caseQty` /
`suggestedCases` / `suggestedUnits` (db.ts lines 768-770); `ReorderItem` declares
`caseQty: number` / `suggestedCases: number | null` / `suggestedUnits: number` (types/index.ts
lines 721-723). Null-handling matches the design: `suggestedCases: it?.suggested_cases == null
? null : Number(...)` and `suggestedUnits: Number(it?.suggested_units ?? it?.suggested_qty ?? 0)`.

**Predicate `case_qty > 1`.** CONFIRMED on both sides. SQL normalizes null→1 via `coalesce`
then tests strict `> 1` (migration lines 389/435/438), so null/0/1 all fall through to
base-unit-unchanged. FE mirrors via the server's `suggestedCases != null` gate (the server only
sets it non-null when `case_qty > 1`), so `formatSuggested` (ReorderSection.tsx lines 62-69)
and the CSV `isCase` branch (line 454) never render the degenerate `1 case · 1`. pgTAP
assertion 8 pins `case_qty=1 → suggested_cases` JSON `null` (test lines 242-246); jest pins
`caseQty` 1/0/null → plain render (test lines 214-225).

**No scope creep.** CONFIRMED.
- ON HAND / INBOUND / PAR stay base unit for all items: `BreakdownLine` segments
  (ReorderSection.tsx lines 92/94/96) and the column cells (lines 351/354/357) use
  `formatQty(item.onHand|pendingPoQty|parLevel)` with no case treatment.
- par/forecast math untouched (verified in the body diff above).
- spec-087 calendar/filter untouched (`reorderDayFilter.ts` unmodified; the section's
  selected-date / partition / `computeReorderKpis` wiring at lines 627/666-673 is unchanged
  from spec 087).
- per-vendor `total qty` rollup stays base-unit, NOT silently changed (M2 above).

**Out-of-design-scope surfaces correctly handled.**
- CSV: `Cases` + `Units Per Case` columns added right after `Suggested Qty`
  (ReorderSection.tsx lines 444-445); `Suggested Qty` carries `suggestedUnits` for case rows /
  raw `suggestedQty` for non-case (line 463); `Est. Cost` = `item.estimatedCost.toFixed(2)`
  (server-rounded, line 469); non-case rows have empty `Cases`/`Units Per Case` (lines 464-465).
  Matches design §(C). Jest pins the cell indices (test lines 275-294).
- PDF: 7-column head preserved (line 546); `Suggested` cell = `formatSuggestedPdf(item)`
  (`N cs · M unit`, line 554); `Est. Cost` and footer `Est. total`
  (`payload.kpis.totalEstimatedCost`, lines 556/580) read server-rounded values. Matches §(C).

**pgTAP.** CONFIRMED. `report_reorder_list_cases.test.sql` runs `plan(12)`: 1 fixture-resolve
+ 11 content assertions covering case item 49/24 → cases=3 / units=72 / case_qty=24 / cost=72
(whole-case, not 49), exact-multiple 48/24 → 2/48/48, plain case_qty=1 → `suggested_cases` JSON
null / case_qty=1 / cost=10 (base-unit unchanged), and the rollup
(`vendor_total_cost == sum(per-item estimated_cost)`). No `set role anon`; no
`has_function_privilege` arm (grant untouched). Master-JWT pattern mirrors the hybrid-formula
reference test. Matches design §9.

**RLS / realtime / edge / store-slice.** CONFIRMED none. No new tables; `security invoker`
behind the unchanged `auth_can_see_store(p_store_id)` first-statement gate; `case_qty` reads
the same `catalog_ingredients` row already SELECTed via `ci`. No `supabase_realtime`
publication change → the `docker restart supabase_realtime_imr-inventory` gotcha does NOT
apply. No edge function touched. No `useStore.ts` slice change; optimistic-then-revert /
`notifyBackendError` correctly NOT applicable (read-only RPC; errors route to the in-section
`reorderError` pane, unchanged).

**No direct-Supabase bypass.** CONFIRMED. All reorder DB access still flows through
`fetchReorderSuggestions` → `report_reorder_list` RPC in `src/lib/db.ts` (lines 2706-2748);
nothing in `ReorderSection.tsx` calls `supabase.from`/`supabase.rpc` directly.

---

## Verdict

The implementation is a faithful, scope-clean realization of the Decision B design. The
migration is an additive `create or replace` with a byte-identical signature, no grant churn,
and exactly the three specified hunks over an otherwise-verbatim body; the whole-case cost is
rounded at the single per-item `estimated_cost` source and inherited by `vendor_total_cost`
and `kpis.total_estimated_cost`, so the "EST. TOTAL == sum of visible per-row Est $" invariant
holds by construction — including through spec 087's untouched `computeReorderKpis` day filter,
which is exactly why Option B was chosen. The field-name contract (`case_qty`/`suggested_cases`/
`suggested_units` → `caseQty`/`suggestedCases`/`suggestedUnits`), the strict `case_qty > 1`
predicate, the base-unit-only ON HAND/INBOUND/PAR scope, and the CSV/PDF column shape all match
the design. The FE does zero cost math (reads server-authoritative `estimatedCost`/
`vendorTotalCost`/`totalEstimatedCost`). pgTAP and jest pin the rounding, the exact-multiple
no-spurious-case edge, singular/plural copy, no-case-size regression, and the KPI invariant. The
two Minor notes are a cosmetic inline-vs-column realization of `suggested_units` (behavior
identical) and the deliberately-unchanged base-unit `total qty` rollup that the design itself
flagged as a non-blocking open question. No Critical, no Should-fix — clean from an architectural-
drift standpoint.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Minor (both
  non-actionable: a cosmetic inline-vs-column realization of `suggested_units`, and the
  deliberately-unchanged base-unit per-vendor `total qty` rollup that the design flagged as a
  non-blocking open question). Implementation MATCHES the Decision B design — additive
  byte-identical-signature migration with the three specified hunks, server-rounded cost
  inherited by vendor_total_cost + kpis.total_estimated_cost, FE does no cost math,
  reorderDayFilter.ts unmodified, field-name contract and predicate honored, pgTAP + jest pin
  the invariants.
payload_paths:
  - specs/088/reviews/backend-architect.md
