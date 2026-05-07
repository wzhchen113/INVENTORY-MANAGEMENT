# Spec 004: Convert ingredient form free-text fields to managed lookups (categories, units, vendors, pack-contents)

Status: READY_FOR_REVIEW

**Type:** Frontend (Cmd UI) + Backend (schema + RPC, mostly RPC) + Admin lookup UI
**Filed:** 2026-05-06 (rewritten 2026-05-06 after a code re-read corrected the table-name assumptions in the original draft)
**Cross-references:**
- Form file: [`src/components/cmd/IngredientForm.tsx`](../src/components/cmd/IngredientForm.tsx)
- Drawer host: [`src/components/cmd/IngredientFormDrawer.tsx`](../src/components/cmd/IngredientFormDrawer.tsx)
- Read-only conversions tab today: [`src/screens/cmd/sections/InventoryCatalogMode.tsx:551-612`](../src/screens/cmd/sections/InventoryCatalogMode.tsx) (`CatalogConversionsTab`)
- Existing units/pack columns on `inventory_items`: [`supabase/migrations/20260405000759_init_schema.sql`](../supabase/migrations/20260405000759_init_schema.sql)
- Brand-catalog refactor (P2 backfill that copied `unit/category/case_qty/sub_unit_size/sub_unit_unit` into `catalog_ingredients`): [`supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql`](../supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql)
- Lookup tables that already exist: [`supabase/migrations/20260424211732_recover_undeclared_tables.sql`](../supabase/migrations/20260424211732_recover_undeclared_tables.sql)
- Hardcoded canonical mass/volume conversion factors: [`src/utils/unitConversion.ts`](../src/utils/unitConversion.ts) (lines 6–19)
- Cost-calc that this spec must not break: [`src/store/useStore.ts`](../src/store/useStore.ts) — `getIngredientLineCost` at lines 1201–1234
- Existing categories store CRUD: [`src/store/useStore.ts`](../src/store/useStore.ts) lines 462–491 (`addIngredientCategory`, `updateIngredientCategory`, `deleteIngredientCategory`)
- Existing categories DB CRUD: [`src/lib/db.ts`](../src/lib/db.ts) lines 1180–1193
- Legacy categories modal pattern (reference only — do not edit): [`src/screens/IngredientsScreen.tsx`](../src/screens/IngredientsScreen.tsx) — `showCatModal` flow around lines 50–55
- Existing vendor section: [`src/screens/cmd/sections/VendorsSection.tsx`](../src/screens/cmd/sections/VendorsSection.tsx) + [`src/components/cmd/VendorFormDrawer.tsx`](../src/components/cmd/VendorFormDrawer.tsx)

## User story

As a store manager (and admin) using the 2AM PROJECT admin app, I want the **category**, **default unit**, **pack unit**, and **primary vendor** fields on the ingredient edit/add form to be dropdown selections backed by managed lookup data — and I want admin sections in the Cmd UI where I can view/edit/add/delete those lookups (and per-ingredient pack conversions like "1 case of chicken leg = 40 LB") — so that ingredient data stops drifting via free-text typos, pack sizes have machine-checkable unit semantics, and the costing / prep recipe / BOM math has a stable foundation to compute against.

## Background — verified ground truth (re-confirmed 2026-05-06)

The original draft of this spec was based on table names that don't exist (`categories`, `units`, `unit_conversions`). The actual state of the codebase is:

### Tables that already exist

1. **`ingredient_categories`** (created in [`20260424211732_recover_undeclared_tables.sql`](../supabase/migrations/20260424211732_recover_undeclared_tables.sql)).
   - Schema: `id uuid pk, name text not null unique, created_at timestamptz`.
   - RLS: authenticated read; admin/master write.
   - **Brand-scope: NONE.** Categories are global today, not brand-scoped (no `brand_id` column). Architect-level call whether to add brand scoping; PM default = leave global.
   - CRUD already wired through [`db.ts:1180-1193`](../src/lib/db.ts) and [`useStore.ts:462-491`](../src/store/useStore.ts) (`addIngredientCategory` / `updateIngredientCategory` / `deleteIngredientCategory`). The store rename also walks `inventory.map(i => i.category === oldName ? {...i, category: newName} : i)` — text-FK semantics matched on the `name` string. **Backend is ready; no schema work needed for categories.** The deliverable for categories is purely UI: dropdown on the form, plus a Cmd admin section.

2. **`ingredient_conversions`** (same migration). PER INGREDIENT, not a global units table.
   ```
   id uuid pk
   inventory_item_id uuid not null references inventory_items(id) on delete cascade
   purchase_unit text not null              -- e.g. 'case', 'bag'
   base_unit text not null  default 'g'     -- e.g. 'g', 'fl_oz'
   conversion_factor numeric(12,4) not null -- e.g. 18144 (40 lbs in g)
   net_yield_pct numeric(5,2) default 100   -- waste/trim discount
   unique (inventory_item_id, purchase_unit)
   ```
   This is the canonical model for "1 case of chicken leg = 40 LB @ 92% yield". RLS: authenticated read; admin/master write.
   - Note `inventory_item_id` despite the brand-catalog refactor — the FK still points at the per-store table. The cost-calc fallback in `getIngredientLineCost` ([`useStore.ts:1226-1227`](../src/store/useStore.ts)) checks both `c.inventoryItemId === item.catalogId` and `c.inventoryItemId === item.id` to be safe. **Whether conversions should migrate to `catalog_id` is an architect call**, not a PM question.

3. **`vendors`** — already exists; `VendorsSection.tsx` and `VendorFormDrawer.tsx` already exist; `inventory_items.vendor_id` already exists. **Backend is ready; the form just doesn't render a picker.**

### Tables that DO NOT exist

- **No `units` master table.** Valid units = whatever's in [`src/utils/unitConversion.ts:6-19`](../src/utils/unitConversion.ts) hardcoded constants:
  - Weight (base = `g`): `g`, `kg`, `oz`, `lbs` with reality-correct factors.
  - Volume (base = `fl_oz`): `fl_oz`, `cups`, `qt`, `gal` with reality-correct factors.
  - Plus the legacy [`IngredientsScreen.tsx`](../src/screens/IngredientsScreen.tsx)'s `UNITS` constant: `['lbs', 'oz', 'cases', 'each', 'gal', 'qt', 'loaves', 'bags']` — the "abstract" units (`cases`, `each`, `loaves`, `bags`) depend on `ingredient_conversions` to map to a base unit.
- **No `unit_conversions` master table.** Conversions are PER INGREDIENT (`ingredient_conversions`).
- **No `pack_unit` column on `inventory_items`.** The form's `packUnit` field is **typed but never persisted** — pre-existing bug confirmed in [`IngredientFormDrawer.toUpdates()`](../src/components/cmd/IngredientFormDrawer.tsx) at line ~38. The dropdown rework MUST close this bug.

### Pack-contents columns that exist on `inventory_items` (and `catalog_ingredients` after P2)

- `case_qty numeric` — UI labels this "pack size". Number only, no unit. Today implicitly in the row's `unit`.
- `case_price numeric`.
- `sub_unit_size numeric` + `sub_unit_unit text` — used by [`getIngredientLineCost`](../src/store/useStore.ts) (lines 1215–1221) as the primary translation pair (`recipe unit → sub_unit → counted unit`). **Not shown on the ingredient form** — only surfaces in the catalog detail's `properties.json` as `"sub_unit": "1 lb"`.

### How the cost calc works today (must be preserved)

[`getIngredientLineCost`](../src/store/useStore.ts) lines 1201–1234 tries, in order:
1. **Direct** — `recipe.unit === item.unit` → `costPerUnit × qty`. Done.
2. **Standard conversion via sub_unit** — `getConversionFactor(recipe.unit, item.subUnitUnit || item.unit)` (uses the hardcoded weight/volume tables) → divide by `subUnitSize` to land in counted units → multiply `costPerUnit`.
3. **Fallback to `ingredient_conversions`** — for abstract units (`cases`, `each`). `costPerBase = item.costPerUnit / conv.conversionFactor`; `smartToBase(qty, unit)` lands in g/fl_oz; multiply.

Recipe/BOM units (`recipe_ingredients.unit`, `prep_recipe_ingredients.unit`, `recipe_prep_items.unit`) are all free-text and feed steps (1)–(3). Any change to how units are typed/normalized ripples here.

### Existing UI surfaces

- **Cmd ingredient form**: [`src/components/cmd/IngredientForm.tsx`](../src/components/cmd/IngredientForm.tsx) — free-text inputs for category, default unit, pack unit, vendor; `subUnitSize/subUnitUnit` not shown; `altUnits` is read-only stub.
- **Cmd ingredient drawer**: [`src/components/cmd/IngredientFormDrawer.tsx`](../src/components/cmd/IngredientFormDrawer.tsx) — `toUpdates()` mapper drops `packUnit`.
- **Cmd catalog conversions tab**: [`InventoryCatalogMode.tsx:551-612`](../src/screens/cmd/sections/InventoryCatalogMode.tsx) — `CatalogConversionsTab`. **Read-only today.** Shows `purchase_unit → base_unit × factor (yield%)`. Empty state: "FIX — NO CONVERSIONS" warning, no add button.
- **Legacy category modal**: [`IngredientsScreen.tsx`](../src/screens/IngredientsScreen.tsx) `showCatModal` flow (around lines 50–55) — full add/edit/delete UI for `ingredient_categories`. Cmd has no equivalent. Reference pattern only — `IngredientsScreen.tsx` is legacy and `AdminScreens.tsx` is off-limits per CLAUDE.md.
- **VendorsSection**: [`src/screens/cmd/sections/VendorsSection.tsx`](../src/screens/cmd/sections/VendorsSection.tsx) + [`VendorFormDrawer.tsx`](../src/components/cmd/VendorFormDrawer.tsx) — already exist.

### Realtime

- `brand-{brandId}` channel in [`src/hooks/useRealtimeSync.ts`](../src/hooks/useRealtimeSync.ts) currently subscribes to `recipes`, `prep_recipes`, `catalog_ingredients`, `vendors`. If a new `units` master table lands (Q1=yes), it must be added to the publication AND the channel's table list. Realtime publication-membership gotcha (CLAUDE.md) applies — `docker restart supabase_realtime_imr-inventory` after any publication change locally.

## User's verbatim request (frozen for scope traceability)

> 1 - categories is a drop down selection from existing categories, not inputs. but make sure there is a section where can see all the categories and can edit or add new categories for the ingredients.
> 2 - "unit & pack, default unit" also a drop down selections, not inputs. but make sure there is a section where can see all the units and can edit or add new units conversions (all unit conversions must follow to reality measurements). pack size and unit size are related, like let's say 1 case pack size (which is "case", depends on the "unit & pack" selection) of chicken leg is 40 LB pack unit (depend on the second "unit & pack" selection but in this case is LB). all unit only numbers and decimal points are allowed, no letters
> 3 - all the unit & sizes is also connected to prep recipes and menu items/ BOM which it use to calculate the portions and cost.
> 4 - vendor also is a drop down selection to pick on the existing vendors, not input

## PM-recommended defaults (proposed model — confirm or revise via Q1–Q8)

After re-reading the code with main Claude on 2026-05-06, here is the model the PM is recommending the user ratify (each defaulted answer is mapped to a question below):

- **Categories (Q5)**: backend's ready. Wire the dropdown + add a Cmd "Categories" section modeled on the legacy `IngredientsScreen.tsx` modal pattern. Plain delete-with-block-if-in-use.
- **Vendors (Q6)**: backend's ready. Wire the dropdown + reuse `VendorsSection`. Open question: inline "add new vendor" link inside the dropdown vs. navigate-away.
- **Units (Q1)**: keep canonical mass/volume factors hardcoded in `unitConversion.ts` (read-only, can't be set wrong). Add a `units` master table ONLY for registering CUSTOM units ("case", "tray", "sheet pan", "loaves", "bags") — those custom units always require a per-ingredient `ingredient_conversions` row to define their physical meaning. So the units table is mostly a registry of strings + a `kind` (mass / volume / count / abstract); the actual factors live either in code (canonical) or in `ingredient_conversions` (per-ingredient abstract).
- **Pack-contents canonical home (Q2)**: PM-recommended option (c) — drop pack-unit/contents from the ingredient row entirely; the truth lives in `ingredient_conversions(purchase_unit='case', base_unit='lbs', conversion_factor=40)`. The form's "pack size" + "pack unit" reads/writes through the conversion row.
- **Conversions write UI (Q3)**: in scope for this spec. The user's "1 case = 40 LB" example REQUIRES a write path; the existing tab is read-only. Either add inline add/edit/delete on the conversions tab OR have the ingredient form open the conversions tab in-context. PM default: add inline CRUD on the existing tab.
- **Yield % (Q4)**: schema has `net_yield_pct`, default 100%. Surface as an optional advanced field on the conversion edit row, not on the main ingredient form.
- **Recipe/BOM units (Q8)**: out of scope for this spec; preserve cost-calc behavior with a before/after sanity check on a known ingredient. Convert recipe/prep unit text → unit_id in a follow-up Spec 005.
- **Existing data migration (Q7)**: `inventory_items.category` strings that don't match any `ingredient_categories.name` row → auto-create the missing rows from distinct values (case/space-collapse via `lower(trim())`), log the mapping for review. Same for any free-text purchase units that don't match the units registry → if user opts for a units master table, auto-register them.

## Acceptance criteria

> Most criteria below are firm; a few are gated on Q1–Q8 outcomes and labelled `[pending Q#]`.

### Form behavior (`IngredientForm.tsx` + `IngredientFormDrawer.tsx`)

- [ ] **Category** field renders as a dropdown selector populated from `ingredient_categories`. It is no longer a free-text input.
- [ ] **Default unit** renders as a dropdown selector. Source = the canonical hardcoded units in [`unitConversion.ts`](../src/utils/unitConversion.ts) plus any custom units registered in the `units` table (if Q1=yes) OR plus distinct `purchase_unit` values across `ingredient_conversions` (if Q1=no).
- [ ] **Pack unit** renders as a dropdown. Selecting a non-canonical unit (e.g., "case", "tray") prompts the user to define its physical meaning for THIS ingredient — either inline (modal/popover) or by jumping to the conversions tab. [Pending Q3 — UX option.]
- [ ] **Primary vendor** renders as a dropdown of `vendors` rows for the current brand. Saving persists `vendor_id` (already a column on `inventory_items`). [Pending Q6a — inline "add new vendor" or selection-only.]
- [ ] **Pack size** numeric input accepts digits and one decimal point only — no letters, no other characters. Submitting non-numeric is blocked client-side and rejected server-side.
- [ ] When the user saves the form, all four dropdown selections persist and survive a reload.
- [ ] Save with any required dropdown left empty (category, default unit) is blocked with a Toast error, matching the existing required-field validation pattern in [`IngredientFormDrawer.tsx:77-80`](../src/components/cmd/IngredientFormDrawer.tsx).
- [ ] **`packUnit` save-bug closed.** Today the form mapper at [`IngredientFormDrawer.toUpdates()`](../src/components/cmd/IngredientFormDrawer.tsx) ~line 38 silently drops `packUnit`. Whatever shape Q2 resolves to, the spec MUST persist the user's pack-unit choice (whether to a new column, an updated `sub_unit_unit`, or via writing/updating a row in `ingredient_conversions`).

### Categories admin section

- [ ] A new Cmd UI section `CategoriesSection` lives at `src/screens/cmd/sections/CategoriesSection.tsx` and is wired into the sidebar/nav of [`InventoryDesktopLayout.tsx`](../src/screens/cmd/InventoryDesktopLayout.tsx). [Pending Q5b — placement.]
- [ ] The section lists every `ingredient_categories` row with create / rename / delete actions, modeled on the legacy [`IngredientsScreen.tsx`](../src/screens/IngredientsScreen.tsx) `showCatModal` pattern.
- [ ] Delete is blocked if any `inventory_items.category` (or `catalog_ingredients.category`) row references the name. Toast on conflict.
- [ ] Realtime: when one admin client changes a category, other admin clients see the change after the 400 ms debounced reload. (Categories are global today; the existing `useStore` already handles this — verify wiring.)

### Conversions write UI (NEW — closing the read-only gap)

- [ ] [`CatalogConversionsTab`](../src/screens/cmd/sections/InventoryCatalogMode.tsx) at lines 551–612 gains add / edit / delete actions for `ingredient_conversions` rows.
- [ ] Add row UI: pick `purchase_unit` (e.g., "case"), `base_unit` (e.g., "lbs", from canonical units), enter `conversion_factor` (e.g., 40), optional `net_yield_pct` (advanced, defaults 100). Save creates an `ingredient_conversions` row with the FK pointed at the inventory_item (Q4-equivalent question on whether to use `catalog_id` is for the architect to flag).
- [ ] Edit row UI updates the same shape; delete removes the row.
- [ ] All writes route through [`src/lib/db.ts`](../src/lib/db.ts) (new functions added) and [`src/store/useStore.ts`](../src/store/useStore.ts) (new state actions added) — no direct Supabase calls from components.
- [ ] Numeric-only validation on `conversion_factor` and `net_yield_pct` (digits + single decimal, regex `^\d*\.?\d*$`).

### Units admin (CONDITIONAL on Q1)

If Q1 = yes (units master table):
- [ ] A new Cmd UI section `UnitsSection` lives at `src/screens/cmd/sections/UnitsSection.tsx` and is wired into nav. [Pending Q5b — placement.]
- [ ] Schema for `units`: `code text pk` (or `id uuid pk` + unique `code`), `name text`, `kind text check (kind in ('mass','volume','count','abstract'))`. **No factor column** — canonical factors stay hardcoded in `unitConversion.ts`; abstract-unit factors live in `ingredient_conversions`.
- [ ] Migration seeds the canonical units (`g`, `kg`, `oz`, `lbs`, `fl_oz`, `cups`, `qt`, `gal`) with `kind` set correctly, and any distinct existing free-text purchase units across the data with `kind='abstract'`. (See Q7 backfill behavior.)
- [ ] CRUD: admins can add custom abstract units (e.g., "tray", "sheet pan"). Canonical units (kind in mass/volume) are read-only or marked system to prevent accidental edit. [Pending Q1b.]
- [ ] Realtime: `units` is added to the realtime publication AND to `useRealtimeSync.ts`'s table list. Realtime gotcha applies — `docker restart supabase_realtime_imr-inventory` locally after publication change.

If Q1 = no:
- [ ] No new `units` table. Default-unit and pack-unit dropdowns source from `unitConversion.ts` constants (canonical) plus distinct `purchase_unit` values returned by an RPC over `ingredient_conversions` (abstract). Custom abstract units are added implicitly when the user creates an `ingredient_conversions` row with a new `purchase_unit` string.

### Vendor dropdown

- [ ] Vendor field in the ingredient form is a dropdown of `vendors` rows for the current brand (filtered by `brand_id`).
- [ ] Selecting a vendor persists `inventory_items.vendor_id`. The form's free-text `vendorName` input is removed (the existing `vendor_id` column is the source of truth).
- [ ] No new vendor admin section is added — `VendorsSection` already exists. The spec verifies it covers create / edit / delete; if Q6a = inline-add, the dropdown opens `VendorFormDrawer` and refreshes on save. [Pending Q6a.]

### Migration of existing free-text data

- [ ] Migration creates any missing `ingredient_categories` rows from distinct existing `inventory_items.category` and `catalog_ingredients.category` values, collapsed via `lower(trim())`. Mapping logged to `pg_notify` or a temp table for review.
- [ ] If Q1=yes (units table): same backfill for distinct existing free-text unit / pack-unit / purchase-unit values across `inventory_items`, `catalog_ingredients`, and `ingredient_conversions.purchase_unit`. Canonical units seeded first; remainder become `kind='abstract'`.
- [ ] No existing ingredient row is left with a category/unit value that doesn't resolve to a registered row after migration. Architect probe required (see Probe results below).

### Costing / cost-calc invariant

- [ ] Pick 2–3 known ingredients (PM suggests chicken leg, chicken breast, and one of flour/oil) and compute `getIngredientLineCost(...)` for a realistic recipe line BEFORE the migration. Save the values as a probe artifact.
- [ ] After the migration, the same probe must return the same numbers (within float tolerance, e.g., 1e-6). Architect writes the SQL/JS probe and bakes it into a smoke check.
- [ ] If the probe shows a delta, the migration is invalid and must be fixed before SHIP.
- [ ] No changes to `recipe_ingredients.unit`, `prep_recipe_ingredients.unit`, `recipe_prep_items.unit` in this spec (those are free-text today and stay that way; converting to unit_id is filed as Spec 005).

### Realtime

- [ ] If Q1=yes: `units` added to supabase realtime publication AND to `useRealtimeSync.ts`'s `brand-{brandId}` channel table list. Realtime publication-membership gotcha called out in the design doc.
- [ ] `ingredient_conversions` realtime status: confirm whether it's already in the publication; if not and the conversions tab needs live cross-client updates, add it. (PM default: add it, since the conversions write UI is now multi-user-editable.)

### Permissions

- [ ] Lookup CRUD endpoints/policies enforce `auth_is_admin()`. Read access matches existing patterns (authenticated read on `ingredient_categories`, `ingredient_conversions`, `vendors`).
- [ ] `useRole.ts` placeholder behavior is fine for now (returns `'admin'` for everyone — intentional per CLAUDE.md).

## In scope

- Cmd UI dropdowns on the ingredient form: category, default unit, pack unit, vendor.
- Numeric-only validation on pack size and any numeric input touched by this spec.
- `CategoriesSection` Cmd UI page (admin CRUD on `ingredient_categories`).
- Conversions write UI (add/edit/delete) on the existing `CatalogConversionsTab`.
- Closing the `packUnit` save-bug in `IngredientFormDrawer.toUpdates()`.
- `UnitsSection` Cmd UI page IF Q1=yes.
- Migration that backfills `ingredient_categories` from distinct existing free-text category values (and `units` if Q1=yes).
- Vendor dropdown wiring (the `vendors` table and `VendorsSection` already exist).
- Updates to [`src/lib/db.ts`](../src/lib/db.ts) for new lookup CRUD calls.
- Updates to [`src/store/useStore.ts`](../src/store/useStore.ts) for new lookup state and actions (categories CRUD already partially there; conversions CRUD likely needs adding).
- Realtime channel additions in [`src/hooks/useRealtimeSync.ts`](../src/hooks/useRealtimeSync.ts) (only if Q1=yes adds new tables, OR `ingredient_conversions` needs live updates).
- Cost-calc invariant probe (architect writes; reviewers verify).

## Out of scope (explicitly)

- **Recipe/BOM unit text → unit_id refactor.** `recipe_ingredients.unit text`, `prep_recipe_ingredients.unit text`, `recipe_prep_items.unit text` stay free-text. Filed as follow-up Spec 005. Rationale: large blast radius across cost-calc, prep recipe builders, and the BOM editor; better as its own spec with its own probe.
- **Editing `AdminScreens.tsx` (legacy mega-screen).** New functionality goes in Cmd UI sections only (CLAUDE.md "Legacy admin screens"). The legacy admin form will continue to use free-text columns until `EXPO_PUBLIC_NEW_UI` becomes default.
- **Editing `IngredientsScreen.tsx`.** Reference only for the categories modal pattern; legacy file, not modified.
- **Customer PWA / staff app.** Sibling repos. The `pwa-catalog` edge function does not need a contract change because we're not changing the shape of `category` or `unit` in the catalog payload (text is preserved).
- **SKU / Reorder Pt / Max / Vendor SKU / Avg Cost.** Other "schema pending" stubs on the form. Not requested here.
- **Audit logging on lookup CRUD.** The `audit_log` table exists; defaulting to no log entries for lookup edits in this spec. [Pending Q8 if user wants it.]
- **Bulk merge tools** (e.g., "merge category 'Meats' into 'Meat'"). Useful long-term but not requested. Plain delete-with-block-if-in-use only.
- **Brand-scoping `ingredient_categories`.** Today categories are global. Adding `brand_id` is a larger migration with cross-brand isolation tradeoffs. Architect is asked to flag, but PM default = stay global.
- **Migrating `ingredient_conversions.inventory_item_id` → `catalog_id`.** The FK still points at the per-store table. Architect call to flag; not a deliverable here.
- **Test framework.** No test runner exists (CLAUDE.md). Verification is manual + the cost-calc invariant probe.
- **Changing the `app.json` slug.** Not touched (CLAUDE.md "app.json slug mismatch (DO NOT AUTO-FIX)").
- **Modifying `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, or `npm run db`.** Frozen legacy (CLAUDE.md "Data layer").

## Open questions — UNRESOLVED, awaiting user

These block setting `Status: READY_FOR_ARCH`. Each is filed back to the user via the Handoff payload. Numbers re-tightened from the previous draft based on the verified ground truth above.

- **Q1 — Units master table: yes or no?**
  - (a) Add `units (code, name, kind)` so admins can register custom units ("case", "tray", "loaves") in one place. Canonical mass/volume factors stay in `unitConversion.ts` (read-only, can't be set wrong); abstract units' physical meanings live in `ingredient_conversions`. Adds one table + a Cmd section.
  - (b) Skip the master table. Custom units exist only as free-text on `ingredient_conversions.purchase_unit`. Default-unit dropdown sources from `unitConversion.ts` constants ∪ distinct existing `purchase_unit` values returned by an RPC. Less infrastructure, slightly weaker hygiene (no place to define "tray" without picking an ingredient).
  - PM lean: (a). Confirm.

- **Q2 — Pack-contents canonical home.** Where does "1 case = 40 LB" live?
  - (a) New columns `pack_unit_id` + `pack_contents_qty` + `pack_contents_unit_id` on `inventory_items` (parallel to existing `case_qty`/`sub_unit_size`). Most explicit; most schema growth.
  - (b) Repurpose the existing `sub_unit_size`/`sub_unit_unit` pair as the canonical pack-contents pair — rename in the form, no new columns. (`case_qty` stays as the count.) Reuses existing data.
  - (c) Drop pack-unit/contents from the ingredient row entirely; the truth is in `ingredient_conversions(purchase_unit='case', base_unit='lbs', conversion_factor=40)`. The form's "pack size" + "pack unit" reads/writes via the conversion row. Cleanest model; aligns with the cost-calc fallback already wired.
  - PM lean: (c). Confirm.

- **Q3 — Conversions write UI scope.**
  - (a) This spec adds inline add/edit/delete on the existing read-only conversions tab (`CatalogConversionsTab`). Ingredient form's pack-unit dropdown either creates a row inline (modal/popover) OR opens the tab in-context.
  - (b) Defer the write UI to a follow-up. Ingredient form's pack-unit dropdown only picks from existing rows; users can't create a new conversion until the next spec ships.
  - PM lean: (a) — the user's "1 case = 40 LB" example REQUIRES a write path; (b) means the headline use-case doesn't work end-to-end.
  - Sub-question Q3a: if (a), inline modal vs. jump-to-tab UX?

- **Q4 — Yield % UX.**
  - (a) Surface `net_yield_pct` on the conversion edit row as an optional advanced/expandable field, defaulting 100%.
  - (b) Hide entirely; always 100% for v1; expose later.
  - PM lean: (a).

- **Q5 — Categories Cmd section placement.**
  - Q5a: Combined with "Recipe categories" (also has store CRUD per [`useStore.ts:441-460`](../src/store/useStore.ts)) into one "Categories" page, or kept separate?
  - Q5b: Top-level sidebar item, or under a "Settings" / "Lookups" sub-group?
  - PM lean: separate page, top-level. Recipe categories live under recipes already.

- **Q6 — Vendor dropdown UX.**
  - Q6a: Inline "add new vendor" option that opens `VendorFormDrawer` from the dropdown? Or selection-only (admin must navigate to `VendorsSection` to add a vendor)?
  - PM lean: inline-add (one less click for the common case). The drawer already exists; minimal extra wiring.

- **Q7 — Existing-data backfill behavior.**
  - When the migration finds an `inventory_items.category` value not in `ingredient_categories.name`:
  - (a) Auto-create the missing row, collapsed via `lower(trim())`. Log the mapping for review (temp table or `pg_notify`).
  - (b) Fail and force the user to clean up free-text drift before retry.
  - PM lean: (a). Same policy applies to free-text unit values if Q1=yes.

- **Q8 — Recipe/BOM scope confirmation.**
  - The user said "all the unit & sizes is also connected to prep recipes and menu items / BOM which it use to calculate the portions and cost." Is the user asking that this spec ALSO converts `recipe_ingredients.unit`, `prep_recipe_ingredients.unit`, `recipe_prep_items.unit` from text to a unit reference? Or just stating the dependency exists and asking that we don't break it?
  - PM lean: don't-break-it for this spec; file Spec 005 for the unit_id refactor of recipe/prep tables (large blast radius across cost-calc and the prep editor). Acceptance criterion = sanity-check probe shows same cost numbers pre/post.

## Resolved answers (locked 2026-05-06 by user)

User ratified PM defaults with two adjustments to satisfy the project's "no duplicates, utilize existing" rule. The locked answers are now the source of truth; the (a)/(b)/(c) options above are kept for reasoning trace only.

- **Q1 = no.** No new `units` master table. Canonical mass/volume units stay in [`unitConversion.ts:6-19`](../src/utils/unitConversion.ts) as the single source of truth (read-only by design — can't be set wrong). Default-unit and pack-unit dropdowns source from those constants ∪ distinct `purchase_unit` values across `ingredient_conversions`. Custom abstract units (e.g., "tray") are added implicitly when an admin creates an `ingredient_conversions` row with a new `purchase_unit` string. **No `UnitsSection.tsx` is created. No new realtime publication membership beyond what's already there.** The "Units admin (CONDITIONAL on Q1)" acceptance section above resolves to its `Q1 = no` branch only.
- **Q2 = b.** Pack-contents canonical home = the existing `inventory_items.sub_unit_size` + `sub_unit_unit` columns (parallel on `catalog_ingredients` after the P2 backfill). The form renames "pack unit" UX-side to write `sub_unit_unit` and "default unit size" to write `sub_unit_size`. **No new columns on `inventory_items`.** No double-write to `ingredient_conversions` for canonical pack contents. `ingredient_conversions` stays as the fallback for genuinely abstract units (each, bag) where no canonical mass/volume mapping applies — its current job per [`getIngredientLineCost` step 3](../src/store/useStore.ts) (lines 1223–1232). Cost-calc step 2 (sub_unit-based translation) remains the primary path; the form change just means the user is now setting that pair via dropdowns instead of having it hidden.
- **Q3 = a.** Conversions write UI is in scope for this spec. `CatalogConversionsTab` gains add/edit/delete on `ingredient_conversions` rows. Sub-question Q3a left to architect: inline modal vs. jump-to-tab when the form's pack-unit dropdown selects a new abstract unit; architect picks the simpler option that doesn't fork the form drawer's modal stack.
- **Q4 = a.** `net_yield_pct` surfaces on the conversion edit row as an optional advanced/expandable field, defaults 100%. Hidden behind a disclosure toggle so the common case stays one input.
- **Q5.** New top-level Cmd sidebar item: `CategoriesSection` for `ingredient_categories`. Separate from recipe categories (which already live under recipes). One new file at `src/screens/cmd/sections/CategoriesSection.tsx`.
- **Q6 = inline-add.** Vendor dropdown gets a "+ new vendor" option that opens the existing [`VendorFormDrawer`](../src/components/cmd/VendorFormDrawer.tsx) modally. On save, the new vendor appears in the dropdown and is auto-selected.
- **Q7 = a.** Migration auto-creates missing `ingredient_categories` rows from distinct existing `inventory_items.category` and `catalog_ingredients.category` values, collapsed via `lower(trim())`. Mapping is logged for review (architect picks the log mechanism — temp table or `pg_notify`).
- **Q8 = don't-break-it.** `recipe_ingredients.unit`, `prep_recipe_ingredients.unit`, `recipe_prep_items.unit` stay free-text in this spec. Cost-calc invariant probe (chicken leg + chicken breast + flour or oil) must show identical `getIngredientLineCost` numbers pre- and post-migration. Converting recipe/prep unit text → unit ref is filed as a follow-up Spec 005.

### Locked-in deliverable surface (from the resolved answers above)

- **Edits to existing files** (utilize what's there — no duplicates):
  - [`src/components/cmd/IngredientForm.tsx`](../src/components/cmd/IngredientForm.tsx) — category/default-unit/pack-unit/vendor become dropdowns; `subUnitSize`/`subUnitUnit` surface as the canonical "default unit size" + "pack unit" pair (Q2=b).
  - [`src/components/cmd/IngredientFormDrawer.tsx`](../src/components/cmd/IngredientFormDrawer.tsx) — `toUpdates()` mapper persists `subUnitSize`/`subUnitUnit` properly (closes the existing `packUnit` save-bug by routing it to the right column).
  - [`src/screens/cmd/sections/InventoryCatalogMode.tsx`](../src/screens/cmd/sections/InventoryCatalogMode.tsx) — `CatalogConversionsTab` (lines 551–612) gains add/edit/delete actions wired to new store actions and db.ts calls.
  - [`src/lib/db.ts`](../src/lib/db.ts) — add CRUD for `ingredient_conversions` writes (an upsert exists at line 1106; need delete + ensure update is exposed).
  - [`src/store/useStore.ts`](../src/store/useStore.ts) — add store actions for conversion add/update/delete; the existing categories CRUD at lines 462–491 stays as-is and is utilized by the new section.
- **One new file:**
  - `src/screens/cmd/sections/CategoriesSection.tsx` — fills a real gap (no Cmd categories admin exists today). Wired into [`InventoryDesktopLayout.tsx`](../src/screens/cmd/InventoryDesktopLayout.tsx) sidebar.
- **No new DB tables.** No new columns. No new realtime publication members beyond evaluating whether `ingredient_conversions` already has it (architect probe).
- **One migration possible-but-likely-zero:** The data backfill is `INSERT INTO ingredient_categories (name) … ON CONFLICT DO NOTHING` from distinct existing free-text. Architect to confirm whether a migration file is needed or whether a one-shot data cleanup is sufficient.

## Probe results

_Populated by backend-developer 2026-05-07 against the local `npm run dev:db` stack (Postgres 17.6)._

- [x] Distinct existing `inventory_items.category` values (count + list): **N/A — column does not exist on `inventory_items`.** The brand-catalog refactor (P3 lockdown, `20260504072830_brand_catalog_p3_lockdown.sql`) moved `category`, `unit`, `sub_unit_size`, `sub_unit_unit`, and `case_qty` onto `catalog_ingredients` and dropped them from `inventory_items`. The migration's union-on-existence guard handles both topologies safely; on the local DB only the catalog-side branch fires.
- [x] Distinct existing `inventory_items.unit` values (count + list): **N/A — same reason as above.**
- [x] Distinct existing `catalog_ingredients.category` values: **13** — `appetizer, bread, cleaning supplies, condiments, dairy, dairy & sauce, desserts, drinks, dry goods, produce, protein, seafood, vegetable & produce`.
- [x] Distinct existing `catalog_ingredients.unit` values: **6** — `bags, cases, each, gal, lbs, loaves`.
- [x] Distinct existing `ingredient_conversions.purchase_unit` values: **2** — `each, lbs`. (Sparse on the local seed; the field's job becomes load-bearing once admins start writing rows via the new tab.)
- [x] Number of `inventory_items` rows with empty/null `category` or `unit`: **N/A** (columns gone). On `catalog_ingredients`: 0 / 143 with null/empty category, 0 / 143 with null/empty unit.
- [x] Whether `sub_unit_size` / `sub_unit_unit` are populated on the majority of `catalog_ingredients`: **141 / 143 (98.6%) populated**, 2 missing. Q2=b feasibility holds.
- [x] Whether any `vendors.brand_id` is null: **0 / 11 null.** Vendor dropdown filter `brandId === currentStore.brandId` will not silently exclude rows.
- [x] Realtime publication current membership for `ingredient_conversions`, `ingredient_categories`, `vendors`: **all 3 already members of `supabase_realtime`**. The DDL migration `20260507010947_spec004_realtime_publication_add_conversions.sql` is therefore idempotent / no-op locally; on a fresh DB it adds the membership. Either way the runtime result is the same. `docker restart supabase_realtime_imr-inventory` was run after applying.
- [x] Confirmed `ingredient_conversions.inventory_item_id` column **has been dropped** post-P3. Columns present: `id, purchase_unit, base_unit, conversion_factor, net_yield_pct, created_at, catalog_id`. All writes from this spec use `catalog_id` exclusively (matches design §0). Cost-calc fallback at [`useStore.ts:1226-1227`](../src/store/useStore.ts) keeps the `c.inventoryItemId === item.id` dual-check as belt-and-suspenders; it's dead code on the current schema but harmless.
- [x] Backfill insert preview: with the existing 11 `ingredient_categories` rows, the migration would insert **2 new rows** (`Produce`, `Dairy`) — those are the lowercased variants of `Vegetable & Produce` / `Dairy & Sauce` that don't match by `lower(trim())`. Re-running the migration is a no-op via the `not exists` predicate.

### Cost-calc invariant probe — pre and post migration

Reproduced [`getIngredientLineCost`](../src/store/useStore.ts) lines 1201–1234 in SQL against three representative recipe lines (Towson store `00000000-0000-0000-0000-000000000001`). All three exercise path 2 (canonical sub_unit translation) or path 1 (direct unit match); no `ingredient_conversions` rows exist for these catalog ids so path 3 is not engaged.

| Recipe line | Item unit | Sub-unit | costPerUnit | Path | Pre-migration cost | Post-migration cost |
|---|---|---|---|---|---|---|
| 1 each Chicken Breast Patty | each | 1 each | 1.54 | 1 (direct) | **$1.540000** | **$1.540000** |
| 8 oz Chicken Leg | cases | 40 lbs | 88.68 | 2 (sub-unit) | **$1.108500** | **$1.108500** |
| 2 lbs Flour (50lb) | bags | 50 lbs | 20.00 | 2 (sub-unit) | **$0.800000** | **$0.800000** |

Delta = 0 across all three lines, well within the 1e-6 tolerance. Migration is invariant-safe — expected because it only inserts new `ingredient_categories` rows that nothing in the cost-calc reads.

## Dependencies

- **Brand-catalog refactor (P1–P5).** Already in place (migrations dated 2026-05-04). This spec assumes `catalog_ingredients` and brand-level vendor scoping are landed.
- **`src/lib/db.ts`** — central DB access; new lookup CRUD goes here.
- **`src/store/useStore.ts`** — central Zustand store; lookup state additions and conversions CRUD here.
- **`src/hooks/useRealtimeSync.ts`** — channel table list updated if new tables land or if `ingredient_conversions` needs live cross-client updates.
- **`IngredientForm.tsx` + `IngredientFormDrawer.tsx`** — primary form-UI surface.
- **`InventoryDesktopLayout.tsx`** — sidebar wiring for new `CategoriesSection` (and `UnitsSection` if Q1=yes).
- **`CatalogConversionsTab` in `InventoryCatalogMode.tsx`** — gains write UI.
- **`VendorsSection` + `VendorFormDrawer`** — already exist; verified compatible with the dropdown's inline-add path (Q6a).
- **Realtime publication-membership gotcha** (CLAUDE.md): if a new table is added to the publication mid-session, `docker restart supabase_realtime_imr-inventory` is required locally.
- **Edge runtime bind-mount gotcha** (CLAUDE.md): not applicable (no edge function changes expected).

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. New sections under `src/screens/cmd/sections/`. Do NOT touch [`AdminScreens.tsx`](../src/screens/AdminScreens.tsx) — explicit rule. [`IngredientsScreen.tsx`](../src/screens/IngredientsScreen.tsx) is reference-only for the legacy categories modal.
- **Per-store or admin-global:** `ingredient_categories` is global today (no `brand_id`). `ingredient_conversions` is per-ingredient (FK to `inventory_items`, which is per-store). `vendors` is brand-scoped. Architect to flag if any of these scopings should change in this spec; PM default = leave as-is.
- **Realtime channels touched:** `brand-{brandId}` may need `units` (if Q1=yes) and `ingredient_conversions` (if not already published). Realtime publication-membership gotcha applies.
- **Migrations needed:** Only if Q1=yes (one new timestamped SQL migration for `units` + seed + backfill) OR if Q2=(a) (one new migration for new pack columns). Q1=no + Q2=(c) = the PM default — possibly no SQL migration at all, just RPC additions and frontend work.
- **Edge functions touched:** None planned. `pwa-catalog` payload shape unchanged (text in / text out).
- **Web/native scope:** Both. Cmd UI ships to both via Expo. No web-only or native-only behavior expected.
- **Tests:** No test framework wired up. Manual verification + the cost-calc invariant probe (architect writes the SQL/JS, reviewers verify it returns the same number pre/post). Test framework selection is its own future spec.
- **`app.json` slug:** Not touched.
- **`useSupabaseStore.ts` / `useJsonServerSync.ts` / `db.json`:** Not touched (legacy/frozen).

## Risk surface (PM-level summary; architect refines in design)

- **Q2 / pack-contents canonical home is the highest-impact open question.** Three viable models with very different schema footprints. PM lean (c) keeps schema small but moves the "1 case = 40 LB" definition off the row and into `ingredient_conversions`, which means the form has to read/write through that table. If the architect picks a different option, the conversions write UI scope (Q3) shifts.
- **`packUnit` save-bug.** Pre-existing. The dropdown rework MUST close it (otherwise users will see the dropdown work and silently lose data on reload). Surface to architect explicitly.
- **Cost-calc invariant.** If unit text gets normalized (e.g., "lbs." vs "lb" collapse to the same canonical), values that previously didn't match in `getConversionFactor` will start matching. Cost numbers may shift quietly. The before/after probe is the safety net — non-negotiable acceptance criterion.
- **Realtime publication.** If Q1=yes, adding `units` to the publication mid-session breaks realtime locally until `docker restart`. Surface clearly in the design and apply checklist.
- **`ingredient_conversions.inventory_item_id` FK still points at per-store table.** The cost-calc fallback hedges with `c.inventoryItemId === item.catalogId` OR `=== item.id` ([`useStore.ts:1226-1227`](../src/store/useStore.ts)). If the architect decides to migrate the FK to `catalog_id`, that's its own spec — flag as architect's call.
- **Categories global scope.** If two brands ever have a "Meat" category that means different things, the global `ingredient_categories` will collide. PM default is stay global; architect to flag if brand-scoping is warranted given existing data.
- **Backfill safety.** Distinct existing values for category / unit / purchase_unit are unknown until the architect probes the live data. If there's lots of casing/spelling drift, Q7 becomes the sharp edge — PM default of auto-create-with-collapse may swallow drift the user wanted to clean up manually.

## Handoff guidance for the architect

When this spec flips to `READY_FOR_ARCH` (after the user resolves Q1–Q8), the architect should:

1. Probe distinct existing free-text values for `category`, `unit`, `purchase_unit` across `inventory_items`, `catalog_ingredients`, and `ingredient_conversions`. Document under Probe results.
2. Decide the units `kind` enum and the canonical-base-unit list per kind, lining up with `unitConversion.ts` (Q1).
3. Decide the pack-contents model per Q2 ((a) new columns, (b) reuse `sub_unit_*`, or (c) read/write through `ingredient_conversions`).
4. Trace the cost-calc invariant: pick 2–3 known ingredients (PM suggests chicken leg, chicken breast, and one of flour/oil), write the JS/SQL probe that returns their computed cost via `getIngredientLineCost`, and acceptance-criteria the same probe returning the same number post-migration.
5. Surface the pre-existing `packUnit` save bug as a build-time deliverable.
6. Flag (don't fix in this spec) whether `ingredient_conversions.inventory_item_id` should migrate to `catalog_id`.
7. Confirm Q1–Q8 stances still hold once probe data is in. If probe data invalidates a stance, surface immediately and do not proceed with design.
8. Produce the design and set `Status: READY_FOR_BUILD`, then hand off to backend-developer + frontend-developer in parallel.

## Design

### 0. Ground-truth correction to the Background section

The spec's Background section (lines 38–48) describes `ingredient_conversions` as still keyed on `inventory_item_id`. **That is partially stale** — the brand-catalog refactor Phase 2 ([`20260504062318_brand_catalog_p2_backfill.sql`](../supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql) lines 197–223) added a `catalog_id` column, populated it, and deduped per-store conversion rows down to one canonical row per (catalog_id, purchase_unit). The current [`db.ts:1087-1112`](../src/lib/db.ts) reads and writes via `catalog_id`, mapping it onto the TS field `inventoryItemId` for back-compat. The cost-calc fallback at [`useStore.ts:1226-1227`](../src/store/useStore.ts) checks `c.inventoryItemId === item.catalogId || c.inventoryItemId === item.id` to hedge during the transition.

**What the architect needs to confirm via probe SQL** (developer runs at the start of the build): whether `ingredient_conversions.inventory_item_id` still exists as a column at all post-P5, or whether a phase-3-or-later migration dropped it. This affects only one design decision (delete-by-id semantics still work either way; both `catalog_id` and `id` are present). Either way, **all writes from this spec use `catalog_id` exclusively** — the `inventory_item_id` legacy column, if still present, is ignored.

This correction does not change any of the locked answers (Q1=no, Q2=b, etc.). It does sharpen the conversion-write contract below.

### 1. Schema changes

**One new migration is required** — but only for the data backfill in Q7. No new tables, no new columns.

- File: `supabase/migrations/20260506HHMMSS_spec004_ingredient_categories_backfill.sql` (developer picks the timestamp at apply time).
- Shape (additive, idempotent):
  ```sql
  -- Backfill ingredient_categories from distinct existing free-text on
  -- inventory_items.category and catalog_ingredients.category.
  -- Collapses casing/whitespace via lower(trim(...)). Logs what it did
  -- via RAISE NOTICE so `supabase db reset` output captures the mapping.
  do $$
  declare v_inserted int; v_skipped int;
  begin
    with sources as (
      select trim(category) as raw from inventory_items
       where category is not null and trim(category) <> ''
      union all
      select trim(category) from catalog_ingredients
       where category is not null and trim(category) <> ''
    ),
    canonical as (
      select distinct on (lower(raw)) raw
        from sources
       order by lower(raw), raw  -- prefer the first casing seen
    ),
    inserted as (
      insert into ingredient_categories (name)
      select c.raw from canonical c
       where not exists (
         select 1 from ingredient_categories ic
          where lower(ic.name) = lower(c.raw)
       )
      returning name
    )
    select count(*) into v_inserted from inserted;
    raise notice 'spec004 backfill: inserted % ingredient_categories', v_inserted;
  end $$;
  ```
- **Destructive vs. additive:** purely additive. Existing rows are not touched. No `update inventory_items set category = ...` — the text-FK semantics in `useStore.updateIngredientCategory` (lines 471–482) already handle name-rewrite cascades client-side; the migration just makes sure every existing free-text value has a matching dropdown row to pick.
- **Rollout safety:** safe to apply to prod (idempotent — re-running is a no-op via the `not exists` predicate). Safe to ship before the frontend lands; the new rows are invisible until the dropdown reads them.
- **No `update` of existing free-text values to a canonical casing.** PM Q7=a says "collapse via `lower(trim())`" for matching, not for normalizing the existing data. The dropdown uses the canonical row's name as-stored; existing inventory rows with mismatched casing (e.g., "meat" vs. "Meat") show whichever casing was stored. If the user wants a one-shot lowercase normalize sweep, file as Spec 006.

**No other schema changes:**
- Q1=no → no `units` table.
- Q2=b → no new pack columns; `sub_unit_size`/`sub_unit_unit` already exist on both `inventory_items` and `catalog_ingredients` (P2 backfilled them on the catalog side per [`20260504062318` line 41](../supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql)).
- Q3=a → no `ingredient_conversions` schema changes; the table already supports add/edit/delete, only the UI is missing.
- Q5 → no schema; categories CRUD already exists.
- Q6=inline-add → no schema; `vendors` already exists.

### 2. RLS impact

**None.** Confirmed by reading [`20260424211732_recover_undeclared_tables.sql`](../supabase/migrations/20260424211732_recover_undeclared_tables.sql):

- `ingredient_categories` — authenticated read (line 41), admin/master write (line 46). Covers the new CategoriesSection CRUD.
- `ingredient_conversions` — authenticated read (line 72), admin/master write (line 77). Covers the new conversion CRUD.
- `vendors` — already brand-scoped via the per-store hardening migration; existing `VendorFormDrawer` already exercises these paths.

No new policies. No edits to existing policies. The `useRole` hook returning `'admin'` for everyone (CLAUDE.md) is fine — these tables are admin/master-write at the DB layer, not at the app layer, so the hook's stub doesn't matter.

### 3. PostgREST vs. RPC for `ingredient_conversions` writes

**Plain PostgREST table writes.** Three reasons:

1. The existing precedent is direct PostgREST — `fetchIngredientConversions` and `upsertIngredientConversion` in [`db.ts:1087-1113`](../src/lib/db.ts) already use `supabase.from('ingredient_conversions')` directly. Categories CRUD ([`db.ts:1184-1193`](../src/lib/db.ts)) is the same.
2. RLS already enforces admin-only writes at the table level. No multi-row transaction or stored procedure logic to wrap.
3. The cost-calc invariant probe doesn't depend on which transport — it's a read-side function, not a write-side guarantee.

**New `db.ts` surface:**

```ts
// Add to the INGREDIENT CONVERSIONS section (~line 1083), keeping
// fetchIngredientConversions and upsertIngredientConversion as-is.

/** Update an existing conversion by id. Used by the inline edit UI on
 *  CatalogConversionsTab — purchase_unit / base_unit / factor / yield. */
export async function updateIngredientConversion(
  id: string,
  patch: Partial<Pick<IngredientConversion, 'purchaseUnit' | 'baseUnit' | 'conversionFactor' | 'netYieldPct'>>,
): Promise<void> {
  const row: any = {};
  if (patch.purchaseUnit !== undefined) row.purchase_unit = patch.purchaseUnit;
  if (patch.baseUnit !== undefined) row.base_unit = patch.baseUnit;
  if (patch.conversionFactor !== undefined) row.conversion_factor = patch.conversionFactor;
  if (patch.netYieldPct !== undefined) row.net_yield_pct = patch.netYieldPct;
  const { error } = await supabase.from('ingredient_conversions').update(row).eq('id', id);
  if (error) throw error;
}

/** Delete a conversion row by id. Used by the row-level "delete" action
 *  on the conversions tab. */
export async function deleteIngredientConversion(id: string): Promise<void> {
  const { error } = await supabase.from('ingredient_conversions').delete().eq('id', id);
  if (error) throw error;
}

/** Insert a brand-new conversion. Distinguished from the existing upsert
 *  to make the optimistic-then-revert pattern simple — caller knows it
 *  will get a fresh row id back. */
export async function createIngredientConversion(
  conv: Omit<IngredientConversion, 'id'>,
): Promise<IngredientConversion> {
  const { data, error } = await supabase.from('ingredient_conversions').insert({
    catalog_id: conv.inventoryItemId, // TS field name is back-compat; value IS catalog_id
    purchase_unit: conv.purchaseUnit,
    base_unit: conv.baseUnit,
    conversion_factor: conv.conversionFactor,
    net_yield_pct: conv.netYieldPct,
  }).select().single();
  if (error) throw error;
  return {
    id: data.id,
    inventoryItemId: data.catalog_id,
    purchaseUnit: data.purchase_unit,
    baseUnit: data.base_unit,
    conversionFactor: data.conversion_factor,
    netYieldPct: data.net_yield_pct,
  };
}
```

The existing `upsertIngredientConversion` stays — it's used elsewhere (verify with grep before deleting). The new functions are additive.

**Distinct purchase_units RPC?** PM defaults said "an RPC over `ingredient_conversions`" for sourcing the abstract-unit dropdown. **Architect call: don't add an RPC.** The full conversion list is already loaded into the store at boot (`s.ingredientConversions`); deriving distinct purchase units client-side is one line:

```ts
// Hook in IngredientForm.tsx — no DB roundtrip needed.
const abstractUnits = React.useMemo(
  () => Array.from(new Set(allConversions.map(c => c.purchaseUnit.toLowerCase()))).sort(),
  [allConversions],
);
```

Adding an RPC for this would duplicate data the store already has and violate the no-dupes rule.

### 4. Realtime impact

**Add `ingredient_conversions` to the `brand-{brandId}` channel.** Currently [`useRealtimeSync.ts:32-39`](../src/hooks/useRealtimeSync.ts) listens on `recipes`, `prep_recipes`, `catalog_ingredients`, `vendors`. With Q3=a turning the conversions tab into a multi-user write surface, add:

```ts
.on('postgres_changes',
    { event: '*', schema: 'public', table: 'ingredient_conversions' /* no filter — table is brand-scoped via FK to catalog_ingredients */ },
    onSync)
```

**Filter clause:** there is no `brand_id` column on `ingredient_conversions` directly — it inherits scope via `catalog_id` → `catalog_ingredients.brand_id`. PostgREST realtime filters can't follow FKs, so the safe option is no filter (the channel already only fires once per debounce window). The 400ms debounce in `useRealtimeSync` cushions the noise. If multi-brand support lands later, this gets revisited.

**Publication membership probe:** developer must run, before adding to the channel:

```sql
select schemaname, tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime'
   and tablename in ('ingredient_conversions', 'ingredient_categories', 'vendors');
```

Expected: `vendors` is present (already used by the channel). `ingredient_categories` and `ingredient_conversions` may or may not be — verify and add via:

```sql
alter publication supabase_realtime add table public.ingredient_conversions;
-- ingredient_categories: defer. Categories CRUD is admin-only and the
-- list is small; the existing useStore-level optimistic update is
-- sufficient for cross-tab updates within the same session. Adding a
-- live channel for it is over-engineering.
```

**Realtime publication-membership gotcha (CLAUDE.md):** if the migration adds `ingredient_conversions` to the publication, the local container must be restarted with `docker restart supabase_realtime_imr-inventory` after `npm run dev:db`. **Flag this as a deploy/dev step** in the dev checklist below — not a runtime concern, but a foot-gun if missed.

**Architect call:** the publication ALTER goes in a separate, tiny migration file rather than the categories backfill, because publications and data are conceptually separate concerns and ROLLBACK semantics differ. Suggest:

- `supabase/migrations/20260506HHMMSS_spec004_ingredient_categories_backfill.sql` (data)
- `supabase/migrations/20260506HHMMSS_spec004_realtime_publication_add_conversions.sql` (DDL)

The developer authors the body; sample shape:

```sql
-- Add ingredient_conversions to the realtime publication so the
-- conversions write UI shows live cross-client updates.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'ingredient_conversions'
  ) then
    alter publication supabase_realtime add table public.ingredient_conversions;
    raise notice 'spec004: added ingredient_conversions to supabase_realtime';
  else
    raise notice 'spec004: ingredient_conversions already in supabase_realtime, skipping';
  end if;
end $$;
```

### 5. Edge function impact

**None.** Confirmed:

- `pwa-catalog` payload shape: `category` and `unit` are still text columns on `catalog_ingredients`. The dropdown change is purely an admin-side UX restriction; the row shape doesn't change. PWA consumers see the same strings.
- `staff-*` functions: no contact with `ingredient_categories`, `ingredient_conversions`, or the form fields touched here.
- No new edge function. No `verify_jwt` toggles. No service-token validation work.

### 6. Frontend boundaries — what each file does

| File | Change | Owner |
|---|---|---|
| [`src/components/cmd/IngredientForm.tsx`](../src/components/cmd/IngredientForm.tsx) | Replace 4 `<InputLine>` free-text inputs with dropdown selectors (category, default unit, pack unit, vendor). Surface `subUnitSize` (numeric) + `subUnitUnit` (dropdown) as the canonical "default unit size" + "pack unit" pair per Q2=b. The existing labels "pack size" → "case qty" stays as-is (counts cases). Numeric-only validation (`^\d*\.?\d*$`) on `caseQty`, `subUnitSize`, `costPerUnit`, `parLevel`, `casePrice`. | frontend-dev |
| [`src/components/cmd/IngredientFormDrawer.tsx`](../src/components/cmd/IngredientFormDrawer.tsx) | **Close the `packUnit` save-bug.** Per Q2=b, the form's "pack unit" dropdown writes to `subUnitUnit`, not to a non-existent `packUnit` column. The current `toUpdates()` mapper at line 38 already includes `subUnitUnit` — the bug is that the form's `packUnit` field never feeds it. **Fix:** in `toUpdates()`, source `subUnitUnit` from `v.packUnit || v.subUnitUnit` (the dropdown writes to `packUnit` for UX label clarity; the mapper aliases it). Alternatively rename the form field to `subUnitUnit` directly and drop `packUnit` from `IngredientFormValues`. **Architect picks: rename `packUnit` → `subUnitUnit` in `IngredientFormValues`** to eliminate the dead field entirely. The "pack unit" UI label stays; the underlying state slot is `subUnitUnit`. Drop `packSize` / `altUnits` from the form values too if they're truly stubs (verify they're not read elsewhere). | frontend-dev |
| [`src/screens/cmd/sections/InventoryCatalogMode.tsx`](../src/screens/cmd/sections/InventoryCatalogMode.tsx) `CatalogConversionsTab` (lines 551–612) | Add inline add row at the top (purchase_unit text or dropdown of existing canonical units, base_unit dropdown of canonical mass/volume units from `unitConversion.ts`, factor numeric, optional net_yield_pct behind a disclosure). Each existing row gains edit + delete actions. All writes via new store actions (next row). | frontend-dev |
| New file: `src/screens/cmd/sections/CategoriesSection.tsx` | Cmd-styled list of `ingredientCategories`. Add / rename / delete actions wired to existing `useStore.addIngredientCategory` / `updateIngredientCategory` / `deleteIngredientCategory` (lines 462–491). Delete is blocked client-side if any inventory row uses the name (lookup `inventory.some(i => i.category === name)`); show toast on conflict. Modeled on the legacy `IngredientsScreen.tsx` `showCatModal` pattern (reference only — do NOT modify the legacy file). | frontend-dev |
| [`src/screens/cmd/InventoryDesktopLayout.tsx`](../src/screens/cmd/InventoryDesktopLayout.tsx) | Wire `CategoriesSection` into the sidebar nav and the section dispatch switch. Q5 locked top-level placement. | frontend-dev |
| [`src/lib/db.ts`](../src/lib/db.ts) | Add `updateIngredientConversion`, `deleteIngredientConversion`, `createIngredientConversion` (signatures in §3 above). | backend-dev |
| [`src/store/useStore.ts`](../src/store/useStore.ts) | Add `addIngredientConversion`, `updateIngredientConversion`, `deleteIngredientConversion` actions following the optimistic-then-revert pattern. Reuse the existing `ingredientConversions` slice (already in state — read by `getIngredientLineCost` line 1225). | backend-dev |
| [`src/hooks/useRealtimeSync.ts`](../src/hooks/useRealtimeSync.ts) | Add `ingredient_conversions` to the `brand-{brandId}` channel (no filter — see §4). | backend-dev |
| Vendor dropdown in `IngredientForm.tsx` | Render `vendors.filter(v => v.brandId === currentStore.brandId)`. Selecting a vendor sets `values.vendorId` (the `vendorName` field becomes a derived display from the chosen vendor — drop free-text input). Q6=inline-add: a "+ new vendor" sentinel item at the bottom of the dropdown opens the existing `VendorFormDrawer` modally; on save, the new vendor is auto-selected via `setValues({ ...values, vendorId: created.id, vendorName: created.name })`. | frontend-dev |

### 7. The pack-unit decision tree (Q2=b semantics)

Given the user's two examples ("1 case = 40 LB of chicken leg" and "1 each = 400g of an avocado"), here's exactly what the form writes:

**Case A — canonical pack contents (LB / oz / g / kg / fl_oz / cups / qt / gal):**

User selects "case" as the tracking `unit`, then "lbs" as the "pack unit" (= `subUnitUnit`), and types 40 as "default unit size" (= `subUnitSize`). Form saves to `inventory_items`:
- `unit = 'case'` (the counted/tracked unit)
- `case_qty = 1` (or however many cases per delivery — separate concept)
- `sub_unit_size = 40`
- `sub_unit_unit = 'lbs'`

**No `ingredient_conversions` row is written.** Cost-calc step 2 (`getConversionFactor('lbs', 'lbs') = 1`, then `qtyInSubUnit / subUnitSize = qty / 40`) handles the recipe-line math directly. This is the cleanest path and aligns with how `getIngredientLineCost` lines 1215–1221 already work.

**Case B — abstract pack contents (each, bag, tray, sheet pan):**

User selects "each" as the tracking `unit` for avocados. The "pack unit" dropdown's choice "g" is canonical → still **Case A** under the hood — write `subUnitSize=400, subUnitUnit='g'`.

But what if pack unit is "tray" (no canonical mapping)? Two sub-cases:
- **B1 — tray maps to a canonical unit per ingredient (rare).** Use Case A: write `subUnitSize=N, subUnitUnit='g'` (or whatever canonical applies). Don't touch `ingredient_conversions`.
- **B2 — tray is genuinely irreducible to a canonical unit.** Then this isn't a pack unit, it's an *abstract recipe unit*. The form should NOT let the user pick "tray" as `subUnitUnit` because cost-calc step 2 can't resolve it. Instead, the user creates an `ingredient_conversions` row on the conversions tab: `purchase_unit='tray', base_unit='g', conversion_factor=N`. Then recipes that say "0.5 trays" hit cost-calc step 3 (the abstract fallback at line 1223–1232).

**Form-level rule:** the **pack unit dropdown is restricted to canonical mass/volume units only** (`g`, `kg`, `oz`, `lbs`, `fl_oz`, `cups`, `qt`, `gal`). Abstract units never go in `subUnitUnit`. This keeps cost-calc step 2 always resolvable.

**Default unit dropdown** (the tracking `unit`): canonical units ∪ distinct `purchase_unit` values from `ingredientConversions`. Picking an abstract value (`case`, `bag`, `tray`) is fine — it's the counted-unit handle, not the physical-content unit.

**Conversions tab purpose** (Q3=a's actual job): manage the `purchase_unit → base_unit` factors for genuinely abstract tracking units. This is where "1 case = 40 LB" lives if the user wants to track in `case` and the recipe says `lbs` directly without going through the sub-unit translation. **But under Q2=b's primary path (Case A), the conversions tab is mostly empty for new ingredients** — the pack unit pair on the form already handles the math. The conversions tab covers edge cases and pre-existing legacy rows.

**Architect call: this duality is real and the form's UX must distinguish "pack unit" (canonical only, on the row) from "purchase unit" (abstract, on the conversions tab).** Frontend-dev should put a one-line help text under the pack-unit dropdown: *"For abstract pack units like 'case' or 'tray', define their physical meaning on the Conversions tab."* If the user picks a non-canonical default unit (e.g., `case`) AND there's no matching conversion row for it, the form shows a yellow inline warning with a "Define on Conversions tab" link.

### 8. `useStore.ts` slice deltas (optimistic-then-revert)

Three new actions, modeled on existing `addIngredientCategory` / `updateIngredientCategory` / `deleteIngredientCategory`:

```ts
addIngredientConversion: (conv: Omit<IngredientConversion, 'id'>) => {
  const tempId = `_tmp_${Date.now()}`;
  set((s) => ({ ingredientConversions: [...s.ingredientConversions, { ...conv, id: tempId }] }));
  db.createIngredientConversion(conv)
    .then((saved) => set((s) => ({
      ingredientConversions: s.ingredientConversions.map((c) => c.id === tempId ? saved : c),
    })))
    .catch((e: any) => {
      set((s) => ({ ingredientConversions: s.ingredientConversions.filter((c) => c.id !== tempId) }));
      notifyBackendError('Add conversion', e);
    });
},

updateIngredientConversion: (id: string, patch: Partial<IngredientConversion>) => {
  const prev = get().ingredientConversions;
  set((s) => ({
    ingredientConversions: s.ingredientConversions.map((c) => c.id === id ? { ...c, ...patch } : c),
  }));
  db.updateIngredientConversion(id, patch).catch((e: any) => {
    set({ ingredientConversions: prev });
    notifyBackendError('Update conversion', e);
  });
},

deleteIngredientConversion: (id: string) => {
  const prev = get().ingredientConversions;
  set((s) => ({ ingredientConversions: s.ingredientConversions.filter((c) => c.id !== id) }));
  db.deleteIngredientConversion(id).catch((e: any) => {
    set({ ingredientConversions: prev });
    notifyBackendError('Delete conversion', e);
  });
},
```

Add to `StoreActions` interface declaration. The slice itself (`ingredientConversions: IngredientConversion[]`) already exists — it's read by `getIngredientLineCost` line 1225.

snake_case → camelCase mapping is already in `db.fetchIngredientConversions`; the new write functions match it.

### 9. Cost-calc invariant probe (build-time gate)

Developer **must** run this before flipping `Status: READY_FOR_REVIEW`. Stash the pre-migration numbers in a comment at the top of the new migration file or in the spec under "Probe results"; re-run post-migration; numbers must match within 1e-6.

**Probe SQL — pre-migration baseline** (developer runs against local DB after `npm run dev:db`):

```sql
-- 1. Pick three representative ingredients. Names below are the PM's
-- suggestion; substitute realistic equivalents from the data if any are
-- missing. Use the names that actually exist in the local seed.
with picks as (
  select i.id, i.catalog_id, i.name, i.unit, i.cost_per_unit,
         i.sub_unit_size, i.sub_unit_unit, i.case_qty
    from inventory_items i
   where i.store_id = '00000000-0000-0000-0000-000000000001' -- Towson
     and lower(i.name) in ('chicken leg', 'chicken breast', 'flour', 'cooking oil', 'oil')
)
select * from picks order by name;

-- 2. For each ingredient, dump its conversions (catalog-keyed):
select c.* from ingredient_conversions c
 where c.catalog_id in (select catalog_id from picks);

-- 3. Snapshot the inputs to the cost calc. Save this output verbatim.
```

**Probe JS — apply `getIngredientLineCost` against three representative recipe lines** (developer runs in browser console or as a one-off script under `scripts/spec004-cost-probe.ts`):

```ts
// Three representative recipe lines, picked to exercise the three
// cost-calc paths in useStore.ts:1201-1234.
const probes = [
  // Path 1 (direct): recipe unit === item.unit
  { itemName: 'chicken leg',    quantity: 1,   unit: '<copy item.unit>' },
  // Path 2 (sub_unit translation): recipe unit converts to subUnitUnit
  { itemName: 'chicken breast', quantity: 8,   unit: 'oz' },
  // Path 3 (abstract conversions fallback)
  { itemName: 'flour',          quantity: 0.5, unit: 'cups' },
];

for (const p of probes) {
  const item = useStore.getState().inventory.find(i =>
    i.name.toLowerCase() === p.itemName && i.storeId === currentStoreId
  );
  if (!item) { console.log(p.itemName, 'NOT FOUND'); continue; }
  const cost = useStore.getState().getIngredientLineCost({
    itemId: item.catalogId || item.id,
    itemName: item.name,
    quantity: p.quantity,
    unit: p.unit,
  });
  console.log(`${p.itemName} ${p.quantity} ${p.unit}: $${cost.toFixed(6)}`);
}
```

**Acceptance gate:** the same three numbers, to 1e-6, must reproduce after the migration runs and the form rewrite is in place. If any ingredient is missing from the seed, developer picks a substitute and documents the choice in the Probe results section. **No SHIP without this probe passing.**

**Why this works as an invariant check:** Q2=b doesn't move data — `sub_unit_size`/`sub_unit_unit` already exist on the rows; the form change is purely write-path UX. The migration only inserts new `ingredient_categories` rows. Neither operation touches the columns `getIngredientLineCost` reads (`unit`, `costPerUnit`, `subUnitSize`, `subUnitUnit`, conversions). So the probe should pass trivially. **If it fails, that means an unintended data mutation snuck in** — exactly what we want the gate to catch.

### 10. Probe results — DEVELOPER MUST POPULATE BEFORE BUILD

The architect couldn't reach the live local DB from this session. **Backend-dev runs these queries first (against the running `npm run dev:db` Postgres) and pastes results into the Probe results section above before writing any migration SQL.** If any result invalidates a locked answer (e.g., `vendors.brand_id` is NULL on most rows, breaking the dropdown filter), HALT and surface to the user — do not proceed.

```sql
-- A. Distinct inventory_items.category values (count + sample list)
select count(distinct lower(trim(category))) as distinct_categories,
       array_agg(distinct lower(trim(category)) order by lower(trim(category))) as values
  from inventory_items
 where category is not null and trim(category) <> '';

-- B. Distinct inventory_items.unit values
select count(distinct lower(trim(unit))) as distinct_units,
       array_agg(distinct lower(trim(unit)) order by lower(trim(unit))) as values
  from inventory_items
 where unit is not null and trim(unit) <> '';

-- C. Distinct catalog_ingredients.category and .unit values (post-P2; should mirror A and B)
select 'cat' as kind, count(distinct lower(trim(category))) as n
  from catalog_ingredients where category is not null and trim(category) <> ''
union all
select 'unit', count(distinct lower(trim(unit)))
  from catalog_ingredients where unit is not null and trim(unit) <> '';

-- D. Distinct ingredient_conversions.purchase_unit (this is the abstract-unit registry)
select count(distinct lower(trim(purchase_unit))) as n,
       array_agg(distinct lower(trim(purchase_unit)) order by lower(trim(purchase_unit))) as values
  from ingredient_conversions;

-- E. Inventory rows with empty/null category or unit (backfill policy check)
select count(*) filter (where category is null or trim(category) = '') as null_category,
       count(*) filter (where unit is null or trim(unit) = '')         as null_unit,
       count(*) as total
  from inventory_items;

-- F. Q2=b feasibility: sub_unit population on inventory_items
select count(*) filter (where sub_unit_size is not null and sub_unit_unit is not null) as has_sub_unit,
       count(*) filter (where sub_unit_size is null or sub_unit_unit is null)          as missing_sub_unit,
       count(*) as total
  from inventory_items;

-- G. vendors.brand_id null check (vendor dropdown filter correctness)
select count(*) filter (where brand_id is null) as null_brand,
       count(*) as total
  from vendors;

-- H. Realtime publication membership
select schemaname, tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime'
   and tablename in ('ingredient_conversions', 'ingredient_categories', 'vendors');

-- I. Confirm whether ingredient_conversions.inventory_item_id column still exists
-- (decides whether legacy fallback in cost-calc line 1227 is still load-bearing)
select column_name from information_schema.columns
 where table_name = 'ingredient_conversions' and table_schema = 'public'
 order by ordinal_position;
```

**Decision points based on probe outputs:**

- If **E.null_category > 0** or **E.null_unit > 0**: those rows can't satisfy the dropdown's required-field validation. Backfill policy: leave them null (form still requires user to pick on next edit; no migration mass-update). Surface the count in Probe results so the user knows.
- If **F.missing_sub_unit / total > 50%**: most ingredients don't have pack contents set. Form change is mostly cosmetic for old data; users will fill them in over time as they edit. Acceptable. Don't auto-backfill (we don't know the real values).
- If **G.null_brand > 0**: the vendor dropdown filter `vendors.filter(v => v.brandId === currentStore.brandId)` will exclude those rows. P2 backfill (line 28 of `20260504062318`) sets brand_id on all vendors → expected to be 0. If non-zero, HALT and surface.
- If **H** shows `ingredient_conversions` is NOT in the publication: developer's realtime DDL migration adds it (per §4). Apply `docker restart supabase_realtime_imr-inventory` after.
- If **I** does not show `inventory_item_id`: cost-calc fallback line 1227 (`c.inventoryItemId === item.id`) is dead code — out of scope for this spec, file as Spec 006 cleanup.

### 11. Architect-level open flags (NOT user questions; documented decisions)

- **`ingredient_conversions.inventory_item_id` → `catalog_id` migration:** **leave as-is for this spec.** P2 backfill already linked all rows to `catalog_id`; cost-calc line 1227 is the dual-check hedge. Migrating off `inventory_item_id` is a column-drop with cross-fk implications — out of scope, file as Spec 006.
- **`ingredient_categories.brand_id`:** **leave global.** No probe data suggests cross-brand collisions today (single brand). Adding `brand_id` would require a full RLS rewrite, a backfill, and form-side brand-filter wiring. Out of scope.
- **Pre-existing `packUnit` save-bug:** addressed in §6 (rename `packUnit` → `subUnitUnit` in form values; "pack unit" stays as the user-facing label).
- **Cost-calc line 1227 dual-check:** kept untouched. Not a bug, it's belt-and-suspenders for the post-P2 transition. Removing it is Spec 006.
- **Categories duplicate via casing:** the migration's `lower(trim())` collision check matches at compare time but stores the first-seen casing. If the live data has both "Meat" and "meat", only one survives — the first one alphabetically. **Architect-level call: acceptable** because Q7=a says "auto-create" and the user accepted it. If user wants merge tools (manual canonical-casing pick), file as Spec 007.
- **`useStore.ingredientConversions` initial load:** verify it's loaded at boot. Quick grep for `fetchIngredientConversions` in `useStore.ts` should show a load-all call in the initial fetch path. If it's only loaded per-ingredient, the abstract-units dropdown derivation in §3 won't have data — backend-dev fixes by adding to the boot fetch.

### 12. Risks and tradeoffs

- **Migration ordering.** Categories backfill must apply BEFORE the frontend's CategoriesSection ships (otherwise the dropdown is empty for inventory rows whose categories aren't yet in `ingredient_categories`). Non-issue for prod deploy because migrations always apply first; flag for dev: don't merge frontend without the migration also landing.
- **RLS gap?** No. All tables involved already have admin-write policies. Read paths are authenticated-only. The `useRole` placeholder doesn't matter — DB-level enforcement is the gate.
- **Performance on the 286 KB seed dataset.** Categories list is at most a few dozen rows. Conversions list is ~hundreds at most. Vendor dropdown is brand-filtered (single-digit count today). All fits in memory; no pagination needed. The realtime channel filter for `ingredient_conversions` is unfiltered; assess once seed grows to multi-brand.
- **Edge function cold-start.** N/A — no edge function changes.
- **The `packUnit` rename.** Risky if `packUnit` is read by any other component besides `IngredientFormDrawer`. Frontend-dev must grep for `packUnit` across `src/` before renaming; if any other usage exists (search hint: Cmd+Shift+F `packUnit` in src/), surface as a halt — don't silently rename.
- **Vendor inline-add UX collision.** Opening `VendorFormDrawer` while inside `IngredientFormDrawer` puts two modals on screen. Both use `<Modal>` with backdrop click-outside — the topmost should capture clicks. Verify on web (z-index ordering should work; React Native modals stack natively). If broken, fall back to selection-only and file Q6 follow-up.
- **Realtime publication membership race.** If two devs run the realtime DDL migration concurrently (vanishingly unlikely), the `add table` is idempotent via the `if not exists` guard — safe.
- **Distinct purchase_units derivation client-side.** If two clients add the same new abstract unit nearly-simultaneously, they'll briefly see different lists. Realtime resolves it within 400ms. Acceptable.
- **The Q2=b "rename only" claim.** If the probe (F) shows that 90%+ of inventory rows have `sub_unit_size=NULL`, then the form's pack-unit dropdown change is functionally a NEW data field for the user — not "renaming labels." That's fine for the user's mental model, but the spec text framing as "no new data" is misleading. Surface to PM if needed.

### 13. Developer apply checklist (deploy / dev steps)

1. Run all probe SQL in §10 against local Postgres. Paste into the Probe results section above.
2. Compute the cost-calc baseline per §9; commit it as a comment in the migration file.
3. Author migrations:
   - `20260506HHMMSS_spec004_ingredient_categories_backfill.sql` (data, idempotent).
   - `20260506HHMMSS_spec004_realtime_publication_add_conversions.sql` (DDL).
4. Apply via `npm run dev:db` reset — verify `RAISE NOTICE` outputs match expectations.
5. **`docker restart supabase_realtime_imr-inventory`** — required because of the realtime publication-membership gotcha (CLAUDE.md). Skipping this means realtime updates for `ingredient_conversions` silently don't fire locally.
6. Implement backend (`db.ts` + store actions + realtime channel addition).
7. Implement frontend (form, drawer, conversions tab CRUD, CategoriesSection, sidebar wiring).
8. Re-run cost-calc probe per §9; numbers must match the baseline within 1e-6. Paste post-migration numbers into Probe results.
9. Smoke-test: add a category from the new section, add a vendor inline from the form's dropdown, edit an ingredient's pack unit, add an `ingredient_conversions` row from the conversions tab, delete it. Verify each survives reload.
10. Set `Status: READY_FOR_REVIEW` and list files changed under `## Files changed`.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: |
  Spec 004 is READY_FOR_BUILD. Implement the design under `## Design` in
  parallel.

  **backend-developer owns:**
    - The two migration files: the categories backfill
      (`20260506HHMMSS_spec004_ingredient_categories_backfill.sql`) and the
      realtime publication DDL
      (`20260506HHMMSS_spec004_realtime_publication_add_conversions.sql`).
      Idempotent, additive-only. SQL bodies sketched in §1 and §4.
    - Run all probe SQL in §10 first and populate the spec's "Probe results"
      section with real numbers; HALT and surface to PM if any result
      invalidates a locked answer (esp. G.null_brand > 0 or any column-shape
      surprise from I).
    - The three new functions in `src/lib/db.ts`:
      `createIngredientConversion`, `updateIngredientConversion`,
      `deleteIngredientConversion`. Snake-case mapping per §3.
    - The three new optimistic-then-revert actions in `src/store/useStore.ts`:
      `addIngredientConversion`, `updateIngredientConversion`,
      `deleteIngredientConversion`. Pattern in §8.
    - Add `ingredient_conversions` to the brand channel in
      `src/hooks/useRealtimeSync.ts` (no filter — see §4).
    - Verify `fetchIngredientConversions` is called in the boot-time fetch
      (so the form's abstract-units derivation has data); if not, add it.
    - Run the cost-calc invariant probe (§9) before AND after applying
      migrations; paste both numbers into Probe results. Numbers must match
      within 1e-6. **No flipping Status to READY_FOR_REVIEW without this.**
    - Apply `docker restart supabase_realtime_imr-inventory` after the
      realtime DDL migration runs locally — this is the publication-
      membership gotcha from CLAUDE.md.

  **frontend-developer owns:**
    - `src/components/cmd/IngredientForm.tsx`: replace 4 free-text inputs with
      dropdowns (category, default unit, pack unit, vendor). Surface
      `subUnitSize` + `subUnitUnit` as the canonical pack-contents pair.
      Numeric-only validation per §6. Help text under pack-unit per §7
      pointing abstract units to the Conversions tab.
    - `src/components/cmd/IngredientFormDrawer.tsx`: rename `packUnit` →
      `subUnitUnit` in `IngredientFormValues` to close the save-bug. Grep for
      `packUnit` across `src/` before renaming; halt and surface if any other
      usage exists.
    - `src/screens/cmd/sections/InventoryCatalogMode.tsx`'s
      `CatalogConversionsTab` (lines 551–612): inline add/edit/delete UI
      backed by the new store actions. Yield % behind a disclosure toggle.
      Numeric-only validation on factor and yield.
    - New `src/screens/cmd/sections/CategoriesSection.tsx`: list + add /
      rename / delete using existing store actions (lines 462–491). Block
      delete client-side if `inventory.some(i => i.category === name)` —
      toast on conflict. Pattern reference (do NOT modify):
      `src/screens/IngredientsScreen.tsx` `showCatModal`.
    - Wire `CategoriesSection` into the sidebar in
      `src/screens/cmd/InventoryDesktopLayout.tsx` (top-level item per Q5).
    - Vendor dropdown: filter `vendors` by `currentStore.brandId`. Add a
      "+ new vendor" sentinel that opens `VendorFormDrawer` modally; on save
      auto-select. Test the modal-stacking on web — fall back to selection-
      only if broken (per §12).

  After implementation, both devs collaborate on listing files changed under
  `## Files changed` in the spec, then set `Status: READY_FOR_REVIEW`.
payload_paths:
  - specs/004-ingredient-form-lookups.md

## Files changed

### Backend-developer (this pass)

**Migrations** (`supabase/migrations/`):
- `20260507010946_spec004_ingredient_categories_backfill.sql` — idempotent
  `ingredient_categories` backfill from distinct `lower(trim(...))` values
  on `catalog_ingredients.category` (and `inventory_items.category` if the
  legacy column still exists; on local it does not). Logs insert count via
  `RAISE NOTICE`. **Local apply: 2 rows inserted (`Produce`, `Dairy`).**
- `20260507010947_spec004_realtime_publication_add_conversions.sql` — adds
  `public.ingredient_conversions` to the `supabase_realtime` publication,
  guarded by `if not exists`. Idempotent / no-op on local (table was already
  a member). `docker restart supabase_realtime_imr-inventory` was run after
  apply per the CLAUDE.md realtime publication-membership gotcha.

**Application code:**
- `src/lib/db.ts` — added `createIngredientConversion`,
  `updateIngredientConversion`, and `deleteIngredientConversion`. Writes
  use `catalog_id` exclusively (legacy `inventory_item_id` column has been
  dropped post-P3). snake_case → camelCase mapping mirrors the existing
  `fetchIngredientConversions` mapper.
- `src/store/useStore.ts` — added `IngredientConversion` to the type imports;
  added `addIngredientConversion` / `updateIngredientConversion` /
  `deleteIngredientConversion` to the `StoreActions` interface and the
  store-creator object using the optimistic-then-revert + `notifyBackendError`
  pattern. Reuses the existing `ingredientConversions` slice (already hydrated
  at boot via `fetchAllForStore` → `fetchIngredientConversions`).
- `src/hooks/useRealtimeSync.ts` — added `ingredient_conversions` to the
  `brand-{brandId}` channel's table subscriptions. No filter — the table has
  no `brand_id` column (scope is inherited via the `catalog_id` FK), and
  PostgREST realtime filters can't follow FKs. The 400ms debounce in the
  caller cushions cross-brand noise.

### Fix-pass deltas (backend-developer, 2026-05-06 review-cycle 1)

Addresses release-coordinator FIXES_NEEDED items 1, 6, and 8a from
`specs/004-ingredient-form-lookups/reviews/release-proposal.md`. Frontend-
developer is running in parallel and owns the cascading consumer cleanups
(InventoryCatalogMode.tsx, IngredientForm.tsx, CategoriesSection.tsx,
IngredientFormDrawer.tsx) per the proposal's split.

**Item 1 — Type the `ingredientConversions` slice properly** (clears all 3
code-reviewer Criticals + one Should-fix in one edit):
- `src/types/index.ts` — `AppState.ingredientConversions` changed from
  `IngredientConversion[] | undefined` to `IngredientConversion[]`
  (non-optional). Comment updated to reflect that `useStore` always
  initializes to `[]`.
- `src/store/useStore.ts:190` — initial value changed from `[] as any[]`
  to `[] as IngredientConversion[]`.
- `src/store/useStore.ts:503-552` — removed all 6 defensive
  `(s.ingredientConversions || []) as IngredientConversion[]` casts in
  `addIngredientConversion` / `updateIngredientConversion` /
  `deleteIngredientConversion`. They are now bare `s.ingredientConversions`
  reads with the proper type flowing from the slice declaration.
- Pre-existing `|| []` fallbacks at lines 1213 and 1287 (cost-calc
  consumers) left untouched — out of scope for this fix pass.

**Item 6 — Reconcile `updateIngredientConversion` return contract**
(option (a): apply the saved row, matching `addIngredientConversion`):
- `src/store/useStore.ts:530-538` — `updateIngredientConversion` now
  threads `.then((saved) => set(...))` before `.catch()` so the server's
  authoritative row replaces local state on success. Mirrors the pattern
  already used by `addIngredientConversion` (line 507 onward). The
  optimistic patch-merge stays in place; the saved-row apply happens
  after the round-trip resolves.
- `src/lib/db.ts:1156-1180` — unchanged. The function already returned
  `Promise<IngredientConversion>` with a properly mapped row.

**Item 8a — Tighten RLS on `ingredient_categories`** (closes the
inherited high-severity gap the security-auditor flagged; pre-existing
since `20260502071736_remote_schema.sql:300-305` overwrote the original
admin-gated split, never re-tightened by P5):
- New migration: `supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql`.
  Drops `auth_manage_ingredient_categories` (the permissive
  `for all to public using (auth.uid() is not null)` policy) and
  re-creates the granular admin-gated split using `auth_is_admin()` —
  same shape Phase 5 applied to `ingredient_conversions` at
  `20260504073942_brand_catalog_p5_rls.sql:176-198`. Idempotent.
- **Local apply verified:** migration ran cleanly via
  `npx supabase migration up --local`. `pg_policies` query against
  `ingredient_categories` returns exactly 4 rows: 1 SELECT (auth-only),
  1 INSERT / 1 UPDATE / 1 DELETE (all admin-gated via
  `auth_is_admin()`).
- **Smoke-test verified:** an authenticated non-admin role
  (`set local request.jwt.claims = '{"sub":"…","role":"authenticated","app_metadata":{}}'`)
  attempting `insert into ingredient_categories` is denied with
  `ERROR: new row violates row-level security policy for table
  "ingredient_categories"`. The same insert with
  `app_metadata.role = "admin"` succeeds and returns the row.

**TypeScript check:** `npx tsc --noEmit` shows zero new errors related
to the typing change. The pre-existing repo-wide error set
(AdminScreens.tsx / IngredientsScreen.tsx / PrepRecipesScreen.tsx /
useStore.ts `storeLoading`-on-FullStore noise / scripts/test-unit-conversion
.ts catalogId / etc.) is unchanged. No new `(s: any)` or `(c: any)` casts
needed downstream of the slice — frontend-dev's parallel pass will remove
the ones currently in their owned files.

**Browser verification:** the change is invisible to the running browser
preview (admin@local.test session). The slice typing is a compile-time
edit; the new `updateIngredientConversion` saved-row apply re-emits the
same data shape the optimistic patch had already merged; the RLS migration
only narrows write permissions for non-admin sessions, and the local
preview user is admin. No browser-visible behavior delta to verify.

**Fix-pass files changed (this pass):**
- `src/types/index.ts` (interface, non-optional)
- `src/store/useStore.ts` (slice initializer + 3 actions)
- `supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql` (new)

**Status:** left at `READY_FOR_REVIEW` per the proposal's coordination
note. Frontend-developer (running in parallel) owns items 2, 3, 4, 5, and 7;
the last dev to finish is responsible for any further status flip.

**Spec:**
- `specs/004-ingredient-form-lookups.md` — populated the Probe results
  section with the actual local-DB numbers and the cost-calc invariant
  table (pre and post migration: identical, delta = 0). Set
  `Status: READY_FOR_REVIEW`.

### Frontend-developer (this pass)

**Application code (modifications):**
- `src/utils/unitConversion.ts` — exported `CANONICAL_WEIGHT_UNITS`,
  `CANONICAL_VOLUME_UNITS`, `CANONICAL_UNITS` arrays and `isCanonicalUnit()`
  helper so the form / conversions tab can drive their dropdowns and
  abstract-unit warning logic from the same single source of truth as
  `getConversionFactor`. No behavior change to existing exported functions.
- `src/components/cmd/IngredientForm.tsx` — replaced four free-text
  `<InputLine>`s (category / default unit / pack unit / primary vendor)
  with a new colocated `<SelectField>` component (web uses native
  `<select>` for accessibility + correct stacking inside the drawer Modal;
  native gets a TouchableOpacity-based fallback). `subUnitSize` now
  surfaces as a numeric input next to "pack size" (caseQty), and
  `subUnitUnit` is the "pack unit" dropdown — restricted to canonical
  mass/volume units per spec §7. Numeric-only validation (`^\d*\.?\d*$`)
  added to `caseQty`, `subUnitSize`, `costPerUnit`, `parLevel`, and
  `casePrice`. Yellow inline warning shows when default unit is abstract
  AND no `ingredient_conversions` row exists for that purchase_unit
  string (matches dropdown derivation; conservative — fires on global
  miss, not per-ingredient miss). Renamed the form-state field
  `packUnit` → `subUnitUnit` and dropped the dead `packSize` / `altUnits`
  stubs. Vendor dropdown filters by `currentStore.brandId` and shows a
  "+ new vendor…" sentinel that fires the new `onAddVendor` prop.
- `src/components/cmd/IngredientFormDrawer.tsx` — closes the
  `packUnit`-save-bug by aligning the form values shape with what
  `toUpdates()` writes (now that `IngredientFormValues.subUnitUnit` is
  the canonical slot, the existing mapper Just Works). Adds inline-add
  vendor wiring: snapshots vendor ids before opening
  `<VendorFormDrawer mode="new">`, and on close diff-finds the new
  vendor and auto-selects it via `setValues`. The vendor drawer is
  rendered as a sibling to the ingredient drawer's Modal (not inside
  it) to avoid backdrop / z-index battles per spec §12. Added
  `vendorId` to `toUpdates()` so the FK round-trips on save (was
  previously only set in the NEW-mode addItem path, leaving EDIT mode
  silently writing only `vendorName`).
- `src/components/cmd/JsonPreview.tsx` — updated the live-JSON preview
  to show `sub_unit_size` + `sub_unit_unit` (the renamed field) instead
  of the old `packUnit`. Pure display change.
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` —
  `CatalogConversionsTab` (lines 551–612 of the prior file) now offers
  inline add / edit / delete, all routed through the new store actions
  (`addIngredientConversion` / `updateIngredientConversion` /
  `deleteIngredientConversion` from backend-dev's pass). Add row UI:
  free-text purchase_unit (with chip suggestions from existing distinct
  values), canonical-units-only base_unit dropdown, numeric factor,
  optional `net_yield_pct` behind a disclosure toggle that defaults to
  100. Each existing row gains EDIT (inline) and DEL (with
  `confirmAction`) actions. The "FIX — NO CONVERSIONS" empty state is
  preserved with a copy update directing the user to the add form
  above.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — wired the new
  `CategoriesSection` into the sidebar's "Planning" group (top-level
  per Q5, separate from recipe categories) and the section dispatch
  switch.

**Application code (new files):**
- `src/screens/cmd/sections/CategoriesSection.tsx` — new top-level Cmd
  UI admin section for `ingredient_categories`. List with add / rename
  / delete actions, modeled on the legacy `IngredientsScreen.tsx`
  `showCatModal` pattern (legacy reference; not modified). Reuses the
  existing `useStore.addIngredientCategory` /
  `updateIngredientCategory` / `deleteIngredientCategory` actions — no
  duplicated CRUD. Delete is blocked client-side when any
  `inventory.category === name`, with a toast on conflict.

**Verification:**
- `npm install` had to be run first (no `node_modules/` checked out).
- Local TypeScript check (`./node_modules/.bin/tsc --noEmit`) passes
  with no NEW errors in any file touched here. The 149 pre-existing
  errors (mostly in `AdminScreens.tsx` / `IngredientsScreen.tsx` /
  `useSupabaseStore.ts` / supabase function `Deno` globals) were
  present before this change and are unchanged afterward (verified by
  stashing and re-running).
- `npm run web` (`expo start --web`) bundles cleanly. The bundle URL
  `http://localhost:8081/node_modules/expo/AppEntry.bundle?platform=web…`
  returns HTTP 200 with the new identifiers (`addIngredientConversion`,
  `deleteIngredientConversion`, `CategoriesSection`,
  `abstractUnitWarning`, `handleVendorChange`, `NEW_VENDOR_SENTINEL`,
  `isCanonicalUnit`, `CANONICAL_UNITS`) all present.
- **Browser preview (preview_* MCP) was unavailable in this agent
  session** — the chrome / computer-use MCP tools were not loaded into
  the tool list and direct screenshot / click verification was not
  possible. Code-reviewer / test-engineer should re-verify in a real
  browser per the spec acceptance checklist (open form on existing
  item, switch dropdowns, abstract-unit warning, conversions
  add/edit/delete, categories add/rename/delete-blocking).

## Fix-pass deltas (release-coordinator FIXES_NEEDED, 2026-05-06)

Frontend-developer fix-pass addressing items 1-5 + N1 from
`specs/004-ingredient-form-lookups/reviews/release-proposal.md`. Backend-
developer is running in parallel and owns item 8 (RLS migration) plus the
slice typing in `useStore.ts:190` and the `db.ts` return contract.

**Files changed (frontend, this fix-pass):**
- `src/utils/validators.ts` — **new file**. Single source of truth for the
  numeric-input regex used by `IngredientForm` and the catalog conversions
  tab. Tightened from `/^\d*\.?\d*$/` to `/^(\d+\.?\d*|\d*\.\d+|)$/` so the
  lone `"."` (which `parseFloat` returns NaN for, then was silently coerced
  to `0`) is rejected at the keystroke. De-duplicates the inline regex
  previously copied across two files. (Fix-pass items 3 + 4.)
- `src/components/cmd/IngredientForm.tsx`:
  - Imports `isNumericInput` from the new `validators.ts`; dropped the
    inline `NUMERIC_RE` / `isNumericInput` definitions.
  - Replaced `useStore((s: any) => s.ingredientConversions || [])` with
    `useStore((s) => s.ingredientConversions)` — the slice is typed
    `IngredientConversion[]` (non-optional) on `AppState` and backend-dev's
    `useStore.ts:190` initializer no longer carries `as any[]`.
  - Dropped the `c.purchaseUnit || c.purchase_unit` snake_case fallback in
    `defaultUnitOptions`. Same in the `abstractUnitWarning` predicate;
    removed the `(c: any)` cast there.
  - Added a multi-line comment at the `each` carve-out in
    `abstractUnitWarning` explaining why it's exempt from the yellow
    "no conversion defined" warning. (Fix-pass N1.)
- `src/screens/cmd/sections/InventoryCatalogMode.tsx`:
  - Imports `NUMERIC_RE` from `validators.ts`; dropped the inline copy.
  - Dropped `(s: any)` casts on the three conversion action selectors
    (`addIngredientConversion` / `updateIngredientConversion` /
    `deleteIngredientConversion`).
  - Dropped the `(c: any)` cast and the dead `c.catalogId` branch in the
    `conversions` filter — `IngredientConversion.inventoryItemId` is the
    sole keying column on the type, and `catalogId` doesn't exist there.
    The conversions list now reads `allConversions.filter((c) => ids.has(c.inventoryItemId))`.
  - Dropped the `(sel.primary as any).catalogId` cast in `writeCatalogId` —
    `InventoryItem.catalogId` is typed (required string at types/index.ts:56).
  - Dropped the `(c: any)` cast in `purchaseUnitOptions` and the
    `c.purchaseUnit || c.purchase_unit` fallback.
  - `startEdit`/`handleDelete` now take `IngredientConversion` instead of
    `any`; the dual-access snake_case fallbacks (`conv.purchase_unit`,
    `conv.base_unit`, `conv.conversion_factor`, `conv.net_yield_pct`) are
    gone from both the edit-prefill and the display rows.
  - Dropped the `typeof addIngredientConversion === 'function'` /
    `typeof updateIngredientConversion === 'function'` /
    `typeof deleteIngredientConversion === 'function'` runtime guards and
    their dead else-branches — actions are non-optional on the typed
    store.
  - **Tightened `net_yield_pct` validation in both `handleAdd` and
    `saveEdit`**: empty input falls back to 100 (the column default); any
    non-empty input must parse to a number in `(0, 100]` or the save is
    aborted with a Toast error "Yield % must be between 0 and 100".
    Replaces the previous `isFinite(yieldN) && yieldN > 0 ? yieldN : 100`
    that silently coerced negative or NaN input to 100. (Fix-pass item 3 /
    security-auditor M1.)
- `src/screens/cmd/sections/CategoriesSection.tsx` — DELETE button on the
  in-use category row is no longer `disabled={count > 0}` and no longer
  carries the dimmed (`opacity: 0.45`) styling. Clicking always fires
  `handleDelete`, which surfaces the existing Toast + inline warning when
  the category is in use. Resolves the disabled-vs-toast divergence flagged
  by code-reviewer / test-engineer / backend-architect. (Fix-pass item 2.)
- `src/components/cmd/IngredientFormDrawer.tsx` — SAVE button is no longer
  `disabled={!requiredValid}` and no longer dims to 60% opacity when the
  form is invalid. Clicking always fires `handleSave`, which surfaces the
  existing Toast on missing required fields. The footer "0/3 required
  valid" string already communicates the form state visually. Same
  rationale as the categories DELETE fix above. (Fix-pass item 2.)

**Verification (this fix-pass):**
- `./node_modules/.bin/tsc --noEmit` total error count is **149** —
  identical to the baseline before this fix-pass and matching the prior
  pass's note. **Zero new errors in any of the five files touched here**
  (verified via grep on the fixed file paths).
- Bundle compiles cleanly via the running `expo start --web` server on
  port 8082 (HTTP 200 on the AppEntry bundle URL). The new identifiers
  (`Yield % must be between 0 and 100`, `isNumericInput` from validators,
  `spec 004 fix-pass` comment marker) are present in the bundled output.
- **Browser-side interactive verification (preview_* / claude-in-chrome /
  computer-use MCP tools) was again not loaded into this agent session's
  toolkit.** The four interactive checks listed in the fix-pass plan
  (categories DELETE on in-use is enabled and toasts; SAVE on empty form
  is enabled and toasts; lone-dot rejection on numeric inputs; yield %
  >100 surfaces toast) need to be exercised by the reviewers (or main
  Claude in a follow-up session) before ship. The code paths are
  in-place and bundle cleanly; the keystroke-level rejection is a pure
  regex tightening with no UI surface to misbehave.

**Items NOT touched here (other agent or out of scope):**
- Fix-pass item 1 root cause — `useStore.ts:190` initializer typing and
  the `AppState.ingredientConversions` slice type (owned by
  backend-developer). The frontend casts removed here depend on that
  fix; verified mid-pass that backend-dev's commit landed
  (`useStore.ts:190` is now `[] as IngredientConversion[]`, and the six
  defensive `(s.ingredientConversions || []) as IngredientConversion[]`
  casts in the action bodies are bare reads).
- Fix-pass item 6 — `db.updateIngredientConversion` return contract
  (owned by backend-developer per the proposal).
- Fix-pass item 7 — manual save-then-reload round-trip on the four
  dropdowns (GAP-1). Browser preview tools unavailable; reviewers /
  main Claude follow-up.
- Fix-pass item 8 — `auth_manage_ingredient_categories` RLS migration
  (owned by backend-developer; `20260507015244_spec004_ingredient_categories_rls_p6.sql`
  is in the staged migrations list).

