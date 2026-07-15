# Code review for spec 123 (Reorder: per-vendor CSV/PDF exports + persistent "PO CREATED")

Scope reviewed: `supabase/migrations/20260718000000_reorder_list_has_po.sql`,
`src/lib/db.ts` (`mapReorderVendor`, `createPurchaseOrderDraft`),
`src/store/useStore.ts` (`createPoDraft`), `src/types/index.ts` (`ReorderVendor`),
`src/screens/staff/lib/fetchReorder.ts`, `src/screens/cmd/sections/ReorderSection.tsx`,
`src/i18n/{en,es,zh-CN}.json`, `supabase/tests/reorder_list_has_po.test.sql`,
`src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx`.

## Critical

None found. The migration is a byte-for-byte diff of the live
`20260711000000_reorder_list_include_stocked.sql` body plus exactly the one
additive `has_po` EXISTS key (verified line-by-line — every CTE, the KPI block,
and the warnings block are untouched); `createPurchaseOrderDraft` /
`createPoDraft` / `mapReorderVendor` / `ReorderVendor.hasPo` all match the
design's exact shape; the disabled "PO CREATED" chip is a plain `View` with no
`onPress`, verified non-pressable by the jest test
(`ReorderSection.spec123.test.tsx:262-263`); i18n parity holds for
`poCreatedLabel`/`poCreatedAria` across en/es/zh-CN at identical line numbers.

## Should-fix

- `src/screens/cmd/sections/ReorderSection.tsx:734-735` and `:1034` — the
  per-vendor CSV/PDF filenames (`IMR_Reorder_${slugifyStore(store.name)}_${date}.csv`
  / `.pdf`) do not include the vendor name. Since export is now scoped
  per-vendor-card (this spec's whole point), clicking "CSV" on vendor A's card
  and then vendor B's card on the same store+date produces two downloads with
  the **exact same filename** — the browser will auto-suffix or the user's
  manual save can clobber the first file, and neither filename indicates which
  vendor's order it contains. This directly undercuts the acceptance criterion
  "export exactly one vendor's order at a time." Fix: thread `vendor.vendorName`
  (slugified) into the filename in `handleCsvExport`/`handlePdfExport`, or have
  `ReorderVendorExportButtons` build a vendor-qualified filename before calling
  the builders (no signature change to `buildReorderCsv` itself is required —
  only the filename string built at the call site needs it).
- `src/screens/cmd/sections/ReorderSection.tsx:1135-1138, 1145` — `exportPayload`
  (a `useMemo` that spreads `reorderPayload` with `vendors: primary` and
  recomputed `kpis`) is no longer consumed by any export path — the per-vendor
  buttons read `reorderPayload` directly (`:414`) and narrow it themselves. The
  memo is now used **only** for its truthiness in `showExport` (`!!exportPayload`
  at `:1145`), which is equivalent to `!!reorderPayload`. This is leftover from
  before the narrowing refactor — recomputing a full filtered-payload object
  every render just to check non-null is dead weight and confusing to a future
  reader who'll assume it's still wired to an export call. Simplify to
  `!!reorderPayload` (or drop the memo and use `reorderPayload` directly) and
  remove `exportPayload`.
- `src/screens/cmd/sections/ReorderSection.tsx:418-427` (`onCsv`) and
  `src/utils/vendorImportShared.ts:87` (`resolveExportBase`'s `otherVendorCount`)
  — because `onCsv` now **always** narrows the payload to the single card's
  vendor (`narrowReorderToVendor`) before calling `pickImportVendor` /
  `handleImportExport`, `resolveExportBase`'s `otherVendorCount` (computed as
  `payload.vendors.filter(v => v.vendorId !== cfg.id).length`) can never be
  nonzero from this call site anymore — the narrowed payload only ever contains
  `cfg.id` itself. The "Risk 1" toast note in `emitImportPlan`
  (`ReorderSection.tsx:771-772`, `"${plan.otherVendorCount} other vendor(s) not
  in this file"`) is now permanently unreachable dead logic reached through this
  path. Since the whole point of per-vendor export is that a vendor's card only
  ever produces that vendor's file (no longer a surprise "other vendors
  omitted" scenario), the cue may simply be intentionally moot now — but the
  code and its "Risk 1" comment don't reflect that; either remove the dead
  branch from this call site or add a comment explaining it's vestigial for a
  future non-narrowed caller.

## Nits

- `src/screens/cmd/sections/ReorderSection.tsx:448,457` — the per-vendor
  export buttons' `accessibilityLabel` is a hardcoded English literal
  (`"Export CSV"` / `"Export PDF"`), while the sibling `CreatePoButton` /
  `ReorderQuickOrderButton` in the same footer use `T('section.reorder....')`
  i18n keys. Matches the pre-existing untranslated REFRESH button
  (`:1192`, `"Refresh reorder list"`) so it's not a *new* inconsistency, but
  worth an i18n key next time this file is touched.
- `src/screens/cmd/sections/ReorderSection.tsx:418-432` — `onCsv` and `onPdf`
  each independently call `narrowReorderToVendor(reorderPayload, vendor)`;
  trivial/cheap, but could be hoisted to one `const narrowed = ...` shared by
  both handlers (or memoized) for a small dedup win.
- `src/types/index.ts:905-912`, `src/screens/staff/lib/fetchReorder.ts:106-111`
  — making `hasPo` a required field (forcing the staff mapper touch even
  though the staff Reorder screen never renders a create-PO button) is the
  right call: it makes a future third `ReorderVendor` producer fail to compile
  if it forgets the mapping, versus silently defaulting via `hasPo?: boolean`.
  No change requested — noting only because the spec explicitly asked for a
  required-vs-optional opinion.
- Jest coverage for `mapReorderVendor`'s `has_po` → `hasPo` mapping and its
  "absent → false" default (called out in the spec's own "Tests surface" as
  jest item (a)) doesn't appear to exist as a direct `db.ts` unit test — it's
  only indirectly exercised via `ReorderSection.spec123.test.tsx`'s hand-built
  `vendor()` fixtures, which never go through the real `mapReorderVendor`
  function. Likely test-engineer territory; flagging for their awareness
  rather than as a code-craft defect.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 3 Should-fix, 4 Nits.
payload_paths:
  - specs/123-reorder-per-vendor-exports-po-created/reviews/code-reviewer.md
