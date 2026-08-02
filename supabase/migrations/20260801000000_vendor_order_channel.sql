-- ============================================================
-- Spec 149 (§1.1) — per-vendor order CHANNEL + Instacart retailer key + the
-- store postal code the Instacart retailer-availability lookup needs.
--
-- STRICTLY ADDITIVE: three nullable columns, one CHECK constraint, one
-- SECURITY INVOKER helper function. No backfill, no data touched, no policy
-- change, no publication change, no drop. All DDL is metadata-only on PG 17.
--
-- FIRST of a hard dependency chain (§10.4):
--   20260801000000_vendor_order_channel   ← this file (vendor_order_channel())
--   20260801000100_order_approvals        ← calls vendor_order_channel()
--   20260801000200_order_ready_notification_type ← calls both
-- Applying out of order fails loudly ("function does not exist"); there is no
-- silent half-state.
--
-- REALTIME PUBLICATION — DELIBERATE ABSENCE (spec 149 R-5). No migration in
-- this spec changes supabase_realtime publication membership (public.vendors
-- and public.stores are both already published; a new COLUMN on a published
-- table is not a membership change). So the
-- `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
-- Flagged so the deploy checklist is not padded with a no-op restart.
--
-- RLS INHERITANCE — ZERO policy change (§2):
--   • vendors.order_channel / vendors.instacart_retailer_key inherit the
--     privileged vendors policies verbatim: brand_member_read_vendors (SELECT),
--     privileged_update_vendors / privileged_insert_vendors /
--     privileged_delete_vendors. Row-level policies are column-agnostic → a
--     non-privileged brand member CANNOT set either column the instant it
--     exists.
--   • stores.postal_code inherits the existing stores policies (incl. the
--     spec-051 rewritten ones).
--   • Grants ride the spec-097 explicit table-level grants
--     (20260618000000_public_grants_explicit.sql) — table grants extend to
--     every column, so there is no grant hunk and no leak.
--   • spec-053 permissive_policy_lint — no policy added → NO allowlist edit.
--
-- PROD-APPLY (spec 064 gate — `db push` lacks the prod password, project
-- MEMORY): execute_sql this body via the Supabase MCP, INSERT the exact
-- version '20260801000000' into supabase_migrations.schema_migrations, then
-- VERIFY the three columns by PRESENCE (information_schema.columns) and
-- vendor_order_channel by NORMALIZED-MD5. db-migrations-applied.yml goes red
-- between commit and prod-apply — expected, flag it, do not "fix" it.
--
-- Design authority: specs/149-eod-approve-order-pipeline.md "## Backend design"
-- §1.1 (+ R-3 precedence, AC-14).
-- ============================================================

begin;

-- ─── Column 1: vendors.order_channel (AC-14) ───────────────────────────────
alter table public.vendors
  add column if not exists order_channel text;

-- Drop-then-re-add so the migration is re-runnable (ADD CONSTRAINT has no
-- IF NOT EXISTS). Mirrors the spec-121/126 notifications_type_check pattern.
alter table public.vendors
  drop constraint if exists vendors_order_channel_check;

alter table public.vendors
  add constraint vendors_order_channel_check
  check (order_channel is null
         or order_channel in ('instacart','webstaurant','extension','manual'));

comment on column public.vendors.order_channel is
  'spec 149 (AC-14): the vendor''s declared APPROVE & ORDER destination — one of '
  '''instacart'' | ''webstaurant'' | ''extension'' | ''manual'', or NULL (undeclared). '
  'This column is DECLARATIVE ONLY; the RESOLVED channel is '
  'public.vendor_order_channel(vendor_id), which applies the R-3 precedence so '
  'this column can never contradict the specs-131/132 vendors.extension_ordering '
  'flag. Inherits the privileged vendors RLS column-agnostically.';

-- ─── Column 2: vendors.instacart_retailer_key (AC-14 / OQ-2) ───────────────
alter table public.vendors
  add column if not exists instacart_retailer_key text;

comment on column public.vendors.instacart_retailer_key is
  'spec 149 (AC-14 / OQ-2): the Instacart Developer Platform retailer_key slug '
  'for this vendor (as returned by GET /idp/v1/retailers?postal_code=…). '
  'Nullable. A NULL/blank key means the ''instacart'' channel CANNOT win the R-3 '
  'precedence — the vendor falls back to ''extension'' when extension_ordering is '
  'true, which is why BJ''s / Sam''s stay on the live-tuned cart-filler until an '
  'operator verifies a key resolves for the store''s real ZIP (spec 149 §10.2).';

-- ─── Column 3: stores.postal_code (OQ-2) ───────────────────────────────────
-- stores.address is free text and is deliberately NOT parsed; a dedicated
-- column is the ZIP source for the IDP retailer-availability lookup. NULL ⇒
-- the Instacart channel is unavailable for that store and the mint short-
-- circuits to 409 retailer_unavailable (spec 149 R-4 / §5.5 step 1).
alter table public.stores
  add column if not exists postal_code text;

comment on column public.stores.postal_code is
  'spec 149 (OQ-2): the store''s postal code (ZIP), used server-side by the '
  'instacart-cart-link edge function for the IDP retailer-availability lookup. '
  'Nullable — NULL means the Instacart channel is unavailable for this store and '
  'the mint returns 409 retailer_unavailable with a fallbackChannel. Never '
  'derived from stores.address (free text, not parsed).';

-- ─── Channel-resolution helper — the single SQL truth for R-3 (AC-14) ──────
-- SECURITY INVOKER: the caller's brand_member_read_vendors policy clips the
-- row, so an invisible / missing vendor yields NULL and create_order_approval
-- (§1.2) raises P0002 on NULL. Mirrors the get_pending_extension_orders posture
-- (specs 131/132), NOT the staff DEFINER RPCs.
--
-- Precedence (the eight-row truth table pinned by
-- supabase/tests/vendor_order_channel.test.sql and by the TS mirror
-- src/utils/orderChannel.ts):
--   order_channel='instacart' AND a non-blank instacart_retailer_key ⇒ instacart
--                                        (the ONLY case that beats the flag)
--   extension_ordering = true                                       ⇒ extension
--   order_channel='webstaurant'                                     ⇒ webstaurant
--   otherwise                                                       ⇒ manual
-- Note the third row of the table: order_channel='extension' with
-- extension_ordering=false resolves to 'manual' — the new column can never
-- contradict the specs-131/132 flag.
create or replace function public.vendor_order_channel(p_vendor_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when v.order_channel = 'instacart'
     and nullif(btrim(coalesce(v.instacart_retailer_key, '')), '') is not null
      then 'instacart'
    when v.extension_ordering            then 'extension'
    when v.order_channel = 'webstaurant' then 'webstaurant'
    else 'manual'
  end
  from public.vendors v
  where v.id = p_vendor_id;
$$;

comment on function public.vendor_order_channel(uuid) is
  'spec 149 (§1.1, AC-14, R-3): resolve a vendor''s APPROVE & ORDER channel. '
  'Returns ''instacart'' | ''webstaurant'' | ''extension'' | ''manual'', or NULL when '
  'the vendor does not exist or is clipped by the caller''s RLS. SECURITY '
  'INVOKER by design. The ONLY way vendors.order_channel can beat '
  'vendors.extension_ordering is order_channel=''instacart'' AND a non-blank '
  'instacart_retailer_key — so BJ''s / Sam''s stay on the tuned cart-filler '
  'unless an operator explicitly keys them.';

revoke all     on function public.vendor_order_channel(uuid) from public, anon;
grant  execute on function public.vendor_order_channel(uuid) to authenticated;

commit;
