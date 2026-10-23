# Spec 173: Surface failed catalog-field saves in `updateInventoryItem`

Status: READY_FOR_REVIEW

Origin: deferred from spec 171. It was raised as architect OQ-B, and the 171 security auditor and the backend-architect drift review (M2) flagged it too. The bug affects **every** catalog-level field, not only `eod_count_mode`. The dispatching session recorded the decisions below on the owner's behalf (owner: plan first, stage-not-commit). They are resolved, not open.

## User story

As a **store manager editing an ingredient** (name, unit, category, case qty, sub-unit, translations, or EOD count mode), I want a failed save to visibly fail and roll back, so I don't walk away believing a brand-wide catalog change landed when it didn't.

## Current state (verified 2026-10-23, `main` at `f7b2759`)

- [`updateInventoryItem`, src/lib/db.ts:447-596](../src/lib/db.ts) builds `catalogUpdates` from `name`, `unit`, `category`, `caseQty`, `subUnitSize`, `subUnitUnit`, `i18nNames`, and `eodCountMode` (L471-484). When any are present, it does three things:
  - L488-494: looks up `inventory_items.select('catalog_id').eq('id', id).single()`. It **ignores `error`**.
  - L495: `if (catalogId)`. A missing `catalog_id` **silently skips** the catalog write.
  - L496-500: runs `catalog_ingredients.update(catalogUpdates).eq('id', catalogId)`. It **ignores the result**: no `error` check and no affected-row check.
- The per-store write (L517-524) and every `item_vendors` write (L567-593) in the same function already `if (error) throw error`.
- The catalog block runs **first**, before the per-store and `item_vendors` writes.
- [`updateItem`, src/store/useStore.ts:2277-2329](../src/store/useStore.ts) applies the optimistic patch first. If `db.updateInventoryItem` rejects, it restores the `prev` snapshot in `inventory` and calls `notifyBackendError('Update item', e)` (L2311-2316). It is the only production caller. It never sees a rejection for catalog failures, so the optimistic value sticks until the next refresh or realtime reload.
- **PostgREST + RLS:** an UPDATE whose target row is filtered out by RLS returns `error: null` with 0 affected rows. Checking `error` alone does not catch an RLS denial.

## Acceptance criteria

All criteria are tested with jest. The db-level tests mock the supabase builder, following the existing `src/lib/db.eodCountMode.test.ts` harness.

### db-level: `updateInventoryItem` rejects on every catalog failure mode

Each of the following calls gets a payload that includes at least one catalog field. In each one, the promise **rejects**:

- [ ] **AC-1 (lookup error):** the `inventory_items.select('catalog_id')…single()` lookup returns a non-null `error`.
- [ ] **AC-2 (missing catalog_id):** the lookup returns no error, but `data` is null or `data.catalog_id` is null or undefined.
- [ ] **AC-3 (update error):** the `catalog_ingredients` UPDATE returns a non-null `error`, for example a CHECK violation `23514`.
- [ ] **AC-4 (0-row update):** the `catalog_ingredients` UPDATE returns `error: null` but affects 0 rows, which is the RLS-denial shape. The architect picks the detection mechanism, for example chaining `.select('id')` and treating an empty returned array as failure.
- [ ] **AC-5 (no half-write):** in each of AC-1 through AC-4, with a payload that also carries per-store fields (for example `parLevel`) and a `vendors[]` array, the mock op log shows **no** `inventory_items` UPDATE and **no** `item_vendors` upsert, update, or delete after the failure.
- [ ] **AC-6 (rejection carries context):** the rejected value is an `Error` or a PostgREST error object. `notifyBackendError` can render it, so `e.message` is a non-empty string. For AC-1 and AC-3, the original supabase error is propagated or wrapped with its message intact.

### db-level: happy path and non-catalog edits unchanged

- [ ] **AC-7:** a catalog UPDATE that affects 1 row resolves. The per-store and `item_vendors` writes then proceed exactly as today, in the same order.
- [ ] **AC-8:** a payload with **no** catalog fields (for example `{ parLevel: 5 }`, or `vendors[]` only) issues no `catalog_id` lookup and no `catalog_ingredients` UPDATE, the same as today. It cannot reject for catalog reasons.
- [ ] **AC-9:** `src/lib/db.eodCountMode.test.ts` and `src/lib/db.updateInventoryItemPrimarySwitch.test.ts` pass. Their assertions stay unchanged. Their mocks may change **only** if the new 0-row check requires it, for example by making the catalog UPDATE mock return one row.

### Store-level: `updateItem` reverts and toasts

- [ ] **AC-10:** with `db.updateInventoryItem` mocked to reject (simulating any of AC-1 through AC-4), calling `useStore.getState().updateItem(id, { name: 'New' })` has these effects:
  - (a) the item in `inventory` first shows the optimistic value;
  - (b) after the rejection settles, the item in `inventory` deep-equals its pre-edit snapshot;
  - (c) `notifyBackendError` is called once with `'Update item'` and the rejection.

  No new UI and no new copy.

### Gates

- [ ] **AC-11:** full `npx jest`, `npm run typecheck`, and `npm run typecheck:test` are green. The changes are **staged, not committed**. The owner commits.

## In scope

- `src/lib/db.ts` `updateInventoryItem`, catalog block only (L485-502): check the lookup error, throw on a missing `catalog_id`, check the UPDATE error, and detect a 0-row UPDATE. Each throws before the per-store and `item_vendors` writes.
- New jest coverage for AC-1 through AC-8 and AC-10. File names are the architect's call, for example `src/lib/db.updateInventoryItemCatalogErrors.test.ts` plus a store-level test.
- Minimal mock adjustments to the two existing db tests, only if AC-4's mechanism needs them (AC-9).

## Out of scope (explicitly)

These are follow-ups, each with a one-line rationale:

- **Reverse partial write.** If the catalog write succeeds and a later per-store or `item_vendors` write fails, the store reverts the whole item. For that moment the UI shows the old catalog values even though the brand-wide catalog change landed. It corrects on the next refresh. Fixing this needs either a split revert or a transactional RPC, which is a larger design.
- **Other unchecked writes in db.ts.** That includes the `vendor_id` lookup at L549-555 in this same function. Sweeping them is a separate audit.
- **Any DB, migration, RLS, or policy change.** This spec is client-side error handling only. pgTAP is not involved.
- **New UI, toast copy, or i18n.** The existing `notifyBackendError('Update item', e)` toast is the surface.
- **The `id.length < 10` early return** at L465. It is a pre-existing silent no-op on a separate path.
- **`app.json` slug.** Not touched.

## Open questions resolved

These were decided by the dispatching session on the owner's behalf on 2026-10-23.

- Q: Which catalog failures should throw? → A: All four throw from `updateInventoryItem`: lookup error, missing `catalog_id`, UPDATE error, and 0-row UPDATE. The store then reverts the item to its pre-edit snapshot and shows the existing toast. There is no new UI and no copy beyond what `notifyBackendError` already shows.
- Q: How does an RLS denial get caught, given PostgREST returns no error? → A: Treat a 0-row catalog UPDATE as a failure. The architect picks the mechanism (for example `.select('id')` and check the returned rows).
- Q: Ordering and half-writes? → A: The catalog write stays first. A catalog failure throws **before** any per-store or `item_vendors` write, so nothing is half-written on that path.
- Q: What else is in scope? → A: Not the reverse partial case, other unchecked db.ts writes, or any DB / migration / RLS change. Only `src/lib/db.ts` and jest change.
- Q: Which tests? → A: jest only. At the db level: each failure mode rejects, no per-store write follows a catalog failure, and the happy path is unchanged, with the two existing db tests kept green. At the store level: a failed update reverts `inventory` and calls `notifyBackendError`.
- Q: What counts as done? → A: The failure is surfaced and reverted; full `npx jest`, `npm run typecheck`, and `npm run typecheck:test` are green; and the changes are staged for the owner to commit.

## Notes for architect (non-blocking)

- **N1. Abort signal.** The catalog calls carry `.abortSignal(signal)`. If the inflight tracker aborts mid-request, the new error check will turn that into a rejection, and so a revert and a toast. The per-store write already behaves this way, so this is probably acceptable. Confirm how `useInflight.track` handles an aborted write and whether an abort should be special-cased.
- **N2. 0-row versus RLS-visible-but-unchanged.** PostgREST counts a matched row as affected even when the values don't change. So `.select('id')` returns 1 row for a no-op edit, and only RLS filtering or a deleted catalog row gives 0.
- **N3. `.single()` on the lookup.** `.single()` already returns an error (`PGRST116`) when 0 rows match, so in practice AC-1 covers an RLS-hidden `inventory_items` row. AC-2 covers a visible row with a null `catalog_id`.

## Dependencies

- Spec 040 P3 (`i18n_names` on the catalog), spec 102 / 124 (`item_vendors` reconcile ordering), and spec 171 (`eod_count_mode` and the existing `db.eodCountMode.test.ts` harness).
- No migrations, no edge functions, and no local stack needed.

## Project-specific notes

- **Cmd UI section / legacy:** none directly. The fix is in `src/lib/db.ts`, and the behavior surfaces through the existing ingredient editor (`IngredientFormDrawer` / `InventoryCatalogMode`) by way of `useStore.updateItem`.
- **Per-store or admin-global:** the catalog fields are brand-global (`catalog_ingredients`), and the per-store fields stay store-scoped. RLS is unchanged; this spec only stops ignoring its denials.
- **Realtime channels touched:** none. `brand-{id}` and `store-{id}` reloads are unchanged.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** both. This is shared data-layer code.
- **Test tracks:** jest only, with db-level and store-level tests. No pgTAP and no shell smoke.

## Backend design

Scope: `src/lib/db.ts` `updateInventoryItem` catalog block (L485-502) plus jest. **No migrations, no RLS or policy changes, no edge functions, no realtime changes, no `useStore.ts` changes, and no signature change.** The `updateInventoryItem(id, updates): Promise<void>` contract is unchanged except that it now rejects in four more cases.

### D1. Throw conditions and order (inside `if (Object.keys(catalogUpdates).length > 0)`)

Each step runs only if the previous one passed. All four throw **before** the per-store `inventory_items` UPDATE (L517) and before any `item_vendors` op (L537+), which gives AC-5.

1. **Lookup error (AC-1).** Destructure `{ data: row, error: lookupError }` from the existing `inventory_items.select('catalog_id').eq('id', id).abortSignal(signal).single()`. If `lookupError` is set, `throw lookupError` raw, the same as every other check in this function (`if (error) throw error`). This check must come **before** the catalog_id check, because `data` is null whenever there is an error.
2. **Missing catalog_id (AC-2).** If `row?.catalog_id` is falsy, throw a synthesized `Error` (D3). This replaces the silent `if (catalogId)` skip. The UPDATE is no longer conditional.
3. **UPDATE error (AC-3).** Destructure `{ data: updated, error: updateError }` from the catalog UPDATE (D2). If `updateError` is set, `throw updateError` raw. A CHECK violation keeps `code: '23514'` and its `message`.
4. **0-row UPDATE (AC-4).** If `!updated || updated.length === 0`, throw a synthesized `Error` (D3).

### D2. How to detect a 0-row UPDATE

Add `.select('id')` to the existing chain:

```
supabase.from('catalog_ingredients')
  .update(catalogUpdates)
  .eq('id', catalogId)
  .select('id')
  .abortSignal(signal)
```

This asks PostgREST for `Prefer: return=representation` and returns `data: { id }[]`. An RLS-filtered row returns `[]` with `error: null`, which D1 step 4 catches. I chose this over two alternatives:
- `.select('id').single()`. It turns 0 rows into a `PGRST116` error, but the message ("JSON object requested, multiple (or no) rows returned") would show up in the toast and is not useful.
- `{ count: 'exact' }`. It adds a count header for no benefit.

Payload cost is one `id` per edit, which is negligible.

### D3. Error shape for the synthesized cases

Throw plain `Error` instances. `notifyBackendError` renders `e?.message` as `text2` under `text1: 'Update item failed'`, so the messages must make sense on their own. Exact strings, so tests can pin them:

- AC-2: `new Error('Catalog change not saved: this ingredient has no catalog link.')`
- AC-4: `new Error('Catalog change not saved: no permission to edit this catalog ingredient, or it no longer exists.')`

Do not add a custom error class. Nothing branches on the type, and `InflightTimeoutError` is the only typed error in this path, which is intentional. The raw PostgREST errors from AC-1 and AC-3 already carry a non-empty `message`, which satisfies AC-6.

### D4. Decisions on notes N1-N3

- **N1 (abort): no special case.** `useInflight.track` (src/lib/inflight.ts:130-149) already turns any rejection after its own 30s abort into `InflightTimeoutError`, whose write copy is "Request timed out — the change may or may not have been saved. Refresh to verify." That is the correct message for an aborted catalog write. The new checks only make the catalog path behave the same as the per-store path already does. Nothing else aborts the signal (`track` builds the controller internally), so a "user-cancelled" case that would need silencing does not exist.
- **N2 (no-op edit): confirmed, nothing to do.** PostgREST returns the matched row even when the values don't change, and the `updated_at` bump means a real write happens anyway. So a no-op edit returns 1 row and resolves. Only an RLS-filtered or deleted catalog row returns 0.
- **N3 (`.single()` + PGRST116): keep `.single()` and throw PGRST116 raw through D1 step 1.** An RLS-hidden or deleted `inventory_items` row therefore surfaces as AC-1 with PostgREST's own message. That message is not friendly, but the state is rare and the brief is no new copy. Do **not** switch to `.maybeSingle()`: that would move this case into AC-2's message, which wrongly claims the item has no catalog link. AC-2 is only for a visible row whose `catalog_id` is null.

### D5. Existing test mocks (AC-9)

- **`src/lib/db.eodCountMode.test.ts`: needs one change.** The builder's `then` falls back to `{ data: [], error: null }` for `catalog_ingredients`, which D1 step 4 now reads as a 0-row failure. The first three `updateInventoryItem` tests would reject. Fix: in the `describe('updateInventoryItem — …')` `beforeEach` (L149-151), add `tableResults.catalog_ingredients = { data: [{ id: CATALOG_ID }], error: null };`. All assertions stay unchanged. The new `select` op on `catalog_ingredients` is logged, but every assertion filters on `op === 'update'` or matches `eq` exactly, so the extra op doesn't affect them.
- **`src/lib/db.updateInventoryItemPrimarySwitch.test.ts`: no change.** None of its payloads carry a catalog field, so it never enters the catalog block.
- No other callers or tests of `updateInventoryItem` exist. `useStore.ts:2311` is the only production caller.

### D6. Test file plan

**`src/lib/db.updateInventoryItem.catalogErrors.spec173.test.ts`** (db-level). Copy the thenable `makeBuilder` / `opLog` / `tableResults` / `singleResults` harness from `db.eodCountMode.test.ts`, along with its `./supabase`, `./inflight`, and `./auth` mocks.
- AC-1: `singleResults.inventory_items = { data: null, error: { code: 'PGRST116', message: '…' } }`. Expect `rejects.toMatchObject({ code: 'PGRST116' })` and no `catalog_ingredients` op at all.
- AC-2: run twice (`data: null` and `data: { catalog_id: null }`). Expect `rejects.toThrow(<D3 AC-2 string>)` and no `catalog_ingredients` UPDATE.
- AC-3: `tableResults.catalog_ingredients = { data: null, error: { code: '23514', message: 'violates check constraint' } }`. Expect `rejects.toMatchObject({ code: '23514', message: … })`.
- AC-4: `tableResults.catalog_ingredients = { data: [], error: null }`. Expect `rejects.toThrow(<D3 AC-4 string>)`. Also assert that `select('id')` was chained on `catalog_ingredients`.
- AC-5: a parametrized loop over AC-1 through AC-4 with payload `{ name: 'X', parLevel: 5, vendorId: B, vendors: [{ vendorId: B }] }`. After the rejection, assert that `opLog` has no `inventory_items` `update` op and no `item_vendors` op of any kind.
- AC-6: in each case, `e.message` is a non-empty string.
- AC-7: catalog returns `[{ id }]` with the same mixed payload. It resolves. Assert op order: catalog `update` index < `inventory_items` `update` index < first `item_vendors` op index.
- AC-8: `{ parLevel: 5 }` and `{ vendors: [{ vendorId: B }] }` produce no `select('catalog_id')` and no `catalog_ingredients` op, even with `singleResults.inventory_items` set to an error. Use a payload that does not trigger the L549 `vendor_id` lookup for the error variant, or give `vendorId` explicitly.

**`src/store/useStore.updateItem.catalogRevert.spec173.test.ts`** (store-level). Copy the harness from `src/store/useStore.updateStore.test.ts`: mock `react-native-toast-message`, `../lib/supabase`, `../lib/auth`, and `../lib/db`. `db.updateInventoryItem` gets a rejecting `jest.fn()` that returns a controllable deferred. `db.addAuditEvent` resolves, because `updateItem` fires an audit event unconditionally. Seed `inventory` with one item, call `updateItem(id, { name: 'New' })`, and assert:
- (a) synchronously, the item's `name` is `'New'`;
- (b) after the deferred rejects and microtasks flush, the item `toEqual`s the pre-edit snapshot;
- (c) `Toast.show` was called exactly once with `objectContaining({ type: 'error', text1: 'Update item failed', text2: <rejection.message> })`. `notifyBackendError` is module-local in `useStore.ts:54`, so it can't be spied on directly. The mocked `Toast.show` is how the other store tests observe it.

Run the test once with a PostgREST-shaped rejection and once with an `Error`.

### D7. Risks

- **Behavior change for non-privileged editors (intended, but call it out).** The `catalog_ingredients` UPDATE policy requires `auth_is_privileged() AND auth_can_see_brand(brand_id)` (`20260509000000_multi_brand_schema_rls.sql:458`). Any Cmd-UI user who edits a catalog field without that grant has been failing silently. After this change they get a toast and a revert on every such edit. This is what the spec asks for, but the owner should expect reports of "my edit now errors" from those users.
- **Mixed payloads are now all-or-nothing on the catalog side.** If an edit combines a catalog field with per-store fields and the catalog write fails, the per-store fields are not written either, and the whole item reverts. Today the per-store part would have landed. This matches AC-5 and the spec's "no half-write" decision. The reverse partial case stays out of scope.
- **Audit event still fires on failure.** `updateItem` logs `'Item edit'` before the promise settles (useStore.ts:2317). This is pre-existing, out of scope, and not changed here.
- No performance, realtime, cold-start, or migration-ordering impact.

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec (## Backend design, D1-D6). Change only the catalog block of `updateInventoryItem` in src/lib/db.ts. Make the one-line mock change in src/lib/db.eodCountMode.test.ts. Add the two spec173 test files. Run full `npx jest`, `npm run typecheck`, and `npm run typecheck:test`. Stage, do not commit. Then set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/173-catalog-update-error-surfacing.md

## Files changed

### src/lib/db.ts
- `src/lib/db.ts` — `updateInventoryItem` catalog block only (D1-D3): throw the lookup error raw; throw the D3 "no catalog link" `Error` on a missing `catalog_id`; chain `.select('id')` on the catalog UPDATE, throw its error raw, and throw the D3 "no permission / no longer exists" `Error` on 0 returned rows. All four throw before the per-store and `item_vendors` writes.

### Tests (jest)
- `src/lib/db.eodCountMode.test.ts` — D5 one-line mock addition (`tableResults.catalog_ingredients = { data: [{ id: CATALOG_ID }], error: null }` in the `updateInventoryItem` describe `beforeEach`). No assertion changes.
- `src/lib/db.updateInventoryItem.catalogErrors.spec173.test.ts` — new; AC-1 through AC-8.
- `src/store/useStore.updateItem.catalogRevert.spec173.test.ts` — new; AC-10 (PostgREST-shaped and `Error` rejections).

### Spec
- `specs/173-catalog-update-error-surfacing.md` — Status flipped to READY_FOR_REVIEW; this list.

Verification: full `npx jest` 257 suites / 3194 tests passed; `npm run typecheck` and `npm run typecheck:test` clean. `src/lib/db.updateInventoryItemPrimarySwitch.test.ts` passes unchanged (no catalog fields in its payloads). No other test reaches the real `updateInventoryItem` / `updateItem` with catalog fields (the component tests mock `updateItem` on the store).

