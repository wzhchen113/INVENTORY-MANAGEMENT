-- supabase/tests/vendor_order_channel.test.sql
--
-- Spec 149 (AC-14, R-3) — pgTAP coverage for public.vendor_order_channel(),
-- shipped in supabase/migrations/20260801000000_vendor_order_channel.sql.
--
-- This file is the SQL half of a two-track pin: the same eight-row truth table
-- is pinned in jest against the TS display mirror src/utils/orderChannel.ts.
-- The duplication is deliberate (a DB round-trip per vendor per render is not
-- acceptable, and the edge-function Deno bundle can import neither) — the two
-- tracks exist so a drift in either implementation fails the build.
--
-- THE POINT OF THIS FILE (spec 149 design guidance 2): a later edit must not be
-- able to silently reroute BJ's / Sam's AWAY from the live-tuned specs-131/132
-- cart-filler. `vendors.extension_ordering` stays load-bearing; the only case
-- in which the new `order_channel` column beats it is
-- order_channel='instacart' AND a NON-BLANK instacart_retailer_key.
--
-- Plan (11 arms):
--   (T1) instacart + key      + ext=true   ⇒ instacart   ← only case beating the flag
--   (T2) instacart + NULL key + ext=true   ⇒ extension   ← BJ's stays on the cart-filler
--   (T2b) instacart + BLANK key + ext=true ⇒ extension   ← btrim/nullif guard
--   (T3) instacart + NULL key + ext=false  ⇒ manual
--   (T4) webstaurant          + ext=true   ⇒ extension
--   (T5) webstaurant          + ext=false  ⇒ webstaurant
--   (T6) extension            + ext=false  ⇒ manual      ← column cannot contradict the flag
--   (T7) NULL channel         + ext=true   ⇒ extension
--   (T8) NULL channel         + ext=false  ⇒ manual
--   (T9) unknown vendor id                 ⇒ NULL        (⇒ create_order_approval P0002)
--   (T10) vendors_order_channel_check rejects an out-of-enum value.
--
-- Hermetic: begin; … rollback;. Fixtures created inside the transaction, so the
-- file is green under the committed seed AND on a CI-fresh database.

begin;
create extension if not exists pgtap;

select plan(11);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_brand_id uuid;
begin
  select id into v_brand_id from public.brands limit 1;
  perform set_config('test.brand_id', v_brand_id::text, true);
end $$;

-- Eight vendors, one per truth-table row (plus the blank-key variant).
-- Inserted as the default (superuser) role → RLS-free fixture setup.
insert into public.vendors (id, name, brand_id, order_channel, instacart_retailer_key, extension_ordering)
values
  ('49900000-0000-0000-0000-000000000001', '__voc_t1__',
   current_setting('test.brand_id', true)::uuid, 'instacart',  'sams_club', true),
  ('49900000-0000-0000-0000-000000000002', '__voc_t2__',
   current_setting('test.brand_id', true)::uuid, 'instacart',  null,        true),
  ('49900000-0000-0000-0000-000000000003', '__voc_t2b__',
   current_setting('test.brand_id', true)::uuid, 'instacart',  '   ',       true),
  ('49900000-0000-0000-0000-000000000004', '__voc_t3__',
   current_setting('test.brand_id', true)::uuid, 'instacart',  null,        false),
  ('49900000-0000-0000-0000-000000000005', '__voc_t4__',
   current_setting('test.brand_id', true)::uuid, 'webstaurant', null,       true),
  ('49900000-0000-0000-0000-000000000006', '__voc_t5__',
   current_setting('test.brand_id', true)::uuid, 'webstaurant', null,       false),
  ('49900000-0000-0000-0000-000000000007', '__voc_t6__',
   current_setting('test.brand_id', true)::uuid, 'extension',   null,       false),
  ('49900000-0000-0000-0000-000000000008', '__voc_t7__',
   current_setting('test.brand_id', true)::uuid, null,          null,       true),
  ('49900000-0000-0000-0000-000000000009', '__voc_t8__',
   current_setting('test.brand_id', true)::uuid, null,          null,       false);

-- ─── the eight-row truth table (AC-14) ─────────────────────────
select is(public.vendor_order_channel('49900000-0000-0000-0000-000000000001'), 'instacart',
  '(T1) order_channel=instacart + retailer key + extension_ordering=true ⇒ instacart (the ONLY case that beats the flag)');

select is(public.vendor_order_channel('49900000-0000-0000-0000-000000000002'), 'extension',
  '(T2) order_channel=instacart + NULL retailer key + extension_ordering=true ⇒ extension (BJ''s stays on the tuned cart-filler)');

select is(public.vendor_order_channel('49900000-0000-0000-0000-000000000003'), 'extension',
  '(T2b) a BLANK/whitespace retailer key is treated as absent ⇒ extension');

select is(public.vendor_order_channel('49900000-0000-0000-0000-000000000004'), 'manual',
  '(T3) order_channel=instacart + NULL retailer key + extension_ordering=false ⇒ manual');

select is(public.vendor_order_channel('49900000-0000-0000-0000-000000000005'), 'extension',
  '(T4) order_channel=webstaurant + extension_ordering=true ⇒ extension (the flag wins)');

select is(public.vendor_order_channel('49900000-0000-0000-0000-000000000006'), 'webstaurant',
  '(T5) order_channel=webstaurant + extension_ordering=false ⇒ webstaurant');

select is(public.vendor_order_channel('49900000-0000-0000-0000-000000000007'), 'manual',
  '(T6) order_channel=extension + extension_ordering=false ⇒ manual (the column CANNOT contradict the specs-131/132 flag)');

select is(public.vendor_order_channel('49900000-0000-0000-0000-000000000008'), 'extension',
  '(T7) NULL order_channel + extension_ordering=true ⇒ extension');

select is(public.vendor_order_channel('49900000-0000-0000-0000-000000000009'), 'manual',
  '(T8) NULL order_channel + extension_ordering=false ⇒ manual');

-- ─── (T9) unknown vendor ⇒ NULL (create_order_approval turns this into P0002) ─
select ok(
  public.vendor_order_channel('49900000-0000-0000-0000-0000000000ff') is null,
  '(T9) an unknown / RLS-invisible vendor resolves to NULL'
);

-- ─── (T10) the CHECK constraint bounds the enum ────────────────
select throws_ok(
  $q$insert into public.vendors (name, brand_id, order_channel)
     values ('__voc_bad__', (select id from public.brands limit 1), 'doordash')$q$,
  '23514',
  null,
  '(T10) vendors_order_channel_check rejects an out-of-enum order_channel'
);

select finish();
rollback;
