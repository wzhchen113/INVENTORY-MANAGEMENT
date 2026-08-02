-- supabase/tests/order_ready_notifications.test.sql
--
-- Spec 149 — pgTAP coverage for the 'order_ready' notification type shipped in
-- supabase/migrations/20260801000200_order_ready_notification_type.sql.
--
-- Plan (10 arms):
--   CHECK widening (AC-1)
--     (N1) notifications.type accepts the new 'order_ready'.
--     (N2) it STILL accepts all eight legacy values (eod, weekly, waste,
--          receiving, po, missed_eod, issue) — additive only, no row invalidated.
--     (N3) it still REJECTS an unknown value (23514).
--   Emit + the exclusive branch (AC-2 / AC-3 / R-1)
--     (E1) an eod_submissions INSERT at status='submitted' whose vendor has
--          below-par items emits exactly ONE 'order_ready'.
--     (E2) …and ZERO 'eod' for that same submission — order_ready REPLACES the
--          routine spec-120 notification (AC-3, no double ping).
--     (E3) the row denormalizes body = VENDOR NAME (the spec-126 free-text slot),
--          store_name, actor_name and actor_user_id (an order_ready HAS an actor,
--          unlike missed_eod — that is what makes the fan-out exclude the
--          submitter).
--     (E4) a submission whose vendor has NO below-par item emits exactly ONE
--          'eod' …
--     (E5) …and ZERO 'order_ready' — the other side of the exclusive branch.
--     (E6) exactly ONE notification total per submission event, either way.
--   Dedupe (AC-2)
--     (D1) a repeat emit_order_ready for the same (type, source_id) does NOT
--          double-insert — re-submission / re-run is a no-op.
--
-- NOTE ON THE PREDICATE'S ON-HAND SOURCE: the notify_eod_submission trigger is
-- AFTER INSERT on eod_submissions, and the staff RPC writes eod_entries (and
-- bumps inventory_items.current_stock) AFTER the parent row lands — so at
-- trigger time there are no entries for the submission and
-- eod_vendor_has_below_par necessarily reads the PRE-COUNT
-- inventory_items.current_stock. (The design's LEFT JOIN on eod_entries was
-- inert on every real path and was DROPPED in the post-review fix round —
-- backend-architect S-2. Zero behavior change; the predicate approximates in
-- both directions and AC-13's empty-order state is the backstop.) These
-- fixtures reproduce that real ordering exactly (submission inserted with no
-- entries).
--
-- Hermetic: begin; … rollback;. Fixtures created inside the transaction, so the
-- file is green under the committed seed AND on a CI-fresh database. The
-- trigger arms run as the default (superuser) role and count rows directly —
-- RLS scoping for public.notifications is already pinned by
-- supabase/tests/submission_notifications.test.sql and is unchanged here.

begin;
create extension if not exists pgtap;

select plan(10);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_admin_id uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_brand_a  uuid;
  v_store_a  uuid;
begin
  select id into v_brand_a from public.brands limit 1;
  select id into v_store_a from public.stores where name = 'Frederick' limit 1;
  perform set_config('test.admin_id', v_admin_id::text, true);
  perform set_config('test.brand_a',  v_brand_a::text,  true);
  perform set_config('test.store_a',  v_store_a::text,  true);
end $$;

-- Two vendors: one whose linked item is BELOW par, one whose linked item is AT
-- par. Both resolve to a non-NULL channel (every vendor does — worst case
-- 'manual'), so the branch is decided purely by eod_vendor_has_below_par.
insert into public.vendors (id, name, brand_id, order_channel, extension_ordering)
values
  ('49930000-0000-0000-0000-000000000001', '__or_vendor_below__',
   current_setting('test.brand_a', true)::uuid, null, false),
  ('49930000-0000-0000-0000-000000000002', '__or_vendor_atpar__',
   current_setting('test.brand_a', true)::uuid, null, false);

do $$
declare
  v_cat_below uuid; v_cat_atpar uuid; v_item_below uuid; v_item_atpar uuid;
begin
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (current_setting('test.brand_a', true)::uuid,
          'SPEC149-BELOW-'||gen_random_uuid()::text, 'each', 6, 1, 1.25)
  returning id into v_cat_below;

  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (current_setting('test.brand_a', true)::uuid,
          'SPEC149-ATPAR-'||gen_random_uuid()::text, 'each', 1, 1, 0.50)
  returning id into v_cat_atpar;

  -- BELOW par: par 10, on hand 2 ⇒ par_replacement = 8 > 0.
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level)
  values (current_setting('test.store_a', true)::uuid, v_cat_below,
          '49930000-0000-0000-0000-000000000001', 1.25, 2, 10)
  returning id into v_item_below;

  -- AT par: par 0, on hand 5 ⇒ par_replacement = -5 ⇒ not below par.
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level)
  values (current_setting('test.store_a', true)::uuid, v_cat_atpar,
          '49930000-0000-0000-0000-000000000002', 0.50, 5, 0)
  returning id into v_item_atpar;

  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
  values (v_item_below, '49930000-0000-0000-0000-000000000001', 1.25, 7.50, true),
         (v_item_atpar, '49930000-0000-0000-0000-000000000002', 0.50, 0.50, true);
end $$;


-- ─── (N1/N2/N3) the CHECK widening (AC-1) ──────────────────────
select lives_ok(
  format($q$insert into public.notifications
             (brand_id, store_id, type, source_id, store_name)
           values (%L::uuid, %L::uuid, 'order_ready',
                   '49940000-0000-0000-0000-0000000000a1'::uuid, 'Fixture')$q$,
         current_setting('test.brand_a', true), current_setting('test.store_a', true)),
  '(N1) AC-1 — notifications.type accepts the new ''order_ready'' value'
);

select lives_ok(
  format($q$insert into public.notifications
             (brand_id, store_id, type, source_id, store_name)
           select %L::uuid, %L::uuid, t.type,
                  ('49940000-0000-0000-0000-0000000000b' || t.ord)::uuid, 'Fixture'
             from (values ('eod',1),('weekly',2),('waste',3),('receiving',4),
                          ('po',5),('missed_eod',6),('issue',7))
                  as t(type, ord)$q$,
         current_setting('test.brand_a', true), current_setting('test.store_a', true)),
  '(N2) AC-1 — all seven legacy types are STILL accepted (additive widening, no row invalidated)'
);

select throws_ok(
  format($q$insert into public.notifications
             (brand_id, store_id, type, source_id, store_name)
           values (%L::uuid, %L::uuid, 'order_placed',
                   '49940000-0000-0000-0000-0000000000c1'::uuid, 'Fixture')$q$,
         current_setting('test.brand_a', true), current_setting('test.store_a', true)),
  '23514',
  null,
  '(N3) AC-1 — notifications_type_check still rejects an unknown type'
);


-- ─── (E1/E2/E3/E6) the below-par branch ⇒ order_ready ──────────
-- eod_submissions carries a BEFORE INSERT trigger
-- (eod_submissions_set_submitted_by) that OVERRIDES submitted_by with
-- auth.uid(), so the explicit column value below is ignored. Set the JWT claim
-- (staying on the superuser role, so the fixture inserts are still RLS-free) or
-- every emitted notification lands with a NULL actor — which would silently
-- weaken arm (E3) into asserting nothing.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

insert into public.eod_submissions (id, store_id, date, vendor_id, submitted_by, status)
values ('49950000-0000-0000-0000-000000000001',
        current_setting('test.store_a', true)::uuid,
        date '2026-08-01',
        '49930000-0000-0000-0000-000000000001',
        current_setting('test.admin_id', true)::uuid,
        'submitted');

select is(
  (select count(*)::int from public.notifications
    where type = 'order_ready'
      and source_id = '49950000-0000-0000-0000-000000000001'),
  1,
  '(E1) AC-2 — a submission whose vendor has below-par items emits exactly ONE order_ready'
);

select is(
  (select count(*)::int from public.notifications
    where type = 'eod'
      and source_id = '49950000-0000-0000-0000-000000000001'),
  0,
  '(E2) AC-3 — order_ready REPLACES the routine eod notification (no double ping)'
);

select is(
  (select format('%s|%s|%s|%s',
                 n.body,
                 n.store_name,
                 coalesce(n.actor_name, '<null>'),
                 (n.actor_user_id = current_setting('test.admin_id', true)::uuid)::text)
     from public.notifications n
    where n.type = 'order_ready'
      and n.source_id = '49950000-0000-0000-0000-000000000001'),
  format('__or_vendor_below__|%s|%s|true',
         (select name from public.stores where id = current_setting('test.store_a', true)::uuid),
         (select coalesce(username, name) from public.profiles
           where id = current_setting('test.admin_id', true)::uuid)),
  '(E3) the order_ready row denormalizes body=<vendor name>, store_name, actor_name and actor_user_id'
);

select is(
  (select count(*)::int from public.notifications
    where source_id = '49950000-0000-0000-0000-000000000001'),
  1,
  '(E6a) exactly ONE notification total for the below-par submission event'
);


-- ─── (E4/E5) the at-par branch ⇒ the routine eod notification ──
insert into public.eod_submissions (id, store_id, date, vendor_id, submitted_by, status)
values ('49950000-0000-0000-0000-000000000002',
        current_setting('test.store_a', true)::uuid,
        date '2026-08-01',
        '49930000-0000-0000-0000-000000000002',
        current_setting('test.admin_id', true)::uuid,
        'submitted');

select is(
  (select count(*)::int from public.notifications
    where type = 'eod'
      and source_id = '49950000-0000-0000-0000-000000000002'),
  1,
  '(E4) AC-3 — a vendor with NO below-par item still emits exactly ONE routine eod notification'
);

select is(
  (select count(*)::int from public.notifications
    where type = 'order_ready'
      and source_id = '49950000-0000-0000-0000-000000000002'),
  0,
  '(E5) AC-3 — …and ZERO order_ready (the branch is exclusive in BOTH directions)'
);


-- ─── (D1) dedupe on (type, source_id) (AC-2) ───────────────────
select public.emit_order_ready(
  current_setting('test.store_a', true)::uuid,
  '49930000-0000-0000-0000-000000000001'::uuid,
  '__or_vendor_below__',
  current_setting('test.admin_id', true)::uuid,
  '49950000-0000-0000-0000-000000000001'::uuid
);

select is(
  (select count(*)::int from public.notifications
    where type = 'order_ready'
      and source_id = '49950000-0000-0000-0000-000000000001'),
  1,
  '(D1) AC-2 — a repeat emit for the same (type, source_id) is deduped (on conflict do nothing)'
);

select finish();
rollback;
