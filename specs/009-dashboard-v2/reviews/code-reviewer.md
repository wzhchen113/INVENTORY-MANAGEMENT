# Code review for spec 009

Reviewer: code-reviewer
Date: 2026-05-06

Files reviewed:
- `src/lib/cmdSelectors.ts` (new selectors block, lines 255-959)
- `src/lib/db.ts` (lines 482-585 — `fetchEodSubmissionsForStores`, `fetchPosImportsForStores`)
- `src/components/cmd/Sparkline.tsx` (NEW)
- `src/components/cmd/Heatmap.tsx` (NEW)
- `src/screens/cmd/sections/DashboardSection.tsx` (REWRITE)
- `src/screens/cmd/sections/ReconciliationSection.tsx` (refactored `rows` + parity probe)

---

### Critical

_None._

No legacy files were touched (AdminScreens.tsx, useSupabaseStore.ts, useJsonServerSync.ts, db.json are clean). No direct `supabase.from()` calls outside `db.ts`. No `app.json` slug change. No new `*.test.ts` files without a framework. No realtime channels added.

---

### Should-fix

**1. `src/screens/cmd/sections/ReconciliationSection.tsx:75-118` — R3 parity probe ships as-is with no removal plan.**

The probe is guarded by `__DEV__` so it won't run in production bundles, and the inline comment says "slated for removal after one round of manual visual diffing." The spec ask is explicit: the developer asked the reviewer to decide "remove before ship or keep for one production cycle." Given that the live-evidence note confirms Reconciliation renders without crash and the probe fires only in development, the probe should be removed before this branch merges. It reproduces the full prior-EOD walk (lines 83-103) that `computeVarianceLines` was specifically extracted to consolidate — keeping it adds dead weight to the file. If parity confidence is needed for a future regression, a standalone test against the pure function is the right home for that logic, not a `useEffect` side channel in a production component. **Remove the `useEffect` block (lines 81-118) before merge.**

**2. `src/screens/cmd/sections/DashboardSection.tsx:650` — `getItemStatus` prop typed as `(i: any) => 'ok' | 'low' | 'out'` instead of using the existing type.**

```ts
getItemStatus: (i: any) => 'ok' | 'low' | 'out';
```

The store's `getItemStatus` is typed as `(item: InventoryItem) => ItemStatus` (per `useStore.ts`). The `any` here suppresses a real type. The `ItemStatus` enum/union is imported in `cmdSelectors.ts` already. `StoreColProps` should mirror the actual signature: `getItemStatus: (i: InventoryItem) => ItemStatus`. This is a TypeScript strictness violation — `any` used to sidestep a type error rather than fix it.

**3. `src/screens/cmd/sections/DashboardSection.tsx:296` / `309` / `326` — hard-coded delta strings on three KPI tiles.**

```ts
delta="+4.2%"    // TOTAL INV VALUE
delta="+8%"      // WASTE / WK
delta={lowOutAll.length > 0 ? '+25%' : ''}   // STOCK ALERTS
```

These are literal strings with no derivation from real data. The spec (§6, D5) explicitly calls for `SYNTHETIC_KPI_SERIES` on the sparkline series — synthetic is acceptable there. But the delta pill is a different field: it's the labelled numeric change shown next to the tile headline. Showing "+4.2%" and "+8%" as permanent hard-coded values is misleading in a way the synthetic series is not (the series is decorative; the pill reads as a precise percentage change). The `SYNTHETIC_KPI_SERIES` comment does not cover the delta strings. Either drive them from `synthSeries` (first vs last point) or blank them with `delta=""` like the EOD tile does when counts are equal. As shipped, an operator will read "+4.2%" as a real inventory-value increase from yesterday. This is R1 made worse.

**4. `src/screens/cmd/sections/DashboardSection.tsx:139` — `eslint-disable-next-line` suppressing a hooks rule for a dependency that can be expressed correctly.**

```ts
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [stores.map((s) => s.id).join(','), currentStore.id]);
```

The comment is right that `storeIds.join()` is the stable primitive you want. But calling `.map(...).join(',')` inline in a dependency array creates a new string on every render and still correctly triggers the rule warning because the outer `stores` reference is not listed. The standard fix is to derive the stable string in a `useMemo` one line above and list the memoised value:

```ts
const storeIdsKey = React.useMemo(() => stores.map((s) => s.id).join(','), [stores]);
// useEffect deps: [storeIdsKey, currentStore.id]
```

This removes the lint suppression, expresses intent clearly, and means the `useEffect` fires exactly when store membership changes — same behaviour, no comment needed.

**5. `src/screens/cmd/sections/DashboardSection.tsx:646-651` — `StoreColProps` uses `ReturnType<typeof useStore.getState>` twice instead of the typed slice.**

```ts
inventory: ReturnType<typeof useStore.getState>['inventory'];
auditLog: ReturnType<typeof useStore.getState>['auditLog'];
```

Both slices have concrete types already — `InventoryItem[]` and `AuditEvent[]` (imported in other files from `../../../types`). Using `ReturnType<typeof useStore.getState>[...]` for prop types couples this component's interface to the Zustand store's internal shape, which is the opposite of "pure presentational component that takes typed props." Replace with the explicit types.

---

### Nits

**N1. `src/components/cmd/Sparkline.tsx` — `label` prop from the architect's spec §3 is not implemented.**

The architect's interface specified:
```ts
/** Optional accessibility label (rendered as <title> child of <Svg>). */
label?: string;
```
The implementation drops it. Not a functional regression (browser renders fine without `<title>`), but the omission means the component isn't fully spec-compliant and screen readers get nothing. Low impact for a desktop admin tool, but easy to add.

**N2. `src/screens/cmd/sections/DashboardSection.tsx:219-221` — `heatmapDays` and `heatmapDayLetters` as empty-dep `useMemo` is unnecessary.**

```ts
const heatmapDays = React.useMemo(() => lastNDates(7), []);
const heatmapDayLetters = React.useMemo(() => lastNDayLetters(7), []);
```

`lastNDates(7)` and `lastNDayLetters(7)` are called once at mount with no deps that ever change. They could simply be module-level constants computed once at import time — `lastNDates` and `lastNDayLetters` don't close over any component state. Wrapping them in `useMemo([])` is a pattern that reads as "expensive and reactive" when it's neither.

**N3. `src/screens/cmd/sections/DashboardSection.tsx:180-181` — `lowOutAll` filtered twice in the same render pass.**

```ts
const outCount = lowOutAll.filter((i) => getItemStatus(i) === 'out').length;
const lowCount = lowOutAll.filter((i) => getItemStatus(i) === 'low').length;
```

`getItemStatus` is already called inside the `lowOutAll` memo above. These two filters call it again on the pre-filtered list. A single pass `reduce` or destructuring of counts from the original memo would be cleaner and avoids calling `getItemStatus` a third time per item. With 286K seed data this is harmless; pattern-wise it's repetitive.

**N4. `src/screens/cmd/sections/DashboardSection.tsx:679` — `foodPct` in `StoreCol` uses the v1 heuristic with a magic `30`.**

```ts
const foodPct = eodToday ? 30 + ((eodToday.entries?.length || 0) % 5) : 30;
```

This is deliberately the v1 proxy, but `30` is a magic literal when `TARGET_FOOD_COST_PCT` is already defined at the top of the file for exactly this purpose. Replacing `30` with `TARGET_FOOD_COST_PCT` (twice) makes the constant do its job and makes the fallback's intent explicit: "proxy lands near target."

**N5. `src/components/cmd/Heatmap.tsx:104-106` — row key uses `row.label` which is not guaranteed unique.**

```ts
key={`${row.label}-${rIdx}`}
```

If two stores share a name prefix that truncates identically (unlikely today, defensive for the future), this key could collide. `storeId` is the stable identity; the parent (`DashboardSection.tsx`) could pass it through, or the key could be `rIdx` alone since the array order is stable. Minor.

**N6. `src/screens/cmd/sections/DashboardSection.tsx:183` — `todayISO` is a plain `const` outside all memos, which re-computes on every render.**

```ts
const todayISO = isoDay(new Date());
```

`new Date()` is called on every render. Since the dashboard is unlikely to be left open across midnight, this is functionally fine, but if `todayISO` is used in multiple memos as a dependency (it is — line 185, 673), each render produces a new string reference. For `useMemo` deps this is harmless because string equality is value-based in JS. Pattern still worth noting.

**N7. `src/lib/cmdSelectors.ts:651` — `DAY_NAMES` constant duplicated from `DashboardSection.tsx:55`.**

Both files define `const DAY_NAMES = ['Sunday', 'Monday', ...]`. The one in `cmdSelectors.ts` is used inside `computeAttentionQueue`. The one in `DashboardSection.tsx` is dead — the dashboard calls `computeAttentionQueue` directly and never uses `DAY_NAMES` locally. Remove the `DashboardSection.tsx` copy (line 55).

**N8. `src/lib/cmdSelectors.ts` — `computeStoreFoodCostVariancePp` O(n) `findIndex` inside a date-walk loop.**

```ts
const idx = ordered.findIndex((s) => s.id === sub.id);
```

This is O(N) inside an outer loop over dates × EODs — effectively O(N²) on the submission list. `computeCogsActual` avoids this by walking a `for(i)` loop and using the outer index directly. `computeStoreFoodCostVariancePp` takes a different approach (iterates dates first, then finds the submission) which forces the `findIndex`. A map from `sub.id → index` built before the date loop would be O(1). With the seed data volume (14 days × 4 stores × small entry sets) this doesn't matter in practice, but the inconsistency between the two functions is worth noting.

**N9. `src/screens/cmd/sections/DashboardSection.tsx:560-561` — sign-display inconsistency in CoGS variance row.**

```ts
{v.deltaCost > 0 ? '+' : '−'}${Math.abs(Math.round(v.deltaCost))}
```

Uses a Unicode minus (`'−'`, U+2212) while the KPI delta pills use a regular hyphen-minus (`'-'`). Either standardize on Unicode minus everywhere for math display (correct typographically) or use the ASCII hyphen everywhere. Mixed usage within one screen is inconsistent.
