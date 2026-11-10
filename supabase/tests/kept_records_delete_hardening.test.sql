-- supabase/tests/kept_records_delete_hardening.test.sql
--
-- Spec 194 / pgTAP for supabase/migrations/20261109170000_kept_records_delete_hardening.sql:
-- staff cannot re-date kept PO, waste and POS rows (closes spec 186 audit M1),
-- PO lines are deletable only under a draft and POS lines never directly (M2),
-- and neither line rule can be bypassed by moving a PO back to draft or moving
-- a line to another parent.
--
-- Arm map (spec 194 ACs):
--   C-1..C-6     catalog: policies, triggers, firing order, functions, the
--                spec 186 comment rewrite, no eod_* DELETE policy
--                (AC-28, AC-29, AC-30, AC-31)
--   PRE-*        every fixture exists; each caller can SELECT the rows it acts on
--   AC1-*, AC2-* staff date changes raise 42501 (200-day, 1-hour, now(), NULL)
--   AC3-*        M1 replay: re-date then delete leaves the rows
--   AC4-*, AC5-* privileged date changes; the accepted two-step residual
--   AC6-*        pass-through SETs
--   AC7-*        staff updates and RPCs that must keep working
--   AC8-*        server contexts: postgres, service_role, postgres with staff
--                claims, staff through a SECURITY DEFINER wrapper
--   AC9-*        explicit-date INSERTs
--   AC10..AC14   PO line deletes
--   AC15..AC19   POS line deletes, cascade, alias update, Breadbot insert
--   AC20..AC24   status into draft, line moves, pass-throughs
--   PGBYPASS-*   the delete rules do not bind postgres
--
-- AC-25 (refusal shape) is covered by every throws_ok below, each of which pins
-- SQLSTATE and message byte for byte, and by the 'ok:0' + read-back arms for
-- the silent line-delete refusals.
--
-- Read-back rule (spec 186): every arm that claims a row or value survived,
-- changed or was removed reads it back by fixture id as postgres in a later
-- block. Each caller's results are stashed with set_config and asserted in the
-- final postgres block. PRE-* are the visibility preconditions, so a 0-row
-- result cannot come from RLS hiding the row from that caller.
--
-- Stale claims: the date guard treats `postgres` with user claims as that user
-- (D-2). Every postgres block below that changes a date clears
-- request.jwt.claims first. Do not use `set role anon` (spec 067).
--
-- now() is the transaction start, so fixture dates and read-backs share one
-- clock.
--
-- Principals:
--   staff   22222222-… profiles.role='user', user_stores grant on Towson, JWT 'user'
--   admin   11111111-… profiles.role='admin', brand A, JWT 'admin'
--   master  33333333-… profiles.role='master', brand A, JWT 'master'
--   super   33333333-… promoted in-txn to super_admin, brand_id NULL, JWT 'user'
--   adminB  b194a0ff-…-01 profiles.role='admin', brand B, JWT 'admin' (AC-13)
--   Store A = Towson 00000000-…-0001 (brand A); store B = b194a001-…-01 (brand B)
--
-- Fixture ids: b194a0GG-0000-0000-0000-0000000000NN.
--   GG=10 purchase_orders (200 days unless noted, Towson unless noted)
--     01 P_D draft   02 P_S sent   03 P_P partial   04 P_R received
--     05 P_C cancelled   06 P_H draft 1 hour   07 P_B draft, store B
--     08 P_U draft (AC-12)   09 P_14 draft 1 hour (AC-14)
--     0a P_7a draft   0b P_7b draft   0c P_7c sent   0d P_7d sent (AC-7)
--     0e P_Z received (AC-25)   11/12/13 P_4 admin/master/super (AC-4)
--     16 staff explicit-date insert (AC-9)
--   GG=20 po_items
--     01 L_D1  02 L_D2  03 L_D3 on P_D   04 L_S  05 L_P  06 L_R  07 L_C
--     08 L_H1  09 L_H2 on P_H   0a L_B on P_B   0b L_U1  0c L_U2 on P_U
--     0d L_14 on P_14   0e L_7c on P_7c   0f L_Z on P_Z
--   GG=21 vendor_order_attempts: 01 on P_14
--   GG=22 po_items inserted by the AC-12 sequence: 01, 02
--   GG=30 waste_log
--     01 W_old  02 W_new (1 hour)  03/04/05 W_4 admin/master/super  06 W_5
--     07 W_8a  08 W_8b  09 W_8c  0a W_8d   0b staff insert  0c postgres insert
--   GG=40 pos_imports
--     01 I_old  02 I_new (1 hour)  03 I_17 (1 hour)  04/05/06 I_4 a/m/s
--     07 I_Z  08 I_19 (service role)  0b staff insert
--   GG=50 pos_import_items: 01 PL_old  02 PL_new  03 PL_17  07 PL_Z  08 PL_19

begin;
create extension if not exists pgtap;

select plan(103);

-- ── helpers ───────────────────────────────────────────────────────────────
-- Copied from retention_prune_job.test.sql. Returns 'ok:<row_count>' or the
-- SQLSTATE, so an error does not stop the next statement.
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

-- What every store-A caller must be able to SELECT before its arms run.
create function pg_temp.vis() returns text
language sql as $$
  select format('po=%s poi=%s waste=%s pos=%s posi=%s',
    (select count(*) from public.purchase_orders where id in (
       'b194a010-0000-0000-0000-000000000001', 'b194a010-0000-0000-0000-000000000002',
       'b194a010-0000-0000-0000-000000000003', 'b194a010-0000-0000-0000-000000000004',
       'b194a010-0000-0000-0000-000000000005', 'b194a010-0000-0000-0000-000000000006')),
    (select count(*) from public.po_items where id in (
       'b194a020-0000-0000-0000-000000000004', 'b194a020-0000-0000-0000-000000000005',
       'b194a020-0000-0000-0000-000000000006', 'b194a020-0000-0000-0000-000000000007')),
    (select count(*) from public.waste_log where id in (
       'b194a030-0000-0000-0000-000000000001', 'b194a030-0000-0000-0000-000000000002')),
    (select count(*) from public.pos_imports where id in (
       'b194a040-0000-0000-0000-000000000001', 'b194a040-0000-0000-0000-000000000002')),
    (select count(*) from public.pos_import_items where id in (
       'b194a050-0000-0000-0000-000000000001', 'b194a050-0000-0000-0000-000000000002')));
$$;

-- AC-10: one delete per non-draft PO line (sent, partial, received, cancelled).
create function pg_temp.del_non_draft_lines() returns text
language sql as $$
  select pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-000000000004'$q$)
         || '|' || pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-000000000005'$q$)
         || '|' || pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-000000000006'$q$)
         || '|' || pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-000000000007'$q$);
$$;

-- AC-15, AC-16: the 200-day and the 1-hour POS line.
create function pg_temp.del_pos_lines() returns text
language sql as $$
  select pg_temp.try_sql($q$delete from public.pos_import_items where id = 'b194a050-0000-0000-0000-000000000001'$q$)
         || '|' || pg_temp.try_sql($q$delete from public.pos_import_items where id = 'b194a050-0000-0000-0000-000000000002'$q$);
$$;

-- AC-8 (d): a SECURITY DEFINER function owned by postgres that re-dates a
-- waste row. Called as staff, it must still be refused.
create function pg_temp.sd_redate_waste(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.waste_log set logged_at = now() where id = p_id;
end;
$$;

-- ── principals ────────────────────────────────────────────────────────────
insert into public.brands (id, name, deleted_at) values
  ('b194a000-0000-0000-0000-000000000001', 'Brand B (test 194)', null);

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time) values
  ('b194a001-0000-0000-0000-000000000001', 'b194a000-0000-0000-0000-000000000001', 'Store B (test 194)', '1 Way', 'active', '22:00');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
) values (
  'b194a0ff-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 's194-adminb@local.test', '',
  now(), now(), now(),
  jsonb_build_object('provider', 'email', 'role', 'admin'), '{}'::jsonb, false, false,
  '', '', '', '', '', '', '', '');

insert into public.profiles (id, name, role, initials, color, status, brand_id) values
  ('b194a0ff-0000-0000-0000-000000000001', 's194 brand-B admin', 'admin', 'BA', '#888888', 'active',
   'b194a000-0000-0000-0000-000000000001')
on conflict (id) do update
  set role = excluded.role, brand_id = excluded.brand_id, name = excluded.name;

-- ── catalog, items, recipe ────────────────────────────────────────────────
insert into public.catalog_ingredients (id, brand_id, name, unit, case_qty, sub_unit_size, default_cost) values
  ('b194a002-0000-0000-0000-000000000001', '2a000000-0000-0000-0000-000000000001', '__test_spec194_item_a__', 'each', 4, 1, 5),
  ('b194a002-0000-0000-0000-000000000002', 'b194a000-0000-0000-0000-000000000001', '__test_spec194_item_b__', 'each', 4, 1, 5);

insert into public.inventory_items (id, store_id, catalog_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion) values
  ('b194a003-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'b194a002-0000-0000-0000-000000000001', 20, 5, 0, 0, 0),
  ('b194a003-0000-0000-0000-000000000002', 'b194a001-0000-0000-0000-000000000001', 'b194a002-0000-0000-0000-000000000002', 20, 5, 0, 0, 0);

insert into public.recipes (id, menu_item, brand_id) values
  ('b194a004-0000-0000-0000-000000000001', '__test_spec194_recipe__', '2a000000-0000-0000-0000-000000000001');

-- ── purchase_orders (explicit created_at as postgres; AC-9 shows it is allowed) ─
insert into public.purchase_orders (id, store_id, vendor_id, status, created_at) values
  ('b194a010-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',     now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'sent',      now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'partial',   now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'received',  now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'cancelled', now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',     now() - interval '1 hour'),
  ('b194a010-0000-0000-0000-000000000007', 'b194a001-0000-0000-0000-000000000001', null,                                   'draft',     now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',     now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',     now() - interval '1 hour'),
  ('b194a010-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',     now() - interval '200 days'),
  ('b194a010-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',     now() - interval '200 days'),
  ('b194a010-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'sent',      now() - interval '200 days'),
  ('b194a010-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'sent',      now() - interval '200 days'),
  ('b194a010-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'received',  now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',     now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',     now() - interval '200 days'),
  ('b194a010-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'draft',     now() - interval '200 days');

insert into public.po_items (id, po_id, item_id, ordered_qty) values
  ('b194a020-0000-0000-0000-000000000001', 'b194a010-0000-0000-0000-000000000001', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-000000000002', 'b194a010-0000-0000-0000-000000000001', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-000000000003', 'b194a010-0000-0000-0000-000000000001', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-000000000004', 'b194a010-0000-0000-0000-000000000002', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-000000000005', 'b194a010-0000-0000-0000-000000000003', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-000000000006', 'b194a010-0000-0000-0000-000000000004', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-000000000007', 'b194a010-0000-0000-0000-000000000005', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-000000000008', 'b194a010-0000-0000-0000-000000000006', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-000000000009', 'b194a010-0000-0000-0000-000000000006', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-00000000000a', 'b194a010-0000-0000-0000-000000000007', 'b194a003-0000-0000-0000-000000000002', 1),
  ('b194a020-0000-0000-0000-00000000000b', 'b194a010-0000-0000-0000-000000000008', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-00000000000c', 'b194a010-0000-0000-0000-000000000008', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-00000000000d', 'b194a010-0000-0000-0000-000000000009', 'b194a003-0000-0000-0000-000000000001', 1),
  ('b194a020-0000-0000-0000-00000000000e', 'b194a010-0000-0000-0000-00000000000c', 'b194a003-0000-0000-0000-000000000001', 2),
  ('b194a020-0000-0000-0000-00000000000f', 'b194a010-0000-0000-0000-00000000000e', 'b194a003-0000-0000-0000-000000000001', 1);

insert into public.vendor_order_attempts (id, po_id, store_id, vendor_id, outcome, stage) values
  ('b194a021-0000-0000-0000-000000000001', 'b194a010-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001',
   'b1ee724a-8626-45ab-85d4-14a99e7cbc45', 'failed', 'error');

-- ── waste_log ─────────────────────────────────────────────────────────────
insert into public.waste_log (id, store_id, item_id, quantity, unit, reason, logged_at)
select v.id::uuid, '00000000-0000-0000-0000-000000000001', 'b194a003-0000-0000-0000-000000000001', 1, 'each', '__test_spec194__', v.at
  from (values
    ('b194a030-0000-0000-0000-000000000001', now() - interval '200 days'),
    ('b194a030-0000-0000-0000-000000000002', now() - interval '1 hour'),
    ('b194a030-0000-0000-0000-000000000003', now() - interval '200 days'),
    ('b194a030-0000-0000-0000-000000000004', now() - interval '200 days'),
    ('b194a030-0000-0000-0000-000000000005', now() - interval '200 days'),
    ('b194a030-0000-0000-0000-000000000006', now() - interval '200 days'),
    ('b194a030-0000-0000-0000-000000000007', now() - interval '200 days'),
    ('b194a030-0000-0000-0000-000000000008', now() - interval '200 days'),
    ('b194a030-0000-0000-0000-000000000009', now() - interval '200 days'),
    ('b194a030-0000-0000-0000-00000000000a', now() - interval '200 days')) as v(id, at);

-- ── pos_imports + lines ───────────────────────────────────────────────────
insert into public.pos_imports (id, store_id, filename, import_date, imported_at)
select v.id::uuid, '00000000-0000-0000-0000-000000000001', '__test_spec194__.csv', date '1999-03-03', v.at
  from (values
    ('b194a040-0000-0000-0000-000000000001', now() - interval '200 days'),
    ('b194a040-0000-0000-0000-000000000002', now() - interval '1 hour'),
    ('b194a040-0000-0000-0000-000000000003', now() - interval '1 hour'),
    ('b194a040-0000-0000-0000-000000000004', now() - interval '200 days'),
    ('b194a040-0000-0000-0000-000000000005', now() - interval '200 days'),
    ('b194a040-0000-0000-0000-000000000006', now() - interval '200 days'),
    ('b194a040-0000-0000-0000-000000000007', now() - interval '200 days')) as v(id, at);

insert into public.pos_import_items (id, import_id, menu_item, qty_sold, revenue, recipe_id) values
  ('b194a050-0000-0000-0000-000000000001', 'b194a040-0000-0000-0000-000000000001', '__test_spec194__', 1, 1, null),
  ('b194a050-0000-0000-0000-000000000002', 'b194a040-0000-0000-0000-000000000002', '__test_spec194__', 1, 1, null),
  ('b194a050-0000-0000-0000-000000000003', 'b194a040-0000-0000-0000-000000000003', '__test_spec194__', 1, 1, null),
  ('b194a050-0000-0000-0000-000000000007', 'b194a040-0000-0000-0000-000000000007', '__test_spec194__', 1, 1, null);


-- ══════════════════════════════════════════════════════════════════════════
-- Catalog (postgres)
-- ══════════════════════════════════════════════════════════════════════════

-- C-1a (AC-28, AC-30): the PERMISSIVE policies on the five tables are exactly
-- the 20 store_member_* policies. No new permissive policy, no SELECT rename.
select is(
  (select string_agg(tablename || '/' || policyname || '/' || cmd, ', ' order by tablename, policyname)
     from pg_policies
    where schemaname = 'public'
      and tablename in ('purchase_orders', 'po_items', 'waste_log', 'pos_imports', 'pos_import_items')
      and permissive = 'PERMISSIVE'),
  'po_items/store_member_delete_po_items/DELETE, po_items/store_member_insert_po_items/INSERT, '
  || 'po_items/store_member_read_po_items/SELECT, po_items/store_member_update_po_items/UPDATE, '
  || 'pos_import_items/store_member_delete_pos_import_items/DELETE, pos_import_items/store_member_insert_pos_import_items/INSERT, '
  || 'pos_import_items/store_member_read_pos_import_items/SELECT, pos_import_items/store_member_update_pos_import_items/UPDATE, '
  || 'pos_imports/store_member_delete_pos_imports/DELETE, pos_imports/store_member_insert_pos_imports/INSERT, '
  || 'pos_imports/store_member_read_pos_imports/SELECT, pos_imports/store_member_update_pos_imports/UPDATE, '
  || 'purchase_orders/store_member_delete_purchase_orders/DELETE, purchase_orders/store_member_insert_purchase_orders/INSERT, '
  || 'purchase_orders/store_member_read_purchase_orders/SELECT, purchase_orders/store_member_update_purchase_orders/UPDATE, '
  || 'waste_log/store_member_delete_waste_log/DELETE, waste_log/store_member_insert_waste_log/INSERT, '
  || 'waste_log/store_member_read_waste_log/SELECT, waste_log/store_member_update_waste_log/UPDATE',
  'C-1a: the PERMISSIVE policies on the five tables are exactly the 20 store_member_* policies'
);

-- C-1b (AC-28): the RESTRICTIVE policies are spec 186's three, unchanged, plus
-- this spec's two.
select is(
  (select string_agg(tablename || '/' || policyname || '/' || cmd || '/' || qual, ', ' order by tablename, policyname)
     from pg_policies
    where schemaname = 'public'
      and tablename in ('purchase_orders', 'po_items', 'waste_log', 'pos_imports', 'pos_import_items')
      and permissive = 'RESTRICTIVE'),
  'po_items/po_items_restrict_delete_non_draft/DELETE/(EXISTS ( SELECT 1' || chr(10)
  || '   FROM purchase_orders po' || chr(10)
  || '  WHERE ((po.id = po_items.po_id) AND (po.status = ''draft''::text)))), '
  || 'pos_import_items/pos_import_items_restrict_delete/DELETE/false, '
  || 'pos_imports/pos_imports_restrict_delete_aged/DELETE/(imported_at >= (now() - ''1 day''::interval)), '
  || 'purchase_orders/purchase_orders_restrict_delete_aged/DELETE/(created_at >= (now() - ''1 day''::interval)), '
  || 'waste_log/waste_log_restrict_delete_aged/DELETE/(logged_at >= (now() - ''1 day''::interval))',
  'C-1b: RESTRICTIVE DELETE policies are spec 186''s three (unchanged) plus po_items draft-only and pos_import_items never'
);

-- C-2: the six triggers, BEFORE ROW UPDATE OF one column, enabled, with the
-- date function's column argument.
select is(
  (select string_agg(format('%s/%s/%s/%s/%s/%s/%s',
            t.tgrelid::regclass, t.tgname, t.tgenabled, t.tgtype, p.proname,
            (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
              where a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])),
            encode(t.tgargs, 'escape')), ', ' order by t.tgname)
     from pg_trigger t
     join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal
      and t.tgname in ('purchase_orders_lock_created_at_trg', 'waste_log_lock_logged_at_trg',
                       'pos_imports_lock_imported_at_trg', 'purchase_orders_no_return_to_draft_trg',
                       'po_items_lock_po_id_trg', 'pos_import_items_lock_import_id_trg')),
  'po_items/po_items_lock_po_id_trg/O/19/po_items_lock_po_id/po_id/, '
  || 'pos_import_items/pos_import_items_lock_import_id_trg/O/19/pos_import_items_lock_import_id/import_id/, '
  || 'pos_imports/pos_imports_lock_imported_at_trg/O/19/kept_record_lock_date/imported_at/imported_at\000, '
  || 'purchase_orders/purchase_orders_lock_created_at_trg/O/19/kept_record_lock_date/created_at/created_at\000, '
  || 'purchase_orders/purchase_orders_no_return_to_draft_trg/O/19/purchase_orders_block_return_to_draft/status/, '
  || 'waste_log/waste_log_lock_logged_at_trg/O/19/kept_record_lock_date/logged_at/logged_at\000',
  'C-2: six BEFORE ROW UPDATE OF <col> triggers, enabled, on the right column and function'
);

-- C-2b: no user DELETE trigger on the two line tables, so the delete rules stay
-- policies and FK cascades keep working (D-3).
select is(
  (select count(*)::int from pg_trigger
    where not tgisinternal
      and tgrelid in ('public.po_items'::regclass, 'public.pos_import_items'::regclass)
      and (tgtype & 8) <> 0),
  0,
  'C-2b: po_items and pos_import_items have no user DELETE trigger'
);

-- C-3 (D-6): spec 177's store check fires before the po_id lock. Postgres
-- fires same-event triggers in name order (C collation), so read both names
-- from pg_trigger and require the store check to sort first. The behaviour
-- (the cross-store message wins) is pinned by cross_store_item_rejection T09.
select is(
  (select array_agg(tgname::text order by tgname collate "C") from pg_trigger
    where tgrelid = 'public.po_items'::regclass
      and not tgisinternal
      and tgname in ('po_items_check_store_trg', 'po_items_lock_po_id_trg')),
  array['po_items_check_store_trg', 'po_items_lock_po_id_trg']::text[],
  'C-3: both po_items triggers exist and the store check fires first'
);

-- C-4: the four functions are SECURITY INVOKER, pin search_path, and no
-- client role holds EXECUTE.
select is(
  (select string_agg(format('%s/%s/%s/%s/%s', p.proname, p.prosecdef, p.proconfig,
            has_function_privilege('anon', p.oid, 'execute'),
            has_function_privilege('authenticated', p.oid, 'execute')), ', ' order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('kept_record_lock_date', 'purchase_orders_block_return_to_draft',
                        'po_items_lock_po_id', 'pos_import_items_lock_import_id')),
  'kept_record_lock_date/f/{search_path=public}/f/f, '
  || 'po_items_lock_po_id/f/{search_path=public}/f/f, '
  || 'pos_import_items_lock_import_id/f/{search_path=public}/f/f, '
  || 'purchase_orders_block_return_to_draft/f/{search_path=public}/f/f',
  'C-4: four SECURITY INVOKER functions, search_path=public, no EXECUTE for anon or authenticated'
);

-- C-5 (AC-29): spec 186's three policy comments are rewritten.
select is(
  (select string_agg(format('%s:%s:%s:%s', pol.polname,
            d.description like 'spec 186: RESTRICTIVE.%',
            d.description not like '%Not a security boundary%',
            d.description like '%Since spec 194 (kept-records delete hardening), staff cannot change%'), ', ' order by pol.polname)
     from pg_policy pol
     join pg_description d on d.objoid = pol.oid and d.classoid = 'pg_policy'::regclass
    where pol.polname in ('purchase_orders_restrict_delete_aged', 'waste_log_restrict_delete_aged',
                          'pos_imports_restrict_delete_aged')),
  'pos_imports_restrict_delete_aged:t:t:t, '
  || 'purchase_orders_restrict_delete_aged:t:t:t, '
  || 'waste_log_restrict_delete_aged:t:t:t',
  'C-5: spec 186''s three comments keep their prefix, drop "Not a security boundary" and name spec 194'
);

-- C-6 (AC-31)
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('eod_submissions', 'eod_entries')
      and cmd in ('DELETE', 'ALL')),
  0,
  'C-6: no DELETE or ALL policy on eod_submissions or eod_entries'
);

-- PRE-0: every fixture exists.
select is(
  format('po=%s poi=%s voa=%s waste=%s pos=%s posi=%s',
    (select count(*) from public.purchase_orders where id::text like 'b194a010-%'),
    (select count(*) from public.po_items where id::text like 'b194a020-%'),
    (select count(*) from public.vendor_order_attempts where id::text like 'b194a021-%'),
    (select count(*) from public.waste_log where id::text like 'b194a030-%'),
    (select count(*) from public.pos_imports where id::text like 'b194a040-%'),
    (select count(*) from public.pos_import_items where id::text like 'b194a050-%')),
  'po=17 poi=15 voa=1 waste=10 pos=7 posi=4',
  'PRE-0: every fixture exists'
);


-- ══════════════════════════════════════════════════════════════════════════
-- Staff block — profiles.role='user', grant on Towson
-- ══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.jwt('22222222-2222-2222-2222-222222222222', 'user');

select is(pg_temp.vis(), 'po=6 poi=4 waste=2 pos=2 posi=2', 'PRE-staff: staff can SELECT the rows it acts on');

-- AC-1: 200-day rows, set to now().
select throws_ok($q$update public.purchase_orders set created_at = now() where id = 'b194a010-0000-0000-0000-000000000004'$q$,
  '42501', 'purchase_orders: created_at is immutable', 'AC1-1: staff cannot re-date the 200-day received PO');
select throws_ok($q$update public.waste_log set logged_at = now() where id = 'b194a030-0000-0000-0000-000000000001'$q$,
  '42501', 'waste_log: logged_at is immutable', 'AC1-2: staff cannot re-date the 200-day waste row');
select throws_ok($q$update public.pos_imports set imported_at = now() where id = 'b194a040-0000-0000-0000-000000000001'$q$,
  '42501', 'pos_imports: imported_at is immutable', 'AC1-3: staff cannot re-date the 200-day import');

-- AC-2: 1-hour rows, and NULL on both ages.
select throws_ok($q$update public.purchase_orders set created_at = now() where id = 'b194a010-0000-0000-0000-000000000006'$q$,
  '42501', 'purchase_orders: created_at is immutable', 'AC2-1: staff cannot re-date the 1-hour PO');
select throws_ok($q$update public.waste_log set logged_at = now() where id = 'b194a030-0000-0000-0000-000000000002'$q$,
  '42501', 'waste_log: logged_at is immutable', 'AC2-2: staff cannot re-date the 1-hour waste row');
select throws_ok($q$update public.pos_imports set imported_at = now() where id = 'b194a040-0000-0000-0000-000000000002'$q$,
  '42501', 'pos_imports: imported_at is immutable', 'AC2-3: staff cannot re-date the 1-hour import');
select throws_ok($q$update public.purchase_orders set created_at = null where id = 'b194a010-0000-0000-0000-000000000004'$q$,
  '42501', 'purchase_orders: created_at is immutable', 'AC2-4: staff cannot null the 200-day PO date');
select throws_ok($q$update public.waste_log set logged_at = null where id = 'b194a030-0000-0000-0000-000000000001'$q$,
  '42501', 'waste_log: logged_at is immutable', 'AC2-5: staff cannot null the 200-day waste date');
select throws_ok($q$update public.pos_imports set imported_at = null where id = 'b194a040-0000-0000-0000-000000000001'$q$,
  '42501', 'pos_imports: imported_at is immutable', 'AC2-6: staff cannot null the 200-day import date');
select throws_ok($q$update public.purchase_orders set created_at = null where id = 'b194a010-0000-0000-0000-000000000006'$q$,
  '42501', 'purchase_orders: created_at is immutable', 'AC2-7: staff cannot null the 1-hour PO date');
select throws_ok($q$update public.waste_log set logged_at = null where id = 'b194a030-0000-0000-0000-000000000002'$q$,
  '42501', 'waste_log: logged_at is immutable', 'AC2-8: staff cannot null the 1-hour waste date');
select throws_ok($q$update public.pos_imports set imported_at = null where id = 'b194a040-0000-0000-0000-000000000002'$q$,
  '42501', 'pos_imports: imported_at is immutable', 'AC2-9: staff cannot null the 1-hour import date');

-- AC-3 (M1 replay): re-date, then delete. Read back in the final block.
select set_config('test.ac3_po',
  pg_temp.try_sql($q$update public.purchase_orders set created_at = now() where id = 'b194a010-0000-0000-0000-000000000004'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000004'$q$), true);
select set_config('test.ac3_waste',
  pg_temp.try_sql($q$update public.waste_log set logged_at = now() where id = 'b194a030-0000-0000-0000-000000000001'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.waste_log where id = 'b194a030-0000-0000-0000-000000000001'$q$), true);
select set_config('test.ac3_pos',
  pg_temp.try_sql($q$update public.pos_imports set imported_at = now() where id = 'b194a040-0000-0000-0000-000000000001'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.pos_imports where id = 'b194a040-0000-0000-0000-000000000001'$q$), true);

-- AC-6: pass-through SETs as staff.
select set_config('test.ac6_staff',
  pg_temp.try_sql($q$update public.purchase_orders set created_at = created_at where id = 'b194a010-0000-0000-0000-000000000004'$q$) || '|' ||
  pg_temp.try_sql($q$update public.waste_log set logged_at = logged_at where id = 'b194a030-0000-0000-0000-000000000001'$q$) || '|' ||
  pg_temp.try_sql($q$update public.pos_imports set imported_at = imported_at where id = 'b194a040-0000-0000-0000-000000000001'$q$), true);

-- AC-7: updates and RPCs that must keep working on 200-day rows.
select set_config('test.ac7_mark_sent',
  pg_temp.try_sql($q$update public.purchase_orders set status = 'sent' where id = 'b194a010-0000-0000-0000-00000000000a'$q$), true);
select set_config('test.ac7_ext_sent',
  pg_temp.try_sql($q$update public.purchase_orders set status = 'sent' where id = 'b194a010-0000-0000-0000-00000000000b' and status = 'draft'$q$), true);
select set_config('test.ac7_total',
  pg_temp.try_sql($q$update public.purchase_orders set total_cost = 99 where id = 'b194a010-0000-0000-0000-000000000004'$q$), true);
select set_config('test.ac7_receive',
  pg_temp.try_sql($q$select public.receive_purchase_order('b194a010-0000-0000-0000-00000000000c',
      '[{"po_item_id":"b194a020-0000-0000-0000-00000000000e","received_qty":2}]'::jsonb,
      'b194a0ee-0000-0000-0000-000000000001'::uuid)$q$), true);
select set_config('test.ac7_cancel',
  pg_temp.try_sql($q$select public.cancel_purchase_order('b194a010-0000-0000-0000-00000000000d')$q$), true);
select set_config('test.ac7_waste_qty',
  pg_temp.try_sql($q$update public.waste_log set quantity = 7 where id = 'b194a030-0000-0000-0000-000000000001'$q$), true);
select set_config('test.ac7_pos_filename',
  pg_temp.try_sql($q$update public.pos_imports set filename = '__test_spec194_renamed__.csv' where id = 'b194a040-0000-0000-0000-000000000001'$q$), true);

-- AC-8 (d): a SECURITY DEFINER function does not hand staff the exemption.
select throws_ok($q$select pg_temp.sd_redate_waste('b194a030-0000-0000-0000-00000000000a')$q$,
  '42501', 'waste_log: logged_at is immutable', 'AC8-d: staff calling a postgres-owned SECURITY DEFINER re-date is refused');

-- AC-9: explicit-date INSERTs as staff.
select set_config('test.ac9_staff',
  pg_temp.try_sql($q$insert into public.waste_log (id, store_id, quantity, unit, reason, logged_at) values
      ('b194a030-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 1, 'each', '__test_spec194__', now() - interval '10 days')$q$) || '|' ||
  pg_temp.try_sql($q$insert into public.purchase_orders (id, store_id, status, created_at) values
      ('b194a010-0000-0000-0000-000000000016', '00000000-0000-0000-0000-000000000001', 'draft', now() - interval '10 days')$q$) || '|' ||
  pg_temp.try_sql($q$insert into public.pos_imports (id, store_id, filename, import_date, imported_at) values
      ('b194a040-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', '__test_spec194__.csv', date '1999-03-03', now() - interval '10 days')$q$), true);

-- AC-10
select set_config('test.ac10_staff', pg_temp.del_non_draft_lines(), true);

-- AC-11: a line on the 200-day draft and on the 1-hour draft.
select set_config('test.ac11_staff',
  pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-000000000001'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-000000000008'$q$), true);

-- AC-12: the upsertVendorDraftOrder UPDATE-path sequence on the 200-day draft.
select set_config('test.ac12_old',
  (select string_agg(id::text, ',' order by id) from public.po_items where po_id = 'b194a010-0000-0000-0000-000000000008'), true);
select set_config('test.ac12_seq',
  pg_temp.try_sql($q$insert into public.po_items (id, po_id, item_id, ordered_qty, received_qty, cost_per_unit) values
      ('b194a022-0000-0000-0000-000000000001', 'b194a010-0000-0000-0000-000000000008', 'b194a003-0000-0000-0000-000000000001', 3, null, 5),
      ('b194a022-0000-0000-0000-000000000002', 'b194a010-0000-0000-0000-000000000008', 'b194a003-0000-0000-0000-000000000001', 4, null, 5)$q$) || '|' ||
  pg_temp.try_sql(format('delete from public.po_items where id = any (%L::uuid[])',
                         '{' || current_setting('test.ac12_old', true) || '}')) || '|' ||
  pg_temp.try_sql($q$update public.purchase_orders set total_cost = 35 where id = 'b194a010-0000-0000-0000-000000000008'$q$), true);

-- AC-13: staff without a grant on store B.
select set_config('test.ac13_staff',
  pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-00000000000a'$q$), true);

-- AC-15, AC-16
select set_config('test.ac15_staff', pg_temp.del_pos_lines(), true);

-- AC-20
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000002'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-staff-sent: staff cannot move a sent PO to draft');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000003'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-staff-partial: staff cannot move a partial PO to draft');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000004'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-staff-received: staff cannot move a received PO to draft');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000005'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-staff-cancelled: staff cannot move a cancelled PO to draft');

-- AC-21: draft -> draft is a pass-through.
select set_config('test.ac21',
  pg_temp.try_sql($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000001'$q$), true);

-- AC-22, AC-23
select throws_ok($q$update public.po_items set po_id = 'b194a010-0000-0000-0000-000000000001' where id = 'b194a020-0000-0000-0000-000000000006'$q$,
  '42501', 'po_items: po_id is immutable', 'AC22-staff: staff cannot move the received PO''s line onto the same store''s draft');
select throws_ok($q$update public.pos_import_items set import_id = 'b194a040-0000-0000-0000-000000000002' where id = 'b194a050-0000-0000-0000-000000000001'$q$,
  '42501', 'pos_import_items: import_id is immutable', 'AC23-staff: staff cannot move the 200-day import''s line onto the 1-hour import');

-- AC-24: pass-through SETs of the parent ids.
select set_config('test.ac24',
  pg_temp.try_sql($q$update public.po_items set po_id = po_id where id = 'b194a020-0000-0000-0000-000000000006'$q$) || '|' ||
  pg_temp.try_sql($q$update public.pos_import_items set import_id = import_id where id = 'b194a050-0000-0000-0000-000000000001'$q$), true);


-- ══════════════════════════════════════════════════════════════════════════
-- Admin block — profiles.role='admin', JWT 'admin', brand A
-- ══════════════════════════════════════════════════════════════════════════
select pg_temp.jwt('11111111-1111-1111-1111-111111111111', 'admin');

select is(pg_temp.vis(), 'po=6 poi=4 waste=2 pos=2 posi=2', 'PRE-admin: admin can SELECT the rows it acts on');

-- AC-4
select set_config('test.ac4_admin',
  pg_temp.try_sql($q$update public.purchase_orders set created_at = now() - interval '5 days' where id = 'b194a010-0000-0000-0000-000000000011'$q$) || '|' ||
  pg_temp.try_sql($q$update public.waste_log set logged_at = now() - interval '5 days' where id = 'b194a030-0000-0000-0000-000000000003'$q$) || '|' ||
  pg_temp.try_sql($q$update public.pos_imports set imported_at = now() - interval '5 days' where id = 'b194a040-0000-0000-0000-000000000004'$q$), true);

-- AC-5 (accepted residual): admin re-dates a 200-day waste row and deletes it.
select set_config('test.ac5',
  pg_temp.try_sql($q$update public.waste_log set logged_at = now() where id = 'b194a030-0000-0000-0000-000000000006'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.waste_log where id = 'b194a030-0000-0000-0000-000000000006'$q$), true);

-- AC-6: pass-through SETs as admin.
select set_config('test.ac6_admin',
  pg_temp.try_sql($q$update public.purchase_orders set created_at = created_at where id = 'b194a010-0000-0000-0000-000000000004'$q$) || '|' ||
  pg_temp.try_sql($q$update public.waste_log set logged_at = logged_at where id = 'b194a030-0000-0000-0000-000000000001'$q$) || '|' ||
  pg_temp.try_sql($q$update public.pos_imports set imported_at = imported_at where id = 'b194a040-0000-0000-0000-000000000001'$q$), true);

-- AC-10
select set_config('test.ac10_admin', pg_temp.del_non_draft_lines(), true);

-- AC-11
select set_config('test.ac11_admin',
  pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-000000000002'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-000000000009'$q$), true);

-- AC-13: the brand-A admin cannot delete the line in brand B's store.
select set_config('test.ac13_admin_a',
  pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-00000000000a'$q$), true);

-- AC-14: PO rollback of the 1-hour draft cascades its line and attempt.
select set_config('test.ac14',
  pg_temp.try_sql($q$delete from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000009'$q$), true);

-- AC-15, AC-16
select set_config('test.ac15_admin', pg_temp.del_pos_lines(), true);

-- AC-17: deleting the 1-hour import cascades its line.
select set_config('test.ac17',
  pg_temp.try_sql($q$delete from public.pos_imports where id = 'b194a040-0000-0000-0000-000000000003'$q$), true);

-- AC-18: the applyAliasToPastImports update.
select set_config('test.ac18',
  pg_temp.try_sql($q$update public.pos_import_items set recipe_id = 'b194a004-0000-0000-0000-000000000001', recipe_mapped = true
      where id = 'b194a050-0000-0000-0000-000000000001'$q$), true);

-- AC-20, AC-22, AC-23
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000002'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-admin-sent');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000003'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-admin-partial');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000004'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-admin-received');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000005'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-admin-cancelled');
select throws_ok($q$update public.po_items set po_id = 'b194a010-0000-0000-0000-000000000001' where id = 'b194a020-0000-0000-0000-000000000006'$q$,
  '42501', 'po_items: po_id is immutable', 'AC22-admin');
select throws_ok($q$update public.pos_import_items set import_id = 'b194a040-0000-0000-0000-000000000002' where id = 'b194a050-0000-0000-0000-000000000001'$q$,
  '42501', 'pos_import_items: import_id is immutable', 'AC23-admin');


-- ══════════════════════════════════════════════════════════════════════════
-- Master block — profiles.role='master', JWT 'master', brand A
-- ══════════════════════════════════════════════════════════════════════════
select pg_temp.jwt('33333333-3333-3333-3333-333333333333', 'master');

select is(pg_temp.vis(), 'po=6 poi=4 waste=2 pos=2 posi=2', 'PRE-master: master can SELECT the rows it acts on');

select set_config('test.ac4_master',
  pg_temp.try_sql($q$update public.purchase_orders set created_at = now() - interval '6 days' where id = 'b194a010-0000-0000-0000-000000000012'$q$) || '|' ||
  pg_temp.try_sql($q$update public.waste_log set logged_at = now() - interval '6 days' where id = 'b194a030-0000-0000-0000-000000000004'$q$) || '|' ||
  pg_temp.try_sql($q$update public.pos_imports set imported_at = now() - interval '6 days' where id = 'b194a040-0000-0000-0000-000000000005'$q$), true);
select set_config('test.ac10_master', pg_temp.del_non_draft_lines(), true);
select set_config('test.ac15_master', pg_temp.del_pos_lines(), true);

select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000002'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-master-sent');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000003'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-master-partial');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000004'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-master-received');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000005'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-master-cancelled');
select throws_ok($q$update public.po_items set po_id = 'b194a010-0000-0000-0000-000000000001' where id = 'b194a020-0000-0000-0000-000000000006'$q$,
  '42501', 'po_items: po_id is immutable', 'AC22-master');
select throws_ok($q$update public.pos_import_items set import_id = 'b194a040-0000-0000-0000-000000000002' where id = 'b194a050-0000-0000-0000-000000000001'$q$,
  '42501', 'pos_import_items: import_id is immutable', 'AC23-master');


-- ══════════════════════════════════════════════════════════════════════════
-- Super_admin block — 3333 promoted in-txn, brand_id NULL, JWT 'user'
-- ══════════════════════════════════════════════════════════════════════════
reset role;
select set_config('request.jwt.claims', '', true);
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select pg_temp.jwt('33333333-3333-3333-3333-333333333333', 'user');

select is(pg_temp.vis(), 'po=6 poi=4 waste=2 pos=2 posi=2', 'PRE-super: super_admin can SELECT the rows it acts on');

select set_config('test.ac4_super',
  pg_temp.try_sql($q$update public.purchase_orders set created_at = now() - interval '7 days' where id = 'b194a010-0000-0000-0000-000000000013'$q$) || '|' ||
  pg_temp.try_sql($q$update public.waste_log set logged_at = now() - interval '7 days' where id = 'b194a030-0000-0000-0000-000000000005'$q$) || '|' ||
  pg_temp.try_sql($q$update public.pos_imports set imported_at = now() - interval '7 days' where id = 'b194a040-0000-0000-0000-000000000006'$q$), true);
select set_config('test.ac10_super', pg_temp.del_non_draft_lines(), true);
select set_config('test.ac15_super', pg_temp.del_pos_lines(), true);

select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000002'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-super-sent');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000003'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-super-partial');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000004'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-super-received');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000005'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-super-cancelled');
select throws_ok($q$update public.po_items set po_id = 'b194a010-0000-0000-0000-000000000001' where id = 'b194a020-0000-0000-0000-000000000006'$q$,
  '42501', 'po_items: po_id is immutable', 'AC22-super');
select throws_ok($q$update public.pos_import_items set import_id = 'b194a040-0000-0000-0000-000000000002' where id = 'b194a050-0000-0000-0000-000000000001'$q$,
  '42501', 'pos_import_items: import_id is immutable', 'AC23-super');


-- ══════════════════════════════════════════════════════════════════════════
-- Brand-B admin block (AC-13)
-- ══════════════════════════════════════════════════════════════════════════
select pg_temp.jwt('b194a0ff-0000-0000-0000-000000000001', 'admin');

-- Positive control: this principal works, and sees its own brand's line.
select is(
  format('own=%s other=%s',
    (select count(*) from public.po_items where id = 'b194a020-0000-0000-0000-00000000000a'),
    (select count(*) from public.po_items where id = 'b194a020-0000-0000-0000-000000000003')),
  'own=1 other=0',
  'PRE-adminB: the brand-B admin sees store B''s draft line and not store A''s'
);

select set_config('test.ac13_admin_b',
  pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-000000000003'$q$), true);


-- ══════════════════════════════════════════════════════════════════════════
-- service_role block (AC-8 b, AC-19)
-- ══════════════════════════════════════════════════════════════════════════
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok($q$update public.waste_log set logged_at = now() - interval '8 days' where id = 'b194a030-0000-0000-0000-000000000008'$q$,
  'AC8-b: service_role (claims role service_role) may change a date');

-- AC-19: the Breadbot insert shape.
select lives_ok($q$insert into public.pos_imports (id, store_id, filename, import_date, imported_by) values
    ('b194a040-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', '__test_spec194_breadbot__', date '1999-03-04', null)$q$,
  'AC19-1: service_role inserts a pos_imports row with imported_by NULL');
select lives_ok($q$insert into public.pos_import_items (id, import_id, menu_item, qty_sold, revenue, recipe_id) values
    ('b194a050-0000-0000-0000-000000000008', 'b194a040-0000-0000-0000-000000000008', '__test_spec194__', 2, 2, null)$q$,
  'AC19-2: service_role inserts its lines');


-- ══════════════════════════════════════════════════════════════════════════
-- postgres block (AC-8 a and c, AC-9, AC-20/22/23 for postgres, AC-25)
-- ══════════════════════════════════════════════════════════════════════════
reset role;
select set_config('request.jwt.claims', '', true);

-- AC-8 (a): no user JWT.
select lives_ok($q$update public.waste_log set logged_at = now() - interval '9 days' where id = 'b194a030-0000-0000-0000-000000000007'$q$,
  'AC8-a: postgres with no claims may change a date');

-- AC-9: explicit-date INSERT as postgres.
select lives_ok($q$insert into public.waste_log (id, store_id, quantity, unit, reason, logged_at) values
    ('b194a030-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 1, 'each', '__test_spec194__', now() - interval '11 days')$q$,
  'AC9-2: postgres inserts a waste row with an explicit date');

-- AC-20, AC-22, AC-23: no exemption for postgres.
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000002'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-postgres-sent');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000003'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-postgres-partial');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000004'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-postgres-received');
select throws_ok($q$update public.purchase_orders set status = 'draft' where id = 'b194a010-0000-0000-0000-000000000005'$q$,
  '42501', 'purchase_orders: status cannot return to draft', 'AC20-postgres-cancelled');
select throws_ok($q$update public.po_items set po_id = 'b194a010-0000-0000-0000-000000000001' where id = 'b194a020-0000-0000-0000-000000000006'$q$,
  '42501', 'po_items: po_id is immutable', 'AC22-postgres');
select throws_ok($q$update public.pos_import_items set import_id = 'b194a040-0000-0000-0000-000000000002' where id = 'b194a050-0000-0000-0000-000000000001'$q$,
  '42501', 'pos_import_items: import_id is immutable', 'AC23-postgres');

-- AC-25: the line-delete rules are policies, so they do not bind postgres.
select is(
  pg_temp.try_sql($q$delete from public.po_items where id = 'b194a020-0000-0000-0000-00000000000f'$q$) || '|' ||
  pg_temp.try_sql($q$delete from public.pos_import_items where id = 'b194a050-0000-0000-0000-000000000007'$q$),
  'ok:1|ok:1',
  'PGBYPASS-postgres: postgres deletes a line under a received PO and a POS line (RLS bypass)'
);

-- AC-8 (c): postgres carrying staff claims is treated as staff.
select pg_temp.jwt('22222222-2222-2222-2222-222222222222', 'user');
select throws_ok($q$update public.waste_log set logged_at = now() where id = 'b194a030-0000-0000-0000-000000000009'$q$,
  '42501', 'waste_log: logged_at is immutable', 'AC8-c: postgres with staff claims cannot change a date');
select set_config('request.jwt.claims', '', true);


-- ══════════════════════════════════════════════════════════════════════════
-- Read-backs (postgres, claims cleared)
-- ══════════════════════════════════════════════════════════════════════════

-- AC-1, AC-2, AC-3: original dates on the 200-day and 1-hour rows.
select is(
  format('po200=%s po1h=%s',
    (select created_at = now() - interval '200 days' from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000004'),
    (select created_at = now() - interval '1 hour'   from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000006')),
  'po200=t po1h=t',
  'AC1-AC2-po: both PO rows keep their original created_at'
);
select is(
  format('w200=%s w1h=%s',
    (select logged_at = now() - interval '200 days' from public.waste_log where id = 'b194a030-0000-0000-0000-000000000001'),
    (select logged_at = now() - interval '1 hour'   from public.waste_log where id = 'b194a030-0000-0000-0000-000000000002')),
  'w200=t w1h=t',
  'AC1-AC2-waste: both waste rows keep their original logged_at'
);
select is(
  format('i200=%s i1h=%s',
    (select imported_at = now() - interval '200 days' from public.pos_imports where id = 'b194a040-0000-0000-0000-000000000001'),
    (select imported_at = now() - interval '1 hour'   from public.pos_imports where id = 'b194a040-0000-0000-0000-000000000002')),
  'i200=t i1h=t',
  'AC1-AC2-pos: both imports keep their original imported_at'
);
select is(current_setting('test.ac3_po', true) || ' ' || current_setting('test.ac3_waste', true) || ' ' || current_setting('test.ac3_pos', true),
  '42501|ok:0 42501|ok:0 42501|ok:0',
  'AC3-1: staff two-step: each re-date raised 42501 and each delete hit 0 rows');
select is(
  format('po=%s waste=%s pos=%s',
    (select count(*) from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000004' and created_at = now() - interval '200 days'),
    (select count(*) from public.waste_log where id = 'b194a030-0000-0000-0000-000000000001' and logged_at = now() - interval '200 days'),
    (select count(*) from public.pos_imports where id = 'b194a040-0000-0000-0000-000000000001' and imported_at = now() - interval '200 days')),
  'po=1 waste=1 pos=1',
  'AC3-2: the received PO, the waste row and the import are still there with their original dates'
);

-- AC-4
select is(current_setting('test.ac4_admin', true) || ' ' || current_setting('test.ac4_master', true) || ' ' || current_setting('test.ac4_super', true),
  'ok:1|ok:1|ok:1 ok:1|ok:1|ok:1 ok:1|ok:1|ok:1',
  'AC4-1: admin, master and super_admin each changed one date on each table');
select is(
  format('admin=%s/%s/%s master=%s/%s/%s super=%s/%s/%s',
    (select created_at  = now() - interval '5 days' from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000011'),
    (select logged_at   = now() - interval '5 days' from public.waste_log       where id = 'b194a030-0000-0000-0000-000000000003'),
    (select imported_at = now() - interval '5 days' from public.pos_imports     where id = 'b194a040-0000-0000-0000-000000000004'),
    (select created_at  = now() - interval '6 days' from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000012'),
    (select logged_at   = now() - interval '6 days' from public.waste_log       where id = 'b194a030-0000-0000-0000-000000000004'),
    (select imported_at = now() - interval '6 days' from public.pos_imports     where id = 'b194a040-0000-0000-0000-000000000005'),
    (select created_at  = now() - interval '7 days' from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000013'),
    (select logged_at   = now() - interval '7 days' from public.waste_log       where id = 'b194a030-0000-0000-0000-000000000005'),
    (select imported_at = now() - interval '7 days' from public.pos_imports     where id = 'b194a040-0000-0000-0000-000000000006')),
  'admin=t/t/t master=t/t/t super=t/t/t',
  'AC4-2: each privileged role''s new dates read back'
);

-- AC-5
select is(current_setting('test.ac5', true), 'ok:1|ok:1', 'AC5-1: admin re-dated the 200-day waste row and deleted it');
select is((select count(*)::int from public.waste_log where id = 'b194a030-0000-0000-0000-000000000006'), 0,
  'AC5-2: the re-dated waste row is gone (owner''s accepted residual)');

-- AC-6
select is(current_setting('test.ac6_staff', true) || ' ' || current_setting('test.ac6_admin', true),
  'ok:1|ok:1|ok:1 ok:1|ok:1|ok:1',
  'AC6: pass-through SET of each date succeeds for staff and admin');

-- AC-7: each staff update succeeded and reads back.
select is(current_setting('test.ac7_mark_sent', true) || '/' ||
          (select status from public.purchase_orders where id = 'b194a010-0000-0000-0000-00000000000a'),
  'ok:1/sent', 'AC7-1: staff marks a 200-day draft sent (markPurchaseOrderSent shape)');
select is(current_setting('test.ac7_ext_sent', true) || '/' ||
          (select status from public.purchase_orders where id = 'b194a010-0000-0000-0000-00000000000b'),
  'ok:1/sent', 'AC7-2: staff marks a 200-day draft sent with the extension''s status = draft filter');
select is(current_setting('test.ac7_total', true) || '/' ||
          (select total_cost::text from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000004'),
  'ok:1/99.00', 'AC7-3: staff updates total_cost on the 200-day received PO');
select is(current_setting('test.ac7_receive', true) || '/' ||
          (select status from public.purchase_orders where id = 'b194a010-0000-0000-0000-00000000000c') || '/' ||
          (select received_qty::text from public.po_items where id = 'b194a020-0000-0000-0000-00000000000e'),
  'ok:1/received/2.000', 'AC7-4: staff receives the 200-day sent PO through receive_purchase_order');
select is(current_setting('test.ac7_cancel', true) || '/' ||
          (select status from public.purchase_orders where id = 'b194a010-0000-0000-0000-00000000000d'),
  'ok:1/cancelled', 'AC7-5: staff cancels the 200-day sent PO through cancel_purchase_order');
select is(current_setting('test.ac7_waste_qty', true) || '/' ||
          (select quantity::text from public.waste_log where id = 'b194a030-0000-0000-0000-000000000001'),
  'ok:1/7.000', 'AC7-6: staff edits the 200-day waste row''s quantity');
select is(current_setting('test.ac7_pos_filename', true) || '/' ||
          (select filename from public.pos_imports where id = 'b194a040-0000-0000-0000-000000000001'),
  'ok:1/__test_spec194_renamed__.csv', 'AC7-7: staff edits the 200-day import''s filename');

-- AC-8
select is(
  format('a=%s b=%s',
    (select logged_at = now() - interval '9 days' from public.waste_log where id = 'b194a030-0000-0000-0000-000000000007'),
    (select logged_at = now() - interval '8 days' from public.waste_log where id = 'b194a030-0000-0000-0000-000000000008')),
  'a=t b=t',
  'AC8-ab: the postgres and service_role date changes read back'
);
select is(
  format('c=%s d=%s',
    (select logged_at = now() - interval '200 days' from public.waste_log where id = 'b194a030-0000-0000-0000-000000000009'),
    (select logged_at = now() - interval '200 days' from public.waste_log where id = 'b194a030-0000-0000-0000-00000000000a')),
  'c=t d=t',
  'AC8-cd: the refused postgres-with-staff-claims and SECURITY DEFINER rows keep their dates'
);

-- AC-9
select is(current_setting('test.ac9_staff', true), 'ok:1|ok:1|ok:1',
  'AC9-1: staff inserts waste, PO and import rows with explicit dates');
select is(
  format('%s/%s/%s/%s',
    (select logged_at   = now() - interval '10 days' from public.waste_log       where id = 'b194a030-0000-0000-0000-00000000000b'),
    (select created_at  = now() - interval '10 days' from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000016'),
    (select imported_at = now() - interval '10 days' from public.pos_imports     where id = 'b194a040-0000-0000-0000-00000000000b'),
    (select logged_at   = now() - interval '11 days' from public.waste_log       where id = 'b194a030-0000-0000-0000-00000000000c')),
  't/t/t/t',
  'AC9-3: the explicit dates read back'
);

-- AC-10
select is(
  current_setting('test.ac10_staff', true) || ' ' || current_setting('test.ac10_admin', true) || ' ' ||
  current_setting('test.ac10_master', true) || ' ' || current_setting('test.ac10_super', true),
  'ok:0|ok:0|ok:0|ok:0 ok:0|ok:0|ok:0|ok:0 ok:0|ok:0|ok:0|ok:0 ok:0|ok:0|ok:0|ok:0',
  'AC10-1: every role''s delete of each non-draft PO line hit 0 rows'
);
select is(
  format('sent=%s partial=%s received=%s cancelled=%s',
    (select count(*) from public.po_items where id = 'b194a020-0000-0000-0000-000000000004' and po_id = 'b194a010-0000-0000-0000-000000000002'),
    (select count(*) from public.po_items where id = 'b194a020-0000-0000-0000-000000000005' and po_id = 'b194a010-0000-0000-0000-000000000003'),
    (select count(*) from public.po_items where id = 'b194a020-0000-0000-0000-000000000006' and po_id = 'b194a010-0000-0000-0000-000000000004'),
    (select count(*) from public.po_items where id = 'b194a020-0000-0000-0000-000000000007' and po_id = 'b194a010-0000-0000-0000-000000000005')),
  'sent=1 partial=1 received=1 cancelled=1',
  'AC10-2: each non-draft line reads back present on its original PO (also AC-22)'
);

-- AC-11
select is(current_setting('test.ac11_staff', true) || ' ' || current_setting('test.ac11_admin', true),
  'ok:1|ok:1 ok:1|ok:1',
  'AC11-1: staff and admin each deleted a line on the 200-day draft and on the 1-hour draft');
select is(
  (select count(*)::int from public.po_items where id in (
     'b194a020-0000-0000-0000-000000000001', 'b194a020-0000-0000-0000-000000000002',
     'b194a020-0000-0000-0000-000000000008', 'b194a020-0000-0000-0000-000000000009')),
  0,
  'AC11-2: the four draft lines are gone'
);

-- AC-12
select is(current_setting('test.ac12_old', true) || ' ' || current_setting('test.ac12_seq', true),
  'b194a020-0000-0000-0000-00000000000b,b194a020-0000-0000-0000-00000000000c ok:2|ok:2|ok:1',
  'AC12-1: staff read both old ids, inserted two lines, deleted the two old ones and updated the total');
select is(
  (select string_agg(id::text, ',' order by id) from public.po_items where po_id = 'b194a010-0000-0000-0000-000000000008'),
  'b194a022-0000-0000-0000-000000000001,b194a022-0000-0000-0000-000000000002',
  'AC12-2: the 200-day draft ends with exactly the new lines'
);

-- AC-13
select is(
  current_setting('test.ac13_staff', true) || ' ' || current_setting('test.ac13_admin_a', true) || ' ' ||
  current_setting('test.ac13_admin_b', true),
  'ok:0 ok:0 ok:0',
  'AC13-1: staff without store B, the brand-A admin on store B, and the brand-B admin on store A each hit 0 rows'
);
select is(
  (select count(*)::int from public.po_items where id in ('b194a020-0000-0000-0000-00000000000a', 'b194a020-0000-0000-0000-000000000003')),
  2,
  'AC13-2: both draft lines read back present'
);

-- AC-14
select is(
  current_setting('test.ac14', true) || ' ' ||
  format('po=%s poi=%s voa=%s',
    (select count(*) from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000009'),
    (select count(*) from public.po_items where id = 'b194a020-0000-0000-0000-00000000000d'),
    (select count(*) from public.vendor_order_attempts where id = 'b194a021-0000-0000-0000-000000000001')),
  'ok:1 po=0 poi=0 voa=0',
  'AC14: admin deleting the 1-hour draft PO cascades its line and attempt'
);

-- AC-15, AC-16
select is(
  current_setting('test.ac15_staff', true) || ' ' || current_setting('test.ac15_admin', true) || ' ' ||
  current_setting('test.ac15_master', true) || ' ' || current_setting('test.ac15_super', true),
  'ok:0|ok:0 ok:0|ok:0 ok:0|ok:0 ok:0|ok:0',
  'AC15-AC16-1: every role''s delete of the 200-day and the 1-hour POS line hit 0 rows'
);
select is(
  format('old=%s new=%s',
    (select count(*) from public.pos_import_items where id = 'b194a050-0000-0000-0000-000000000001' and import_id = 'b194a040-0000-0000-0000-000000000001'),
    (select count(*) from public.pos_import_items where id = 'b194a050-0000-0000-0000-000000000002' and import_id = 'b194a040-0000-0000-0000-000000000002')),
  'old=1 new=1',
  'AC15-AC16-2: both POS lines read back present on their original imports (also AC-23)'
);

-- AC-17
select is(
  current_setting('test.ac17', true) || ' ' ||
  format('pos=%s posi=%s',
    (select count(*) from public.pos_imports where id = 'b194a040-0000-0000-0000-000000000003'),
    (select count(*) from public.pos_import_items where id = 'b194a050-0000-0000-0000-000000000003')),
  'ok:1 pos=0 posi=0',
  'AC17: admin deleting the 1-hour import cascades its line'
);

-- AC-18
select is(
  current_setting('test.ac18', true) || ' ' ||
  (select recipe_id::text || '/' || recipe_mapped from public.pos_import_items where id = 'b194a050-0000-0000-0000-000000000001'),
  'ok:1 b194a004-0000-0000-0000-000000000001/true',
  'AC18: admin sets recipe_id and recipe_mapped on the 200-day POS line'
);

-- AC-19
select is(
  format('pos=%s posi=%s',
    (select count(*) from public.pos_imports where id = 'b194a040-0000-0000-0000-000000000008' and imported_by is null),
    (select count(*) from public.pos_import_items where id = 'b194a050-0000-0000-0000-000000000008')),
  'pos=1 posi=1',
  'AC19-3: the Breadbot-shaped import and line read back'
);

-- AC-20
select is(
  (select string_agg(status, ',' order by id) from public.purchase_orders where id in (
     'b194a010-0000-0000-0000-000000000002', 'b194a010-0000-0000-0000-000000000003',
     'b194a010-0000-0000-0000-000000000004', 'b194a010-0000-0000-0000-000000000005')),
  'sent,partial,received,cancelled',
  'AC20-readback: each non-draft PO keeps its status'
);

-- AC-21
select is(current_setting('test.ac21', true) || '/' ||
          (select status from public.purchase_orders where id = 'b194a010-0000-0000-0000-000000000001'),
  'ok:1/draft', 'AC21: staff draft -> draft is a pass-through');

-- AC-24
select is(current_setting('test.ac24', true), 'ok:1|ok:1',
  'AC24: pass-through SET of po_id and import_id succeeds');

-- AC-25 (postgres arm read-back)
select is(
  format('poi=%s posi=%s',
    (select count(*) from public.po_items where id = 'b194a020-0000-0000-0000-00000000000f'),
    (select count(*) from public.pos_import_items where id = 'b194a050-0000-0000-0000-000000000007')),
  'poi=0 posi=0',
  'PGBYPASS-readback: the lines postgres deleted are gone'
);

select * from finish();
rollback;
