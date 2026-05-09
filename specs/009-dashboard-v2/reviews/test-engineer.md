## Test report for spec 009 (Dashboard v2)

Reviewed: 2026-05-06
Reviewer: test-engineer

No test runner exists on this project (CLAUDE.md "Gaps and unknowns" confirmed).
All evidence is CODE-VERIFIED (static inspection) unless labeled VERIFIED (live,
confirmed by main Claude's browser session per the dispatch brief). No new test
framework was introduced; the recommendation section at the end surfaces this gap.

---

### Acceptance criteria status

**A1.** `DashboardSection.tsx` renders 5 KPI tiles in a horizontal strip, each
with label, value, sub-label, delta pill, and inline SVG sparkline of 7-14 data
points. KPIs: total inventory value, avg food cost %, waste/wk, EOD submitted,
stock alerts.

Status: VERIFIED (live evidence from main Claude's browser session).

Code corroboration: `DashboardSection.tsx:288-328` renders five `<Kpi>` tiles in
a `flexDirection:'row'` `<View>`. Each tile receives `series` from either
`synthSeries` (10 points, within the 7-14 spec) or `fcSeries` (up to 10 real
points falling back to synthetic). All five KPI labels match the spec exactly.
Delta pills render conditionally (`{delta ? <Text>…</Text> : null}`) — correct;
empty string suppresses the pill for the EOD-submitted tile when all stores are
complete.

Test path: `specs/009-dashboard-v2/reviews/test-engineer.md` (this file). No
automated test. VERIFIED.

---

**A2.** `src/components/cmd/Sparkline.tsx` exists, accepts
`{ values, color, width?, height?, fill? }`, renders a polyline + optional
area fill via `react-native-svg`, works web + native.

Status: CODE-VERIFIED.

`Sparkline.tsx` imports `Svg, { Path }` from `react-native-svg` directly (the
project has `react-native-svg@15.12.1` as a direct dep). The `fill` prop renders
a closed-area `<Path>` at `fillOpacity={0.12}`. Degenerate input (`values.length
< 2`) returns an empty `<Svg>` without throwing. No platform branch needed — the
`react-native-svg` package handles web + native rendering via the existing
react-native-web shim. The prop surface matches the spec exactly.

One deviation: the spec calls for "a polyline", but the implementation uses
`<Path>` with `M … L … L` segments rather than a `<Polyline>` element. This is
functionally equivalent and produces an identical visual result. Not a defect.

---

**A3.** CoGS card renders with three Stat sub-tiles (theoretical, actual,
Δ variance with %) and a "top variance items" list (top 5 by |Δ$|).

Status: VERIFIED (live evidence).

Code corroboration: `DashboardSection.tsx:344-355` renders `<CogsCard>` with
`theoretical`, `actual`, `delta`, `pct` from `useCogsForCurrentStore(7)`, and
`topRows` from `useTopVarianceItems(7, 5)`. `CogsCard` renders three `<CogsStat>`
tiles plus the top-5 list. Empty state (`topRows.length === 0`) shows "no
variance lines yet — needs EOD + POS data" (correct for local seed). The Δ
variance `pct` field is derived in `useCogsForCurrentStore` as `(delta /
theoretical) * 100` — matches spec.

---

**A4.** Variance computation extracted into `cmdSelectors.ts` as a pure function;
Reconciliation refactored to consume it; no behavioral change.

Status: CODE-VERIFIED.

`cmdSelectors.ts:324-366` defines `computeVarianceLines`. `ReconciliationSection.tsx:9`
imports it. `ReconciliationSection.tsx:55` calls
`computeVarianceLines(currentStore.id, inventory, eodSubmissions, stores, 'priorEod')`.

The R3 parity probe at `ReconciliationSection.tsx:81-118` is correctly guarded
by `if (!__DEV__) return;` — it fires only in dev builds, only when `latest` is
non-null, and only when the inline-vs-selector row sets diverge. When rows match
(normal case), the `useEffect` runs to completion with no log output. This
probe is not noisy: it logs nothing on a matching result, logs only on
mismatch, and is a `useEffect` (not render-time). The probe is correctly scoped.
No noise concern.

---

**A5.** Food-cost variance heatmap: 4 rows × 7 columns, color-graded per
heatmap thresholds.

Status: VERIFIED (live evidence: 4 store rows, 7 day columns, all 0.0 on local
seed).

Code corroboration:

`Heatmap.tsx:38-44` defines `DEFAULT_THRESHOLDS = { danger:2.5, deepWarn:1.5,
warn:0.5, neutral:0.5, ok:-0.5 }`. This matches the spec's threshold table
exactly.

`cellPaint` at `Heatmap.tsx:55-65` implements the five-bin ladder:

- `vv >= 2.5` → `C.danger`, opacity 1.0, text `#fff`
- `vv >= 1.5` → `C.warn`, opacity 0.85, text `#fff`  (Decision D1: deep amber collapsed)
- `vv >= 0.5` → `C.warn`, opacity 0.65, text `#fff`
- `-0.5 < vv < 0.5` → `C.fg3`, opacity 0.35, text `C.fg`
- `vv <= -0.5` → `C.ok`, opacity 0.55, text `C.fg`

This matches the spec's §4 table in `Backend design`.

Cell label format: `{vv > 0 ? '+' : ''}{vv.toFixed(1)}` at `Heatmap.tsx:143`.
Spec says exactly the same format. Match.

Legend present in `DashboardSection.tsx:614-640` (`HeatmapLegend`) showing −1 to
−0.5, ±0.5, +0.5 to 1.5, +2.5+ swatches. Legend range labels match live evidence.

Decision D1 deviation (deep amber collapsed to `C.warn` at two opacities) is
documented by spec and inline comment. Not a defect.

---

**A6.** Per-store column grid: one card per visible store with header, 4-cell
mini-stats, attention queue, manager footer.

Status: VERIFIED (live evidence: 4 store cards rendered).

Code corroboration: `DashboardSection.tsx:393-408` maps `stores` array to
`<StoreCol>` components. `StoreCol` renders: store header (name, status pill,
slug mono subtitle), 4-cell `Mini2` grid (inv, food%, alerts, eod), attention
queue section, footer with manager + lastSync.

Per-store data correctness: `store.eodDeadlineTime` is read directly from the
store object; `auth_can_see_store()` RLS enforces store visibility at the DB
level, so `stores` from `useStore` is already pre-filtered. The card set respects
RLS implicitly.

---

**A7.** Attention queue: 4 alert types, each `{ sev, text }`, sorted high →
med → low.

Status: CODE-VERIFIED (two of four rules firing live per dispatch brief; other
two need data conditions).

**eod_missing**: Implemented in `cmdSelectors.ts:700-728`. Three-branch ladder:
  - Both today and yesterday missing → `sev:'low'`, text "EOD missing 2 days running"
  - Today missing + past deadline → `sev:'high'`, text "EOD missing past HH:MM deadline"
  - Today missing + not yet past deadline → `sev:'med'`, text "EOD not yet submitted today"

DISCREPANCY FOUND: The spec's A7 summary states "severity: high if 0 entries
past `eodDeadlineTime`, **med otherwise**". The §7 rule table refines this with
a three-tier ladder: `high` (past deadline), `med` (today, not yet past
deadline), `low` (missing yesterday too). The implementation follows the §7
table, not the A7 summary. The §7 table is the authoritative binding document
per the architect's design, so the implementation is correct per the intended
design. However, the A7 text is misleading: it says "med otherwise" but the
implementation emits `low` for the two-day-running case. This is a spec
clarity issue, not a code bug — the architect's table explicitly says `low`
when yesterday is also missing. The implementation is correct against §7.

**low_out_stock**: `cmdSelectors.ts:730-755`. Three-tier ladder:
  - `out > 0` → `sev:'high'`
  - `low > 5` → `sev:'med'`
  - `1 ≤ low ≤ 5` → `sev:'low'`

DISCREPANCY FOUND: Spec A7 summary says "low stock (med)". The §7 rule table
corrects this to a three-tier ladder where `1 ≤ low ≤ 5` → `low`, `low > 5` →
`med`. Implementation follows §7. Same pattern as eod_missing above — A7
summary is simplified shorthand, §7 is authoritative. Code is correct per §7.

**food_cost_streak**: `cmdSelectors.ts:757-790`. Trailing 7-day variance
computed, then consecutive trailing `pp >= 1` days counted.
  - Streak >= 5 → `sev:'high'`
  - Streak >= 3 → `sev:'med'`
  - Streak < 3 → no alert

Spec A7 says "Food-cost streak ≥3 days over target (high)". The §7 table
corrects this: `streak >= 5 → high; 3-4 → med`. Implementation follows §7. Same
spec-clarity issue; §7 is authoritative. Code is correct per §7.

**unconfirmed_po**: `cmdSelectors.ts:799-821`. Lookback window 4-7 days (i.e.,
4 to 7 days ago, exclusive of today/yesterday/3-days-ago). For each lookback day,
checks `orderSchedule[dayName]` for scheduled vendors, then checks
`orderSubmissions` for a matching row. Missing matches generate `sev:'med'` alerts
with text `"{vendorName} order missed ({date})"`.

Decision D6 correctly implemented: the rule is "scheduled vendor with no
matching submission > 3 days old". Per spec §11 D6, this is the approved
rewrite. The lookback range (4-7 days) correctly targets "> 3 days old" (day-0
is today; days 1-3 are too recent; 4+ are > 3 days).

Sorting: `out.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || a.text.localeCompare(b.text))`
at `cmdSelectors.ts:826-829`. Correct: high → med → low, then alphabetic.

---

**A8.** Count badge color: zero items → `C.ok`; any high-severity item → `C.danger`;
otherwise → `C.warn`.

Status: CODE-VERIFIED.

`DashboardSection.tsx:712`:
```
const countTone =
  queue.length === 0 ? C.ok : queue.some((q) => q.sev === 'high') ? C.danger : C.warn;
```
Exact match with spec. Badge count renders at line 820 with `color: countTone`.

---

**A9.** No new Zustand actions introduced; selectors live in `cmdSelectors.ts`.

Status: VERIFIED (live evidence per dispatch brief; code inspection confirms).

`DashboardSection.tsx` only reads from `useStore` via selector callbacks (`(s) => s.xxx`).
No new action methods added to `useStore.ts`. All derivations are in `useMemo`
blocks in the component or in `cmdSelectors.ts` pure functions / hook wrappers.

---

**A10.** All visual primitives reuse existing Cmd atoms where they exist; only
`<Sparkline />` and `<Heatmap />` are new.

Status: CODE-VERIFIED.

`DashboardSection.tsx` imports: `useCmdColors`, `CmdRadius` (theme), `sans`,
`mono`, `Type` (typography), `TabStrip`, `SectionCaption` (existing Cmd atoms).
No new imports from `src/components/cmd/` beyond `Sparkline` and `Heatmap`.

However: `StatCard`, `StatusPill`, and `StatusDot` are NOT used in the
implementation — the developer built inline `<Kpi>`, `<CogsStat>`, and a bespoke
status indicator inside `<StoreCol>` rather than reusing the existing atoms. The
spec says these existing atoms should be reused "where they exist". Whether these
inline analogs constitute a violation depends on interpretation:

- `<Kpi>` is a Dashboard-specific compound that combines a sparkline with
  a stat display — `StatCard` doesn't support an embedded sparkline, so a new
  local sub-component is defensible.
- The status pill in `StoreCol` is built inline rather than reusing `<StatusPill>`
  from `src/components/cmd/StatusPill.tsx`. This is a mild deviation: the
  existing `StatusPill` atom could have been used here. The custom implementation
  renders the same semantic content, just without code reuse.
- `StatusDot` is used conceptually (a 6px circle for store status) but as an
  inline `<View>` rather than importing `src/components/cmd/StatusDot.tsx`.

These deviations are cosmetic — the visual output matches the spec, and the two
genuinely new components (`Sparkline`, `Heatmap`) are correctly new files. This
is a Minor finding: the A10 atom-reuse intent is partially met but not fully
honored for `StatusPill` and `StatusDot`.

---

**A11.** Type-check passes (`npx tsc --noEmit`) and dashboard renders without
runtime errors.

Status: VERIFIED (dispatch brief: `tsc --noEmit` shows 119 total errors, down
from 149 baseline; no new errors introduced by this feature; dashboard renders
cleanly on local Supabase).

---

**A12.** v1 fully removed — no feature flag, no dual-render path. 328-line v1
replaced in place.

Status: VERIFIED (dispatch brief: dev's full rewrite of `DashboardSection.tsx`
with no feature flag).

Code corroboration: `DashboardSection.tsx` has a single default export with no
conditional rendering on any feature flag. `featureFlags.ts` is not imported.
The file is 930 lines (including inline sub-components) — structurally a full
replacement of the v1 328-line file.

---

### Additional findings

**Finding 1 — D2 cross-store data wiring (Decision D2): CODE-VERIFIED, correct.**

`DashboardSection.tsx:107-152` implements the Decision D2 mount effect:
`fetchEodSubmissionsForStores` and `fetchPosImportsForStores` are called in a
`React.useEffect` with `storeIds.join(',')` and `currentStore.id` in the
dependency array. Results are held in `crossStoreEod` / `crossStorePos`
component-local state. The focal-store realtime slice is merged in:

```js
const allEod = useMemo(() => {
  const others = crossStoreEod.filter(s => s.storeId !== currentStore.id);
  return [...others, ...eodSubmissions];   // focal store = always realtime
}, [...]);
```

This correctly gives the focal store's eodSubmissions realtime updates while
non-focal stores get mount-time data. Both `heatmapRows` and `queueByStore`
consume `allEod` / `allPos`, so the cross-store data is fully wired.
R4 caveat (non-focal stores not refreshed on realtime) is documented in code.

**Finding 2 — R3 parity probe: probe is well-scoped, not noisy.**

`ReconciliationSection.tsx:81-118` wraps the probe in `if (!__DEV__) return;`
and only logs when inline and selector results diverge (row count mismatch, row
order mismatch, or dollar value mismatch > $0.01). On a matching result the
`useEffect` exits silently. In production, the entire block is stripped by Metro's
dead-code elimination on `__DEV__`. The probe does not fire on every render
unconditionally — it fires on every dependency change, but only logs when
divergence is detected. This is acceptable behavior for a dev-only parity
check.

**Finding 3 — Empty "all clear" state: code path exists.**

`DashboardSection.tsx:824-828`:
```jsx
{queue.length === 0 ? (
  <View style={{...}}>
    <Text style={{...}}>✓</Text>
    <Text style={{...}}>all clear</Text>
  </View>
) : (
  queue.map(...)
)}
```
The empty state code path exists. It could not be exercised on the local seed
(every store has alerts) but the logic is straightforward. CODE-VERIFIED.

**Finding 4 — SYNTHETIC_KPI_SERIES tag is grep-discoverable.**

Two references in `DashboardSection.tsx`:
- Line 27: block comment `// SYNTHETIC_KPI_SERIES — Phase 1 placeholder. No daily KPI rollups exist yet…`
- Line 190: inline comment `// Other 4 KPIs use synthSeries — see SYNTHETIC_KPI_SERIES tag above.`

The tag is grep-discoverable. Future contributors will find the comment with
`grep -r SYNTHETIC_KPI_SERIES src/`. Confirmed per spec R1 mitigation.

**Finding 5 — D6 unconfirmed_po rule implementation matches Decision D6.**

The lookback loop in `cmdSelectors.ts:799-821` iterates `lookback = 4..7` (4, 5,
6, 7 days ago). This covers the "> 3 days old" window specified by D6. For each
past day it checks whether `orderSchedule[pastDayName]` lists any vendors and
whether `orderSubmissions` has a matching row by `storeId + date + vendorName`.
Missing matches are surfaced as `sev:'med'` with the date in the text, allowing
the operator to identify which specific missed order is being flagged. The
`id` format `{storeId}:po:{vendorKey}:{pastISO}` keeps each day's miss as a
distinct entry (matching the spec's stable-id contract in §7). D6 is correctly
implemented.

**Finding 6 — StatCard / StatusPill / StatusDot partial reuse (A10 minor deviation).**

As noted under A10: the `<StoreCol>` sub-component builds its status indicator
and store-header badge inline rather than importing `StatusPill` or `StatusDot`
from `src/components/cmd/`. The visual output is equivalent. This is a code
quality / consistency issue, not a behavioral defect. The spec language ("reuse
existing Cmd UI atoms where they exist") is mildly violated for these two atoms.

**Finding 7 — Test framework gap: selectors are now the highest-value test target.**

`cmdSelectors.ts` now contains approximately 960 lines of pure, deterministic
logic: `computeVarianceLines`, `computeCogsTheoretical`, `computeCogsActual`,
`computeTopVarianceItems`, `computeStoreFoodCostVariancePp`,
`computeAttentionQueue`. All six accept plain JS primitives and return plain JS
values. `computeAttentionQueue` accepts an injectable `now?: Date` parameter
specifically to allow deterministic unit tests.

The A7 spec discrepancies between the high-level A7 summary and the §7 rule
table (eod_missing `low` case, low_out_stock `low` case, food_cost_streak `med`
case) are currently untested. Without a unit test runner these rules can silently
regress. The R3 parity probe covers the Reconciliation code path but nothing
covers the attention queue or heatmap math.

Recommendation: introduce vitest as a devDependency (zero build config on this
Metro project — vitest can run `src/lib/*.ts` files in Node without Expo).
Target: `src/lib/cmdSelectors.ts` first. The architect's §8 explicitly anticipates
this ("the selectors are designed to be unit-testable when the runner lands").
This is a separate spec decision, not a blocker for this spec's ship — but the
gap should be on the PM's backlog.

---

### Test run

No automated test runner exists on this project. The evidence above is:
- VERIFIED: live browser evidence from main Claude's dispatch brief (A1, A3, A5,
  A6, A11, A12)
- CODE-VERIFIED: static code inspection in this session (all ACs, all findings)
- NOT TESTED via automation: all criteria

---

### Notes

1. **Spec text vs. implementation discrepancy (A7, severity ladders):** The
   acceptance criteria text in A7 is simplified shorthand. The authoritative rule
   table is in §7 of the Backend design. The implementation correctly follows §7.
   The A7 text should be updated in a spec cleanup pass to avoid confusing future
   reviewers. This is documentation-only, not a code defect.

2. **No test framework:** per CLAUDE.md "Gaps and unknowns" and per spec §8
   (which explicitly says "no test framework, treat as visual-acceptance only").
   The test-engineer is surfacing this as a standing gap. No framework was
   introduced without user approval.

3. **Coverage of cross-store data in food_cost_streak for non-focal stores:**
   Per spec §12 note and `cmdSelectors.ts:836-844` comment block, the hook
   `useAttentionQueueByStore()` only sees focal-store `eodSubmissions`, so the
   food_cost_streak rule fires with 0-pp data for non-focal stores when using the
   hook. However, `DashboardSection.tsx` does NOT use the hook — it calls
   `computeAttentionQueue(...)` directly with `allEod` (which includes cross-store
   data from the mount effect). The attention queue food_cost_streak rule for
   non-focal stores is therefore correctly computed with real cross-store EOD data.
   This is correct behavior; the concern in the spec notes applies only to the
   hook, not the dashboard's direct invocation.

4. **Native testing:** spec Q7 = web only. Native testing is not required.
