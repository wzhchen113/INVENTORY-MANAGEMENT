# Spec 119: Apply vendor change to all stores

Status: READY_FOR_REVIEW

## Context / motivating incident

The owner reassigned the "Honey Blend" ingredient's vendor from WEBSTAURANT to
GOLDEN CITY. The change applied to ONE store only (Frederick); the other three
brand stores (Charles / Towson / Reisters) silently kept WEBSTAURANT, so the
item showed the old vendor on their EOD count and reorder screens. The owner
expected the reassignment to be brand-wide.

This is not a bug in the current per-store write path. Vendor assignment is
intentionally per-store: each `inventory_items` row carries its own
`item_vendors` links (spec 102 multi-vendor: `vendor_id`, `cost_per_unit`,
`case_price`, `is_primary`, plus `order_code` from spec 114) and a legacy
scalar `inventory_items.vendor_id` mirrored to the primary. The admin Cmd
Inventory list is filtered to `currentStore.id`, and editing an ingredient's
vendors writes only to the current store's item via
`db.updateInventoryItem(id, { vendors: [...], vendorId })`
([src/lib/db.ts:388](../src/lib/db.ts)). That is correct and store-scoped.

The gap: there is no affordance to PROPAGATE a vendor change to the same
catalog ingredient's items in the OTHER brand stores. The Honey Blend data has
already been hand-fixed across all four stores; this feature prevents
recurrence.

## User story

As a brand admin editing an ingredient in the Cmd Inventory editor, I want an
explicit "Apply vendors to all stores" action, so that the current store's
vendor set propagates to that ingredient's items across all of the brand's
stores when I deliberately choose to — while a normal Save still only touches
the store I'm viewing, so intentional per-store vendor differences are
preserved.

## Acceptance criteria

- [ ] The ingredient editor (`IngredientForm` / `IngredientFormDrawer`) shows a
      SEPARATE, explicit "Apply vendors to all stores" action in the VENDORS
      section, distinct from `Save`. Brand-wide propagation is ALWAYS a
      deliberate button press and NEVER a side effect of a normal Save.
- [ ] A normal `Save` continues to call the existing per-store path
      (`db.updateInventoryItem` for the current store's item) with no change in
      behavior. The new action does not alter what `Save` does.
- [ ] The "Apply vendors to all stores" action propagates the submitted vendor
      set — the full `item_vendors` link set: attached vendors (attach/detach),
      which one is primary, and each link's `order_code` — from the current
      store's item to the SAME catalog ingredient's `inventory_items` row in
      EVERY store of the CURRENT brand that the caller can see via
      `auth_can_see_store()`, including the current store.
- [ ] Propagation is scoped to the current brand only; stores in other brands
      are never touched (never cross-brand), and RLS / `auth_can_see_store()` is
      respected — a store the caller cannot see is not modified.
- [ ] After the action runs, each target store's item has exactly the submitted
      vendor SET: de-selected vendors' links are removed and newly attached
      vendors' links are created on that store.
- [ ] Per-store pricing is PRESERVED (non-destructive): for a vendor link that
      ALREADY exists on a target store, that store's own `cost_per_unit` /
      `case_price` are left unchanged — only WHICH vendors are linked (and which
      is primary) changes. For a NEW link (a vendor a target store did not have),
      the link is seeded from the current store's `cost_per_unit` / `case_price`
      for that vendor.
- [ ] Order codes propagate: the current store's per-vendor `order_code` (spec
      114) is written to every target store's corresponding link, for both
      preserved and newly-seeded links.
- [ ] `is_primary` and the legacy scalar `inventory_items.vendor_id` stay
      mirrored on EVERY target store to the submitted primary (SD-1 mirror
      preserved on each store, not just the current one).
- [ ] v1 targets ONLY stores where the catalog ingredient ALREADY has an
      `inventory_items` row. Stores missing the row are NOT created; they are
      counted and reported as skipped.
- [ ] The action reports the outcome to the user: how many stores were updated
      AND how many were skipped (no `inventory_items` row for this ingredient).
      Any partial failure surfaces via `notifyBackendError` (optimistic-then-
      revert + toast) rather than silently succeeding.
- [ ] Other admin clients viewing an affected store see the change without a
      manual reload (realtime), because each affected `item_vendors` row change
      lands on the `store-{id}` channel already wired in `useRealtimeSync`.

## In scope

- Admin Cmd UI only: an explicit "Apply vendors to all stores" action in the
  ingredient editor's VENDORS section and its propagation path.
- A brand-wide propagation path (backend shape TBD by architect — see Q6) that
  applies the current store's submitted vendor link set to the catalog
  ingredient's `inventory_items` across the brand's visible stores.
- Preserving the multi-vendor (spec 102) and order-code (spec 114) contracts:
  `is_primary` mirror, scalar `vendor_id` mirror, per-store price preservation,
  per-link `order_code`.
- A user-visible summary of how many stores were updated / skipped.

## Out of scope (explicitly)

- Changing the DEFAULT save behavior. `Save` remains per-store; brand-wide
  propagation is strictly an explicit separate action — some ingredients
  legitimately have different vendors per store. (Rationale: the incident was a
  missed propagation, not a wrong default; making brand-wide a Save side effect
  would break intentional per-store sourcing.)
- Overwriting other stores' negotiated per-vendor prices. Existing links keep
  their own price; only new links are seeded from the current store.
- Creating `inventory_items` rows in stores that don't have the ingredient yet
  (v1 targets only-existing rows and reports the rest as skipped).
- Propagating any NON-vendor field (name, category, unit, par, cost basis,
  expiry, i18n names). This feature touches the vendor link set only.
- Staff app. Staff do not edit vendors.
- The customer PWA.
- A bulk / multi-ingredient "apply to all stores" batch tool. This is per-single
  ingredient at edit time.
- Retroactive reconciliation of already-drifted ingredients across the catalog.
  (Honey Blend was hand-fixed; a catalog-wide audit is a separate spec if
  wanted.)

## Open questions resolved

- Q: What propagates — full vendor set or primary only? → A: FULL vendor set —
  all attached vendors + which is primary + their order codes.
- Q: Per-store pricing on apply-to-all — overwrite or preserve? → A: PRESERVE
  each store's existing `cost_per_unit` / `case_price`; only change which vendor
  is linked (and primary). For a NEW link a store did not have, seed its price
  from the current store's value. Non-destructive.
- Q: Order codes (spec 114) — propagate or per-store? → A: PROPAGATE the current
  store's per-vendor order code to all stores.
- Q: UI shape — inline toggle on Save, or separate action? → A: SEPARATE explicit
  "Apply vendors to all stores" action, distinct from Save. Brand-wide
  propagation is always a deliberate button press, never a Save side effect.
- Q: Missing items — only-existing or also create the row? → A: v1 ONLY-EXISTING;
  target only stores that already have the ingredient's `inventory_items` row,
  report skipped stores, do not auto-create.

## Dependencies

- Multi-vendor contract — spec 102 (`item_vendors`, `is_primary`, scalar
  `vendor_id` mirror). Propagation must uphold the SD-1 primary mirror on each
  target store.
- Order-code contract — spec 114 (`item_vendors.order_code`).
- Per-each cost basis — spec 104 (`cost_per_unit` is per-EACH, derived from
  `case_price / (case_qty × sub_unit_size)`). Relevant to the seed-new-link
  pricing path.
- Per-store RLS hardening — `auth_can_see_store()`
  ([supabase/migrations/20260504173035_per_store_rls_hardening.sql](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)).
  Propagation must respect it and never write a store the caller cannot see.
- Existing per-store write path:
  `db.updateInventoryItem` ([src/lib/db.ts:388](../src/lib/db.ts)),
  editor `src/components/cmd/IngredientForm.tsx` +
  `src/components/cmd/IngredientFormDrawer.tsx`.
- Realtime — `store-{id}` channel via
  [src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts).

## Open question for the architect (backend shape)

- Q6 — Implement the fan-out as a single Postgres RPC (a `SECURITY DEFINER`
  function that reconciles `item_vendors` across the brand's visible items for a
  catalog id, echoing the per-store reconcile logic in `updateInventoryItem`,
  with the preserve-existing-price / seed-new-link / propagate-order-code /
  mirror-primary rules enforced server-side) OR a `db.ts` client-side loop over
  the brand's items reusing the existing reconcile? An RPC keeps the write atomic
  and RLS-consistent in one round-trip; a client loop reuses existing code but is
  N round-trips and not atomic. The architect makes this call.

## Project-specific notes

- Cmd UI section / legacy: Cmd Inventory editor
  (`src/components/cmd/IngredientForm.tsx` / `IngredientFormDrawer.tsx`,
  reached from `src/screens/cmd/InventoryDesktopLayout.tsx`). No legacy surface.
- Per-store or admin-global: brand-scoped. The feature deliberately fans a
  per-store write out across all stores of the CURRENT brand (never
  cross-brand), gated by `auth_can_see_store()`.
- Realtime channels touched: `store-{id}` for each affected store. RISK — the
  realtime publication gotcha: if `item_vendors` (or the affected tables) is not
  in the realtime publication, other clients won't see the fan-out live; a
  mid-session publication change needs
  `docker restart supabase_realtime_imr-inventory` to re-snapshot the slot.
  Architect to confirm the affected tables are published.
- Migrations needed: likely YES if the propagation is implemented as a Postgres
  RPC (see Q6 for the architect). Flagged: RPC vs. a `db.ts` client-side loop.
- Edge functions touched: none expected (PostgREST/RPC path, JWT-protected).
- Web/native scope: same as the rest of the Cmd admin UI — no web-only APIs
  involved; no `app.json` / build-identifier changes.
- Tests: pgTAP for the propagation logic (correct fan-out across the brand's
  visible stores, RLS scoping / no cross-brand write, `is_primary` + scalar
  mirror on each store, preserve-existing-price / seed-new-link, propagate-
  order-code, only-existing-rows + skipped count) if implemented as an RPC; jest
  for the editor's action wiring and any pure mapping helper. No shell smoke
  expected.

---

## Backend design

### Q6 decision — single SECURITY DEFINER RPC (not a db.ts client loop)

**Recommend the RPC.** Rationale, weighed against the alternative:

- **RLS correctness in one place.** A `db.ts` client loop would have to (a) fetch
  the brand's `inventory_items` for the catalog, (b) loop upsert/delete per store.
  Every one of those reads/writes runs under the caller's RLS, which is *correct*
  for scoping but means the loop is at the mercy of whatever the caller can see
  AND cannot express "skip the store I can't see, and COUNT it as skipped" — the
  loop simply wouldn't see the row to count it. The RPC, `SECURITY DEFINER`,
  can enumerate the brand's full store set and apply `auth_can_see_store()`
  *explicitly* per store, so the skipped-count is authoritative.
- **Atomicity.** The fan-out is all-or-nothing inside one transaction. A client
  loop that fails on store 3 of 4 leaves a partial write with no rollback — the
  optimistic-then-revert pattern can only revert the *current* store's slice (the
  admin store holds only `currentStore.id`'s inventory), so a partial client-loop
  failure is silently unrecoverable on the other stores. The RPC either commits
  every target or none.
- **Round-trips.** One RPC call vs. N per-store round-trips (4 stores today, but
  the brand can grow). Cold path, but the atomicity + RLS points dominate.
- **Convention.** This mirrors the existing privileged brand-scoped write RPCs
  (`copy_brand_catalog`, `create_inventory_item_with_catalog`) rather than
  inventing a new pattern. `db.ts` stays the single client entry point via a thin
  wrapper (below), so the centralization convention is upheld — the RPC is the
  server-side implementation, `db.ts` still owns the client surface.

The **existing per-store reconcile logic in `updateInventoryItem`**
([src/lib/db.ts:474-518](../src/lib/db.ts)) is the behavioral reference the RPC
echoes server-side (upsert submitted links, delete de-selected, mirror
`is_primary` + scalar `vendor_id`). The RPC does NOT replace or call that path —
Save stays exactly as-is (AC-2, see "Preserved path" below).

### Data model changes

**No schema/column/index change.** This is a pure additive **function** migration.
`item_vendors` (spec 102, [supabase/migrations/20260630000000_item_vendors.sql](../supabase/migrations/20260630000000_item_vendors.sql))
already carries every column the fan-out touches: `item_id`, `vendor_id`,
`cost_per_unit`, `case_price`, `is_primary`, `order_code` (spec 114), plus the
`item_vendors_item_vendor_unique (item_id, vendor_id)` on-conflict target and the
`item_vendors_one_primary_per_item` partial-unique index. The legacy scalar
`inventory_items.vendor_id` is unchanged.

- **Proposed migration filename:**
  `supabase/migrations/20260713000000_apply_item_vendors_to_brand.sql`
- **Destructive vs additive:** additive (new function only). Reversible-by-design:
  `drop function public.apply_item_vendors_to_brand(uuid, jsonb, uuid);` returns
  the system to exactly today's behavior.
- **Rollout safety:** the function is inert until the frontend button calls it;
  Save is untouched, so shipping the migration ahead of the UI is safe.
- **Prod apply:** per the project's "Prod migration via Supabase MCP" convention
  (MEMORY.md) — `db push` lacks the prod password. Apply the function body via
  MCP `execute_sql` on project `ebwnovzzkwhsdxkpyjka`, insert the exact version
  string into `supabase_migrations.schema_migrations`, and verify with the
  normalized-md5 check. The `db-migrations-applied.yml` gate will hard-fail on
  `main` until this is done (repo-has / prod-missing drift) — apply to prod in the
  same push window.

### RPC — signature & contract

```sql
create or replace function public.apply_item_vendors_to_brand(
  p_catalog_id        uuid,
  p_vendors           jsonb,   -- array of {vendor_id, cost_per_unit, case_price, order_code}
  p_primary_vendor_id uuid     -- nullable; which submitted vendor is primary (SD-1)
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$ ... $$;

revoke execute on function public.apply_item_vendors_to_brand(uuid, jsonb, uuid) from public, anon;
grant  execute on function public.apply_item_vendors_to_brand(uuid, jsonb, uuid) to authenticated;
```

- **SECURITY / search_path:** `SECURITY DEFINER`, `set search_path = public` —
  byte-aligned with `copy_brand_catalog` ([supabase/migrations/20260517030000_copy_brand_catalog.sql:22-23](../supabase/migrations/20260517030000_copy_brand_catalog.sql)).
  The RPC calls only `public.*` helpers (which set their own `public, auth`
  search_path internally), so `public` alone is sufficient.
- **Auth gate (privileged + brand-scoped), mirrors the existing write RPCs:**
  1. `if not public.auth_is_privileged() then raise exception 'privileged only'; end if;`
     (admin OR super_admin — mirrors `copy_brand_catalog`; the Cmd editor is an
     admin-only surface, and privileged is the correct floor for a brand-wide
     fan-out).
  2. Resolve `v_brand_id := (select brand_id from catalog_ingredients where id = p_catalog_id);`
     — `if v_brand_id is null then raise exception 'catalog ingredient not found'; end if;`
  3. `if not public.auth_can_see_brand(v_brand_id) then raise exception 'brand not accessible'; end if;`
     — the never-cross-brand guarantee (AC-4).
  4. Per-store visibility is enforced INSIDE the loop, not just at brand level:
     the target-item set is filtered on `public.auth_can_see_store(ii.store_id)`
     so a store the caller cannot see is neither read nor written (AC-4), even
     though a brand-admin sees all their own-brand stores today (belt-and-
     suspenders + correct skipped semantics).

**Reconcile body (per target `inventory_items` row for the catalog, all in one txn):**

- Target set: `inventory_items ii where ii.catalog_id = p_catalog_id and
  public.auth_can_see_store(ii.store_id)`. (Store scoping is transitive; the
  catalog's `brand_id` already pins the brand, and `auth_can_see_brand` gated
  above, so this cannot reach another brand.)
- **Upsert each submitted vendor** into `item_vendors` with
  `on conflict (item_id, vendor_id) do update` — this single statement encodes
  BOTH the preserve-existing-price and seed-new-link rules:
  - INSERT branch (NEW link): `cost_per_unit`, `case_price` come from the
    submitted (current-store) values → **seed-new-link** (AC-6, spec 104 per-each
    basis carried verbatim — the RPC does no cost math, it copies the value).
  - `DO UPDATE` branch (EXISTING link): set `order_code = excluded.order_code`,
    `is_primary = excluded.is_primary`, `updated_at = now()` — and **do NOT touch
    `cost_per_unit` / `case_price`** → **preserve-existing-price** (AC-6). Order
    code overwrites on both branches → **propagate-order-code** (AC-7).
  - `is_primary = (vendor_id = p_primary_vendor_id)` on every row → SD-1 mirror.
- **Delete de-selected links:** `delete from item_vendors where item_id = ii.id
  and vendor_id <> all(submitted_ids)`; with an empty submitted set, delete ALL
  links for the item (AC-5, empty-set semantics identical to `updateInventoryItem`).
- **Mirror the legacy scalar:** `update inventory_items set vendor_id =
  p_primary_vendor_id, updated_at = now() where id = ii.id` on every target store
  → SD-1 scalar mirror on each store, not just current (AC-8).
- **Primary-index ordering caveat (developer must verify with pgTAP):** the
  `item_vendors_one_primary_per_item` partial-unique index means the multi-row
  upsert must not transiently leave two `is_primary=true` rows. Mirror the proven
  order in `updateInventoryItem` (upsert-then-delete); if a re-point of primary
  trips the index, unset the old primary first (`update … set is_primary=false
  where item_id = ii.id`) before the upsert. Cover the re-point case explicitly.

**Params:**
- `p_catalog_id` — the current item's `catalogId`.
- `p_vendors` — JSONB array; each element `{vendor_id, cost_per_unit, case_price,
  order_code}`. `order_code` empty/absent → SQL NULL (same null-coalesce as the
  create/update paths, spec 114 AC-3). An empty array `[]` means "remove all
  links from every target store."
- `p_primary_vendor_id` — the form's primary pick, falling back to the current
  item's scalar `vendor_id` (resolved client-side, mirroring the
  `updateInventoryItem` primaryVendorId fallback at [src/lib/db.ts:484-493](../src/lib/db.ts)).
  May be NULL (no primary / all links non-primary, scalar set NULL).

**Return shape:** `jsonb`
```json
{ "updated_count": 4, "skipped_count": 1, "skipped_store_ids": ["<uuid>"] }
```
- `updated_count` — count of `inventory_items` rows reconciled (visible brand
  stores that HAVE a row for this catalog, incl. the current store — AC-3).
- `skipped_count` / `skipped_store_ids` — visible brand stores (`stores s where
  s.brand_id = v_brand_id and public.auth_can_see_store(s.id)`) that have NO
  `inventory_items` row for this catalog. v1 does NOT create the row (AC-9,
  out-of-scope). This is the authoritative skipped set the client-loop
  alternative could not produce.

**Error cases** (all `raise exception` → SQLSTATE P0001 → PostgREST HTTP 400,
surfaced as a string by the `supabase.rpc` error path, thrown in `db.ts`, caught
by the store action → `notifyBackendError`):
- `'privileged only'` — non-privileged caller.
- `'catalog ingredient not found'` — bad/foreign `p_catalog_id`.
- `'brand not accessible'` — caller cannot see the catalog's brand (cross-brand
  attempt).

### RLS impact

**No new table, no policy change.** The RPC is `SECURITY DEFINER` so it does not
rely on the `item_vendors` RLS policies at runtime; instead it re-implements the
same scoping *explicitly* via `auth_is_privileged()` + `auth_can_see_brand()` +
`auth_can_see_store()`. The four existing `store_member_*_item_vendors` policies
([20260630000000_item_vendors.sql:121-142](../supabase/migrations/20260630000000_item_vendors.sql))
continue to govern the ordinary per-store Save path (`updateInventoryItem`) and
all direct PostgREST reads. The spec-053 permissive-policy lint is unaffected (no
new policy).

### API contract — RPC vs PostgREST

**RPC.** A brand-wide multi-store reconcile with an authoritative skipped-count is
not expressible as a PostgREST table/view write. Consistent with the existing
privileged write RPCs.

### Edge function changes

**None.** Pure PostgREST/RPC path, JWT-protected by default (no `config.toml`
entry needed — `verify_jwt` defaults on). No `staff-*` / service-token surface.

### `src/lib/db.ts` surface

New thin wrapper (JWT-protected `supabase.rpc`, wrapped in the existing
`useInflight.track({ kind: 'write' })` envelope like the other write helpers;
throws the PostgREST error so the store action's `.catch` fires):

```ts
export async function applyItemVendorsToBrand(
  catalogId: string,
  vendors: Array<{ vendorId: string; costPerUnit?: number; casePrice?: number; orderCode?: string }>,
  primaryVendorId: string | null,
): Promise<{ updatedCount: number; skippedCount: number; skippedStoreIds: string[] }>;
```

- Maps the camelCase `vendors[]` → the RPC's snake_case JSONB
  (`{ vendor_id, cost_per_unit, case_price, order_code }`), reusing the same
  shape the update path already builds.
- Maps the snake_case return (`updated_count`, `skipped_count`,
  `skipped_store_ids`) → camelCase (`updatedCount`, `skippedCount`,
  `skippedStoreIds`) via a local `mapItem`-style inline map.
- `order_code` null-coalesce (`v.orderCode || null`) identical to the
  create/update helpers.

### Realtime impact

- **Channel:** each affected store's `item_vendors` change replays on that store's
  `store-{id}` channel — already wired: `item_vendors` was added to the
  `supabase_realtime` publication in spec 102
  ([20260630000000_item_vendors.sql:172](../supabase/migrations/20260630000000_item_vendors.sql))
  and `useRealtimeSync` subscribes to it. **Other** admin clients viewing an
  affected store therefore see the fan-out live (AC-13) with no manual reload.
- **Publication gotcha — DOES NOT APPLY here.** This migration adds a FUNCTION
  only; it does NOT change `supabase_realtime` publication membership. The
  `docker restart supabase_realtime_imr-inventory` ritual is **not** needed for
  this spec. (State it explicitly in the migration header, matching the sibling
  RPC migrations.)
- **Acting-client note (not a bug):** the admin store holds only
  `currentStore.id`'s inventory, and this client subscribes only to its current
  `store-{id}` + `brand-{id}` channels. The OTHER stores' fan-out writes do not
  live-reflect in the ACTING client's UI — nor should they; those items aren't in
  its local state. The acting client reflects the current store optimistically
  (below) + the returned summary counts. AC-13 is about *other* clients, which is
  satisfied by the publication membership.

### Frontend store impact

- **Slice:** `src/store/useStore.ts` inventory slice — a NEW action alongside
  `updateItem` (~[useStore.ts:1314](../src/store/useStore.ts)), e.g.
  `applyVendorsToAllStores(catalogId, vendors, primaryVendorId)`.
- **Optimistic-then-revert applies, scoped to the current store only.** Apply the
  same optimistic vendor-link patch `updateItem` builds
  ([useStore.ts:1324-1345](../src/store/useStore.ts)) to the *current* store's
  item (the only affected item in local state), call
  `db.applyItemVendorsToBrand(...)`; on error revert that item's slice and call
  `notifyBackendError('Apply vendors to all stores', e)` (AC-11 — no silent
  success). On success, surface the returned `{ updatedCount, skippedCount }` to
  the editor for the user-visible summary (AC-10). The other stores' items
  converge via their own realtime; the acting client does not hold them.
- **Editor:** `src/components/cmd/IngredientForm.tsx` /
  `IngredientFormDrawer.tsx` VENDORS section gains a SEPARATE, explicit "Apply
  vendors to all stores" button distinct from Save (AC-1). It builds the same
  `vendors[]` payload the Save path submits + the primary pick, calls the new
  store action, awaits it, and renders the summary (updated / skipped). This is
  frontend-developer work.

### Preserved path (AC-2)

`Save` is UNCHANGED: it continues to call `db.updateInventoryItem(id, { vendors,
vendorId, ... })` for the current store's item only. The new RPC, `db.ts`
wrapper, and store action are strictly ADDITIVE. Brand-wide propagation is only
ever the explicit button press — never a Save side effect.

### Risks & tradeoffs

- **Primary partial-unique-index ordering** (above): the one real correctness
  trap. Mirror `updateInventoryItem`'s proven order and cover the primary-repoint
  case in pgTAP.
- **Migration ordering / prod drift:** the `db-migrations-applied.yml` gate goes
  red between repo-commit and prod-MCP-apply. Apply to prod in the same window;
  don't merge and walk away (the 2026-06-28 red-gate incident in CLAUDE.md).
- **RLS gap — none identified:** the SECURITY DEFINER body re-asserts privileged +
  brand + per-store visibility explicitly. The one thing to NOT regress: keep the
  per-store `auth_can_see_store()` filter inside the target/skipped queries, or a
  privileged caller could theoretically be handed a `p_catalog_id` whose brand
  they can see but with a store row they can't — the filter is the guard.
- **Performance on the 286 KB seed dataset:** trivial — the target set is bounded
  by the brand's store count (single digits) × 1 catalog. Indexed on
  `item_vendors_item_id_idx` and the `(store_id, catalog_id)` unique on
  `inventory_items`. No table scan concern.
- **Cold-start:** N/A (no edge function).
- **Semantic subtlety to document in the RPC comment:** because Apply preserves
  existing per-store prices (AC-6), pressing Apply does NOT push the *current
  store's* freshly-typed price to already-linked vendors — Apply changes the
  vendor SET / primary / order codes, not prices. To change a price the admin
  uses Save. This is intended (non-destructive), but is a likely support
  question; make it explicit in the RPC comment and the button's helper text.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend design in
  specs/119-apply-vendor-change-to-all-stores.md. Backend: author migration
  supabase/migrations/20260713000000_apply_item_vendors_to_brand.sql (SECURITY
  DEFINER RPC apply_item_vendors_to_brand(uuid, jsonb, uuid) with the privileged
  + brand + per-store auth gate, upsert-preserve-existing / seed-new /
  propagate-order-code / mirror-primary+scalar reconcile, and the
  {updated_count, skipped_count, skipped_store_ids} return), the db.ts
  applyItemVendorsToBrand wrapper, and pgTAP covering fan-out, no-cross-brand,
  per-store RLS scoping, preserve-vs-seed pricing, order-code propagation,
  primary+scalar mirror per store, and the skipped-count. Prod-apply via the MCP
  process; item_vendors is already in the realtime publication so NO docker
  restart. Frontend: add the separate "Apply vendors to all stores" button in the
  IngredientForm/IngredientFormDrawer VENDORS section + the
  applyVendorsToAllStores store action (optimistic-then-revert scoped to the
  current store, notifyBackendError on failure, updated/skipped summary on
  success). Do NOT change the Save path. After implementation set
  Status: READY_FOR_REVIEW and list files under ## Files changed.
payload_paths:
  - specs/119-apply-vendor-change-to-all-stores.md

---

## Files changed (frontend — spec 119)

Frontend implementation of the SEPARATE "Apply vendors to all stores" action
(distinct from Save), the store action, and i18n. Backend (migration + RPC +
pgTAP) is a parallel track.

- `src/store/useStore.ts` — new `applyVendorsToAllStores(catalogId, vendors,
  primaryVendorId)` action (interface decl + implementation). No naive
  optimistic write across stores; fires `db.applyItemVendorsToBrand`, reloads
  the current store on success, `notifyBackendError` on failure, resolves to the
  RPC summary (or `null`).
- `src/components/cmd/IngredientForm.tsx` — new `onApplyToAllStores` /
  `applyingToAllStores` props and the SEPARATE "Apply vendors to all stores"
  button + helper text in the VENDORS section (rendered EDIT-mode only, i.e. when
  the host passes the callback).
- `src/components/cmd/IngredientFormDrawer.tsx` — `handleApplyVendorsToAllStores`
  (confirmAction gate → store action → updated/skipped summary toast), in-flight
  guard state, and wiring the props through both compact + desktop body renders.
  Save path unchanged.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — added
  `section.inventory.applyVendors*` keys (button label, help, confirm
  title/body/cta, success title + `{updated}`/`{skipped}` detail). Parity green.

Shared with the backend track:
- `src/lib/db.ts` — `applyItemVendorsToBrand` thin RPC wrapper. Authored by the
  backend track (landed in the shared tree during this parallel build); the
  frontend store action consumes it verbatim. (A momentary duplicate copy the
  frontend added for local typecheck was removed once the backend copy was
  detected — single definition remains.)

### Verification
- `npx tsc --noEmit` — clean.
- `npx jest` — 102 suites / 1184 tests pass (incl. `i18n.test` parity).
- Browser golden-path click NOT exercised live: the preview harness tools were
  unavailable in this session AND the `apply_item_vendors_to_brand` RPC is not
  applied to the local Supabase stack (parallel backend track), so a live click
  would fail at the RPC regardless. Button render / action / i18n wiring is
  verified via the type system + jest; a reviewer with the migration applied
  locally should exercise the live fan-out.
