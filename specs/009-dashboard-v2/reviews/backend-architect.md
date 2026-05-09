# Backend architect — post-impl drift review (Spec 009)

Reviewer: backend-architect (post-impl mode)
Date: 2026-05-06
Mode: drift review against §0–§11 + Decisions D1–D6

Overall: implementation matches the design contract well. The selectors
landed where I asked them to, with the field shapes I specified; D2 took
the conservative-component-local path; the Reconciliation extraction is
clean; the new components reuse existing patterns. R3 parity probe is
present and dev-gated.

Findings below ordered Critical → Should-fix → Nits.

---

## Critical

(none)

No security, contract, AC, or build-breaking drift found. The build
compiles, AC1–A12 are wired, and the §2 contract is honored.

---

## Should-fix

### S1. `useStoreFoodCostHeatmap` hook is shipped dead (and contradicts its own doc)

`src/lib/cmdSelectors.ts:851-874` exports
`useStoreFoodCostHeatmap(days=7)`. Its block comment (lines 833-844)
says callers needing real cross-store EOD/POS must NOT use this hook —
they must call the pure function directly with the §5/D2 helpers.
DashboardSection.tsx:223-238 indeed bypasses the hook and calls
`computeStoreFoodCostVariancePp` per store with `allEod` / `allPos`.

Net effect: this hook ships unused, and its only documented use case
("Dashboard heatmap") is the use case the comment tells you NOT to use
it for. Anyone discovering it via grep will reach for it next time and
hit the same partial-data bug we just designed around.

Recommendation: either delete the hook outright (preferred — the pure
function `computeStoreFoodCostVariancePp` is the public API and the
Dashboard already uses it correctly) OR rewrite the hook to accept the
cross-store EOD/POS arrays as args and let the caller hold them. As
shipped, it's a footgun.

Same shape, lower priority: `useAttentionQueueByStore`
(cmdSelectors.ts:941-959) iterates every store but feeds focal-store-
only `eodSubmissions` / `posImports` into `computeAttentionQueue`. The
food_cost_streak rule will under-fire for non-focal stores under this
hook. The dashboard correctly bypasses it. Same disposition: either
delete or accept-cross-store-args.

### S2. Architect rationale for D2 is stale, but the chosen behavior is right

Heads-up on a moved goalpost — not a code drift, a doc drift. My §0
finding said `__all__` mode flatMaps inventory/wasteLog/auditLog but
not eodSubmissions/posImports, which was the rationale for D2 picking
component-local state over mutating `useStore.loadFromSupabase`.

In reality, `setCurrentStore` at `useStore.ts:248-263` redirects any
`__all__` store id to the first accessible focal store, so `__all__`
mode is **decommissioned** as a switchable mode. `useStore.inventory`
is now per-focal-store, not flatMapped across stores. (The
`loadFromSupabase('__all__')` branch is unreachable from the UI.)

The implication isn't that D2 was wrong — it's that the design's
"don't perturb other Cmd sections in `__all__` mode" risk argument
doesn't apply, because there is no `__all__` mode. D2(b) is still the
right answer for a different reason: `useStore.eodSubmissions` is
**always** single-focal-store now, and the dashboard genuinely needs
cross-store data the store doesn't carry. So the conclusion holds; the
reasoning is what shifted under us between spec lock and impl.

Concrete code consequence: the dashboard's KPI strip uses
`useStore.inventory` (DashboardSection.tsx:91, :155-181) for "TOTAL
INV VALUE" and "STOCK ALERTS" — which means those KPIs are
**focal-store totals**, not all-stores totals, despite the headline
"All stores · day in progress" rendered at line 284. AC1 says "total
inventory value" and AC8 talks about per-store badges, but doesn't
nail down whether the strip is fleet-wide or focal. The handoff
labelled it fleet-wide (header reads "All stores").

Recommendation: either (a) backfill cross-store inventory the same
way EOD/POS were done (add `db.fetchInventoryForStores(storeIds)` and
hold in component state), or (b) update the hero header to honestly
say "Focal store · day in progress" or similar. Not blocking, but
visible to the user.

### S3. CoGS card top-variance list is focal-store-only, header reads cross-store

DashboardSection.tsx:214 — `useTopVarianceItems(7, 5)` — pulls top
variance items for `currentStore.id` only (selector at
cmdSelectors.ts:880-899). The header on the CoGS card and the
"all stores" framing imply this is fleet-wide.

This is consistent with my §2 design ("CoGS card for the current
store") but contradicts the user-facing framing in the rest of the
dashboard. Same disposition as S2 — either fan it out across all
visible stores or label the card "focal store" so an operator
doesn't draw fleet-wide conclusions from a single-store sample.

### S4. `synthSeries` "STOCK ALERTS" delta is hard-coded "+25%" regardless of reality

DashboardSection.tsx:326 — `delta={lowOutAll.length > 0 ? '+25%' : ''}`.
The synth sparkline below it draws a deterministic random walk from
`synthSeries(lowOutAll.length, ...)` but the delta pill on top is a
flat "+25%" string when any alerts exist. Same is true for "+4.2%"
on TOTAL INV VALUE (line 294) and "+8%" on WASTE / WK (line 310).

R1 in the spec covers the sparkline being synthetic (acceptable for
Phase 1). It does NOT cover the delta-pill numbers being hard-coded
fictional percentages — that's a stricter form of "operator sees a
trend that isn't real." A flat number with no delta would be more
honest. Same `SYNTHETIC_KPI_SERIES` rationale should govern; flag
explicitly.

Recommendation: drop hard-coded delta strings on the three synthetic
KPIs (TOTAL INV / WASTE / STOCK ALERTS) — show the headline number
without a trend pill — until real series land. AVG FOOD COST and EOD
SUBMITTED have real signal so their pills are fine. (EOD's
"+${eodSubmittedToday - storeCount}" at line 318 reads as a negative
when not all stores have submitted — that's correct math, just looks
weird as a "delta pill". Acceptable IMO.)

### S5. `__DEV__` parity probe will silently skip when `latest` is undefined

ReconciliationSection.tsx:81-118 — the R3 mitigation. Fine in shape,
but it bails at line 83 if `latest` is undefined (which is a totally
normal "no EOD yet" state on a fresh store). In that case both inline
and selector return `[]`, so technically there's nothing to compare —
but the user's "didn't fire because rows weren't recomputed" comment
in the task brief is a tell that this path may be the dominant one in
the test session. The probe doesn't tell you it skipped vs. found
zero diff.

Recommendation: add a one-liner `console.log('[Spec 009 R3] no
latest EOD — probe skipped')` so a quiet console means "selector
matched", not "selector wasn't tested." Optional, but it would close
the loop on R3 verification.

---

## Nits

### N1. `fetchEodSubmissionsForStores` doesn't backfill `storeName`

db.ts:517 — `storeName: ''` with a comment "backfilled by caller
against useStore.stores if needed". The Dashboard's merge at
DashboardSection.tsx:144-152 doesn't backfill it; downstream selectors
(`computeAttentionQueue`, `computeStoreFoodCostVariancePp`) don't read
`storeName` so it doesn't break anything *today*. But `storeName`
appears in `EODSubmission` shape and other consumers (Reconciliation
in `__all__` mode historically) did read it. Document the contract
gap or do the cheap one-line backfill on read. Cosmetic.

### N2. `computeAttentionQueue.unconfirmed_po` lookback range starts at day 4

cmdSelectors.ts:799 — `for (let lookback = 4; lookback <= 7; lookback++)`.
Spec D6 said "> 3 days old", which I'd read as "starting 4 days back"
— so `lookback = 4` is right. But I'd phrase it as `lookback >= 4`
in the comment for clarity, since "> 3 days old" is ambiguous about
whether day 4 inclusive or exclusive counts. Document the boundary
choice.

Also — for stores with vendors scheduled multiple weekdays, this loop
will fire one alert per missed (vendor, day) pair. Across 4 lookback
days that could be 4+ alerts per vendor for a heavy-schedule store.
The sort + dedupe at line 826 only dedupes by id, and ids include
date so duplicates *won't* dedupe. Possible queue spam — but per the
empty-state observation in the task brief ("Stock alerts at 572"),
the seed data isn't going to test this. Worth a stress test on a real
store with a populated `orderSchedule` before you trust the queue
length count badge in production.

### N3. KPI strip's "EOD SUBMITTED" delta string

DashboardSection.tsx:318 — `delta={eodSubmittedToday === storeCount ? '' : `${eodSubmittedToday - storeCount}`}`.
When 2 of 4 stores submitted, this prints "-2" as the delta. Reads
weird in a delta-pill context (delta pills usually signify
day-over-day change). Cosmetic; consider just suppressing the delta
on EOD or labeling it differently ("2 missing" etc.).

### N4. Heatmap legend doesn't match the actual threshold table

DashboardSection.tsx:629-637 — legend swatches are
`−1 to −0.5 / ±0.5 / +0.5 to 1.5 / +2.5+`. That skips the 1.5–2.5
band entirely (which renders as deep amber per cellPaint). Add a
fourth swatch for 1.5–2.5 or compress the range labels honestly.
Not a math bug, just visual completeness.

### N5. Nit: pure function dependency in `useEffect` dep array

DashboardSection.tsx:140 — `[stores.map((s) => s.id).join(','), currentStore.id]`.
The `stores.map().join()` shape is a known eslint footgun (computed
inline in dep array each render); the `eslint-disable-next-line` is
appropriate. Alternative: precompute `const storeIdsKey = useMemo(()
=> stores.map(...).join(','), [stores])`. Nit only — the existing
inline form works.

### N6. Variance refactor: `pct` rounding rule diverged subtly

ReconciliationSection.tsx:69 — `pct: l.expected > 0 ? Math.round((l.delta / l.expected) * 100) : 0`.
Pre-refactor (per the inline R3 probe at line 91-103, which doesn't
compute `pct` at all and only diff-checks `id` + `dollar`), the
original `pct` derivation isn't captured. As long as the screen's
existing render of `pct` matches the prior visual output, this is
fine — but the R3 probe explicitly doesn't verify `pct`. If a user
notices a "Δ %" column that subtly differs from before the refactor
(e.g. when expected was 0 and the prior code path did something
else), the probe won't catch it. Optional: extend the probe to
diff `pct` too.

---

## Decisions verification

| Decision | Spec lock | Implementation | Match? |
|----------|-----------|----------------|--------|
| D1 (heatmap deep amber) | collapse to C.warn @ 0.85 vs 0.65 | Heatmap.tsx:60-64 | yes |
| D2 (cross-store data) | component-local + db helpers | DashboardSection.tsx:113-152, db.ts:496-585 | yes |
| D3 (target food-cost) | hard-code 30, named constant | cmdSelectors.ts:556 (`TARGET_FOOD_COST_PCT_DEFAULT`) + DashboardSection.tsx:24 | yes (two named constants — one in selector, one in screen — the screen doesn't import the selector const, so changing one doesn't propagate; mild D3 footgun re-emergence — call the screen-side constant out of the selector for single-source) |
| D4 (single overview tab) | overview only, no stubs | DashboardSection.tsx:268 | yes |
| D5 (synthetic sparklines) | 4 of 5, food-cost real, tagged grep | DashboardSection.tsx:33-53 (`SYNTHETIC_KPI_SERIES`) + line 191-208 (real fc) | yes |
| D6 (unconfirmed_po rule) | "scheduled vendor with no matching submission, > 3 days old" | cmdSelectors.ts:792-821 | yes |

D3 sub-finding worth a one-line fix: DashboardSection.tsx:24 redeclares
`TARGET_FOOD_COST_PCT = 30` instead of importing
`TARGET_FOOD_COST_PCT_DEFAULT` from cmdSelectors. Per the build notes
("avoids the architect's hard-code 30 in two places footgun") this was
explicitly avoided in the selector but then re-introduced in the
screen. Trivial fix.

---

## Reconciliation refactor — direct math sanity check

Pre-refactor inline (visible in the R3 probe shape at
ReconciliationSection.tsx:91-102):
```
expected = prevById.get(itemId) ?? actualRemaining
diff     = +(actualRemaining - expected).toFixed(2)
dollar   = +(diff * costPerUnit).toFixed(2)
filter   diff !== 0
sort     |dollar| desc
```

Post-refactor selector (`computeVarianceLines`, mode `priorEod`,
cmdSelectors.ts:330-366):
```
expected = prevById.get(itemId) ?? actualRemaining   // same
delta    = +(counted - expected).toFixed(2)          // same
deltaCost= +(delta * (costPerUnit || 0)).toFixed(2)  // same; || 0 is new but inventory rows have a number always
filter   delta !== 0                                 // same
no internal sort (caller sorts)                      // same outcome — Reconciliation re-sorts at :72
```

Math matches one-for-one. The `(costPerUnit || 0)` defensive coalesce
is new but cosmetic — `InventoryItem.costPerUnit` is typed `number`
and the legacy inline path would have NaN'd if it were ever undefined,
so the new path is strictly safer with no observable behavior delta.

The `previous` lookup definition matches: pre-refactor used
`s.date < latest.date` after sorting by date descending; selector uses
`submissionsForStore.find(s => s.date < latest.date)` after sorting
by date descending. Identical.

R3 mitigation appears sound. Probe should be safe to remove after a
reviewer manually confirms one round of EOD-populated parity (note S5
above re: skip-when-no-latest gap).

---

## Cross-store fetch mount latency

User-facing question from the brief: "what does the user see in the
meantime — empty cells or loading state?"

Looking at DashboardSection.tsx mount flow:

1. Component mounts with `crossStoreEod = []`, `crossStorePos = []`.
2. `allEod` initially equals `eodSubmissions` (focal store only).
3. Heatmap rows render: focal store has real data, other stores'
   `computeStoreFoodCostVariancePp` returns array of zeros (no EOD
   for them in `allEod` yet). Heatmap paints those as neutral cells
   with "+0.0" text — visually they'll all show as the neutral grey
   `±0.5` band.
4. Per-store attention queues: focal store renders real queue, others
   show only the rules that don't depend on EOD/POS (low_out_stock,
   eod_missing for today, unconfirmed_po). Most stores will likely
   show at least one alert, so no "✓ all clear" false-positive flash.
5. ~one network round-trip later (likely <500ms locally), state
   updates, dashboard re-renders with real cross-store data.

Risk: brief flash of "all stores look the same / on target" before
real data lands. No spinner, no skeleton, no "loading" cue. For a
power-user admin dashboard this is probably fine — flash is sub-
second and the per-store cards visually re-paint, so the eye sees
"new data arrived" naturally. Worth flagging as a UX nit but not a
backend concern.

If you want a guard: render an empty state for the heatmap until
`crossStoreEod.length > 0` (skip the all-zeros initial paint). Same
for the per-store grid's food_cost_streak alert.

---

## Sparkline + Heatmap component design

Both match my §3 / §4 prop contracts:

- **Sparkline.tsx** — 53 LOC, exactly the §3 spec. `Path` + optional
  fill, `strokeWidth: 1.4`, `strokeLinecap: 'round'`. Empty/single-
  point input renders empty Svg without throwing (matches §3 rule).
  Reusable beyond Dashboard — purely presentational, takes color as
  prop. **Approved.**

- **Heatmap.tsx** — 153 LOC (a bit over the §4 estimate of ~80, but
  the bin-paint helper + label width param + thresholds prop are all
  worth the bytes). Cell painting matches the §4 table exactly.
  Reusable beyond Dashboard — `HeatmapRow` + `dayLabels` shape is
  generic (any per-row × per-column heatmap). One missing API
  affordance: `dayLabels` is required and labelled "day labels" in
  the prop comment, but the component doesn't actually need them to
  be days (any column header strings work). Consider renaming the
  prop to `columnLabels` for honesty, but that's a Phase 2 polish.
  **Approved.**

Neither component reaches into Zustand. Both work on RNW + native
without platform branching (per spec lock Q7 + the SVG decision in
§3). Drift: zero.

---

## Summary

- 0 Critical
- 5 Should-fix (S1–S5; S1 is the one I'd actually push back on)
- 6 Nits (N1–N6)
- All 6 architect Decisions (D1–D6) implemented per spec
- Reconciliation refactor math is verifiably equivalent
- Sparkline + Heatmap match prop contracts, are reusable

The single most important follow-up: **delete or rewrite
`useStoreFoodCostHeatmap` and `useAttentionQueueByStore` hooks (S1)**.
As shipped they're documented footguns — the next person to discover
them via grep will hit the partial-data bug we just designed around.

The architect rationale doc-drift on D2 (S2) is worth fixing in the
spec for posterity but doesn't change the impl. The
focal-vs-fleet-wide framing question (S2/S3) is a UX/PM call, not
strictly an architecture finding.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 5 Should-fix, 6 Nits.
  Top recommendation: delete/rewrite the two dead hooks
  (useStoreFoodCostHeatmap, useAttentionQueueByStore) before they bite
  the next contributor. Reconciliation refactor math verified equivalent
  to pre-refactor inline path; R3 probe is sound but skips silently when
  no EOD exists (S5).
payload_paths:
  - /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/009-dashboard-v2/reviews/backend-architect.md
