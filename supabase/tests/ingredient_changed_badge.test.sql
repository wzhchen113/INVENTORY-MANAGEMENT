-- supabase/tests/ingredient_changed_badge.test.sql
--
-- Spec 128 / design §11 — pgTAP coverage for the ingredient-changed-badge
-- migration (20260722000000_ingredient_changed_badge.sql):
--
--   Structure:
--     - catalog_ingredients.image_changed_at / inventory_items.vendor_changed_at
--       exist, nullable, timestamptz.
--     - both BEFORE UPDATE triggers exist.
--
--   Trigger behaviour:
--     - update catalog_ingredients set image_path=… stamps image_changed_at;
--       a name-only update does NOT.
--     - update inventory_items set vendor_id=… stamps vendor_changed_at;
--       a cost-only update does NOT; re-writing the SAME vendor_id does NOT
--       (IS DISTINCT FROM).
--
--   staff_items_updated RPC:
--     - never-counted edge (changed_at set, no count → updated=true).
--     - changed_at > last_counted_at → updated=true.
--     - a submitted count AFTER the change → updated=false (clears).
--     - changed_at NULL (neither photo nor vendor) → updated=false.
--     - last_counted_at = max over BOTH eod and weekly submitted counts.
--     - a status='draft' weekly does NOT clear (draft excluded).
--     - greatest(image_changed_at, vendor_changed_at): a single non-null side
--       drives changed_at (arms 14/18 via vendor_changed_at); when BOTH are
--       NULL, changed_at is NULL → updated=false (arm 16). (greatest() picking
--       the later of two non-null timestamps is standard SQL, not re-pinned.)
--
-- Hermetic: begin; … rollback; — all fixtures are created inside the txn and
-- rolled back. Runs as the postgres superuser (RLS bypassed) — the RPC's
-- security-invoker RLS filtering is covered by the existing per-store policy
-- tests; this file pins the RPC's COMPUTATION (greatest / last_counted_at /
-- updated predicate), which is the migration's actual new surface.

begin;
create extension if not exists pgtap;

select plan(20);

-- ─── Structure: columns ────────────────────────────────────────
select has_column(
  'catalog_ingredients', 'image_changed_at',
  '(1) catalog_ingredients has an image_changed_at column'
);
select col_type_is(
  'catalog_ingredients', 'image_changed_at', 'timestamp with time zone',
  '(2) catalog_ingredients.image_changed_at is timestamptz'
);
select col_is_null(
  'catalog_ingredients', 'image_changed_at',
  '(3) catalog_ingredients.image_changed_at is nullable (NULL = never changed)'
);
select has_column(
  'inventory_items', 'vendor_changed_at',
  '(4) inventory_items has a vendor_changed_at column'
);
select col_type_is(
  'inventory_items', 'vendor_changed_at', 'timestamp with time zone',
  '(5) inventory_items.vendor_changed_at is timestamptz'
);
select col_is_null(
  'inventory_items', 'vendor_changed_at',
  '(6) inventory_items.vendor_changed_at is nullable (NULL = never changed)'
);

-- ─── Structure: triggers exist ─────────────────────────────────
select has_trigger(
  'catalog_ingredients', 'trg_catalog_image_changed_at',
  '(7) catalog_ingredients has the trg_catalog_image_changed_at trigger'
);
select has_trigger(
  'inventory_items', 'trg_item_vendor_changed_at',
  '(8) inventory_items has the trg_item_vendor_changed_at trigger'
);

-- ─── Fixtures ──────────────────────────────────────────────────
-- One brand, one store, two vendors, three catalog ingredients + items.
insert into public.brands (id, name)
  values ('b0000000-0000-0000-0000-000000000001', 'Spec128 Brand');
insert into public.stores (id, name, brand_id)
  values ('50000000-0000-0000-0000-000000000001', 'Spec128 Store',
          'b0000000-0000-0000-0000-000000000001');
insert into public.vendors (id, name, brand_id)
  values ('e0000000-0000-0000-0000-000000000001', 'Vendor A',
          'b0000000-0000-0000-0000-000000000001'),
         ('e0000000-0000-0000-0000-000000000002', 'Vendor B',
          'b0000000-0000-0000-0000-000000000001');

-- catalog ingredients (image_path NULL at insert — creation is not a change)
insert into public.catalog_ingredients (id, brand_id, name, unit)
  values ('c0000000-0000-0000-0000-000000000001',
          'b0000000-0000-0000-0000-000000000001', 'Photo Item', 'ea'),
         ('c0000000-0000-0000-0000-000000000002',
          'b0000000-0000-0000-0000-000000000001', 'Vendor Item', 'ea'),
         ('c0000000-0000-0000-0000-000000000003',
          'b0000000-0000-0000-0000-000000000001', 'Unchanged Item', 'ea');

-- inventory items (initial vendor_id set at insert — not a change)
insert into public.inventory_items (id, store_id, catalog_id, vendor_id, cost_per_unit)
  values ('11000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000001',
          'e0000000-0000-0000-0000-000000000001', 1),
         ('11000000-0000-0000-0000-000000000002',
          '50000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000002',
          'e0000000-0000-0000-0000-000000000001', 1),
         ('11000000-0000-0000-0000-000000000003',
          '50000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000003',
          'e0000000-0000-0000-0000-000000000001', 1);

-- ─── Trigger: image_path change stamps; name-only does NOT ─────
update public.catalog_ingredients
   set image_path = 'b0000000-0000-0000-0000-000000000001/c0000000-0000-0000-0000-000000000001/x.jpg'
 where id = 'c0000000-0000-0000-0000-000000000001';
select isnt(
  (select image_changed_at from public.catalog_ingredients
     where id = 'c0000000-0000-0000-0000-000000000001'),
  null,
  '(9) updating image_path stamps image_changed_at'
);

update public.catalog_ingredients
   set name = 'Unchanged Item RENAMED'
 where id = 'c0000000-0000-0000-0000-000000000003';
select is(
  (select image_changed_at from public.catalog_ingredients
     where id = 'c0000000-0000-0000-0000-000000000003'),
  null,
  '(10) a name-only update does NOT stamp image_changed_at'
);

-- ─── Trigger: vendor_id change stamps; cost-only + same-vendor do NOT ─────
update public.inventory_items
   set vendor_id = 'e0000000-0000-0000-0000-000000000002'
 where id = '11000000-0000-0000-0000-000000000002';
select isnt(
  (select vendor_changed_at from public.inventory_items
     where id = '11000000-0000-0000-0000-000000000002'),
  null,
  '(11) changing vendor_id stamps vendor_changed_at'
);

-- cost-only update on the unchanged item must NOT stamp
update public.inventory_items
   set cost_per_unit = 99
 where id = '11000000-0000-0000-0000-000000000003';
select is(
  (select vendor_changed_at from public.inventory_items
     where id = '11000000-0000-0000-0000-000000000003'),
  null,
  '(12) a cost-only update does NOT stamp vendor_changed_at'
);

-- re-writing the SAME vendor_id must NOT stamp (IS DISTINCT FROM). Prove by
-- clearing the stamp then re-writing the identical value.
update public.inventory_items set vendor_changed_at = null
 where id = '11000000-0000-0000-0000-000000000002';
update public.inventory_items
   set vendor_id = 'e0000000-0000-0000-0000-000000000002'  -- same as current
 where id = '11000000-0000-0000-0000-000000000002';
select is(
  (select vendor_changed_at from public.inventory_items
     where id = '11000000-0000-0000-0000-000000000002'),
  null,
  '(13) re-writing the SAME vendor_id does NOT stamp (IS DISTINCT FROM)'
);
-- restore the stamp for the RPC tests below
update public.inventory_items set vendor_changed_at = now()
 where id = '11000000-0000-0000-0000-000000000002';

-- ─── RPC: never-counted edge → updated=true ───────────────────
-- Photo item changed, no counts anywhere → updated=true, last_counted_at NULL.
select is(
  (select updated from public.staff_items_updated('50000000-0000-0000-0000-000000000001')
     where item_id = '11000000-0000-0000-0000-000000000001'),
  true,
  '(14) changed item that was never counted → updated=true'
);
select is(
  (select last_counted_at from public.staff_items_updated('50000000-0000-0000-0000-000000000001')
     where item_id = '11000000-0000-0000-0000-000000000001'),
  null,
  '(15) never-counted item → last_counted_at is NULL'
);

-- ─── RPC: changed_at NULL (unchanged item) → updated=false ─────
select is(
  (select updated from public.staff_items_updated('50000000-0000-0000-0000-000000000001')
     where item_id = '11000000-0000-0000-0000-000000000003'),
  false,
  '(16) item with no photo/vendor change (changed_at NULL) → updated=false'
);

-- ─── RPC: submitted count AFTER change clears (updated=false) ──
-- Back-date the photo change well into the past, then submit an EOD count NOW.
update public.catalog_ingredients
   set image_changed_at = now() - interval '2 days'
 where id = 'c0000000-0000-0000-0000-000000000001';
insert into public.eod_submissions (id, store_id, date, vendor_id, status, submitted_at)
  values ('ed000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-000000000001', current_date,
          'e0000000-0000-0000-0000-000000000001', 'submitted', now());
insert into public.eod_entries (submission_id, item_id, actual_remaining)
  values ('ed000000-0000-0000-0000-000000000001',
          '11000000-0000-0000-0000-000000000001', 5);
select is(
  (select updated from public.staff_items_updated('50000000-0000-0000-0000-000000000001')
     where item_id = '11000000-0000-0000-0000-000000000001'),
  false,
  '(17) a SUBMITTED eod count after the change clears the badge (updated=false)'
);

-- ─── RPC: changed_at > last_counted_at → updated=true ─────────
-- The vendor item was counted 2 days ago, then the vendor changed now.
insert into public.eod_submissions (id, store_id, date, vendor_id, status, submitted_at)
  values ('ed000000-0000-0000-0000-000000000002',
          '50000000-0000-0000-0000-000000000001', current_date - 2,
          'e0000000-0000-0000-0000-000000000001', 'submitted', now() - interval '2 days');
insert into public.eod_entries (submission_id, item_id, actual_remaining)
  values ('ed000000-0000-0000-0000-000000000002',
          '11000000-0000-0000-0000-000000000002', 5);
select is(
  (select updated from public.staff_items_updated('50000000-0000-0000-0000-000000000001')
     where item_id = '11000000-0000-0000-0000-000000000002'),
  true,
  '(18) change AFTER the last submitted count → updated=true'
);

-- ─── RPC: last_counted_at = max over BOTH eod and weekly counts ─
-- Add a weekly (inventory_counts) count for the vendor item submitted NOW; the
-- max over both count kinds now post-dates the vendor change → clears.
insert into public.inventory_counts (id, store_id, kind, status, submitted_at)
  values ('1c000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-000000000001', 'weekly', 'submitted', now());
insert into public.inventory_count_entries (count_id, item_id)
  values ('1c000000-0000-0000-0000-000000000001',
          '11000000-0000-0000-0000-000000000002');
select is(
  (select updated from public.staff_items_updated('50000000-0000-0000-0000-000000000001')
     where item_id = '11000000-0000-0000-0000-000000000002'),
  false,
  '(19) last_counted_at is the max over BOTH eod and weekly submitted counts (weekly now clears it)'
);

-- ─── RPC: a DRAFT weekly does NOT clear ───────────────────────
-- Reset the vendor item to updated (change now, only a DRAFT weekly since).
-- Remove the prior clearing counts, back-date the change, add a DRAFT weekly NOW.
delete from public.inventory_count_entries
  where item_id = '11000000-0000-0000-0000-000000000002';
delete from public.inventory_counts
  where id = '1c000000-0000-0000-0000-000000000001';
delete from public.eod_entries
  where item_id = '11000000-0000-0000-0000-000000000002';
delete from public.eod_submissions
  where id = 'ed000000-0000-0000-0000-000000000002';
update public.inventory_items set vendor_changed_at = now() - interval '1 hour'
 where id = '11000000-0000-0000-0000-000000000002';
insert into public.inventory_counts (id, store_id, kind, status, submitted_at)
  values ('1c000000-0000-0000-0000-000000000002',
          '50000000-0000-0000-0000-000000000001', 'weekly', 'draft', now());
insert into public.inventory_count_entries (count_id, item_id)
  values ('1c000000-0000-0000-0000-000000000002',
          '11000000-0000-0000-0000-000000000002');
select is(
  (select updated from public.staff_items_updated('50000000-0000-0000-0000-000000000001')
     where item_id = '11000000-0000-0000-0000-000000000002'),
  true,
  '(20) a DRAFT weekly count does NOT clear the badge (draft excluded)'
);

select * from finish();
rollback;
