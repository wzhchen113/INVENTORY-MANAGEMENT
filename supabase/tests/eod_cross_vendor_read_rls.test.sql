-- supabase/tests/eod_cross_vendor_read_rls.test.sql
--
-- Spec 200 AC-16 — the staff EOD "count a shared item once" overlay reads
-- OTHER vendors' submitted submissions at the active store
-- (src/screens/staff/lib/borrowSources.ts, fetchBorrowSources). No policy
-- change ships with spec 200; this file pins that the EXISTING store-scoped
-- SELECT policies admit that read and nothing wider:
--
--   store_member_read_eod_submissions — auth_can_see_store(store_id)
--   store_member_read_eod_entries     — scoped through the parent's store
--   (20260504173035_per_store_rls_hardening.sql L66-95).
--
-- staff_role_eod_rls.test.sql already pins a member's same-store read with a
-- single vendor; no suite pinned a cross-VENDOR read, hence this file.
--
-- Principal: the seed manager@local.test (2222…, profiles.role = 'user',
-- user_stores = Towson + Frederick) — the same principal as
-- staff_role_eod_rls.test.sql and eod_no_need.test.sql. Charles is the
-- non-member store.
--
-- Fixtures (as postgres, inside the transaction): two FRESH vendors A and B
-- in the Frederick brand; vendor A's 'submitted' submission at Frederick
-- (two entries: one numeric, one NO NEED) and at Charles (one entry), plus
-- vendor B's 'submitted' submission at Frederick — all on a synthetic date
-- (2001-04-04), so no seed / smoke residue can collide (the vendors are new).
--
-- No `set role anon` (segfaults CI per spec 067). Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(7);

-- ─── fixtures (as postgres) ─────────────────────────────────────
do $$
declare
  v_frederick   uuid;
  v_charles     uuid;
  v_brand       uuid;
  v_a           uuid;
  v_b           uuid;
  v_fred_item1  uuid;
  v_fred_item2  uuid;
  v_charles_item uuid;
  v_sub_fa      uuid;
  v_sub_fb      uuid;
  v_sub_ca      uuid;
  v_tag         text := substr(gen_random_uuid()::text, 1, 8);
begin
  select id, brand_id into v_frederick, v_brand from public.stores where name = 'Frederick' limit 1;
  select id into v_charles from public.stores where name = 'Charles' limit 1;

  insert into public.vendors (name, brand_id) values ('SPEC200-A-' || v_tag, v_brand) returning id into v_a;
  insert into public.vendors (name, brand_id) values ('SPEC200-B-' || v_tag, v_brand) returning id into v_b;

  select id into v_fred_item1 from public.inventory_items where store_id = v_frederick order by id limit 1;
  select id into v_fred_item2 from public.inventory_items where store_id = v_frederick order by id offset 1 limit 1;
  select id into v_charles_item from public.inventory_items where store_id = v_charles order by id limit 1;

  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (v_frederick, '2001-04-04'::date, v_a, 'submitted', gen_random_uuid())
  returning id into v_sub_fa;
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (v_frederick, '2001-04-04'::date, v_b, 'submitted', gen_random_uuid())
  returning id into v_sub_fb;
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (v_charles, '2001-04-04'::date, v_a, 'submitted', gen_random_uuid())
  returning id into v_sub_ca;

  insert into public.eod_entries (submission_id, item_id, actual_remaining, actual_remaining_each)
  values (v_sub_fa, v_fred_item1, 5, 5);
  insert into public.eod_entries (submission_id, item_id, no_need)
  values (v_sub_fa, v_fred_item2, true);
  insert into public.eod_entries (submission_id, item_id, actual_remaining, actual_remaining_each)
  values (v_sub_fb, v_fred_item2, 3, 3);
  insert into public.eod_entries (submission_id, item_id, actual_remaining, actual_remaining_each)
  values (v_sub_ca, v_charles_item, 9, 9);

  perform set_config('test.manager_id',   '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.frederick_id', v_frederick::text, true);
  perform set_config('test.charles_id',   v_charles::text,   true);
  perform set_config('test.v_a',          v_a::text,         true);
  perform set_config('test.v_b',          v_b::text,         true);
  perform set_config('test.sub_fa',       v_sub_fa::text,    true);
  perform set_config('test.sub_ca',       v_sub_ca::text,    true);
end $$;

-- Precondition (as postgres): the fixture holds what the member arms expect,
-- so a 0-row member read below can only mean RLS denied it.
select is(
  (select count(*)::int from public.eod_entries
    where submission_id in (current_setting('test.sub_fa', true)::uuid,
                            current_setting('test.sub_ca', true)::uuid)),
  3,
  '(pre) fixture: A has 2 Frederick entries + 1 Charles entry'
);

-- ─── Impersonate the staff user (manager@local.test, role=user) ─
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.manager_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

-- (1) The member reads vendor A's submitted row at their store.
select is(
  (select count(*)::int from public.eod_submissions
    where id = current_setting('test.sub_fa', true)::uuid),
  1,
  '(1) member of Frederick can SELECT vendor A''s eod_submissions row at Frederick'
);

-- (2) The borrow-source read shape (store, date, status = submitted, ANY
--     vendor) returns BOTH vendors' rows — the read is store-scoped, not
--     vendor-scoped.
select is(
  (select count(*)::int from public.eod_submissions
    where store_id = current_setting('test.frederick_id', true)::uuid
      and date = '2001-04-04'::date
      and status = 'submitted'
      and vendor_id in (current_setting('test.v_a', true)::uuid,
                        current_setting('test.v_b', true)::uuid)),
  2,
  '(2) the borrow-source read at Frederick returns vendor A''s AND vendor B''s submissions'
);

-- (3) The member reads A's entries at their store, NO NEED included.
select is(
  (select count(*)::int from public.eod_entries
    where submission_id = current_setting('test.sub_fa', true)::uuid),
  2,
  '(3) member of Frederick can SELECT vendor A''s eod_entries at Frederick'
);

select is(
  (select count(*)::int from public.eod_entries
    where submission_id = current_setting('test.sub_fa', true)::uuid
      and no_need),
  1,
  '(4) the NO NEED entry is visible (a borrowed NO NEED counts the item)'
);

-- (5) + (6) A store the member does not belong to reads 0 rows for both.
select is(
  (select count(*)::int from public.eod_submissions
    where store_id = current_setting('test.charles_id', true)::uuid
      and date = '2001-04-04'::date
      and vendor_id = current_setting('test.v_a', true)::uuid),
  0,
  '(5) non-member store (Charles): vendor A''s eod_submissions row reads 0 rows'
);

select is(
  (select count(*)::int from public.eod_entries
    where submission_id = current_setting('test.sub_ca', true)::uuid),
  0,
  '(6) non-member store (Charles): vendor A''s eod_entries read 0 rows'
);

select * from finish();
rollback;
