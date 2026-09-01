-- supabase/tests/auto_place_order_attempts.test.sql
--
-- Spec 162 — pgTAP coverage for the auto-place backend
-- (supabase/migrations/20260829000000_auto_place_order_attempts.sql).
--
-- This RPC is the hinge of a feature that spends real money, so the arms below
-- are deliberately about REFUSALS and NON-EFFECTS as much as about happy paths:
--
--   shape:
--     (S1) vendor_order_attempts exists with the outcome CHECK;
--     (S2) notifications.type CHECK admits 'order_failed' AND still admits
--          every legacy value (the drop/re-add pattern's regression risk);
--     (S3) RLS is enabled and there is NO client INSERT policy — writes are the
--          SECURITY DEFINER RPC's alone.
--
--   record_vendor_order_attempt:
--     (F1) a 'failed' attempt records exactly one row;
--     (F2) …and LEAVES the PO draft (nothing was ordered);
--     (F3) …and DROPS any vendor_order_number handed to it (AC-5);
--     (F4) …and emits exactly one 'order_failed' notification;
--     (F5) …whose actor_user_id is NULL, so the spec-120 push fan-out does not
--          exclude the operator who walked away;
--     (F6) …whose body carries "<vendor> · <reason>";
--     (I1) a replayed client_uuid returns the SAME attempt id;
--     (I2) …and creates NO second row (and therefore no second notification);
--     (P1) a 'placed' attempt flips the PO draft → sent;
--     (P2) …and stores the vendor order number;
--     (P3) …and emits NO 'order_failed' notification;
--     (G1) a caller who cannot see the PO's store is REFUSED (P0001) — the gate
--          fires before any side effect;
--     (G2) …and that refusal wrote NO attempt row;
--     (V1) an invalid outcome is refused (P0001).
--
--   grants (the anon-inheritance trap):
--     (GR1) anon CANNOT execute record_vendor_order_attempt;
--     (GR2) authenticated CAN.
--           `revoke ... from anon` alone does NOT achieve (GR1): CREATE FUNCTION
--           grants EXECUTE to PUBLIC and anon inherits it, so the revoke must
--           name `public`. This shipped wrong once and was caught by a prod
--           has_function_privilege check, not by a test — hence this arm.
--
--   stage/TS lockstep:
--     (ST1) the stage CHECK accepts EVERY stage the extension's CheckoutStage
--           union can emit. A stage the TS produces but the CHECK rejects turns
--           a routine failure into a LOST one — the insert raises, so no row, no
--           notification, no email, on the exact path whose only job is telling
--           someone the order didn't happen.
--
-- Fixtures created INSIDE the transaction (hermetic under seed AND CI-fresh).
-- The 2222 manager is a Frederick member, NOT Charles — the (G1) outsider arm
-- uses a Charles PO. No `set role anon` (segfaults CI per spec 067).
-- Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(24);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_charles    uuid;
  v_brand_id   uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
end $$;

-- ─── (S1)–(S3) shape + posture (metadata, RLS-free) ────────────
select has_table('vendor_order_attempts', 'spec 162: vendor_order_attempts table exists');

select is(
  (select count(*)::int
     from pg_constraint
    where conrelid = 'public.vendor_order_attempts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%outcome%placed%failed%'),
  1,
  '(S1) outcome is constrained to placed|failed'
);

-- The drop/re-add widening must ADD 'order_failed' without losing a legacy
-- value. A lost value would make every existing emitter start failing.
select ok(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.notifications'::regclass and conname = 'notifications_type_check')
    like '%order_failed%',
  '(S2a) notifications.type CHECK admits order_failed'
);
select ok(
  (select bool_and((select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.notifications'::regclass and conname = 'notifications_type_check') like '%' || t || '%')
     from unnest(array['eod','weekly','waste','receiving','po','missed_eod','issue','order_ready']) t),
  '(S2b) …and still admits all eight legacy values'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.vendor_order_attempts'::regclass),
  '(S3a) RLS is enabled on vendor_order_attempts'
);
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'vendor_order_attempts'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')),
  0,
  '(S3b) no client INSERT/UPDATE/DELETE policy — the RPC owns every write'
);

-- ─── a Frederick draft PO and a Charles draft PO ───────────────
do $$
declare v_vendor uuid; v_po uuid; v_po_charles uuid;
begin
  insert into public.vendors (id, name, brand_id, extension_ordering)
  values (gen_random_uuid(), '__spec162_vendor__', current_setting('test.brand_id', true)::uuid, true)
  returning id into v_vendor;

  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid, v_vendor,
          current_setting('test.master_id', true)::uuid, 'draft', 99.00)
  returning id into v_po;

  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.charles_id', true)::uuid, v_vendor,
          current_setting('test.master_id', true)::uuid, 'draft', 55.00)
  returning id into v_po_charles;

  perform set_config('test.vendor',     v_vendor::text,     true);
  perform set_config('test.po',         v_po::text,         true);
  perform set_config('test.po_charles', v_po_charles::text, true);
end $$;

-- ─── impersonate the Frederick member (2222) ───────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.manager_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

-- ─── (F1)–(F6) the FAILED path ─────────────────────────────────
select lives_ok(
  $$select public.record_vendor_order_attempt(
      current_setting('test.po', true)::uuid, 'failed', 'cap-check',
      'The cart total is $812.40, over the $500.00 spend cap.',
      812.40, 500.00, 'SHOULD-BE-DROPPED', '00000000-0000-0000-0000-00000000f001')$$,
  '(F1) a failed attempt records without raising'
);

set local role postgres;

select is(
  (select status from public.purchase_orders where id = current_setting('test.po', true)::uuid),
  'draft',
  '(F2) a failed attempt LEAVES the PO draft — nothing was ordered'
);

select is(
  (select vendor_order_number from public.vendor_order_attempts
    where client_uuid = '00000000-0000-0000-0000-00000000f001'),
  null,
  '(F3) an order number handed in with a FAILURE is dropped (AC-5)'
);

select is(
  (select count(*)::int from public.notifications
    where type = 'order_failed'
      and source_id = (select id from public.vendor_order_attempts
                        where client_uuid = '00000000-0000-0000-0000-00000000f001')),
  1,
  '(F4) exactly one order_failed notification, keyed on the ATTEMPT id'
);

select is(
  (select actor_user_id from public.notifications
    where source_id = (select id from public.vendor_order_attempts
                        where client_uuid = '00000000-0000-0000-0000-00000000f001')),
  null,
  '(F5) actor_user_id is NULL so the push fan-out does not exclude the operator'
);

select ok(
  (select body from public.notifications
    where source_id = (select id from public.vendor_order_attempts
                        where client_uuid = '00000000-0000-0000-0000-00000000f001'))
    like '\_\_spec162\_vendor\_\_ · %spend cap%',
  '(F6) body carries "<vendor> · <reason>"'
);

-- ─── (I1)–(I2) idempotency ─────────────────────────────────────
set local role authenticated;
select is(
  (select public.record_vendor_order_attempt(
     current_setting('test.po', true)::uuid, 'failed', 'cap-check', 'replay',
     812.40, 500.00, null, '00000000-0000-0000-0000-00000000f001')),
  (select id from public.vendor_order_attempts where client_uuid = '00000000-0000-0000-0000-00000000f001'),
  '(I1) a replayed client_uuid returns the SAME attempt id'
);

set local role postgres;
select is(
  (select count(*)::int from public.vendor_order_attempts
    where client_uuid = '00000000-0000-0000-0000-00000000f001'),
  1,
  '(I2) …and writes no second row, so a retry cannot double-notify'
);

-- ─── (P1)–(P3) the PLACED path ─────────────────────────────────
set local role authenticated;
select lives_ok(
  $$select public.record_vendor_order_attempt(
      current_setting('test.po', true)::uuid, 'placed', 'confirm',
      'confirmed order BJ-98765', 412.10, 500.00, 'BJ-98765',
      '00000000-0000-0000-0000-00000000f002')$$,
  '(P0) a placed attempt records without raising'
);

set local role postgres;
select is(
  (select status from public.purchase_orders where id = current_setting('test.po', true)::uuid),
  'sent',
  '(P1) a placed attempt flips the PO draft → sent'
);
select is(
  (select vendor_order_number from public.vendor_order_attempts
    where client_uuid = '00000000-0000-0000-0000-00000000f002'),
  'BJ-98765',
  '(P2) …and stores the vendor order number'
);
select is(
  (select count(*)::int from public.notifications
    where type = 'order_failed'
      and source_id = (select id from public.vendor_order_attempts
                        where client_uuid = '00000000-0000-0000-0000-00000000f002')),
  0,
  '(P3) …and emits no order_failed notification'
);

-- ─── (G1)–(G2) the store gate, and (V1) the outcome guard ──────
-- The 2222 manager is a Frederick member; the Charles PO is invisible to them.
set local role authenticated;
select throws_ok(
  $$select public.record_vendor_order_attempt(
      current_setting('test.po_charles', true)::uuid, 'failed', 'error', 'probe',
      null, null, null, '00000000-0000-0000-0000-00000000f003')$$,
  'P0001',
  'not authorized for this store',
  '(G1) a caller who cannot see the store is refused'
);

select throws_ok(
  $$select public.record_vendor_order_attempt(
      current_setting('test.po', true)::uuid, 'shipped', 'confirm', 'probe',
      null, null, null, '00000000-0000-0000-0000-00000000f004')$$,
  'P0001',
  'invalid outcome shipped',
  '(V1) an outcome outside placed|failed is refused'
);

set local role postgres;
select is(
  (select count(*)::int from public.vendor_order_attempts
    where client_uuid in ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000f004')),
  0,
  '(G2) a refused call writes NO attempt row — the gate fires before any side effect'
);

-- ─── (ST1) every stage the extension can emit is accepted ──────
-- The extension's CheckoutStage union (extension/src/core/checkout.ts) and this
-- CHECK have to stay in lockstep: a stage the TS can produce but the CHECK
-- rejects turns a routine failure into a LOST failure — the attempt insert
-- raises, so no row, no notification and no email, on the exact path whose only
-- job is telling someone the order didn't happen.
set local role postgres;
select is(
  (select count(*)::int from unnest(array[
     'cart-verify','cap-check','address-verify','card-verify',
     'checkout-nav','place','confirm','challenge','error'
   ]) s
   where (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.vendor_order_attempts'::regclass
             and pg_get_constraintdef(oid) ilike '%stage%') not like '%''' || s || '''%'),
  0,
  '(ST1) the stage CHECK accepts every stage the extension can emit'
);

-- ─── (GR1)-(GR2) the grant shape, not the intent ───────────────
set local role postgres;
select ok(
  not has_function_privilege('anon',
    'public.record_vendor_order_attempt(uuid,text,text,text,numeric,numeric,text,uuid)'::regprocedure, 'execute'),
  '(GR1) anon CANNOT execute record_vendor_order_attempt (revoke must name PUBLIC, not just anon)'
);
select ok(
  has_function_privilege('authenticated',
    'public.record_vendor_order_attempt(uuid,text,text,text,numeric,numeric,text,uuid)'::regprocedure, 'execute'),
  '(GR2) authenticated CAN — the revoke-from-PUBLIC did not over-reach'
);

select * from finish();
rollback;
