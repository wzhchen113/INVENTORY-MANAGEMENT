# Spec 122: Catalog-mode per-store edits apply brand-wide (par fan-out) + fix wrong-store binding

Status: READY_FOR_REVIEW

## Context / motivating bug (diagnosed, with prod evidence)

In the brand-level **catalog.tsv** inventory view
(`src/screens/cmd/sections/InventoryCatalogMode.tsx`), the catalog groups every
store's `inventory_items` row for an ingredient under one lowercase-name key and
picks a `primary` row = the FIRST row encountered while building the group
(`InventoryCatalogMode.tsx:122`, `primary: it`). Opening the edit drawer binds
that arbitrary primary row to the form (`InventoryCatalogMode.tsx:752`,
`item={sel?.primary}`). The primary is whatever store was iterated first — NOT
the store the user is currently in.

Consequence: **per-store fields** (par_level, cost, etc.) are both DISPLAYED
from and SAVED to the wrong store.

**Confirmed prod repro:** a user in the **Charles** workspace edited
"Corn On Cob 3\"" par to 480. The form showed and saved 480 to **Frederick's**
row (the primary), while **Charles's** row stayed at par 4. Charles's EOD count
and reorder screens — which correctly read Charles's own `inventory_items` row —
never reflected the change. Prod par for that catalog at time of report:
Frederick 480, Charles 4, Towson 4, Reisters 4.

**Data model:** `par_level` is `inventory_items.par_level`, strictly per-store
(one row per store). Name / unit / category are brand-wide via
`catalog_ingredients`, which is why NAME edits from catalog mode APPEAR to work
(they hit the shared catalog row) while per-store edits silently land on the
wrong store. Per-store `inventory_items` scalar fields written by the current
Save path (`src/lib/db.ts` `updateInventoryItem`, lines 444-464) are:
`cost_per_unit`, `current_stock`, `par_level`, `vendor_id`, `usage_per_portion`,
`expiry_date`, `case_price`.

## User decision (confirmed by owner)

When editing a per-store value from the **brand-level catalog view**, it should
**apply to ALL stores in the brand** — the "this IS the ingredient" mental model
of the catalog view. This is the chosen behavior for the **catalog.tsv** view
specifically. The per-store **items.tsv** view MUST remain single-store
(unchanged). Because a brand-wide apply covers config/threshold fields but must
NOT clobber live physical counts, the fan-out set is enumerated below and is a
FIRM requirement, not an open question.

## User story

As a brand admin editing an ingredient from the brand-level catalog.tsv view, I
want my per-store edits (starting with par level) to apply to that ingredient
across EVERY store of the brand, so that all stores' EOD count and reorder
screens reflect the change — instead of the edit silently landing on one
arbitrary store while the store I was actually looking at stays stale.

## Acceptance criteria

### Fix the wrong-store binding (display + save)

- [ ] **AC-1 (display fix):** When the edit drawer is opened from catalog.tsv,
      the form is seeded from the CURRENT store's `inventory_items` row for that
      catalog ingredient when one exists (`row.storeId === currentStore.id`), NOT
      from `sel.primary` (the arbitrary first row). If the current store has no
      row for the ingredient, the form falls back to a deterministic
      representative row (e.g. `sel.primary`) rather than a random one; the
      spec's chosen fallback is documented in the design.
- [ ] **AC-2 (repro closed — per-store save no longer mis-targets):** Editing
      par from catalog.tsv for the Corn-On-Cob repro no longer writes the value
      to a non-current store while leaving the current store stale. After the
      edit, the current store's row reflects the new value.

### Brand-wide fan-out of per-store CONFIG fields

- [ ] **AC-3 (par fans out — the core requirement):** Saving a `par_level` edit
      from catalog.tsv applies the new par to the catalog ingredient's
      `inventory_items` row in EVERY store of the current brand the caller can
      see via `auth_can_see_store()`, including the current store. After the
      Corn-On-Cob repro edit to 480 from Charles, all four visible brand stores
      (Frederick / Charles / Towson / Reisters) read par 480.
- [ ] **AC-4 (fan-out reflected downstream in EVERY store):** Each affected
      store's EOD count screen and reorder screen — which read that store's own
      `inventory_items` row — reflect the new par for that store, not just the
      store the edit was made from.
- [ ] **AC-5 (current_stock NEVER fans out):** A catalog.tsv edit MUST NOT
      overwrite any store's `current_stock`. `current_stock` is a live physical
      on-hand count that legitimately differs per store; brand-wide-writing it
      would corrupt inventory. If the drawer's `current_stock` field is edited,
      that value applies to the CURRENT store only (single-store, same as today),
      and is never propagated to other stores.
- [ ] **AC-6 (count-like / physical fields NEVER fan out):** The following stay
      strictly per-store (current store only, never propagated):
      `current_stock`, `expiry_date`, `usage_per_portion`, and any
      average-daily-usage / physical-safety-stock field. Only the CONFIG /
      threshold fields enumerated in AC-7 fan out.
- [ ] **AC-7 (fan-out field set — firm enumeration):** The brand-wide apply
      covers exactly these per-store fields: `par_level` (REQUIRED — the core
      need), and `cost_per_unit` + `case_price` (see OQ-1 — recommended IN, but
      the one open decision). No other `inventory_items` scalar field fans out.
      Vendor-link fan-out already exists (spec 119, `apply_item_vendors_to_brand`)
      and is out of scope here.
- [ ] **AC-8 (brand-scoped, never cross-brand):** Propagation is scoped to the
      current brand only; stores in other brands are never touched, and
      `auth_can_see_store()` is respected — a store the caller cannot see is
      never read or written.
- [ ] **AC-9 (only-existing rows; skipped accounting):** v1 targets ONLY stores
      where the catalog ingredient ALREADY has an `inventory_items` row. Stores
      missing the row are NOT created; they are counted and reported as skipped
      (mirrors spec 119 AC-9).
- [ ] **AC-10 (outcome reported):** The action reports how many stores were
      updated and how many were skipped. Any partial failure surfaces via
      `notifyBackendError` (optimistic-then-revert + toast) rather than silently
      succeeding.
- [ ] **AC-11 (privileged gate):** The fan-out is gated on
      `auth_is_privileged()` + `auth_can_see_brand()` + per-store
      `auth_can_see_store()`, byte-aligned with spec 119's
      `apply_item_vendors_to_brand`.
- [ ] **AC-12 (realtime):** Other admin clients viewing an affected store see the
      new par without a manual reload, because each affected `inventory_items`
      row change lands on that store's `store-{id}` channel already wired in
      `useRealtimeSync` (`inventory_items` is already in the realtime
      publication — architect to confirm; publication gotcha does not apply to a
      function-only migration).

### items.tsv stays single-store (regression guard)

- [ ] **AC-13 (items.tsv unchanged):** Editing par / cost / any per-store field
      from the per-store **items.tsv** view continues to write ONLY the current
      store's `inventory_items` row, with no brand-wide fan-out. This behavior is
      unchanged by this spec.

## In scope

- Admin Cmd UI only. Fix the catalog.tsv drawer binding so it seeds from and
  saves to the CURRENT store (AC-1/AC-2), and add brand-wide fan-out for the
  enumerated CONFIG fields when saving from catalog.tsv (AC-3–AC-11).
- A brand-wide propagation path modeled on spec 119: a SECURITY DEFINER RPC
  (privileged + `auth_can_see_brand` + per-store `auth_can_see_store`,
  only-existing-rows, skipped-store accounting) + a `db.ts` thin wrapper + a
  `useStore` action, analogous to `apply_item_vendors_to_brand` /
  `applyItemVendorsToBrand` / `applyVendorsToAllStores`.
- A user-visible summary of updated / skipped store counts.
- Keeping items.tsv single-store (regression guard only, no behavior change).

## Out of scope (explicitly)

- **`current_stock` fan-out.** Explicitly forbidden (AC-5) — it is a live
  physical count that differs per store; propagating it would corrupt inventory.
- **Count-like / physical field fan-out** (`expiry_date`, `usage_per_portion`,
  average-daily-usage, physical safety-stock) — AC-6. These are per-store by
  nature.
- **Catalog-level fields** (name, unit, category, case_qty, sub_unit_*,
  i18n_names). These already propagate brand-wide via `catalog_ingredients`
  today; unchanged.
- **Vendor-link fan-out.** Already shipped as spec 119
  (`apply_item_vendors_to_brand`). Not re-implemented here.
- **Creating `inventory_items` rows** in stores that lack the ingredient (v1
  targets only-existing rows and reports the rest as skipped — AC-9).
- **Changing items.tsv behavior** — it stays single-store (AC-13).
- **A bulk / multi-ingredient "apply to all stores" batch tool.** Per-single
  ingredient at edit time.
- **Retroactive reconciliation** of already-drifted pars across the catalog. The
  Corn-On-Cob rows were reported hand-fixed; a catalog-wide audit is a separate
  spec if wanted.
- Staff app and customer PWA.

## Open questions

### For the user (one genuinely-open decision)

- **OQ-1 — Does cost fan out too, or par only?** The core confirmed requirement
  is that **par_level** fans out. The open decision is whether `cost_per_unit`
  and `case_price` should ALSO fan out on a catalog.tsv save.
  - **Recommendation: IN (fan out par + cost + case_price).** Rationale: from the
    catalog "this IS the ingredient" mental model, price is typically a
    brand-negotiated attribute and the same wrong-store binding bug currently
    mis-targets cost the same way it mis-targets par. Fanning cost out keeps the
    catalog view internally consistent.
  - **Argument for OUT (par only):** spec 119's vendor fan-out deliberately
    PRESERVES each store's existing per-vendor `cost_per_unit` / `case_price`
    (non-destructive, because stores can negotiate different prices). If prices
    legitimately differ per store, a par-only fan-out avoids clobbering them.
  - This is the one decision that changes AC-7's field set. If the user chooses
    OUT, AC-7 narrows to `par_level` only and cost/case_price stay single-store
    (current-store only).

### For the architect

- **OQ-2 — Preserve-vs-overwrite semantics for the fanned fields.** Spec 119's
  vendor RPC preserves existing per-store prices and only seeds NEW links. For
  par (and cost, if OQ-1 = IN), the natural read of the owner's decision is a
  straight OVERWRITE to every store (that is what "apply to all stores" means for
  a threshold like par). Architect to confirm overwrite (recommended) vs any
  preserve carve-out, and document it. Note this differs intentionally from spec
  119's preserve semantics because par is a single scalar the owner wants
  uniform, not a per-store-negotiated link price.
- **OQ-3 — One combined RPC vs a par-specific RPC.** Whether to author a new
  `apply_item_fields_to_brand(catalog_id, fields jsonb)` style RPC that fans the
  enumerated CONFIG fields, or a narrower `apply_item_par_to_brand`. Mirror the
  spec 119 shape either way (return `{updated_count, skipped_count,
  skipped_store_ids}`).
- **OQ-4 — UX trigger.** Whether the brand-wide apply is (a) the DEFAULT behavior
  of Save in catalog.tsv (since the owner's decision is that catalog edits ARE
  brand-wide), or (b) a separate explicit "Apply to all stores" button like spec
  119's vendor button, with Save staying current-store. The owner's stated mental
  model ("this IS the ingredient") leans toward (a) default-brand-wide FOR THE
  ENUMERATED FIELDS, with `current_stock` and count-like fields always staying
  current-store even under (a). Architect to choose and justify; whichever is
  chosen, AC-5/AC-6 (stock and count-like never fan out) hold.

## Dependencies

- **Spec 119 precedent** — `apply_item_vendors_to_brand` RPC
  ([supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql](../supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql)),
  `applyItemVendorsToBrand` ([src/lib/db.ts:534](../src/lib/db.ts)),
  `applyVendorsToAllStores` (`src/store/useStore.ts`), and the "Apply vendors to
  all stores" button in `IngredientForm` / `IngredientFormDrawer`. This spec is
  the par/cost analog and should reuse the SECURITY DEFINER + privileged +
  `auth_can_see_brand` + per-store `auth_can_see_store` + only-existing-rows +
  skipped-accounting pattern.
- **Per-store Save path** — `updateInventoryItem`
  ([src/lib/db.ts:389](../src/lib/db.ts)); per-store field split at lines 444-464.
- **Per-store RLS hardening** — `auth_can_see_store()`
  ([supabase/migrations/20260504173035_per_store_rls_hardening.sql](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)).
- **Catalog view** — `src/screens/cmd/sections/InventoryCatalogMode.tsx`
  (group `primary` binding at :122, drawer `item={sel?.primary}` at :752). The
  main `InventoryCatalogMode` component does not currently read `currentStore`
  (only `CatalogStoresTab` does) — the display fix needs it in scope.
- **Editor** — `src/components/cmd/IngredientForm.tsx`,
  `src/components/cmd/IngredientFormDrawer.tsx`.
- **Realtime** — `store-{id}` channel via
  [src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts).
- Per-each cost basis (spec 104) — relevant only if OQ-1 = IN (cost fans out);
  `cost_per_unit` is per-EACH and would be copied verbatim (no cost math).

## Project-specific notes

- **Cmd UI section / legacy:** Cmd Inventory catalog.tsv view
  (`src/screens/cmd/sections/InventoryCatalogMode.tsx`) + the shared editor
  (`IngredientForm` / `IngredientFormDrawer`). No legacy surface.
- **Per-store or admin-global:** brand-scoped. The feature deliberately fans a
  per-store write out across all stores of the CURRENT brand (never cross-brand),
  gated by `auth_can_see_store()`. `current_stock` and count-like fields remain
  strictly per-store (current store only).
- **Realtime channels touched:** `store-{id}` for each affected store. RISK — the
  realtime publication gotcha: confirm `inventory_items` is in the
  `supabase_realtime` publication (it is, from init schema — architect to
  verify). A function-only migration does NOT change publication membership, so
  the `docker restart supabase_realtime_imr-inventory` ritual does not apply.
- **Migrations needed:** YES — a new SECURITY DEFINER RPC (function-only,
  additive, reversible via `drop function`). Prod-apply via the "Prod migration
  via Supabase MCP" convention (MEMORY.md); the `db-migrations-applied.yml` gate
  hard-fails between repo-commit and prod-apply, so apply in the same window.
- **Edge functions touched:** none (PostgREST/RPC path, JWT-protected).
- **Web/native scope:** same as the rest of the Cmd admin UI. No web-only APIs;
  no `app.json` / build-identifier changes.
- **Tests:** pgTAP for the RPC (par fan-out across visible brand stores; cost/
  case_price fan-out iff OQ-1 = IN; `current_stock` + count-like fields NEVER
  written to other stores; no cross-brand write; per-store `auth_can_see_store`
  scoping; only-existing-rows + skipped count). jest for the drawer's
  current-store binding fix (AC-1) and the store-action wiring, and a guard that
  items.tsv stays single-store (AC-13). No shell smoke expected.

---

## Backend design

Resolved user decisions baked in (do NOT re-open): OQ-1 = **par + cost + case_price
all fan out** (nothing else); OQ-2 = **OVERWRITE** semantics (intentionally
different from spec 119's preserve — see §"Overwrite vs 119 preserve" below);
OQ-3 = **one combined scalar RPC** (`apply_item_scalars_to_brand`); OQ-4 =
**automatic on Save in catalog.tsv**, no extra button.

### 1. Data model changes

**None.** No new tables, columns, or indexes. This is a function-only, additive,
fully-reversible migration — identical class to spec 119. The fan-out set
(`par_level`, `cost_per_unit`, `case_price`) already exists on `inventory_items`
(init schema + spec 104 widened the cost columns to `numeric(12,6)`). No
destructive DDL; rollback is `drop function public.apply_item_scalars_to_brand(uuid, numeric, numeric, numeric);`.

**Proposed migration filename:**
`supabase/migrations/20260717000000_apply_item_scalars_to_brand.sql`
(verified free — the migration set runs `20260710…` → `20260716000000`; the next
slot `20260717000000` has no collision).

**RPC signature (SECURITY DEFINER, `set search_path = public`):**

```
apply_item_scalars_to_brand(
  p_catalog_id     uuid,
  p_par_level      numeric,   -- NULL ⇒ skip this field on every store
  p_cost_per_unit  numeric,   -- NULL ⇒ skip
  p_case_price     numeric    -- NULL ⇒ skip
) returns jsonb   -- { updated_count, skipped_count, skipped_store_ids }
```

**NULL-means-skip convention.** A catalog Save always sends all three non-NULL, so
in practice all three fan out on every catalog save. NULL-per-param is kept as the
"leave this field alone on every store" escape hatch (defensive + future-proof:
lets a caller propagate par only, cost only, etc. without a new RPC). This is the
cleanest representation of "which fields to write" given a fixed 3-scalar payload —
no jsonb bag needed (contrast 119's `p_vendors jsonb`, which had a variable link
set). Each written field is `coalesce(p_<field>, ii.<field>)` so a NULL param is a
literal no-op on that column.

**Body shape (single atomic UPDATE, not a per-row loop).** Unlike 119 — which
loops because each store needs an upsert/delete reconcile of the `item_vendors`
junction — this fan-out is a plain scalar overwrite, so a single set-based UPDATE
is cleaner, atomic, and gives the same per-store `auth_can_see_store()` guarantee
by putting the check in the WHERE predicate (semantically identical to 119's
in-loop belt-and-suspenders gate; each row is admitted only if the caller can see
its store):

```
-- 1. auth_is_privileged() else raise 'privileged only'
-- 2. select brand_id from catalog_ingredients where id = p_catalog_id;
--    null ⇒ raise 'catalog ingredient not found'
-- 3. if not auth_can_see_brand(v_brand_id) then raise 'brand not accessible'
-- 4. update public.inventory_items ii
--       set par_level     = coalesce(p_par_level,     ii.par_level),
--           cost_per_unit  = coalesce(p_cost_per_unit,  ii.cost_per_unit),
--           case_price     = coalesce(p_case_price,     ii.case_price),
--           updated_at     = now()
--     where ii.catalog_id = p_catalog_id
--       and public.auth_can_see_store(ii.store_id);   -- per-store gate (AC-8/AC-11)
--    GET DIAGNOSTICS v_updated = ROW_COUNT;
-- 5. authoritative skipped set — visible brand stores with NO row for this
--    catalog (byte-for-byte the same query as 119, AC-9): array_agg(s.id) from
--    stores where brand_id = v_brand_id and auth_can_see_store(s.id) and
--    not exists(inventory_items for this catalog+store).
-- 6. return jsonb_build_object('updated_count', v_updated, 'skipped_count',
--    coalesce(array_length(v_skipped_ids,1),0), 'skipped_store_ids',
--    to_jsonb(v_skipped_ids));
```

**"Mirror the legacy scalars if any" — N/A here.** 119 had to mirror
`inventory_items.vendor_id` because `item_vendors.is_primary` is the real source
and the scalar is a legacy denormalization. `par_level`/`cost_per_unit`/`case_price`
have no junction table and no legacy mirror — they ARE the columns. Nothing extra
to mirror.

**`current_stock` / count-like fields are NOT parameters** — structurally
impossible for this RPC to touch them (AC-5/AC-6 enforced by construction, not by
a runtime guard). The UPDATE names exactly three columns.

**Overwrite vs 119 preserve (OQ-2 — flag for reviewers).** Spec 119
DELIBERATELY preserves each store's existing per-vendor `cost_per_unit`/`case_price`
(a store can negotiate its own price with a shared vendor). This spec
DELIBERATELY OVERWRITES par/cost/case_price on every visible store with the typed
value, because the owner's catalog "this IS the ingredient" model wants those
three uniform brand-wide. **This divergence is intentional and correct — do NOT
flag it as an inconsistency between 119 and 122.** The migration header comment
must call this out explicitly (mirror 119's header prose style).

**Grants:** `revoke execute … from public, anon; grant execute … to authenticated;`
(byte-aligned with 119). SECURITY DEFINER + the three auth gates are the real
enforcement; the grant just keeps anon out.

### 2. RLS impact

No new table ⇒ no new policies. The RPC is SECURITY DEFINER and self-gates
identically to 119 (AC-11):

- `auth_is_privileged()` — caller must be admin/super-admin, else `raise 'privileged only'`.
- `auth_can_see_brand(v_brand_id)` — never cross-brand, else `raise 'brand not accessible'`.
- `auth_can_see_store(ii.store_id)` in the UPDATE WHERE — a store the caller cannot
  see is neither read nor written (AC-8). Same helper the per-store `inventory_items`
  "Store access" policy (init schema :265) uses, so the definer path cannot exceed
  what the caller could reach via normal PostgREST.

No existing policy needs editing. `updateInventoryItem`'s per-store write path is
untouched (items.tsv stays single-store — AC-13).

### 3. API contract

**PostgREST RPC** (not a table/view): `rpc('apply_item_scalars_to_brand', …)`.
JWT-protected (default `verify_jwt`), no edge function.

- **Request:** `{ p_catalog_id: uuid, p_par_level: number|null, p_cost_per_unit: number|null, p_case_price: number|null }`
- **Response (200):** `{ updated_count: int, skipped_count: int, skipped_store_ids: uuid[] }`
- **Error cases** (all `raise exception` ⇒ PostgREST maps to HTTP 400 → surfaced
  as string by the `.rpc(...).abortSignal()` error path):
  - `privileged only` — caller not admin/super-admin.
  - `catalog ingredient not found` — bad `p_catalog_id`.
  - `brand not accessible` — catalog's brand not visible to caller (cross-brand attempt).

### 4. Edge function changes

**None.** Pure PostgREST/RPC path. No `verify_jwt` decisions, no service-token
validation. (Confirms spec §"Edge functions touched: none".)

### 5. `src/lib/db.ts` surface

New thin wrapper directly below `applyItemVendorsToBrand` (~line 562), same
`useInflight.getState().track((signal) => …)` + `.abortSignal(signal)` discipline:

```ts
export async function applyItemScalarsToBrand(
  catalogId: string,
  scalars: { parLevel?: number | null; costPerUnit?: number | null; casePrice?: number | null },
): Promise<{ updatedCount: number; skippedCount: number; skippedStoreIds: string[] }>
```

Body: `supabase.rpc('apply_item_scalars_to_brand', { p_catalog_id: catalogId,
p_par_level: scalars.parLevel ?? null, p_cost_per_unit: scalars.costPerUnit ??
null, p_case_price: scalars.casePrice ?? null }).abortSignal(signal)`; `if (error)
throw error`; map `data.updated_count/skipped_count/skipped_store_ids` →
`{ updatedCount, skippedCount, skippedStoreIds }` (snake→camel, same three-line
mapper as 119's wrapper). `?? null` is what converts an omitted/undefined key into
the SQL NULL-means-skip param.

### 6. `src/store/useStore.ts` surface

New action `applyScalarsToAllStores`, modeled 1:1 on `applyVendorsToAllStores`
(useStore.ts:1405). Interface entry beside `applyVendorsToAllStores` (line 224):

```ts
applyScalarsToAllStores: (
  catalogId: string,
  scalars: { parLevel?: number | null; costPerUnit?: number | null; casePrice?: number | null },
) => Promise<{ updatedCount: number; skippedCount: number; skippedStoreIds: string[] } | null>;
```

Implementation (same rationale comment as 119): **no naive optimistic write across
the fan-out targets** — other stores' `inventory_items` rows aren't in the current
slice. Fire the RPC; on success `loadFromSupabase(currentStore.id)` so the acting
client converges (other clients get it via realtime); on failure
`notifyBackendError('Apply to all stores', e)` and return `null`. No `AuditAction`
verb (brand-wide, mirrors `applyVendorsToAllStores` — no audit entry).

**Optimistic-then-revert applies to the CURRENT store only, via the existing
`updateItem` call** (see §7 Save path), NOT to the fan-out. The current store's
slice is patched optimistically by `updateItem`; the fan-out RPC has nothing local
to revert. This is the established 119 split — reuse it.

### 7. Frontend store impact — catalog-mode Save path

Two changes in `InventoryCatalogMode.tsx` + `IngredientFormDrawer.tsx`.

**(a) Display fix (AC-1/AC-2) — `InventoryCatalogMode.tsx:752`.** The main
`InventoryCatalogMode` component must bring `currentStore` into scope (spec notes
only `CatalogStoresTab` reads it today) and seed the drawer from the current
store's row:

```
item={sel && (sel.rows.find((r) => r.storeId === currentStore.id) ?? sel.primary)}
```

Fallback = `sel.primary` when the current store has no row for the ingredient
(deterministic, documented per AC-1). This alone closes the Corn-On-Cob display
half of the repro.

**(b) Brand-wide Save flag + fan-out.** The drawer serves BOTH items.tsv
(single-store) and catalog.tsv (brand-wide), so it needs to know which. Add a
prop to `IngredientFormDrawer` (and it is the ONLY signal — no heuristics):

```
brandWide?: boolean   // default false = current items.tsv/per-store behavior
```

`InventoryCatalogMode.tsx` passes `brandWide` on its `mode="edit"` drawer instance
(:749-754). The per-store items.tsv drawer instance elsewhere does NOT pass it (or
passes `false`) — AC-13 regression guard.

In `handleSave` (IngredientFormDrawer.tsx:238), the `mode === 'edit'` branch:

- **Always** call `updateItem(item.id, toUpdates(values))` — this writes the
  CURRENT store's row (incl. `current_stock`, `expiry_date`, `usage_per_portion`
  and the catalog-level name/i18n fields) and drives the current-store optimistic
  patch. Unchanged.
- **Additionally, when `brandWide === true`,** fire the new action to fan the three
  scalars to the OTHER visible brand stores:
  ```
  const summary = await applyScalarsToAllStores(item.catalogId, {
    parLevel: values.parLevel-as-number,
    costPerUnit: values.costPerUnit-as-number,
    casePrice:  values.casePrice-as-number,
  });
  ```
  The RPC also re-writes the current store's three scalars — a harmless idempotent
  double-write of the identical value (updateItem already wrote them). Toast the
  `{ updated, skipped }` summary on success (reuse/extend the 119 i18n keys, e.g.
  `applyScalarsSuccessTitle/Detail`); failure already surfaced by
  `notifyBackendError` inside the action (AC-10). **No confirmAction dialog** —
  OQ-4 says automatic on Save, so unlike 119's button this is silent-on-save
  (the summary toast is the user-visible record).

`current_stock`/count-like fields flow ONLY through `updateItem` → current store
(AC-5/AC-6 hold structurally — they are never passed to `applyScalarsToAllStores`).

**Field parsing note:** `values.parLevel`/`costPerUnit`/`casePrice` are form
strings — parse to number the same way `toUpdates` already does; pass `null` (not
`0`) for a blank field so NULL-means-skip fires rather than zeroing every store.
Blank-string → `null` is the correct mapping; a genuine typed `0` is a real
overwrite. Developer should mirror `toUpdates`'s existing numeric coercion and
convert its "" case to `null` for the fan-out payload.

### 8. Realtime impact

**No publication change, no new table, no `docker restart`.** `inventory_items` is
already in the `supabase_realtime` publication
(`20260514140000_realtime_publication_tighten.sql:44`, filtered `store_id=eq.<id>`).
Each affected store's `inventory_items` UPDATE replays on its own `store-{id}`
channel via `useRealtimeSync` (debounced 400ms) — other admin clients viewing an
affected store see the new par/cost live (AC-12). The publication gotcha does NOT
apply to this function-only migration (confirmed — flag it in the migration header
the same way 119 did, for reviewer reassurance).

### 9. Tests to cover (for test-engineer)

**pgTAP** (`supabase/tests/…apply_item_scalars_to_brand…`):
- par (and cost + case_price) OVERWRITE every visible brand store's row, incl. the
  current store (AC-3/AC-7).
- `current_stock`, `expiry_date`, `usage_per_portion`, `average_daily_usage`,
  `safety_stock` on other stores are UNCHANGED after the call (AC-5/AC-6) — assert
  pre/post equality on a store that had a distinct `current_stock`.
- NULL-means-skip: calling with `p_cost_per_unit => null` leaves cost untouched
  while par still fans out.
- cross-brand isolation: a store in another brand is never written (AC-8).
- per-store `auth_can_see_store` scoping: a store the caller cannot see is neither
  updated nor mis-counted (run as a store-limited admin; assert it's absent from
  updated and — if it lacks a row — present in `skipped_store_ids`).
- only-existing-rows + skipped accounting: a visible brand store with no row is
  counted in `skipped_count`/`skipped_store_ids`, NOT created (AC-9).
- `auth_is_privileged()` gate: non-privileged caller raises `privileged only`.
- overwrite (not preserve) — assert a store that had a DIFFERENT par ends at the
  new value (guards against a developer copy-pasting 119's preserve branch).

**jest** (drawer/store):
- AC-1 binding: opening the catalog.tsv drawer while `currentStore` = Charles seeds
  the form from Charles's row, not `sel.primary` (Frederick). Fallback to
  `sel.primary` when the current store has no row.
- catalog-mode Save (`brandWide`) calls `applyScalarsToAllStores` with the parsed
  par/cost/case_price; items.tsv Save (`brandWide` absent/false) does NOT (AC-13).
- blank field → `null` in the fan-out payload (not `0`).
- store action returns the summary on success, `null` + `notifyBackendError` on
  throw (AC-10).

---

## Files changed (backend)

Migrations:
- `supabase/migrations/20260717000000_apply_item_scalars_to_brand.sql` (new) —
  SECURITY DEFINER `apply_item_scalars_to_brand(uuid, numeric, numeric, numeric)`.
  OVERWRITE semantics (deliberate divergence from spec 119's preserve, flagged in
  header). NULL-means-skip per field via `coalesce`. Single atomic set-based
  UPDATE, per-store `auth_can_see_store()` in the WHERE. `auth_is_privileged()` +
  `auth_can_see_brand()` gates. REVOKE from public/anon, GRANT to authenticated.
  Applied LOCALLY only — **prod-apply pending main Claude** (MCP execute_sql +
  schema_migrations insert per the "Prod migration via Supabase MCP" convention;
  the `db-migrations-applied.yml` gate will be red between repo-commit and
  prod-apply — apply in the same window).

src/lib/db.ts:
- `applyItemScalarsToBrand(catalogId, { parLevel, costPerUnit, casePrice })` thin
  wrapper (~line 563, next to `applyItemVendorsToBrand`). `useInflight.track` +
  `.abortSignal(signal)`; `?? null` maps blank/undefined → SQL NULL (skip, not 0);
  snake→camel mapped return `{ updatedCount, skippedCount, skippedStoreIds }`.

Tests (pgTAP):
- `supabase/tests/apply_item_scalars_to_brand.test.sql` (new, 18 assertions,
  green) — overwrite par/cost/case across visible brand stores incl. current;
  current_stock + count-like fields UNCHANGED (AC-5/AC-6); NULL-means-skip;
  cross-brand denied; non-privileged denied; skipped-store accounting (rows not
  created).

Note: the frontend files (`src/store/useStore.ts`,
`src/screens/cmd/sections/InventoryCatalogMode.tsx`,
`src/components/cmd/IngredientFormDrawer.tsx`, i18n, the jest spec) are owned by
the parallel frontend-developer track and are listed there.

## Files changed (frontend)

- `src/store/useStore.ts` — added `applyScalarsToAllStores(catalogId, { parLevel,
  costPerUnit, casePrice })` action + interface entry. Optimistically patches the
  three CONFIG scalars on ALL in-memory `inventory` rows for the catalog (the
  catalog view holds every store's row), calls `db.applyItemScalarsToBrand`, and
  reverts the patched rows to their snapshot on failure via `notifyBackendError`.
  `current_stock` and count-like fields are never patched.
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` — display fix (AC-1): pulled
  `currentStore` into the main component and seed the edit drawer from
  `sel.rows.find(r => r.storeId === currentStore.id) ?? sel.primary` instead of
  `sel.primary`; pass `brandWide` on the `mode="edit"` drawer so Save fans out.
- `src/components/cmd/IngredientFormDrawer.tsx` — new `brandWide?: boolean` prop.
  On `brandWide` edit Save, still calls `updateItem` for the current store AND
  additionally fires `applyScalarsToAllStores(item.catalogId, { parLevel,
  costPerUnit, casePrice })` (blank → null via `scalarOrNull`, so a cleared field
  skips rather than zeroing every store) with a summary toast. Without `brandWide`
  (items.tsv) behavior is unchanged — single store.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — added
  `applyScalarsSuccessTitle` / `applyScalarsSuccessDetail` keys for the summary
  toast.
- `src/components/cmd/IngredientFormDrawer.spec122.test.tsx` (new) — brandWide Save
  calls updateItem + applyScalarsToAllStores with par/cost/case_price; fan-out
  payload never carries current_stock/count-like fields; items.tsv Save calls
  updateItem only (no fan-out); blank par → null.
- `src/screens/cmd/sections/__tests__/InventoryCatalogMode.spec122.test.tsx` (new)
  — AC-1: edit drawer seeds from the current store's row, falls back to primary
  when the current store has no row; asserts `brandWide` is passed.
- `src/store/useStore.test.ts` — added `applyScalarsToAllStores` coverage
  (optimistic overwrite of par/cost/case_price leaving current_stock untouched +
  returns summary; revert + notifyBackendError + null on RPC failure) and
  `applyItemScalarsToBrand` to the db mock.

Verification: `npx tsc --noEmit` clean; full `npx jest` green (106 suites / 1207
tests). Browser preview tools are not available in this environment, so the golden
path was not exercised in-browser; wiring is covered by the jest suites above.
