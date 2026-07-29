# Spec 143: Phone tier for the Ordering (Reorder) screen

Status: READY_FOR_REVIEW

> Next increment of the admin-console phone-optimization program (specs 140/142)
> driven by the external design handoff (`design_handoff_imr_phone`, README §3
> "Ordering (P1)"). Spec 140 delivered the phone EOD-count tier + the `PhoneType`
> ramp + the `ResponsiveSheet` bottom-sheet idiom; spec 142 delivered the global
> phone chrome + the list/detail sections + the shared drill-in scaffold. This
> spec covers the **Ordering / Reorder** screen: the desktop single-column vendor
> cards (fixed-width columns that letter-stack on phone) become a flat, full-width
> list of collapsible vendor cards with a thumb-reachable stepper + one primary
> action per card. Frontend-only, presentation-layer, gated on `useIsPhone()`; no
> backend / migration / edge-function / `src/lib/db.ts` contract change.

## Scope (design handoff README §3)

Behind `if (isPhone) return <PhoneOrdering/>` placed AFTER all hooks in
`ReorderSection.tsx` (desktop + tablet byte-unchanged, AC-REG):

- **Header:** title + "FOR MON JUL 27 ▾" date chip (display; tap → honest toast,
  matching the prototype's non-mutating `dateTap`); KPI line
  "N VENDORS · M LINES · est $…" computed over the counted (active) vendors.
- **Vendor cards (flat list, not the desktop needs/enough split):** chevron + name
  collapsible ▸/▾, status badge (ok "COUNTED TODAY" / "EOD {mon day}" · warn
  "STOCK FALLBACK" · violet "NO COUNT"), "next delivery:" line, stats line
  (lines · cs · est $).
- **Line rows:** name + "case of 25 lbs · $3.80/lb" + − / N CS / + stepper (44px
  tall, ± 40px wide) + line cost ("—" when 0). Steppers write BASE units through
  `setReorderEditQty` (clamped ≥0) via the spec-134 `poCaseDisplay` conversions;
  qty/cost recompute through `applyReorderEdits` exactly as desktop.
- **Footer per card:** ··· overflow (48×48 outline) → `ResponsiveSheet`
  (`presentation.phone: 'bottom-sheet'`) action sheet (QUICK-ORDER LIST / EXPORT
  CSV / EXPORT PDF / ORDER SCHEDULE), reusing the desktop handlers
  (`buildPoQuickOrderText` + `sharePurchaseOrder`; `handleCsvExport` /
  `handlePdfExport` / `handleImportExport` re-exported from `ReorderSection`);
  native CSV/PDF + ORDER SCHEDULE surface honest toasts. Plus ONE primary 48px
  button: extension vendors = solid "FILL CART →" (→ ok "CART FILLED ✓" via the
  existing `fillCartForVendor`); others = outline "QUICK-ORDER LIST ⧉".
- **Count-not-submitted (spec 130, violet):** card border violet; body replaced by
  the violet block (⊘, "COUNT NOT SUBMITTED YET", copy, "GO TO EOD COUNT →"),
  which deep-links to that vendor's EOD tab via the `usePaletteAction`
  `eodFocusItemId` bridge (same cross-section jump as PhoneInventoryDetail's
  COUNT NOW). No footer actions.

## Reuse (no new primitives, no forked logic)

`useCmdColors()` / `CmdRadius` / `PhoneType` / `mono()` / `sans()` /
`ResponsiveSheet`; the pure helpers `partitionReorderVendors` /
`isReorderCountNotSubmitted` / `weekdayName` (`reorderDayFilter`), `applyReorderEdits`
/ `narrowReorderToVendor` (`ReorderSection`), `isCaseRow` / `poOrderedToCases` /
`poCasesToBase` (`poCaseDisplay`), `buildPoQuickOrderText` (`poQuickOrderText` —
NOT forked), `pickImportVendor` (`vendorImportShared`), `formatMoney` / `formatQty`
(`reorderExport`). Store slices read directly: `reorderPayload` (hydrated by the
parent's still-running load effects), `orderSchedule`, `reorderEdits`,
`setReorderEditQty`, `clearReorderEditsForVendor`, `fillCartForVendor`, `vendors`,
`inventory`, `currentStore`. Spec 130's gating + spec 135's collapsible semantics
preserved.

## Acceptance

- Full vendor + item names (flex:1, ellipsize only past full width); no
  sideways/stacked text; no horizontal scroll; every tappable ≥44×44 (steppers 44
  tall / ± 40 wide, ··· 48×48, primary 48); both themes via tokens only.
- Desktop (≥1100px) + tablet (768–1099px) render output byte-unchanged (AC-REG):
  the guard + a `useIsPhone()` read + the `PhoneOrdering` import + the `export`
  keyword on three already-defined orchestrators are the only edits to
  `ReorderSection.tsx`; the desktop return subtree is untouched.
- `npx tsc --noEmit` clean; full `npx jest` green (1567 tests); web bundle
  compiles via Metro (the `PhoneOrdering ↔ ReorderSection` cycle resolves — both
  directions exercised by jest and the 15.8 MB web bundle).

## Deviations / notes

- **Flat list, not needs/enough split.** The phone prototype (README §3 + the
  `.dc.html` Ordering frame) shows ONE flat list of vendor cards, so `PhoneOrdering`
  renders the day-filtered `primary` vendors flat (count-not-submitted ones get the
  violet treatment inline). The desktop needs/enough/no-schedule grouping is a
  desktop affordance and is unchanged there.
- **Date chip is display-only + honest toast.** The prototype's `dateTap` only
  shows a toast; a functional phone date picker would require lifting the parent's
  `selectedDate`/load lifecycle (the parent owns it and its effects still run under
  the guard). The chip shows the loaded `asOfDate` and taps to a toast pointing to
  desktop. Deliberate, matches the prototype.
- **Cards default expanded on phone** (the steppers are the primary interaction),
  vs desktop's default-collapsed scannable summary.

## Tests (jest track only — no DB/edge change)

- `phone/__tests__/PhoneOrdering.test.tsx` — card render + KPI, case-stepper
  base-unit write-through (clamp ≥0), spec-130 violet state + EOD deep-link,
  extension FILL CART, ··· overflow sheet actions (with real store selectors +
  real `reorderDayFilter` / `poCaseDisplay` / `applyReorderEdits`).
- `phone/__tests__/PhoneOrdering.acReg.test.tsx` — desktop + tablet render the
  desktop `reorder.tsx` tree, not the phone component; phone renders it.
- The seven existing `ReorderSection*.test.tsx` suites gained a desktop-forcing
  `theme/breakpoints` mock (they default to the phone tier under jest's window,
  which now routes to `PhoneOrdering`).

## Files changed

### New
- src/screens/cmd/sections/phone/PhoneOrdering.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneOrdering.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneOrdering.acReg.test.tsx
- specs/143-phone-ordering-tier.md

### Modified — host section (guard + reuse exports; desktop/tablet byte-unchanged)
- src/screens/cmd/sections/ReorderSection.tsx  (isPhone guard → PhoneOrdering;
  `export` added to `handleCsvExport` / `handlePdfExport` / `handleImportExport`
  so the phone overflow sheet reuses them)

### Modified — i18n (all three catalogs, parity kept)
- src/i18n/en.json / es.json / zh-CN.json  (section.reorder.phoneKpiVendors,
  phoneKpiLines, phoneKpiEst, phoneCardStats, phoneItemsAffected, phoneCartFilled,
  phoneGoToEodCount, phoneSheetTitle, phoneExportCsv, phoneExportPdf,
  phoneOrderSchedule, phoneOrderScheduleToast, phoneDateFor, phoneDateHint)

### Modified — existing tests (force desktop tier for the new isPhone fork)
- src/screens/cmd/sections/__tests__/ReorderSection.test.tsx
- src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx
- src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx
- src/screens/cmd/sections/__tests__/ReorderSection.spec130.test.tsx
- src/screens/cmd/sections/__tests__/ReorderSection.spec135.test.tsx
- src/screens/cmd/sections/__tests__/ReorderSection.spec138.test.tsx
- src/screens/cmd/sections/__tests__/ReorderSection.resetAfterExport.spec138.test.tsx

## Handoff

next_agent: code-reviewer, security-auditor, test-engineer
prompt: Review the implementation of this spec. Each reviewer writes its findings
  to specs/143-phone-ordering-tier/reviews/<your-name>.md.
payload_paths:
  - specs/143-phone-ordering-tier.md
  - src/screens/cmd/sections/phone/PhoneOrdering.tsx
  - src/screens/cmd/sections/ReorderSection.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneOrdering.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneOrdering.acReg.test.tsx
  - src/i18n/en.json
  - src/i18n/es.json
  - src/i18n/zh-CN.json
