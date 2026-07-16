# Backend-architect drift review — Spec 124 (primary-vendor switch duplicate-key)

Mode: post-implementation drift review. Comparing STAGED implementation against
the `## Backend design` I authored in
`specs/124-primary-vendor-switch-duplicate-key.md`.

Verdict: **No drift. The implementation matches the design on every point.**

Files reviewed:
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts`
  (`updateInventoryItem`, lines 389-532; `createInventoryItem`, lines 288-382)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.updateInventoryItemPrimarySwitch.test.ts`
- `supabase/migrations/` (full listing — confirmed no spec-124 `.sql`)

## Confirmations against the design

### (1) Client-side pre-demote (Option 1) — MATCHES
`db.ts:500-506` inside `updateInventoryItem`:
- `supabase.from('item_vendors').update({ is_primary: false })` — demote UPDATE. Correct.
- `.eq('item_id', id).eq('is_primary', true)` — filters `item_id=id AND is_primary=true`. Correct.
- `if (primaryVendorId) demote = demote.neq('vendor_id', primaryVendorId);`
  (`db.ts:504`) — the `.neq('vendor_id', …)` is applied ONLY when
  `primaryVendorId` is truthy (non-null). null → filter omitted → demote-all.
  Matches the design's "OMITTED so the statement demotes ALL primaries." Correct.
- Placed inside `if (updates.vendors.length > 0)` (guard opens at `db.ts:495`),
  BEFORE the upsert (`db.ts:507`). Correct.
- `.abortSignal(signal)` threaded (`db.ts:505`). Correct.
- `if (demoteRes.error) throw demoteRes.error;` (`db.ts:506`) — throws on error,
  reaching the `track()` wrapper / optimistic-revert. Correct.

### (2) Ordering demote → upsert → delete — MATCHES
- demote: `db.ts:500-506`
- upsert: `db.ts:507-520`
- delete de-selected: `db.ts:524-529`
Sequence is exactly demote → upsert → delete as designed. The legacy scalar
mirror (`inventory_items.vendor_id`) is still written by the earlier per-store
UPDATE at `db.ts:457-464` (SD-1 preserved, unchanged).

### (3) No `updated_at` in the demote payload — MATCHES (load-bearing detail honored)
`db.ts:501` payload is exactly `{ is_primary: false }`. No `updated_at`,
consistent with the sibling upsert which also leaves the column to the DB. The
jest test explicitly locks this: `expect(demote?.args[0]).toEqual({ is_primary: false })`
(`db.updateInventoryItemPrimarySwitch.test.ts:119`).

### (4) No migration / RPC / edge change; `createInventoryItem` untouched — MATCHES
- No spec-124 migration: glob `*124*.sql` returns nothing; latest migration on
  disk is `20260709000000_vendor_order_unit.sql`. Nothing added to
  `supabase/migrations/`. The `db-migrations-applied.yml` gate is unaffected.
- No RPC and no edge-function change introduced by this fix.
- `createInventoryItem` (`db.ts:288-382`) unchanged: its link upsert at
  `db.ts:370` still marks `is_primary: l.vendorId === vendorId` against the
  single scalar with NO demote pre-step — correct and safe, since a freshly
  created item has zero pre-existing `item_vendors` rows (design §createInventoryItem).
  The only new `is_primary: false` demote in the file is at `db.ts:501` inside
  `updateInventoryItem`.

### (5) Jest ordering test matches the named track — MATCHES
`src/lib/db.updateInventoryItemPrimarySwitch.test.ts` is the file named in the
design's Test-surface / Files-changed sections. It covers, per the design:
- demote-before-upsert on a primary switch (`toBeLessThan(upsertIdx)`, lines 74-88)
- demote filters `item_id`, `is_primary=true`, `vendor_id <> B` (lines 90-108)
- no `updated_at` in the demote payload (lines 110-120)
- `primaryVendorId=null` variant demotes ALL primaries with NO `.neq` (lines 122-139)
- demote error is thrown (optimistic-revert contract, lines 141-159)

The `primaryVendorId=null` case is driven via `vendorId: ''` → `vendorId`
resolves to `null` at `db.ts:444` (`length > 10` check) → `primaryVendorId`
null and, because `updates.vendorId !== undefined`, no fallback SELECT fires.
The test's inline comment (lines 123-124) correctly documents this path. Sound.

## Findings by severity

- Critical: none
- Should-fix: none
- Minor: none

## Notes (non-blocking, no action required)

- The accepted non-atomic 3-call window (demote → upsert → delete without a
  wrapping transaction) is present as designed and was explicitly accepted for
  v1 under the Option-1 decision. Not drift. The Option-2 RPC remains the
  documented escape hatch if it ever bites.
- Realtime publication gotcha correctly does NOT apply — no migration, no
  `supabase_realtime` membership change, so no `docker restart
  supabase_realtime_imr-inventory` step is needed.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 findings by severity — the
  implementation matches the design on all five checked points (pre-demote shape
  and placement, demote→upsert→delete ordering, no updated_at, no
  migration/RPC/edge and createInventoryItem untouched, named jest ordering test).
payload_paths:
  - specs/124-primary-vendor-switch-duplicate-key/reviews/backend-architect.md
