## Code review for spec 130

Scope reviewed: `src/utils/reorderDayFilter.ts` (+ `.test.ts`),
`src/screens/cmd/sections/ReorderSection.tsx` (+ `__tests__/ReorderSection.spec130.test.tsx`,
`ReorderSection.test.tsx`, `ReorderSection.spec123.test.tsx`, `ReorderSectionCases.test.tsx`),
`src/screens/staff/screens/Reorder.tsx` (+ `Reorder.test.tsx`), admin i18n
(`src/i18n/en.json`/`es.json`/`zh-CN.json`), staff i18n
(`src/screens/staff/i18n/en.json`/`es.json`/`zh-CN.json`).

Overall: implementation matches the architect's Backend design closely. The
predicate is correctly centralized (`isReorderCountNotSubmitted`, `eodSubmittedAt
== null`), imported by both screens with no inline re-derivation. Un-counted
vendors are filtered out of the needs/enough split, the `computeReorderKpis`
input, and the export/`showExport` gate on both surfaces, and land in a
dedicated top group. The not-submitted `VendorCard` branch on both surfaces
returns early before the footer/action block, so `reorder-create-po-*`,
`reorder-quick-order-*`, `reorder-export-csv-*`, `reorder-export-pdf-*` are
genuinely unmounted (not hidden) for an un-counted vendor — verified by reading
the render tree, not just the tests. A counted vendor's render path is
untouched. i18n keys are present and translated (not left in English) in all
three locale files on both surfaces. No direct `supabase.from/rpc` calls, no
`window.confirm`/`Alert.alert`, no inline hex colors, no legacy-file edits, no
`app.json` change, tests stay on the jest track.

### Critical

None found.

### Should-fix

- `src/screens/staff/screens/Reorder.tsx:808-815` — the staff "Count not
  submitted" group header renders `t('reorder.countNotSubmitted.groupTitle')`
  with no vendor count, while (a) the equivalent admin group header appends
  `· {notSubmittedPrimary.length}` (`src/screens/cmd/sections/ReorderSection.tsx:1465`),
  and (b) the staff screen's own sibling "no schedule" group interpolates a
  count into its localized title (`t('reorder.noSchedule.title', { count:
  noSchedule.length })`, `Reorder.tsx:864`). This is a real admin/staff parity
  gap for the exact feature this spec asks to keep in parity — a manager on
  staff loses the at-a-glance "how many vendors need a count" signal the admin
  surface (and staff's own noSchedule pattern) provides. Fix: add a `{count}`
  placeholder to `reorder.countNotSubmitted.groupTitle` (all three staff locale
  files) and pass `{ count: notSubmittedDisplay.length }` at the call site, or
  drop the count from the admin header for a documented reason — but the two
  surfaces should agree.

- `src/screens/cmd/sections/ReorderSection.tsx:524-548` and `:590-637` (mirrored
  by `src/screens/staff/screens/Reorder.tsx:181-196` and `:219-234`) — the
  not-submitted branch duplicates the vendor-name + badges + next-delivery
  header markup verbatim from the normal branch instead of extracting it into
  a small shared sub-render (e.g., a `VendorCardHeader` helper taking
  `sourceBadgeEl`/`scheduleBadgeEl`/`daysLabel`). Both branches will drift if
  a future change touches the header (e.g., a new badge) and only one branch
  gets updated — exactly the kind of duplication CLAUDE.md flags. Scoped small
  today (~15-20 lines per file), but worth extracting now since this spec is
  the second render branch to need it.

### Nits

- `src/screens/cmd/sections/ReorderSection.tsx` / `src/screens/staff/screens/Reorder.tsx`
  — after this change, `computeReorderKpis(needsOrderVendors)` (admin) and
  `computeReorderKpis(needsOrderVendors)` (staff, fed from `countedDisplay`)
  can never include a vendor with `onHandSource === 'stock'`, because that
  vendor is by the documented payload-contract invariant also
  `eodSubmittedAt == null` and is filtered out before the KPI call. Net
  effect: the "On-hand source" stat's "N stock fallback" sub-label
  (`StatCard label="On-hand source"` on admin; `reorder.kpi.sourceSub` on
  staff) will now always render `0`, even when the new "Count not submitted"
  group above it is showing several vendors. This is a direct, presumably-
  intended consequence of the architect's Q4 resolution (not a bug to fix in
  this review), but it turns a previously-meaningful stat into dead/always-
  zero display — flagging in case the architect/release-coordinator wants to
  either drop that sub-label or repoint it at `notSubmittedPrimary.length` /
  `notSubmittedDisplay.length` in a follow-up.
- `src/screens/cmd/sections/ReorderSection.tsx:476` — `itemTone` is computed
  unconditionally before the not-submitted early return at line 513, even
  though it's unused on that branch. Harmless (cheap ternary), but could move
  below the branch check for clarity.
