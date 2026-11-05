-- ============================================================
-- Spec 177 — reject line items that belong to a different store.
--
-- Three BEFORE-row triggers that enforce the per-store invariant BENEATH the
-- unchanged auth_can_see_store() RLS policies:
--
--   (R-1) public.po_items_check_store()          on public.po_items
--         BEFORE INSERT OR UPDATE OF item_id, po_id. The line's item must be
--         an inventory_items row of the parent purchase order's store. Fails
--         closed (42501) when the parent is missing / invisible / storeless or
--         the item is null / missing / invisible / another store's.
--   (R-2) public.order_approvals_lines_check_store() on public.order_approvals
--         BEFORE INSERT OR UPDATE OF lines. Every lines[].item_id must be an
--         inventory_items row of new.store_id. Malformed lines ⇒ 22023; a
--         cross-store / missing / invisible item ⇒ 42501. Covers the
--         create_order_approval RPC (insert + pending-retry update), a direct
--         PostgREST INSERT, and a direct PATCH of a pending row's lines.
--   (R-3) public.purchase_orders_lock_store_id()  on public.purchase_orders
--         BEFORE UPDATE OF store_id. store_id is ALWAYS immutable on UPDATE
--         (design D-3) — lined or not. 42501.
--
-- STRICTLY ADDITIVE: three functions, three triggers, three comments, three
-- revokes. No table, column, index, policy, publication or existing function
-- is modified. No backfill (prod had 0 bad rows on 2026-10-26; re-checked by
-- the runbook pre-check). No publication change, therefore NO
-- `docker restart supabase_realtime_imr-inventory` step.
--
-- All three functions are SECURITY INVOKER with `set search_path = public`
-- (design D-5): every legitimate writer can see both sides under its own role,
-- so "not visible to the caller" can only ever fail closed. Execute is revoked
-- from public, anon, authenticated (spec 097's ALTER DEFAULT PRIVILEGES would
-- otherwise grant it); Postgres does not check EXECUTE when a trigger fires.
--
-- Trigger order on order_approvals (design D-6): BEFORE triggers fire in name
-- order, and 'order_approvals_guard' < 'order_approvals_lines_check_store_trg',
-- so the existing guard runs first — a lines PATCH on a non-pending row keeps
-- reporting the guard's P0001 'order approval snapshot is immutable once
-- approved', and the guard's store_id immutability holds before this check.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): ONLY on the owner's explicit
-- go-ahead and BEFORE the push. execute_sql this body via the Supabase MCP,
-- INSERT the exact version '20261025000000' into
-- supabase_migrations.schema_migrations, VERIFY the three functions by
-- NORMALIZED-MD5 and the three triggers by PRESENCE (pg_trigger,
-- tgenabled = 'O'). Full runbook: specs/177-cross-store-item-rejection.md §10.
--
-- Design authority: specs/177-cross-store-item-rejection.md "## Backend design".
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ─── (R-1) po_items store consistency ─────────────────────────────────────
-- Modeled on public.inventory_count_entries_check_store()
-- (20260513120000_inventory_counts_consistency.sql). Column-scoped trigger
-- (receiving writes of received_qty / cost_per_unit / ordered_qty never call
-- the function) PLUS an in-function short-circuit (design D-4) so a future
-- pass-through SET of item_id / po_id with unchanged values stays harmless.
create or replace function public.po_items_check_store()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_po_store   uuid;
  v_item_store uuid;
begin
  if tg_op = 'UPDATE'
     and new.item_id is not distinct from old.item_id
     and new.po_id   is not distinct from old.po_id then
    return new;
  end if;

  select store_id into v_po_store
    from public.purchase_orders
   where id = new.po_id;
  if v_po_store is null then
    raise exception 'po_items: parent purchase order not found, not visible, or has no store'
      using errcode = '42501';
  end if;

  if new.item_id is null then
    raise exception 'po_items: item store mismatch with parent purchase order'
      using errcode = '42501';
  end if;

  select store_id into v_item_store
    from public.inventory_items
   where id = new.item_id;
  if v_item_store is null or v_item_store is distinct from v_po_store then
    raise exception 'po_items: item store mismatch with parent purchase order'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.po_items_check_store() is
  'spec 177 (R-1): BEFORE INSERT OR UPDATE OF item_id, po_id on public.po_items. '
  'Requires inventory_items.store_id of new.item_id to equal '
  'purchase_orders.store_id of new.po_id. Fails closed with 42501: '
  '''po_items: parent purchase order not found, not visible, or has no store'' / '
  '''po_items: item store mismatch with parent purchase order''. '
  'SECURITY INVOKER; short-circuits an UPDATE that leaves item_id and po_id unchanged.';

revoke execute on function public.po_items_check_store()
  from public, anon, authenticated;

drop trigger if exists po_items_check_store_trg on public.po_items;
create trigger po_items_check_store_trg
  before insert or update of item_id, po_id on public.po_items
  for each row
  execute function public.po_items_check_store();


-- ─── (R-2) order_approvals.lines store consistency ────────────────────────
-- Two set-based statements, no per-line loop (N4). (1) SHAPE never casts — it
-- uses pg_input_is_valid (PG16+), the same uuid input function the RPC's
-- cast-in-exception-block uses, so the two layers agree on what a uuid is and
-- no 22P02 can escape. (2) STORE casts only after (1) has proven every
-- element valid. Do NOT merge (1) and (2) into one predicate: SQL does not
-- guarantee AND/OR evaluation order, so the cast could run on a bad element.
-- An empty array passes vacuously (store check, not cardinality; the RPC
-- enforces 1..200).
create or replace function public.order_approvals_lines_check_store()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- store_id immutability on UPDATE is guaranteed by order_approvals_guard,
  -- which fires first (D-6).
  if tg_op = 'UPDATE' and new.lines is not distinct from old.lines then
    return new;
  end if;

  -- (1) SHAPE. The CASE keeps jsonb_array_elements off a non-array even if
  -- the OR were evaluated right-to-left (no evaluation-order reliance).
  if jsonb_typeof(new.lines) is distinct from 'array'
     or exists (select 1
                  from jsonb_array_elements(
                         case when jsonb_typeof(new.lines) = 'array'
                              then new.lines else '[]'::jsonb end) e
                 where jsonb_typeof(e) <> 'object'
                    or not pg_input_is_valid(coalesce(e->>'item_id', ''), 'uuid')) then
    raise exception 'order_approvals: lines must be an array of objects with a uuid item_id'
      using errcode = '22023';
  end if;

  -- (2) STORE.
  if exists (select 1
               from jsonb_array_elements(new.lines) e
              where not exists (select 1
                                  from public.inventory_items ii
                                 where ii.id = (e->>'item_id')::uuid
                                   and ii.store_id = new.store_id)) then
    raise exception 'order_approvals: line item store mismatch with approval store'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.order_approvals_lines_check_store() is
  'spec 177 (R-2): BEFORE INSERT OR UPDATE OF lines on public.order_approvals. '
  'Every lines[].item_id must be an inventory_items row of new.store_id. '
  'Malformed lines raise 22023 ''order_approvals: lines must be an array of '
  'objects with a uuid item_id''; a missing / invisible / other-store item '
  'raises 42501 ''order_approvals: line item store mismatch with approval store''. '
  'SECURITY INVOKER; short-circuits an UPDATE that leaves lines unchanged; '
  'fires after order_approvals_guard (name order).';

revoke execute on function public.order_approvals_lines_check_store()
  from public, anon, authenticated;

drop trigger if exists order_approvals_lines_check_store_trg on public.order_approvals;
create trigger order_approvals_lines_check_store_trg
  before insert or update of lines on public.order_approvals
  for each row
  execute function public.order_approvals_lines_check_store();


-- ─── (R-3) purchase_orders.store_id is always immutable ───────────────────
-- Design D-3: no legitimate writer changes store_id (the store/brand cascade
-- is a DELETE), and always-immutable makes the parent store R-1 reads a
-- constant, which closes the "lock once lined" insert-vs-move race. A
-- mis-filed PO is cancelled and re-created.
create or replace function public.purchase_orders_lock_store_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.store_id is distinct from old.store_id then
    raise exception 'purchase_orders: store_id is immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.purchase_orders_lock_store_id() is
  'spec 177 (R-3): BEFORE UPDATE OF store_id on public.purchase_orders. '
  'store_id is always immutable on UPDATE (lined or not); a change raises '
  '42501 ''purchase_orders: store_id is immutable''. SECURITY INVOKER.';

revoke execute on function public.purchase_orders_lock_store_id()
  from public, anon, authenticated;

drop trigger if exists purchase_orders_lock_store_id_trg on public.purchase_orders;
create trigger purchase_orders_lock_store_id_trg
  before update of store_id on public.purchase_orders
  for each row
  execute function public.purchase_orders_lock_store_id();

commit;
