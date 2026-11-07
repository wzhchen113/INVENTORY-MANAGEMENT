# Spec 184: Stock a store in bulk, and correct the empty EOD banner

Status: READY_FOR_REVIEW

Origin: creating a store inserts only a `stores` row, so a new store has nothing to count or order until each item is added by hand. The owner answered every open question on 2026-11-05, so the decisions below are written as requirements. Code findings were read from the working tree on 2026-11-05, and line numbers are pointers. Prod facts were measured read-only by main Claude the same day.

## User stories

1. As a **brand admin opening a new store**, I want to stock it in one action by copying an existing store's items, par levels, costs and vendor links, so that EOD count, weekly count and ordering work on day one without 149 hand entries.
2. As a **brand admin with a store that is already open but empty or partly stocked** (Kenyon and H Street today), I want to run the same action on that store, so that I get the missing items without disturbing what it already has.
3. As a **brand admin whose brand has catalog ingredients no store carries**, I want to choose which of them to add while stocking, so that a new ingredient isn't lost and a removed one doesn't come back without my say-so.
4. As an **admin looking at EOD for a store with nothing to count**, I want the screen to tell me the actual reason, and not offer a toggle that can't help, so that I don't go looking for a vendor schedule problem that doesn't exist.

## Current state (verified)

### Prod data (measured read-only, 2026-11-05)

| Store | Brand | `inventory_items` | `order_schedule` rows |
|---|---|---:|---:|
| Towson | 2AM | 149 | 12 |
| Charles | 2AM | 149 | 12 |
| Frederick | 2AM | 143 | 0 |
| Reisterstown | 2AM | 143 | 0 |
| Kenyon | 2AM | 0 | 6 |
| H Street | 2AM | 0 | 0 |
| Baltimore Seafood | separate brand | 0 | 0 |

- **2AM has 150 `catalog_ingredients`, and 0 of them are carried by no store.** So every row is carried somewhere, but **no single store has all 150**. Copying from one store can miss rows that another store carries. It isn't known whether Towson and Charles hold the same 149, so reaching 150 could need a further run from Frederick or Reisterstown.
- **Baltimore Seafood's brand has 0 catalog rows and no stocked store,** so it has nothing to copy from.
- **Each stocked store has 2 items with no vendor link.** They are copied like any other item, and they don't appear at EOD until linked.
- `item_vendors` columns: `id`, `item_id`, `vendor_id`, `cost_per_unit`, `case_price`, `is_primary`, `created_at`, `updated_at`, `order_code`, `product_page_url`. `catalog_ingredients` has no par or vendor column.

### Store creation
- `addStore` ([src/store/useStore.ts:3523-3529](../src/store/useStore.ts)) is fire-and-forget. It adds a row with a temporary id (`s${Date.now()}`), then swaps in the real id when `db.createStore` resolves. A failed insert only reaches `console.warn`: no revert and no toast.
- `StoreFormDrawer` ([src/components/cmd/StoreFormDrawer.tsx:127-136](../src/components/cmd/StoreFormDrawer.tsx)) shows the "Created store" success toast straight after calling `addStore`, whether or not the insert succeeds.
- `createStore` ([src/lib/db.ts:156](../src/lib/db.ts)) writes only `stores`.
- `StoreFormDrawer` is used only by `StoresTab` ([src/screens/cmd/sections/BrandsSection.tsx:1098](../src/screens/cmd/sections/BrandsSection.tsx)), and `BrandsSection` refuses everyone but `super_admin` (L151). So in the UI, **only super-admins can create a store today**. The server is wider: `privileged_insert_stores` admits any privileged role.

### No bulk path exists
- The only item-creating RPC is `create_inventory_item_with_catalog`, one item at a time, SECURITY INVOKER, `on conflict (store_id, catalog_id) do nothing` ([20261023000000_catalog_eod_count_mode.sql:162-184](../supabase/migrations/20261023000000_catalog_eod_count_mode.sql)).
- `apply_item_vendors_to_brand` ([20260724000000](../supabase/migrations/20260724000000_apply_item_vendors_product_page_url.sql), L154-165) and `apply_item_scalars_to_brand` ([20260717000000](../supabase/migrations/20260717000000_apply_item_scalars_to_brand.sql), L126-138) target existing rows only. A store with no row for that catalog id goes into `skipped_store_ids` and is not created (spec 119 / spec 122 AC-9).

### What a store's items are made of
- `inventory_items` is per-store and unique on `(store_id, catalog_id)` ([20260504072830](../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql) L41-42). Per-store fields: `cost_per_unit`, `case_price`, `par_level`, `safety_stock`, `usage_per_portion`, `average_daily_usage`, `current_stock`, `eod_remaining`, `expiry_date`, `vendor_id`, `last_updated_by`, `vendor_changed_at`.
- `item_vendors` holds the links: `(item_id, vendor_id)` unique, at most one `is_primary` per item ([20260630000000_item_vendors.sql](../supabase/migrations/20260630000000_item_vendors.sql)). `inventory_items.vendor_id` mirrors the primary link (SD-1). Item and link costs use the per-each basis from spec 104.
- `catalog_ingredients` is brand-level: name, unit, category, packaging, translations, photo, EOD count mode, shelf life. It does have `default_cost` / `default_case_price`, but these are set when an ingredient is first created and later price changes don't update them (spec 122 fan-out writes store rows only; cost-on-receipt says `default_cost` is never written). In `src/` they are only mapped in `fetchCatalogIngredients`, and nothing reads them. This spec doesn't use them.
- `vendors` is brand-scoped, so links can be copied between stores of one brand. Recipes dropped `store_id` in brand catalog P3, so recipes need no copying.

### Why vendor links matter
- Admin EOD builds its tabs **only** from item-to-vendor links ([EODCountSection.tsx:439-455](../src/screens/cmd/sections/EODCountSection.tsx)). An item with no link appears in no tab.
- Staff EOD reads items through `item_vendors` with an inner join on the item ([src/screens/staff/screens/EODCount.tsx:161-168](../src/screens/staff/screens/EODCount.tsx)). Same rule.
- So **an item added without a vendor link can't be counted at EOD.** That applies to the 2 unlinked items per stocked store, and to any uncarried catalog row the admin adds (R-3).

### Order schedule
- `order_schedule` is per-store. Admin EOD falls back to "all vendors, every day" when a store has no schedule rows (L457-461).
- Staff EOD has **no such fallback**. It lists only that day's scheduled vendors ([EODCount.tsx:116-146](../src/screens/staff/screens/EODCount.tsx)). A stocked store with no schedule still shows staff no vendors. After stocking, that would apply to H Street but not Kenyon.

### Why the gap is easy to miss
`InventoryCatalogMode` builds its list by grouping `inventory` rows by name across all stores ([InventoryCatalogMode.tsx:118-143](../src/screens/cmd/sections/InventoryCatalogMode.tsx)). An empty store looks fine there. It also means a catalog row that no store carries is invisible in that view. "Delete everywhere" (L668-682) deletes the inventory rows and leaves the catalog row, so a catalog row no store carries may well be an ingredient someone removed on purpose. `copy_brand_catalog` can also create catalog rows in a brand without inventory rows.

### The EOD banner ([EODCountSection.tsx:1678-1684](../src/screens/cmd/sections/EODCountSection.tsx))
- It shows `noVendorsScheduled` when `vendorTabs` is empty, a schedule exists, and the toggle is off. `allVendorTabs` contains only vendors with items at this store, so a day that does have a scheduled vendor still reads "no vendors scheduled".
- The `show unscheduled vendors` toggle (L1710-1738) can only widen to `allVendorTabs`. When that is empty, it does nothing.
- `showUnscheduled` (L322) is set only by that toggle and is never reset. The `+ vendor` button is disabled while it is true (L1691). Hiding the toggle without handling this could leave `+ vendor` stuck disabled.
- Phone renders a separate branch (L1282, [PhoneEodCount.tsx:394-397](../src/screens/cmd/sections/eod/PhoneEodCount.tsx)). It always shows `noVendorsAtStore` when the filtered list is empty, and it has no toggle.

### Constraints from earlier specs
- **Spec 179:** `id` and `store_id` are immutable on `inventory_items`, and every delete leaves a tombstone. Reusing an id under another store raises 42501. So copied rows **must get fresh ids**, never the source row's id. Fresh ids are never tombstoned. Re-stocking after a delete mints a new id, so it is unaffected.
- **Spec 177:** PO lines and approval lines must name an item from the same store. Copied rows are the target store's own, so this holds once the target's ids are used.
- **Spec 097:** new functions need EXECUTE revoked from `public, anon` explicitly, because default privileges grant it.

## Requirements (owner-approved)

- **R-1. Bulk stock from a store, in one transaction.** A new RPC (working name `stock_store_from_store(p_target_store_id, p_source_store_id, p_extra_catalog_ids)`; the architect may rename it) creates, at the target store, one `inventory_items` row for each source row whose `catalog_id` the target lacks, and copies those rows' vendor links. It also adds any uncarried catalog rows the admin ticked (R-3). It either fully applies or changes nothing. A source store is always required, and there is no catalog-only path.
- **R-2. Field handling for copied rows.**

  | Field | At the target |
  |---|---|
  | `id` | fresh |
  | `store_id` | target |
  | `catalog_id` | from source |
  | `par_level`, `safety_stock`, `usage_per_portion` | copied (store configuration) |
  | `cost_per_unit`, `case_price` | copied verbatim, with no cost math (spec 104 basis carries through) |
  | `vendor_id` | copied, and must equal the target's primary link |
  | `current_stock`, `eod_remaining` | 0 |
  | `average_daily_usage` | 0 (observed at one store; not meaningful at another) |
  | `expiry_date`, `last_updated_by`, `vendor_changed_at` | null |
  | Each `item_vendors` link | new row on the new item, copying `vendor_id`, `cost_per_unit`, `case_price`, `is_primary`, `order_code`, `product_page_url`; `id`, `created_at` and `updated_at` are fresh |

- **R-3. Optional list of uncarried catalog rows.** If the target's brand has `catalog_ingredients` rows carried by **no store in the brand** (active or inactive), the stock dialog lists them, with none ticked. The admin may tick any to add. Each one becomes an `inventory_items` row with `par_level`, `cost_per_unit`, `case_price`, `safety_stock`, `usage_per_portion`, `current_stock`, `eod_remaining` and `average_daily_usage` all 0, null `vendor_id`, and no links. `default_cost` is not used. These rows don't show at EOD until a vendor is linked, and the dialog says so. **When there are no such rows, the list doesn't appear** (2AM on prod today).
- **R-4. Never disturb what's there.** Rows the target already has are left exactly as they are, including their links, stock and prices. Only what's missing is added.
- **R-5. One source doesn't mean the full catalog.** One run adds only what that source carries, plus any ticked rows. Running again from a different source adds what the first didn't provide. The dialog and result must not imply the store now has the full catalog (2AM: 150 catalog rows, largest store 149).
- **R-6. Everything the target lacks is copied.** No per-item or per-category selection of the source's items.
- **R-7. Role gate.** Caller must be `auth_is_privileged()` **and** pass `auth_can_see_store()` for both stores. Both stores must belong to the same brand. Matches the `apply_item_*_to_brand` gates. A manager with `user_stores` rows on both stores is refused, even though RLS would let them insert items one at a time. The UI lives in the Brands section, so in practice super-admins use it.
- **R-8. Entry points.** A `STOCK` action on each `StoresTab` row, plus a "Stock from" choice when creating a store.
- **R-9. The order schedule is not copied.** When the target has no `order_schedule` rows, the result warns the admin.
- **R-10. Correct the EOD empty state**, as set out under AC-22 to AC-26.

## Acceptance criteria

Test tracks: **pgTAP** (one new file under `supabase/tests/`), **jest**, and browser-preview verification. No shell smoke. Refusal tests assert the SQLSTATE and exact message with `throws_ok`. Success tests assert the rows really landed. Fixtures are hermetic (`begin; … rollback;`), and use two stores in one brand, a store in a second brand, a caller who can see both stores, and an anti-vacuity probe that proves it, so RLS can't make a cross-store case pass for the wrong reason.

### RPC behavior (pgTAP)
- [ ] **AC-1:** Stocking an empty target from a source with N items creates exactly N `inventory_items` rows at the target and returns a jsonb reporting at least: items copied, items skipped because the target already has them, links added, uncarried catalog rows added, ticked rows skipped, and items added with no vendor link. Exact keys are set by the architect and pinned by the test.
- [ ] **AC-2:** Every field on a copied row matches the R-2 table, asserted per field, using a source row with non-zero stock, `eod_remaining`, `average_daily_usage` and a set `expiry_date`, so that resetting is proven.
- [ ] **AC-3:** New row ids differ from the source row ids.
- [ ] **AC-4:** Vendor links:
  - an item with two links at the source has two at the target, with cost, case price, `order_code` and `product_page_url` matching per link;
  - exactly one is primary, and it equals the target row's `vendor_id`.
- [ ] **AC-5:** An item with no links at the source is copied with no links and a null `vendor_id`. The "added with no vendor link" count includes it, and it is absent from the staff EOD read shape in AC-6.
- [ ] **AC-6:** Copied linked items are visible through the staff EOD read shape (`item_vendors` inner-joined to `inventory_items` filtered on the target store) for the source's vendors. This proves the reported bug is fixed.
- [ ] **AC-7:** The source store's items and links are unchanged after the call (row-level comparison).
- [ ] **AC-8:** On a partly stocked target, an item it already has keeps its par, cost, case price, `current_stock`, vendor and links exactly, including a link set that differs from the source. Only the missing items are added, and the returned counts say so.
- [ ] **AC-9:** A second identical run adds 0 items and 0 links and changes nothing.
- [ ] **AC-10:** With source A carrying items {1,2} and source B carrying {2,3}, running from A then B leaves the target with {1,2,3}. Item 2 keeps A's values, and the second run reports 1 copied and 1 skipped.
- [ ] **AC-11:** All-or-nothing: a failure partway through, forced in the test, leaves 0 new `inventory_items` and 0 new `item_vendors` rows.
- [ ] **AC-12:** A source store with no items and no ticked rows returns 0 counts and writes nothing.

### Uncarried catalog rows (pgTAP)
- [ ] **AC-13:** A ticked catalog row carried by no store in the brand is added at the target with the R-3 values, no links, and a null `vendor_id`, and the counts report it. `default_cost` being non-zero in the fixture proves it isn't used.
- [ ] **AC-14:** A ticked id that now has an inventory row at any store in the brand, including the target or an inactive store, adds nothing for that id. It is counted as skipped, and the rest of the call proceeds.
- [ ] **AC-15:** A ticked id from another brand, or an id that doesn't exist, refuses the whole call and writes nothing.
- [ ] **AC-16:** A null or empty tick list behaves the same as a call with no ticks.

### Refusals and privileges (pgTAP)
- [ ] **AC-17:** Each of these is refused and writes nothing:
  - a non-privileged user who has `user_stores` rows on both stores;
  - an admin of another brand (cannot see the stores);
  - a privileged caller who can see the target but not the source, and the reverse;
  - source and target in different brands, tested as `super_admin` so visibility can't be what stops it;
  - source equal to target;
  - a missing target or source id, including a null source with ticked rows;
  - a store whose `brand_id` is null.

  The architect sets the errcodes. Default: 42501 for authorization, 22023 for bad parameters.
- [ ] **AC-18:** A cross-brand vendor link on a source row is not copied to the target, or the call is refused. The architect picks which and the test pins it.
- [ ] **AC-19:** `anon` and `PUBLIC` lack EXECUTE, `authenticated` has it, exactly one overload exists, `search_path` is pinned, and `prosecdef` is pinned to the design's choice. No `order_schedule` row is written by any call.
- [ ] **AC-20:** Spec 179 and spec 177 coexist:
  - delete a stocked item at the target, then re-run: the item returns under a new id with no 42501;
  - a PO at the target accepts a line naming the target's copied row, and refuses one naming the source's row.

  `inventory_items_identity_lock.test.sql`, `cross_store_item_rejection.test.sql`, `public_grants_explicit.test.sql` and `permissive_policy_lint.test.sql` pass **unmodified**. No RLS policy or publication changes.
- [ ] **AC-21:** A successful call that adds at least one item writes exactly one `audit_log` row for the target store naming the source store and the counts, never one per item. A refused call or a call that adds nothing writes none. The architect picks whether the RPC or the client writes it (`copy_brand_catalog` is a one-row-per-call precedent).

### EOD empty state (jest, desktop branch unless stated)
- [ ] **AC-22:** When `vendorTabs` is empty and inventory has loaded, exactly one of these shows:

  | State | Condition | Message | Toggle |
  |---|---|---|---|
  | S1 | store has 0 items | new `section.eod.noItemsAtStore`: "this store has no items yet, so there is nothing to count" | hidden |
  | S2 | store has items, none with a vendor link | new `section.eod.noVendorLinksAtStore`: "items at this store have no vendor linked, so they can't be counted here" | hidden |
  | S3 | vendors have items here; the selected day has no scheduled vendors | existing `noVendorsScheduled` | shown; turning it on shows the tabs |
  | S4 | vendors have items here; the day has scheduled vendors, none with items here | new `section.eod.scheduledVendorsNoItems`: "vendors scheduled for {day} have no items at this store" | shown; turning it on shows the tabs |

  S1 takes precedence over S2, and S2 over S3 and S4. Exact copy may be tuned at review, but must not imply that a schedule or the toggle will help in S1 or S2.
- [ ] **AC-23:** A store where only some items have vendor links (the prod norm: 2 unlinked per stocked store) shows no S2 message. Linked items appear in their tabs as they do today, and the unlinked ones stay absent. A store whose only items came from ticked catalog rows is in S2.
- [ ] **AC-24:** After turning the toggle on at a stocked store and then switching to a store in S1 or S2, the `+ vendor` button is enabled and the toggle is hidden. Coming back to a stocked store gives a coherent toggle state (the architect picks reset or keep; the test pins it).
- [ ] **AC-25:** New keys exist in `en.json`, `es.json` and `zh-CN.json`, and `src/i18n/i18n.test.ts` passes.
- [ ] **AC-26:** Phone: in S1 and S2, `PhoneEodCount` shows the same new messages. A search or category filter that merely hides rows at a stocked store still behaves as it does today. The rest-day panel is unchanged on both branches.

### Stock dialog (jest)
- [ ] **AC-27:** Each `StoresTab` row has a `STOCK` button (`testID="store-stock-<id>"`, `accessibilityLabel`, 44x44 effective target, same treatment as `EDIT`). It opens a dialog that works in the existing responsive sheet on desktop and phone widths.
- [ ] **AC-28:** The source picker lists only stores of the same brand that have at least 1 item, excludes the target, and shows each store's item count.
- [ ] **AC-29:** **No source available.** When no other store in the brand has items (Baltimore Seafood on prod), the dialog says there is no store to copy from, shows no picker and no uncarried-rows list, and offers no submit. The same holds for a brand with 0 catalog rows, and for a brand with catalog rows but no stocked store.
- [ ] **AC-30:** After a source is picked, and before anything is written, the dialog states:
  - the source's name, how many items will be added, and how many the target already has;
  - how many of those being added have no vendor link and so won't appear at EOD until linked, shown only when that's above 0;
  - that stock starts at 0;
  - when other stores in the brand carry rows that neither the source nor the target has, how many there are and that running again from another store adds them. This line is hidden when the count is 0.

  Nothing in the copy says or implies the store will have the full catalog.
- [ ] **AC-31:** With no items to add and nothing ticked, the dialog says the target already has everything from that source and offers no submit.
- [ ] **AC-32:** The uncarried-rows list (R-3):
  - doesn't render when the brand has no such rows;
  - when rows exist, shows each row's localized name, category and unit, is scrollable, and has none ticked by default;
  - says ticked rows are added with blank par and cost and no vendor link, so they won't show at EOD until linked, and that some may be ingredients removed on purpose;
  - sends only the ticked ids.
- [ ] **AC-33:** On success, a result message reports items copied, items skipped, ticked rows added, ticked rows skipped (when above 0) and items with no vendor link (when above 0). Without a page reload, the Inventory and EOD sections reflect the new rows when the target is the current store. The refresh must be explicit, because the admin realtime subscription filters `inventory_items` to the current store only.
- [ ] **AC-34:** When the target has no `order_schedule` rows (H Street), the result also warns that staff EOD will show no vendors until a schedule is set. When it has rows (Kenyon), no such warning shows.
- [ ] **AC-35:** On failure, `notifyBackendError` surfaces the error, no success message shows, the dialog stays open with the picks intact, and the refresh doesn't fake a result. A second press while in flight doesn't send a second call.
- [ ] **AC-36:** All traffic goes through new wrappers in `src/lib/db.ts` using `useInflight` `track`, and through a slice action in `useStore.ts`. No component calls `supabase` directly.
- [ ] **AC-37:** There's no selection UI for the source's items (R-6). Ticks exist only on the uncarried-rows list.

### Stock at creation (jest)
- [ ] **AC-38:** Create mode of `StoreFormDrawer` gains a "Stock from" choice listing the brand's stores that have items, with each store's item count, plus an explicit "Don't stock yet". No store is preselected, so the admin has to choose. CREATE stays disabled until they do, and the `n/N required valid` footer counts it. If the brand has no store with items, the field is hidden and the footer stays at 2. Edit mode is unchanged. The copy doesn't imply the full catalog.
- [ ] **AC-39:** The uncarried-rows list is not in the create drawer. If the brand has such rows, the result message after a successful create says how many exist and that they can be added from the store's `STOCK` action.
- [ ] **AC-40:** `addStore` returns a promise that resolves to the real store id or a failure value, never rejects, and reverts its optimistic row and calls `notifyBackendError` on failure. The success message fires only after the insert resolves. On failure the drawer stays open with the input intact and the stock RPC isn't called. Existing store-list behavior is otherwise unchanged, and the temporary id is never sent to the RPC.
- [ ] **AC-41:** If the store is created but stocking fails, the store remains, the message says it was created but not stocked, and the row's `STOCK` action can retry. A test pins this.
- [ ] **AC-42:** A store created and stocked gets the same result content as AC-33 and AC-34. A new store has no schedule, so the AC-34 warning always shows on this path.
- [ ] **AC-43:** `StoresTab`'s refresh on drawer close doesn't drop the new store from the list. Today's `[refresh, drawerOpen]` effect can race an in-flight create (the spec-094 class of race, see L1120-1138).

### Gates
- [ ] **AC-44:** `scripts/test-db.sh`, full `npx jest` (not a subset), `npm run typecheck`, and `npm run typecheck:test` all pass.
- [ ] **AC-45:** Browser preview on the local stack (`npm run dev:db`), logged in as a `super_admin` (`BrandsSection` refuses others; check whether `admin@local.test` qualifies), recorded in the review notes, at desktop width and at phone width:
  1. create a store and choose "Don't stock yet"; EOD shows S1 with no toggle and an enabled `+ vendor`;
  2. run `STOCK` from a seeded store; the dialog's counts match the source; EOD shows vendor tabs and items, Inventory shows the items with stock 0 and the source's par and cost;
  3. edit a par at the target, reopen `STOCK` from a different store with more or different items, and run it; only missing items are added and the edit stays;
  4. reopen `STOCK` from the same source; the dialog says there is nothing to add and offers no submit;
  5. confirm the uncarried-rows list is absent. Then use "Delete everywhere" on a test ingredient, reopen the dialog, confirm it's listed unticked, tick it and run; it appears in Inventory with blank par and cost, and not at EOD;
  6. open `STOCK` in a brand with no stocked store; the dialog offers no submit;
  7. confirm the no-schedule warning, and that S3 and S4 appear with a schedule set and the toggle works in both.

### Prod apply (documented in the design; executed only on the owner's go-ahead)
- [ ] **AC-46:** The design includes a prod apply runbook for project `ebwnovzzkwhsdxkpyjka` following spec 177 §10 with the spec 179 S-1 and S-2 corrections: verbatim migration through MCP `execute_sql`, exact-version insert into `schema_migrations`, normalized-md5 verification, and a raise-always negative probe that leaves no rows. Apply comes before the push that carries the migration. After the push, confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.

## In scope

- One migration adding the bulk stock RPC with its grants and comment, plus any read RPC the dialog needs (N4).
- `db.ts` wrappers and a `useStore.ts` slice action.
- The `STOCK` row action and dialog in `StoresTab`, including the optional uncarried-rows list.
- The "Stock from" field in the create drawer, and the `addStore` promise rework that it needs.
- The EOD empty-state correction (desktop S1 to S4, phone S1 and S2), with three-locale strings.
- New pgTAP and jest coverage, and the prod apply runbook.

## Out of scope (explicitly)

- **Backfilling Kenyon and H Street.** Being decided in a separate session. The action must work on them (user story 2, AC-8), and running it after a SQL backfill is harmless because it only adds what's missing.
- **A catalog-only stocking path.** The owner chose copy as the source. Uncarried rows are an add-on to a copy, never a source of their own.
- **Stocking a brand with no stocked store,** including Baltimore Seafood today. With no source, the dialog offers no submit (AC-29), so that first store still needs hand entry or CSV import. Decided by this spec from the owner's "copy stays the source"; see the resolved Q3.
- **Copying from several sources in one run.** Run it again from another source (AC-10).
- **Overwriting existing rows, or per-item or per-category selection of the source's items.** The owner rejected both.
- **Copying `order_schedule`,** or setting schedules for Frederick, Reisterstown or H Street. All three have 0 rows, so staff EOD lists no vendors there. Frederick and Reisterstown are an existing gap this spec doesn't touch.
- **An EOD notice for individually unlinked items at a store that has vendor tabs** (AC-23). Stocked stores already have 2 such items with no notice. The stock result reports them instead.
- **Changing the Catalog view** so it shows per-store gaps, or a store-row item count. Useful, but not needed once the action and the banner exist.
- **Making `apply_item_*_to_brand` create missing rows.** Those skip rules are specified behavior (spec 119 and 122 AC-9).
- **An entry point outside Brands.** The owner chose Brands only. The server gate already allows other privileged roles, so a later entry point needs no migration.
- **Other per-store data:** `store_count_layouts`, `pos_recipe_aliases`, saved reports, EOD deadline, weekly due day, `user_stores`.
- **Bulk undo.** A wrong copy is fixed by deleting items. The confirm step (AC-30) is the guard.
- **A link or directions from the EOD banner to the stock action.** Non-super-admins can't open Brands, so the directions would be wrong for them.
- **Staff EOD empty-state copy,** and phone S3/S4 copy (phone still shows `noVendorsAtStore`). Both are adjacent and neither is in this request. Noted as a follow-up.
- **Importing starting counts.** Stock starts at 0, and the first count sets it.
- **Removing or refreshing `default_cost` / `default_case_price`.** Unrelated cleanup.
- **`app.json` slug.** Not touched. Edge functions and realtime publication not touched.

## Open questions resolved

Answered by the owner on 2026-11-05, relayed by main Claude:
- Q: Where do a store's items come from? → A: **Copy from an existing store in the same brand.** Not a catalog-only path.
- Q: Where does an admin start this? → A: **Both** at store creation and as an action on an existing store.
- Q: What happens to catalog rows no store carries yet? → A: **Admin chooses, through an optional list in the dialog.** Copy stays the source. If rows carried by no store in the brand exist, the dialog lists them and the admin ticks any to add, with blank par and cost and no vendor link, so they won't show at EOD until linked. The list doesn't appear when there is nothing to show.
- Q: What about running it on a store that already has items? → A: **Add only what's missing; never change existing rows.**
- Q: Does the admin pick which items to copy? → A: **No, copy everything the target lacks.**
- Q: Should the action also copy the order schedule? → A: **No. Warn when the target has no schedule.**
- Q: Who can run it? → A: **UI in Brands (super-admins in practice). The server allows any privileged role who can see both stores.**

Follow-on details the answers left open, set here by the product manager with the obvious default. Any of them can be overridden without changing the design's shape:
- The uncarried-rows list is in the `STOCK` dialog only, not the create drawer (AC-39), because the owner specified "the dialog" and the drawer has no result step for it.
- A brand with no stocked store can't use ticks alone, because a source is always required (AC-29). This state doesn't exist on prod today: Baltimore Seafood's brand has 0 catalog rows.
- A ticked row that has since gained an inventory row is skipped and counted, not added blank (AC-14), so the "carried by no store" rule holds at write time.
- "Blank" par and cost are stored as 0, the column defaults. The Inventory view already flags a 0-cost item as unfinished.

## Notes for architect

- **N1. Invoker vs definer.** Every row the RPC touches is one the caller can already see under the gates in R-7, so SECURITY INVOKER looks sufficient (the `create_inventory_item_with_catalog` precedent), and it keeps RLS as a second check. The `apply_item_*` functions chose definer only for skipped-store accounting. One thing to confirm: "carried by no store in the brand" (R-3, AC-14) must see **every** store in the brand, so check that an invoker read can't under-count for any caller who passes R-7. Record the choice.
- **N2. Set-based vs row loop.** At about 150 items with one or two links each, either works. Links need mapping from source item id to new item id, for example by joining on `catalog_id`. Respect `item_vendors_one_primary_per_item`.
- **N3. Concurrency.** Two admins running on one target at once: `on conflict (store_id, catalog_id) do nothing` protects items, and links must only be created for rows this call actually inserted (AC-8).
- **N4. Dialog data.** The dialog needs: per-store item counts, how many the target already has, unlinked count among those being added, rows carried elsewhere but by neither store (AC-30), and uncarried rows (AC-32). The `inventory` slice holds every visible store's rows (`fetchInventory()` with no store filter, [db.ts:5894](../src/lib/db.ts)), but `catalogIngredients` is loaded for the **current** brand, the super-admin may be viewing another, and the slice can be stale. A small read RPC returning this preview is acceptable and likely cleaner. Displayed counts must come from the same rules the write uses.
- **N5. EOD loading state.** `fetchAllForStore` swallows a failed inventory fetch into `[]` (L5894), so a failed load looks like an empty store, and S1 would state something false. Decide how S1 tells "loaded and empty" apart from "not loaded or failed", and pin that with a test.
- **N6. Desktop worksheet body.** Check what renders below the pills when no vendor is selected, so there aren't two conflicting messages.
- **N7. Migration slot.** The newest on disk is `20261027000000_eod_update_notifications.sql`. Spec 178's work has an untracked test file in the tree (`supabase/tests/order_approvals_fk_set_null.test.sql`) and may also take a slot. Re-check before building.
- **N8. Triggers.** Spec 179 lists the triggers on `inventory_items`, and none notifies on insert. Confirm with `pg_trigger` in the pre-check, and confirm no cron or report sends alerts because a new store's items are all at 0.

## Risks

- **One source misses rows.** On prod every 2AM store lacks at least one of the 150 catalog rows, so one run won't reach 150. An admin who assumes it did has a silent gap. Guarded by R-5 and AC-30, and a re-run fills it.
- **Values depend on run order.** The first source to provide an item sets its par and cost, and later runs never change them (AC-10). This follows from "never change existing rows".
- **Deleted ingredients can come back.** A ticked row may be something removed on purpose. Rows are unticked by default, and the dialog says so (AC-32).
- **Every copied item starts "out".** `getItemStatus` returns `out` at stock 0, and reorder suggests a full par for each item until the first count. This follows from the requested "stock starts at 0". The dialog copy (AC-30) says so.
- **Staff still can't count at a store with no schedule.** This is the owner's choice, and the warning (AC-34) names it. It applies to H Street after stocking.
- **Wrong source chosen.** No bulk undo. At a new store the rows have no references, so they can be deleted one at a time, but that takes time. Guarded by AC-30.
- **Copied prices treated as this store's real prices.** Costs are a starting point. Cost-on-receipt updates them as deliveries come in.
- **Realtime burst.** The `item_vendors` subscription has no store filter ([useRealtimeSync.ts:46](../src/hooks/useRealtimeSync.ts)), so several hundred inserts reach every signed-in admin client as events. The 400 ms debounce should coalesce them, followed by a full inventory reload. Worth a look during preview.
- **The `addStore` rework** changes a function that existing tests pin (`StoreFormDrawer.test.tsx`). Grep for tests that pin the old behavior, and run full jest.
- **The banner saying "no items" when the load failed.** See N5.
- **Prod / repo drift.** Pushing before the prod apply turns `db-migrations-applied.yml` red. AC-46 sets the order.

## Dependencies

- Spec 179 (identity lock, tombstones) and spec 177 (cross-store line rejection): constraints, and suites that must stay green.
- Specs 102, 114 and 131 (`item_vendors` and its columns), spec 104 (per-each cost basis).
- Specs 119 and 122 (the fan-out gates this mirrors, and their skip behavior).
- Specs 149 and 155 (`StoreFormDrawer` shape), spec 162 (address required).
- Spec 097 (function privileges), spec 053 (permissive-policy lint), spec 064 (migration gate).
- Spec 170 (audit log hardening), if the RPC writes the audit row.

## Project-specific notes

- **Cmd UI section / legacy:** `src/screens/cmd/sections/BrandsSection.tsx` (`StoresTab`), `src/screens/cmd/sections/EODCountSection.tsx`, `src/screens/cmd/sections/eod/PhoneEodCount.tsx`, and `src/components/cmd/StoreFormDrawer.tsx`.
- **Which app:** admin Cmd UI. The staff stack gets no code change, but benefits because its EOD reads the copied links.
- **Per-store or admin-global:** per-store writes, brand-bounded, gated by `auth_is_privileged()` plus `auth_can_see_store()` on both stores.
- **Edge function or PostgREST:** Postgres RPC through `src/lib/db.ts`. JWT-authenticated. No edge function.
- **Realtime channels touched:** `store-{target}` receives `inventory_items` and `item_vendors` events, and `item_vendors` events reach all subscribed admin clients (unfiltered). No publication change, so the realtime container-restart gotcha doesn't apply.
- **Migrations needed:** yes, one. Prod apply via MCP after the owner's go-ahead and before the push.
- **Edge functions touched:** none.
- **Web/native scope:** both, since it's React Native code in the shared Cmd UI. Verified in the browser at desktop and phone widths. A native Simulator pass isn't required by this spec.
- **`app.json` slug:** not touched.
- **Test tracks:** pgTAP (one new file, plus lints unmodified), jest (EOD states, stock dialog, `StoreFormDrawer`, `db.ts` wrappers, i18n parity), both typechecks. No shell smoke.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria and any project-specific notes, then produce the design doc and set Status: READY_FOR_BUILD.
payload_paths:
  - specs/184-stock-new-store.md

## Backend design

Everything below was verified against the working tree on 2026-11-05 by reading migrations and code. No database was queried: this agent has no shell or MCP, so column lists come from the migration history and are pinned at build time by `columns_are` (T-1). Prod values come from the spec's own measurements.

### 0. Findings that change or sharpen the spec

| # | Finding | Evidence | What the design does |
|---|---|---|---|
| F-1 | **The feature's core assumption holds.** `vendors` is brand-scoped: `brand_id` NOT NULL, RLS by `auth_can_see_brand(brand_id)`. Copied links point at a valid vendor at the target. | [p3_lockdown:20](../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql), [multi_brand:575](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql) | Copy links as specified. |
| F-2 | **New defect the feature makes reachable: the 1000-row cap.** `fetchAllForStore` loads `fetchInventory()` with no store filter, and `max_rows = 1000`. 2AM has 584 rows today, 882 after Kenyon and H Street are stocked, and 1031 with one more store. Past 1000, PostgREST silently truncates the `id`-ordered result, so items vanish from random stores for every admin, with no error. | [db.ts:5894](../src/lib/db.ts), [db.ts:295](../src/lib/db.ts), [config.toml:18](../supabase/config.toml) | **Design-added requirement D-14 (keyset paging).** Not in the spec. Flagged for the owner, who may defer it. Prod's `max_rows` is a dashboard setting not visible from the repo; the fix is harmless at any value. **Superseded (release fixes, 2026-11-07):** a short-page stop is not correct at any value; below 1000 it stops after page one. The loop now stops on an empty page; see D-14. |
| F-3 | **A single-statement copy cannot work under INVOKER.** `store_member_insert_item_vendors` checks `exists(select … from inventory_items …)` in WITH CHECK. A policy subquery runs on the statement's snapshot and cannot see a parent row inserted by the same statement (writable CTE). | [item_vendors.sql:126-129](../supabase/migrations/20260630000000_item_vendors.sql) | Items and links are **separate statements** (D-5). T-5 runs under `authenticated` to prove it. |
| F-4 | **R-7's two checks don't guarantee full brand visibility; a third does.** `auth_can_see_store` has a `user_stores` arm, so a privileged caller can pass on both stores without seeing the brand (a stale `admin` JWT on a demoted `role='user'`, `brand_id` null profile). An invoker read of "carried by no store" would then under-count. Adding `auth_can_see_brand(brand)`, which `apply_item_*` already use and R-7 says to match, closes it. | [auth_can_see_store:88-108](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql), [apply_item_vendors:81](../supabase/migrations/20260724000000_apply_item_vendors_product_page_url.sql) | Gate G-7. **Invariant:** privileged AND `auth_can_see_brand(b)` implies every store of `b` is visible. If super_admin, arm (i). Otherwise `auth_is_admin()` is true and arm (ii) passes for every store of `b`. This is what makes INVOKER safe (N1). |
| F-5 | **AC-17's "store whose `brand_id` is null" is unreachable.** `stores.brand_id` is NOT NULL and no later migration drops it (grep across all migrations). | [p3_lockdown:19](../supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql) | T-29 pins `col_not_null` instead of inserting a row. The RPC still treats null as not found. |
| F-6 | **R-2 and AC-5 conflict on `vendor_id`.** R-2 says copied; AC-5 says a no-link item gets null. SD-1 is application-maintained with no trigger or constraint, so a source row can be inconsistent (scalar with no link, scalar differing from the primary link). | [item_vendors.sql:13-20](../supabase/migrations/20260630000000_item_vendors.sql) | The target's `vendor_id` and `is_primary` are **derived** from the copied links (D-4). Identical to a plain copy on consistent rows. |
| F-7 | **The `inventory` slice holds every visible store,** so a stock run on a store other than the current one also leaves the slice stale. AC-33 only asks for a refresh when the target is current. | [db.ts:5894](../src/lib/db.ts) | Reload whenever anything was added, whichever store is current (D-11). A superset of AC-33. |
| F-8 | **The spec's realtime note is slightly off.** `store-{target}` only exists on clients viewing that store. `item_vendors` is unfiltered, so all admin clients with any store open receive those events. | [useRealtimeSync.ts:32-46](../src/hooks/useRealtimeSync.ts) | See section 7. |
| F-9 | **S2 can't be derived from `allVendorTabs`.** `fetchVendors(...).catch(() => [])` also swallows failures, so linked items with an empty `vendors` slice would falsely read "no vendor linked". | [db.ts:5898](../src/lib/db.ts), [EODCountSection.tsx:439-455](../src/screens/cmd/sections/EODCountSection.tsx) | S2 reads item links directly; a sixth state covers this case (D-12). |
| F-10 | **Local login isn't a super-admin** (answers AC-45). `admin@local.test` is `role=admin`, and the seed has no super-admin profile. | [apply_item_vendors test:15-16](../supabase/tests/apply_item_vendors_to_brand.test.sql), [smoke-multi-brand.sh:65-71](../scripts/smoke-multi-brand.sh) | The preview must promote it with the smoke script's pattern (role `super_admin`, `brand_id` null to satisfy `profiles_role_brand_consistent`), re-login, and revert afterward. |

**N8 confirmed from migrations.** `inventory_items` has exactly five non-internal triggers: `inventory_items_updated_at`, `trg_item_vendor_changed_at`, `inventory_items_identity_lock_trg` (all BEFORE UPDATE), `inventory_items_tombstone_check_trg` (AFTER INSERT) and `inventory_items_tombstone_record_trg` (AFTER DELETE). `item_vendors` has none. Nothing notifies on insert. No cron or edge function alerts on stock levels: the only functions reading `current_stock` are `breadbot-nightly-sync` and `pwa-catalog`, and `eod-reminder-cron` and `record_missed_orders_for_day` read schedules and POs, not items. The runbook re-confirms with `pg_trigger`.

### 1. Data model changes

**No table, column, index, constraint, policy, trigger or publication change.** One additive migration with two functions, their comments and their grants.

- **File:** `supabase/migrations/20261105000000_stock_store_from_store.sql`. Newest on disk is `20261027000000`. Re-check before building (N7); any later unused version is fine.
- **Shape:** `begin; set local lock_timeout = '5s'; … commit;`, with a header in the spec 177 / 179 style, including a PROD-APPLY note naming the exact version.
- **Rollout:** additive and idempotent (`create or replace`). The old client never calls it. Applying it before the push is safe.
- **Rollback:** drop both functions and delete the `schema_migrations` row. Rows already stocked stay; they're ordinary items.

**Column disposition, `inventory_items` (all 17, from init schema + `remote_schema` + P1/P3 + `20260722`):**

| Column | Target value | Note |
|---|---|---|
| `id` | default (`uuid_generate_v4()`) | Omit from the column list. Never source's (spec 179). |
| `store_id` | `p_target_store_id` | |
| `catalog_id` | source's | Only if the catalog row is in the brand (D-3). |
| `cost_per_unit` | source's verbatim | `numeric(12,6)`, no math (spec 104). |
| `case_price` | source's verbatim | |
| `par_level`, `safety_stock`, `usage_per_portion` | source's | |
| `vendor_id` | **derived** (D-4) | |
| `current_stock`, `eod_remaining`, `average_daily_usage` | explicit `0` | |
| `expiry_date`, `last_updated_by`, `vendor_changed_at` | omit (null) | `trg_item_vendor_changed_at` is BEFORE UPDATE only, so insert doesn't stamp it. |
| `created_at`, `updated_at` | default | |

**Column disposition, `item_vendors` (all 10):** `id`, `created_at`, `updated_at` default; `item_id` the new item; `vendor_id`, `cost_per_unit`, `case_price`, `order_code`, `product_page_url` source's verbatim (null stays null); `is_primary` derived (D-4). Its FK is `on delete cascade`, and the (`item_id`, `vendor_id`) unique constraint plus D-4 mean `item_vendors_one_primary_per_item` can't fire.

**Not copied, because it's keyed to a store's history or out of scope:** `eod_entries`, `po_items`, `waste_log`, `inventory_count_entries`, `flags`, `store_count_layouts`, `user_count_*`, `order_schedule`. `items_last_counted` returns NULL for new rows, which correctly reads "never counted".

### 2. RLS impact

No policy is added or changed (AC-20). `permissive_policy_lint.test.sql` has nothing new to check and passes unmodified. Both RPCs are **SECURITY INVOKER** with `set search_path = public` (N1, the `create_inventory_item_with_catalog` precedent), so existing policies are a second check beneath the gates:

| Operation | Policy | Helper |
|---|---|---|
| read target/source | `store_member_read_stores` | `auth_can_see_store(id)` |
| read and insert items | `store_member_read/insert_inventory_items` | `auth_can_see_store(store_id)` |
| read and insert links | `store_member_read/insert_item_vendors` | `exists(... auth_can_see_store(ii.store_id))`, hence F-3 |
| read catalog, vendors | `brand_member_read_*` | `auth_can_see_brand(brand_id)` |
| read schedule | "Store members can read order_schedule" | `auth_can_see_store(store_id)` |
| write audit | `store_member_insert_audit_log` + three RESTRICTIVE policies from spec 170 | See D-8 |

**Why not DEFINER:** N1's one concern is resolved by F-4, and definer would drop RLS as a second check with nothing gained. A foreign vendor or catalog row is invisible to a brand admin and excluded by an explicit `brand_id` predicate for a super-admin, so the two arrive at the same result.

### 3. API contract: PostgREST RPC, two functions

No PostgREST table access (the write must be atomic, and the read needs set logic across the brand). Neither returns rows, so `max_rows` doesn't apply.

#### 3.1 Write

```
public.stock_store_from_store(
  p_target_store_id   uuid,
  p_source_store_id   uuid,
  p_extra_catalog_ids uuid[] default null
) returns jsonb
language plpgsql  volatile  security invoker  set search_path = public
```

Grants: `revoke all … from public, anon; grant execute … to authenticated;` (the [20261023000000:241-246](../supabase/migrations/20261023000000_catalog_eod_count_mode.sql) idiom; revoking `public` is load-bearing per spec 097).

**Gates, in this order, before any write.** Messages are byte-exact and pinned by `throws_ok`.

| # | Condition | SQLSTATE | Message |
|---|---|---|---|
| G-1 | `not auth_is_privileged()` | 42501 | `stock_store: privileged only` |
| G-2 | target or source null | 22023 | `stock_store: target and source store are required` |
| G-3 | target = source | 22023 | `stock_store: source and target must differ` |
| G-4 | `not auth_can_see_store(target)` | 42501 | `stock_store: target store not accessible` |
| G-4b | `not auth_can_see_store(source)` | 42501 | `stock_store: source store not accessible` |
| G-5 | either store row not found, or null brand | 22023 | `stock_store: store not found` |
| G-6 | brands differ | 22023 | `stock_store: stores must be in the same brand` |
| G-7 | `not auth_can_see_brand(brand)` | 42501 | `stock_store: brand not accessible` |
| G-8 | any tick null, not found, or in another brand | 22023 | `stock_store: catalog id not in this brand` |

Visibility precedes existence on purpose. A brand admin gets 42501 for both a missing and a foreign store, so no existence oracle. Only a super-admin, for whom G-4 is always true, can reach G-5. Tests pin both. Within one brand, a caller passing G-1 and G-7 sees every store, so AC-17's "sees target but not source" is exercised across brands and with the stale-JWT fixture (T-24 to T-26).

**Body after the gates:**

- **D-1. Serialize.** `perform pg_advisory_xact_lock(hashtext('stock_store:' || v_brand::text));` (hash idiom from [store_count_layouts:270](../supabase/migrations/20260706000000_store_count_layouts.sql)). Per brand, not per target, so the "carried by no store" check holds between runs on different targets. Taken after the gates so a refused caller holds nothing. Released at transaction end.
- **D-2. Why both a lock and ON CONFLICT.** Without the lock, two bulk inserts taking unique keys in different orders can deadlock (40P01): atomic, but an error on a legitimate click. With it, the second run waits and then, because READ COMMITTED re-snapshots each statement in a volatile function, sees the first run's rows and adds nothing. `on conflict (store_id, catalog_id) do nothing` stays, because `create_inventory_item_with_catalog` and direct inserts don't take the lock. A waiter is subject to PostgREST's `statement_timeout`, which fails atomically and can simply be retried.
- **D-3. Read the plan in one statement.** A single SELECT fills local typed arrays (`public.inventory_items[]`, `public.item_vendors[]`, `uuid[]`), so items and links share one snapshot and a concurrent edit at the source can't split a scalar from its links:
  - **eligible items:** source rows whose catalog row has `brand_id = v_brand`. A foreign-catalog row is ignored by both functions (T-13);
  - **total eligible count**, for `items_skipped`;
  - **items to add:** eligible, and the target has no row for that `catalog_id`;
  - **their links**, and which link vendors have `brand_id = v_brand`.
- **D-4. Derive the primary (F-6).** For each item, over its same-brand links only:
  1. if a link matches the source's `vendor_id`, that vendor (SD-1: the scalar wins);
  2. otherwise the link with `is_primary = true`;
  3. otherwise null.

  The target's `vendor_id` is that value, and each link's `is_primary` is `vendor_id = that value`. So a scalar with no link becomes null (AC-5), and a target never has a scalar without its link. A source with links but no primary and a null scalar copies as such: no primary is invented (T-11).
- **D-5. Insert items, statement 1.** `insert … select … from unnest(plan) on conflict (store_id, catalog_id) do nothing returning id, catalog_id, vendor_id`, captured into local arrays. Only returned rows get links (N3, AC-8).
- **D-6. Insert links, statement 2.** A separate statement (F-3), joining returned rows to plan items by `catalog_id` and plan links by source item id, keeping same-brand vendors only. Use `get diagnostics` for `links_added`. Cross-brand links on returned items count into `links_skipped_cross_brand`.
- **D-7. Uncarried ticks, statement 3.** For distinct ticked ids still carried by no store in the brand (`inventory_items` joined to `stores` on `brand_id = v_brand`, any status, evaluated now, after D-5): insert with the R-3 zeros, `on conflict do nothing`. `extras_skipped` = distinct ticks minus added. A tick the source also carries is copied in D-5 and counted as skipped here. A null or empty array is the same as no ticks (AC-16).
- **D-8. Audit, the RPC writes it (AC-21).** Atomic with the writes, and a client-side write could fail independently or fire on a refusal (the `copy_catalog_rows` precedent). Exactly one row when `items_copied + extras_added > 0`: `store_id` target, `user_id` `auth.uid()`, `action` `'Store stocked'`, `item_ref` source store's name, `detail` a readable count sentence (`Copied N items and L vendor links, skipped K; added E catalog rows, skipped F`), `value` total rows added as text. Omit `created_at`. This passes under INVOKER: `store_member_insert_audit_log` by target visibility; `…server_only_actions` because the action isn't listed; `…actor_is_caller` because `user_id = auth.uid()`; `…created_at_now` because the default applies before WITH CHECK ([spec 170](../supabase/migrations/20261022000000_audit_log_rls_hardening.sql)). `'Store stocked'` stays forgeable by a store member like most client-written actions, because adding it to the server-only list would need a policy change (AC-20) and would refuse this INVOKER writer.
- **D-9. Return.** Keys are pinned by T-2.

```
{
  "items_copied": int,
  "items_skipped": int,               -- eligible source rows the target already had
  "links_added": int,
  "links_skipped_cross_brand": int,   -- AC-18: skip, don't refuse
  "extras_added": int,
  "extras_skipped": int,
  "items_no_vendor_link": int,        -- every row added with no link, copied or ticked
  "target_has_order_schedule": bool,  -- AC-34
  "uncarried_remaining": int          -- AC-39: uncarried brand rows after this run
}
```

**AC-18 choice: skip and report.** One bad historical link shouldn't block stocking 149 items. An item whose only link is foreign counts as no-link. The runbook measures how many exist.

**Errors reach the client** as PostgREST errors with `code` and `message`. 42501 maps to HTTP 403 and 22023 to 400. Network and timeout errors go through `track`. A client-side abort after a server commit reads as a failure, but a re-run is harmless and reports 0 (AC-9).

#### 3.2 Read (N4)

```
public.stock_store_preview(
  p_brand_id        uuid,
  p_target_store_id uuid default null
) returns jsonb
language plpgsql  stable  security invoker  set search_path = public
```

Same grant idiom. Takes `p_brand_id`, because the create drawer has a brand but no store yet (AC-38), and the super-admin may be viewing a brand other than the current one (N4). One call returns every source's numbers, so picking a source costs no round trip. It's all one snapshot, and doesn't depend on the `inventory` or `catalogIngredients` slices.

**Gates.** G-1; null brand 22023 `stock_store: brand is required`; G-7; and if a target is given: not visible 42501 `stock_store: target store not accessible`, not in this brand 22023 `stock_store: target not in this brand`.

```
{
  "brand_id": uuid,
  "target_item_count": int | null,            -- null when no target
  "target_has_order_schedule": bool | null,
  "sources": [{                               -- brand stores with item_count >= 1, excluding the target, by name
    "store_id": uuid, "name": text, "status": text,
    "item_count": int,                        -- eligible rows (D-3)
    "items_to_add": int,
    "items_already_at_target": int,           -- to_add + already = item_count
    "items_no_vendor_link": int,              -- among to_add, with no same-brand link
    "carried_elsewhere_count": int            -- AC-30: rows other brand stores carry that neither source nor target has
  }],
  "uncarried": [{                             -- catalog rows carried by no store in the brand, any status, by name
    "catalog_id": uuid, "name": text, "unit": text, "category": text | null, "i18n_names": jsonb
  }]
}
```

Inactive stores are included with `status`, so the dialog can label them (R-3 counts inactive stores; AC-28 doesn't exclude them). The numbers are duplicated logic by necessity, so **T-34 runs the preview and then the write and asserts every number agrees**.

### 4. Edge function changes

None. No `verify_jwt` change.

### 5. `src/lib/db.ts` surface

Both use `useInflight.getState().track` and `.abortSignal(signal)`, and throw on error. Mappers are exported for unit tests, snake_case to camelCase, with `Number()` on counts. Types are exported from `db.ts` (the `PoLine` / `OrderApproval` precedent).

```ts
export interface StockSourceOption {
  storeId: string; name: string; status: string;
  itemCount: number; itemsToAdd: number; itemsAlreadyAtTarget: number;
  itemsNoVendorLink: number; carriedElsewhereCount: number;
}
export interface UncarriedCatalogRow {
  catalogId: string; name: string; unit: string; category: string | null;
  i18nNames: Record<string, string>;   // feeds getLocalizedName(row, locale)
}
export interface StoreStockPreview {
  brandId: string; targetItemCount: number | null; targetHasOrderSchedule: boolean | null;
  sources: StockSourceOption[]; uncarried: UncarriedCatalogRow[];
}
export interface StockStoreResult {
  itemsCopied: number; itemsSkipped: number; linksAdded: number;
  linksSkippedCrossBrand: number; extrasAdded: number; extrasSkipped: number;
  itemsNoVendorLink: number; targetHasOrderSchedule: boolean; uncarriedRemaining: number;
}

export async function fetchStoreStockPreview(
  brandId: string, targetStoreId?: string | null,
): Promise<StoreStockPreview>;   // kind 'read', label 'fetchStoreStockPreview'

export async function stockStoreFromStore(
  targetStoreId: string, sourceStoreId: string, extraCatalogIds?: string[],
): Promise<StockStoreResult>;    // kind 'write', label 'stockStoreFromStore'; [] is sent as null
```

**Two existing helpers change:**

- **D-13. `fetchAllForStore`** ([db.ts:5894](../src/lib/db.ts)) stops discarding the failure: the catch sets a local flag and still returns `[]`, and the result gains `inventoryFailed: boolean`. Replacing the slice with `[]` on failure stays as is (surfaced as a follow-up in section 11).
- **D-14. `fetchInventory()` with no `storeId`** (F-2) pages by keyset: `.order('id').limit(1000)`, then `.gt('id', lastId)`, until a page comes back short, concatenating the rows. **Superseded (release fixes, 2026-11-07, architect S-1):** the loop stops on an EMPTY page, so a server cap below 1000 still reads everything; every load costs one extra empty request. Keyset rather than `.range()` so a row inserted mid-read can't shift a page into a duplicate or a miss. Each page goes through `track`. `fetchInventory(storeId)` stays one unchanged request: a single store can't exceed the catalog size, and [db.eodCountMode.test.ts](../src/lib/db.eodCountMode.test.ts) pins that chain. Below 1000 rows, the only change is that an exactly-1000-row page costs one extra empty request.

### 6. Frontend store impact ([src/store/useStore.ts](../src/store/useStore.ts))

```ts
addStore: (store: Omit<Store, 'id'>) => Promise<string | null>;   // never rejects
loadStoreStockPreview: (brandId: string, targetStoreId?: string | null) => Promise<db.StoreStockPreview | null>;
stockStoreFromStore: (targetStoreId: string, sourceStoreId: string, extraCatalogIds?: string[]) => Promise<db.StockStoreResult | null>;
inventoryLoadStatus: 'unknown' | 'loaded' | 'failed';
```

**D-10. `addStore` keeps optimistic-then-revert (AC-40), the spec 155 `updateStore` contract.** It appends the temp row and returns the `db.createStore` promise.

- **On success:** remove the temp row by id, add the real row unless present, and resolve the id. Don't just `map` as today: a `loadFromSupabase` in flight does `set({ stores: cloudStores })`, which replaces the array and drops the temp row, so a bare `map` would lose the store from the slice until the next load. T-J4 pins this.
- **On failure:** filter out the temp row by id (not a snapshot, for the same reason), call `notifyBackendError('Create store', e)`, and resolve `null`. The `console.warn` path goes.
- **Callers:** `StoreFormDrawer` is the only one in `src/` (grep), and it now awaits. The temp id never leaves the slice, because the drawer only passes the resolved id to the RPC.

**D-11. Stocking is deliberately not optimistic.** The server computes which rows are added, their ids and their derived primaries, and the client can't predict them for a run on another store. `stockStoreFromStore` awaits the RPC.

- **On success:** if `itemsCopied + extrasAdded > 0`, fire `void get().loadFromSupabase(get().currentStore?.id)` whichever store is current (F-7), then resolve the result. A same-store reload keeps the reorder slice (spec 175).
- **On zero rows added:** no reload.
- **On failure:** `notifyBackendError('Stock store', e)`, resolve `null`, no reload, nothing to revert (AC-35).

`loadStoreStockPreview` catches, notifies with `'Load stock options'`, and resolves `null`. Preview data stays in component state, not the store; it's only meaningful while a dialog is open.

**N5. `inventoryLoadStatus`.** `'unknown'` at init and in the identity-reset block ([useStore.ts:1275](../src/store/useStore.ts)). `loadFromSupabase` sets `data.inventoryFailed ? 'failed' : 'loaded'` in the same `set` as `inventory`, so a load dropped by spec 176 R-3 writes neither. The `__all__` branch sets `'failed'` if any entry is null or flagged. The outer `catch` doesn't write it, since prior state is kept there. Test mocks that omit the flag read as loaded, so existing suites aren't disturbed.

#### D-12. EOD empty state

New pure module `src/lib/eodEmptyState.ts`, beside `eodDayStatus.ts`:

```ts
export type EodEmptyState =
  | 'none' | 'loading' | 'load_failed'
  | 'no_items'                    // S1
  | 'no_vendor_links'             // S2
  | 'vendors_unresolved'
  | 'no_scheduled_vendors'        // S3
  | 'scheduled_vendors_no_items'; // S4

export function deriveEodEmptyState(input: {
  vendorTabsCount: number; allVendorTabsCount: number;
  storeItemCount: number;
  storeItemsWithLinkCount: number;     // from item vendorIds, NOT allVendorTabs (F-9)
  scheduleConfigured: boolean; dayScheduledVendorCount: number;
  inventoryLoadStatus: 'unknown' | 'loaded' | 'failed'; storeLoading: boolean;
}): EodEmptyState;
```

First match wins:

| Order | Condition | State | Desktop message | Toggle |
|---|---|---|---|---|
| 1 | `vendorTabsCount > 0` | `none` | none | as today |
| 2 | status `failed` | `load_failed` | new `section.eod.itemsNotLoaded` | hidden |
| 3 | status `unknown`, or `storeLoading` with no items here | `loading` | none | hidden |
| 4 | no items | `no_items` (S1) | `noItemsAtStore` | hidden |
| 5 | items, none linked | `no_vendor_links` (S2) | `noVendorLinksAtStore` | hidden |
| 6 | linked, but `allVendorTabsCount = 0` | `vendors_unresolved` | existing `noVendorsAtStore` | hidden |
| 7 | no vendor scheduled for the day | `no_scheduled_vendors` (S3) | existing `noVendorsScheduled` | shown |
| 8 | otherwise | `scheduled_vendors_no_items` (S4) | new `scheduledVendorsNoItems` | shown |

- **N5 is answered by rows 2 and 3.** A failed fetch never reaches S1. `itemsNotLoaded` ("items for this store could not be loaded; reload to try again") is one key beyond AC-22's list. AC-22 scopes to "inventory has loaded", so this fills the unspecified state rather than changing a specified one.
- **AC-23.** S2 needs zero linked items, so the prod norm of 2 unlinked per stocked store never triggers it.
- **Toggle:** `scheduleConfigured && allVendorTabs.length > 0`.
- **AC-24: reset.** `useEffect(() => setShowUnscheduled(false), [currentStore.id])`, because the toggle is a per-view escape hatch and "keep" would silently widen the next store. Also `disabled={showUnscheduled && allVendorTabs.length > 0}` on `+ vendor`, so a same-store change (all items removed under realtime) can't strand it either.
- **N6.** With no vendor selected, `grouped` is empty and the body prints `noItemsInFilter` ("no items in this filter") under the column header, at [EODCountSection.tsx:1950-1983](../src/screens/cmd/sections/EODCountSection.tsx). That's the conflicting second message. When the state isn't `none` and `filteredItems` is empty, render neither the header nor that text. `additionalItems` from `+ COUNT` still render.
- **Phone.** `PhoneEodModel` gains an **optional** `eodEmptyState?: EodEmptyState`, so test fixtures typed against the model still pass `typecheck:test`. At [PhoneEodCount.tsx:394-397](../src/screens/cmd/sections/eod/PhoneEodCount.tsx), when `filteredItems` is empty: `no_items`, `no_vendor_links` and `load_failed` show their message, and everything else keeps `noVendorsAtStore`. A search filter at a stocked store has state `none`, so it's unchanged. `isRestDay` is checked first, so the rest-day panel is unchanged too (AC-26). This does mean an empty store on a rest weekday shows the rest panel on phone. That's what AC-26 asks for.

**i18n.** Four new keys under `section.eod` in all three locales: `noItemsAtStore`, `noVendorLinksAtStore`, `scheduledVendorsNoItems` (`{day}`), `itemsNotLoaded`. Also `enum.auditAction.storeStocked`. The drawer and `StoresTab` are hardcoded English by design ([StoreFormDrawer.tsx:369-370](../src/components/cmd/StoreFormDrawer.tsx)), and AC-25 only names EOD keys, so the dialog follows its neighbours, except that uncarried names go through `getLocalizedName`.

**Audit surface.** Add `'Store stocked'` to the `AuditAction` union ([types/index.ts:634](../src/types/index.ts)), `KEY_BY_ACTION` ([formatAuditAction.ts:11](../src/utils/formatAuditAction.ts); `enumLabels.test.ts` catches drift), `ACTION_TONE` in `AuditLogSection` and `PhoneAuditLog`, and `inferKind` as `'stock'`.

#### UI contract

- **`StockStoreDialog`** (new, `src/components/cmd/StockStoreDialog.tsx`, in `ResponsiveSheet`). Opens with `{ store, brandId }` and calls `loadStoreStockPreview(brandId, store.id)` on each open. On `null`: an inline "could not load" message with no submit. Empty `sources`: AC-29 message, no picker, no uncarried list, no submit. Selected source: AC-30 lines from that source's numbers, phrased "{itemsToAdd} will be added; {itemsAlreadyAtTarget} of {itemCount} are already at {target}". No submit when `itemsToAdd === 0` and nothing ticked (AC-31). A `useRef` in-flight guard makes a second press a no-op (AC-35). Success closes the dialog and hands the result up; failure leaves it open with picks intact.
- **Result panel: in `StoresTab`, not a toast.** State `stockResult` renders a dismissible panel (`testID="store-stock-result"`). Toasts vanish, and the AC-34 no-schedule warning is the most important line on the screen. Both the dialog and the drawer report through it, so AC-42's "same content" holds by construction. Message text comes from a pure `buildStockResultLines(result, { sourceName, targetName })` in `src/utils/stockResult.ts`, unit-tested for the zero-count hiding in AC-33 and for never implying a full catalog (R-5).
- **`StoreFormDrawer` create mode.** On open, `loadStoreStockPreview(brandId)`; edit mode never calls it. `stockChoice: null | 'none' | storeId`, starting `null`.
  - `REQUIRED_FIELDS` is 3 when `sources.length > 0`, else 2.
  - While the preview is pending, CREATE is disabled and the footer stays `n/2`, so a press can't race the list.
  - On preview failure the field is hidden, the footer stays at 2, and an inline note says to use `STOCK` afterward. A failed read mustn't block creating a store.
  - `handleSave`: `const id = await addStore(payload)`. `null` means return, drawer open (AC-40). Then if a source was chosen, `await stockStoreFromStore(id, source)`. `null` means "created but not stocked; use STOCK to retry" (AC-41). Then `onCreated?.({ …, result })`, then `onClose()`. The drawer closes on AC-41 because a second CREATE would make a duplicate store.
  - AC-39's count comes from `result.uncarriedRemaining`, or from `preview.uncarried.length` on "Don't stock yet".
- **AC-43.** Awaiting `addStore` before `onClose` removes the race on the normal path. Two more guards: while `submitting`, the drawer's close paths (CANCEL, esc, sheet dismiss) are inert, and `StoresTab.refresh` gets a generation ref so an older response can't overwrite a newer one. The `[refresh, drawerOpen]` effect itself stays.

### 7. Realtime impact

**No publication change, so the `docker restart supabase_realtime_imr-inventory` step does not apply.** `inventory_items` and `item_vendors` are already members, and `audit_log` isn't ([20260514140000:44](../supabase/migrations/20260514140000_realtime_publication_tighten.sql), [item_vendors.sql:172](../supabase/migrations/20260630000000_item_vendors.sql)).

One run on 149 items is about 149 `inventory_items` plus 150 to 300 `item_vendors` inserts, committed together:

- **Who receives what.** `inventory_items` reaches only clients viewing the target (`store-{target}`, filtered). `item_vendors` reaches **every** admin client (unfiltered). `brand-{id}` is untouched: no catalog, vendor or recipe row changes. The staff stack has no realtime in v1.
- **Reload cost.** [CmdNavigator.tsx:64-71](../src/navigation/CmdNavigator.tsx) is a trailing debounce: each event resets the 400 ms timer, so a burst ends in one `loadFromSupabase` per client, 400 ms after the last delivered event, and spec 176's generation guard handles overlap. The acting client reloads twice (explicit, then the echo), which is harmless.
- **Not measured.** Realtime re-checks RLS per subscriber and per event, and hosted plans have per-second event limits. Several hundred events across a few admins is small, but this repo can't show how prod behaves at the limit. The design doesn't depend on delivery: the acting client's reload is explicit, and a missed event on another client self-heals on its next load. Record what the preview shows (spec's Realtime burst risk).
- **Other admins' screens** do the full reload once, including all-store inventory. D-14 keeps that correct past 1000 rows but not cheap, an existing posture this feature adds to.

### 8. pgTAP plan: new file `supabase/tests/stock_store_from_store.test.sql`

Hermetic (`begin … rollback`). Use **fresh fixture stores** in the seed 2AM brand and a second brand, not seed stores (the local seed says `Reisters`, not `Reisterstown`, and has its own 564 rows). Fixture vendors must be selected with `brand_id` filters; the older tests' `vendors order by id` isn't safe here. Set `authenticated` plus `request.jwt.claims`. Don't `set role anon` (spec 067 segfault); use `has_function_privilege`. Fixture callers: brand admin, other-brand admin, `role='user'` with `user_stores` on both, super-admin, and a stale-JWT caller. Each gets an anti-vacuity probe of `auth_can_see_store` before its refusal case.

| T | Asserts | AC |
|---|---|---|
| 1 | `columns_are` on `inventory_items` and `item_vendors`: a future column forces a copy-or-reset decision. | R-2 |
| 2 | Empty target from N items: N rows, exact jsonb keys and values. | 1 |
| 3 | Per field on a copied row, from a source with non-zero stock, `eod_remaining`, `average_daily_usage`, `expiry_date`, `last_updated_by`, `vendor_changed_at`, and a 6-decimal cost. | 2 |
| 4 | New ids differ from source ids. | 3 |
| 5 | **Under `authenticated`:** two-link item gets two links, matching cost, case price, `order_code`, `product_page_url`; exactly one primary equal to `vendor_id`; link ids and `item_id` fresh. | 4, F-3 |
| 6 | No-link item: no links, null `vendor_id`, counted. Also a scalar with no link: null at target. | 5, F-6 |
| 7 | Staff read shape (`item_vendors` inner-joined to `inventory_items` on the target) returns copied linked items, not the no-link one. | 5, 6 |
| 8 | Source rows and links byte-equal before and after (`row_to_json` comparison). | 7 |
| 9 | Partly stocked: existing row keeps par, cost, case price, stock, vendor and a differing link set; counts correct. | 8 |
| 10 | Identical second run adds 0 and changes nothing; no second audit row. | 9, 21 |
| 11 | D-4 drift: scalar V1 with primary flagged on V2 gives V1 primary; links with no primary and a null scalar give no primary and null. | R-2, F-6 |
| 12 | A then B: {1,2,3}, item 2 keeps A's values, second run reports 1 copied, 1 skipped. | 10 |
| 13 | Foreign-catalog source row isn't copied, and the preview agrees. | D-3 |
| 14 | **Forced failure:** a test-only `before insert` trigger on `item_vendors` raising on a marker `order_code`. `throws_ok`, then 0 new items, 0 new links, 0 audit rows. | 11 |
| 15 | Source with no items, no ticks: zeros, nothing written. | 12 |
| 16 | **Conflict arm:** a test-only BEFORE INSERT trigger on `inventory_items` (guarded by `pg_trigger_depth()`) inserts the same `(store, catalog)` first, simulating a concurrent writer. That row is counted as skipped and gets **no** links. | N3, 8 |
| 17 | Ticked uncarried row: R-3 zeros, no links, null vendor; non-zero `default_cost` fixture proves it's unused. | 13 |
| 18 | Tick now carried at another store, at the target, or at an inactive store: added 0, skipped 1, rest proceeds. | 14 |
| 19 | Tick from another brand, nonexistent, or null element: 22023, nothing written. | 15 |
| 20 | Null and `'{}'` ticks equal no ticks; duplicate ticks add one. | 16 |
| 21 | `role='user'` with `user_stores` on both: 42501 G-1, with a probe showing `auth_can_see_store` true on both. | 17 |
| 22 | Other-brand admin: 42501, with a false probe. | 17 |
| 23 | Brand admin, missing store: 42501. Super-admin, missing store: 22023 G-5. | 17 |
| 24, 25 | Sees target, not source, and the reverse (brand admin, stores across brands): G-4 / G-4b. | 17 |
| 26 | Stale JWT `admin` on a `role='user'`, null-brand profile with `user_stores` on both: passes G-1 and G-4, refused at G-7. | F-4 |
| 27 | Different brands as super-admin: 22023 G-6. | 17 |
| 28 | Same id: G-3. Null source with ticks: G-2. | 17 |
| 29 | `col_not_null('public','stores','brand_id')`. | 17, F-5 |
| 30 | Cross-brand link not copied, counted, `vendor_id` null when it was the only link. | 18 |
| 31 | `anon` and `PUBLIC` lack EXECUTE, `authenticated` has it, one overload each, `proconfig` has `search_path=public`, `prosecdef` false; preview `provolatile = 's'`; `order_schedule` count unchanged. | 19 |
| 32 | Delete a stocked item at the target, re-run: returns under a new id, no 42501. PO at the target accepts the copied row and refuses the source's row (42501 `po_items: item store mismatch with parent purchase order`). | 20 |
| 33 | One `audit_log` row naming source and counts on a real add; zero on refusal (T-14 too) and on a no-op. | 21 |
| 34 | **Parity:** preview numbers for a source equal the write's result, and `carried_elsewhere_count` and `uncarried` are right on a three-store fixture. | N4 |
| 35 | Preview: excludes target and 0-item stores; includes inactive stores with `status`; a row at an inactive store isn't uncarried; gates 42501 / 22023; no target gives null target fields. | 28, 32 |

Existing suites that must pass **unmodified**: `inventory_items_identity_lock`, `cross_store_item_rejection`, `public_grants_explicit`, `permissive_policy_lint` (AC-20).

**Concurrency can't be proven in a single pgTAP session.** T-16 covers the conflict arm. In addition, the build records a manual two-`psql` probe on the local stack in the review notes: session 1 `begin`, call, hold; session 2 same call blocks; session 1 commits; session 2 returns 0 added with no error and no duplicates.

### 9. Jest plan

| File | Covers |
|---|---|
| `src/lib/db.stockStore.spec184.test.ts` (new) | Wrapper RPC names and arg names, `[]` sent as null, mapper camelCase and `Number()`, throw on error (AC-36). |
| `src/lib/db.fetchInventoryPaging.spec184.test.ts` (new) | No-store path pages by keyset and concatenates past 1000; store path issues one request (D-14). `inventoryFailed` true on a rejected fetch (N5). |
| `src/store/useStore.addStore.spec184.test.ts` (new) | Real id; failure removes the temp row, notifies, resolves null, never rejects; **T-J4** a mid-flight reload dropping the temp row still ends with exactly one real row. |
| `src/store/useStore.stockStore.spec184.test.ts` (new) | Reloads once on rows added, including when target isn't current; no reload on zero or failure; failure notifies and resolves null; `inventoryLoadStatus` loaded, failed, `__all__`, and unwritten on a stale drop. |
| `src/lib/eodEmptyState.test.ts` (new) | Every row of the D-12 table and each precedence pair. |
| `EODCountSection.emptyState.spec184.test.tsx` (new) | AC-22, AC-23, AC-24 (toggle on, switch store, `+ vendor` enabled, toggle hidden, return gives toggle off), N5 (failed load never shows S1), N6 (`noItemsInFilter` absent in each state). |
| `PhoneEodCount` test (new or extended) | AC-26. |
| `StockStoreDialog.test.tsx` (new) | AC-27 to AC-32, AC-35, AC-37. |
| `StoresTab.stock.spec184.test.tsx` (new) | AC-27 button, AC-33/34 panel, AC-43 stale-refresh guard. |
| `src/utils/stockResult.test.ts` (new) | AC-33, AC-34, AC-39, R-5 copy. |
| `StoreFormDrawer.test.tsx` (**edit**) | AC-38 to AC-42. |

**Old tests the rework breaks, deliberately:**

- [StoreFormDrawer.test.tsx:48-58](../src/components/cmd/StoreFormDrawer.test.tsx) mocks `addStore = jest.fn()`, resolving `undefined`, which now reads as failure. It needs `.mockResolvedValue('new-id')`, a `loadStoreStockPreview` on the mock state, and `open()` must settle the preview before pressing CREATE, because many tests press synchronously. The `n/2` strings stay valid when the mock returns no sources; keep them byte-identical.
- The `StoresTab.*` mocks expose only `updateStore`. The preview effect runs only when the drawer is visible in create mode, so they should be unaffected. Verify.
- Run full `npx jest`, both typechecks and `scripts/test-db.sh` (AC-44).

### 10. Prod apply runbook (AC-46). Execute only on the owner's explicit go-ahead, BEFORE the push. Not part of this pipeline.

Project `ebwnovzzkwhsdxkpyjka`, MCP `execute_sql`. Not `apply_migration`, which mints its own version.

**M-1.** Apply the committed file locally, recompute both normalized md5s, and confirm they equal the values recorded under `## Files changed`.

**Prod data has changed since this runbook was written.** A separate one-time data change (2026-11-05/06) copied Charles's 149 items and 154 vendor links into Kenyon and H Street. Expect about 882 `inventory_items` rows (584 + 2 x 149, an estimate, not a measurement), and do not assume any store is empty. Neither probe below depends on an empty store.

**Step 1: read-only pre-check.** STOP on anything unexpected.
- `select version()` shows 17.x. `schema_migrations` has `20261027000000` and nothing at or after this version.
- `to_regprocedure` for both new signatures is NULL.
- `pg_trigger` on `inventory_items` shows exactly the five in section 0, all `O`. None on `item_vendors`.
- `inventory_items_store_catalog_unique` exists.
- `supabase_realtime` is not `puballtables`; `inventory_items` and `item_vendors` are members.

Report only, not a STOP; these size D-4, AC-18 and D-3:
```sql
select count(*) from public.item_vendors iv join public.inventory_items ii on ii.id = iv.item_id
  join public.stores s on s.id = ii.store_id join public.vendors v on v.id = iv.vendor_id
 where v.brand_id <> s.brand_id;                                   -- cross-brand links
select count(*) from public.inventory_items ii join public.stores s on s.id = ii.store_id
  join public.catalog_ingredients c on c.id = ii.catalog_id
 where c.brand_id <> s.brand_id;                                   -- foreign-catalog rows
select count(*) from public.inventory_items ii
 where ii.vendor_id is not null and not exists (select 1 from public.item_vendors iv
   where iv.item_id = ii.id and iv.vendor_id = ii.vendor_id);      -- scalar with no link
select count(*) from public.item_vendors iv join public.inventory_items ii on ii.id = iv.item_id
 where iv.is_primary and iv.vendor_id is distinct from ii.vendor_id; -- primary differs from scalar
select count(*) from public.inventory_items;                       -- distance to the F-2 cap (~882 expected)
```
Also report, not a STOP: prod's PostgREST `max_rows`, from the dashboard (Project Settings, Data API, Max rows) or the Management API `GET /v1/projects/ebwnovzzkwhsdxkpyjka/postgrest` (`max_rows`). D-14 now stops on an empty page, so any value reads correctly; the number only says how many requests a load costs.

**Step 2 (S-1): apply.** The full committed file, line 1 to the final `commit;`, as one `execute_sql` call. On `55P03` nothing was created; re-run off-peak.

**Step 3 (M-2): record,** as a separate call:
```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20261105000000', 'stock_store_from_store') on conflict (version) do nothing;
select version, name from supabase_migrations.schema_migrations where version = '20261105000000';
```

**Step 4: verify.** Normalized md5s equal M-1, using the spec 179 §10 Step 4 query shape, with `public.stock_store_from_store(uuid,uuid,uuid[])` and `public.stock_store_preview(uuid,uuid)`. `pg_proc`: `prosecdef` f on both, `proconfig` `{search_path=public}`, owner postgres, one row each; `anon_x` false, `auth_x` true, no PUBLIC entry in `proacl`. `pg_policies` and publication membership unchanged from Step 1.

**Step 5 (S-2): raise-always probes, no placeholders.** Each is one `execute_sql` DO block that ends in an exception on every path, so nothing persists and nothing reaches the WAL's committed stream.

Probe 1, refusal (no claims, so `auth_is_privileged()` is false):
```sql
do $$
declare v_s1 uuid; v_s2 uuid;
begin
  select s1.id, s2.id into v_s1, v_s2 from public.stores s1
    join public.stores s2 on s2.brand_id = s1.brand_id and s2.id <> s1.id
   order by s1.id, s2.id limit 1;
  if v_s1 is null then raise exception 'PROBE SKIPPED: no two stores share a brand'; end if;
  begin
    perform public.stock_store_from_store(v_s1, v_s2, null);
  exception when sqlstate '42501' then
    if sqlerrm = 'stock_store: privileged only' then raise exception 'PROBE OK: %', sqlerrm; end if;
    raise exception 'PROBE FAILED: unexpected 42501: %', sqlerrm;
  end;
  raise exception 'PROBE FAILED: an unprivileged call was not refused';
end $$;
```

Probe 2, rehearsal against a synthetic store. Finds the store with the most items in a brand, and the real super-admin profile id for `auth.uid()`:
```sql
do $$
declare v_uid uuid; v_src uuid; v_brand uuid; v_tgt uuid; v_r jsonb; v_bad int;
begin
  select id into v_uid from public.profiles where role = 'super_admin' order by id limit 1;
  if v_uid is null then raise exception 'PROBE SKIPPED: no super_admin profile'; end if;
  select ii.store_id, s.brand_id into v_src, v_brand
    from public.inventory_items ii join public.stores s on s.id = ii.store_id
   group by 1, 2 order by count(*) desc, 1 limit 1;
  if v_src is null then raise exception 'PROBE SKIPPED: no stocked store'; end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  insert into public.stores (brand_id, name, address)
  values (v_brand, 'spec184 probe ' || gen_random_uuid()::text, '1 Probe Way')
  returning id into v_tgt;
  v_r := public.stock_store_from_store(v_tgt, v_src, null);
  select count(*) into v_bad from public.inventory_items t
   where t.store_id = v_tgt
     and (t.current_stock <> 0 or t.eod_remaining <> 0 or t.average_daily_usage <> 0
          or t.expiry_date is not null or t.last_updated_by is not null
          or (t.vendor_id is not null and not exists (select 1 from public.item_vendors iv
                where iv.item_id = t.id and iv.vendor_id = t.vendor_id and iv.is_primary)));
  if v_bad > 0 then raise exception 'PROBE FAILED: % rows break R-2', v_bad; end if;
  if (v_r->>'items_copied')::int < 1 then raise exception 'PROBE FAILED: copied nothing: %', v_r; end if;
  if (select count(*) from public.audit_log where store_id = v_tgt and action = 'Store stocked') <> 1 then
    raise exception 'PROBE FAILED: expected one audit row';
  end if;
  raise exception 'PROBE OK: %', v_r;
end $$;
```
This runs as `postgres`, so it proves the function body, not the RLS path; T-5 proves that. `PROBE FAILED` means STOP and do not push. `PROBE SKIPPED` means the probe's precondition doesn't exist on prod, so it proved nothing either way: it is not a pass. Report it to the owner and continue only on their say-so. Confirm afterward that no store named `spec184 probe%` exists.

**Step 6: commit, push, then gates.** Stage spec 184's files by explicit path, never `git add -A` or `git add .`. `supabase/tests/order_approvals_fk_set_null.test.sql` is another spec's untracked file that fails 8 of 12 assertions; it must not go in this commit, or `test.yml` turns red. After the push, confirm the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green, and check `e2e.yml` by hand (not yet a formal gate). Pushing before Step 3 turns `db-migrations-applied.yml` red. The frontend is safe to ship any time after Step 3, and the migration is unused until it does.

**Rollback before the push:** `drop function public.stock_store_from_store(uuid,uuid,uuid[]); drop function public.stock_store_preview(uuid,uuid);`, then delete the version row. The new UI would then fail visibly through `notifyBackendError`.

**Rollback after the push:** don't delete the version row: the migration file is on `main`, so `db-migrations-applied.yml` would fail. Write a forward migration that drops both functions, apply and record it the same way, and revert or hide the UI in the same push.

### 11. Risks and tradeoffs

**Migration and rollout**
- **Ordering.** No dependency beyond `20261026100000` and `20261025000000`, both already on prod per their runbooks; Step 1 confirms. N7 still applies if another migration lands first.
- **D-14 is approved by the owner (2026-11-05): build it in this spec.** It widens the spec by one small change in a shared read path. Without it, the first store past 1000 total rows silently corrupts what every admin sees. With it, the regression surface is the no-filter path of `fetchInventory`, covered by a new test.

**RLS and auth**
- **Stale admin JWT with a matching brand.** A demoted user whose token still says `admin` and whose `brand_id` matches passes every gate until the token expires. Same exposure as every `auth_is_privileged()` policy; not new.
- **Forgeable audit action.** See D-8.

**Performance**
- **Not measured.** Each inserted row runs the RLS check, FK checks, and for items `inventory_items_check_tombstone`. At about 150 items and 300 links that's a few thousand index lookups, expected well inside PostgREST's statement timeout and the 30-second `track` abort. The 286 KB seed (about 564 items) is a fair test. Record the timing in the preview notes.
- **The preview** runs set logic across the brand's stores, about 7 stores and 900 rows, once per dialog open.
- **All-store reload.** Paging means more requests per load once past 1000 rows, on every 400 ms-debounced reload for all admins. It's correct but gets heavier. A store-scoped inventory load is the real fix, but `InventoryCatalogMode`'s cross-store grouping depends on the current shape, so it isn't in this spec.
- **Edge cold start:** not applicable.

**Behavior worth the owner's attention, none of it blocking**
- **US Foods account number at a new store.** `vendors.import_customer_numbers` is a per-store map keyed by store id, falling back to the brand's `account_number` ([20260713000000](../supabase/migrations/20260713000000_vendor_import_customer_numbers.sql)). That migration exists because the fallback stamps "the wrong account". A freshly stocked store can now export a US Foods Import-Order file under the fallback number until someone adds its entry. **D-15, owner-approved (2026-11-05): the stocking result warns about this.** Show one line in the result (dialog and create-and-stock alike) when a vendor linked by the target store's items has a non-empty `import_customer_numbers` map with no entry for the target store. Compute it client-side from the vendors already in the slice, with no RPC change (**superseded:** the slices can't serve this, so `StoresTab` reads `db.fetchInventory(target)` and `db.fetchVendors(brandId)` instead; see the frontend deviations, accepted in the architect's post-impl review); if the vendor mapping doesn't expose that column, the frontend or backend developer adds it to the mapper. Name the vendor(s) in the line. Jest covers warn, no-warn (entry exists), and no-warn (empty or null map, which is a vendor with no per-store numbers).
- **"Updated" badge on first count.** `staff_items_updated` flags a never-counted item whose catalog row has an `image_changed_at`, per spec 128 ([20260817000000:27-31](../supabase/migrations/20260817000000_items_last_counted.sql)). Staff at a new store will see that badge on any ingredient whose photo ever changed, until the first count. Cosmetic.
- **`pwa-catalog`** serves the target's rows as soon as they commit, with `current_stock` 0. The customer PWA is a sibling app and its handling wasn't checked.
- **Failed inventory load still blanks the worksheet.** D-13 makes this honest rather than changing it. Keeping prior rows on a failed reload would be better, but it's a separate behavior change.
- **`breadbot-nightly-sync` looks already broken,** unrelated to this spec: it selects `unit, sub_unit_size, sub_unit_unit` from `inventory_items` ([index.ts:321](../supabase/functions/breadbot-nightly-sync/index.ts)), columns P3 dropped. Not touched, and it has no interaction with stocking.

**Design tradeoffs**
- **Duplicated rules between preview and write,** mitigated by T-34. A shared SQL helper would add a third granted function for little gain.
- **Brand-wide lock.** Two admins stocking different stores in one brand wait on each other for under a few seconds. Rare, and it buys the write-time truth of "carried by no store".
- **A small window remains** between the preview's numbers and the write. The write is authoritative, and the result panel reports what actually happened.

### 12. Build split

To avoid two developers editing one file in parallel:

- **backend-developer:** the migration, `stock_store_from_store.test.sql`, the `db.ts` changes (section 5), the `useStore.ts` changes (section 6), `src/lib/eodEmptyState.ts`, and their jest files. Records both md5s under `## Files changed`, and the concurrency probe and timing.
- **frontend-developer:** `StockStoreDialog`, `src/utils/stockResult.ts`, `StoreFormDrawer`, `StoresTab`, `EODCountSection`, `PhoneEodCount`, the i18n keys, the audit surface, their jest files, and the AC-45 browser pass (promoting a local user per F-10).

The frontend codes against the signatures above and can mock the slice until the backend lands. Neither applies anything to prod.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec (## Backend design). Section 12 sets who owns which files. D-14 (fetchInventory keyset paging) is a design-added requirement the owner may veto, so confirm it with main Claude before starting. Do not apply anything to prod; section 10 runs only on the owner's go-ahead. Leave supabase/tests/order_approvals_fk_set_null.test.sql alone. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed, with the two normalized md5s.
payload_paths:
  - specs/184-stock-new-store.md

## Files changed

Both halves have landed. Status is `READY_FOR_REVIEW`. The AC-45 browser pass is still outstanding: main Claude runs it and records it here.

### Backend (section 12)

**Migration**
- `supabase/migrations/20261105000000_stock_store_from_store.sql` (new). Slot re-checked before naming: newest on disk was `20261027000000`. Applied to the local DB only, not prod.

**pgTAP**
- `supabase/tests/stock_store_from_store.test.sql` (new, 196 assertions)

**`src/lib`**
- `src/lib/db.ts`: stock wrappers, types and mappers (section 5), `fetchInventory()` keyset paging (D-14), `fetchAllForStore` `inventoryFailed` (D-13). The vendor mapper already exposes `importCustomerNumbers`, so D-15 needed no db.ts change.
- `src/lib/eodEmptyState.ts` (new, D-12)
- `src/lib/eodEmptyState.test.ts` (new)
- `src/lib/db.stockStore.spec184.test.ts` (new)
- `src/lib/db.fetchInventoryPaging.spec184.test.ts` (new)

**`src/store`**
- `src/store/useStore.ts`: `addStore` returns a promise (D-10), `loadStoreStockPreview`, `stockStoreFromStore` (D-11), `inventoryLoadStatus` (N5)
- `src/store/useStore.addStore.spec184.test.ts` (new)
- `src/store/useStore.stockStore.spec184.test.ts` (new)

### Normalized md5s (M-1)

Local, from the committed file applied verbatim with `docker exec -i supabase_db_imr-inventory psql`, using the spec 179 §10 Step 4 query shape.

| Function | Normalized md5 |
|---|---|
| `public.stock_store_from_store(uuid,uuid,uuid[])` | `f9d3fc9a3ee14f3e25073efa8499e23c` |
| `public.stock_store_preview(uuid,uuid)` | `a427ea80fb24f7ff291df57a75ab1b28` |

### Concurrency probe (section 8)

Two `psql` sessions on the local stack, both `authenticated` as the seed admin, same target and source (Towson, 143 items).

- Session 1 called the RPC, then held its transaction open for 6 s.
- Session 2 made the same call 2.5 s later. A third session saw it waiting: `wait_event = advisory`, `granted = f`.
- Session 1 committed. Session 2 returned about 0.14 s later, 4.04 s after starting, with no error and `items_copied: 0, links_added: 0, items_skipped: 143`.
- Afterward: 143 rows, 143 distinct catalog ids, 141 links, 1 audit row. Probe rows and tombstones were removed.

### Timing (local stack, seed scale)

| Call | Rows | Time |
|---|---|---|
| `stock_store_from_store` under `authenticated`, in `psql` | 143 items, 141 links | 438 ms |
| Same, over HTTP through PostgREST | 143 items, 141 links | 507 ms round trip |
| `stock_store_preview` under `authenticated`, in `psql` | 4 sources | 157 ms |

The realtime burst and prod behaviour weren't measured. Record those in the AC-45 browser pass.

### Frontend (section 12)

**Components**
- `src/components/cmd/StockStoreDialog.tsx` (new)
- `src/components/cmd/StockStoreDialog.test.tsx` (new)
- `src/components/cmd/StoreFormDrawer.tsx`: "Stock from" field, awaited `addStore`, `onCreated`, inert close paths while a create is in flight
- `src/components/cmd/StoreFormDrawer.test.tsx`: section 9 mock and `open()` changes, plus AC-38 to AC-43

**Utils**
- `src/utils/stockResult.ts` (new): result lines, and the D-15 derivation and line
- `src/utils/stockResult.test.ts` (new)
- `src/utils/formatAuditAction.ts`: `Store stocked`

**Sections**
- `src/screens/cmd/sections/BrandsSection.tsx`: `StoresTab` STOCK action, result panel, D-15 check, refresh generation guard, row wrap at phone width
- `src/screens/cmd/sections/__tests__/StoresTab.stock.spec184.test.tsx` (new)
- `src/screens/cmd/sections/EODCountSection.tsx`: D-12 message, toggle and `+ vendor` rules, AC-24 reset, N6
- `src/screens/cmd/sections/__tests__/EODCountSection.emptyState.spec184.test.tsx` (new)
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx`: optional `eodEmptyState`
- `src/screens/cmd/sections/eod/__tests__/PhoneEodCount.test.tsx`: AC-26
- `src/screens/cmd/sections/AuditLogSection.tsx`, `src/screens/cmd/sections/phone/PhoneAuditLog.tsx`: tone and kind for `Store stocked`
- `src/screens/cmd/sections/__tests__/AuditLogSection.storeStocked.spec184.test.tsx` (new)

**Types and i18n**
- `src/types/index.ts`: `AuditAction` gains `Store stocked`
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`: four `section.eod` keys, `enum.auditAction.storeStocked`

### Frontend deviations from the design

- **D-15 reads through `db.ts`, not the slices.** Section 11 says to compute it from the vendors already in the slice. That can't work on two paths. `stockStoreFromStore` doesn't await its reload, so when the result arrives the `inventory` slice doesn't hold the rows just added, and a freshly stocked store would never warn. The `vendors` slice holds the current store's brand, which needn't be the brand on the tab. `StoresTab` calls `db.fetchInventory(target)` and `db.fetchVendors(brandId)` instead, and appends the line when they return. No RPC change. If the reads fail, `notifyBackendError` fires and the panel says the check couldn't run, so a failed check doesn't read as "no warning".
- **AC-39 line is suppressed when the brand has no store to copy from.** It would point at a `STOCK` action that AC-29 leaves with no list and no submit.
- **AC-33 "ticked rows added" shows only once something was ticked,** including when every tick was skipped. AC-33 gives it no zero rule, but on a run with no ticks (2AM today) "0 ticked catalog rows" says nothing.
- **Inert close paths apply to create mode only.** Section 6 doesn't scope them, but AC-38 says edit mode is unchanged.
- **One addition: `links_skipped_cross_brand` above 0 gets a result line,** since the design's AC-18 choice is "skip and report".
- **`confirmAction` isn't used.** The design adds no extra confirm: the AC-30 statement is the confirm step, and nothing is written until STOCK is pressed under it.
- **Dialog, drawer and panel copy is hardcoded English,** per section 6. Only the EOD and audit strings are in the catalog.

### Frontend verification

- Full `npx jest`: 296 of 296 suites, 3755 of 3755 tests, 17 of 17 snapshots.
- `npx tsc --noEmit --types <real names>` exit 0, with `--listFiles` confirming the changed files are covered. `npm run typecheck:test` exit 0. Plain `npm run typecheck` wasn't run: it fails locally on the stray `node_modules/@types/* 2` directories.
- `npx expo export --platform web` built, written to a temporary directory and removed.
- Nine mutations of the key guards were each caught by the new tests, then restored.
- **Not verified:** the AC-45 browser pass, native, `scripts/test-db.sh` (no SQL changed in this half), realtime burst behaviour, and the phone-width row wrap and dialog layout, which jest can't see.

## Browser verification (AC-45)

Run by main Claude on 2026-11-05 in the in-app browser against the local stack (`EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`), web at 1440x900 and 375x812, with `admin@local.test` temporarily promoted per F-10. All test stores, the test brand, the catalog row, tombstones and the vendor number were removed afterwards and the promotion reverted; local counts confirmed back at baseline. Nothing touched prod.

**Passed, seen on screen**
- Create drawer: nothing preselected, CREATE disabled at 2/3, enabled at 3/3 after a choice. "Don't stock yet" creates the store and the panel points to STOCK.
- The reported bug's state (schedule exists, vendor scheduled today, 0 items), at both widths: "this store has no items yet, so there is nothing to count"; no toggle; `+ vendor` enabled on desktop.
- STOCK from Towson: preview said 143 to add and 2 without vendor links; result 143 items and 141 links. SQL confirmed stock all 0, no par or cost differences from Towson, no shared ids, one `Store stocked` audit row. EOD then showed SYSCO (14), matching Towson's 14 links, and the toggle returned.
- Re-run from Charles after editing a par and deleting an item: 1 added, par edit kept (777 vs Towson's 96), the deleted item back under a new id with Charles's values.
- Uncarried list: unticked by default; a ticked row landed with 0 par, 0 cost, 0 links, and the result said so. The list disappeared once the row was carried.
- Same source again: "already has everything from Charles", no submit.
- Brand with no other stocked store: "no store to copy from", no picker, no submit.
- S3 ("no vendors scheduled for thursday", toggle shown, toggle lists all vendors) and S4 ("vendors scheduled for thursday have no items at this store", toggle shown).
- AC-24: toggle on at a stocked store, switch to an empty one (no toggle, `+ vendor` enabled), switch back (toggle off).
- Create-and-stock from Frederick: result panel included the no-schedule warning and the US Foods warning (D-15). Both warnings correctly named the store.
- D-14 live: with 1002 local rows the app issued `limit=1000` then `id=gt.<last>&limit=1000`.
- Phone: store rows wrap, the dialog fills the screen with submit reachable, the "1 more item" carried-elsewhere line shows, EOD shows the no-items message. No console errors in any run.
- Reload count: each stock run caused 2 full reloads on this client (the explicit one, and one debounced realtime reload about a second later), not a storm.

**Not exercised in the browser**
- The failed-load state (N5, `itemsNotLoaded`): jest and a mutation check only. Forcing it would have meant breaking the shared local stack.
- Dark mode, native, a second concurrent admin's realtime view, and staff EOD at a stocked store.

**For the owner's eye**
- On desktop the no-items message is small 11px text in the vendor row above a blank body.
- SUBMIT COUNT stays enabled at 0 items on both widths. Not pressed, so what it does in this state is unverified.

## Release fixes (2026-11-07)

Made by main Claude on the owner's go-ahead for release-proposal items 1-6 and OD-3. OD-1 (English-only stock copy) is a named follow-up; OD-2 left as is; OD-4 (prod apply) not approved yet; OD-6 security Lows are follow-ups.

1. **D-14 stop rule** (`src/lib/db.ts`): `fetchInventory()` now stops on an EMPTY page, so a server `max_rows` below 1000 still reads everything. The test fixture was fixed first (its `wire` mock returned the same rows for every cursor). New cases: capped server (500 + 500 + 31 = 1031 rows in 4 requests), and an empty first page in 1 request.
2. **Stale result panel** (`BrandsSection.tsx`): `showStockPanel` drops a result whose render's brand is no longer on screen, which covers both the STOCK dialog and create-and-stock. New StoresTab test; mutation-checked.
3. **INACTIVE marker** in the drawer's "Stock from" list, in the accessibility label too. New drawer test.
4. **Dead input removed**: `scheduleConfigured` from `deriveEodEmptyState`, its caller and its test.
5. **Copy**: one exported `plural` in `stockResult.ts`, used by the dialog and drawer; "1 of 1 is", "1 of those has". New dialog test.
6. **Runbook text** (section 10): prod now ~882 rows (estimate) with Kenyon and H Street backfilled; report-only `max_rows` read; `PROBE SKIPPED` defined; explicit-path staging that keeps `order_approvals_fk_set_null.test.sql` out; rollback before vs after the push. F-2, the D-14 text and the D-15 text are marked superseded.
7. **OD-3**: SUBMIT COUNT is disabled for `no_items`, `no_vendor_links` and `load_failed` on desktop (testID `eod-submit-desktop`, so the spec 140 phone-gate test that asserts `eod-submit` is absent on desktop still holds) and phone, via `isNothingToCount()` in `eodEmptyState.ts`. `onSubmit` also returns early in those states. Six new tests; removing the guard fails all six.

**No SQL changed**, so the normalized md5s under `## Files changed` stand.

**Gates (local):** full `npx jest` 296/296 suites, 3770/3770 tests, 17/17 snapshots. `npm run typecheck:test` exit 0. `npx tsc --noEmit --types <real names>` exit 0 (plain `npm run typecheck` still hits the local-only stray `@types/* 2` directories; CI runs `npm ci`). `scripts/test-db.sh` 94/95, the only failure `order_approvals_fk_set_null.test.sql` (8 of 12), not part of this spec.

**Browser (local stack, 1440 and 375):** an empty store with a vendor scheduled today shows the no-items message and a disabled SUBMIT COUNT (`aria-disabled`, desktop opacity 0.4, phone greyed), with no console errors. Towson's button stays enabled. Test store removed and the local promotion reverted afterwards.
