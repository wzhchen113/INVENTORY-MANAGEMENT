## Test report for spec 122

### Acceptance criteria status

- AC-1 (display fix — drawer seeds from CURRENT store's row, falls back to
  `sel.primary`) → **PASS** —
  `src/screens/cmd/sections/__tests__/InventoryCatalogMode.spec122.test.tsx::"seeds
  the edit drawer from the CURRENT store row, not primary"` and `"falls back to
  primary when the current store has no row for the ingredient"`. Confirmed by
  code read: `InventoryCatalogMode.tsx:759` —
  `item={sel && (sel.rows.find((r) => r.storeId === currentStore.id) ?? sel.primary)}`
  — matches the design byte-for-byte, and `currentStore` is now pulled into the
  main component's scope (`InventoryCatalogMode.tsx:81`).
- AC-2 (repro closed — per-store save no longer mis-targets) → **PASS** — the
  same jest file proves the drawer binds `inv-2` (Charles/current store, par 4)
  instead of `inv-1` (Frederick/primary, par 480) when `currentStore` is
  Charles; `IngredientFormDrawer.spec122.test.tsx` proves `updateItem` is
  called with the bound item's id (the current-store row) on Save. Combined
  with the pgTAP overwrite assertions (below), the full repro path — wrong
  display AND wrong save target — is closed.
- AC-3 (par fans out to every visible brand store, incl. current) → **PASS** —
  `supabase/tests/apply_item_scalars_to_brand.test.sql` (3) `updated_count = 2`
  (Towson + Charles, the only two stores with a row), (6)/(7) `par_level`
  overwritten to 480 on both, including Charles which started at a DIFFERENT
  par (4) — proves overwrite, not a no-op/preserve. Also
  `src/store/useStore.test.ts::"applyScalarsToAllStores (spec 122)"` proves the
  optimistic patch lands on every in-memory row for the catalog.
- AC-4 (fan-out reflected downstream in EVERY store's EOD/reorder screens) →
  **PASS by composition, no new dedicated integration test.** The RPC test
  proves the write lands on each store's own `inventory_items.par_level` row
  (assertions 6/7 above). EOD count and reorder screens read that same column
  from `inventory_items` via pre-existing, **unchanged-by-this-spec** code
  (`src/screens/staff/lib/fetchReorder.ts`, pinned by
  `fetchReorder.test.ts:58` reading `par_level` off the row) — this spec did
  not touch those consumers, so their existing coverage still holds. No new
  test explicitly re-verifies "EOD/reorder screen renders the post-fanout par"
  end-to-end; low risk given the write-side and read-side are each
  independently tested and neither changed by the other.
- AC-5 (current_stock NEVER fans out — the highest-risk AC) → **PASS,
  thoroughly covered on both layers.**
  - SQL: `apply_item_scalars_to_brand.test.sql` seeds Towson (`current_stock
    111`) and Charles (`current_stock 222`, a DIFFERENTLY-seeded live count)
    BEFORE the call, asserts par/cost/case are overwritten, THEN asserts (11)
    Charles `current_stock` still 222 and (12) Towson still 111 — the exact
    pre/post-equality-on-a-differing-value shape this review was asked to
    scrutinize. The RPC also excludes `current_stock` from its parameter list
    entirely (structural guarantee, not just a runtime check) — confirmed by
    reading the migration's `UPDATE` clause (only `par_level`, `cost_per_unit`,
    `case_price`, `updated_at`).
  - Frontend: `IngredientFormDrawer.spec122.test.tsx::"fan-out payload never
    carries current_stock or count-like fields"` asserts the
    `applyScalarsToAllStores` payload keys are exactly
    `['casePrice','costPerUnit','parLevel']`. `useStore.test.ts` asserts
    `current_stock` is untouched on BOTH catalog rows after the optimistic
    fan-out patch. `db.applyItemScalarsToBrand`'s TS signature is also
    structurally incapable of taking a `currentStock` field.
- AC-6 (count-like/physical fields never fan out — `expiry_date`,
  `usage_per_portion`, avg-daily-usage, safety-stock) → **PASS** —
  `apply_item_scalars_to_brand.test.sql` assertion (13) asserts all four
  (`expiry_date`, `usage_per_portion`, `average_daily_usage`, `safety_stock`)
  are byte-identical pre/post on Charles. Structurally excluded from the RPC's
  parameter list, same guarantee as AC-5.
- AC-7 (fan-out field set — par + cost + case_price, nothing else) → **PASS**
  — pgTAP assertions (6)-(10) confirm all three fields overwrite on both
  stores; the `UPDATE` clause names exactly these three columns plus
  `updated_at`. `IngredientFormDrawer.spec122.test.tsx` confirms the frontend
  payload carries exactly these three keys.
- AC-8 (brand-scoped, never cross-brand) → **PASS** — pgTAP (1) `throws_ok
  'brand not accessible'` for a foreign-brand catalog id; (16)/(17) brand-B's
  item is completely untouched (`par_level`/`cost_per_unit` unchanged) after
  the brand-A call.
- AC-9 (only-existing rows; skipped accounting, no row creation) → **PASS** —
  pgTAP (4) `skipped_count = 2`, (5) `skipped_store_ids` contains both
  Frederick and Reisters (the two stores with no row for the fresh catalog
  ingredient). The function body contains no `insert into
  public.inventory_items` anywhere — structurally incapable of creating rows.
- AC-10 (outcome reported; partial failure via `notifyBackendError`, no silent
  success) → **PASS** — pgTAP pins the `{updated_count, skipped_count,
  skipped_store_ids}` return shape (assertions 3-5).
  `useStore.test.ts::"reverts the optimistic patch and surfaces
  notifyBackendError on failure, returning null"` proves the failure branch:
  RPC reject → optimistic rows reverted to snapshot, `Toast.show` (via
  `notifyBackendError`) called, action resolves `null`. This closes the exact
  frontend-layer gap the spec-119 test-engineer report flagged as unmet for
  that spec's sibling action — 122 does not repeat it.
- AC-11 (privileged gate — `auth_is_privileged()` + `auth_can_see_brand()` +
  per-store `auth_can_see_store()`) → **PASS** — pgTAP (0) non-privileged
  `role=user` caller rejected with `'privileged only'` BEFORE any side effect;
  (1) cross-brand rejected with `'brand not accessible'`; per-store
  `auth_can_see_store()` is in the `UPDATE ... WHERE` predicate (confirmed by
  code read) — no dedicated "privileged caller who can't see one specific
  in-brand store" pgTAP case exists, but this mirrors spec 119's precedent
  exactly and for the same structural reason: `auth_can_see_store()`
  short-circuits true for any caller who passes `auth_is_privileged()`
  (admin/super_admin), so that branch is unreachable for any caller capable of
  invoking this RPC at all — not a coverage gap introduced by this spec.
- AC-12 (realtime — other admin clients see the new par live via `store-{id}`)
  → **NOT TESTED (pre-existing test-infrastructure gap, not spec-122-specific)
  — mirrors spec 119's AC11 exactly.** No automated test in this repo drives a
  live two-client realtime scenario for any feature. Verified instead by
  direct inspection: `select tablename from pg_publication_tables where
  pubname='supabase_realtime' and tablename='inventory_items'` on the running
  local container returns 1 row (already in the publication, pre-dating this
  spec — `20260514140000_realtime_publication_tighten.sql`), and this
  migration is function-only (no publication-membership change), matching the
  migration header's own claim. Not blocking — same reasoning the spec 119
  report used, and this project has no realtime-integration test track by
  design (see CLAUDE.md's three-track policy).
- AC-13 (items.tsv stays single-store — regression guard) → **PASS** —
  `IngredientFormDrawer.spec122.test.tsx::"items.tsv EDIT Save (no brandWide)
  calls updateItem only — NO fan-out"` asserts `applyScalarsToAllStores` is
  never called when `brandWide` is omitted. Confirmed by code read: the
  items.tsv host (`src/screens/cmd/InventoryDesktopLayout.tsx:562-567`) does
  not pass `brandWide` at all (prop defaults to `false`/undefined), while only
  the catalog.tsv host (`InventoryCatalogMode.tsx:762`) passes `brandWide`
  unconditionally on its edit-drawer instance.

### Test run

**pgTAP — the new file, isolated (via full suite grep):**
```
bash scripts/test-db.sh
== supabase/tests/apply_item_scalars_to_brand.test.sql ==
  PASS supabase/tests/apply_item_scalars_to_brand.test.sql (18 assertion(s) passed)
```
All 18 assertions pass, matching `select plan(18)`.

**pgTAP — full suite:**
```
✗ 1/69 DB test file(s) failed
```
One pre-existing, unrelated failure: `supabase/tests/item_vendors_rls.test.sql`
test (12) "non-member UPDATE cannot write order_code on a Charles link (stays
NULL — RLS regression pin)" — `have: 8302192, want: NULL`. Confirmed pre-
existing and unrelated to spec 122: this file was last touched by spec 114
(`git log` shows no commits since `806c6d9`), and it is the SAME local-
container-staleness failure the spec-119 test-engineer report already flagged
(the fixture's unqualified `limit 1` picks over a long-lived local Charles
item/vendor pair that has since accumulated a real `order_code` from earlier
manual CSV-export exercising, not from `seed.sql` or any migration). Not
reproducible in CI's fresh-`supabase start` runs. Not a regression introduced
by this spec.

**jest — spec122 files:**
```
npx jest spec122
PASS component src/screens/cmd/sections/__tests__/InventoryCatalogMode.spec122.test.tsx
PASS component src/components/cmd/IngredientFormDrawer.spec122.test.tsx
Tests: 6 passed, 6 total
```

**jest — useStore:**
```
npx jest useStore
PASS unit src/store/useStore.test.ts
PASS unit src/store/useStore.switching.test.ts
PASS unit src/store/useStore.updateStore.test.ts
Tests: 28 passed, 28 total
```

**jest — i18n parity:**
```
npx jest i18n.test
PASS unit src/i18n/i18n.test.ts
PASS unit src/screens/staff/i18n/i18n.test.ts
Tests: 24 passed, 24 total
```
`applyScalarsSuccessTitle` / `applyScalarsSuccessDetail` confirmed present with
matching key sets and `{updated}`/`{skipped}` placeholders in `en.json`,
`es.json`, `zh-CN.json`.

**jest — full suite:**
```
npx jest
Test Suites: 106 passed, 106 total
Tests:       1207 passed, 1207 total
```
Matches the spec's own reported count exactly.

**Typechecks:**
```
npx tsc --noEmit                        → clean
npm run typecheck:test (tsconfig.test.json) → clean
```

### Notes

- **Framework:** no new framework introduced. All new tests land in the
  existing pgTAP / jest tracks; no shell-smoke test was needed or added (pure
  PostgREST/RPC path, no edge function — matches the spec's own "no shell
  smoke expected" note).
- **The two highest-risk ACs (current_stock never fans out; items.tsv stays
  single-store) are both thoroughly covered, at both the SQL layer (pgTAP,
  structural column exclusion + explicit pre/post equality assertions on a
  differing value) and the frontend layer (jest, payload-key assertions +
  default-false prop wiring).** I found no gap in either that would justify a
  BLOCK.
- **This spec closes a gap the spec-119 test-engineer report flagged as unmet
  for its sibling feature.** Spec 119 shipped with `NOT TESTED` on its
  frontend-layer success/failure summary + `notifyBackendError` wiring for
  `applyVendorsToAllStores`. Spec 122's `useStore.test.ts` coverage for
  `applyScalarsToAllStores` explicitly closes that same category of gap for
  this spec's analogous action (optimistic patch + revert + toast, both
  branches tested).
- **AC-4 and AC-12 are the only two ACs without a dedicated new test**, and
  both are low-risk by design: AC-4 is a composition of two already-
  independently-tested, unchanged code paths (RPC write + pre-existing
  downstream reads); AC-12 mirrors a pre-existing, project-wide
  test-infrastructure gap (no realtime-integration harness exists for any
  feature in this repo) that spec 119 already surfaced and was not treated as
  blocking there. I am not blocking spec 122 on either.
- **Prod-apply status not verified by me.** The migration
  `supabase/migrations/20260717000000_apply_item_scalars_to_brand.sql` exists
  locally and the function is present and passing against the local
  container, but whether it has been applied to prod via the documented MCP
  process (required before `db-migrations-applied.yml` goes green) is outside
  this review's scope — flagging for the release-coordinator to confirm via
  `gh run list` per the CLAUDE.md CI-status-check rule before recommending
  SHIP_READY.
- **Discovered, unrelated pre-existing pgTAP failure** (`item_vendors_rls.test.sql`
  test 12) persists on this machine's long-lived local container; see Test
  run section. Flagging again so the release-coordinator doesn't misattribute
  it to this spec.
