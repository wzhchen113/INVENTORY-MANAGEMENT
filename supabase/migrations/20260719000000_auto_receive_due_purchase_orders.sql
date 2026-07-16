-- supabase/migrations/20260719000000_auto_receive_due_purchase_orders.sql
--
-- Spec 125 — Auto-receive purchase orders on expected delivery date (BACKEND).
--
-- Adds a daily scheduled DB job that auto-receives every open PO whose
-- expected_delivery has arrived, so a delivered-but-unreceived PO stops
-- lingering as "inbound" (pending_po_qty) on the reorder screen and skewing
-- reorder math. Three additive pieces, no destructive DDL:
--
--   1. auto_receive_due_purchase_orders(date) — a NEW SECURITY DEFINER RPC that
--      INLINES the full-receive restock (does NOT loop over receive_purchase_order,
--      which stamps received_by = auth.uid() — NULL/undesirable in a cron/DEFINER
--      context). System-attributed: received_by = NULL, one system audit row per PO.
--   2. Grants — REVOKE from public/anon/authenticated; keep postgres + service_role
--      (cron runs as postgres; a future admin "run now" endpoint uses service_role).
--   3. pg_cron schedule `auto-receive-purchase-orders-daily` at `0 8 * * *` UTC,
--      calling the RPC with its default current_date. `if exists … unschedule`
--      re-apply guard.
--
-- ─── DESIGN CROSS-REFERENCE (spec 125 ## Backend design) ───────────────────
--   • Full-receive restock logic is MIRRORED (inlined) from receive_purchase_order
--     (20260704000000_po_loop.sql:160, re-created 20260705000000_cost_on_receipt.sql):
--     per open line delta = greatest(0, ordered_qty − received_qty); set
--     po_items.received_qty = ordered_qty; when delta<>0 increment
--     inventory_items.current_stock += delta (store-pinned). STOCK-ONLY — NO cost
--     path (spec 109's new_case_price hunks are NOT ported; auto-receive never
--     re-prices, over-receipt self-corrects via EOD).
--   • Idempotency: the selection filter requires received_at IS NULL and a full
--     receive always stamps received_at = now() + status='received', so a received
--     PO can NEVER be re-selected → stock added exactly once per PO. The
--     deterministic receive_client_uuid = md5(po_id || ':auto-receive')::uuid is
--     defensive (a stable audit marker; unique per PO so it composes with the
--     existing partial-unique purchase_orders_receive_client_uuid_idx).
--   • Cross-store: the RPC is SECURITY DEFINER (runs as owner, bypasses RLS) — this
--     is a SYSTEM job with zero session callers (grants revoked from
--     anon/authenticated). Same pattern as record_missed_orders_for_day
--     (20260530000000_record_missed_orders_rpc.sql). The inventory_items UPDATE is
--     store-pinned (AND store_id = <po.store_id>) mirroring receive_purchase_order's
--     defense-in-depth.
--
-- ─── NO SCHEMA / NO PUBLICATION CHANGE ─────────────────────────────────────
-- purchase_orders.expected_delivery already exists (20260405000759_init_schema.sql;
-- dormant — this spec is its first writer/reader). No column/index/constraint DDL.
-- purchase_orders + inventory_items are ALREADY in supabase_realtime
-- (20260514140000_realtime_publication_tighten.sql), po_items rides its parent
-- header UPDATE — so NO `alter publication` and NO
-- `docker restart supabase_realtime_imr-inventory` is needed after `npm run dev:db`.
--
-- ─── PROD-APPLY NOTES (owner-gated; db push lacks the prod password) ────────
-- Apply via MCP execute_sql against ebwnovzzkwhsdxkpyjka, then insert the exact
-- version 20260719000000 into supabase_migrations.schema_migrations, else the
-- db-migrations-applied gate goes red (project MEMORY). POST-APPLY verify (a
-- function+cron change is invisible to the migration-list drift gate):
--   • select 1 from pg_proc where proname = 'auto_receive_due_purchase_orders';
--   • select 1 from cron.job where jobname = 'auto-receive-purchase-orders-daily';

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- auto_receive_due_purchase_orders(p_as_of date default current_date)
-- Returns the integer count of POs auto-received this run.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.auto_receive_due_purchase_orders(
  p_as_of date default current_date
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po          record;
  v_line        record;
  v_delta       numeric;
  v_vendor_name text;
  v_line_count  int;
  v_count       int := 0;
begin
  -- Loop every open, due PO across ALL stores (DEFINER bypasses RLS — this is a
  -- system job; no auth_can_see_store gate). "Due" = status in ('sent','partial')
  -- AND received_at IS NULL AND expected_delivery IS NOT NULL AND ≤ p_as_of. The
  -- received_at IS NULL filter is the idempotency anchor: a PO this run flips to
  -- received_at = now() and can never be re-selected on a later run.
  for v_po in
    select id, store_id, vendor_id
      from public.purchase_orders
     where status in ('sent', 'partial')
       and received_at is null
       and expected_delivery is not null
       and expected_delivery <= p_as_of
     order by id
  loop
    -- FULL receive: top every open line up to its ordered_qty and add ONLY the
    -- per-line remainder (ordered − received) to stock. greatest(0, …) guards an
    -- already-over-received line from decrementing stock (mirrors
    -- receive_purchase_order's pending_po_qty guard).
    for v_line in
      select id,
             item_id,
             coalesce(ordered_qty, 0)  as ordered_qty,
             coalesce(received_qty, 0) as received_qty
        from public.po_items
       where po_id = v_po.id
    loop
      v_delta := greatest(0, v_line.ordered_qty - v_line.received_qty);

      -- Only touch a line that still has an outstanding remainder (delta > 0).
      -- Gating the received_qty write too (not just the stock write) keeps it
      -- MONOTONIC: an already-over-received line (received_qty > ordered_qty on a
      -- still-partial PO) is left alone rather than regressed down to ordered_qty.
      if v_delta <> 0 then
        update public.po_items
           set received_qty = v_line.ordered_qty
         where id = v_line.id;

        if v_line.item_id is not null then
          update public.inventory_items ii
             set current_stock = coalesce(ii.current_stock, 0) + v_delta,
                 updated_at    = now()
           where ii.id = v_line.item_id
             and ii.store_id = v_po.store_id;   -- store pin (defense-in-depth)
        end if;
      end if;
    end loop;

    -- Header flip. received_by = NULL is the SYSTEM attribution (no auth.uid() in
    -- cron/DEFINER context). The deterministic receive_client_uuid is defensive and
    -- unique per PO (md5(po_id) differs per PO → no cross-PO collision on the
    -- partial-unique index); it intentionally overwrites any prior manual key
    -- (harmless — the row is now terminally received).
    update public.purchase_orders
       set status              = 'received',
           received_at         = now(),
           received_by         = null,
           receive_client_uuid = md5(id::text || ':auto-receive')::uuid
     where id = v_po.id;

    -- One system-attributed audit row per PO (mirrors receive_purchase_order's
    -- write shape but with user_id = NULL and a distinct action). Vendor name is
    -- best-effort for the item_ref column.
    select v.name into v_vendor_name
      from public.vendors v
     where v.id = v_po.vendor_id;

    select count(*) into v_line_count
      from public.po_items
     where po_id = v_po.id;

    insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
    values (v_po.store_id, null, 'PO auto-received',
            'PO ' || left(v_po.id::text, 8) || ' · received (auto)',
            v_vendor_name, v_line_count::text || ' line(s)');

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.auto_receive_due_purchase_orders(date) is
  'Spec 125 — daily system job. Auto-receives every open PO (status in
   (sent,partial), received_at IS NULL) whose expected_delivery IS NOT NULL and
   <= p_as_of, across ALL stores. FULL receive: each line''s received_qty is
   topped up to ordered_qty and current_stock increments by exactly the
   outstanding remainder (store-pinned); header flips to received + received_at
   stamped + received_by NULL (system) + receive_client_uuid =
   md5(po_id||'':auto-receive'')::uuid (defensive). Stock-only (no cost re-price).
   Idempotent via the received_at IS NULL selection filter → stock added exactly
   once per PO. One audit_log row per PO (user_id NULL, action ''PO auto-received'').
   SECURITY DEFINER so cron (postgres) bypasses RLS for the cross-store writes;
   anon + authenticated lack EXECUTE — cron + service_role only.';

-- ─── Grants ────────────────────────────────────────────────────
-- Revoke from public (and therefore anon, which inherits it; and authenticated,
-- the session-driven role we want to block). Grant explicitly to postgres (the
-- role pg_cron executes under) and service_role (defense-in-depth for a future
-- admin "run now" endpoint; not used today). Zero session callers — mirrors
-- record_missed_orders_for_day exactly. Per the spec-097 explicit-grant note
-- (20260618000000_public_grants_explicit.sql), the default public EXECUTE grant a
-- fresh CLI image would re-add is explicitly revoked here.
revoke execute on function public.auto_receive_due_purchase_orders(date)
  from public, anon, authenticated;
grant  execute on function public.auto_receive_due_purchase_orders(date)
  to postgres, service_role;

-- ─── pg_cron schedule ──────────────────────────────────────────
-- 08:00 UTC daily — distinct from the existing DB crons (eod-reminder `*/5`,
-- record-missed-orders-daily `0 7`, prune-username-resolve-rate-limit `17 4`).
-- Runs one hour after record-missed so the two daily jobs don't overlap. Body
-- calls the RPC with the default current_date (UTC). expected_delivery is a plain
-- `date`; coarse UTC-daily granularity is accepted (owner: EOD counts override
-- on-hand, over/early-receipt self-corrects) — same brand-wide TZ approximation
-- record_missed_orders documents.
--
-- The `if exists … unschedule` block makes the migration safe to re-apply.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'auto-receive-purchase-orders-daily') then
    perform cron.unschedule('auto-receive-purchase-orders-daily');
  end if;

  perform cron.schedule(
    'auto-receive-purchase-orders-daily',
    '0 8 * * *',
    $cron$ select public.auto_receive_due_purchase_orders(); $cron$
  );
end $$;

commit;
