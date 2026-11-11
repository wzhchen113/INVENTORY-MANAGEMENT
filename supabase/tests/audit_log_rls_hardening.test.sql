-- supabase/tests/audit_log_rls_hardening.test.sql
--
-- Spec 170 / pgTAP regression for the audit_log RLS hardening shipped in:
--   supabase/migrations/20261022000000_audit_log_rls_hardening.sql
--
-- Closes spec 167 security-auditor M2 (staff can read store-user audit rows)
-- and M3 (audit rows can be forged / edited / erased), plus spec 157
-- OQ-3 / FUTURE-1 (unscoped admin UPDATE/DELETE), plus spec 170
-- security-auditor M1 (client-settable created_at; owner decision 9).
--
-- Arm map (61). The 45 arms of spec 170 §10a, plus 9 added in the review
-- fix pass (plan 45 -> 54, as §10a allows), plus 7 from spec 187:
--   +8  C-1..C-8   created_at pinned to now() on INSERT (M1, AC-22/AC-23)
--   +1  D-10       DELETE store/brand scope isolated from the SELECT mask
--                  (test-engineer Finding 1 Option A / architect SF-1)
--   +7  UD-1..UD-7 'User deleted' is server-only and hidden from staff
--                  (spec 187 AC-20, AC-21)
--
--   S-1..S-7    policy shape (AC-1, AC-2) + owner-bypass precondition (§2)
--   F-1         fixture sanity (AC-3)
--   R-1..R-4    SELECT: staff cannot read store-user rows, can read others;
--               admin + super_admin read both (AC-3..AC-5)
--   I-1..I-16   INSERT: actor-is-caller for staff (AC-6/7), server-only
--               actions refused for every RLS-subject role (AC-8), admin
--               on-behalf attribution still admitted (AC-9)
--   W-1..W-6    the RLS-bypassing writers + the staff INVOKER PO RPC still
--               write their audit rows (AC-10)
--   U-1..U-2    UPDATE affects 0 rows for privileged callers (AC-11)
--   C-1..C-8    INSERT: explicit future / NULL / past created_at refused
--               for staff and admin (42501); omitted created_at (column
--               default now()) still admitted (AC-22, AC-23)
--   D-1..D-9    DELETE: fresh rows not deletable, 91-day rows deletable in
--               scope only, store-less rows super_admin only, staff never,
--               store FK cascade bypasses RLS (AC-12..AC-17)
--   D-10        DELETE scope with the SELECT mask removed by an in-txn
--               probe_wide_select policy (AC-14, clause-isolating)
--
-- D-4 vs D-10: a DELETE whose WHERE references a column also applies the
-- SELECT policies, and store_member_read_audit_log already hides brand-B
-- rows from a brand-A admin. So D-4 passes under the SELECT mask alone and
-- cannot tell the spec 170 DELETE scope from spec 157's unscoped policy.
-- D-10 adds a permissive `using (true)` SELECT policy inside the txn (as
-- postgres), so only admin_delete_audit_log's auth_can_see_store(store_id)
-- clause can refuse. The probe is dropped right after the D-10 attempt so it
-- cannot mask any later arm; the txn rollback removes it as well, and
-- permissive_policy_lint.test.sql runs in its own txn and never sees it.
--
-- Principals (seed):
--   staff        22222222-… profiles.role='user', user_stores grant on Towson
--   admin        11111111-… profiles.role='admin', brand A, JWT 'admin'
--   super_admin  33333333-… (seed master) promoted in-txn to
--                role='super_admin', brand_id=NULL; JWT app_metadata.role
--                'user' so the admit path is provably auth_is_super_admin()
--                (mirrors super_admin_policy_parity.test.sql).
--   S1           Towson 00000000-…-0001 (brand A)
--   SB           test-only store in a test-only brand B
--   S_tmp1/2     test-only brand-A stores for the cascade arms (D-8, D-9)
--
-- Old rows: created_at is set at INSERT time as postgres (there is no UPDATE
-- path any more). now() is the transaction start, so fixtures and policy
-- evaluation share one clock and the 90-day boundary is deterministic.
--
-- Read-back rule: every UPDATE/DELETE OUTCOME is asserted in the final
-- `reset role` superuser block, keyed by fixture id, one fixture row per
-- (caller, arm). A "row survives" check run as a caller that cannot see the
-- row would pass vacuously.
--
-- AC-17 interpretation (spec 170 §10a): D-8 deletes a test-only brand-A store
-- rather than seed Towson (whose cascade would touch every per-store table).
-- D-9 repeats it on the production path (admin JWT through
-- privileged_delete_stores) to prove the FK cascade bypasses the audit_log
-- DELETE policy, which refuses fresh rows.
--
-- Hermetic begin; ... rollback; isolation. The seed is untouched. The two
-- in-txn GRANTs (W-2, W-3) roll back with the transaction.

begin;
create extension if not exists pgtap;

select plan(61);

-- ── constants ─────────────────────────────────────────────────────────────
do $$
begin
  perform set_config('test.staff_id',  '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.admin_id',  '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.super_id',  '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.brand_a',   '2a000000-0000-0000-0000-000000000001', true);
  perform set_config('test.brand_b',   'b1700000-0000-0000-0000-000000000001', true);
  perform set_config('test.s1',        '00000000-0000-0000-0000-000000000001', true);
  perform set_config('test.sb',        'b1700000-0000-0000-0000-000000000002', true);
  perform set_config('test.s_tmp1',    'b1700000-0000-0000-0000-000000000003', true);
  perform set_config('test.s_tmp2',    'b1700000-0000-0000-0000-000000000004', true);
  perform set_config('test.vendor',    'b1ee724a-8626-45ab-85d4-14a99e7cbc45', true);  -- seed BJs (brand A)
  perform set_config('test.item_name', '__test_spec170_item__', true);
end $$;

-- ── principals ────────────────────────────────────────────────────────────
-- Runs as the postgres superuser: auth.uid() is NULL, so the
-- profiles_self_brand_lock trigger's self-edit branch does not fire.
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.super_id', true)::uuid;

-- ── brand B + test-only stores ────────────────────────────────────────────
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 170)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time) values
  (current_setting('test.sb', true)::uuid,     current_setting('test.brand_b', true)::uuid,
   'Foreign Store (test 170)', '1 Foreign Way', 'active', '22:00'),
  (current_setting('test.s_tmp1', true)::uuid, current_setting('test.brand_a', true)::uuid,
   'Cascade Store 1 (test 170)', '1 Cascade Way', 'active', '22:00'),
  (current_setting('test.s_tmp2', true)::uuid, current_setting('test.brand_a', true)::uuid,
   'Cascade Store 2 (test 170)', '2 Cascade Way', 'active', '22:00');

-- ── audit_log fixtures (as postgres; RLS bypassed for setup) ──────────────
-- user_id NULL keeps the profiles FK out of the picture.
insert into public.audit_log (id, store_id, user_id, action, detail, created_at) values
  -- F-1 / R-* visibility fixtures (fresh, S1)
  ('a5000170-0000-0000-0000-000000000001', current_setting('test.s1', true)::uuid, null,
   'Store user created',      '__test_spec170_fixture__', now()),
  ('a5000170-0000-0000-0000-000000000002', current_setting('test.s1', true)::uuid, null,
   'Store user password set', '__test_spec170_fixture__', now()),
  ('a5000170-0000-0000-0000-000000000003', current_setting('test.s1', true)::uuid, null,
   'PO received',             '__test_spec170_fixture__', now()),
  ('a5000170-0000-0000-0000-000000000004', current_setting('test.s1', true)::uuid, null,
   'EOD entry',               '__test_spec170_fixture__', now()),
  -- UD-4 / UD-5 visibility fixture (spec 187, fresh, S1)
  ('a5000170-0000-0000-0000-000000000005', current_setting('test.s1', true)::uuid, null,
   'User deleted',            '__test_spec187_fixture__', now()),
  -- U-1 (admin) / U-2 (super_admin): fresh S1
  ('a5000170-0000-0000-0000-000000000010', current_setting('test.s1', true)::uuid, null,
   '__test_spec170_u1__', '__test_spec170_original__', now()),
  ('a5000170-0000-0000-0000-000000000011', current_setting('test.s1', true)::uuid, null,
   '__test_spec170_u2__', '__test_spec170_original__', now()),
  -- D-1 (admin) / D-2 (super_admin): fresh S1
  ('a5000170-0000-0000-0000-000000000020', current_setting('test.s1', true)::uuid, null,
   '__test_spec170_d1__', '__test_spec170_original__', now()),
  ('a5000170-0000-0000-0000-000000000021', current_setting('test.s1', true)::uuid, null,
   '__test_spec170_d2__', '__test_spec170_original__', now()),
  -- D-3 (admin): 91-day S1
  ('a5000170-0000-0000-0000-000000000022', current_setting('test.s1', true)::uuid, null,
   '__test_spec170_d3__', '__test_spec170_original__', now() - interval '91 days'),
  -- D-4 (admin): 91-day brand-B store
  ('a5000170-0000-0000-0000-000000000023', current_setting('test.sb', true)::uuid, null,
   '__test_spec170_d4__', '__test_spec170_original__', now() - interval '91 days'),
  -- D-5 (admin) row X / D-6 (super_admin) row Y: 91-day store-less
  ('a5000170-0000-0000-0000-000000000024', null, null,
   '__test_spec170_d5__', '__test_spec170_original__', now() - interval '91 days'),
  ('a5000170-0000-0000-0000-000000000025', null, null,
   '__test_spec170_d6__', '__test_spec170_original__', now() - interval '91 days'),
  -- D-7 (staff): 91-day S1
  ('a5000170-0000-0000-0000-000000000026', current_setting('test.s1', true)::uuid, null,
   '__test_spec170_d7__', '__test_spec170_original__', now() - interval '91 days'),
  -- D-10 (admin, SELECT mask removed): 91-day brand-B store, separate from D-4's
  ('a5000170-0000-0000-0000-000000000027', current_setting('test.sb', true)::uuid, null,
   '__test_spec170_d10__', '__test_spec170_original__', now() - interval '91 days'),
  -- D-8: S_tmp1 fresh + 91-day
  ('a5000170-0000-0000-0000-000000000030', current_setting('test.s_tmp1', true)::uuid, null,
   '__test_spec170_d8_fresh__', '__test_spec170_original__', now()),
  ('a5000170-0000-0000-0000-000000000031', current_setting('test.s_tmp1', true)::uuid, null,
   '__test_spec170_d8_old__',   '__test_spec170_original__', now() - interval '91 days'),
  -- D-9: S_tmp2 fresh
  ('a5000170-0000-0000-0000-000000000032', current_setting('test.s_tmp2', true)::uuid, null,
   '__test_spec170_d9_fresh__', '__test_spec170_original__', now());

-- ── writer fixtures (W-1, W-2, W-4, W-6): one S1 item with a unique name ─
do $$
declare
  v_cat  uuid;
  v_item uuid;
  v_po   uuid;
  v_line uuid;
begin
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (current_setting('test.brand_a', true)::uuid, current_setting('test.item_name', true),
          'each', 4, 1, 5.00)
  returning id into v_cat;

  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion)
  values (current_setting('test.s1', true)::uuid, v_cat, current_setting('test.vendor', true)::uuid,
          20.00, 5.00, 10, 0, 0)
  returning id into v_item;

  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
  values (v_item, current_setting('test.vendor', true)::uuid, 5.00, 20.00, true)
  on conflict (item_id, vendor_id) do nothing;

  -- W-6: a sent PO on S1 with one line (no price change on receipt).
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.s1', true)::uuid, current_setting('test.vendor', true)::uuid,
          current_setting('test.admin_id', true)::uuid, 'sent', 20.00)
  returning id into v_po;
  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values (v_po, v_item, 1, null, 20.00)
  returning id into v_line;

  perform set_config('test.cat_id',  v_cat::text,  true);
  perform set_config('test.item_id', v_item::text, true);
  perform set_config('test.po_id',   v_po::text,   true);
  perform set_config('test.line_id', v_line::text, true);
end $$;

-- W-3: an S1 order_schedule row for Monday 1999-12-27 with no matching PO.
insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (current_setting('test.s1', true)::uuid, 'Monday',
        current_setting('test.vendor', true)::uuid, 'BJs', 'Tuesday');

-- W-2 / W-3: make the service_role-only DEFINER RPCs callable from an
-- RLS-subject role (rolled back with the txn). Calling them as staff is what
-- makes the arms sharp: under caller RLS, (c) would refuse W-2's NULL actor
-- and (b) would refuse W-3's 'Order missed'.
grant execute on function public.staff_log_waste(uuid, uuid, uuid, numeric, text, text, text, text) to authenticated;
grant execute on function public.record_missed_orders_for_day(date) to authenticated;


-- ══════════════════════════════════════════════════════════════════════════
-- Policy shape (postgres)
-- ══════════════════════════════════════════════════════════════════════════

-- S-1 (AC-1)
select is(
  (select string_agg(policyname || '/' || cmd || '/' || permissive, ', ' order by policyname)
     from pg_policies
    where schemaname = 'public' and tablename = 'audit_log'),
  'admin_delete_audit_log/DELETE/PERMISSIVE, '
  || 'audit_log_restrict_insert_actor_is_caller/INSERT/RESTRICTIVE, '
  || 'audit_log_restrict_insert_created_at_now/INSERT/RESTRICTIVE, '
  || 'audit_log_restrict_insert_server_only_actions/INSERT/RESTRICTIVE, '
  || 'audit_log_restrict_select_store_user_actions/SELECT/RESTRICTIVE, '
  || 'store_member_insert_audit_log/INSERT/PERMISSIVE, '
  || 'store_member_read_audit_log/SELECT/PERMISSIVE',
  'S-1: audit_log has exactly the seven expected policies (names, commands, kinds)'
);

-- S-2 (AC-1, AC-11)
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'audit_log' and cmd = 'UPDATE'),
  0,
  'S-2: no UPDATE policy on audit_log (default-deny; rows immutable via the API)'
);

-- S-3 (AC-1): literal captured from the local DB BEFORE the spec 170 migration.
select is(
  (select qual from pg_policies
    where schemaname = 'public' and tablename = 'audit_log'
      and policyname = 'store_member_read_audit_log'),
  '(((store_id IS NOT NULL) AND auth_can_see_store(store_id)) OR ((store_id IS NULL) AND auth_is_privileged()))',
  'S-3: store_member_read_audit_log USING is byte-unchanged from spec 157'
);

-- S-4 (AC-1): literal captured from the local DB BEFORE the spec 170 migration.
select is(
  (select with_check from pg_policies
    where schemaname = 'public' and tablename = 'audit_log'
      and policyname = 'store_member_insert_audit_log'),
  '(((store_id IS NOT NULL) AND auth_can_see_store(store_id)) OR ((store_id IS NULL) AND auth_is_privileged()))',
  'S-4: store_member_insert_audit_log WITH CHECK is byte-unchanged from spec 157'
);

-- S-5 (AC-1)
select ok(
  (select qual like '%auth_is_privileged()%'
      and qual like '%90 days%'
      and qual like '%auth_can_see_store(store_id)%'
      and qual like '%auth_is_super_admin()%'
      and with_check is null
     from pg_policies
    where schemaname = 'public' and tablename = 'audit_log'
      and policyname = 'admin_delete_audit_log'),
  'S-5: admin_delete_audit_log carries the scoped, 90-day age-gated predicate (no WITH CHECK)'
);

-- S-6 (AC-2)
select is(
  (select count(*)::int
     from pg_policy pol
     join pg_description d
       on d.objoid = pol.oid
      and d.classoid = 'pg_policy'::regclass
    where pol.polrelid = 'public.audit_log'::regclass
      and d.description like 'spec 170: %'),
  5,
  'S-6: five audit_log policies carry a spec 170 comment'
);

-- S-7 (§2 precondition): owner bypass for every DEFINER writer.
select ok(
  (select c.relrowsecurity and not c.relforcerowsecurity
     from pg_class c where c.oid = 'public.audit_log'::regclass)
  and (select count(*) = 5
              and bool_and(p.proowner = (select relowner from pg_class
                                          where oid = 'public.audit_log'::regclass))
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('staff_submit_eod', 'staff_log_waste',
                            'record_missed_orders_for_day', 'copy_catalog_rows',
                            'auto_receive_due_purchase_orders')),
  'S-7: audit_log RLS on, FORCE RLS off, and every SECURITY DEFINER writer is owned by the table owner (owner bypass holds)'
);

-- F-1 (AC-3 fixture)
select is(
  (select count(*)::int from public.audit_log
    where id in ('a5000170-0000-0000-0000-000000000001',
                 'a5000170-0000-0000-0000-000000000002',
                 'a5000170-0000-0000-0000-000000000003',
                 'a5000170-0000-0000-0000-000000000004')
      and store_id = current_setting('test.s1', true)::uuid),
  4,
  'F-1: fixture — S1 rows for Store user created / Store user password set / PO received / EOD entry exist'
);


-- ══════════════════════════════════════════════════════════════════════════
-- Staff block — profiles.role='user', JWT 'user', user_stores grant on S1
-- ══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.staff_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

-- R-1 (AC-3)
select is(
  (select count(*)::int from public.audit_log
    where store_id = current_setting('test.s1', true)::uuid
      and action in ('Store user created', 'Store user password set')),
  0,
  'R-1: staff on S1 sees 0 Store user created / Store user password set rows'
);

-- R-2 (AC-4)
select is(
  (select count(*)::int from public.audit_log
    where id in ('a5000170-0000-0000-0000-000000000003',
                 'a5000170-0000-0000-0000-000000000004')),
  2,
  'R-2: staff on S1 still sees ordinary S1 rows (PO received, EOD entry)'
);

-- I-1 (AC-6)
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Waste log', '__test_spec170_i1__')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  '42501',
  null,
  'I-1: staff INSERT attributed to another profile is rejected (42501)'
);

-- I-2 (AC-6)
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, null, 'Waste log', '__test_spec170_i2__')$q$,
         current_setting('test.s1', true)),
  '42501',
  null,
  'I-2: staff INSERT with user_id NULL is rejected (42501)'
);

-- I-3 (AC-7)
select lives_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Waste log', '__test_spec170_i3__')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  'I-3: staff INSERT of an ordinary action attributed to self succeeds'
);

-- I-4..I-7 (AC-8): store_id = S1 and user_id = staff, so the permissive
-- policy and (c) both pass and only (b) can refuse.
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Store user created', '__test_spec170_i4__')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  '42501', null,
  'I-4: staff INSERT of ''Store user created'' rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Store user password set', '__test_spec170_i5__')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  '42501', null,
  'I-5: staff INSERT of ''Store user password set'' rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Order missed', '__test_spec170_i6__')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  '42501', null,
  'I-6: staff INSERT of ''Order missed'' rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'catalog_copy', '__test_spec170_i7__')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  '42501', null,
  'I-7: staff INSERT of ''catalog_copy'' rejected (42501)'
);

-- C-1..C-4 (AC-22/AC-23, M1): store_id = S1, user_id = staff, ordinary
-- action, so the permissive policy, (b) and (c) all pass and only
-- audit_log_restrict_insert_created_at_now can refuse.
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail, created_at)
            values (%L, %L, 'Waste log', '__test_spec170_c1__', '2099-01-01 00:00:00+00')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  '42501', null,
  'C-1: staff INSERT with a future created_at is rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail, created_at)
            values (%L, %L, 'Waste log', '__test_spec170_c2__', null)$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  '42501', null,
  'C-2: staff INSERT with created_at NULL is rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail, created_at)
            values (%L, %L, 'PO price change', '__test_spec170_c3__', now() - interval '30 days')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  '42501', null,
  'C-3: staff INSERT with an explicit past created_at is rejected (42501)'
);
select lives_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Waste log', '__test_spec170_c4__')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  'C-4: staff INSERT with created_at omitted (column default now()) succeeds'
);

-- W-1 (AC-10): staff_submit_eod (DEFINER) writes 'EOD entry' with user_id NULL.
select public.staff_submit_eod(
  gen_random_uuid(),
  current_setting('test.s1', true)::uuid,
  '1999-12-29'::date,
  null,
  'submitted',
  jsonb_build_array(jsonb_build_object(
    'ingredient_id',    current_setting('test.item_id', true)::uuid,
    'actual_remaining', 7,
    'unit',             'each'
  )),
  current_setting('test.vendor', true)::uuid
);

select is(
  (select count(*)::int from public.audit_log
    where store_id = current_setting('test.s1', true)::uuid
      and action   = 'EOD entry'
      and item_ref = current_setting('test.item_name', true)
      and user_id is null),
  1,
  'W-1: staff_submit_eod called by staff still writes its EOD entry audit row (owner bypass)'
);

-- W-2 (AC-10): staff_log_waste (DEFINER) writes 'Waste log' with user_id NULL.
select public.staff_log_waste(
  gen_random_uuid(),
  current_setting('test.s1', true)::uuid,
  current_setting('test.item_id', true)::uuid,
  1,
  'each',
  '__test_spec170_waste__',
  null,
  null
);

select is(
  (select count(*)::int from public.audit_log
    where store_id = current_setting('test.s1', true)::uuid
      and action   = 'Waste log'
      and item_ref = current_setting('test.item_name', true)
      and user_id is null),
  1,
  'W-2: staff_log_waste called from an RLS-subject role still writes its NULL-actor Waste log row'
);

-- W-3 (AC-10): record_missed_orders_for_day (DEFINER) writes 'Order missed'.
select public.record_missed_orders_for_day('1999-12-27'::date);  -- a Monday

select cmp_ok(
  (select count(*)::int from public.audit_log
    where store_id = current_setting('test.s1', true)::uuid
      and action   = 'Order missed'
      and detail   = 'BJs order missed (1999-12-27)'),
  '>=',
  1,
  'W-3: record_missed_orders_for_day called from an RLS-subject role still writes Order missed rows'
);

-- W-6 (AC-10): receive_purchase_order (INVOKER) as staff, no price change.
select public.receive_purchase_order(
  current_setting('test.po_id', true)::uuid,
  jsonb_build_array(jsonb_build_object(
    'po_item_id',   current_setting('test.line_id', true)::uuid,
    'received_qty', 1)),
  gen_random_uuid()
);

select is(
  (select count(*)::int from public.audit_log
    where store_id = current_setting('test.s1', true)::uuid
      and action   = 'PO received'
      and detail like 'PO ' || left(current_setting('test.po_id', true), 8) || '%'
      and user_id  = current_setting('test.staff_id', true)::uuid),
  1,
  'W-6: receive_purchase_order (SECURITY INVOKER) called by staff still writes PO received with user_id = staff'
);

-- UD-1 (spec 187 AC-20). The store is visible and the actor matches, so only
-- audit_log_restrict_insert_server_only_actions can refuse.
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'User deleted', '__test_spec187_ud1__')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  '42501',
  null,
  'UD-1: staff INSERT of ''User deleted'' attributed to self is rejected (42501)'
);

-- UD-4 (spec 187 AC-21)
select is(
  (select count(*)::int from public.audit_log
    where id = 'a5000170-0000-0000-0000-000000000005'),
  0,
  'UD-4: staff on S1 sees 0 ''User deleted'' rows'
);

-- D-7 attempt: staff DELETE of a 91-day S1 row (outcome asserted as postgres).
delete from public.audit_log where id = 'a5000170-0000-0000-0000-000000000026';


-- ══════════════════════════════════════════════════════════════════════════
-- Admin block — profiles.role='admin', JWT 'admin', brand A
-- ══════════════════════════════════════════════════════════════════════════
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

-- R-3 (AC-5)
select is(
  (select count(*)::int from public.audit_log
    where id in ('a5000170-0000-0000-0000-000000000001',
                 'a5000170-0000-0000-0000-000000000002')),
  2,
  'R-3: admin (brand A) reads both store-user rows on S1'
);

-- I-8..I-11 (AC-8)
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Store user created', '__test_spec170_i8__')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  '42501', null,
  'I-8: admin INSERT of ''Store user created'' rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Store user password set', '__test_spec170_i9__')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  '42501', null,
  'I-9: admin INSERT of ''Store user password set'' rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Order missed', '__test_spec170_i10__')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  '42501', null,
  'I-10: admin INSERT of ''Order missed'' rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'catalog_copy', '__test_spec170_i11__')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  '42501', null,
  'I-11: admin INSERT of ''catalog_copy'' rejected (42501)'
);

-- I-16 (AC-9): the admin EOD on-behalf path.
select lives_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'EOD entry', '__test_spec170_i16__')$q$,
         current_setting('test.s1', true), current_setting('test.staff_id', true)),
  'I-16: admin INSERT of an ordinary action attributed to a staff profile succeeds (EOD on-behalf)'
);

-- C-5..C-8 (AC-22/AC-23, M1): privileged callers get no created_at
-- exemption. store_id = S1, user_id = admin, ordinary action.
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail, created_at)
            values (%L, %L, 'Item edit', '__test_spec170_c5__', '2099-01-01 00:00:00+00')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  '42501', null,
  'C-5: admin INSERT with a future created_at is rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail, created_at)
            values (%L, %L, 'Item edit', '__test_spec170_c6__', null)$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  '42501', null,
  'C-6: admin INSERT with created_at NULL is rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail, created_at)
            values (%L, %L, 'Item edit', '__test_spec170_c7__', now() - interval '91 days')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  '42501', null,
  'C-7: admin INSERT with an explicit past created_at is rejected (42501)'
);
select lives_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Item edit', '__test_spec170_c8__')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  'C-8: admin INSERT with created_at omitted (column default now()) succeeds'
);

-- U-1 / D-1 / D-3 / D-4 / D-5 attempts (outcomes asserted as postgres).
update public.audit_log set detail = '__test_spec170_admin_touched__'
 where id = 'a5000170-0000-0000-0000-000000000010';
delete from public.audit_log where id = 'a5000170-0000-0000-0000-000000000020';
delete from public.audit_log where id = 'a5000170-0000-0000-0000-000000000022';
delete from public.audit_log where id = 'a5000170-0000-0000-0000-000000000023';
delete from public.audit_log where id = 'a5000170-0000-0000-0000-000000000024';

-- D-9 attempt: admin deletes brand-A S_tmp2 (privileged_delete_stores admits).
delete from public.stores where id = current_setting('test.s_tmp2', true)::uuid;

-- UD-2 (spec 187 AC-20)
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'User deleted', '__test_spec187_ud2__')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  '42501',
  null,
  'UD-2: admin INSERT of ''User deleted'' attributed to self is rejected (42501)'
);

-- UD-5 (spec 187 AC-21)
select is(
  (select count(*)::int from public.audit_log
    where id = 'a5000170-0000-0000-0000-000000000005'),
  1,
  'UD-5: admin who can see S1 sees the ''User deleted'' row'
);

-- D-10 attempt (AC-14, clause-isolating). As postgres, add a wide permissive
-- SELECT probe so the SELECT mask no longer hides the brand-B row; then, as
-- the same admin JWT, record that the row IS visible (precondition, so the
-- arm cannot pass vacuously if the probe stops working) and try to delete
-- it. Only admin_delete_audit_log's auth_can_see_store(store_id) clause can
-- refuse. The probe is dropped immediately afterwards so no later arm runs
-- with it. Verified to FAIL against a spec 157 negative control
-- (using (auth_is_privileged())) and against the mutant
-- `auth_can_see_store(store_id) or true` (spec 170 review fix pass).
reset role;
create policy probe_wide_select on public.audit_log for select using (true);
set local role authenticated;

select set_config('test.d10_visible',
  (select count(*)::text from public.audit_log
    where id = 'a5000170-0000-0000-0000-000000000027'),
  true);
delete from public.audit_log where id = 'a5000170-0000-0000-0000-000000000027';

reset role;
drop policy probe_wide_select on public.audit_log;
set local role authenticated;


-- ══════════════════════════════════════════════════════════════════════════
-- Super_admin block — profiles.role='super_admin', JWT 'user'
-- ══════════════════════════════════════════════════════════════════════════
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.super_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

-- R-4 (AC-5)
select is(
  (select count(*)::int from public.audit_log
    where id in ('a5000170-0000-0000-0000-000000000001',
                 'a5000170-0000-0000-0000-000000000002')),
  2,
  'R-4: super_admin reads both store-user rows on S1'
);

-- I-12..I-15 (AC-8)
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Store user created', '__test_spec170_i12__')$q$,
         current_setting('test.s1', true), current_setting('test.super_id', true)),
  '42501', null,
  'I-12: super_admin INSERT of ''Store user created'' rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Store user password set', '__test_spec170_i13__')$q$,
         current_setting('test.s1', true), current_setting('test.super_id', true)),
  '42501', null,
  'I-13: super_admin INSERT of ''Store user password set'' rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'Order missed', '__test_spec170_i14__')$q$,
         current_setting('test.s1', true), current_setting('test.super_id', true)),
  '42501', null,
  'I-14: super_admin INSERT of ''Order missed'' rejected (42501)'
);
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'catalog_copy', '__test_spec170_i15__')$q$,
         current_setting('test.s1', true), current_setting('test.super_id', true)),
  '42501', null,
  'I-15: super_admin INSERT of ''catalog_copy'' rejected (42501)'
);

-- W-4 (AC-10): copy_catalog_rows (DEFINER, super_admin gate) writes one
-- store-less 'catalog_copy' row into the target brand.
select public.copy_catalog_rows(
  current_setting('test.brand_a', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'catalog_ingredients',
  array[current_setting('test.cat_id', true)::uuid]
);

select is(
  (select count(*)::int from public.audit_log
    where store_id is null
      and action  = 'catalog_copy'
      and detail  = current_setting('test.brand_b', true)
      and user_id = current_setting('test.super_id', true)::uuid),
  1,
  'W-4: copy_catalog_rows called by super_admin still writes its catalog_copy audit row (owner bypass)'
);

-- UD-3 (spec 187 AC-20)
select throws_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail)
            values (%L, %L, 'User deleted', '__test_spec187_ud3__')$q$,
         current_setting('test.s1', true), current_setting('test.super_id', true)),
  '42501',
  null,
  'UD-3: super_admin INSERT of ''User deleted'' attributed to self is rejected (42501)'
);

-- U-2 / D-2 / D-6 attempts (outcomes asserted as postgres).
update public.audit_log set detail = '__test_spec170_super_touched__'
 where id = 'a5000170-0000-0000-0000-000000000011';
delete from public.audit_log where id = 'a5000170-0000-0000-0000-000000000021';
delete from public.audit_log where id = 'a5000170-0000-0000-0000-000000000025';


-- ══════════════════════════════════════════════════════════════════════════
-- service_role block (BYPASSRLS) — the manage-store-user writer path
-- ══════════════════════════════════════════════════════════════════════════
reset role;
set local role service_role;

insert into public.audit_log (store_id, user_id, action, detail, item_ref)
values (current_setting('test.s1', true)::uuid, current_setting('test.admin_id', true)::uuid,
        'Store user created', '__test_spec170_w5__', '__test_spec170_username__');

-- W-5 (AC-10)
select is(
  (select count(*)::int from public.audit_log
    where store_id = current_setting('test.s1', true)::uuid
      and action   = 'Store user created'
      and detail   = '__test_spec170_w5__'),
  1,
  'W-5: service_role INSERT of ''Store user created'' succeeds (BYPASSRLS)'
);

-- UD-6 (spec 187 AC-20): the delete-user writer path.
select lives_ok(
  format($q$insert into public.audit_log (store_id, user_id, action, detail, item_ref)
            values (%L, %L, 'User deleted', '__test_spec187_ud6__', '__test_spec187_name__')$q$,
         current_setting('test.s1', true), current_setting('test.admin_id', true)),
  'UD-6: service_role INSERT of ''User deleted'' succeeds (BYPASSRLS)'
);


-- ══════════════════════════════════════════════════════════════════════════
-- Superuser read-back block
-- ══════════════════════════════════════════════════════════════════════════
reset role;

-- D-8 (AC-17): superuser store delete cascades to fresh + old audit rows.
delete from public.stores where id = current_setting('test.s_tmp1', true)::uuid;

select is(
  (select count(*)::int from public.audit_log
    where id in ('a5000170-0000-0000-0000-000000000030',
                 'a5000170-0000-0000-0000-000000000031')
       or store_id = current_setting('test.s_tmp1', true)::uuid),
  0,
  'D-8: deleting a store removes every audit_log row for it, fresh rows included (FK cascade)'
);

-- U-1 (AC-11)
select is(
  (select detail from public.audit_log where id = 'a5000170-0000-0000-0000-000000000010'),
  '__test_spec170_original__',
  'U-1: admin UPDATE of an S1 audit_log row affects 0 rows (detail unchanged)'
);

-- U-2 (AC-11)
select is(
  (select detail from public.audit_log where id = 'a5000170-0000-0000-0000-000000000011'),
  '__test_spec170_original__',
  'U-2: super_admin UPDATE of an S1 audit_log row affects 0 rows (detail unchanged)'
);

-- D-1 (AC-12)
select is(
  (select count(*)::int from public.audit_log where id = 'a5000170-0000-0000-0000-000000000020'),
  1,
  'D-1: admin DELETE of a fresh S1 row affects 0 rows (row survives)'
);

-- D-2 (AC-12)
select is(
  (select count(*)::int from public.audit_log where id = 'a5000170-0000-0000-0000-000000000021'),
  1,
  'D-2: super_admin DELETE of a fresh S1 row affects 0 rows (row survives)'
);

-- D-3 (AC-13)
select is(
  (select count(*)::int from public.audit_log where id = 'a5000170-0000-0000-0000-000000000022'),
  0,
  'D-3: admin (brand A) DELETE of a 91-day S1 row removes it'
);

-- D-4 (AC-14, PostgREST-shaped): SELECT-masked. The brand-A admin cannot
-- SELECT the brand-B row, and a column-filtered DELETE also applies the SELECT
-- policies, so this passes whether or not admin_delete_audit_log is scoped.
-- D-10 is the arm that isolates the DELETE scope clause.
select is(
  (select count(*)::int from public.audit_log where id = 'a5000170-0000-0000-0000-000000000023'),
  1,
  'D-4: admin (brand A) DELETE of a 91-day brand-B row affects 0 rows (SELECT-masked; D-10 isolates the DELETE scope)'
);

-- D-5 (AC-15)
select is(
  (select count(*)::int from public.audit_log where id = 'a5000170-0000-0000-0000-000000000024'),
  1,
  'D-5: admin DELETE of a 91-day store-less row affects 0 rows (row survives)'
);

-- D-6 (AC-15)
select is(
  (select count(*)::int from public.audit_log where id = 'a5000170-0000-0000-0000-000000000025'),
  0,
  'D-6: super_admin DELETE of a 91-day store-less row removes it'
);

-- D-7 (AC-16)
select is(
  (select count(*)::int from public.audit_log where id = 'a5000170-0000-0000-0000-000000000026'),
  1,
  'D-7: staff DELETE of a 91-day S1 row affects 0 rows (row survives)'
);

-- D-9 (AC-17, production path): the admin's store delete took the fresh
-- audit row with it even though admin_delete_audit_log refuses fresh rows.
select ok(
  not exists (select 1 from public.stores where id = current_setting('test.s_tmp2', true)::uuid)
  and not exists (select 1 from public.audit_log where id = 'a5000170-0000-0000-0000-000000000032'),
  'D-9: admin JWT store delete removes the store and its fresh audit row (FK cascade bypasses RLS)'
);

-- D-10 (AC-14, clause-isolating): with the SELECT mask removed, the admin saw
-- the brand-B row (precondition) and the DELETE policy's store scope still
-- refused it.
select ok(
  current_setting('test.d10_visible', true) = '1'
  and exists (select 1 from public.audit_log where id = 'a5000170-0000-0000-0000-000000000027')
  and not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'audit_log'
                     and policyname = 'probe_wide_select'),
  'D-10: with a wide SELECT probe unmasking it, admin (brand A) DELETE of a 91-day brand-B row is refused by admin_delete_audit_log''s store scope (row survives; probe dropped)'
);

-- UD-7 (spec 187 AC-20)
select is(
  (select count(*)::int from public.audit_log
    where store_id = current_setting('test.s1', true)::uuid
      and action   = 'User deleted'
      and detail   = '__test_spec187_ud6__'),
  1,
  'UD-7: the service_role ''User deleted'' row from UD-6 exists'
);

select * from finish();
rollback;
