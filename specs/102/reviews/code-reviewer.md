# Code review — spec 102 (multi-vendor ingredients)

Reviewer: code-reviewer. Captured by main Claude from the agent's report
(the agent completed the review but did not persist this file itself).

## Critical

- **`src/components/cmd/IngredientFormDrawer.tsx:184–191` — inline "+ new vendor" in EDIT mode wipes existing links.**
  `handleVendorDrawerClose` sets the scalar `vendorId`/`vendorName` for a
  newly-created vendor but does NOT add it to `values.vendors`. On save in edit
  mode, `toUpdates(values).vendors` is therefore `[]`, and `updateInventoryItem`
  with `vendors: []` deletes ALL existing `item_vendors` links for the item. The
  item ends with a dangling `inventory_items.vendor_id` pointing at the new
  vendor but zero junction rows → it disappears from every vendor tab and the
  reorder explosion. New-item mode is OK (the `db.ts:348-352` synthesis fallback
  creates one link). Fix: add the new vendor to `values.vendors` in
  `handleVendorDrawerClose`, mirroring `handleAttachVendor`.

## Should-fix

- **`src/lib/db.ts:751–761` — `submitEODCount` silently swallows a failed
  `item_vendors` prefetch.** On error, `linkedItemIdsForVendor` is empty → every
  entry fails the membership check → all `inventory_items` on-hand updates are
  skipped for the whole submission. Entries persist, but `current_stock` /
  `eod_remaining` go stale (reorder reads stale on-hand until the next fetch).
  The per-item "don't throw" rationale (line 780) doesn't apply to a prefetch
  failure that kills the batch. Fix: throw, or fall back to the submission's own
  entry item IDs (already client-gated in `buildSubmission`).
- **`src/lib/db.ts:429,460–469` — `updateInventoryItem` clears `is_primary` when
  `updates.vendorId` is omitted.** `vendorId` local is `null` when
  `updates.vendorId` is undefined → `v.vendorId === null` false for all links →
  every `is_primary` set false. Current callers always send `vendorId` so it
  doesn't manifest, but the function is fragile. Fix: fall back to the item's
  existing `vendor_id` (as the optimistic mirror does at `useStore.ts:1182`).
- **`src/lib/db.ts:751–754` — membership prefetch is not store-scoped.** Comment
  claims "at this store (RLS-scoped)" but query filters only by `vendor_id`; a
  multi-store admin gets item_ids across all accessible stores. No cross-store
  write (UUIDs unique) but wider than stated. Fix: filter by submission store.
- **`src/lib/db.ts:479` — raw `.not('vendor_id','in',`(${ids.join(',')})`)`
  string** differs from the file's parameterized `.in(col, [vals])` convention;
  fragile if `ids` ever holds a non-UUID. Fix: use the array form.

## Nits

- `src/screens/cmd/sections/EODCountSection.tsx:83–86` — `deriveCountedItemIds`
  includes any submission status, not just draft/submitted; tighten the gate.
- `src/lib/db.ts:4023` — dead `lv.vendor?.id` fallback (the embed always selects
  `vendor_id`).
- `supabase/migrations/20260630000300_report_weekly_lowstock.sql:93–131` — recipe
  CTE chain is a verbatim copy from `report_reorder_list`; add an "update in
  lockstep" cross-reference comment.
- `src/screens/staff/screens/WeeklyCount.tsx:121–144` — `fetchLowStock` is a
  second mapper for the same RPC `db.fetchWeeklyLowStock` already maps; drift
  risk (staff carve-out permits it, deferred).
- `src/screens/staff/lib/fetchReorder.ts:42–49` — documented, justified verbatim
  copy; noted only for completeness.
