-- ============================================================
-- Spec 122 — Apply per-store scalar edits to all stores in the brand.
--
-- A brand admin editing an ingredient from the brand-level catalog.tsv view
-- wants the per-store CONFIG scalars (par_level, cost_per_unit, case_price)
-- to apply to the SAME catalog ingredient's inventory_items row across EVERY
-- store of the current brand the caller can see. This is the "this IS the
-- ingredient" mental model of the catalog view. A per-store items.tsv Save
-- still only touches the current store (db.updateInventoryItem) — this RPC is
-- the SEPARATE, additive fan-out path invoked automatically on a catalog.tsv
-- Save.
--
-- This is a SECURITY DEFINER fan-out that applies the three scalars server-
-- side, in ONE atomic set-based UPDATE, with authoritative skipped-store
-- accounting the client-loop alternative could not produce (it can only see
-- rows RLS lets it read; it cannot COUNT a store whose row it cannot see).
--
-- ADDITIVE, NON-DESTRUCTIVE (of SCHEMA), reversible-by-design:
--   drop function public.apply_item_scalars_to_brand(uuid, numeric, numeric, numeric);
-- returns the system to exactly today's behavior. Save is untouched, so
-- shipping this migration ahead of the UI wiring is inert and safe.
--
-- OVERWRITE semantics — DELIBERATE DIVERGENCE FROM SPEC 119 (OQ-2). Spec 119's
-- apply_item_vendors_to_brand DELIBERATELY PRESERVES each store's existing
-- per-vendor cost_per_unit / case_price, because a store can negotiate its own
-- price with a shared vendor. This RPC DELIBERATELY OVERWRITES par_level,
-- cost_per_unit and case_price on every visible store with the typed value,
-- because the owner's catalog "this IS the ingredient" model wants those three
-- uniform brand-wide. This divergence is INTENTIONAL and CORRECT — do NOT flag
-- it as an inconsistency between 119 and 122. (Reviewer note per spec 122
-- Backend design §"Overwrite vs 119 preserve".)
--
-- NULL-MEANS-SKIP per field. A catalog Save always sends all three non-NULL,
-- so in practice all three fan out on every catalog save. A NULL param is the
-- "leave this field alone on every store" escape hatch (defensive + future-
-- proof: propagate par only, cost only, etc. without a new RPC). Each written
-- column is coalesce(p_<field>, ii.<field>) so a NULL param is a literal no-op
-- on that column.
--
-- current_stock AND COUNT-LIKE FIELDS ARE NOT PARAMETERS (AC-5/AC-6). They are
-- excluded BY CONSTRUCTION — the UPDATE names exactly three columns, so it is
-- structurally impossible for this RPC to touch current_stock, expiry_date,
-- usage_per_portion, average_daily_usage or safety_stock. Those are live/
-- physical per-store values and legitimately differ per store.
--
-- REALTIME PUBLICATION GOTCHA — DOES NOT APPLY. This migration adds a FUNCTION
-- only; it does NOT change supabase_realtime publication membership.
-- inventory_items was already in the publication
-- (20260514140000_realtime_publication_tighten.sql). The
-- `docker restart supabase_realtime_imr-inventory` ritual is NOT needed for
-- this spec — each affected store's inventory_items change already replays on
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

-- apply_item_scalars_to_brand(catalog, par, cost, case_price) — overwrite the
-- three per-store CONFIG scalars for a catalog ingredient across the brand's
-- caller-visible inventory_items rows.
--
--   p_catalog_id    — the current item's catalog_id.
--   p_par_level     — new par_level. NULL ⇒ skip (leave every store's par_level).
--   p_cost_per_unit — new cost_per_unit. NULL ⇒ skip.
--   p_case_price    — new case_price. NULL ⇒ skip.
--
-- Returns jsonb:
--   { updated_count, skipped_count, skipped_store_ids }
--   updated_count     — inventory_items rows overwritten (visible brand stores
--                       WITH a row for this catalog, incl. current).
--   skipped_count /   — visible brand stores with NO inventory_items row for
--   skipped_store_ids   this catalog. v1 does NOT create the row (AC-9).
create or replace function public.apply_item_scalars_to_brand(
  p_catalog_id    uuid,
  p_par_level     numeric,
  p_cost_per_unit numeric,
  p_case_price    numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand_id    uuid;
  v_updated     int := 0;
  v_skipped_ids uuid[] := '{}';
begin
  -- Auth gate (privileged + brand-scoped), byte-aligned with spec 119.
  if not public.auth_is_privileged() then
    raise exception 'privileged only';
  end if;

  select brand_id into v_brand_id
    from public.catalog_ingredients
   where id = p_catalog_id;
  if v_brand_id is null then
    raise exception 'catalog ingredient not found';
  end if;

  -- Never cross-brand (AC-8).
  if not public.auth_can_see_brand(v_brand_id) then
    raise exception 'brand not accessible';
  end if;

  -- Single atomic set-based OVERWRITE across every inventory_items row for
  -- this catalog in a store the caller can SEE. auth_can_see_store() in the
  -- WHERE predicate is the per-store gate (AC-8/AC-11): a store the caller
  -- cannot see is neither read nor written — semantically identical to 119's
  -- in-loop belt-and-suspenders check. coalesce(p_field, ii.field) makes a
  -- NULL param a literal no-op on that column (NULL-means-skip). current_stock
  -- and every count-like field are absent by construction (AC-5/AC-6).
  update public.inventory_items ii
     set par_level     = coalesce(p_par_level,     ii.par_level),
         cost_per_unit = coalesce(p_cost_per_unit, ii.cost_per_unit),
         case_price    = coalesce(p_case_price,    ii.case_price),
         updated_at    = now()
   where ii.catalog_id = p_catalog_id
     and public.auth_can_see_store(ii.store_id);
  get diagnostics v_updated = row_count;

  -- Authoritative skipped set: visible brand stores with NO inventory_items
  -- row for this catalog. v1 does NOT create the row (AC-9, out of scope).
  -- Byte-aligned with spec 119's skipped query.
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

revoke execute on function public.apply_item_scalars_to_brand(uuid, numeric, numeric, numeric) from public, anon;
grant  execute on function public.apply_item_scalars_to_brand(uuid, numeric, numeric, numeric) to authenticated;

comment on function public.apply_item_scalars_to_brand(uuid, numeric, numeric, numeric) is
  'spec 122: brand-wide OVERWRITE fan-out of an ingredient''s per-store CONFIG scalars (par_level, cost_per_unit, case_price) across the catalog''s inventory_items rows in every caller-visible store of the catalog''s brand. Single atomic set-based UPDATE. NULL param ⇒ skip that field (coalesce to existing). OVERWRITE semantics — DELIBERATELY different from spec 119''s preserve, because the owner wants these three uniform brand-wide. current_stock and count-like fields (expiry_date, usage_per_portion, average_daily_usage, safety_stock) are excluded BY CONSTRUCTION (never parameters — AC-5/AC-6). Targets ONLY-EXISTING rows; stores missing the row are counted into skipped_count/skipped_store_ids and NOT created (AC-9). Privileged + auth_can_see_brand + per-store auth_can_see_store gated; never cross-brand. Save (db.updateInventoryItem / items.tsv) is unchanged.';
