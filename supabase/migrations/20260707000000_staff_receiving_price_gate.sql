-- supabase/migrations/20260707000000_staff_receiving_price_gate.sql
--
-- Spec 113 — Staff-side receiving: server-side price-path privilege gate
-- (BACKEND slice).
--
-- Owner ruling R-1 (STOCK-ONLY for staff, enforced SERVER-SIDE): staff record
-- delivered quantities → stock via the existing receive path, but the spec-109
-- price/cost path (a line carrying new_case_price → the ★ item_vendors +
-- inventory_items cost updates) stays ADMIN-ONLY and is now enforced in the
-- database — not merely by the staff UI omitting the price column. A
-- non-privileged store member who reaches a priced line — even via a
-- hand-crafted RPC call — is refused for the WHOLE call, with nothing durable
-- written (no stock, no cost, no audit, no idempotency stamp). The stock path is
-- UNCHANGED for store members; the privileged price path is UNCHANGED (spec 109
-- regression). This closes the pre-existing hole: §3b had NO role gate, so any
-- authenticated store member (incl. a staff-role member) could rewrite item
-- costs via a crafted new_case_price. See spec 113 backend design §0/§1/§2.
--
-- ─── SOURCE DISCIPLINE (verbatim-copy) ─────────────────────────────────────
-- The receive_purchase_order body below is copied VERBATIM from its CURRENT
-- on-disk LATEST definition:
--     20260705000000_cost_on_receipt.sql:122-386
-- (the spec 107 body + the four spec-109 hunks) and applies EXACTLY ONE new
-- gate hunk, per spec 113 backend design §1:
--
--   HUNK (spec 113 GATE) — the FIRST statement inside the §3b cost branch,
--            immediately after `if v_item_id is not null and
--            v_line.new_case_price is not null then` and BEFORE the `< 0`
--            validation: `if not public.auth_is_privileged() then raise
--            exception 'forbidden: price change requires admin' using errcode =
--            '42501'; end if;`. Placed before the `< 0` check so the gate keys
--            ONLY on the PRESENCE of a non-null new_case_price (the enclosing
--            `if`), refusing a non-privileged caller identically regardless of
--            the price VALUE (0 / negative / equal / different) — OQ-1 "price
--            ENTRY stays admin-only". The refusal string
--            'forbidden: price change requires admin' is a PINNED house
--            stable-string contract (the 'cannot delete self' / 'cannot demote
--            self' family; pgTAP pins it byte-equal — do not reword without
--            editing supabase/tests/staff_receiving_gate.test.sql in the same
--            PR). errcode 42501 (insufficient_privilege) matches the
--            auth_can_see_store gate three lines up in the source.
--
-- Why the placement is correct (the load-bearing reasoning, mirroring the
-- design §1): the gate fires BEFORE any durable write for the priced line AND
-- before the idempotency stamp. The §3a stock UPDATE and the received_qty
-- UPDATE run EARLIER in the SAME loop iteration in source order, but plpgsql
-- runs the function in a single implicit transaction — a `raise exception`
-- aborts and ROLLS BACK the entire function (every stock/received_qty write from
-- this and prior iterations), so "nothing durable" (AC-2) holds even though the
-- raise is physically after the stock UPDATE. This is the same atomic-rollback
-- property spec 109's `< 0` P0001 case relied on; the spec 113 pgTAP case (b)
-- pins it directly across all six durable targets (received_qty, current_stock,
-- inventory_items.case_price/cost_per_unit, item_vendors, audit_log) plus the
-- receive_client_uuid stamp.
--
-- NO OTHER delta. There are no behaviorally-inert deltas beyond this one hunk:
-- every other line — the stock path, status flip, idempotency short-circuit,
-- envelope shape, and the privileged cost path (§3b HUNK 2/3/4) — is
-- byte-identical to 20260705000000_cost_on_receipt.sql:122-386. The other RPCs
-- in that file's ancestry (close_short_purchase_order, cancel_purchase_order)
-- and the reorder re-CREATEs are NOT re-emitted here — only
-- receive_purchase_order changes. Diff this body against
-- 20260705000000_cost_on_receipt.sql:122-386 to verify the gate hunk (+ the
-- comment-on-function line noting the gate) is the ONLY delta (AC-5).
--
-- ─── ACL / GRANT ───────────────────────────────────────────────────────────
-- The signature is byte-identical — receive_purchase_order(uuid, jsonb, uuid) —
-- so `create or replace` PRESERVES the existing `revoke … from public, anon` +
-- `grant … to authenticated` from spec 107. NO grant/revoke statements here
-- (matching the spec-104 / 107 / 109 discipline for signature-stable
-- re-CREATEs). SECURITY INVOKER + set search_path = public unchanged. No RLS /
-- policy change: the stock writes ride existing policies and the
-- top-of-function auth_can_see_store gate fires FIRST; the NEW price-path gate
-- is an inline SECOND authorization check inside the §3b branch (RLS cannot
-- express "refuse based on a value inside the jsonb argument"). The stock path
-- is NOT gated on privilege (that would break staff receiving entirely — R-1 is
-- stock-FOR-staff).
--
-- NO schema change: no CREATE/ALTER TABLE, no column, index, or constraint. The
-- gate touches only the function body.
--
-- NO publication membership change (no `alter publication supabase_realtime add
-- table`): purchase_orders is ALREADY in supabase_realtime for the admin
-- store-{id} reload, and this migration touches only a function body. So the
-- realtime publication gotcha does NOT apply and NO `docker restart
-- supabase_realtime_imr-inventory` step is needed after `npm run dev:db`
-- (mirrors the spec-107 / 109 header note). The staff Receiving screen uses no
-- realtime (spec 062 / AC-14).
--
-- ─── PROD-APPLY NOTES (owner-gated; db push lacks the prod password) ────────
-- Apply via MCP execute_sql against ebwnovzzkwhsdxkpyjka, then insert the exact
-- version 20260707000000 into supabase_migrations.schema_migrations, else the
-- db-migrations-applied gate goes red (project MEMORY). POST-APPLY, verify the
-- function carries the gate (a body-only change is INVISIBLE to the
-- migration-list drift gate — same caveat spec 104 / 107 / 109 documented):
--   select 1 from pg_proc where proname = 'receive_purchase_order'
--    and pg_get_functiondef(oid) like '%forbidden: price change requires admin%';
-- The developer FLAGS the prod-apply in the handoff; they do NOT push it.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- receive_purchase_order(p_po_id, p_lines, p_client_uuid) — spec 107 body +
-- the four spec-109 hunks (VERBATIM from 20260705000000_cost_on_receipt.sql:
-- 122-386) + the ONE spec-113 price-path privilege gate hunk (§3b, first
-- statement, before the `< 0` check).
--
-- Stock/status/idempotency logic is UNCHANGED from spec 107/109. A line WITHOUT
-- new_case_price behaves exactly as before (stock-only) — staff receives ride
-- this path untouched. A line WITH a non-null new_case_price now requires
-- auth_is_privileged(): a non-privileged caller is refused (42501) before any
-- write; a privileged caller flows the spec-109 cost path unchanged.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.receive_purchase_order(
  p_po_id       uuid,
  p_lines       jsonb,   -- [{ "po_item_id": uuid, "received_qty": numeric, "new_case_price"?: numeric }, ...]
  p_client_uuid uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_store_id       uuid;
  v_status         text;
  v_received_at    timestamptz;
  v_vendor_id      uuid;   -- spec 109: PO's vendor — the item_vendors link the receipt updates.
  v_existing       uuid;
  v_line           record;
  v_item_id        uuid;
  v_fully_received boolean;
  v_new_status     text;
  v_vendor_name    text;
  v_line_count     int;
  v_lines_out      jsonb;
  -- spec 109 (cost path) locals:
  v_case_qty          numeric;   -- catalog case_qty for the changed item (coalesced ≥ 1).
  v_sub_unit_size     numeric;   -- catalog sub_unit_size for the changed item (coalesced ≥ 1).
  v_item_name         text;      -- catalog name for the audit item_ref.
  v_old_case_price    numeric;   -- link's prior case_price (NULL when link missing).
  v_old_cost_per_unit numeric;   -- link's prior per-each cost (NULL when link missing).
  v_new_cost_per_unit numeric;   -- computed per-each = new_case_price / (case_qty × sub_unit_size).
  v_price_changes     jsonb := '[]'::jsonb;  -- spec 109 HUNK 4: additive envelope array.
begin
  -- (1) AUTH GATE — first statement. Resolve the PO's store, refuse if unseen.
  -- spec 109: ALSO select vendor_id (the link the cost writes target).
  select store_id, status, received_at, vendor_id
    into v_store_id, v_status, v_received_at, v_vendor_id
    from public.purchase_orders
   where id = p_po_id;

  if v_store_id is null then
    raise exception 'purchase order % not found', p_po_id using errcode = 'P0002';
  end if;
  if not public.auth_can_see_store(v_store_id) then
    raise exception 'Not authorized for store %', v_store_id using errcode = '42501';
  end if;

  -- (2) IDEMPOTENCY — if this client_uuid already landed on THIS PO, rebuild and
  -- return the SAME envelope (status + current per-line totals) WITHOUT
  -- re-incrementing stock. The durable per-line truth is po_items.received_qty.
  -- spec 109 HUNK 4: this replay path fires BEFORE the step-(3) loop where the
  -- cost writes live, so a retry re-applies NO cost change — it returns
  -- price_changes: [] (a replay changed nothing).
  if p_client_uuid is not null then
    select receive_client_uuid into v_existing
      from public.purchase_orders
     where id = p_po_id and receive_client_uuid = p_client_uuid;
    if found then
      select coalesce(jsonb_agg(
               jsonb_build_object('po_item_id', pit.id,
                                  'received_qty', coalesce(pit.received_qty, 0))
               order by pit.id), '[]'::jsonb)
        into v_lines_out
        from public.po_items pit
       where pit.po_id = p_po_id;
      return jsonb_build_object('po_id', p_po_id, 'status', v_status,
                                'conflict', true, 'lines', v_lines_out,
                                'price_changes', '[]'::jsonb);
    end if;
  end if;

  -- (3) APPLY each line: ADD received_qty (accumulates across partials) and
  -- increment inventory_items.current_stock by the SAME delta in COUNTED units.
  -- The FE submits "how much arrived in THIS receive" (pre-filled with the
  -- OUTSTANDING remainder ordered_qty − received_qty), NOT the ordered total —
  -- this is the only shape correct for the OQ-3 "remainder stays inbound → a
  -- later receive lands the rest" flow. The `and pit.po_id = p_po_id` guard
  -- rejects a cross-PO id.
  --
  -- spec 109 HUNK 1: the projection gains new_case_price. jsonb_to_recordset
  -- yields SQL NULL for an absent key OR explicit JSON null, so the
  -- disambiguator below is `new_case_price is not null`. A non-numeric JSON
  -- scalar raises 22P02 at this cast (before the loop body), aborting the call.
  for v_line in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(po_item_id uuid, received_qty numeric, new_case_price numeric)
  loop
    v_item_id := null;
    update public.po_items pit
       set received_qty = coalesce(pit.received_qty, 0) + v_line.received_qty
     where pit.id = v_line.po_item_id
       and pit.po_id = p_po_id
     returning pit.item_id into v_item_id;

    -- (3a) STOCK — unchanged spec-107 block. Independent of the cost path: a
    -- stock-only line (no new_case_price) does exactly this and nothing more.
    if v_item_id is not null and coalesce(v_line.received_qty, 0) <> 0 then
      update public.inventory_items ii
         set current_stock = coalesce(ii.current_stock, 0) + v_line.received_qty,
             updated_at    = now()
       where ii.id = v_item_id
         and ii.store_id = v_store_id;   -- store pin (defense-in-depth)
    end if;

    -- (3b) COST — spec 109 HUNK 2/3. Only when the line resolved to a real item
    -- AND a new case price was entered. A negative price is a malformed payload
    -- → hard-abort the whole call (P0001). Zero / absent / equal-to-current →
    -- no cost write, no audit row (the > 0 and distinct-from guards).
    if v_item_id is not null and v_line.new_case_price is not null then
      -- spec 113 GATE (R-1): the price path is admin-only, enforced server-side.
      -- A non-privileged caller who reaches a priced line — even via a
      -- hand-crafted RPC call — is refused for the WHOLE call BEFORE any write
      -- or idempotency stamp (the raise aborts the implicit transaction, rolling
      -- back the §3a stock write above). Refuse on PRESENCE (OQ-1), not on
      -- value, and BEFORE the `< 0` validation so a non-privileged caller gets
      -- the SAME refusal regardless of the price value (0, negative, equal, or
      -- different). auth_is_privileged() = admin OR super_admin (false for
      -- staff/user). auth_can_see_store already passed above (step 1); this is
      -- the SECOND, price-specific gate. String PINNED (house stable-string;
      -- pgTAP case f pins it byte-equal).
      if not public.auth_is_privileged() then
        raise exception 'forbidden: price change requires admin' using errcode = '42501';
      end if;

      if v_line.new_case_price < 0 then
        raise exception 'invalid new_case_price % for po_item %',
          v_line.new_case_price, v_line.po_item_id using errcode = 'P0001';
      end if;

      -- Resolve the packing divisor + item name via the catalog join. Both
      -- coalesce to ≥ 1, so the ★ divisor (case_qty × sub_unit_size) is ≥ 1 and
      -- never zero. (Mirrors the reorder RPCs' coalesce(ci.case_qty, 1) /
      -- coalesce(ci.sub_unit_size, 1) idiom — 20260704000000:829-830.)
      select coalesce(ci.case_qty, 1), coalesce(ci.sub_unit_size, 1), ci.name
        into v_case_qty, v_sub_unit_size, v_item_name
        from public.inventory_items ii
        join public.catalog_ingredients ci on ci.id = ii.catalog_id
       where ii.id = v_item_id;

      -- Read the link's CURRENT case_price to decide "did it change?" and to
      -- capture the OLD values for the audit BEFORE the upsert overwrites them.
      -- A missing link leaves both NULL → the change test's is-distinct-from
      -- treats NULL current as "changed", and the audit renders old as '—'.
      select iv.case_price, iv.cost_per_unit
        into v_old_case_price, v_old_cost_per_unit
        from public.item_vendors iv
       where iv.item_id = v_item_id
         and iv.vendor_id = v_vendor_id;

      -- The change test (design §2): a real, positive, DIFFERENT price. A 0
      -- fails `> 0` (treated as "no price entered"); an equal price fails
      -- `is distinct from` → no cost write, no audit row on EITHER table.
      if v_line.new_case_price > 0
         and v_line.new_case_price is distinct from v_old_case_price then

        v_new_cost_per_unit := v_line.new_case_price / (v_case_qty * v_sub_unit_size);

        -- Target 1 — the vendor link (item, po.vendor_id). UPSERT: INSERT a
        -- non-primary link when it's missing (the receipt is ground truth that
        -- the store bought this item from this vendor); else UPDATE the cost and
        -- leave is_primary untouched. Conflict target is the (item_id, vendor_id)
        -- composite unique (item_vendors_item_vendor_unique, 20260630000000:73).
        insert into public.item_vendors (item_id, vendor_id, case_price, cost_per_unit, is_primary)
        values (v_item_id, v_vendor_id, v_line.new_case_price, v_new_cost_per_unit, false)
        on conflict (item_id, vendor_id) do update
           set case_price    = excluded.case_price,
               cost_per_unit = excluded.cost_per_unit,
               updated_at    = now();

        -- Target 2 — the item scalar (ALWAYS, no is_primary gate — OQ-1). Same
        -- ★ divisor as Target 1, so the link's per-each and the item's per-each
        -- AGREE when packing is identical. Store pin mirrors the stock write.
        update public.inventory_items ii
           set case_price    = v_line.new_case_price,
               cost_per_unit = v_new_cost_per_unit,
               updated_at    = now()
         where ii.id = v_item_id
           and ii.store_id = v_store_id;

        -- (3c) AUDIT — spec 109 HUNK 3. One row PER CHANGED LINE, distinct
        -- action 'PO price change'. detail carries old→new CASE price (the
        -- invoice basis the operator entered); value carries old→new PER-EACH
        -- cost (the derived headline). Both directions of the ★ bridge are in
        -- the trail. Old values render '—' on a link-missing INSERT. user_id =
        -- auth.uid() (INVOKER → real caller, spoof-proof). Vendor name is
        -- resolved lazily below on the first change (see the `if v_vendor_name
        -- is null` fetch — the per-call 'PO received' row also uses it).
        if v_vendor_name is null then
          select v.name into v_vendor_name
            from public.purchase_orders po
            join public.vendors v on v.id = po.vendor_id
           where po.id = p_po_id;
        end if;

        insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
        values (
          v_store_id,
          auth.uid(),
          'PO price change',
          'PO ' || left(p_po_id::text, 8) || ' · ' || coalesce(v_vendor_name, '—')
                || ' · case ' || coalesce(v_old_case_price::text, '—')
                || ' → ' || v_line.new_case_price::text,
          coalesce(v_item_name, ''),
          'each ' || coalesce(v_old_cost_per_unit::text, '—')
                || ' → ' || v_new_cost_per_unit::text
        );

        -- (3d) ENVELOPE — spec 109 HUNK 4. Accumulate this change. old_* fields
        -- are JSON null on a link-missing INSERT; new_* are always concrete.
        v_price_changes := v_price_changes || jsonb_build_object(
          'po_item_id',        v_line.po_item_id,
          'item_id',           v_item_id,
          'old_case_price',    v_old_case_price,
          'new_case_price',    v_line.new_case_price,
          'old_cost_per_unit', v_old_cost_per_unit,
          'new_cost_per_unit', v_new_cost_per_unit
        );
      end if;
    end if;
  end loop;

  -- (4) RECOMPUTE status from the lines. Fully received ⇔ every line's
  -- received_qty >= ordered_qty → 'received' + received_at stamped. Else
  -- 'partial' + received_at LEFT NULL (OQ-3: the NULL received_at is the
  -- canonical "still open" signal pending_po_qty keys on, so the remainder keeps
  -- counting). received_by is stamped to the last receiver either way (who
  -- touched it last); the FE only surfaces received_by when received_at is set.
  select bool_and(coalesce(received_qty, 0) >= coalesce(ordered_qty, 0))
    into v_fully_received
    from public.po_items
   where po_id = p_po_id;

  -- receive_client_uuid records THIS receive's idempotency key. Design §3 prose
  -- specifies "each receive event supersedes … overwrites the column" (the con
  -- column in the Option-A table): across MULTIPLE sequential partial receives,
  -- each must be dedupable against ITS OWN retry, so the column must hold the
  -- LATEST receive's uuid, not the first. `coalesce(p_client_uuid,
  -- receive_client_uuid)` overwrites with the new key when one is supplied and
  -- preserves the prior key only when this call is non-idempotent (NULL uuid).
  update public.purchase_orders
     set status              = case when v_fully_received then 'received' else 'partial' end,
         received_at         = case when v_fully_received then now() else null end,
         received_by         = auth.uid(),
         receive_client_uuid = coalesce(p_client_uuid, receive_client_uuid)
   where id = p_po_id
   returning status into v_new_status;

  -- (5) AUDIT row (one per call). user_id = auth.uid() (INVOKER → the real
  -- caller, spoof-proof). Vendor name is best-effort for the item_ref column.
  -- spec 109: v_vendor_name may already be resolved by the first cost change
  -- above; only fetch if still null (avoids a redundant lookup).
  if v_vendor_name is null then
    select v.name into v_vendor_name
      from public.purchase_orders po
      join public.vendors v on v.id = po.vendor_id
     where po.id = p_po_id;
  end if;

  select count(*) into v_line_count
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(po_item_id uuid, received_qty numeric, new_case_price numeric);

  insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
  values (v_store_id, auth.uid(), 'PO received',
          'PO ' || left(p_po_id::text, 8) || ' · ' || v_new_status,
          v_vendor_name, v_line_count::text || ' line(s)');

  -- (6) RETURN envelope — current cumulative per-line received totals + spec-109
  -- price_changes (HUNK 4; [] when no line changed price).
  select coalesce(jsonb_agg(
           jsonb_build_object('po_item_id', pit.id,
                              'received_qty', coalesce(pit.received_qty, 0))
           order by pit.id), '[]'::jsonb)
    into v_lines_out
    from public.po_items pit
   where pit.po_id = p_po_id;

  return jsonb_build_object('po_id', p_po_id, 'status', v_new_status,
                            'conflict', false, 'lines', v_lines_out,
                            'price_changes', v_price_changes);
end;
$$;

-- No grant/revoke re-emit: signature unchanged, `create or replace` preserves
-- the spec-107 ACL (revoke from public, anon; grant execute to authenticated).

comment on function public.receive_purchase_order(uuid, jsonb, uuid) is
  'Spec 107 + 109 + 113: receive delivered stock against a PO, optionally re-pricing.
   Stock path (spec 107, UNCHANGED): received_qty accumulates ADDITIVELY across
   partial receives and current_stock increments by the same COUNTED-unit delta;
   idempotent on p_client_uuid (a repeat returns the prior envelope with
   conflict:true, no double-apply); fully received ⇒ received + received_at
   stamped, short ⇒ partial + received_at NULL. Cost path (spec 109 OQ-1
   AGGRESSIVE): a line whose optional new_case_price differs from the link''s
   current case_price updates BOTH the item_vendors (item, po.vendor_id) link AND
   inventory_items — case_price + per-each cost_per_unit via the ★ formula
   case_price / (case_qty × sub_unit_size) — regardless of is_primary, and writes
   one PO-price-change audit row per changed line (old→new case + per-each). A
   missing link is INSERTed (is_primary=false). new_case_price < 0 aborts the call
   (P0001); = 0 / absent / equal is a no-op. catalog_ingredients.default_cost is
   NEVER written (OQ-2). Spec 113 PRICE GATE (R-1): the cost path is admin-only,
   enforced server-side — a non-privileged caller (auth_is_privileged() false)
   who sends a non-null new_case_price on ANY line is refused for the WHOLE call
   with SQLSTATE 42501 ''forbidden: price change requires admin'' BEFORE any write
   or idempotency stamp (nothing durable; the raise rolls back the implicit
   transaction). The gate keys on the PRESENCE of new_case_price, not its value.
   The stock path is UNCHANGED for store members (staff receive stock-only). A
   privileged caller''s price path is UNCHANGED (spec 109 regression). Returns
   { po_id, status, conflict, lines[], price_changes[] }. SECURITY INVOKER +
   auth_can_see_store gate (fires before any write).';

commit;
