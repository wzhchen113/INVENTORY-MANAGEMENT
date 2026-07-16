# Security audit for spec 124

Primary-vendor switch duplicate-key fix. Client-side write-ordering change in
`updateInventoryItem` (`src/lib/db.ts`) — one pre-demote `UPDATE item_vendors
SET is_primary=false` issued before the existing upsert. No migration, no RPC,
no edge function, no RLS/grant change. Reviewed against the three confirmation
points requested plus the standard threat model.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
None.

### Confirmations

1. **Scope / RLS parity — CONFIRMED.**
   `src/lib/db.ts:500-506` — the demote is
   `supabase.from('item_vendors').update({ is_primary: false }).eq('item_id',
   id).eq('is_primary', true)` with an optional `.neq('vendor_id',
   primaryVendorId)`. It is scoped to `item_id = id` — the single item being
   edited — and issued through PostgREST as the authenticated caller. It is
   governed by the pre-existing `store_member_update_item_vendors` policy
   (`supabase/migrations/20260630000000_item_vendors.sql:131-137`), an
   `exists(... and auth_can_see_store(ii.store_id))` USING+WITH CHECK on the
   UPDATE command — the same policy that already governs any UPDATE on this
   table. RLS additionally constrains the write to rows whose parent
   `inventory_items.store_id` is visible to the caller, so no cross-store write
   is reachable even though the client filter is only `item_id`. No new access
   path, no privilege change. The sibling upsert (`:507-520`) and delete
   (`:524-529`) in the same block ride the insert/delete policies at
   `:126-142`. Identical enforcement.

2. **No injection — CONFIRMED.**
   Every value in the demote is a bound method argument, not string-built:
   `update({ is_primary: false })`, `.eq('item_id', id)`, `.eq('is_primary',
   true)`, `.neq('vendor_id', primaryVendorId)` — the requested `.neq` value is
   a parameter, not interpolated. `id` and `primaryVendorId` reach PostgREST as
   query parameters. No `EXECUTE`, no dynamic SQL, no template string in the
   spec-124 change.
   (Note, out of scope: the pre-existing de-select delete at `:526` builds a
   filter via `\`(${ids.join(',')})\`` where `ids` are vendor UUIDs. This is
   untouched by spec 124 and the values are server-generated UUIDs bound to a
   uuid column; not introduced or altered here, so not a finding for this spec.)

3. **No new data exposure, no secrets — CONFIRMED.**
   The demote reads no rows back (only `error` is inspected at `:506`), returns
   nothing to the client, and handles no tokens, keys, or PII. No
   `console.log`/`notifyBackendError` payload carries new sensitive data. Error
   is thrown to the `track()` wrapper (`:531`), matching the existing
   optimistic-revert contract — no SQL fragment or row data surfaced to the UI
   beyond the existing behavior.

### Additional checks
- No new table → no missing-RLS risk. No migration on disk; the
  `db-migrations-applied.yml` gate is unaffected.
- No edge function, no `verify_jwt`/service-token surface, no HTML/email body,
  no destructive role/deletion path — none of the edge-function discipline
  checks apply.
- `createInventoryItem` unchanged; design confirmed it starts from zero
  `item_vendors` rows so it cannot hit the ordering bug — not a security
  concern either way.
- The test file `src/lib/db.updateInventoryItemPrimarySwitch.test.ts` mocks
  only `supabase.from`; no secrets, no live credentials.

### Dependencies
No `package.json` changes — `npm audit` skipped.

## Verdict
0 Critical, 0 High, 0 Medium, 0 Low. All three requested confirmation points
hold. Nothing blocks merge from a security standpoint.
