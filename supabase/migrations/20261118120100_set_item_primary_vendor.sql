-- ============================================================
-- Spec 201 — public.set_item_primary_vendor(uuid, uuid, date): the admin
-- "switch" on a reorder row that won a coincident day (R7, design §5).
--
-- What: a NEW function. Makes p_vendor_id the item's primary vendor at THIS
-- store only, atomically, in the spec 124 demote-first order:
--   demote the old is_primary link → promote the new link → mirror the
--   SD-1 scalar inventory_items.vendor_id.
-- One transaction, so the item_vendors_one_primary_per_item partial unique
-- index never sees two primaries and vendor_id / is_primary can't drift
-- apart half-way (design §5.1, the "dangling scalar"). Only this item's
-- inventory_items row and its item_vendors rows are written; inventory_items
-- is per store, so no other store's rows change.
--
-- Posture: SECURITY INVOKER, set search_path = public. Every guard fires
-- BEFORE any write, in this order, with these stable strings:
--   1. any argument null
--        'set_item_primary_vendor: item_id, vendor_id and as_of_date are required'  22023
--   2. not public.auth_is_privileged()  (admin only, OQ-3 — server-side)
--        'set_item_primary_vendor: privileged only'                                42501
--   3. item row locked FOR UPDATE (serializes concurrent switches); not
--      found, including RLS-hidden
--        'set_item_primary_vendor: item not found'                                 P0001
--   4. not public.auth_can_see_store(<item store>)
--        'set_item_primary_vendor: caller cannot see store'                        42501
--   5. no item_vendors link for (item, vendor)
--        'set_item_primary_vendor: vendor is not linked to this item'              P0001
--   6. already primary (vendor_id is not distinct from p_vendor_id) → return
--      changed = false with NO writes (does not repair is_primary drift — R3)
--   7. 3c: the item is on a non-cancelled purchase_orders row for (this
--      store, the CURRENT primary vendor, p_as_of_date) — same keying as
--      report_reorder_list's has_po; covers FILL CART drafts
--        'set_item_primary_vendor: item is on an open order for the current primary vendor'  P0001
-- The 3c string is a client contract (the store action matches it by
-- substring); changing it is a contract change.
-- PostgREST maps 22023 / P0001 → 400 and 42501 → 403.
--
-- RLS: no policy change. Being INVOKER, RLS stays the second wall behind the
-- explicit gates (store_member_update_inventory_items /
-- store_member_update_item_vendors; po_items / purchase_orders SELECT via
-- store_member_read_*). trg_item_vendor_changed_at stamps vendor_changed_at
-- on the scalar change (spec 128 "Updated" badge — intended).
--
-- The CLAUDE.md self-guard and last-of-role conventions do not apply: this
-- targets no profile and deletes nothing.
--
-- Grants: revoke from public, anon; grant to authenticated (same shape as
-- apply_item_vendors_to_brand). Pinned in set_item_primary_vendor.test.sql.
--
-- Realtime: NONE. inventory_items and item_vendors are already in
-- supabase_realtime; no publication change, so the
-- `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
--
-- Prod apply (Supabase MCP, project ebwnovzzkwhsdxkpyjka): execute_sql this
-- file, INSERT version '20261118120100' into
-- supabase_migrations.schema_migrations, then verify the function's
-- normalized md5. Apply together with 20261118120000 and BEFORE the spec 201
-- admin client deploys (otherwise the switch fails with PGRST202 →
-- notifyBackendError + revert).
--
-- Rollback (after the admin client is rolled back):
--   drop function public.set_item_primary_vendor(uuid, uuid, date);
-- ============================================================

create or replace function public.set_item_primary_vendor(
  p_item_id    uuid,
  p_vendor_id  uuid,
  p_as_of_date date
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_store uuid;
  v_prev  uuid;
begin
  -- 1. Required arguments.
  if p_item_id is null or p_vendor_id is null or p_as_of_date is null then
    raise exception 'set_item_primary_vendor: item_id, vendor_id and as_of_date are required'
      using errcode = '22023';
  end if;

  -- 2. Admin only (OQ-3), enforced server-side. Mirrors
  -- apply_item_vendors_to_brand's auth_is_privileged() gate.
  if not public.auth_is_privileged() then
    raise exception 'set_item_primary_vendor: privileged only'
      using errcode = '42501';
  end if;

  -- 3. Lock the item row; serializes two concurrent switches of the same
  -- item. An RLS-hidden row reads as not found.
  select ii.store_id, ii.vendor_id
    into v_store, v_prev
    from public.inventory_items ii
   where ii.id = p_item_id
     for update;
  if not found then
    raise exception 'set_item_primary_vendor: item not found'
      using errcode = 'P0001';
  end if;

  -- 4. Store visibility (explicit house shape on top of RLS).
  if not public.auth_can_see_store(v_store) then
    raise exception 'set_item_primary_vendor: caller cannot see store'
      using errcode = '42501';
  end if;

  -- 5. The target vendor must already be linked to the item.
  if not exists (
    select 1
      from public.item_vendors iv
     where iv.item_id   = p_item_id
       and iv.vendor_id = p_vendor_id
  ) then
    raise exception 'set_item_primary_vendor: vendor is not linked to this item'
      using errcode = 'P0001';
  end if;

  -- 6. No-op: already the primary. No writes; is_primary drift is NOT
  -- repaired here (R3, out of scope).
  if v_prev is not distinct from p_vendor_id then
    return jsonb_build_object(
      'item_id',            p_item_id,
      'store_id',           v_store,
      'previous_vendor_id', v_prev,
      'vendor_id',          p_vendor_id,
      'changed',            false
    );
  end if;

  -- 7. 3c: refuse when the item is already on today's order for the CURRENT
  -- primary vendor. Same (store, vendor, reference_date, status <>
  -- 'cancelled') keying as report_reorder_list's has_po. Re-checked here in
  -- the same transaction as the write. This NARROWS the client pre-check
  -- TOCTOU but does not close it: under READ COMMITTED a concurrent FILL CART
  -- whose po_items insert has not committed yet is invisible here, and the
  -- inventory_items row lock does not serialize against po_items inserts.
  -- The residue is the rare stale draft line spec 201's Residual risk names.
  if v_prev is not null and exists (
    select 1
      from public.po_items pi
      join public.purchase_orders po on po.id = pi.po_id
     where pi.item_id        = p_item_id
       and po.store_id       = v_store
       and po.vendor_id      = v_prev
       and po.reference_date = p_as_of_date
       and po.status <> 'cancelled'
  ) then
    raise exception 'set_item_primary_vendor: item is on an open order for the current primary vendor'
      using errcode = 'P0001';
  end if;

  -- 8. Demote first (spec 124 order) so the partial unique index
  -- item_vendors_one_primary_per_item never sees two primaries.
  update public.item_vendors
     set is_primary = false, updated_at = now()
   where item_id = p_item_id
     and is_primary
     and vendor_id <> p_vendor_id;

  -- 9. Promote the new primary link.
  update public.item_vendors
     set is_primary = true, updated_at = now()
   where item_id   = p_item_id
     and vendor_id = p_vendor_id;

  -- 10. Mirror the SD-1 scalar. trg_item_vendor_changed_at stamps
  -- vendor_changed_at (spec 128).
  update public.inventory_items
     set vendor_id = p_vendor_id, updated_at = now()
   where id = p_item_id;

  -- 11. Result.
  return jsonb_build_object(
    'item_id',            p_item_id,
    'store_id',           v_store,
    'previous_vendor_id', v_prev,
    'vendor_id',          p_vendor_id,
    'changed',            true
  );
end
$$;

revoke execute on function public.set_item_primary_vendor(uuid, uuid, date) from public, anon;
grant  execute on function public.set_item_primary_vendor(uuid, uuid, date) to authenticated;

comment on function public.set_item_primary_vendor(uuid, uuid, date) is
  'spec 201: admin-only (auth_is_privileged) switch of an item''s primary vendor at ONE store. SECURITY INVOKER. Guards (all before any write): required args (22023), privileged only (42501), item locked FOR UPDATE / not found (P0001), auth_can_see_store (42501), vendor linked (P0001), no-op when already primary (changed=false, no writes), and the 3c refusal when the item is on a non-cancelled purchase_orders row for (store, current primary, p_as_of_date) (P0001, stable string ''item is on an open order for the current primary vendor''). Then spec 124 demote-first: demote old is_primary link, promote the new link, mirror inventory_items.vendor_id. Returns {item_id, store_id, previous_vendor_id, vendor_id, changed}.';
