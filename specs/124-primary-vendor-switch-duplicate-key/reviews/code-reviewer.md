## Code review for spec 124

### Critical
(none)

### Should-fix
- `src/lib/db.ts:466-474` — The block-level summary comment above the
  `item_vendors` reconcile ("Upsert each present link ... then delete links
  whose vendorId is not in the submitted set") was not updated to mention the
  new demote step. A reader who only skims this top comment (rather than the
  inline comment at `db.ts:496-499`) would still believe the reconcile is a
  two-step upsert→delete, which is exactly the stale assumption that caused
  this bug in the first place (the spec-119 RPC comment claiming to mirror
  `updateInventoryItem`'s "proven ordering" when it didn't). Update the
  summary to state the final order explicitly: demote → upsert → delete.

### Nits
- `src/lib/db.updateInventoryItemPrimarySwitch.test.ts:144-148` — `itemVendorsBuilders` is
  collected via `push` in the error-case test but never read or asserted
  against afterward; dead collection, can be dropped.
- `src/lib/db.updateInventoryItemPrimarySwitch.test.ts:142` — Comment says "Fail the FIRST
  item_vendors abortSignal (the demote)" but the `mockImplementation` actually
  installs a once-erroring `abortSignal` on *every* fresh `item_vendors`
  builder (demote, upsert, delete alike), not just the first. The test still
  passes only because the demote throws first and short-circuits the rest —
  worth tightening the comment so a future reader doesn't assume the mock is
  scoped to the first call specifically.
- `src/lib/db.updateInventoryItemPrimarySwitch.test.ts:37` — The shared `single()` mock
  resolves with `{ vendor_id: null, catalog_id: 'catalog-000001' }`; no test in
  this file exercises the `updates.vendorId === undefined` fallback branch
  that calls `.single()`, so `catalog_id` is unused boilerplate carried over
  from a template. Harmless but can be trimmed to `{ vendor_id: null }`.

### Summary
The fix is placed exactly where the design calls for — inside
`if (updates.vendors.length > 0)`, immediately before the upsert
(`src/lib/db.ts:495-506`) — with correct null-handling (`.neq('vendor_id', …)`
omitted only when `primaryVendorId` is null, verified against the empty-string
input case in the test), no `updated_at` in the demote payload, `.abortSignal(signal)`
threaded consistently with the sibling upsert/delete calls, and a throw-on-error
that preserves the existing optimistic-then-revert contract in
`useStore.ts:1402-1407` (unchanged, correctly not touched by this spec).
`createInventoryItem` is untouched, matching the spec's "confirmed safe" note.
The jest test (`db.updateInventoryItemPrimarySwitch.test.ts`) genuinely asserts call
*order* (`demoteIdx < upsertIdx`) rather than mere presence, and separately
covers the `primaryVendorId=null` demote-all variant and the error-revert path.
Naming (`demote`, `demoteRes`, `linkUpsert`, `delRes`) is consistent with the
existing `del` variable style in the same function. No direct-Supabase,
color-literal, confirm-dialog, web-only-API, or legacy-file issues in this
diff.
