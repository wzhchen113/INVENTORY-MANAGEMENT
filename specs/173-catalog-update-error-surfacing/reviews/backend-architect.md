# Spec 173: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Date: 2026-10-23
Scope: the staged implementation compared against `## Backend design` D1-D7 in `specs/173-catalog-update-error-surfacing.md`.

Files reviewed:
- `src/lib/db.ts`: `updateInventoryItem`, L447-611. The catalog block is L485-517.
- `src/lib/db.updateInventoryItem.catalogErrors.spec173.test.ts` (new)
- `src/store/useStore.updateItem.catalogRevert.spec173.test.ts` (new)
- `src/lib/db.eodCountMode.test.ts` (the D5 mock line)
- Context: `src/store/useStore.ts:54-63` and `2277-2329`, `src/lib/inflight.ts:130-149`, `src/components/cmd/IngredientFormDrawer.tsx:144-172`, `src/lib/csvImport.ts:465-482`, `src/lib/authGate.ts:66`, and the `catalog_ingredients` policies in `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:446-465`.

## Verdict

No contract drift. The implementation matches D1-D6 line for line. There are no Critical findings. One Should-fix is a gap in the design's own risk statement (D7), not a developer error, and it needs no code change in this spec. Three Minor items follow.

## Design conformance (verified)

| Design item | Result | Evidence |
|---|---|---|
| D1.1: lookup error thrown raw, checked before catalog_id | Match | db.ts:493-499. Destructures `{ data: row, error: lookupError }` and runs `if (lookupError) throw lookupError;` before reading `row`. |
| D1.2: missing catalog_id throws; the silent `if (catalogId)` skip is gone | Match | db.ts:500-503. The UPDATE is now unconditional. |
| D1.3: UPDATE error thrown raw | Match | db.ts:507-513 |
| D1.4: 0-row (or null) UPDATE throws | Match | db.ts:514-516, `!updated \|\| updated.length === 0` |
| D1: all throws run before the per-store UPDATE and `item_vendors` | Match | The catalog block closes at L517. The per-store UPDATE starts at L532 and `item_vendors` at L552. |
| D2: `.update().eq().select('id').abortSignal(signal)` | Match | db.ts:507-512 uses the exact chain. It does not use `.single()` or `count: 'exact'`. |
| D2 (RLS soundness of `return=representation`) | OK | `UPDATE ... RETURNING` needs the SELECT policy to pass on returned rows. `brand_member_read_catalog_ingredients` (`auth_can_see_brand(brand_id)`, migration L446-448) is a superset of the UPDATE USING clause (`auth_is_privileged() AND auth_can_see_brand(brand_id)`, L457-462). An authorized writer therefore never gets a 42501 from the RETURNING step, and a denied writer gets `[]`, as designed. |
| D3: exact error strings | Match, byte-identical | db.ts:502 and db.ts:515 match D3. The tests pin both strings (spec173 test L69-71). |
| D3: no custom error class | Match | Both are plain `new Error(...)`. |
| D4/N1: no abort special case | Match | Nothing special-cased. `inflight.ts:138-148` turns any rejection after `ctrl.signal.aborted` into `InflightTimeoutError`, as D4 states. |
| D4/N3: keep `.single()`, no `.maybeSingle()` | Match | db.ts:498. The code comment at L491-492 records the rationale. |
| D5: one-line mock in `db.eodCountMode.test.ts` | Match | L151 adds `tableResults.catalog_ingredients = { data: [{ id: CATALOG_ID }], error: null };` in the describe `beforeEach`. The assertions at L157-182 are consistent with the unmodified spec 171 intent. |
| D5: `db.updateInventoryItemPrimarySwitch.test.ts` untouched | Match | Not in the staged set. Its payloads carry no catalog fields. |
| D6: db-level test file plan | Match | AC-1 (L130-137), AC-2 (L139-147, which adds a third `catalog_id undefined` variant beyond the design), AC-3 (L149-156), AC-4 including the `select('id')` assertion and a `data: null` variant (L158-171), AC-5/AC-6 parametrized over all five failure arrangements with the mixed payload (L173-196), AC-7 op ordering (L200-225), AC-8 with a poisoned lookup and explicit `vendorId` (L227-241). |
| D6: store-level test plan | Match | Harness follows `useStore.updateStore.test.ts`. It uses a controllable deferred, (a) a synchronous optimistic check, (b) `toEqual(pre)`, and (c) `Toast.show` called once with `text1: 'Update item failed'` and `text2: rejection.message`. It runs with both a PostgREST-shaped rejection and an `Error`. It also asserts no toast fires before the rejection, which proves the unconditional audit event does not toast. |
| No `db.ts` bypass | OK | No new `supabase.from`/`rpc` call sites outside `db.ts`. `useStore.ts` is unchanged. |
| Out-of-scope boundaries held | OK | The unchecked `vendor_id` lookup (now db.ts:564-570) and the `id.length < 10` early return (L465) are untouched. No migrations, RLS, edge functions, or realtime changes. |

## Critical

None.

## Should-fix

### S1. D7 understates the blast radius: the ingredient drawer always sends catalog fields (design-side gap, no code change in this spec)

D7 bullets 1-2 frame the behavior change as affecting edits that *touch* a catalog field, with mixed payloads becoming all-or-nothing. However, `IngredientFormDrawer.tsx:144-172` `toUpdates()` **always** sends `name`, `category`, `unit`, `caseQty`, `subUnitSize`, `subUnitUnit`, and `eodCountMode`, whether or not they changed. Every drawer save therefore enters the catalog block (db.ts:485).

Consequence: for any Cmd-UI user who fails `privileged_update_catalog_ingredients`, **every** drawer save now reverts and toasts. That includes par-only, cost-only, and vendor-link-only edits, which previously landed because only the catalog half was silently dropped. This matches AC-5 and the "no half-write" decision, so it is not implementation drift. It is a larger UX change than D7 describes.

Who is exposed: anyone who reaches the Cmd UI has `profiles.role` other than `'user'` (`authGate.ts:66`). `profiles_role_check` allows only `super_admin`, `admin`, `master`, and `user`. `auth_is_admin()` reads only the JWT `app_metadata.role`, while `auth_is_super_admin()` reads `profiles.role`. In practice, the exposed set is therefore:
- `admin`/`master` profiles whose `auth.users.raw_app_meta_data->>'role'` is missing or stale (drift between profile and JWT), and
- any privileged user whose `auth_can_see_brand(brand_id)` is false for the item's catalog row.

Action:
- release-coordinator should carry this into the owner notes in place of D7's milder wording.
- Optional pre-ship sanity check against prod (read-only): list `profiles` with role `admin`/`master` whose `auth.users.raw_app_meta_data->>'role'` is not `admin`/`master`. Zero rows means the exposure is theoretical.
- No change to the staged code.

## Minor

### M1. The CSV import is a second `updateItem` caller with catalog fields, and the design did not list it

D5 says `useStore.ts:2311` is the only production caller of `db.updateInventoryItem`. That is correct at the db layer, but D7 did not list `updateItem`'s own callers. `csvImport.ts:481` calls `ctx.updateItem(op.itemId, { ...op.payload, ... })` per row. The payload is diff-only (`csvImport.ts:312-313`), so only rows whose `name`/`category`/`unit`/`caseQty` changed enter the catalog block.

For such rows after this spec:
- a catalog failure also drops that row's per-store `costPerUnit`/`parLevel` changes;
- each failed row produces its own `console.warn` and toast;
- the importer still counts the row in `updated++` (L482). The fire-and-forget over-count was already there, but it is now reachable through catalog failures as well as per-store ones.

There is no drift and no change for this spec. Candidate follow-up: have the CSV importer await and tally real outcomes.

### M2. The AC-4 test pins that `select('id')` was called, not where it sits in the chain

Spec173 test L162-164 asserts that exactly one `select` op with `['id']` was logged on `catalog_ingredients`. Each `from()` call returns a fresh builder, and the UPDATE is the only `catalog_ingredients` builder, so the call is effectively pinned. Still, a reorder such as `.select('id')` before `.update()` would pass this test. Optional hardening: assert that the `catalog_ingredients` op sequence equals `['update', 'eq', 'select', 'abortSignal']`.

### M3. "Module-local `notifyBackendError`" is inaccurate in the design text and the test header

D6 and the store test's header comment (L10-11) say `notifyBackendError` is module-local. It is `export function notifyBackendError` at `useStore.ts:54`. The test's approach is still correct: `jest.spyOn` on the export cannot intercept the call `updateItem` makes within the same module, so observing through the mocked `Toast.show` is the right choice. This is cosmetic, and nothing needs to change.

## Counts

Critical 0 / Should-fix 1 (a design-side risk statement, no code change) / Minor 3.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix (D7 understates blast radius: IngredientFormDrawer always sends catalog fields, so for any Cmd-UI user failing the catalog UPDATE policy every drawer save now reverts; owner-awareness item, no code change), 3 Minor.
payload_paths:
  - specs/173-catalog-update-error-surfacing/reviews/backend-architect.md
