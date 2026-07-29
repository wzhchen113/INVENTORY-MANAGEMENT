# Spec 145: Phone tier for the Dashboard screen

Status: READY_FOR_REVIEW

> Next increment of the admin-console phone-optimization program (specs
> 140/142/143/144) driven by the external design handoff (`design_handoff_imr_phone`,
> README §5 "Dashboard (P2)"). Spec 140 delivered the phone EOD-count tier + the
> `PhoneType` ramp; spec 142 the global chrome + the shared list/detail drill-in
> scaffold + `PhoneWidgets`; specs 143/144 the Ordering + Weekly-count tiers. This
> spec covers the **Dashboard** screen: the desktop single-column ScrollView (a
> non-wrapping KPI strip that squeezes at phone width + a CoGS card + a food-cost
> heatmap + a per-store attention grid) becomes a thumb-first vertical feed — a
> 2×2 flex-wrap KPI grid over three grouped sections. Frontend-only,
> presentation-layer, gated on `useIsPhone()`; no backend / migration /
> edge-function / `src/lib/db.ts` contract change.

## Scope (design handoff README §5)

Behind `if (isPhone) return <PhoneDashboard model={…}/>` placed AFTER all hooks in
`DashboardSection.tsx` (desktop + tablet byte-unchanged, AC-REG):

- **Header:** title ("Dashboard") + a mono meta line ("{date} · {store}").
- **2×2 KPI cards** (flex-wrap `flex:1 0 44%`, NO CSS grid; `kpiValue` ramp):
  INVENTORY VALUE (fg) / OUT OF STOCK (danger) / LOW VS PAR (warn) / WASTE · 7 DAYS
  (fg). Values are **lifted verbatim** from `DashboardSection`'s own selectors
  (`totalInvValue` / `outCount` / `lowCount` / `wasteWeek` + `itemCount` /
  `wasteEventCount`) — no re-derived math on the phone side.
- **TODAY'S EOD COUNT** group: per-vendor progress rows (vendor name + `N/M` open ·
  `✓` submitted, with a DONE/OPEN pill). Tapping deep-links to that vendor's EOD
  count tab via the `usePaletteAction` `eodFocusItemId` bridge (same cross-section
  jump as PhoneOrdering's GO TO EOD COUNT).
- **NEEDS ATTENTION** group: the OUT items (== the OUT KPI count) as `TwoLineRow`s
  (danger `StatusPill` + name + on-hand/unit right value + "par … · $/unit ·
  VENDOR" meta). Tapping opens the full-screen `PhoneInventoryDetail` via the
  shared `PhoneDrillScaffold` + `usePhoneDrill` — the SAME drill-in the Inventory
  section uses (reused, not forked, and not a cross-section deep-link).
- **RECENT ACTIVITY** group: the current store's audit feed (most-recent-first,
  capped) as two-line rows — `formatAuditAction` title + mono `userName` meta +
  `relativeTime` right value.
- Everything in one vertical `ScrollView` inside the drill scaffold; no horizontal
  scroll; every tappable ≥44×44; group captions via `GroupCaption`; status colors
  are semantic tokens, never the accent.

## Reuse (no new primitives, no forked logic)

`useCmdColors()` / `CmdRadius` / `PhoneType` / `mono()`; `TwoLineRow` +
`GroupCaption` (`PhoneWidgets`); `PhoneDrillScaffold` + `usePhoneDrill` +
`PhoneInventoryDetail` (spec 142) for the NEEDS ATTENTION drill-in; `StatusPill`;
`formatCostPerEach` / `costPerEachLabel` (`../../lib/itemMoney`);
`getLocalizedName`; `formatAuditAction`; `relativeTime`; the `usePaletteAction`
bridge. The KPI figures + the derived group views (`outItems` / `wasteEventCount`
/ per-vendor `eodRows` / `recentActivity`) are computed in `DashboardSection` from
its existing store slices and passed down in a `model` bundle — the PhoneEodCount
/ PhoneWeeklyCount lift pattern (no new store fields, no direct DB access). The
per-vendor EOD membership mirrors `EODCountSection`'s tab derivation (junction
`vendorIds`, scalar `vendorId` fallback).

## Acceptance

- Full vendor + item + category names (flex:1, ellipsize only past full width); no
  sideways/stacked text; no horizontal scroll; every tappable ≥44×44 (KPI cards,
  rows, EOD deep-link rows); both themes via tokens only; OUT/LOW use the
  danger/warn tokens, never the accent.
- Desktop (≥1100px) + tablet (768–1099px) render output byte-unchanged (AC-REG):
  the guard + a `useIsPhone()` read + the `vendors` slice read + the
  `PhoneDashboard` import + four phone-only memos (`outItems` / `wasteEventCount` /
  `eodRows` / `recentActivity`) are the only edits to `DashboardSection.tsx`; the
  desktop return subtree is untouched (the memos run for every tier but are
  consumed only under the phone guard).
- `npx tsc --noEmit` clean; full `npx jest` green (1595 tests); web bundle
  compiles via Metro (the `PhoneDashboard ↔ DashboardSection` graph resolves —
  both exercised by jest + the web export).

## Deviations / notes

- **Model-lift for the KPIs, direct reuse for the drill-in.** Per the task's "do
  not re-derive new math; extract/reuse the desktop's computed values", the KPI
  figures arrive in `model` from `DashboardSection`'s own selectors. The NEEDS
  ATTENTION drill-in reuses `PhoneDrillScaffold` + `PhoneInventoryDetail` inline
  (self-contained) rather than deep-linking to the Inventory section — the task's
  preferred option ("reuse, don't fork").
- **Current-store scope for the two store-specific groups.** TODAY'S EOD COUNT and
  RECENT ACTIVITY are scoped to `currentStore` (the phone is single-store in
  practice); the KPI roll-ups stay brand-wide, matching the desktop KPI math they
  reuse. When `currentStore` is `__all__`/unset those two groups render their
  empty states rather than hard-blocking (the KPIs are still meaningful).
- **EOD deep-link uses the first vendor item as the focus id**, the same
  established `eodFocusItemId` bridge PhoneOrdering's GO TO EOD COUNT uses — the
  sanctioned cross-section jump (no new palette surface).
- **`groupItems`-style plural-only copy.** The EOD sub-label is `{counted} OF
  {total} COUNTED` for all counts (no singular special-case), matching the
  prototype's compact caption.

## Tests (jest track only — no DB/edge change)

- `phone/__tests__/PhoneDashboard.test.tsx` — KPI values from a fixture model +
  the danger/warn/fg (never-accent) value coloring; EOD progress rows (open `N/M`
  vs submitted `✓`) + the deep-link payload; NEEDS ATTENTION == the OUT items with
  the drill-in opening on tap (nothing selected by default); RECENT ACTIVITY rows
  with the localized `formatAuditAction` title; every group's empty state.
- `phone/__tests__/PhoneDashboard.acReg.test.tsx` — desktop + tablet render the
  desktop `overview.tsx` TabStrip tree, not the phone component; phone renders it
  and drops the tab strip. Mirrors PhoneOrdering.acReg / PhoneWeeklyCount.acReg.
- No existing `DashboardSection*.test.tsx` suites exist (the section had no jest
  coverage), so no desktop-forcing `theme/breakpoints` mock needed elsewhere. The
  `InventoryDesktopLayout` test already mocks `DashboardSection` to null and forces
  `useIsPhone → false`, so it is unaffected.

## Files changed

### New
- src/screens/cmd/sections/phone/PhoneDashboard.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneDashboard.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneDashboard.acReg.test.tsx
- specs/145-phone-dashboard-tier.md

### Modified — host section (guard + model lift; desktop/tablet byte-unchanged)
- src/screens/cmd/sections/DashboardSection.tsx  (isPhone guard → PhoneDashboard;
  `vendors` slice read; `outItems` / `wasteEventCount` / `eodRows` /
  `recentActivity` memos feeding the model)

### Modified — i18n (all three catalogs, parity kept)
- src/i18n/en.json / es.json / zh-CN.json  (section.dashboard.phone.metaLine,
  kpiInvValue, kpiInvValueSub, kpiOut, kpiOutSub, kpiLow, kpiLowSub, kpiWaste,
  kpiWasteSub, eodGroup, eodSubmitted, eodProgress, eodPillDone, eodPillOpen,
  noEod, attentionGroup, attentionMeta, noAttention, activityGroup, noActivity)

## Handoff

next_agent: code-reviewer, security-auditor, test-engineer
prompt: Review the implementation of this spec. Each reviewer writes its findings
  to specs/145-phone-dashboard-tier/reviews/<your-name>.md.
payload_paths:
  - specs/145-phone-dashboard-tier.md
  - src/screens/cmd/sections/phone/PhoneDashboard.tsx
  - src/screens/cmd/sections/DashboardSection.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneDashboard.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneDashboard.acReg.test.tsx
  - src/i18n/en.json
  - src/i18n/es.json
  - src/i18n/zh-CN.json
