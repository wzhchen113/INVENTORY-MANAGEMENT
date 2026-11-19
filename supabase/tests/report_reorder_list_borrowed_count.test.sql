-- supabase/tests/report_reorder_list_borrowed_count.test.sql
--
-- Spec 201 Part 2 — reorder reads a shared item's count across vendors
-- (the spec 200 borrow source). pgTAP coverage for
-- supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql
-- hunks B1/B2/V (AC-13 .. AC-19, plus AC-15b for the §2 tiebreak).
--
-- Borrow source (design §2, shared word for word with spec 200): per item,
-- the numeric actual_remaining from the first (store, as-of date,
-- 'submitted') submission of ANY vendor in (submitted_at DESC NULLS LAST,
-- submission id DESC) order. The row's OWN numeric entry always wins
-- (R9.1); vendor-level on_hand_source / eod_submitted_at / KPI source counts
-- keep their own-submission meaning (R10); NO NEED stays spec 172's
-- item-wide override and is never a numeric source (R11).
--
-- Fixture (Frederick, created in-transaction):
--   A, B — fresh vendors linked to F (A primary). C — fresh vendor NOT
--   linked to F (its own item H keeps its submission realistic).
--   F — par 10, current_stock 2, usage 0; linked A ($1) + B ($1).
--   G — par 10, current_stock 2; linked B only. H — linked C only.
--   order_schedule: A on WD, B on WD1 → NOT coincident (both F rows
--   return) unless a scenario says otherwise (AC-14).
--   Every scenario uses its OWN synthetic as-of date on the same weekday
--   (base date + 7k), so submissions never have to be deleted. Submissions
--   and entries are direct inserts with explicit submitted_at (and explicit
--   ids for the AC-15b tiebreak).
--
-- S1 (architect post-impl review; owner: "accept, relabel later") — arms
-- (42)-(46) PIN today's vendor-badge consequence of R10 so any later
-- relabel is deliberate: a vendor that DID submit, but whose surfaced rows
-- are all non-own-EOD (borrowed under spec 200's omit, or its own count
-- dropped by primary-wins), badges on_hand_source = 'stock' with a non-null
-- eod_submitted_at. Quantities are correct. A "counted under {vendor}"
-- relabel is a follow-up spec, not an R10 edit.
--
-- Master principal for the reorder calls (mirrors the other
-- report_reorder_list_* suites). No `set role anon`. Hermetic:
-- begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(46);

-- ─── fixtures (as postgres) ─────────────────────────────────────
do $$
declare
  v_store   uuid;
  v_charles uuid;
  v_brand   uuid;
  v_a uuid; v_b uuid; v_c uuid;
  v_tag text := substr(gen_random_uuid()::text, 1, 8);
  v_d   date := '2001-06-04'::date;
begin
  select id, brand_id into v_store, v_brand from public.stores where name = 'Frederick' limit 1;
  select id into v_charles from public.stores where name = 'Charles' limit 1;

  insert into public.vendors (name, brand_id) values ('SPEC201-BC-A-' || v_tag, v_brand) returning id into v_a;
  insert into public.vendors (name, brand_id) values ('SPEC201-BC-B-' || v_tag, v_brand) returning id into v_b;
  insert into public.vendors (name, brand_id) values ('SPEC201-BC-C-' || v_tag, v_brand) returning id into v_c;

  perform set_config('test.master_id', '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.store',   v_store::text, true);
  perform set_config('test.charles', v_charles::text, true);
  perform set_config('test.brand',   v_brand::text, true);
  perform set_config('test.tag',     v_tag, true);
  perform set_config('test.a', v_a::text, true);
  perform set_config('test.b', v_b::text, true);
  perform set_config('test.c', v_c::text, true);
  perform set_config('test.a_name', 'SPEC201-BC-A-' || v_tag, true);
  perform set_config('test.c_name', 'SPEC201-BC-C-' || v_tag, true);
  perform set_config('test.wd',  to_char(v_d, 'FMDay'), true);
  perform set_config('test.wd1', to_char(v_d + 1, 'FMDay'), true);
  -- One as-of date per scenario, all on the same weekday.
  perform set_config('test.d13',  (v_d +   0)::text, true);
  perform set_config('test.d14',  (v_d +   7)::text, true);
  perform set_config('test.d15',  (v_d +  14)::text, true);
  perform set_config('test.d15s', (v_d +  21)::text, true);
  perform set_config('test.d15b', (v_d +  28)::text, true);
  perform set_config('test.d15c', (v_d +  35)::text, true);
  perform set_config('test.d16',  (v_d +  42)::text, true);
  perform set_config('test.d17a', (v_d +  49)::text, true);
  perform set_config('test.d17b', (v_d +  56)::text, true);
  perform set_config('test.d17c', (v_d +  63)::text, true);
  perform set_config('test.d17d', (v_d +  70)::text, true);
  perform set_config('test.d18',  (v_d +  77)::text, true);
  perform set_config('test.d19',  (v_d +  84)::text, true);
  perform set_config('test.ds1o', (v_d +  91)::text, true);
  perform set_config('test.ds1d', (v_d +  98)::text, true);
end $$;

create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  select current_setting('test.brand', true)::uuid,
         'SPEC201BC-' || k || '-' || current_setting('test.tag', true),
         'each'
    from unnest(array['F','G','H','J']) as k
  returning id, name
)
select id, name, split_part(name, '-', 2) as kind from ins;

-- F/G/H at Frederick. J is A's second item (AC-14: A submits "other items
-- but no F"). F also exists at Charles (same catalog) for the AC-17
-- other-store probe.
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  select current_setting('test.store', true)::uuid,
         c.id,
         case c.kind when 'F' then current_setting('test.a', true)::uuid
                     when 'J' then current_setting('test.a', true)::uuid
                     when 'G' then current_setting('test.b', true)::uuid
                     else current_setting('test.c', true)::uuid end,
         1, 2, 10, 0
    from _cat c
  returning id, catalog_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.f', (select id::text from _items where kind = 'F'), true);
  perform set_config('test.g', (select id::text from _items where kind = 'G'), true);
  perform set_config('test.h', (select id::text from _items where kind = 'H'), true);
  perform set_config('test.j', (select id::text from _items where kind = 'J'), true);
end $$;

insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.f', true)::uuid, current_setting('test.a', true)::uuid, 1, 0, true),
  (current_setting('test.f', true)::uuid, current_setting('test.b', true)::uuid, 1, 0, false),
  (current_setting('test.j', true)::uuid, current_setting('test.a', true)::uuid, 1, 0, true),
  (current_setting('test.g', true)::uuid, current_setting('test.b', true)::uuid, 1, 0, true),
  (current_setting('test.h', true)::uuid, current_setting('test.c', true)::uuid, 1, 0, true);

insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.store', true)::uuid,
       case when v.id = current_setting('test.a', true)::uuid
            then current_setting('test.wd', true) else current_setting('test.wd1', true) end,
       v.id, v.name,
       lower(current_setting('test.wd', true))
  from public.vendors v
 where v.id in (current_setting('test.a', true)::uuid, current_setting('test.b', true)::uuid);

-- Submission + entry helpers as plain inserts. _sub(scn, vendor, date,
-- status, submitted_at, store, explicit id). Entries: (scn, vendor, item,
-- actual_remaining, no_need).
create temp table _sub_spec (
  scn text, vendor text, d text, status text, at timestamptz, store text, sid uuid
) on commit drop;
create temp table _ent_spec (
  scn text, vendor text, item text, qty numeric, no_need boolean default false
) on commit drop;

insert into _sub_spec (scn, vendor, d, status, at, store, sid) values
  -- AC-13: A {F=5}; B {G=1}.
  ('ac13', 'a', 'd13', 'submitted', '2001-01-01 10:00+00', 'store', null),
  ('ac13', 'b', 'd13', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-14 (coincident): B {F=4, G=1}; A {J=1} (no F).
  ('ac14', 'b', 'd14', 'submitted', '2001-01-01 10:00+00', 'store', null),
  ('ac14', 'a', 'd14', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-15: A {F=5} earlier, C {F=7, H=1} later; B {G=1}.
  ('ac15', 'a', 'd15', 'submitted', '2001-01-01 10:00+00', 'store', null),
  ('ac15', 'c', 'd15', 'submitted', '2001-01-01 12:00+00', 'store', null),
  ('ac15', 'b', 'd15', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-15 swapped: A later than C.
  ('ac15s', 'a', 'd15s', 'submitted', '2001-01-01 12:00+00', 'store', null),
  ('ac15s', 'c', 'd15s', 'submitted', '2001-01-01 10:00+00', 'store', null),
  ('ac15s', 'b', 'd15s', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-15b: equal submitted_at, C has the higher id → C wins.
  ('ac15b', 'a', 'd15b', 'submitted', '2001-01-01 10:00+00', 'store', '10000000-0000-4000-8000-000000000201'),
  ('ac15b', 'c', 'd15b', 'submitted', '2001-01-01 10:00+00', 'store', 'f0000000-0000-4000-8000-000000000201'),
  ('ac15b', 'b', 'd15b', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-15b mirrored: A has the higher id → A wins.
  ('ac15c', 'a', 'd15c', 'submitted', '2001-01-01 10:00+00', 'store', 'f1000000-0000-4000-8000-000000000201'),
  ('ac15c', 'c', 'd15c', 'submitted', '2001-01-01 10:00+00', 'store', '11000000-0000-4000-8000-000000000201'),
  ('ac15c', 'b', 'd15c', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-16: A {F=5}; B {F=3, G=1} later.
  ('ac16', 'a', 'd16', 'submitted', '2001-01-01 10:00+00', 'store', null),
  ('ac16', 'b', 'd16', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-17a: A's F=5 is a DRAFT; B {G=1}.
  ('ac17a', 'a', 'd17a', 'draft',     '2001-01-01 12:00+00', 'store', null),
  ('ac17a', 'b', 'd17a', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-17b: A's F=5 is on D − 1 (the d17b scenario reads d17b); B {G=1}.
  ('ac17b', 'a', 'd17b-1', 'submitted', '2001-01-01 12:00+00', 'store', null),
  ('ac17b', 'b', 'd17b',   'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-17c: A's F=5 is for ANOTHER store (Charles); B {G=1}.
  ('ac17c', 'a', 'd17c', 'submitted', '2001-01-01 12:00+00', 'charles', null),
  ('ac17c', 'b', 'd17c', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-17d: A's F entry is NO NEED; B {G=1}.
  ('ac17d', 'a', 'd17d', 'submitted', '2001-01-01 12:00+00', 'store', null),
  ('ac17d', 'b', 'd17d', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- AC-18: A {F=5}; B never submitted.
  ('ac18', 'a', 'd18', 'submitted', '2001-01-01 10:00+00', 'store', null),
  -- AC-19: A {F=5}; C {F NO NEED, H=1}; B {G=1}.
  ('ac19', 'a', 'd19', 'submitted', '2001-01-01 10:00+00', 'store', null),
  ('ac19', 'c', 'd19', 'submitted', '2001-01-01 12:00+00', 'store', null),
  ('ac19', 'b', 'd19', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- S1 omit (spec 200 shape): A {F=5}; B {G=10} — G at par, so B's only
  -- surfaced row is the borrowed F.
  ('s1o', 'a', 'ds1o', 'submitted', '2001-01-01 10:00+00', 'store', null),
  ('s1o', 'b', 'ds1o', 'submitted', '2001-01-01 11:00+00', 'store', null),
  -- S1 drop (coincident): A {F=6}; B {F=4} — B's only own count is the
  -- dropped F; G (below par) is uncounted.
  ('s1d', 'a', 'ds1d', 'submitted', '2001-01-01 10:00+00', 'store', null),
  ('s1d', 'b', 'ds1d', 'submitted', '2001-01-01 11:00+00', 'store', null);

insert into _ent_spec (scn, vendor, item, qty, no_need) values
  ('ac13',  'a', 'f', 5, false), ('ac13',  'b', 'g', 1, false),
  ('ac14',  'b', 'f', 4, false), ('ac14',  'b', 'g', 1, false), ('ac14', 'a', 'j', 1, false),
  ('ac15',  'a', 'f', 5, false), ('ac15',  'c', 'f', 7, false), ('ac15', 'c', 'h', 1, false),
  ('ac15',  'b', 'g', 1, false),
  ('ac15s', 'a', 'f', 5, false), ('ac15s', 'c', 'f', 7, false), ('ac15s', 'c', 'h', 1, false),
  ('ac15s', 'b', 'g', 1, false),
  ('ac15b', 'a', 'f', 5, false), ('ac15b', 'c', 'f', 7, false), ('ac15b', 'c', 'h', 1, false),
  ('ac15b', 'b', 'g', 1, false),
  ('ac15c', 'a', 'f', 5, false), ('ac15c', 'c', 'f', 7, false), ('ac15c', 'c', 'h', 1, false),
  ('ac15c', 'b', 'g', 1, false),
  ('ac16',  'a', 'f', 5, false), ('ac16',  'b', 'f', 3, false), ('ac16', 'b', 'g', 1, false),
  ('ac17a', 'a', 'f', 5, false), ('ac17a', 'b', 'g', 1, false),
  ('ac17b', 'a', 'f', 5, false), ('ac17b', 'b', 'g', 1, false),
  ('ac17c', 'a', 'f', 5, false), ('ac17c', 'b', 'g', 1, false),
  ('ac17d', 'a', 'f', null, true), ('ac17d', 'b', 'g', 1, false),
  ('ac18',  'a', 'f', 5, false),
  ('ac19',  'a', 'f', 5, false), ('ac19',  'c', 'f', null, true), ('ac19', 'c', 'h', 1, false),
  ('ac19',  'b', 'g', 1, false),
  ('s1o',   'a', 'f', 5, false), ('s1o',   'b', 'g', 10, false),
  ('s1d',   'a', 'f', 6, false), ('s1d',   'b', 'f', 4, false);

create temp table _subs on commit drop as
with ins as (
  insert into public.eod_submissions (id, store_id, date, vendor_id, status, submitted_at, client_uuid)
  select coalesce(s.sid, gen_random_uuid()),
         current_setting('test.' || s.store, true)::uuid,
         case when s.d like '%-1'
              then current_setting('test.' || replace(s.d, '-1', ''), true)::date - 1
              else current_setting('test.' || s.d, true)::date end,
         current_setting('test.' || s.vendor, true)::uuid,
         s.status, s.at, gen_random_uuid()
    from _sub_spec s
  returning id, store_id, date, vendor_id, client_uuid
)
select ins.id, ins.store_id, ins.date, ins.vendor_id from ins;

-- Map each spec row to its inserted submission (unique on store/date/vendor).
create temp table _sub_map on commit drop as
select s.scn, s.vendor, x.id as submission_id, x.store_id
  from _sub_spec s
  join _subs x
    on x.vendor_id = current_setting('test.' || s.vendor, true)::uuid
   and x.store_id  = current_setting('test.' || s.store, true)::uuid
   and x.date = case when s.d like '%-1'
                     then current_setting('test.' || replace(s.d, '-1', ''), true)::date - 1
                     else current_setting('test.' || s.d, true)::date end;

-- Ordinary entries (eod_entries_check_store holds: item store = submission
-- store).
insert into public.eod_entries (submission_id, item_id, actual_remaining, no_need)
select m.submission_id, current_setting('test.' || e.item, true)::uuid, e.qty, e.no_need
  from _ent_spec e
  join _sub_map m on m.scn = e.scn and m.vendor = e.vendor
 where m.store_id = current_setting('test.store', true)::uuid;

-- AC-17c: the Charles submission carries an entry for FREDERICK's F. The
-- eod_entries_check_store trigger forbids that shape in production, so this
-- probe bypasses triggers for this one statement (session_replication_role
-- = replica, rolled back with the test). It proves the borrow source is
-- store-filtered on the submission, not just accidentally item-scoped.
set local session_replication_role = replica;
insert into public.eod_entries (submission_id, item_id, actual_remaining, no_need)
select m.submission_id, current_setting('test.' || e.item, true)::uuid, e.qty, e.no_need
  from _ent_spec e
  join _sub_map m on m.scn = e.scn and m.vendor = e.vendor
 where m.store_id = current_setting('test.charles', true)::uuid;
set local session_replication_role = origin;

-- ─── master JWT + snapshots ─────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.master_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'master')
  )::text,
  true
);
create temp table _envs (scn text primary key, env jsonb) on commit drop;

insert into _envs
select x.scn, public.report_reorder_list(
         current_setting('test.store', true)::uuid,
         jsonb_build_object('as_of_date', current_setting('test.' || x.dkey, true),
                            'include_stocked', x.stocked))
  from (values ('ac13','d13',false), ('ac15','d15',false), ('ac15s','d15s',false),
               ('ac15b','d15b',false), ('ac15c','d15c',false), ('ac16','d16',false),
               ('ac17a','d17a',false), ('ac17b','d17b',false), ('ac17c','d17c',false),
               ('ac17d','d17d',true), ('ac18','d18',false), ('ac19','d19',true),
               ('s1o','ds1o',false))
       as x(scn, dkey, stocked);
reset role;

-- AC-14: make B coincident with A (both order out on WD).
update public.order_schedule set day_of_week = current_setting('test.wd', true)
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.b', true)::uuid;
set local role authenticated;
insert into _envs select 'ac14', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d14', true)));
insert into _envs select 's1d', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.ds1d', true)));
reset role;

create temp view _v as
select e.scn, v->>'vendor_id' as vendor_id, v as vendor
  from _envs e, jsonb_array_elements(e.env->'vendors') v;
create temp view _r as
select e.scn, v->>'vendor_id' as vendor_id, i->>'item_id' as item_id, i as item
  from _envs e, jsonb_array_elements(e.env->'vendors') v, jsonb_array_elements(v->'items') i;
-- F row per (scenario, vendor letter).
create temp view _f as
select r.scn,
       case r.vendor_id when current_setting('test.a', true) then 'a'
                        when current_setting('test.b', true) then 'b'
                        else 'other' end as who,
       r.item
  from _r r
 where r.item_id = current_setting('test.f', true);

-- ═══ AC-13 ══════════════════════════════════════════════════════
select is(((select item from _f where scn = 'ac13' and who = 'b')->>'on_hand')::numeric, 5::numeric,
  '(1) AC-13: B''s F row borrows A''s count (on_hand 5)');
select ok(not ((select item from _f where scn = 'ac13' and who = 'b')->'flags' ? 'eod_missing_for_item'),
  '(2) AC-13: B''s F row is NOT flagged eod_missing_for_item');
select is((select item from _f where scn = 'ac13' and who = 'b')->>'item_on_hand_source', 'eod',
  '(3) AC-13: B''s F row per-item source is ''eod''');
select is((select item from _f where scn = 'ac13' and who = 'b')->'on_hand_borrowed_from',
  jsonb_build_object('vendor_id', current_setting('test.a', true),
                     'vendor_name', current_setting('test.a_name', true)),
  '(4) AC-13: on_hand_borrowed_from names A');
select is((select vendor->>'on_hand_source' from _v where scn = 'ac13' and vendor_id = current_setting('test.b', true)),
  'eod',
  '(5) AC-13: B''s vendor-level on_hand_source is its own (''eod'' via G) — as before');
select is((select (vendor->>'eod_submitted_at')::timestamptz from _v where scn = 'ac13' and vendor_id = current_setting('test.b', true)),
  '2001-01-01 11:00+00'::timestamptz,
  '(6) AC-13: B''s eod_submitted_at is B''s own submission time');
select is((select item from _f where scn = 'ac13' and who = 'a')->'on_hand_borrowed_from', 'null'::jsonb,
  '(7) AC-13: A''s own F row is not borrowed (on_hand_borrowed_from null)');
select is(((select item from _f where scn = 'ac13' and who = 'b')->>'suggested_qty')::numeric, 5::numeric,
  '(8) AC-13: B''s F suggestion uses the borrowed 5 (par 10 − 5)');

-- ═══ AC-14 (coincident; borrowed into the primary) ══════════════
select is((select count(*)::bigint from _f where scn = 'ac14' and who = 'b'), 0::bigint,
  '(9) AC-14: coincident — F is absent from B');
select is(((select item from _f where scn = 'ac14' and who = 'a')->>'on_hand')::numeric, 4::numeric,
  '(10) AC-14: F on the primary A reads B''s count (on_hand 4)');
select ok(not ((select item from _f where scn = 'ac14' and who = 'a')->'flags' ? 'eod_missing_for_item'),
  '(11) AC-14: A''s F row has no eod_missing_for_item flag');
select is(((select item from _f where scn = 'ac14' and who = 'a')->>'suggested_qty')::numeric, 6::numeric,
  '(12) AC-14: A''s F suggested_qty uses 4 (par 10 − 4 = 6)');
select is((select item from _f where scn = 'ac14' and who = 'a')->>'item_on_hand_source', 'eod',
  '(13) AC-14: A''s F row per-item source is ''eod''');

-- ═══ AC-15 (latest wins; unlinked vendor is a source) ═══════════
select is(((select item from _f where scn = 'ac15' and who = 'b')->>'on_hand')::numeric, 7::numeric,
  '(14) AC-15: C (unlinked, later) wins — B''s F row reads 7');
select is((select item from _f where scn = 'ac15' and who = 'b')->'on_hand_borrowed_from'->>'vendor_name',
  current_setting('test.c_name', true),
  '(15) AC-15: on_hand_borrowed_from names C');
select is(((select item from _f where scn = 'ac15s' and who = 'b')->>'on_hand')::numeric, 5::numeric,
  '(16) AC-15: swapped timestamps — B''s F row reads A''s 5');
select is((select item from _f where scn = 'ac15s' and who = 'b')->'on_hand_borrowed_from'->>'vendor_id',
  current_setting('test.a', true),
  '(17) AC-15: swapped — on_hand_borrowed_from names A');
select is(((select item from _f where scn = 'ac15' and who = 'a')->>'on_hand')::numeric, 5::numeric,
  '(18) AC-15: A''s own F entry still wins on A''s row (5, not C''s later 7)');

-- ═══ AC-15b (equal submitted_at → higher submission id) ═════════
select is(((select item from _f where scn = 'ac15b' and who = 'b')->>'on_hand')::numeric, 7::numeric,
  '(19) AC-15b: equal submitted_at — C''s higher id wins (7)');
select is(((select item from _f where scn = 'ac15c' and who = 'b')->>'on_hand')::numeric, 5::numeric,
  '(20) AC-15b: mirrored — A''s higher id wins (5)');

-- ═══ AC-16 (own wins) ═══════════════════════════════════════════
select is(((select item from _f where scn = 'ac16' and who = 'b')->>'on_hand')::numeric, 3::numeric,
  '(21) AC-16: B''s own F entry (3) wins');
select is(((select item from _f where scn = 'ac16' and who = 'a')->>'on_hand')::numeric, 5::numeric,
  '(22) AC-16: A''s own F entry (5) wins despite B''s later submission');
select ok(
  (select bool_and(item->'on_hand_borrowed_from' = 'null'::jsonb) from _f where scn = 'ac16' and who in ('a','b')),
  '(23) AC-16: neither own row is marked borrowed');

-- ═══ AC-17 (not a source → case B as before) ════════════════════
select is(
  (select jsonb_build_object('on_hand', (item->>'on_hand')::numeric,
                             'missing', item->'flags' ? 'eod_missing_for_item',
                             'source',  item->>'item_on_hand_source',
                             'borrowed', item->'on_hand_borrowed_from')
     from _f where scn = 'ac17a' and who = 'b'),
  jsonb_build_object('on_hand', 2, 'missing', true, 'source', 'stock', 'borrowed', null),
  '(24) AC-17: a DRAFT is not a source — B''s F row is case B (current_stock 2, flag)');
select is(
  (select jsonb_build_object('on_hand', (item->>'on_hand')::numeric,
                             'missing', item->'flags' ? 'eod_missing_for_item',
                             'borrowed', item->'on_hand_borrowed_from')
     from _f where scn = 'ac17b' and who = 'b'),
  jsonb_build_object('on_hand', 2, 'missing', true, 'borrowed', null),
  '(25) AC-17: D − 1 is not a source — case B');
select is(
  (select jsonb_build_object('on_hand', (item->>'on_hand')::numeric,
                             'missing', item->'flags' ? 'eod_missing_for_item',
                             'borrowed', item->'on_hand_borrowed_from')
     from _f where scn = 'ac17c' and who = 'b'),
  jsonb_build_object('on_hand', 2, 'missing', true, 'borrowed', null),
  '(26) AC-17: another store''s submission is not a source — case B');
-- C1: the NO NEED bullet's "as before" is the spec 172 result.
-- (include_stocked = true so the zeroed row is observable.)
select is(
  (select jsonb_build_object('on_hand', (item->>'on_hand')::numeric,
                             'missing', item->'flags' ? 'eod_missing_for_item',
                             'no_need', item->'flags' ? 'no_need',
                             'borrowed', item->'on_hand_borrowed_from')
     from _f where scn = 'ac17d' and who = 'b'),
  jsonb_build_object('on_hand', 2, 'missing', false, 'no_need', true, 'borrowed', null),
  '(27) AC-17/C1: NO NEED is not a source — B''s F row is current_stock 2, ''no_need'' present, ''eod_missing_for_item'' absent');
select is(((select item from _f where scn = 'ac17d' and who = 'b')->>'suggested_qty')::numeric, 0::numeric,
  '(28) AC-17/C1: … and suggests 0 (spec 172 override unchanged)');

-- ═══ AC-18 (vendor never submitted — R10) ═══════════════════════
select is(((select item from _f where scn = 'ac18' and who = 'b')->>'on_hand')::numeric, 5::numeric,
  '(29) AC-18: B never submitted — its F row borrows A''s 5');
select ok(not ((select item from _f where scn = 'ac18' and who = 'b')->'flags' ? 'eod_missing_for_item'),
  '(30) AC-18: B''s F row has no eod_missing_for_item flag');
select is((select item from _f where scn = 'ac18' and who = 'b')->>'item_on_hand_source', 'eod',
  '(31) AC-18: B''s F row per-item source is ''eod'' (borrowed)');
select is((select vendor->>'on_hand_source' from _v where scn = 'ac18' and vendor_id = current_setting('test.b', true)),
  'stock',
  '(32) AC-18/R10: B''s vendor-level on_hand_source stays ''stock''');
select ok((select vendor->'eod_submitted_at' = 'null'::jsonb from _v where scn = 'ac18' and vendor_id = current_setting('test.b', true)),
  '(33) AC-18/R10: B''s eod_submitted_at stays null');
select is(
  (select (env->'kpis'->>'eod_sourced_vendor_count')::bigint from _envs where scn = 'ac18'),
  (select count(*)::bigint from _v where scn = 'ac18' and vendor->>'on_hand_source' = 'eod'),
  '(34) AC-18/R10: kpis.eod_sourced_vendor_count counts own-sourced vendors only');
select is(
  (select (env->'kpis'->>'stock_fallback_vendor_count')::bigint from _envs where scn = 'ac18'),
  (select count(*)::bigint from _v where scn = 'ac18' and vendor->>'on_hand_source' = 'stock'),
  '(35) AC-18/R10: kpis.stock_fallback_vendor_count still counts B');
select is(
  (select vendor->>'on_hand_source' from _v where scn = 'ac18' and vendor_id = current_setting('test.a', true)),
  'eod',
  '(36) AC-18: A (own submission) is ''eod''-sourced');

-- ═══ AC-19 (NO NEED still overrides — R11), include_stocked ═════
select is(
  (select jsonb_build_object('suggested_qty', (item->>'suggested_qty')::numeric,
                             'needs_order',   (item->>'needs_order')::boolean,
                             'no_need',       item->'flags' ? 'no_need')
     from _f where scn = 'ac19' and who = 'b'),
  jsonb_build_object('suggested_qty', 0, 'needs_order', false, 'no_need', true),
  '(37) AC-19: C''s NO NEED zeroes B''s (borrowed) F row: suggest 0, needs_order false, no_need flag');
select is(((select item from _f where scn = 'ac19' and who = 'b')->>'on_hand')::numeric, 5::numeric,
  '(38) AC-19: B''s F row on_hand is the borrowed numeric 5 (NO NEED is never a numeric source)');
select is(
  (select jsonb_build_object('on_hand',       (item->>'on_hand')::numeric,
                             'suggested_qty', (item->>'suggested_qty')::numeric,
                             'no_need',       item->'flags' ? 'no_need')
     from _f where scn = 'ac19' and who = 'a'),
  jsonb_build_object('on_hand', 5, 'suggested_qty', 5, 'no_need', false),
  '(39) AC-19: A''s own case-A row keeps its numeric value (as spec 172 OQ-2)');

-- ═══ R10 sanity across every scenario ═══════════════════════════
select ok(
  (select bool_and(case when vendor->>'on_hand_source' = 'eod'
                        then vendor->'eod_submitted_at' <> 'null'::jsonb
                        else true end)
     from _v
    where vendor_id in (current_setting('test.a', true), current_setting('test.b', true))),
  '(40) R10: an ''eod''-sourced vendor always has its own eod_submitted_at');
select ok(
  (select bool_and(case when item->'on_hand_borrowed_from' <> 'null'::jsonb
                        then item->>'item_on_hand_source' = 'eod'
                             and not (item->'flags' ? 'eod_missing_for_item')
                        else true end)
     from _f),
  '(41) §4: a borrowed row is always ''eod''-sourced and never flagged eod_missing_for_item');

-- ═══ S1 — vendor badge when every surfaced row is non-own-EOD ═══
select is(
  (select array_agg(item_id) from _r where scn = 's1o' and vendor_id = current_setting('test.b', true)),
  array[current_setting('test.f', true)],
  '(42) S1 omit: B''s only surfaced row is F (its own G count is at par)'
);
select is(
  (select jsonb_build_object('on_hand', (item->>'on_hand')::numeric,
                             'source',  item->>'item_on_hand_source')
     from _f where scn = 's1o' and who = 'b'),
  jsonb_build_object('on_hand', 5, 'source', 'eod'),
  '(43) S1 omit: B''s F row quantity is correct (borrowed 5, per-item ''eod'')'
);
select is(
  (select jsonb_build_object('on_hand_source',   vendor->>'on_hand_source',
                             'eod_submitted_at', (vendor->>'eod_submitted_at')::timestamptz)
     from _v where scn = 's1o' and vendor_id = current_setting('test.b', true)),
  jsonb_build_object('on_hand_source', 'stock',
                     'eod_submitted_at', '2001-01-01 11:00+00'::timestamptz),
  '(44) S1 omit (pinned, accepted): B badges ''stock'' WITH a non-null eod_submitted_at'
);
select is(
  (select array_agg(item_id) from _r where scn = 's1d' and vendor_id = current_setting('test.b', true)),
  array[current_setting('test.g', true)],
  '(45) S1 drop: coincident — B''s own-counted F is dropped; only uncounted G surfaces'
);
select is(
  (select jsonb_build_object('on_hand_source',   vendor->>'on_hand_source',
                             'eod_submitted_at', (vendor->>'eod_submitted_at')::timestamptz)
     from _v where scn = 's1d' and vendor_id = current_setting('test.b', true)),
  jsonb_build_object('on_hand_source', 'stock',
                     'eod_submitted_at', '2001-01-01 11:00+00'::timestamptz),
  '(46) S1 drop (pinned, accepted): B badges ''stock'' WITH a non-null eod_submitted_at'
);

select * from finish();
rollback;
