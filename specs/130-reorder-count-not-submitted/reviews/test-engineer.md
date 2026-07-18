## Test report for spec 130

### Acceptance criteria status

- AC1 (admin: un-counted vendor renders header + "Count not submitted yet", no order-qty rows) →
  PASS — `src/screens/cmd/sections/__tests__/ReorderSection.spec130.test.tsx::Reorder — count not submitted (spec 130) > renders the not-submitted state block and NONE of the four per-vendor actions` (asserts `reorder-count-not-submitted-v-b` renders and no per-vendor action testIDs render). Implementation branch confirmed at `src/screens/cmd/sections/ReorderSection.tsx:513` (`isReorderCountNotSubmitted(vendor)` guard before item rows / footer).

- AC2 (staff: same "Count not submitted yet" treatment) → PASS —
  `src/screens/staff/screens/Reorder.test.tsx::Reorder — count not submitted (spec 130) > renders the not-submitted state block and NO item/order rows` (asserts `staff-reorder-count-not-submitted-v-3` + group testID render, and `Stale Widget` / `Order: 9 each` do NOT render).

- AC3 (counted vendor unchanged — breakdown + order lines render exactly as today) → PASS —
  admin: `ReorderSection.spec130.test.tsx::renders a counted vendor normally (breakdown + all actions present)` (asserts `reorder-count-not-submitted-v-a` is absent and all four action testIDs present). staff: `Reorder.test.tsx::excludes the un-counted vendor from the KPIs + export payload` asserts `staff-reorder-vendor-v-1` (the counted vendor's normal card) still renders alongside the not-submitted vendor. Pre-existing suites (`ReorderSection.test.tsx`, `ReorderSection.spec123.test.tsx`, `ReorderSectionCases.test.tsx`) were updated to give their default vendor fixture a non-null `eodSubmittedAt`, so their full existing assertion surface (breakdown rows, PO/quick-order/export actions, KPI math) continues to exercise the counted path under the new predicate with no regression — all pass.

- AC4 (treatment keys off existing `report_reorder_list` payload signal; no change to reorder math or EOD-vs-stock detection) → PASS —
  `src/utils/reorderDayFilter.test.ts::isReorderCountNotSubmitted (spec 130)` pins the predicate (`eodSubmittedAt == null` → true for null and undefined; non-null ISO string → false) as a pure unit test against the existing `ReorderVendor` type; no RPC/type/mapper change was made (confirmed by `git diff`-free `src/lib/db.ts` / `src/screens/staff/lib/fetchReorder.ts` per the spec's Files-changed list, and the predicate itself does not alter `computeReorderKpis` or `splitReorderVendorsByNeed`, both still pure and unit-tested independently elsewhere in `reorderDayFilter.test.ts`).

- AC5 (message routed through i18n on both surfaces, all locales) → PASS —
  verified directly: `section.reorder.countNotSubmittedGroupTitle` / `…Title` / `…Body` present with non-empty translated strings in `src/i18n/en.json`, `es.json`, `zh-CN.json`; `reorder.countNotSubmitted.groupTitle` / `.title` / `.body` present in all three `src/screens/staff/i18n/*.json` files. `npx jest i18n.test` (both admin and staff parity suites, which fail on any missing key across locales) — 2 suites / 24 tests PASS.

- AC6 (Q2 — per-vendor actions hidden for an un-counted vendor) → PASS —
  admin: `ReorderSection.spec130.test.tsx` asserts `reorder-create-po-v-b` / `reorder-quick-order-v-b` / `reorder-export-csv-v-b` / `reorder-export-pdf-v-b` are all `null` for the un-counted vendor, confirmed against `ReorderSection.tsx:513-741` (footer with `CreatePoButton`, `ReorderQuickOrderButton`, `ReorderVendorExportButtons` sits entirely inside the `else` branch of the not-submitted guard). staff: `Reorder.test.tsx` asserts the global `staff-reorder-export-csv` row is absent when the visible set is un-counted-only, and present again once a counted vendor is in view — matching the Q3 "gate `showExport`/`exportPayload` on the counted set" resolution.

- AC7 (Q3 — KPIs / needs-enough split exclude un-counted vendor's items/cost) → PASS —
  admin: `ReorderSection.spec130.test.tsx::excludes the un-counted vendor from the Items / Est. total KPIs` — with a counted vendor (1 item, $10) and an un-counted vendor (2 items, $20) both in the payload, `statcard-Items` reads `'1'`, `statcard-Est. total` reads `'$10.00'`, `statcard-Vendors` reads `'1'` — the un-counted vendor's stale lines contribute nothing. staff: `Reorder.test.tsx::excludes the un-counted vendor from the KPIs + export payload` — export payload + KPIs (`itemCount: 1`, `totalEstimatedCost: 144`) reflect only the counted vendor.

- AC8 (jest coverage on both surfaces: (a) un-counted → message + no order rows, (b) counted → unchanged) → PASS —
  both surfaces have both cases as enumerated in AC1/AC2/AC3 above.

### Test run

- `npx jest reorderDayFilter ReorderSection Reorder` → 11 suites / 151 tests, all PASS (console noise is pre-existing act()-wrapping warnings from unrelated notification-toggle code exercised incidentally by shared screen mounts — not failures, not spec-130-related).
- `npx jest` (full suite) → **122 suites / 1306 tests, all PASS** — matches the count claimed in the spec's Files-changed / Verification section.
- `npx tsc --noEmit` → clean, exit 0.
- `npm run typecheck:test` → clean, exit 0.
- `npx jest i18n.test` → 2 suites / 24 tests PASS (admin + staff locale-parity suites), confirming AC5's locale-key completeness independent of manual inspection.

### Notes

- No framework drift: all new tests are jest / `@testing-library/react-native`, consistent with the existing tracks. No pgTAP or shell-smoke additions needed or made — correct per spec (frontend-only, no RPC/DB change confirmed by inspection of `src/lib/db.ts` and `src/screens/staff/lib/fetchReorder.ts`, neither of which was touched).
- The spec's implementation note flags that live-browser verification of the actual un-counted-vendor UI state was NOT performed (preview tooling unavailable in the implementation session, and the condition requires a seeded un-counted vendor). I did not have live Supabase / browser access invoked for this review either; my verification is jest + typecheck only, same limitation carried forward. This is a minor residual gap (the rendered visual treatment — icon/glyph styling, layout truthfulness beyond testID presence) but does not block: the jest suites assert the behaviorally load-bearing facts (which testIDs/text exist, which are absent, and the KPI numbers), which is exactly what the ACs require. Flagging so the release-coordinator can decide whether a manual/live spot-check is warranted before ship, but it is not a Critical — no AC is unverified at the behavior level.
- The "noSchedule edge" tradeoff called out in the spec's Risks section (an un-counted no-schedule vendor stays inside the collapsed no-schedule group rather than the dedicated top group) is an explicitly accepted v1 limitation per the architect's design, not tested here, and not required by any AC as written — surfacing for completeness only, not as a gap.
- All six risk-flagged highest-priority ACs (un-counted shows no quantities, KPIs exclude un-counted, counted vendors unchanged, both surfaces covered) are covered by passing tests with no gaps found. No BLOCK.
