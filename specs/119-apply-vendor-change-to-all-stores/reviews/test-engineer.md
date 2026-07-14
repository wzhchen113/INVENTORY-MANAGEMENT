## Test report for spec 119

### Acceptance criteria status

- AC1: Ingredient editor shows a SEPARATE, explicit "Apply vendors to all
  stores" action in the VENDORS section, distinct from Save; brand-wide
  propagation is always a deliberate button press, never a Save side effect
  → **NOT TESTED**. Code review confirms the button only renders when the host
  passes `onApplyToAllStores` (EDIT mode + `item?.catalogId` truthy —
  `src/components/cmd/IngredientFormDrawer.tsx:467,481`) and is a distinct
  element from the Save button (`src/components/cmd/IngredientForm.tsx:1305-1325`).
  No jest test renders `IngredientForm`/`IngredientFormDrawer` and asserts the
  button exists, is EDIT-only, or that pressing it does not touch Save's path.
  The spec's own "Project-specific notes → Tests" line commits to "jest for the
  editor's action wiring" for this feature specifically — that commitment is
  unmet.
- AC2: A normal Save continues to call the existing per-store path
  (`db.updateInventoryItem`) unchanged; the new action does not alter Save
  → **PASS (by inspection + non-regression), no dedicated pinning test.**
  `handleSave` in `IngredientFormDrawer.tsx` is untouched by this diff (only a
  new sibling `handleApplyVendorsToAllStores` was added). The pure payload
  builder both paths share, `vendorRowsToLinkPayload`, has extensive existing
  jest coverage (`src/components/cmd/IngredientForm.test.ts:472-651`,
  pre-dating this spec) and all of it still passes. Full jest (1184 tests) and
  both typechecks are green, so no known assertion pins a Save regression.
  There is no dedicated "Save still calls db.updateInventoryItem and not the
  new RPC" jest test, but risk is low: the diff is additive-only at the code
  level (new function/prop, no edit to `handleSave`).
- AC3: The action propagates the full submitted `item_vendors` link set
  (attach/detach, primary, `order_code`) from the current store's item to the
  SAME catalog ingredient's row in EVERY visible store of the CURRENT brand,
  including the current store → **PASS** —
  `supabase/tests/apply_item_vendors_to_brand.test.sql` (3) `updated_count = 2`
  (Towson + Charles, the two stores with a row), (6)-(10) primary repoint +
  scalar mirror on both stores.
- AC4: Propagation is scoped to the current brand only (never cross-brand);
  `auth_can_see_store()` is respected — a store the caller cannot see is not
  modified → **PASS for the cross-brand case**; assertions (1) `throws_ok
  'brand not accessible'` for a foreign-brand catalog, (17)/(18) brand-B's
  link/price is completely untouched by the call against brand A's catalog.
  **Caveat (not a gap in the tests, a fact about the permission model):** the
  test suite cannot exercise "a privileged caller who can see the brand but not
  one specific store in it," because `auth_can_see_store()` short-circuits true
  for both `admin` and `super_admin` (the only two roles that pass
  `auth_is_privileged()` and can call this RPC at all —
  `20260509000000_multi_brand_schema_rls.sql:216-227`). That intra-brand
  per-store-denial branch is genuinely unreachable for any caller who can pass
  the RPC's own auth gate today, so its absence from the pgTAP file is not a
  coverage gap — it mirrors what the RPC comment and the backend-architect's
  design already state ("belt-and-suspenders... even though a brand-admin sees
  all their own-brand stores today").
- AC5: After the action, each target store's item has exactly the submitted
  vendor SET — de-selected links removed, newly attached links created →
  **PASS** — assertion (16) Towson has exactly 2 links after the fan-out (the
  pre-seeded de-selected V3 link is gone) and (13) the new V2 link exists.
  Minor, non-blocking note: the empty-array ("remove every link") edge case
  named explicitly in the RPC's design comment is not given its own pgTAP
  assertion; it exercises the same generic `not (vendor_id = any(v_submitted))`
  delete path already proven by the V3 removal, so I do not treat this as a
  material gap.
- AC6: Per-store pricing preserved for already-linked vendors (own
  `cost_per_unit`/`case_price` unchanged); a NEW link is seeded from the
  current store's submitted values → **PASS** — assertions (11)/(12) Towson
  and Charles both keep their pre-existing V1 price (5.00 / 7.00) despite a
  submitted 99.00, and (13) the new V2 link on Towson is seeded from the
  submitted 20.00.
- AC7: Order codes (spec 114) propagate to every target store's corresponding
  link, for both preserved and newly-seeded links → **PASS** — assertions
  (14) Towson's preserved V1 link gets the propagated `OC-1` and (15)
  Charles's newly-seeded V2 link gets `OC-2`.
- AC8: `is_primary` and the legacy scalar `inventory_items.vendor_id` stay
  mirrored on EVERY target store to the submitted primary → **PASS** —
  assertions (6)-(8) (`is_primary` on Towson + Charles) and (9)-(10) (scalar
  mirror on both stores).
- AC9: v1 targets ONLY stores where the catalog ingredient already has an
  `inventory_items` row; missing rows are not created, and are counted/reported
  as skipped → **PASS** — assertions (4)/(5) `skipped_count = 2` and
  `skipped_store_ids` contains Frederick + Reisters. Also verified by code
  read: the function body contains no `insert into public.inventory_items`
  statement anywhere, so it is structurally incapable of creating the row —
  the only path to satisfy a skipped store is to leave it skipped.
- AC10: The action reports how many stores were updated AND how many were
  skipped; partial failure surfaces via `notifyBackendError` rather than
  silently succeeding → **PARTIAL — PASS at the RPC layer, NOT TESTED at the
  frontend layer.** The RPC's `{updated_count, skipped_count,
  skipped_store_ids}` return shape is pinned by pgTAP (3)-(5). But nothing in
  jest exercises `useStore.applyVendorsToAllStores`'s two branches: (a)
  success → resolves the summary and the drawer's `Toast.show` fires with
  `applyVendorsSuccessDetail`; (b) `db.applyItemVendorsToBrand` rejects →
  `notifyBackendError('Apply vendors to all stores', e)` fires and the action
  resolves `null` (no throw, no silent success). This is the same category of
  gap as AC1 and is exactly the shape of test `useStore.test.ts` already runs
  for sibling actions (e.g. the `deleteProfile` success/error-toast pin at
  `src/store/useStore.test.ts:145-239`) — the pattern to close this gap
  already exists in-repo, it just wasn't applied to this new action.
- AC11: Other admin clients viewing an affected store see the change without a
  manual reload, because each affected `item_vendors` row lands on that
  store's `store-{id}` realtime channel → **NOT TESTED** (no automated test in
  this repo exercises live realtime propagation for any feature — this is a
  pre-existing test-infrastructure gap, not new to spec 119). Verified instead
  by inspection: `item_vendors` is confirmed present in the local
  `supabase_realtime` publication (`select tablename from
  pg_publication_tables where pubname='supabase_realtime' and
  tablename='item_vendors'` → 1 row), and this migration adds a function only
  — it does not touch publication membership, so the spec's own claim that "no
  docker restart is needed" is correct and does not need re-verification here.

### Test run

**pgTAP — the new file, isolated:**
```
bash scripts/test-db.sh supabase/tests/apply_item_vendors_to_brand.test.sql
  PASS supabase/tests/apply_item_vendors_to_brand.test.sql (19 assertion(s) passed)
✓ 1/1 DB test file(s) passed
```
All 19 assertions pass, matching `select plan(19)`.

**pgTAP — full suite:**
```
npm run test:db
✗ 1/66 DB test file(s) failed
```
One pre-existing, unrelated file failed: `supabase/tests/item_vendors_rls.test.sql`
(spec 114), assertion (12) "non-member UPDATE cannot write order_code on a
Charles link (stays NULL — RLS regression pin)" — `have: 8302192, want: NULL`.
Root cause (confirmed): this test's fixture picks "the first `inventory_items`
row for Charles" + "the first vendor by id" via unqualified `limit 1`/`order
by id limit 1`, and asserts the pair's `order_code` starts NULL. On the
currently-running LOCAL dev Postgres container, that specific real Charles
item/vendor combination already carries a real `order_code` (`8302192`) —
almost certainly written by earlier manual exercising of the spec 116/117
CSV-export features against this same long-lived local container, not by
`seed.sql` (grep confirms `order_code` does not appear in `seed.sql` at all)
and not by any migration (no migration bulk-writes `order_code`). This is
**local-container staleness, not a spec 119 regression**: spec 119's own
migration/RPC never writes to real Charles seed data (its test uses a
freshly-inserted, uniquely-named catalog ingredient inside its own
`begin/rollback` txn), and CI runs a fresh `supabase start` per job
(`.github/workflows/test.yml`), so this would not reproduce there. Confirmed
deterministic (failed identically 3/3 re-runs) — not a race/flake. Flagging
this for the record since it was discovered while verifying spec 119, but it
is out of scope for this spec's fix and does not block spec 119 on its own
merits.

**jest — i18n parity:**
```
npx jest i18n.test
PASS unit src/i18n/i18n.test.ts
PASS unit src/screens/staff/i18n/i18n.test.ts
Tests: 24 passed, 24 total
```
`section.inventory.applyVendors*` keys confirmed present with matching key
sets in `en.json`, `es.json`, `zh-CN.json` (button label, help text, confirm
title/body/cta, success title + `{updated}`/`{skipped}` detail).

**jest — full suite:**
```
npx jest
Test Suites: 102 passed, 102 total
Tests:       1184 passed, 1184 total
```
Matches the frontend track's own reported count. Zero of these 1184 tests
reference `applyVendorsToAllStores`, `applyItemVendorsToBrand`, or
`onApplyToAllStores` (confirmed by grep across `src/**/*.test.*`) — the action
and the button are exercised by neither a store-level nor a component-level
test.

**Typechecks:**
```
npx tsc --noEmit                        → clean
npx tsc -p tsconfig.test.json --noEmit  → clean
```

### Notes

- **Framework:** no new framework introduced. pgTAP, jest, and the pre-existing
  (spec 078, unrelated to 119) Playwright `e2e` scripts in `package.json` are
  untouched; I did not run Playwright since it is outside this spec's declared
  test scope and outside this review's instructions.
- **The RPC is the risky surface, and it is well covered.** All 8 backend-shape
  ACs (3-9, plus the auth/cross-brand half of 4) that are actually reachable
  given the current privilege model are PASS via 19 pgTAP assertions,
  including the one genuinely tricky correctness trap the architect flagged
  (primary re-point across the `item_vendors_one_primary_per_item` partial
  unique index — assertions 6-10 exercise exactly that repoint). I do not
  consider the RPC under-tested.
- **The frontend gap is real but not high-risk enough to BLOCK on its own.**
  AC1 and the frontend half of AC10 (button render/wiring, toast summary,
  notifyBackendError-on-failure for the new store action) have zero automated
  coverage, despite the spec's own test-scope note committing to "jest for the
  editor's action wiring." This is a genuine, closable gap — the exact pattern
  needed already exists in `useStore.test.ts` for sibling actions
  (`jest.mock('../lib/db', ...)` + assert `notifyBackendError` called on
  reject / summary resolved on success) and could be added quickly. I am
  **not** blocking release on this alone because: (a) the RPC — the
  higher-risk, data-mutating surface — is thoroughly pgTAP-covered; (b) the
  failure mode of an untested button is "button doesn't render/wire" which is
  visually obvious in any manual QA pass and does not risk silent data
  corruption the way an under-tested RPC would; (c) TypeScript's strict mode
  (clean on both typecheck gates) already catches prop-signature mismatches
  between `IngredientForm` and `IngredientFormDrawer`. I recommend closing this
  gap before the next release touching this surface, but treat it as a
  **should-fix**, not a ship-blocker, given the RPC-side coverage.
- **AC11 (realtime) is unverifiable by any existing automated test in this
  repo** — there is no realtime-integration test harness for any feature, not
  just this one. Verified instead by direct inspection that `item_vendors` is
  in the local `supabase_realtime` publication and that this migration doesn't
  touch publication membership. Consistent with the project's known gaps
  section in `CLAUDE.md`; not a spec-119-specific regression.
- **Discovered, unrelated pre-existing pgTAP failure:** `npm run test:db` (the
  full suite) currently reports 1/66 files failing —
  `supabase/tests/item_vendors_rls.test.sql` assertion (12) — due to local dev
  container data drift (see Test run section above). This is not caused by
  spec 119 and would not reproduce in CI's fresh-`supabase start` runs, but it
  means a bare `npm run test:db` on this machine right now shows a failure
  that has nothing to do with this spec. Surfacing so the release-coordinator
  doesn't misattribute it, and so someone eventually re-seeds/rewrites that
  fixture to not depend on unqualified `limit 1` picks over live local data.
- **Migration/prod-apply status not verified by me.** The spec's migration
  file `20260714000000_apply_item_vendors_to_brand.sql` exists locally and the
  function is present in the local container (confirmed), but whether it has
  been applied to prod via the MCP process (required before the
  `db-migrations-applied.yml` gate goes green) is outside this review's scope
  — flagging for the release-coordinator to confirm via `gh run list` per the
  CLAUDE.md CI-status-check rule before recommending SHIP_READY.

