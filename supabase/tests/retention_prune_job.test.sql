-- supabase/tests/retention_prune_job.test.sql
--
-- Spec 186 / pgTAP for supabase/migrations/20261108120000_retention_prune_job.sql:
-- the nightly audit_log + invitations prune, and the server-side refusal that
-- stops stale clients deleting kept records.
--
-- Arm map:
--   J-1..J-3     cron.job shape (AC-1)
--   P-1          shape of the three stale-client policies
--   P-2          the FK shape store deletion relies on, and the RI firing order
--   P-3          owner-bypass precondition for the prune
--   P-4          no DELETE/ALL policy on eod_* (AC-8)
--   P-5          no client role can execute the prune (AC-10)
--   P-7          admin_delete_audit_log comment (AC-24)
--   F-1          every prune fixture exists before the run (AC-3)
--   A4-*, A5-*   prune deletion control and boundaries (AC-4, AC-5)
--   A6-*, A7     kept records and the approval link survive the run (AC-6, AC-7)
--   A9-*         reported counts equal the row-count drop; second run is 0 (AC-9)
--   A14-*        each caller can SELECT the 200-day rows (AC-14)
--   A15-*, A16-* old purge statements leave them, with 0 rows and no error
--   A17-*        margin: 1-day boundary, fast clock, beyond the margin (AC-17)
--   A18, A21     PO rollback and a line edit on a 200-day draft (AC-18, AC-21)
--   A19-*        db.deleteStore statements in order (AC-19)
--   A20          hard_delete_brand (AC-20)
--   A22-*        rows under the limit stay deletable (AC-22)
--   A25-*        stale audit_log delete raises nothing (AC-25)
--   T-1, T-2     staff cannot remove kept rows by deleting a store; a failed
--                store delete leaves them in place
--
-- AC-2: the run reads `command` from cron.job and executes it, so nothing here
-- names the function for the run itself and it cannot drift from the job. Read
-- cron.job as postgres, before any `set local role` (its RLS is username-scoped).
--
-- A19 is the regression arm for the store delete. Its waste rows name the
-- store's item, and the spec 186 probe tried both RI firing orders: the store
-- delete succeeds and the stores FK cascade removes the aged waste row, with no
-- 23503 on waste_log_item_id_fkey. P-2 pins the FK shape and the firing order
-- that probe covered, so a change to either sends the reader back to the
-- spec 186 architect's ruling (reviews/backend-architect.md).
--
-- Fixture constraints from the spec 186 design:
--   AC-19: waste rows name an item in that store. POS lines use recipe_id NULL,
--          and no eod_entries name the item. A store whose item has a po_items
--          line cannot be deleted today (T-2 pins that failure on purpose).
--   AC-20: the brand's stores own NO inventory items. A brand whose stores own
--          items fails today with 23503 on inventory_items_catalog_id_fkey.
--   Both:  POs are UNLINED. The design said lines with item_id NULL, but
--          po_items_check_store refuses a NULL item_id (42501), so that state
--          cannot be inserted (spec 186 implementation notes).
--
-- Read-back rule: every arm claiming a row survived or was removed reads it by
-- fixture id as postgres. Per-caller state is stashed as postgres right after
-- that caller's attempt (A15-*), and the assertions run in the final block. A
-- read as a caller who cannot see the row would pass vacuously. A14-* and A19-0
-- are the visibility preconditions.
--
-- now() is the transaction start, so fixtures and policies share one clock and
-- the boundaries are deterministic. Do not use `set role anon` (spec 067).
--
-- The real job can fire at 08:47 UTC during a long-lived stack or CI run. This
-- file uses its own fixtures, and A9 compares against the row-count drop.
--
-- Principals (seed):
--   admin  11111111-… profiles.role='admin', brand A, JWT 'admin'
--   staff  22222222-… profiles.role='user', user_stores grant on Towson
--   super  33333333-… promoted in-txn to super_admin, brand_id NULL, JWT 'user'
--   S1     Towson 00000000-…-0001 (brand A)

begin;
create extension if not exists pgtap;

select plan(70);

-- ── helpers ───────────────────────────────────────────────────────────────
-- Runs one statement the way the client's calls behave: an error is recorded and
-- does not stop the next statement. Returns 'ok:<row_count>' or the SQLSTATE.
create function pg_temp.try_sql(p_sql text) returns text
language plpgsql as $$
declare
  v_n bigint;
begin
  execute p_sql;
  get diagnostics v_n = row_count;
  return 'ok:' || v_n;
exception when others then
  return sqlstate;
end;
$$;

create function pg_temp.jwt(p_sub text, p_app_role text) returns void
language sql as $$
  select set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated',
                       'app_metadata', jsonb_build_object('role', p_app_role))::text,
    true);
  select;
$$;

-- The old purge's own statements, as in AC-15, with its cutoff.
create function pg_temp.old_purge() returns text
language sql as $$
  select pg_temp.try_sql($q$delete from public.purchase_orders where created_at < now() - interval '90 days'$q$)
         || '|' ||
         pg_temp.try_sql($q$delete from public.waste_log where logged_at < now() - interval '90 days'$q$)
         || '|' ||
         pg_temp.try_sql($q$delete from public.pos_imports where imported_at < now() - interval '90 days'$q$);
$$;

-- The 200-day rows AC-15 protects, by fixture id.
create function pg_temp.kept_rows() returns text
language sql as $$
  select format('po=%s poi=%s voa=%s waste=%s pos=%s posi=%s',
    (select count(*) from public.purchase_orders
      where id in ('b1860020-0000-0000-0000-000000000003', 'b1860020-0000-0000-0000-000000000004')),
    (select count(*) from public.po_items where id = 'b1860020-0000-0000-0000-000000000005'),
    (select count(*) from public.vendor_order_attempts where id = 'b1860020-0000-0000-0000-000000000006'),
    (select count(*) from public.waste_log where id = 'b1860020-0000-0000-0000-000000000007'),
    (select count(*) from public.pos_imports where id = 'b1860020-0000-0000-0000-000000000008'),
    (select count(*) from public.pos_import_items where id = 'b1860020-0000-0000-0000-000000000009'));
$$;

-- ── principals ────────────────────────────────────────────────────────────
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = '33333333-3333-3333-3333-333333333333';

-- ── brands + test-only stores ─────────────────────────────────────────────
insert into public.brands (id, name, deleted_at) values
  ('b1860000-0000-0000-0000-000000000001', 'Foreign Brand (test 186)', null),
  ('b1860000-0000-0000-0000-000000000002', 'Purged Brand (test 186)',  now());

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time) values
  ('b1860001-0000-0000-0000-000000000001', 'b1860000-0000-0000-0000-000000000001', 'Foreign (test 186)',  '1 Way', 'active', '22:00'),
  ('b1860001-0000-0000-0000-000000000002', '2a000000-0000-0000-0000-000000000001', 'DeleteMe (test 186)', '2 Way', 'active', '22:00'),
  ('b1860001-0000-0000-0000-000000000003', '2a000000-0000-0000-0000-000000000001', 'Blocked (test 186)',  '3 Way', 'active', '22:00'),
  ('b1860001-0000-0000-0000-000000000004', '2a000000-0000-0000-0000-000000000001', 'StaffOf (test 186)',  '4 Way', 'active', '22:00'),
  ('b1860001-0000-0000-0000-000000000005', 'b1860000-0000-0000-0000-000000000002', 'Purged (test 186)',   '5 Way', 'active', '22:00');

insert into public.user_stores (user_id, store_id) values
  ('22222222-2222-2222-2222-222222222222', 'b1860001-0000-0000-0000-000000000004');

insert into public.catalog_ingredients (id, brand_id, name, unit, case_qty, sub_unit_size, default_cost) values
  ('b1860002-0000-0000-0000-000000000001', '2a000000-0000-0000-0000-000000000001', '__test_spec186_item__', 'each', 4, 1, 5);

insert into public.inventory_items (id, store_id, catalog_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion) values
  ('b1860003-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'b1860002-0000-0000-0000-000000000001', 20, 5, 0, 0, 0),
  ('b1860003-0000-0000-0000-000000000002', 'b1860001-0000-0000-0000-000000000002', 'b1860002-0000-0000-0000-000000000001', 20, 5, 0, 0, 0),
  ('b1860003-0000-0000-0000-000000000003', 'b1860001-0000-0000-0000-000000000003', 'b1860002-0000-0000-0000-000000000001', 20, 5, 0, 0, 0),
  ('b1860003-0000-0000-0000-000000000004', 'b1860001-0000-0000-0000-000000000004', 'b1860002-0000-0000-0000-000000000001', 20, 5, 0, 0, 0);

-- ── prune fixtures: audit_log ─────────────────────────────────────────────
insert into public.audit_log (id, store_id, user_id, action, detail, created_at) values
  ('b1860010-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', null, '__test_spec186__', '91d brand A',  now() - interval '91 days'),
  ('b1860010-0000-0000-0000-000000000002', 'b1860001-0000-0000-0000-000000000001', null, '__test_spec186__', '91d brand B',  now() - interval '91 days'),
  ('b1860010-0000-0000-0000-000000000003', null,                                   null, '__test_spec186__', '91d storeless', now() - interval '91 days'),
  ('b1860010-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', null, '__test_spec186__', '89d',          now() - interval '89 days'),
  ('b1860010-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', null, '__test_spec186__', 'null date',    null);

-- ── prune fixtures: invitations ───────────────────────────────────────────
insert into public.invitations (id, email, name, profile_id, used, expires_at) values
  ('b1860011-0000-0000-0000-000000000001', 'inv186-1@local.test', 'expired unused', gen_random_uuid(), false, now() - interval '1 day'),
  ('b1860011-0000-0000-0000-000000000002', 'inv186-2@local.test', 'future unused',  gen_random_uuid(), false, now() + interval '1 day'),
  ('b1860011-0000-0000-0000-000000000003', 'inv186-3@local.test', 'expired used',   gen_random_uuid(), true,  now() - interval '1 day'),
  ('b1860011-0000-0000-0000-000000000004', 'inv186-4@local.test', 'null expiry',    gen_random_uuid(), false, null),
  ('b1860011-0000-0000-0000-000000000005', 'inv186-5@local.test', 'null used',      gen_random_uuid(), null,  now() - interval '1 day');

-- ── kept records, 200 days back, in S1 so all three callers can see them ──
insert into public.eod_submissions (id, store_id, vendor_id, date, status, submitted_at) values
  ('b1860020-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45',
   date '1999-03-03', 'submitted', now() - interval '200 days');
insert into public.eod_entries (id, submission_id, item_id, actual_remaining, created_at) values
  ('b1860020-0000-0000-0000-000000000002', 'b1860020-0000-0000-0000-000000000001', 'b1860003-0000-0000-0000-000000000001', 1, now() - interval '200 days');

insert into public.purchase_orders (id, store_id, vendor_id, status, created_at) values
  ('b1860020-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',    now() - interval '200 days'),
  ('b1860020-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'received', now() - interval '200 days'),
  ('b1860020-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',    now() - interval '200 days');
insert into public.po_items (id, po_id, item_id, ordered_qty) values
  ('b1860020-0000-0000-0000-000000000005', 'b1860020-0000-0000-0000-000000000003', 'b1860003-0000-0000-0000-000000000001', 1),
  ('b1860020-0000-0000-0000-00000000000c', 'b1860020-0000-0000-0000-00000000000b', 'b1860003-0000-0000-0000-000000000001', 1);
insert into public.vendor_order_attempts (id, po_id, store_id, vendor_id, outcome, stage, created_at) values
  ('b1860020-0000-0000-0000-000000000006', 'b1860020-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'failed', 'error', now() - interval '200 days');

insert into public.waste_log (id, store_id, item_id, quantity, unit, reason, logged_at) values
  ('b1860020-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'b1860003-0000-0000-0000-000000000001', 1, 'each', '__test_spec186__', now() - interval '200 days');

insert into public.pos_imports (id, store_id, filename, import_date, imported_at) values
  ('b1860020-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', '__test_spec186__.csv', date '1999-03-03', now() - interval '200 days');
insert into public.pos_import_items (id, import_id, menu_item, qty_sold, revenue, recipe_id) values
  ('b1860020-0000-0000-0000-000000000009', 'b1860020-0000-0000-0000-000000000008', '__test_spec186__', 1, 1, null);

-- Empty lines keep spec 177's lines-store trigger out of the way.
insert into public.order_approvals (id, store_id, vendor_id, business_date, channel, status, lines, source_submission_id) values
  ('b1860020-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45',
   date '1999-03-03', 'manual', 'ordered', '[]'::jsonb, 'b1860020-0000-0000-0000-000000000001');

-- ── AC-17 fixtures (S1): 01 limit+1min, 02 limit-1min, 03 3 days, 04 23 hours ──
insert into public.purchase_orders (id, store_id, status, created_at) values
  ('b1860030-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'draft', now() - interval '1 day' - interval '1 minute'),
  ('b1860030-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'draft', now() - interval '1 day' + interval '1 minute'),
  ('b1860030-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'draft', now() - interval '3 days'),
  ('b1860030-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'draft', now() - interval '23 hours');
insert into public.waste_log (id, store_id, quantity, unit, reason, logged_at) values
  ('b1860030-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 1, 'each', '__test_spec186__', now() - interval '1 day' - interval '1 minute'),
  ('b1860030-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 1, 'each', '__test_spec186__', now() - interval '1 day' + interval '1 minute'),
  ('b1860030-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 1, 'each', '__test_spec186__', now() - interval '3 days'),
  ('b1860030-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 1, 'each', '__test_spec186__', now() - interval '23 hours');
insert into public.pos_imports (id, store_id, filename, import_date, imported_at) values
  ('b1860030-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001', '__test_spec186__.csv', date '1999-03-03', now() - interval '1 day' - interval '1 minute'),
  ('b1860030-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000001', '__test_spec186__.csv', date '1999-03-03', now() - interval '1 day' + interval '1 minute'),
  ('b1860030-0000-0000-0000-000000000023', '00000000-0000-0000-0000-000000000001', '__test_spec186__.csv', date '1999-03-03', now() - interval '3 days'),
  ('b1860030-0000-0000-0000-000000000024', '00000000-0000-0000-0000-000000000001', '__test_spec186__.csv', date '1999-03-03', now() - interval '23 hours');

-- ── AC-22 fixtures (S1), 12 hours old, one set per caller ─────────────────
insert into public.purchase_orders (id, store_id, status, created_at)
select id::uuid, '00000000-0000-0000-0000-000000000001', 'draft', now() - interval '12 hours'
  from unnest(array['b1860040-0000-0000-0000-0000000000a1',
                    'b1860040-0000-0000-0000-0000000000b1',
                    'b1860040-0000-0000-0000-0000000000c1']) as id;
insert into public.waste_log (id, store_id, quantity, unit, reason, logged_at)
select id::uuid, '00000000-0000-0000-0000-000000000001', 1, 'each', '__test_spec186__', now() - interval '12 hours'
  from unnest(array['b1860040-0000-0000-0000-0000000000a2',
                    'b1860040-0000-0000-0000-0000000000b2',
                    'b1860040-0000-0000-0000-0000000000c2']) as id;
insert into public.pos_imports (id, store_id, filename, import_date, imported_at)
select id::uuid, '00000000-0000-0000-0000-000000000001', '__test_spec186__.csv', date '1999-03-03', now() - interval '12 hours'
  from unnest(array['b1860040-0000-0000-0000-0000000000a3',
                    'b1860040-0000-0000-0000-0000000000b3',
                    'b1860040-0000-0000-0000-0000000000c3']) as id;

-- ── AC-19 store: fresh + 200-day rows; waste rows name the store's item ───
insert into public.waste_log (id, store_id, item_id, quantity, unit, reason, logged_at) values
  ('b1860060-0000-0000-0000-000000000001', 'b1860001-0000-0000-0000-000000000002', 'b1860003-0000-0000-0000-000000000002', 1, 'each', '__test_spec186__', now()),
  ('b1860060-0000-0000-0000-000000000002', 'b1860001-0000-0000-0000-000000000002', 'b1860003-0000-0000-0000-000000000002', 1, 'each', '__test_spec186__', now() - interval '200 days');
insert into public.purchase_orders (id, store_id, status, created_at) values
  ('b1860060-0000-0000-0000-000000000003', 'b1860001-0000-0000-0000-000000000002', 'draft', now()),
  ('b1860060-0000-0000-0000-000000000004', 'b1860001-0000-0000-0000-000000000002', 'draft', now() - interval '200 days');
insert into public.pos_imports (id, store_id, filename, import_date, imported_at) values
  ('b1860060-0000-0000-0000-000000000006', 'b1860001-0000-0000-0000-000000000002', '__test_spec186__.csv', date '1999-03-03', now()),
  ('b1860060-0000-0000-0000-000000000007', 'b1860001-0000-0000-0000-000000000002', '__test_spec186__.csv', date '1999-03-03', now() - interval '200 days');
insert into public.pos_import_items (id, import_id, menu_item, qty_sold, revenue, recipe_id) values
  ('b1860060-0000-0000-0000-000000000008', 'b1860060-0000-0000-0000-000000000007', '__test_spec186__', 1, 1, null);

-- ── T-2 store: a line on its item blocks the store delete (spec 179 T32 note) ─
insert into public.waste_log (id, store_id, item_id, quantity, unit, reason, logged_at) values
  ('b1860070-0000-0000-0000-000000000001', 'b1860001-0000-0000-0000-000000000003', 'b1860003-0000-0000-0000-000000000003', 1, 'each', '__test_spec186__', now() - interval '200 days');
insert into public.purchase_orders (id, store_id, status) values
  ('b1860070-0000-0000-0000-000000000002', 'b1860001-0000-0000-0000-000000000003', 'draft');
insert into public.po_items (id, po_id, item_id, ordered_qty) values
  ('b1860070-0000-0000-0000-000000000003', 'b1860070-0000-0000-0000-000000000002', 'b1860003-0000-0000-0000-000000000003', 1);

-- ── T-1 store: staff holds a grant, so the row is visible to them ─────────
insert into public.waste_log (id, store_id, item_id, quantity, unit, reason, logged_at) values
  ('b1860071-0000-0000-0000-000000000001', 'b1860001-0000-0000-0000-000000000004', 'b1860003-0000-0000-0000-000000000004', 1, 'each', '__test_spec186__', now() - interval '200 days');

-- ── AC-20 brand: no inventory items; unlined PO; POS line recipe NULL ─────
-- Explicit po_number: generate_po_number() is SECURITY INVOKER, so its max() only
-- sees POs the caller can read. A numbered row in this foreign brand would make
-- the brand-A admin's AC-18 insert compute the same number and fail on the unique
-- key. Existing behaviour, not part of this spec.
insert into public.purchase_orders (id, store_id, po_number, status, created_at) values
  ('b1860080-0000-0000-0000-000000000001', 'b1860001-0000-0000-0000-000000000005', '__test_spec186_c__', 'draft', now() - interval '200 days');
insert into public.waste_log (id, store_id, item_id, quantity, unit, reason, logged_at) values
  ('b1860080-0000-0000-0000-000000000003', 'b1860001-0000-0000-0000-000000000005', null, 1, 'each', '__test_spec186__', now() - interval '200 days');
insert into public.pos_imports (id, store_id, filename, import_date, imported_at) values
  ('b1860080-0000-0000-0000-000000000004', 'b1860001-0000-0000-0000-000000000005', '__test_spec186__.csv', date '1999-03-03', now() - interval '200 days');
insert into public.pos_import_items (id, import_id, menu_item, qty_sold, revenue, recipe_id) values
  ('b1860080-0000-0000-0000-000000000005', 'b1860080-0000-0000-0000-000000000004', '__test_spec186__', 1, 1, null);


-- ══════════════════════════════════════════════════════════════════════════
-- Shape (postgres)
-- ══════════════════════════════════════════════════════════════════════════

-- J-1 (AC-1): exact name, because prune-username-resolve-rate-limit also exists.
select is(
  (select count(*)::int from cron.job
    where jobname = 'prune-audit-log-and-invitations' and active),
  1,
  'J-1: cron.job has exactly one active prune-audit-log-and-invitations job (readable from the test path)'
);

-- J-2 (AC-1)
select is(
  (select schedule from cron.job where jobname = 'prune-audit-log-and-invitations'),
  '47 8 * * *',
  'J-2: the job fires once per day, at 08:47 UTC'
);

-- J-3 (AC-1)
select is(
  (select command from cron.job where jobname = 'prune-audit-log-and-invitations'),
  'select * from public.prune_audit_log_and_invitations();',
  'J-3: the job command runs the prune'
);

-- P-1: shape of the three stale-client policies.
select is(
  (select string_agg(tablename || '/' || policyname || '/' || permissive || '/' || cmd || '/' || qual, ', ' order by tablename)
     from pg_policies
    where schemaname = 'public'
      and policyname in ('purchase_orders_restrict_delete_aged',
                         'waste_log_restrict_delete_aged',
                         'pos_imports_restrict_delete_aged')),
  'pos_imports/pos_imports_restrict_delete_aged/RESTRICTIVE/DELETE/(imported_at >= (now() - ''1 day''::interval)), '
  || 'purchase_orders/purchase_orders_restrict_delete_aged/RESTRICTIVE/DELETE/(created_at >= (now() - ''1 day''::interval)), '
  || 'waste_log/waste_log_restrict_delete_aged/RESTRICTIVE/DELETE/(logged_at >= (now() - ''1 day''::interval))',
  'P-1: three RESTRICTIVE DELETE policies with the 1-day limit'
);

-- P-2: what store deletion relies on for aged waste rows, now that the direct
-- waste_log delete refuses them. waste_log_store_id_fkey cascades;
-- waste_log_item_id_fkey is NO ACTION ('a') and not deferrable; and the
-- stores -> inventory_items ON DELETE RI trigger sorts before stores -> waste_log,
-- which is the firing order A19 runs in (the order the design feared, and the
-- order on prod as read 2026-11-08). Trigger names compare in C collation, as
-- Postgres orders them. If this fails, re-read the spec 186 architect's ruling
-- before changing A19.
select is(
  format('%s/%s/%s/%s',
    (select confdeltype from pg_constraint
      where conrelid = 'public.waste_log'::regclass and conname = 'waste_log_store_id_fkey'),
    (select confdeltype from pg_constraint
      where conrelid = 'public.waste_log'::regclass and conname = 'waste_log_item_id_fkey'),
    (select condeferrable from pg_constraint
      where conrelid = 'public.waste_log'::regclass and conname = 'waste_log_item_id_fkey'),
    (select (ii.tgname::text collate "C") < (wl.tgname::text collate "C")
       from (select t.tgname from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
              where t.tgrelid = 'public.stores'::regclass and (t.tgtype & 8) <> 0
                and c.conrelid = 'public.inventory_items'::regclass
                and c.conname = 'inventory_items_store_id_fkey') ii,
            (select t.tgname from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
              where t.tgrelid = 'public.stores'::regclass and (t.tgtype & 8) <> 0
                and c.conrelid = 'public.waste_log'::regclass
                and c.conname = 'waste_log_store_id_fkey') wl)),
  'c/a/f/t',
  'P-2: waste_log_store_id_fkey cascades, waste_log_item_id_fkey is NO ACTION and not deferrable, and stores -> inventory_items fires before stores -> waste_log'
);

-- P-3 (S-7 style): the prune relies on owner bypass.
select ok(
  (select bool_and(not c.relforcerowsecurity and c.relrowsecurity)
          and count(*) = 2
          and count(distinct c.relowner) = 1
     from pg_class c
    where c.oid in ('public.audit_log'::regclass, 'public.invitations'::regclass))
  and (select count(*) = 1
              and bool_and(p.prosecdef)
              and bool_and(p.proowner = (select relowner from pg_class where oid = 'public.audit_log'::regclass))
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname = 'prune_audit_log_and_invitations'),
  'P-3: RLS on and FORCE RLS off on audit_log and invitations, and the SECURITY DEFINER prune shares their owner'
);

-- P-4 (AC-8)
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('eod_submissions', 'eod_entries')
      and cmd in ('DELETE', 'ALL')),
  0,
  'P-4: no DELETE or ALL policy on eod_submissions or eod_entries'
);

-- P-5 (AC-10). Catalog assertions: `set role anon` segfaults the CI image.
select is(
  array[has_function_privilege('anon', 'public.prune_audit_log_and_invitations()', 'execute'),
        has_function_privilege('authenticated', 'public.prune_audit_log_and_invitations()', 'execute'),
        has_function_privilege('service_role', 'public.prune_audit_log_and_invitations()', 'execute'),
        has_function_privilege('postgres', 'public.prune_audit_log_and_invitations()', 'execute')],
  array[false, false, false, true],
  'P-5: anon, authenticated and service_role cannot execute the prune; postgres can'
);

-- P-7 (AC-24): the policy stays and its comment is rewritten.
select ok(
  (select d.description like 'spec 170: %'
      and d.description like '%spec 186%'
      and d.description not like '%cleanupOldRecords%'
     from pg_policy pol
     join pg_description d on d.objoid = pol.oid and d.classoid = 'pg_policy'::regclass
    where pol.polrelid = 'public.audit_log'::regclass
      and pol.polname = 'admin_delete_audit_log'),
  'P-7: admin_delete_audit_log comment keeps the spec 170 prefix, names spec 186, and no longer names cleanupOldRecords'
);


-- ══════════════════════════════════════════════════════════════════════════
-- The job (postgres): one run through the job's own command (AC-2)
-- ══════════════════════════════════════════════════════════════════════════

-- F-1 (AC-3)
select is(
  format('audit=%s invites=%s sub=%s entry=%s po=%s poi=%s voa=%s waste=%s pos=%s posi=%s approval=%s',
    (select count(*) from public.audit_log where id::text like 'b1860010-%'),
    (select count(*) from public.invitations where id::text like 'b1860011-%'),
    (select count(*) from public.eod_submissions
      where id = 'b1860020-0000-0000-0000-000000000001' and submitted_at = now() - interval '200 days'),
    (select count(*) from public.eod_entries where id = 'b1860020-0000-0000-0000-000000000002'),
    (select count(*) from public.purchase_orders
      where id in ('b1860020-0000-0000-0000-000000000003', 'b1860020-0000-0000-0000-000000000004')
        and created_at = now() - interval '200 days'),
    (select count(*) from public.po_items where id = 'b1860020-0000-0000-0000-000000000005'),
    (select count(*) from public.vendor_order_attempts where id = 'b1860020-0000-0000-0000-000000000006'),
    (select count(*) from public.waste_log
      where id = 'b1860020-0000-0000-0000-000000000007' and logged_at = now() - interval '200 days'),
    (select count(*) from public.pos_imports
      where id = 'b1860020-0000-0000-0000-000000000008' and imported_at = now() - interval '200 days'),
    (select count(*) from public.pos_import_items where id = 'b1860020-0000-0000-0000-000000000009'),
    (select count(*) from public.order_approvals
      where id = 'b1860020-0000-0000-0000-00000000000a'
        and source_submission_id = 'b1860020-0000-0000-0000-000000000001')),
  'audit=5 invites=5 sub=1 entry=1 po=2 poi=1 voa=1 waste=1 pos=1 posi=1 approval=1',
  'F-1: every prune fixture exists before the run'
);

do $$
declare
  v_cmd     text;
  v_audit0  bigint;
  v_inv0    bigint;
  v_a1      integer;
  v_i1      integer;
  v_a2      integer;
  v_i2      integer;
begin
  select command into strict v_cmd
    from cron.job where jobname = 'prune-audit-log-and-invitations';

  select count(*) into v_audit0 from public.audit_log;
  select count(*) into v_inv0 from public.invitations;

  execute v_cmd into v_a1, v_i1;

  perform set_config('test.audit_reported', v_a1::text, true);
  perform set_config('test.inv_reported', v_i1::text, true);
  perform set_config('test.audit_drop', (v_audit0 - (select count(*) from public.audit_log))::text, true);
  perform set_config('test.inv_drop', (v_inv0 - (select count(*) from public.invitations))::text, true);

  execute v_cmd into v_a2, v_i2;

  perform set_config('test.second_run', v_a2 || ',' || v_i2, true);
end $$;

-- AC-4: deletion control, so a no-op cannot pass.
select is((select count(*)::int from public.audit_log where id = 'b1860010-0000-0000-0000-000000000001'), 0,
  'A4-1: 91-day audit_log row in a brand-A store is gone');
select is((select count(*)::int from public.audit_log where id = 'b1860010-0000-0000-0000-000000000002'), 0,
  'A4-2: 91-day audit_log row in a brand-B store is gone');
select is((select count(*)::int from public.audit_log where id = 'b1860010-0000-0000-0000-000000000003'), 0,
  'A4-3: 91-day store-less audit_log row is gone');
select is((select count(*)::int from public.invitations where id = 'b1860011-0000-0000-0000-000000000001'), 0,
  'A4-4: expired unused invitation is gone');

-- AC-5: boundaries.
select is((select count(*)::int from public.audit_log where id = 'b1860010-0000-0000-0000-000000000004'), 1,
  'A5-1: 89-day audit_log row stays');
select is((select count(*)::int from public.audit_log where id = 'b1860010-0000-0000-0000-000000000005'), 1,
  'A5-2: audit_log row with NULL created_at stays');
select is((select count(*)::int from public.invitations where id = 'b1860011-0000-0000-0000-000000000002'), 1,
  'A5-3: unused invitation expiring in the future stays');
select is((select count(*)::int from public.invitations where id = 'b1860011-0000-0000-0000-000000000003'), 1,
  'A5-4: used invitation with a past expiry stays');
select is((select count(*)::int from public.invitations where id = 'b1860011-0000-0000-0000-000000000004'), 1,
  'A5-5: invitation with NULL expires_at stays');
select is((select count(*)::int from public.invitations where id = 'b1860011-0000-0000-0000-000000000005'), 1,
  'A5-6: invitation with NULL used stays');

-- AC-6: kept records, each asserted separately.
select is((select count(*)::int from public.eod_submissions where id = 'b1860020-0000-0000-0000-000000000001'), 1,
  'A6-1: 200-day eod_submissions row stays');
select is((select count(*)::int from public.eod_entries where id = 'b1860020-0000-0000-0000-000000000002'), 1,
  'A6-2: its eod_entries row stays');
select is((select count(*)::int from public.purchase_orders where id = 'b1860020-0000-0000-0000-000000000003'), 1,
  'A6-3: 200-day draft purchase_orders row stays');
select is((select count(*)::int from public.purchase_orders where id = 'b1860020-0000-0000-0000-000000000004'), 1,
  'A6-4: 200-day received purchase_orders row stays');
select is((select count(*)::int from public.po_items where id = 'b1860020-0000-0000-0000-000000000005'), 1,
  'A6-5: po_items row under the draft stays');
select is((select count(*)::int from public.vendor_order_attempts where id = 'b1860020-0000-0000-0000-000000000006'), 1,
  'A6-6: vendor_order_attempts row under the draft stays');
select is((select count(*)::int from public.waste_log where id = 'b1860020-0000-0000-0000-000000000007'), 1,
  'A6-7: 200-day waste_log row stays');
select is((select count(*)::int from public.pos_imports where id = 'b1860020-0000-0000-0000-000000000008'), 1,
  'A6-8: 200-day pos_imports row stays');
select is((select count(*)::int from public.pos_import_items where id = 'b1860020-0000-0000-0000-000000000009'), 1,
  'A6-9: its pos_import_items row stays');

-- AC-7
select is(
  (select source_submission_id from public.order_approvals where id = 'b1860020-0000-0000-0000-00000000000a'),
  'b1860020-0000-0000-0000-000000000001'::uuid,
  'A7: the linked order_approvals row keeps its source_submission_id'
);

-- AC-9: against the row-count drop, because the seed can hold old rows of its own.
select is(current_setting('test.audit_reported', true), current_setting('test.audit_drop', true),
  'A9-1: the reported audit_log count equals the row-count drop');
select is(current_setting('test.inv_reported', true), current_setting('test.inv_drop', true),
  'A9-2: the reported invitations count equals the row-count drop');
select is(current_setting('test.second_run', true), '0,0',
  'A9-3: a second run in the same transaction reports 0 for both');

-- AC-25 fixtures, after the run, so the stale audit delete has real rows to hit.
insert into public.audit_log (id, store_id, user_id, action, detail, created_at) values
  ('b1860010-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', null, '__test_spec186__', 'post-run 91d', now() - interval '91 days'),
  ('b1860010-0000-0000-0000-000000000007', null,                                   null, '__test_spec186__', 'post-run 91d storeless', now() - interval '91 days');


-- ══════════════════════════════════════════════════════════════════════════
-- Admin block — profiles.role='admin', JWT 'admin', brand A
-- ══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.jwt('11111111-1111-1111-1111-111111111111', 'admin');

-- A14-1 (AC-14)
select is(pg_temp.kept_rows(), 'po=2 poi=1 voa=1 waste=1 pos=1 posi=1',
  'A14-1: admin can SELECT the 200-day rows');

-- AC-15, AC-16
select set_config('test.a16_admin', pg_temp.old_purge(), true);
reset role;
select set_config('test.a15_admin', pg_temp.kept_rows(), true);
set local role authenticated;

-- AC-16 also covers the old purge's other two statements.
select set_config('test.a16_admin_eod',
  pg_temp.try_sql($q$delete from public.eod_submissions where submitted_at < now() - interval '90 days'$q$), true);

-- AC-25
select set_config('test.a25',
  pg_temp.try_sql($q$delete from public.audit_log where created_at < now() - interval '90 days'$q$), true);

-- AC-17: the 1-day boundary, by id, on each table.
select set_config('test.a17_po_old',    pg_temp.try_sql($q$delete from public.purchase_orders where id = 'b1860030-0000-0000-0000-000000000001'$q$), true);
select set_config('test.a17_po_young',  pg_temp.try_sql($q$delete from public.purchase_orders where id = 'b1860030-0000-0000-0000-000000000002'$q$), true);
select set_config('test.a17_w_old',     pg_temp.try_sql($q$delete from public.waste_log where id = 'b1860030-0000-0000-0000-000000000011'$q$), true);
select set_config('test.a17_w_young',   pg_temp.try_sql($q$delete from public.waste_log where id = 'b1860030-0000-0000-0000-000000000012'$q$), true);
select set_config('test.a17_pos_old',   pg_temp.try_sql($q$delete from public.pos_imports where id = 'b1860030-0000-0000-0000-000000000021'$q$), true);
select set_config('test.a17_pos_young', pg_temp.try_sql($q$delete from public.pos_imports where id = 'b1860030-0000-0000-0000-000000000022'$q$), true);

-- AC-17: a clock 88 days fast targets rows over 2 days old.
select set_config('test.a17_fast',
  pg_temp.try_sql($q$delete from public.purchase_orders where created_at < now() - interval '2 days'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.waste_log where logged_at < now() - interval '2 days'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.pos_imports where imported_at < now() - interval '2 days'$q$),
  true);

-- AC-18: PO rollback.
insert into public.purchase_orders (id, store_id, vendor_id, status)
values ('b1860050-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
        'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft');
select set_config('test.a18',
  pg_temp.try_sql($q$delete from public.purchase_orders where id = 'b1860050-0000-0000-0000-000000000001'$q$), true);

-- AC-21: a line on a 200-day draft.
select set_config('test.a21',
  pg_temp.try_sql($q$delete from public.po_items where id = 'b1860020-0000-0000-0000-00000000000c'$q$), true);

-- AC-22
select set_config('test.a22_admin',
  pg_temp.try_sql($q$delete from public.purchase_orders where id = 'b1860040-0000-0000-0000-0000000000a1'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.waste_log where id = 'b1860040-0000-0000-0000-0000000000a2'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.pos_imports where id = 'b1860040-0000-0000-0000-0000000000a3'$q$),
  true);

-- A19-0: visibility precondition for the deleteStore run.
select is(
  format('store=%s waste=%s po=%s pos=%s',
    (select count(*) from public.stores where id = 'b1860001-0000-0000-0000-000000000002'),
    (select count(*) from public.waste_log where store_id = 'b1860001-0000-0000-0000-000000000002'),
    (select count(*) from public.purchase_orders where store_id = 'b1860001-0000-0000-0000-000000000002'),
    (select count(*) from public.pos_imports where store_id = 'b1860001-0000-0000-0000-000000000002')),
  'store=1 waste=2 po=2 pos=2',
  'A19-0: admin can see the store and its fresh and 200-day rows'
);

-- AC-19: db.deleteStore's statements in order, each independent, as the client.
select set_config('test.a19_l185', pg_temp.try_sql($q$delete from public.inventory_items where store_id = 'b1860001-0000-0000-0000-000000000002'$q$), true);
select set_config('test.a19_l186', pg_temp.try_sql($q$delete from public.recipes where store_id = 'b1860001-0000-0000-0000-000000000002'$q$), true);
select set_config('test.a19_l187', pg_temp.try_sql($q$delete from public.eod_submissions where store_id = 'b1860001-0000-0000-0000-000000000002'$q$), true);
select set_config('test.a19_l188', pg_temp.try_sql($q$delete from public.waste_log where store_id = 'b1860001-0000-0000-0000-000000000002'$q$), true);
reset role;
select set_config('test.a19_mid',
  format('fresh=%s aged=%s',
    (select count(*) from public.waste_log where id = 'b1860060-0000-0000-0000-000000000001'),
    (select count(*) from public.waste_log where id = 'b1860060-0000-0000-0000-000000000002')),
  true);
set local role authenticated;
select set_config('test.a19_l190', pg_temp.try_sql($q$delete from public.user_stores where store_id = 'b1860001-0000-0000-0000-000000000002'$q$), true);
select set_config('test.a19_l191', pg_temp.try_sql($q$delete from public.stores where id = 'b1860001-0000-0000-0000-000000000002'$q$), true);

-- T-2: a store delete that fails on a po_items line.
select set_config('test.t2', pg_temp.try_sql($q$delete from public.stores where id = 'b1860001-0000-0000-0000-000000000003'$q$), true);


-- ══════════════════════════════════════════════════════════════════════════
-- Super_admin block — profiles.role='super_admin', JWT 'user'
-- ══════════════════════════════════════════════════════════════════════════
select pg_temp.jwt('33333333-3333-3333-3333-333333333333', 'user');

-- A14-2 (AC-14)
select is(pg_temp.kept_rows(), 'po=2 poi=1 voa=1 waste=1 pos=1 posi=1',
  'A14-2: super_admin can SELECT the 200-day rows');

select set_config('test.a16_super', pg_temp.old_purge(), true);
reset role;
select set_config('test.a15_super', pg_temp.kept_rows(), true);
set local role authenticated;

select set_config('test.a22_super',
  pg_temp.try_sql($q$delete from public.purchase_orders where id = 'b1860040-0000-0000-0000-0000000000b1'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.waste_log where id = 'b1860040-0000-0000-0000-0000000000b2'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.pos_imports where id = 'b1860040-0000-0000-0000-0000000000b3'$q$),
  true);

-- AC-20
select set_config('test.a20',
  pg_temp.try_sql($q$select public.hard_delete_brand('b1860000-0000-0000-0000-000000000002')$q$), true);


-- ══════════════════════════════════════════════════════════════════════════
-- Staff block — profiles.role='user', JWT 'user', grants on S1 + the T-1 store
-- ══════════════════════════════════════════════════════════════════════════
select pg_temp.jwt('22222222-2222-2222-2222-222222222222', 'user');

-- A14-3 (AC-14)
select is(pg_temp.kept_rows(), 'po=2 poi=1 voa=1 waste=1 pos=1 posi=1',
  'A14-3: store-member staff can SELECT the 200-day rows');

select set_config('test.a16_staff', pg_temp.old_purge(), true);
reset role;
select set_config('test.a15_staff', pg_temp.kept_rows(), true);
set local role authenticated;

select set_config('test.a22_staff',
  pg_temp.try_sql($q$delete from public.purchase_orders where id = 'b1860040-0000-0000-0000-0000000000c1'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.waste_log where id = 'b1860040-0000-0000-0000-0000000000c2'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.pos_imports where id = 'b1860040-0000-0000-0000-0000000000c3'$q$),
  true);

-- T-1 precondition + attempt: staff sees the store and the row, and cannot
-- remove the kept row by deleting the store, because privileged_delete_stores
-- refuses them.
select set_config('test.t1_visible',
  format('store=%s waste=%s',
    (select count(*) from public.stores where id = 'b1860001-0000-0000-0000-000000000004'),
    (select count(*) from public.waste_log where id = 'b1860071-0000-0000-0000-000000000001')),
  true);
select set_config('test.t1', pg_temp.try_sql($q$delete from public.stores where id = 'b1860001-0000-0000-0000-000000000004'$q$), true);


-- ══════════════════════════════════════════════════════════════════════════
-- Beyond the margin (AC-17). Last attempt in the file, because the old purge's
-- unfiltered statement with a future cutoff reaches every row under 1 day old
-- that the admin can see.
-- ══════════════════════════════════════════════════════════════════════════
select pg_temp.jwt('11111111-1111-1111-1111-111111111111', 'admin');

select set_config('test.a17_wrong_po',
  pg_temp.try_sql($q$delete from public.purchase_orders where created_at < now() + interval '30 days'$q$), true);
select set_config('test.a17_wrong_w',
  pg_temp.try_sql($q$delete from public.waste_log where logged_at < now() + interval '30 days'$q$), true);
select set_config('test.a17_wrong_pos',
  pg_temp.try_sql($q$delete from public.pos_imports where imported_at < now() + interval '30 days'$q$), true);


-- ══════════════════════════════════════════════════════════════════════════
-- Superuser read-back block
-- ══════════════════════════════════════════════════════════════════════════
reset role;

-- AC-15: per-caller state stashed as postgres straight after each attempt.
select is(current_setting('test.a15_admin', true), 'po=2 poi=1 voa=1 waste=1 pos=1 posi=1',
  'A15-1: the old purge as admin leaves the 200-day PO, lines, attempts, waste, POS and POS lines');
select is(current_setting('test.a15_super', true), 'po=2 poi=1 voa=1 waste=1 pos=1 posi=1',
  'A15-2: the old purge as super_admin leaves them');
select is(current_setting('test.a15_staff', true), 'po=2 poi=1 voa=1 waste=1 pos=1 posi=1',
  'A15-3: the old purge as store-member staff leaves them');

-- AC-16: refusal is 0 rows and no error.
select is(current_setting('test.a16_admin', true), 'ok:0|ok:0|ok:0',
  'A16-1: as admin each statement reports 0 rows and no error');
select is(current_setting('test.a16_super', true), 'ok:0|ok:0|ok:0',
  'A16-2: as super_admin each statement reports 0 rows and no error');
select is(current_setting('test.a16_staff', true), 'ok:0|ok:0|ok:0',
  'A16-3: as staff each statement reports 0 rows and no error');
select is(current_setting('test.a16_admin_eod', true), 'ok:0',
  'A16-4: the old purge''s eod_submissions statement stays 0 rows and no error');

-- AC-17: 1-day boundary.
select is(
  current_setting('test.a17_po_old', true) || ' left=' ||
    (select count(*) from public.purchase_orders where id = 'b1860030-0000-0000-0000-000000000001'),
  'ok:0 left=1', 'A17-1: purchase_orders row 1 day + 1 minute old is refused');
select is(
  current_setting('test.a17_po_young', true) || ' left=' ||
    (select count(*) from public.purchase_orders where id = 'b1860030-0000-0000-0000-000000000002'),
  'ok:1 left=0', 'A17-2: purchase_orders row 1 day - 1 minute old is deleted');
select is(
  current_setting('test.a17_w_old', true) || ' left=' ||
    (select count(*) from public.waste_log where id = 'b1860030-0000-0000-0000-000000000011'),
  'ok:0 left=1', 'A17-3: waste_log row 1 day + 1 minute old is refused');
select is(
  current_setting('test.a17_w_young', true) || ' left=' ||
    (select count(*) from public.waste_log where id = 'b1860030-0000-0000-0000-000000000012'),
  'ok:1 left=0', 'A17-4: waste_log row 1 day - 1 minute old is deleted');
select is(
  current_setting('test.a17_pos_old', true) || ' left=' ||
    (select count(*) from public.pos_imports where id = 'b1860030-0000-0000-0000-000000000021'),
  'ok:0 left=1', 'A17-5: pos_imports row 1 day + 1 minute old is refused');
select is(
  current_setting('test.a17_pos_young', true) || ' left=' ||
    (select count(*) from public.pos_imports where id = 'b1860030-0000-0000-0000-000000000022'),
  'ok:1 left=0', 'A17-6: pos_imports row 1 day - 1 minute old is deleted');

-- AC-17: fast clock, 88 days.
select is(
  current_setting('test.a17_fast', true) || format(' left=%s,%s,%s',
    (select count(*) from public.purchase_orders where id = 'b1860030-0000-0000-0000-000000000003'),
    (select count(*) from public.waste_log where id = 'b1860030-0000-0000-0000-000000000013'),
    (select count(*) from public.pos_imports where id = 'b1860030-0000-0000-0000-000000000023')),
  'ok:0|ok:0|ok:0 left=1,1,1',
  'A17-7: a clock 88 days fast cannot reach 3-day rows on any of the three tables'
);

-- AC-17: beyond the margin, the stated residual. Row counts are not pinned,
-- because the statement also reaches any fresh seed row.
select is(
  format('%s,%s,%s',
    (select count(*) from public.purchase_orders where id = 'b1860030-0000-0000-0000-000000000004'),
    (select count(*) from public.waste_log where id = 'b1860030-0000-0000-0000-000000000014'),
    (select count(*) from public.pos_imports where id = 'b1860030-0000-0000-0000-000000000024')),
  '0,0,0',
  'A17-8: a clock 120 days fast deletes the 23-hour rows on all three tables (the stated residual)'
);
select ok(
  current_setting('test.a17_wrong_po', true) like 'ok:%'
  and current_setting('test.a17_wrong_w', true) like 'ok:%'
  and current_setting('test.a17_wrong_pos', true) like 'ok:%',
  'A17-9: those statements raise no error'
);
select is(
  format('%s,%s,%s',
    (select count(*) from public.purchase_orders where id = 'b1860030-0000-0000-0000-000000000001'),
    (select count(*) from public.waste_log where id = 'b1860030-0000-0000-0000-000000000011'),
    (select count(*) from public.pos_imports where id = 'b1860030-0000-0000-0000-000000000021')),
  '1,1,1',
  'A17-10: even beyond the margin, rows over 1 day old stay refused'
);

-- AC-18
select is(
  current_setting('test.a18', true) || ' left=' ||
    (select count(*) from public.purchase_orders where id = 'b1860050-0000-0000-0000-000000000001'),
  'ok:1 left=0',
  'A18: admin deleting a just-inserted purchase_orders row by id removes it (PO rollback)'
);

-- AC-21
select is(
  current_setting('test.a21', true) || format(' line=%s po=%s',
    (select count(*) from public.po_items where id = 'b1860020-0000-0000-0000-00000000000c'),
    (select count(*) from public.purchase_orders where id = 'b1860020-0000-0000-0000-00000000000b')),
  'ok:1 line=0 po=1',
  'A21: admin can delete a line on a 200-day draft, and the draft stays'
);

-- AC-22
select is(
  current_setting('test.a22_admin', true) || ' left=' ||
    (select count(*) from (
       select id from public.purchase_orders where id = 'b1860040-0000-0000-0000-0000000000a1'
       union all select id from public.waste_log where id = 'b1860040-0000-0000-0000-0000000000a2'
       union all select id from public.pos_imports where id = 'b1860040-0000-0000-0000-0000000000a3') x),
  'ok:1|ok:1|ok:1 left=0',
  'A22-1: admin can still delete 12-hour rows on all three tables'
);
select is(
  current_setting('test.a22_super', true) || ' left=' ||
    (select count(*) from (
       select id from public.purchase_orders where id = 'b1860040-0000-0000-0000-0000000000b1'
       union all select id from public.waste_log where id = 'b1860040-0000-0000-0000-0000000000b2'
       union all select id from public.pos_imports where id = 'b1860040-0000-0000-0000-0000000000b3') x),
  'ok:1|ok:1|ok:1 left=0',
  'A22-2: super_admin can still delete 12-hour rows on all three tables'
);
select is(
  current_setting('test.a22_staff', true) || ' left=' ||
    (select count(*) from (
       select id from public.purchase_orders where id = 'b1860040-0000-0000-0000-0000000000c1'
       union all select id from public.waste_log where id = 'b1860040-0000-0000-0000-0000000000c2'
       union all select id from public.pos_imports where id = 'b1860040-0000-0000-0000-0000000000c3') x),
  'ok:1|ok:1|ok:1 left=0',
  'A22-3: store-member staff can still delete 12-hour rows on all three tables'
);

-- AC-19: per-statement SQLSTATEs from the design.
select is(current_setting('test.a19_l185', true), '23503',
  'A19-1: L185 inventory_items delete raises 23503 because waste rows name the item');
select is(current_setting('test.a19_l186', true), '42703',
  'A19-2: L186 recipes delete raises 42703 (recipes.store_id was dropped)');
select is(current_setting('test.a19_l187', true), 'ok:0',
  'A19-3: L187 eod_submissions delete removes 0 rows');
select is(current_setting('test.a19_l188', true) || ' ' || current_setting('test.a19_mid', true),
  'ok:1 fresh=0 aged=1',
  'A19-4: L188 waste_log delete removes the fresh row and leaves the aged row');
select is(current_setting('test.a19_l190', true), 'ok:0',
  'A19-5: L190 user_stores delete succeeds');
select is(current_setting('test.a19_l191', true), 'ok:1',
  'A19-6: L191 stores delete succeeds');
select is(
  format('store=%s waste=%s po=%s pos=%s posi=%s',
    (select count(*) from public.stores where id = 'b1860001-0000-0000-0000-000000000002'),
    (select count(*) from public.waste_log where id in ('b1860060-0000-0000-0000-000000000001', 'b1860060-0000-0000-0000-000000000002')),
    (select count(*) from public.purchase_orders where id in ('b1860060-0000-0000-0000-000000000003', 'b1860060-0000-0000-0000-000000000004')),
    (select count(*) from public.pos_imports where id in ('b1860060-0000-0000-0000-000000000006', 'b1860060-0000-0000-0000-000000000007')),
    (select count(*) from public.pos_import_items where id = 'b1860060-0000-0000-0000-000000000008')),
  'store=0 waste=0 po=0 pos=0 posi=0',
  'A19-7: the store and all its fresh and 200-day rows are gone'
);

-- AC-20
select is(
  current_setting('test.a20', true) || format(' brand=%s store=%s po=%s waste=%s pos=%s posi=%s',
    (select count(*) from public.brands where id = 'b1860000-0000-0000-0000-000000000002'),
    (select count(*) from public.stores where id = 'b1860001-0000-0000-0000-000000000005'),
    (select count(*) from public.purchase_orders where id = 'b1860080-0000-0000-0000-000000000001'),
    (select count(*) from public.waste_log where id = 'b1860080-0000-0000-0000-000000000003'),
    (select count(*) from public.pos_imports where id = 'b1860080-0000-0000-0000-000000000004'),
    (select count(*) from public.pos_import_items where id = 'b1860080-0000-0000-0000-000000000005')),
  'ok:1 brand=0 store=0 po=0 waste=0 pos=0 posi=0',
  'A20: hard_delete_brand completes and removes the 200-day PO, waste and POS rows'
);

-- AC-25
select is(
  current_setting('test.a25', true) || format(' store=%s storeless=%s',
    (select count(*) from public.audit_log where id = 'b1860010-0000-0000-0000-000000000006'),
    (select count(*) from public.audit_log where id = 'b1860010-0000-0000-0000-000000000007')),
  'ok:1 store=0 storeless=1',
  'A25: the stale audit_log delete as admin raises no error, removes the in-scope row, and skips the store-less one'
);

-- T-1: staff cannot remove kept rows by deleting a store.
select is(
  current_setting('test.t1_visible', true) || ' ' || current_setting('test.t1', true) || format(' store=%s waste=%s',
    (select count(*) from public.stores where id = 'b1860001-0000-0000-0000-000000000004'),
    (select count(*) from public.waste_log where id = 'b1860071-0000-0000-0000-000000000001')),
  'store=1 waste=1 ok:0 store=1 waste=1',
  'T-1: staff who can see the store removes 0 rows with delete from stores, and the aged waste row stays'
);

-- T-2: a failed store delete leaves the kept rows in place.
select is(
  current_setting('test.t2', true) || format(' store=%s waste=%s',
    (select count(*) from public.stores where id = 'b1860001-0000-0000-0000-000000000003'),
    (select count(*) from public.waste_log where id = 'b1860070-0000-0000-0000-000000000001')),
  '23503 store=1 waste=1',
  'T-2: a store delete that fails on a po_items line raises 23503 and the aged waste row stays'
);

select * from finish();
rollback;
