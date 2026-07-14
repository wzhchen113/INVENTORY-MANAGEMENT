-- ============================================================
-- Spec 119 — Apply vendor change to all stores.
--
-- A brand admin editing an ingredient in the Cmd Inventory editor can
-- explicitly PROPAGATE the current store's vendor link set to the SAME
-- catalog ingredient's inventory_items across EVERY store of the current
-- brand the caller can see. A normal Save still only touches the current
-- store (db.updateInventoryItem) — this RPC is a SEPARATE, additive path
-- invoked only by the explicit "Apply vendors to all stores" button.
--
-- This is a SECURITY DEFINER fan-out that echoes the per-store reconcile
-- in db.ts updateInventoryItem (src/lib/db.ts:474-518) server-side, in ONE
-- atomic transaction, with authoritative skipped-store accounting the
-- client-loop alternative could not produce (it can only see rows RLS lets
-- it read; it cannot COUNT a store whose row it cannot see).
--
-- ADDITIVE, NON-DESTRUCTIVE, reversible-by-design:
--   drop function public.apply_item_vendors_to_brand(uuid, jsonb, uuid);
-- returns the system to exactly today's behavior. Save is untouched, so
-- shipping this migration ahead of the UI button is inert and safe.
--
-- NON-DESTRUCTIVE PRICING (spec 119 AC-6): for a vendor link that ALREADY
-- exists on a target store, that store's own cost_per_unit / case_price are
-- left UNCHANGED — only WHICH vendors are linked, which is primary, and the
-- per-link order_code (spec 114) change. For a NEW link (a vendor the target
-- store did not have), the link is SEEDED from the submitted (current-store)
-- cost_per_unit / case_price. The RPC does NO cost math — it copies the
-- submitted per-each value verbatim (spec 104 basis carried through). This
-- means pressing "Apply" does NOT push a freshly-typed price to already-
-- linked vendors; use Save for a price change. Intended, per AC-6.
--
-- REALTIME PUBLICATION GOTCHA — DOES NOT APPLY. This migration adds a
-- FUNCTION only; it does NOT change supabase_realtime publication
-- membership. item_vendors was already added to the publication in spec 102
-- (20260630000000_item_vendors.sql:172). The
-- `docker restart supabase_realtime_imr-inventory` ritual is NOT needed for
-- this spec — each affected store's item_vendors change already replays on
-- its store-{id} channel for OTHER admin clients (useRealtimeSync.ts).
--
-- Prod apply: per the "Prod migration via Supabase MCP" convention
-- (MEMORY.md) — db push lacks the prod password. Main Claude applies the
-- function body via MCP execute_sql on project ebwnovzzkwhsdxkpyjka, inserts
-- the exact version string into supabase_migrations.schema_migrations, and
-- verifies with the normalized-md5 check. The db-migrations-applied.yml gate
-- hard-fails on main between repo-commit and prod-apply — apply in the same
-- window.
-- ============================================================

-- apply_item_vendors_to_brand(catalog, vendors, primary) — reconcile the
-- item_vendors link set for a catalog ingredient across the brand's
-- caller-visible inventory_items rows.
--
--   p_catalog_id        — the current item's catalog_id.
--   p_vendors           — jsonb array of {vendor_id, cost_per_unit,
--                         case_price, order_code}. order_code empty/absent →
--                         SQL NULL (spec 114 null-coalesce). An empty array
--                         [] means "remove ALL links from every target store".
--   p_primary_vendor_id — which submitted vendor is primary (SD-1 mirror).
--                         Nullable → no primary; scalar vendor_id set NULL.
--
-- Returns jsonb:
--   { updated_count, skipped_count, skipped_store_ids }
--   updated_count     — inventory_items rows reconciled (visible brand
--                       stores WITH a row for this catalog, incl. current).
--   skipped_count /   — visible brand stores with NO inventory_items row for
--   skipped_store_ids   this catalog. v1 does NOT create the row (AC-9).
create or replace function public.apply_item_vendors_to_brand(
  p_catalog_id        uuid,
  p_vendors           jsonb,
  p_primary_vendor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand_id     uuid;
  v_updated      int := 0;
  v_skipped_ids  uuid[] := '{}';
  v_submitted    uuid[];
  v_item         record;
begin
  -- Auth gate (privileged + brand-scoped), mirrors copy_brand_catalog.
  if not public.auth_is_privileged() then
    raise exception 'privileged only';
  end if;

  select brand_id into v_brand_id
    from public.catalog_ingredients
   where id = p_catalog_id;
  if v_brand_id is null then
    raise exception 'catalog ingredient not found';
  end if;

  -- Never cross-brand (AC-4).
  if not public.auth_can_see_brand(v_brand_id) then
    raise exception 'brand not accessible';
  end if;

  -- The submitted vendor id set. Empty array → empty set → "remove all
  -- links" for every target item (AC-5 empty-set semantics).
  select coalesce(array_agg((elem->>'vendor_id')::uuid), '{}')
    into v_submitted
    from jsonb_array_elements(coalesce(p_vendors, '[]'::jsonb)) elem;

  -- Target set: every inventory_items row for this catalog in a store the
  -- caller can SEE. auth_can_see_store() is enforced per-store INSIDE the
  -- loop (belt-and-suspenders on top of the brand gate) so a store the
  -- caller cannot see is neither read nor written (AC-4).
  for v_item in
    select ii.id, ii.store_id
      from public.inventory_items ii
     where ii.catalog_id = p_catalog_id
       and public.auth_can_see_store(ii.store_id)
  loop
    -- Primary partial-unique-index (item_vendors_one_primary_per_item)
    -- safety: unset any EXISTING primary that is not the new one BEFORE the
    -- upsert, so the multi-row upsert never transiently leaves two
    -- is_primary=true rows. Mirrors updateInventoryItem's proven ordering.
    update public.item_vendors
       set is_primary = false, updated_at = now()
     where item_id = v_item.id
       and is_primary
       and (p_primary_vendor_id is null or vendor_id <> p_primary_vendor_id);

    -- Upsert each submitted link. This single statement encodes BOTH rules:
    --   INSERT branch (NEW link)  → cost/case_price SEEDED from submitted
    --                               values (AC-6 seed-new-link).
    --   DO UPDATE branch (EXISTS) → order_code + is_primary + updated_at
    --                               only; cost_per_unit / case_price are
    --                               DELIBERATELY untouched (AC-6 preserve).
    -- order_code overwrites on both branches (AC-7 propagate-order-code).
    -- is_primary = (vendor is the submitted primary) → SD-1 mirror; coalesce
    -- to false so a NULL primary yields a valid boolean (NOT NULL column).
    insert into public.item_vendors
      (item_id, vendor_id, cost_per_unit, case_price, is_primary, order_code)
    select
      v_item.id,
      (elem->>'vendor_id')::uuid,
      coalesce((elem->>'cost_per_unit')::numeric, 0),
      coalesce((elem->>'case_price')::numeric, 0),
      coalesce(((elem->>'vendor_id')::uuid = p_primary_vendor_id), false),
      nullif(elem->>'order_code', '')
    from jsonb_array_elements(coalesce(p_vendors, '[]'::jsonb)) elem
    on conflict (item_id, vendor_id) do update
      set order_code = excluded.order_code,
          is_primary = excluded.is_primary,
          updated_at = now();

    -- Remove de-selected links (vendors not in the submitted set). With an
    -- empty submitted set, `= any('{}')` is false for every row so NOT ...
    -- is true → ALL links for the item are deleted (AC-5).
    delete from public.item_vendors
     where item_id = v_item.id
       and not (vendor_id = any(v_submitted));

    -- Mirror the legacy scalar on EVERY target store (AC-8, SD-1 scalar).
    update public.inventory_items
       set vendor_id = p_primary_vendor_id, updated_at = now()
     where id = v_item.id;

    v_updated := v_updated + 1;
  end loop;

  -- Authoritative skipped set: visible brand stores with NO inventory_items
  -- row for this catalog. v1 does NOT create the row (AC-9, out of scope).
  select coalesce(array_agg(s.id), '{}')
    into v_skipped_ids
    from public.stores s
   where s.brand_id = v_brand_id
     and public.auth_can_see_store(s.id)
     and not exists (
       select 1 from public.inventory_items ii
        where ii.catalog_id = p_catalog_id
          and ii.store_id = s.id
     );

  return jsonb_build_object(
    'updated_count',     v_updated,
    'skipped_count',     coalesce(array_length(v_skipped_ids, 1), 0),
    'skipped_store_ids', to_jsonb(v_skipped_ids)
  );
end
$$;

revoke execute on function public.apply_item_vendors_to_brand(uuid, jsonb, uuid) from public, anon;
grant  execute on function public.apply_item_vendors_to_brand(uuid, jsonb, uuid) to authenticated;

comment on function public.apply_item_vendors_to_brand(uuid, jsonb, uuid) is
  'spec 119: brand-wide fan-out of an ingredient''s item_vendors link set. Reconciles (upsert submitted / delete de-selected) across the catalog''s inventory_items rows in every caller-visible store of the catalog''s brand, mirroring is_primary + the legacy scalar vendor_id on each store. NON-DESTRUCTIVE pricing: existing links keep their own cost_per_unit/case_price; NEW links seed from the submitted values. Propagates per-link order_code (spec 114). Targets ONLY-EXISTING rows; stores missing the row are counted into skipped_count/skipped_store_ids and NOT created. Privileged + auth_can_see_brand + per-store auth_can_see_store gated; never cross-brand. Save (db.updateInventoryItem) is unchanged.';
