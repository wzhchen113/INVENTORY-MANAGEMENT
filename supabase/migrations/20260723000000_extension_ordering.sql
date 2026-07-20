-- ============================================================
-- Spec 131 (D-2/D-3) — Expose a pending-PO order payload for the browser-
-- extension cart-filler (BJ's / Sam's Club), spec 132 being the consumer.
--
-- THREE additive columns + TWO SECURITY INVOKER read RPCs. No delivery arm
-- (push/email/Resend/escapeHtml/delivery edge function) — that was CUT by the
-- owner this session. This migration builds nothing that logs into, fetches, or
-- submits on a vendor site (AC-7): the RPCs read ONLY I.M.R data.
--
-- FILENAME NOTE (developer, spec 131 build): the architect's design named this
-- migration `20260720000000_extension_ordering.sql` and asserted the latest
-- on-disk slot was `20260719000000_auto_receive_due_purchase_orders.sql`. The
-- tree has since moved on — `20260720000000` is already taken by
-- `20260720000000_staff_reports_issue_notifications.sql` and the latest on disk
-- is `20260722000000_ingredient_changed_badge.sql`. To honor the design's clear
-- intent ("verified next free slot", additive migration) without a filename
-- collision, this migration takes the next actually-free slot `20260723000000`.
-- The column/RPC contents are UNCHANGED from the design. Flagged for reviewers.
--
-- This whole migration is PURELY ADDITIVE and NON-DESTRUCTIVE: three columns and
-- two `create or replace function`s. NO backfill, NO change to any existing
-- column, NO policy change, NO publication change, NO drop. All DDL is
-- metadata-only / instant on Postgres 17.
--
-- COLUMNS
--   1. public.vendors.extension_ordering  boolean NOT NULL DEFAULT false (AC-1)
--        The per-vendor opt-in flag. Default OFF → zero behavior change for
--        existing vendors; the owner flips it ON for the BJ's / Sam's vendors.
--        `add column … not null default <constant>` is metadata-only on PG 17
--        (the stored default is recorded once; existing rows are not rewritten).
--   2. public.vendors.order_page_url       text (nullable) (AC-2)
--        BJ's landing / Sam's "Reorder for Pickup using a List" page. Also
--        carries the vendor↔site-origin join spec 132 needs (the extension
--        matches the tab origin to new URL(order_page_url).origin).
--   3. public.item_vendors.product_page_url text (nullable) (spec 132 OQ-2)
--        Per-(item, vendor) direct product-page link — the extension PREFERS a
--        non-null value (direct navigate) and FALLS BACK to per-vendor search
--        when null. Nullable, no backfill.
--
-- RLS INHERITANCE (all three columns — ZERO policy change):
--   • vendors.extension_ordering / order_page_url inherit the privileged vendors
--     policies verbatim (spec 115 §0): brand_member_read_vendors (SELECT,
--     auth_can_see_brand), privileged_update_vendors (UPDATE, auth_is_privileged()
--     AND auth_can_see_brand, USING + WITH CHECK), privileged_insert_vendors /
--     privileged_delete_vendors. Row-level policies are column-agnostic → a
--     non-privileged member CANNOT set either column the instant it exists.
--   • item_vendors.product_page_url inherits the four store_member_*_item_vendors
--     policies (20260630000000_item_vendors.sql:121-142) — auth_can_see_store(
--     ii.store_id) via the item_id → inventory_items.store_id parent join.
--     Column-agnostic → gated the instant it exists.
--   • Grants — table-level grants extend to every column (spec-097 explicit-grant
--     migration); no grant hunk, no leak.
--   • spec-053 permissive-policy lint — no policy added → no allowlist edit.
--
-- REALTIME PUBLICATION GOTCHA — DELIBERATE ABSENCE. No migration changes the
-- supabase_realtime publication membership (public.vendors and
-- public.item_vendors are both ALREADY published). So the
-- `docker restart supabase_realtime_imr-inventory` step does NOT apply here.
-- Flagged so the deploy checklist is not padded with a no-op restart.
--
-- RPCs (OQ-1 → a SECURITY INVOKER read-RPC PAIR, NOT a scoped PostgREST embed):
--   • get_pending_extension_orders(p_vendor_id uuid default null) → jsonb array.
--       "Pending" (AC-3) = purchase_orders.status = 'draft' AND
--       vendors.extension_ordering. INVOKER RLS bounds every read to
--       auth_can_see_store / auth_can_see_brand visible rows. p_vendor_id NULL →
--       all opted-in vendors' pending POs. Never errors; empty set → [].
--   • get_extension_order_payload(p_po_id uuid) → jsonb. One PO's full structured
--       lines (AC-4). Explicit store gate (P0002 not-found / RLS-hidden; 42501
--       store not visible), mirroring receive_purchase_order §3. Each line carries
--       orderCode (item_vendors.order_code, NULL when unmapped — NEVER dropped),
--       orderedQty (COUNTED units, verbatim po_items.ordered_qty — NOT
--       case-converted here; the shared builder src/utils/poQuickOrderText.ts
--       does the spec-115 ceil-to-cases at the extension entry point, D-1),
--       caseQty (catalog_ingredients.case_qty), productPageUrl.
--   Both are SECURITY INVOKER + set search_path = public (matching the reorder /
--   receive_purchase_order RPCs, NOT the staff DEFINER RPCs). GRANT execute to
--   authenticated; REVOKE from public, anon (mirror the reorder RPCs). NOT a
--   staff-* / service-token / pwa-catalog surface.
--
-- MARK-ORDERED WRITE-BACK (AC-6, OQ-2 → status draft→'sent'): NO new column, NO
-- new RPC. The existing guarded PostgREST UPDATE (db.ts markPurchaseOrderSent:
-- `update purchase_orders set status='sent' where id=:id`) IS the mark-ordered
-- write; the `and status='draft'` guard the extension uses makes it idempotent
-- and store-scoped via store_member_update_purchase_orders. Nothing to add here.
-- The spec-120 po notification fires on the draft→sent transition (ruled
-- DESIRABLE, D-4) and its trigger already guards `old.status is distinct from
-- 'sent'` (20260715000000_submission_notifications.sql:256), so a re-mark emits
-- no duplicate. CONFIRMED at build time — no trigger change needed.
--
-- PROD-APPLY (spec 064 gate — Supabase MCP, `db push` lacks the prod password):
--   1. execute_sql this whole migration body (columns + both functions + grants).
--   2. INSERT the exact version '20260723000000' into
--      supabase_migrations.schema_migrations so db-migrations-applied.yml stays
--      green.
--   3. VERIFY the columns by PRESENCE:
--        select 1 from information_schema.columns
--         where table_schema='public' and table_name='vendors'
--           and column_name in ('extension_ordering','order_page_url');
--        select 1 from information_schema.columns
--         where table_schema='public' and table_name='item_vendors'
--           and column_name='product_page_url';
--      and VERIFY the two RPCs by NORMALIZED-MD5 of the function body (they are
--      CREATE-OR-REPLACE FUNCTION — the md5 path applies here, unlike a bare
--      column add). The developer FLAGS this prod-apply in the handoff and does
--      NOT push it themselves; db-migrations-applied.yml goes red until the
--      schema_migrations row lands (expected, resolves on apply).
-- ============================================================

begin;

-- ─── Column 1: vendors.extension_ordering (AC-1, OQ-4) ─────────────────────
alter table public.vendors
  add column if not exists extension_ordering boolean not null default false;

comment on column public.vendors.extension_ordering is
  'spec 131 (AC-1): per-vendor opt-in for the browser-extension cart-filler '
  '(spec 132). true → this vendor''s draft POs are picked up by the extension as '
  '"pending orders"; false (default) → no behavior change. Brand-level (vendors '
  'is brand-scoped). Inherits the privileged vendors RLS column-agnostically '
  '(privileged_update_vendors — a non-privileged member cannot flip it).';

-- ─── Column 2: vendors.order_page_url (AC-2) ───────────────────────────────
alter table public.vendors
  add column if not exists order_page_url text;

comment on column public.vendors.order_page_url is
  'spec 131 (AC-2): the vendor''s order page URL — BJ''s landing / Sam''s '
  '"Reorder for Pickup using a List". Nullable (absent → the payload still '
  'exposes the PO, just without a page URL). Also carries the vendor↔site-origin '
  'join spec 132 needs: the extension matches the tab origin to '
  'new URL(order_page_url).origin. Inherits the vendors RLS unchanged.';

-- ─── Column 3: item_vendors.product_page_url (spec 132 OQ-2 fallback) ──────
alter table public.item_vendors
  add column if not exists product_page_url text;

comment on column public.item_vendors.product_page_url is
  'spec 131 (D-2): per-(item, vendor) direct product-page link — the extension '
  '(spec 132) PREFERS a non-null value (direct navigate) and FALLS BACK to '
  'per-vendor search when null. Free-form, nullable, no uniqueness. Inherits the '
  'four store_member_*_item_vendors RLS policies + spec-097 grants + realtime '
  'publication membership unchanged (column-agnostic).';

-- ─── RPC 1: get_pending_extension_orders (AC-3) ────────────────────────────
-- SECURITY INVOKER: the caller's RLS on purchase_orders / vendors bounds every
-- read to auth_can_see_store / auth_can_see_brand visible rows. "Pending" =
-- status='draft' AND vendors.extension_ordering. p_vendor_id NULL → all opted-in
-- vendors' pending POs; else filtered to that vendor. Never errors; empty → [].
create or replace function public.get_pending_extension_orders(
  p_vendor_id uuid default null
) returns jsonb
language sql
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(elem order by elem->>'poId'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'poId',         po.id,
      'storeId',      po.store_id,
      'vendorId',     po.vendor_id,
      'vendorName',   v.name,
      'orderPageUrl', v.order_page_url,
      'orderUnit',    v.order_unit,
      'lineCount',    (select count(*) from public.po_items pit where pit.po_id = po.id),
      'unmappedCount', (
        select count(*)
          from public.po_items pit
          left join public.item_vendors iv
            on iv.item_id = pit.item_id and iv.vendor_id = po.vendor_id
         where pit.po_id = po.id
           and (iv.order_code is null or btrim(iv.order_code) = '')
      )
    ) as elem
    from public.purchase_orders po
    join public.vendors v on v.id = po.vendor_id
    where po.status = 'draft'
      and v.extension_ordering
      and (p_vendor_id is null or po.vendor_id = p_vendor_id)
  ) s;
$$;

comment on function public.get_pending_extension_orders(uuid) is
  'spec 131 (D-3 RPC 1, AC-3): the pending PO set for the browser extension. '
  'Pending = status=''draft'' AND vendors.extension_ordering. SECURITY INVOKER — '
  'caller RLS bounds to auth_can_see_store / auth_can_see_brand. Returns a jsonb '
  'array of { poId, storeId, vendorId, vendorName, orderPageUrl, orderUnit, '
  'lineCount, unmappedCount }; [] when none. p_vendor_id NULL → all opted-in '
  'vendors.';

revoke all     on function public.get_pending_extension_orders(uuid) from public, anon;
grant  execute on function public.get_pending_extension_orders(uuid) to authenticated;

-- ─── RPC 2: get_extension_order_payload (AC-4) ─────────────────────────────
-- SECURITY INVOKER + an explicit store gate (belt-and-suspenders + clean error,
-- mirroring receive_purchase_order §3). Returns ONE PO's structured lines. Each
-- line carries the RAW orderedQty (COUNTED units, verbatim) + orderUnit/caseQty
-- so the SHARED builder (src/utils/poQuickOrderText.ts) does the spec-115
-- ceil-to-cases at the extension entry point — the RPC does NOT re-implement the
-- case math in SQL (D-1: no forked builder). A line whose item has no order_code
-- for this vendor returns orderCode:null + the itemName (AC-4 — surfaced, never
-- dropped).
create or replace function public.get_extension_order_payload(
  p_po_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_store_id  uuid;
  v_vendor_id uuid;
  v_result    jsonb;
begin
  -- (1) resolve store + vendor; raise P0002 if not found (RLS may hide it).
  select po.store_id, po.vendor_id
    into v_store_id, v_vendor_id
    from public.purchase_orders po
   where po.id = p_po_id;

  if v_store_id is null then
    raise exception 'purchase order % not found', p_po_id using errcode = 'P0002';
  end if;

  -- (2) explicit store gate (defense-in-depth + clean 42501).
  if not public.auth_can_see_store(v_store_id) then
    raise exception 'Not authorized for store %', v_store_id using errcode = '42501';
  end if;

  -- (3) assemble the structured payload.
  select jsonb_build_object(
    'poId',         po.id,
    'storeId',      po.store_id,
    'vendorId',     po.vendor_id,
    'vendorName',   v.name,
    'orderPageUrl', v.order_page_url,
    'orderUnit',    v.order_unit,
    'lines', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'itemId',         pit.item_id,
          'itemName',       coalesce(ci.name, ''),
          'orderCode',      nullif(btrim(iv.order_code), ''),
          'orderedQty',     pit.ordered_qty,
          'caseQty',        coalesce(ci.case_qty, 1),
          'productPageUrl', iv.product_page_url
        )
        order by pit.id
      )
      from public.po_items pit
      left join public.inventory_items    ii on ii.id = pit.item_id
      left join public.catalog_ingredients ci on ci.id = ii.catalog_id
      left join public.item_vendors        iv on iv.item_id = pit.item_id
                                             and iv.vendor_id = po.vendor_id
      where pit.po_id = po.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.purchase_orders po
  join public.vendors v on v.id = po.vendor_id
  where po.id = p_po_id;

  return v_result;
end;
$$;

comment on function public.get_extension_order_payload(uuid) is
  'spec 131 (D-3 RPC 2, AC-4): one pending PO''s structured order payload for the '
  'browser extension. SECURITY INVOKER + explicit auth_can_see_store gate (P0002 '
  'not-found / RLS-hidden, 42501 store not visible). Returns { poId, storeId, '
  'vendorId, vendorName, orderPageUrl, orderUnit, lines: [{ itemId, itemName, '
  'orderCode /* null when unmapped — never dropped */, orderedQty /* COUNTED '
  'units, verbatim; the shared builder ceils to cases at the extension */, '
  'caseQty, productPageUrl }] }.';

revoke all     on function public.get_extension_order_payload(uuid) from public, anon;
grant  execute on function public.get_extension_order_payload(uuid) to authenticated;

commit;
