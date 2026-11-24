-- supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql
--
-- Spec 207 — Recompute every store's cost when an item's pack size changes.
--
-- WHAT AND WHY
-- cost_per_unit is the per-each cost, case_price / (case_qty × sub_unit_size),
-- each factor counted as 1 when it is NULL, <= 0 or not finite (spec 104;
-- piecesPerCase in src/utils/perEachCost.ts). case_qty / sub_unit_size live on
-- the brand-wide catalog_ingredients row, but cost is stored per store in two
-- places (inventory_items.cost_per_unit and item_vendors.cost_per_unit) and was
-- only re-derived client-side, for the stores picked under "Save to", and never
-- for other stores' item_vendors links. A pack-size edit therefore left other
-- stores on the old pack size (prod repair of 2026-11-23, see the spec). This
-- migration moves the rule into the database so every writer follows it:
--
--   1. public.pieces_per_case(q, s)            — the single SQL piecesPerCase.
--   2. public.per_each_cost(price, q, s)       — round(price / pieces, 6) for
--                                                price > 0, else NULL.
--   3. R3 derive-on-write: BEFORE INSERT / UPDATE OF case_price,
--      cost_per_unit, catalog_id|item_id triggers on inventory_items and
--      item_vendors, WHEN (new.case_price > 0). A priced row always stores
--      per_each_cost(...) from its catalog row's current pack size; whatever
--      cost the writer sent is replaced. Unpriced rows keep the written cost.
--      Stock / par / EOD / vendor_id / is_primary updates never fire them.
--   4. R1: AFTER UPDATE OF case_qty, sub_unit_size on catalog_ingredients,
--      SECURITY DEFINER, re-derives every inventory_items row of that catalog
--      row at a store of the catalog's brand (every store of the brand) and
--      every item_vendors link of those rows. Priced
--      rows get per_each_cost; unpriced rows are scaled by old/new pieces
--      (OQ-2), so a cost of 0 / NULL stays as it is.
--   5. public.list_cost_drift(): read-only, privileged-only drift listing
--      (OQ-3), meant to be run on prod on demand.
--   6. receive_purchase_order re-CREATE with one changed line plus one NOTE
--      comment (D-6).
--
-- No table, column, index, policy or publication change. No backfill: creating
-- the triggers rewrites no existing row; rows converge on their next write.
--
-- R1 / R3 ORDERING (design D-4)
-- R1 is an AFTER ROW trigger, so by the time its child UPDATEs run the catalog
-- UPDATE is visible and R3 (which fires inside those child UPDATEs because
-- cost_per_unit is in their SET list) reads the NEW case_qty / sub_unit_size.
-- (A BEFORE trigger would let R3 read the old pack size and undo R1.)
--   * Priced rows: R1 writes per_each_cost(price, new q, new s); R3 recomputes
--     the identical value from the catalog row it reads. Byte-identical, so
--     their order does not matter and R3 (last) is authoritative.
--   * Unpriced rows: R1 writes the OQ-2 scaled value; R3's WHEN
--     (new.case_price > 0) is false, so R3 is never invoked for that row and
--     the scaled value survives. Structural, no session flag.
-- R3's triggers are named zz_* so they fire after every other BEFORE trigger
-- (inventory_items_identity_lock_trg still fires first, spec 179) and see the
-- final NEW. R3 never raises, so on INSERT RLS / FK errors still win (spec
-- 179 T72).
--
-- SECURITY
-- * R3 functions are SECURITY INVOKER with search_path ''. Their catalog lookup
--   runs under the caller's RLS, so an invisible (cross-brand) catalog row reads
--   as "not found" (pieces 1) and cannot be probed through RETURNING.
-- * R1 is SECURITY DEFINER (owner postgres, no FORCE RLS on the three tables)
--   so it reaches every store of the brand. It writes only rows keyed to
--   catalog_id = new.id AT A STORE OF THE CATALOG'S BRAND
--   (stores.brand_id = new.brand_id), after the caller passed
--   privileged_update_catalog_ingredients for that row, and only
--   cost_per_unit (plus item_vendors.updated_at). The brand predicate keeps
--   the DEFINER write inside the actor's brand: a row at another brand's store
--   that points at this catalog row (possible today, FU-3) is never touched, so
--   it can neither be rewritten by this brand nor block this brand's pack-size
--   edit (e.g. an unpriced cost whose OQ-2 scaling would overflow
--   numeric(12,6)). Spec 207 security review, Medium.
-- * The helpers are pure arithmetic, executable by anon / authenticated /
--   service_role (R3 calls them as the writing role, before RLS WITH CHECK).
-- * Trigger functions: EXECUTE revoked from public, anon, authenticated.
-- * list_cost_drift is SECURITY INVOKER (store scoping via the spec 205 read
--   policies) and refuses anon (grant) and non-privileged authenticated callers
--   (42501 'privileged only'). A JWT-less postgres session (MCP / SQL editor)
--   is admitted and sees everything.
--
-- REALTIME
-- No publication change: catalog_ingredients, inventory_items and item_vendors
-- are already in supabase_realtime, so NO `docker restart
-- supabase_realtime_imr-inventory` is needed. Behavior change: one pack-size
-- edit emits one inventory_items UPDATE per affected store plus one
-- item_vendors UPDATE per changed link (absorbed by the spec 206 single-flight
-- reload).
--
-- receive_purchase_order SOURCE DISCIPLINE
-- The body below is copied VERBATIM from its latest on-disk definition,
--     20260707000000_staff_receiving_price_gate.sql:114-393
-- with one changed line plus one NOTE comment. The changed line (the §3b
-- per-each computation):
--   - v_new_cost_per_unit := v_line.new_case_price / (v_case_qty * v_sub_unit_size);
--   + v_new_cost_per_unit := public.per_each_cost(v_line.new_case_price, v_case_qty, v_sub_unit_size);
-- The in-body comments copied verbatim from 20260707000000 still describe the
-- old divisor (e.g. "Both coalesce to ≥ 1, so the ★ divisor … is ≥ 1 and never
-- zero", false for case_qty = 0). They are kept byte-identical so the diff
-- stays one line; a single added `-- NOTE (spec 207)` comment next to that
-- block records that per_each_cost now guards factors <= 0 and rounds to 6 dp.
-- so the envelope's price_changes[].new_cost_per_unit, the audit value and both
-- stored columns carry the identical 6 dp value, and a case_qty = 0 catalog row
-- no longer divides by zero. Signature unchanged, so `create or replace`
-- preserves the ACL and the comment on function; no grant / revoke /
-- comment re-emit. Diff against 20260707000000:114-393 to verify (expect the
-- changed line and the added NOTE comment line, nothing else).
--
-- PROD APPLY (owner-gated; spec 207 D-11 runbook)
-- db push lacks the prod password. Run the read-only pre-checks in D-11 step 1
-- (including the inline drift baseline, which must be 0), then execute_sql this
-- file verbatim with `insert into supabase_migrations.schema_migrations
-- (version, name) values ('20261123130000', 'recompute_costs_on_pack_size_change');`
-- placed just before the final `commit;`, then verify per D-11 step 3 and
-- record `select kind, count(*) from public.list_cost_drift() group by kind;`
-- (AC-13). The developer does not apply this to prod.
--
-- UNDO-FILE CAVEAT: after this migration, an undo of the 2026-11-23 repair
-- (`update … set cost_per_unit = <old> …` on a priced row) is silently
-- overridden by R3. Run any such undo with the table's
-- zz_derive_cost_per_unit_trg disabled inside the same transaction.
--
-- BACKOUT (documented, not auto-applied; the migration writes no data):
--   begin;
--   drop trigger if exists catalog_ingredients_rederive_item_costs_trg on public.catalog_ingredients;
--   drop trigger if exists zz_derive_cost_per_unit_trg on public.inventory_items;
--   drop trigger if exists zz_derive_cost_per_unit_trg on public.item_vendors;
--   -- re-run the receive_purchase_order body from 20260707000000:114-393
--   drop function if exists public.list_cost_drift();
--   drop function if exists public.catalog_ingredients_rederive_item_costs();
--   drop function if exists public.inventory_items_derive_cost();
--   drop function if exists public.item_vendors_derive_cost();
--   drop function if exists public.per_each_cost(numeric, numeric, numeric);
--   drop function if exists public.pieces_per_case(numeric, numeric);
--   commit;

begin;

set local lock_timeout = '5s';

-- ═══ 1. helpers (R2) ═══════════════════════════════════════════════════════

-- The single SQL source of piecesPerCase (src/utils/perEachCost.ts). Each factor
-- is kept only when > 0 and < 'Infinity' (mirrors Number.isFinite: Postgres
-- sorts both Infinity and NaN above every finite value, so one bound rejects
-- both); NULL fails `> 0` and falls to 1.
create or replace function public.pieces_per_case(
  p_case_qty      numeric,
  p_sub_unit_size numeric
) returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select (case when p_case_qty > 0 and p_case_qty < 'Infinity'::numeric
               then p_case_qty else 1::numeric end)
       * (case when p_sub_unit_size > 0 and p_sub_unit_size < 'Infinity'::numeric
               then p_sub_unit_size else 1::numeric end);
$$;

-- The R2 priced rule. NULL for an unpriced input (case_price NULL or <= 0);
-- callers decide what an unpriced row gets.
create or replace function public.per_each_cost(
  p_case_price    numeric,
  p_case_qty      numeric,
  p_sub_unit_size numeric
) returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p_case_price > 0
              then round(p_case_price / public.pieces_per_case(p_case_qty, p_sub_unit_size), 6)
         end;
$$;

-- ═══ 2. R3: derive on write ═════════════════════════════════════════════════

create or replace function public.inventory_items_derive_cost()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case_qty      numeric;
  v_sub_unit_size numeric;
begin
  -- Not STRICT: no visible catalog row leaves both NULL → pieces 1. Never raises.
  select ci.case_qty, ci.sub_unit_size
    into v_case_qty, v_sub_unit_size
    from public.catalog_ingredients ci
   where ci.id = new.catalog_id;

  new.cost_per_unit := public.per_each_cost(new.case_price, v_case_qty, v_sub_unit_size);
  return new;
end;
$$;

drop trigger if exists zz_derive_cost_per_unit_trg on public.inventory_items;
create trigger zz_derive_cost_per_unit_trg
  before insert or update of case_price, cost_per_unit, catalog_id
  on public.inventory_items
  for each row when (new.case_price > 0)
  execute function public.inventory_items_derive_cost();

create or replace function public.item_vendors_derive_cost()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case_qty      numeric;
  v_sub_unit_size numeric;
begin
  -- Not STRICT: no visible item / catalog row leaves both NULL → pieces 1.
  -- Never raises.
  select ci.case_qty, ci.sub_unit_size
    into v_case_qty, v_sub_unit_size
    from public.inventory_items ii
    join public.catalog_ingredients ci on ci.id = ii.catalog_id
   where ii.id = new.item_id;

  new.cost_per_unit := public.per_each_cost(new.case_price, v_case_qty, v_sub_unit_size);
  return new;
end;
$$;

drop trigger if exists zz_derive_cost_per_unit_trg on public.item_vendors;
create trigger zz_derive_cost_per_unit_trg
  before insert or update of case_price, cost_per_unit, item_id
  on public.item_vendors
  for each row when (new.case_price > 0)
  execute function public.item_vendors_derive_cost();

-- ═══ 3. R1: re-derive on a pack-size change ═════════════════════════════════

create or replace function public.catalog_ingredients_rederive_item_costs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old numeric := public.pieces_per_case(old.case_qty, old.sub_unit_size);
  v_new numeric := public.pieces_per_case(new.case_qty, new.sub_unit_size);
begin
  -- AC-5: effective pieces unchanged (resend, swap, 0/NULL ↔ 1) → no write.
  if v_old = v_new then
    return null;
  end if;

  -- (a) inventory_items, every store of the catalog's brand with this catalog
  -- row (a row at another brand's store is never touched). updated_at is
  -- bumped by inventory_items_updated_at. Priced rows also pass through R3,
  -- which computes the identical value from the (already updated) catalog row.
  update public.inventory_items ii
     set cost_per_unit =
           case when ii.case_price > 0
                then public.per_each_cost(ii.case_price, new.case_qty, new.sub_unit_size)
                else round(ii.cost_per_unit * v_old / v_new, 6)
           end
   where ii.catalog_id = new.id
     and exists (select 1 from public.stores s
                  where s.id = ii.store_id and s.brand_id = new.brand_id)
     and ii.cost_per_unit is distinct from
           case when ii.case_price > 0
                then public.per_each_cost(ii.case_price, new.case_qty, new.sub_unit_size)
                else round(ii.cost_per_unit * v_old / v_new, 6)
           end;

  -- (b) item_vendors, every link of those rows, each with its OWN case_price.
  -- item_vendors has no updated_at trigger, so stamp it here (mirrors
  -- receiving).
  update public.item_vendors iv
     set cost_per_unit =
           case when iv.case_price > 0
                then public.per_each_cost(iv.case_price, new.case_qty, new.sub_unit_size)
                else round(iv.cost_per_unit * v_old / v_new, 6)
           end,
         updated_at = now()
    from public.inventory_items ii
   where iv.item_id = ii.id
     and ii.catalog_id = new.id
     and exists (select 1 from public.stores s
                  where s.id = ii.store_id and s.brand_id = new.brand_id)
     and iv.cost_per_unit is distinct from
           case when iv.case_price > 0
                then public.per_each_cost(iv.case_price, new.case_qty, new.sub_unit_size)
                else round(iv.cost_per_unit * v_old / v_new, 6)
           end;

  return null;
end;
$$;

drop trigger if exists catalog_ingredients_rederive_item_costs_trg on public.catalog_ingredients;
create trigger catalog_ingredients_rederive_item_costs_trg
  after update of case_qty, sub_unit_size on public.catalog_ingredients
  for each row
  execute function public.catalog_ingredients_rederive_item_costs();

-- ═══ 4. R4: drift listing ═══════════════════════════════════════════════════

create or replace function public.list_cost_drift()
returns table (
  kind          text,
  source_table  text,
  row_id        uuid,
  store_id      uuid,
  store_name    text,
  item_name     text,
  case_price    numeric,
  case_qty      numeric,
  sub_unit_size numeric,
  stored_cost   numeric,
  derived_cost  numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- PostgREST callers must be privileged. A JWT-less postgres session (MCP /
  -- SQL editor, the function's main caller) is admitted. Store scoping is the
  -- spec 205 read policies' job (INVOKER), not this function's.
  if current_user in ('anon', 'authenticated') and not public.auth_is_privileged() then
    raise exception 'privileged only' using errcode = '42501';
  end if;

  return query
  select r.k, r.t, r.id, r.sid, r.sname, r.iname, r.price, r.q, r.s, r.stored, r.derived
    from (
      select case when ii.case_price > 0 then 'drift' else 'cost_without_case_price' end::text as k,
             'inventory_items'::text as t,
             ii.id                   as id,
             ii.store_id             as sid,
             st.name::text           as sname,
             ci.name::text           as iname,
             ii.case_price::numeric  as price,
             ci.case_qty::numeric    as q,
             ci.sub_unit_size::numeric as s,
             ii.cost_per_unit::numeric as stored,
             dc.d                    as derived
        from public.inventory_items ii
        join public.catalog_ingredients ci on ci.id = ii.catalog_id
        left join public.stores st on st.id = ii.store_id
        cross join lateral (
          select public.per_each_cost(ii.case_price, ci.case_qty, ci.sub_unit_size) as d
        ) dc
       where (ii.case_price > 0
              and abs(coalesce(ii.cost_per_unit, 0) - dc.d) > greatest(0.01, 0.02 * dc.d))
          or (coalesce(ii.case_price, 0) <= 0 and coalesce(ii.cost_per_unit, 0) > 0)
      union all
      select case when iv.case_price > 0 then 'drift' else 'cost_without_case_price' end::text,
             'item_vendors'::text,
             iv.id,
             ii.store_id,
             st.name::text,
             ci.name::text,
             iv.case_price::numeric,
             ci.case_qty::numeric,
             ci.sub_unit_size::numeric,
             iv.cost_per_unit::numeric,
             dc.d
        from public.item_vendors iv
        join public.inventory_items ii on ii.id = iv.item_id
        join public.catalog_ingredients ci on ci.id = ii.catalog_id
        left join public.stores st on st.id = ii.store_id
        cross join lateral (
          select public.per_each_cost(iv.case_price, ci.case_qty, ci.sub_unit_size) as d
        ) dc
       where (iv.case_price > 0
              and abs(coalesce(iv.cost_per_unit, 0) - dc.d) > greatest(0.01, 0.02 * dc.d))
          or (coalesce(iv.case_price, 0) <= 0 and coalesce(iv.cost_per_unit, 0) > 0)
    ) r
   order by r.k, r.sname, r.iname, r.t;
end;
$$;

-- ═══ 5. receive_purchase_order (D-6: one changed line) ══════════════════════
-- VERBATIM from 20260707000000_staff_receiving_price_gate.sql:114-393 except
-- the single §3b `v_new_cost_per_unit :=` line (see header).

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
      -- NOTE (spec 207): superseded; per_each_cost guards <= 0 and rounds.
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

        v_new_cost_per_unit := public.per_each_cost(v_line.new_case_price, v_case_qty, v_sub_unit_size);

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

-- ═══ 6. grants and revokes ══════════════════════════════════════════════════

-- Helpers: pure arithmetic, read no data. anon keeps EXECUTE deliberately so an
-- anon priced INSERT still fails on RLS, not on "permission denied for function".
revoke all on function public.pieces_per_case(numeric, numeric) from public;
revoke all on function public.per_each_cost(numeric, numeric, numeric) from public;
grant execute on function public.pieces_per_case(numeric, numeric)
  to anon, authenticated, service_role;
grant execute on function public.per_each_cost(numeric, numeric, numeric)
  to anon, authenticated, service_role;

-- Trigger functions: never callable directly (EXECUTE on a trigger function is
-- checked only at CREATE TRIGGER time).
revoke all on function public.inventory_items_derive_cost()
  from public, anon, authenticated;
revoke all on function public.item_vendors_derive_cost()
  from public, anon, authenticated;
revoke all on function public.catalog_ingredients_rederive_item_costs()
  from public, anon, authenticated;

-- Drift listing: privileged callers via PostgREST, plus postgres (owner).
-- The revoke from anon matters: the public-schema default privileges grant
-- anon EXECUTE on every new function.
revoke all on function public.list_cost_drift() from public, anon;
grant execute on function public.list_cost_drift() to authenticated, service_role;

-- ═══ 7. comments ════════════════════════════════════════════════════════════

comment on function public.pieces_per_case(numeric, numeric) is
  'Spec 207 (R2): the SQL mirror of piecesPerCase (src/utils/perEachCost.ts). '
  'case_qty × sub_unit_size, each factor taken as 1 unless > 0 and finite. '
  'The single SQL source of the pieces count; do not inline '
  'coalesce(case_qty,1) * coalesce(sub_unit_size,1) elsewhere.';

comment on function public.per_each_cost(numeric, numeric, numeric) is
  'Spec 207 (R2): round(case_price / pieces_per_case(case_qty, sub_unit_size), 6) '
  'when case_price > 0, else NULL. Used by the R3 / R1 triggers, '
  'list_cost_drift and receive_purchase_order.';

comment on function public.inventory_items_derive_cost() is
  'Spec 207 (R3): BEFORE INSERT OR UPDATE OF case_price, cost_per_unit, catalog_id '
  'on public.inventory_items, WHEN (new.case_price > 0). Sets cost_per_unit to '
  'per_each_cost(case_price, catalog case_qty, catalog sub_unit_size). SECURITY '
  'INVOKER (catalog lookup under the caller''s RLS; not found → pieces 1). Never raises.';

comment on function public.item_vendors_derive_cost() is
  'Spec 207 (R3): BEFORE INSERT OR UPDATE OF case_price, cost_per_unit, item_id '
  'on public.item_vendors, WHEN (new.case_price > 0). Sets cost_per_unit from the '
  'link''s own case_price and its item''s catalog pack size. SECURITY INVOKER. '
  'Never raises.';

comment on function public.catalog_ingredients_rederive_item_costs() is
  'Spec 207 (R1): AFTER UPDATE OF case_qty, sub_unit_size on '
  'public.catalog_ingredients. When effective pieces change, re-derives '
  'cost_per_unit on every inventory_items row of the catalog row at a store of '
  'the catalog''s brand, and every item_vendors link of those rows: priced rows '
  '→ per_each_cost, '
  'unpriced rows → round(cost × old_pieces / new_pieces, 6) (OQ-2). Only rows '
  'whose cost changes are written. SECURITY DEFINER, search_path ''''.';

comment on function public.list_cost_drift() is
  'Spec 207 (R4, OQ-3): read-only listing of priced inventory_items / item_vendors '
  'rows whose cost_per_unit differs from per_each_cost by more than '
  'max(0.01, 2% of derived) (kind = drift), plus unpriced rows with a cost > 0 '
  '(kind = cost_without_case_price, informational). Refuses non-privileged '
  'PostgREST callers (42501 privileged only); store scoping via RLS (INVOKER). '
  'Run on prod on demand via MCP / SQL editor.';

commit;
