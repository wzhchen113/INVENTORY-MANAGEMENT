-- ============================================================
-- Spec 162 (revision 2) — stores carry a real address, and the cart-filler
-- extension can read the list so the operator PICKS a shipping address instead
-- of retyping one.
--
-- Owner instruction: "i dont want to write the address, but pick the address of
-- existing stores, each stores should have address filled in when creating the
-- store."
--
-- Two parts, both additive:
--   1. a NOT VALID CHECK making address mandatory on every store INSERT/UPDATE
--      from here on, WITHOUT failing on any pre-existing addressless row;
--   2. get_extension_store_addresses() — the visible-store list the extension's
--      address picker is built from.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): execute_sql this body via the
-- Supabase MCP, INSERT the exact version '20260829000100' into
-- supabase_migrations.schema_migrations, then VERIFY the constraint by
-- pg_get_constraintdef and the function by NORMALIZED-MD5.
--
-- Design authority: specs/162-bjs-auto-place-order.md "## Design".
-- ============================================================

begin;

-- ─── Part 1: address becomes mandatory (going forward) ────────────────────
-- NOT VALID is the load-bearing word. A plain `set not null` (or a validated
-- CHECK) would fail outright on any existing store whose address was never
-- filled in — including on PROD, where this migration has to apply cleanly
-- without anyone hand-backfilling first. NOT VALID enforces on every INSERT and
-- UPDATE from now on while grandfathering existing rows, which is exactly the
-- shape spec 107's purchase_orders_status_check used.
--
-- CONSEQUENCE, deliberate and worth knowing: an UPDATE to a grandfathered
-- addressless store fails too, even one that only touches the name. That is the
-- desired forcing function — StoreFormDrawer now requires the address before it
-- will save, so the operator fills it in as part of the edit rather than
-- discovering a constraint error. Once every store has one, run
--   alter table public.stores validate constraint stores_address_present;
-- to close the grandfather clause. That is a separate, deliberate step — NOT
-- done here, because it would fail on exactly the rows this constraint exists
-- to flush out.
--
-- btrim() is the point of the second conjunct: '' and '   ' are not addresses,
-- and a NOT NULL alone would happily accept both.
alter table public.stores
  drop constraint if exists stores_address_present;

alter table public.stores
  add constraint stores_address_present
  check (address is not null and btrim(address) <> '')
  not valid;

comment on constraint stores_address_present on public.stores is
  'spec 162 (rev 2): every store must carry a non-blank address — it is the '
  'shipping address the cart-filler extension''s auto-place picker offers. '
  'NOT VALID: existing addressless rows are grandfathered so the migration '
  'applies cleanly, but any INSERT or UPDATE must comply. Run `validate '
  'constraint` once the stragglers are backfilled.';


-- ─── Part 2: the extension's address picker source ────────────────────────
-- SECURITY INVOKER (the default) so `stores` RLS does the scoping: the caller
-- sees exactly the stores auth_can_see_store already grants them, and this
-- function widens nothing. Same posture as the spec-131 extension RPCs.
--
-- Returns EVERY visible store, including any still missing an address, with
-- `hasAddress` telling the picker which ones are selectable. Filtering the
-- addressless ones out here would make them silently VANISH from the operator's
-- list — they would see a store missing and have no idea why. Naming the gap is
-- what turns it into something they can fix.
create or replace function public.get_extension_store_addresses()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'storeId',    s.id,
        'storeName',  s.name,
        'address',    s.address,
        'hasAddress', (s.address is not null and btrim(s.address) <> '')
      )
      order by s.name
    ),
    '[]'::jsonb
  )
  from public.stores s
  where s.status is distinct from 'inactive';
$$;

comment on function public.get_extension_store_addresses() is
  'spec 162 (rev 2): the visible-store list the cart-filler extension''s '
  'shipping-address picker is built from — {storeId, storeName, address, '
  'hasAddress}, name-ordered, active stores only. SECURITY INVOKER, so stores '
  'RLS scopes it to exactly what the caller can already see. Addressless stores '
  'are RETURNED with hasAddress=false rather than filtered out, so a missing '
  'address reads as a gap to fix instead of a store that vanished.';

-- REVOKE FROM `public` IS LOAD-BEARING (see the same note in
-- 20260829000000): CREATE FUNCTION grants EXECUTE to PUBLIC and anon inherits
-- it, so revoking from `anon` alone leaves anon able to call this. Matches the
-- spec-131 extension RPCs' idiom.
revoke all     on function public.get_extension_store_addresses() from public, anon;
grant  execute on function public.get_extension_store_addresses() to authenticated;

commit;
