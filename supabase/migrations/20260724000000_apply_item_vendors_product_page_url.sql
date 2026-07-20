-- ============================================================
-- Spec 131 (post-review KEEP fix) — propagate item_vendors.product_page_url in
-- apply_item_vendors_to_brand, for PARITY with the per-link order_code.
--
-- The owner ruled KEEP on the spec-131 product_page_url editor field
-- (specs/131-.../reviews/release-proposal.md step 2 / backend-architect.md
-- deviation (b)). Under that ruling the release proposal requires the paired
-- fix (code-reviewer finding 2 / architect M-1): the spec-119 SECURITY DEFINER
-- fan-out apply_item_vendors_to_brand (20260714000000_apply_item_vendors_to_brand.sql)
-- copies each link's order_code to every brand store but SILENTLY DROPS the new
-- item_vendors.product_page_url column (added 20260723000000_extension_ordering.sql).
-- "Apply vendors to all stores" therefore propagates order codes but not
-- product-page URLs — the exact order-code-propagates / product-URL-doesn't
-- inconsistency the proposal flagged.
--
-- THIS MIGRATION carries product_page_url IDENTICALLY to order_code and changes
-- NOTHING ELSE about the function:
--   • INSERT branch (NEW link)  → product_page_url SEEDED from the submitted
--     value (mirrors order_code; both are per-(item,vendor) metadata, not price).
--   • DO UPDATE branch (EXISTS) → product_page_url overwritten from the submitted
--     value (mirrors order_code's AC-7 propagate semantics). cost_per_unit /
--     case_price remain DELIBERATELY untouched (AC-6 preserve) — unchanged.
--   • empty/absent → SQL NULL via nullif(...,'') — same null-coalesce as
--     order_code (spec 114). The client wrapper db.ts applyItemVendorsToBrand is
--     threaded in the SAME change to SEND product_page_url, so the overwrite
--     propagates the submitted value rather than wiping it to NULL.
--
-- Security posture is IDENTICAL to the original: SECURITY DEFINER,
-- set search_path = public, the same auth_is_privileged() + catalog-exists +
-- auth_can_see_brand + per-store auth_can_see_store guards, in the same order,
-- with the same primary-unset-before-upsert ordering. No guard is added, removed,
-- or reordered. The grants/comment are re-issued to match the original exactly.
--
-- ADDITIVE, NON-DESTRUCTIVE, reversible-by-design: this is a single
-- CREATE OR REPLACE FUNCTION; re-applying the 20260714000000 body restores the
-- prior behavior. No column, policy, publication, or grant change.
--
-- REALTIME PUBLICATION GOTCHA — DOES NOT APPLY. Function-only change; no
-- supabase_realtime publication membership change (item_vendors was published in
-- spec 102). No docker restart needed.
--
-- PROD-APPLY (spec 064 gate — Supabase MCP; db push lacks the prod password):
--   1. execute_sql this whole migration body (function + grants + comment).
--   2. INSERT the exact version '20260724000000' into
--      supabase_migrations.schema_migrations so db-migrations-applied.yml stays
--      green. NOTE: 20260723000000_extension_ordering.sql is ALSO still pending
--      prod-apply — apply BOTH in the same window (20260723 first, then this).
--   3. VERIFY by NORMALIZED-MD5 of the function body (CREATE-OR-REPLACE path).
--   The developer FLAGS this prod-apply in the handoff and does NOT push it.
-- ============================================================

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
    --   DO UPDATE branch (EXISTS) → order_code + product_page_url + is_primary
    --                               + updated_at only; cost_per_unit /
    --                               case_price are DELIBERATELY untouched
    --                               (AC-6 preserve).
    -- order_code AND product_page_url overwrite on both branches (AC-7
    -- propagate-order-code; product_page_url carried identically). is_primary =
    -- (vendor is the submitted primary) → SD-1 mirror; coalesce to false so a
    -- NULL primary yields a valid boolean (NOT NULL column).
    insert into public.item_vendors
      (item_id, vendor_id, cost_per_unit, case_price, is_primary, order_code, product_page_url)
    select
      v_item.id,
      (elem->>'vendor_id')::uuid,
      coalesce((elem->>'cost_per_unit')::numeric, 0),
      coalesce((elem->>'case_price')::numeric, 0),
      coalesce(((elem->>'vendor_id')::uuid = p_primary_vendor_id), false),
      nullif(elem->>'order_code', ''),
      nullif(elem->>'product_page_url', '')
    from jsonb_array_elements(coalesce(p_vendors, '[]'::jsonb)) elem
    on conflict (item_id, vendor_id) do update
      set order_code       = excluded.order_code,
          product_page_url = excluded.product_page_url,
          is_primary       = excluded.is_primary,
          updated_at       = now();

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
  'spec 119 (+spec 131 KEEP fix): brand-wide fan-out of an ingredient''s item_vendors link set. Reconciles (upsert submitted / delete de-selected) across the catalog''s inventory_items rows in every caller-visible store of the catalog''s brand, mirroring is_primary + the legacy scalar vendor_id on each store. NON-DESTRUCTIVE pricing: existing links keep their own cost_per_unit/case_price; NEW links seed from the submitted values. Propagates per-link order_code (spec 114) AND product_page_url (spec 131) identically. Targets ONLY-EXISTING rows; stores missing the row are counted into skipped_count/skipped_store_ids and NOT created. Privileged + auth_can_see_brand + per-store auth_can_see_store gated; never cross-brand. Save (db.updateInventoryItem) is unchanged.';
