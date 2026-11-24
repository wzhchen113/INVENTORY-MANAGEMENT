-- supabase/tests/rls_visibility_once_per_query.test.sql
--
-- Spec 205 (AC-2, AC-3, AC-5, AC-6, AC-7): the 36 SELECT / ALL-USING
-- policies that called auth_can_see_store(...) / auth_can_see_brand(...) per
-- row were rewritten (migration 20261123120000_rls_visibility_once_per_query)
-- to the InitPlan form:
--   store: ((select public.auth_is_super_admin())
--           or <e> = any ((select public.auth_visible_store_ids())::uuid[]))
--   brand: ((select public.auth_is_super_admin())
--           or <e> = (select public.auth_profile_brand_id()))
-- This suite proves the rewrite admits exactly the same rows as before, for
-- every principal shape, and pins the posture around it.
--
-- CHANGE BOTH TOGETHER: auth_visible_store_ids() / auth_profile_brand_id()
-- duplicate arms of auth_can_see_store() / auth_can_see_brand(). Any edit to
-- either side must be mirrored and this file re-run. AC-5b below fails if
-- only one side changes.
--
-- Arms (plan 56):
--   AC-5   helper posture (prosecdef, provolatile, proconfig, prorettype --
--          the store fragment's ::uuid[] cast relies on the uuid[] pin),
--          EXECUTE for authenticated + anon, none for PUBLIC, and the per-
--          principal helper values (spec D-2.3 V and B columns).
--   AC-5b  predicate truth table per principal: auth_can_see_store(x) =
--          coalesce(<new store fragment>, false) for x in {fixture stores,
--          seed stores, NULL, a random uuid}; the same for brands.
--   AC-7   the audit_log (store_id, created_at desc) index.
--   AC-6   a manifest of EVERY policy on the 35 R4 tables (name, cmd,
--          permissive, roles, md5(qual), md5(with_check)); set equality both
--          ways. The two ALL policies' with_check md5 equals their pre-205
--          qual md5 (R6: write side unchanged).
--   AC-3   as anon, every R4 table reads 0 rows with no error.
--   AC-2   every principal sees the same primary keys in all 35 tables under
--          the OLD USING text (re-applied with ALTER POLICY inside this
--          transaction, the old functions still exist) and the NEW text; the
--          rows reachable through the two ALL policies by UPDATE ... RETURNING
--          and DELETE ... RETURNING are the same too; the catalog is restored
--          to the new text; non-vacuity guards.
--
-- Principals (spec D-2.3; ids 20500000-0000-0000-0000-0000000000NN):
--   SA, ADM-A, MST-A, ADM-B, ADM-A+L (A1 plus a planted cross-brand B1 link),
--   STALE, STALE+L, ROLE-ONLY, STAFF, LOOSE, NOBRAND, ANON.
-- Fixtures: brand A (stores A1, A2), brand B (store B1), a soft-deleted
-- brand C, rows at A1/A2/B1 (store-scoped) or A/B (brand-scoped) in each of
-- the 35 tables, a NULL-scope row wherever the scope column is nullable
-- (tag NULL), and NULL-foreign-key child rows where the FK is nullable (tag
-- NULLFK). User triggers on the fixture tables are disabled while fixtures
-- are inserted (transactional DDL as the table owner, rolled back with the
-- file; foreign keys stay enforced) so the fixtures can include shapes the
-- write-side triggers refuse, which is the point: this suite tests RLS.
--
-- LIFECYCLE (which arms outlive this spec):
--   * Permanent standing checks: AC-3 (anon), AC-5 (helper posture and
--     values), AC-6 (policy manifest; regenerate per the recipe below) and
--     AC-7 (index). Keep them green.
--   * Migration-time proofs: AC-2 (old vs new USING, from the spec205_r4.old_using
--     literals) and AC-5b (auth_can_see_* vs the InitPlan predicates). They
--     prove the spec 205 rewrite itself. When a later spec INTENTIONALLY
--     changes one of the 36 policies or auth_can_see_store/auth_can_see_brand,
--     that spec either deletes these arms (adjusting plan()) or re-baselines
--     old_using / the AC-5b reference to its own pre-change text, in the same
--     PR. Do not "fix" them by copying the new text into old_using.
--
-- REGENERATING THE AC-6 MANIFEST (a later spec that intentionally changes a
-- policy on one of the 35 tables must do this in the same PR):
--   select format('(%L, %L, %L, %L, %L, %L, %L),', tablename, policyname, cmd,
--                 permissive, roles::text, md5(coalesce(qual, '')),
--                 md5(coalesce(with_check, '')))
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in (<the 35 tables in spec205_tables below>)
--    order by tablename, policyname;
-- Diff it against the old manifest and justify every changed row.
--
-- The OLD USING texts in spec205_r4.old_using below are the pre-205 pg_policies.qual
-- deparse, captured on a fresh `supabase db reset` (spec D-1 manifest). They
-- are valid SQL under the default search_path.

begin;
create extension if not exists pgtap;

select plan(56);

-- ════════════════════════════════════════════════════════════════
-- Constants
-- ════════════════════════════════════════════════════════════════
select set_config('test.brand_a', 'b2050000-0000-0000-0000-00000000000a', true);
select set_config('test.brand_b', 'b2050000-0000-0000-0000-00000000000b', true);
select set_config('test.brand_c', 'b2050000-0000-0000-0000-00000000000c', true);
select set_config('test.store_a1', 'c2050000-0000-0000-0000-0000000000a1', true);
select set_config('test.store_a2', 'c2050000-0000-0000-0000-0000000000a2', true);
select set_config('test.store_b1', 'c2050000-0000-0000-0000-0000000000b1', true);

-- Deterministic fixture id per (table, scope).
create function pg_temp.fid(p_tbl text, p_scope text) returns uuid
language sql immutable as $$ select md5('spec205:' || p_tbl || ':' || p_scope)::uuid $$;

create temp table spec205_tables(tbl text primary key, pkexpr text);
insert into spec205_tables(tbl)
select unnest(array[
  'audit_log','brands','catalog_ingredients','eod_entries','eod_submissions',
  'ingredient_conversions','inventory_count_entries','inventory_counts',
  'inventory_items','invitations','item_vendors','notifications',
  'order_approvals','order_schedule','po_items','pos_import_items',
  'pos_imports','pos_recipe_aliases','prep_recipe_ingredients','prep_recipes',
  'profiles','purchase_orders','recipe_ingredients','recipe_prep_items',
  'recipes','report_definitions','report_runs','staff_reports',
  'store_count_layouts','stores','user_stores','vendor_order_attempts',
  'vendors','waste_log','weekly_reminder_log']);

-- Primary-key expression per table (columns joined with ':'), from pg_index.
update spec205_tables t
   set pkexpr = coalesce(
     (select string_agg(format('x.%I::text', a.attname), $$ || ':' || $$ order by k.ord)
        from pg_index i
        cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
       where i.indrelid = ('public.' || t.tbl)::regclass and i.indisprimary),
     'x.ctid::text');

-- ════════════════════════════════════════════════════════════════
-- Principals
-- ════════════════════════════════════════════════════════════════
create temp table spec205_p (
  ord      int primary key,
  code     text unique not null,
  id       uuid,
  prof_role text,
  prof_brand uuid,
  jwt_role text,
  db_role  text not null,
  exp_v    uuid[] not null,
  exp_b    uuid
);

insert into spec205_p values
  ( 1, 'SA',        '20500000-0000-0000-0000-000000000001', 'super_admin', null,
       'super_admin', 'authenticated', '{}', null),
  ( 2, 'ADM-A',     '20500000-0000-0000-0000-000000000002', 'admin', current_setting('test.brand_a')::uuid,
       'admin', 'authenticated',
       array[current_setting('test.store_a1')::uuid, current_setting('test.store_a2')::uuid],
       current_setting('test.brand_a')::uuid),
  ( 3, 'MST-A',     '20500000-0000-0000-0000-000000000003', 'master', current_setting('test.brand_a')::uuid,
       'master', 'authenticated',
       array[current_setting('test.store_a1')::uuid, current_setting('test.store_a2')::uuid],
       current_setting('test.brand_a')::uuid),
  ( 4, 'ADM-B',     '20500000-0000-0000-0000-000000000004', 'admin', current_setting('test.brand_b')::uuid,
       'admin', 'authenticated',
       array[current_setting('test.store_b1')::uuid],
       current_setting('test.brand_b')::uuid),
  ( 5, 'ADM-A+L',   '20500000-0000-0000-0000-000000000005', 'admin', current_setting('test.brand_a')::uuid,
       'admin', 'authenticated',
       array[current_setting('test.store_a1')::uuid, current_setting('test.store_a2')::uuid,
             current_setting('test.store_b1')::uuid],
       current_setting('test.brand_a')::uuid),
  ( 6, 'STALE',     '20500000-0000-0000-0000-000000000006', 'user', null,
       'admin', 'authenticated', '{}', null),
  ( 7, 'STALE+L',   '20500000-0000-0000-0000-000000000007', 'user', null,
       'admin', 'authenticated', array[current_setting('test.store_a1')::uuid], null),
  ( 8, 'ROLE-ONLY', '20500000-0000-0000-0000-000000000008', 'admin', current_setting('test.brand_a')::uuid,
       'user', 'authenticated', '{}', current_setting('test.brand_a')::uuid),
  ( 9, 'STAFF',     '20500000-0000-0000-0000-000000000009', 'user', current_setting('test.brand_a')::uuid,
       'user', 'authenticated', array[current_setting('test.store_a1')::uuid],
       current_setting('test.brand_a')::uuid),
  (10, 'LOOSE',     '20500000-0000-0000-0000-000000000010', 'user', current_setting('test.brand_a')::uuid,
       'user', 'authenticated', '{}', current_setting('test.brand_a')::uuid),
  (11, 'NOBRAND',   '20500000-0000-0000-0000-000000000011', 'user', null,
       'user', 'authenticated', '{}', null),
  (12, 'ANON',      null, null, null, null, 'anon', '{}', null);

-- Become / stop being a principal (PostgREST-style impersonation).
create function pg_temp.spec205_become(p_code text) returns void
language plpgsql as $$
declare
  r record;
begin
  select * into r from spec205_p where code = p_code;
  if r.db_role = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', r.id, 'role', 'authenticated',
                        'app_metadata', json_build_object('role', r.jwt_role))::text, true);
  end if;
  execute format('set local role %I', r.db_role);
end $$;

create function pg_temp.spec205_unbecome() returns void
language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ════════════════════════════════════════════════════════════════
-- Fixtures (as postgres)
-- ════════════════════════════════════════════════════════════════
alter table public.profiles                disable trigger user;
alter table public.user_stores             disable trigger user;
alter table public.inventory_items         disable trigger user;
alter table public.eod_submissions         disable trigger user;
alter table public.eod_entries             disable trigger user;
alter table public.waste_log               disable trigger user;
alter table public.purchase_orders         disable trigger user;
alter table public.po_items                disable trigger user;
alter table public.pos_imports             disable trigger user;
alter table public.pos_import_items        disable trigger user;
alter table public.invitations             disable trigger user;
alter table public.catalog_ingredients     disable trigger user;
alter table public.report_runs             disable trigger user;
alter table public.inventory_counts        disable trigger user;
alter table public.inventory_count_entries disable trigger user;
alter table public.order_approvals         disable trigger user;

insert into public.brands (id, name, deleted_at) values
  (current_setting('test.brand_a')::uuid, 'Spec205 Brand A', null),
  (current_setting('test.brand_b')::uuid, 'Spec205 Brand B', null),
  (current_setting('test.brand_c')::uuid, 'Spec205 Brand C (deleted)', now());

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time) values
  (current_setting('test.store_a1')::uuid, current_setting('test.brand_a')::uuid, 'Spec205 A1', '1 A1 St', 'active', '22:00'),
  (current_setting('test.store_a2')::uuid, current_setting('test.brand_a')::uuid, 'Spec205 A2', '2 A2 St', 'active', '22:00'),
  (current_setting('test.store_b1')::uuid, current_setting('test.brand_b')::uuid, 'Spec205 B1', '1 B1 St', 'active', '22:00');

-- Store scopes (NULL = a row whose store_id is NULL) and brand scopes.
create temp table spec205_ss(scope text primary key, store_id uuid, brand_id uuid);
insert into spec205_ss values
  ('A1',   current_setting('test.store_a1')::uuid, current_setting('test.brand_a')::uuid),
  ('A2',   current_setting('test.store_a2')::uuid, current_setting('test.brand_a')::uuid),
  ('B1',   current_setting('test.store_b1')::uuid, current_setting('test.brand_b')::uuid),
  ('NULL', null,                                   current_setting('test.brand_a')::uuid);
-- brand_id on the NULL row only picks the parents (vendor, catalog) it uses.

create temp table spec205_bs(scope text primary key, brand_id uuid);
insert into spec205_bs values
  ('A', current_setting('test.brand_a')::uuid),
  ('B', current_setting('test.brand_b')::uuid);

-- auth.users (every token column '', see project memory) and profiles.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select p.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       lower(replace(p.code, '+', '-')) || '-205@local.test', '',
       now(), now(), now(),
       jsonb_build_object('provider','email','providers',array['email'],'role',p.jwt_role),
       '{}'::jsonb, false, false, '', '', '', '', '', '', '', ''
  from spec205_p p where p.id is not null;

insert into public.profiles (id, name, role, initials, color, status, brand_id)
select p.id, 'Spec205 ' || p.code, p.prof_role, 'SP', '#888888', 'active', p.prof_brand
  from spec205_p p where p.id is not null;

-- Links: STAFF -> A1, STALE+L -> A1, ADM-A+L -> A1 and the planted
-- cross-brand ADM-A+L -> B1 (user_stores_brand_match_trg is disabled above).
insert into public.user_stores (user_id, store_id) values
  ('20500000-0000-0000-0000-000000000009', current_setting('test.store_a1')::uuid),
  ('20500000-0000-0000-0000-000000000007', current_setting('test.store_a1')::uuid),
  ('20500000-0000-0000-0000-000000000005', current_setting('test.store_a1')::uuid),
  ('20500000-0000-0000-0000-000000000005', current_setting('test.store_b1')::uuid);

-- Brand-scoped parents.
insert into public.vendors (id, brand_id, name)
select pg_temp.fid('vendors', scope), brand_id, 'Spec205 Vendor ' || scope from spec205_bs;
insert into public.catalog_ingredients (id, brand_id, name, unit)
select pg_temp.fid('catalog_ingredients', scope), brand_id, 'Spec205 Catalog ' || scope, 'ea' from spec205_bs;
insert into public.recipes (id, brand_id, menu_item)
select pg_temp.fid('recipes', scope), brand_id, 'Spec205 Recipe ' || scope from spec205_bs;
insert into public.prep_recipes (id, brand_id, name)
select pg_temp.fid('prep_recipes', scope), brand_id, 'Spec205 Prep ' || scope from spec205_bs;

-- Brand-scoped children (+ NULLFK rows where the FK is nullable).
insert into public.ingredient_conversions (id, catalog_id, purchase_unit)
select pg_temp.fid('ingredient_conversions', scope), pg_temp.fid('catalog_ingredients', scope), 'spec205case' from spec205_bs;
insert into public.pos_recipe_aliases (id, recipe_id, pos_name, store_id)
select pg_temp.fid('pos_recipe_aliases', scope), pg_temp.fid('recipes', scope), 'spec205 alias ' || scope, null from spec205_bs;
insert into public.prep_recipe_ingredients (id, prep_recipe_id, catalog_id)
select pg_temp.fid('prep_recipe_ingredients', scope), pg_temp.fid('prep_recipes', scope), pg_temp.fid('catalog_ingredients', scope) from spec205_bs
union all
select pg_temp.fid('prep_recipe_ingredients', 'NULLFK'), null, pg_temp.fid('catalog_ingredients', 'A');
insert into public.recipe_ingredients (id, recipe_id, catalog_id)
select pg_temp.fid('recipe_ingredients', scope), pg_temp.fid('recipes', scope), pg_temp.fid('catalog_ingredients', scope) from spec205_bs
union all
select pg_temp.fid('recipe_ingredients', 'NULLFK'), null, pg_temp.fid('catalog_ingredients', 'A');
insert into public.recipe_prep_items (id, recipe_id, prep_recipe_id)
select pg_temp.fid('recipe_prep_items', scope), pg_temp.fid('recipes', scope), pg_temp.fid('prep_recipes', scope) from spec205_bs
union all
select pg_temp.fid('recipe_prep_items', 'NULLFK'), null, pg_temp.fid('prep_recipes', 'A');

-- Brand-scoped rows that also carry a store (notifications, staff_reports).
insert into public.notifications (id, brand_id, store_id, type, source_id)
values
  (pg_temp.fid('notifications', 'A'), current_setting('test.brand_a')::uuid, current_setting('test.store_a1')::uuid, 'eod', pg_temp.fid('notifications-src', 'A')),
  (pg_temp.fid('notifications', 'B'), current_setting('test.brand_b')::uuid, current_setting('test.store_b1')::uuid, 'eod', pg_temp.fid('notifications-src', 'B'));
insert into public.staff_reports (id, brand_id, store_id, category, message)
values
  (pg_temp.fid('staff_reports', 'A'), current_setting('test.brand_a')::uuid, current_setting('test.store_a1')::uuid, 'other', 'spec205 A'),
  (pg_temp.fid('staff_reports', 'B'), current_setting('test.brand_b')::uuid, current_setting('test.store_b1')::uuid, 'other', 'spec205 B');

-- Store-scoped rows. Nullable store_id gets the NULL scope row too.
insert into public.inventory_items (id, store_id, catalog_id, vendor_id)
select pg_temp.fid('inventory_items', s.scope), s.store_id,
       pg_temp.fid('catalog_ingredients', case when s.brand_id = current_setting('test.brand_b')::uuid then 'B' else 'A' end),
       pg_temp.fid('vendors',             case when s.brand_id = current_setting('test.brand_b')::uuid then 'B' else 'A' end)
  from spec205_ss s;
insert into public.item_vendors (id, item_id, vendor_id)
select pg_temp.fid('item_vendors', s.scope), pg_temp.fid('inventory_items', s.scope),
       pg_temp.fid('vendors', case when s.brand_id = current_setting('test.brand_b')::uuid then 'B' else 'A' end)
  from spec205_ss s;
insert into public.eod_submissions (id, store_id, date, vendor_id, status)
select pg_temp.fid('eod_submissions', s.scope), s.store_id, date '2026-11-20',
       pg_temp.fid('vendors', case when s.brand_id = current_setting('test.brand_b')::uuid then 'B' else 'A' end), 'submitted'
  from spec205_ss s;
insert into public.eod_entries (id, submission_id, item_id, actual_remaining)
select pg_temp.fid('eod_entries', s.scope), pg_temp.fid('eod_submissions', s.scope), pg_temp.fid('inventory_items', s.scope), 1
  from spec205_ss s
union all
select pg_temp.fid('eod_entries', 'NULLFK'), null, pg_temp.fid('inventory_items', 'A1'), 1;
insert into public.inventory_counts (id, store_id, kind, status)
select pg_temp.fid('inventory_counts', s.scope), s.store_id, 'spot', 'submitted'
  from spec205_ss s where s.store_id is not null;
insert into public.inventory_count_entries (id, count_id, item_id, actual_remaining)
select pg_temp.fid('inventory_count_entries', s.scope), pg_temp.fid('inventory_counts', s.scope), pg_temp.fid('inventory_items', s.scope), 1
  from spec205_ss s where s.store_id is not null;
insert into public.purchase_orders (id, store_id, vendor_id, po_number, status)
select pg_temp.fid('purchase_orders', s.scope), s.store_id,
       pg_temp.fid('vendors', case when s.brand_id = current_setting('test.brand_b')::uuid then 'B' else 'A' end),
       'SPEC205-' || s.scope, 'draft'
  from spec205_ss s;
insert into public.po_items (id, po_id, item_id, ordered_qty)
select pg_temp.fid('po_items', s.scope), pg_temp.fid('purchase_orders', s.scope), pg_temp.fid('inventory_items', s.scope), 1
  from spec205_ss s
union all
select pg_temp.fid('po_items', 'NULLFK'), null, pg_temp.fid('inventory_items', 'A1'), 1;
insert into public.pos_imports (id, store_id, filename)
select pg_temp.fid('pos_imports', s.scope), s.store_id, 'spec205.csv' from spec205_ss s;
insert into public.pos_import_items (id, import_id, menu_item, qty_sold)
select pg_temp.fid('pos_import_items', s.scope), pg_temp.fid('pos_imports', s.scope), 'spec205', 1 from spec205_ss s
union all
select pg_temp.fid('pos_import_items', 'NULLFK'), null, 'spec205', 1;
insert into public.order_approvals (id, store_id, vendor_id, business_date, channel, lines)
select pg_temp.fid('order_approvals', s.scope), s.store_id,
       pg_temp.fid('vendors', case when s.brand_id = current_setting('test.brand_b')::uuid then 'B' else 'A' end),
       date '2026-11-20', 'manual', '[]'::jsonb
  from spec205_ss s where s.store_id is not null;
insert into public.order_schedule (id, store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select pg_temp.fid('order_schedule', s.scope), s.store_id, 'Mon',
       pg_temp.fid('vendors', case when s.brand_id = current_setting('test.brand_b')::uuid then 'B' else 'A' end),
       'Spec205 Vendor', 'Tue'
  from spec205_ss s where s.store_id is not null;
insert into public.report_definitions (id, store_id, template_id, name)
select pg_temp.fid('report_definitions', s.scope), s.store_id, 'spec205', 'Spec205 ' || s.scope from spec205_ss s;
insert into public.report_runs (id, definition_id, template_id, store_id)
select pg_temp.fid('report_runs', s.scope), pg_temp.fid('report_definitions', s.scope), 'spec205', s.store_id
  from spec205_ss s where s.store_id is not null;
insert into public.store_count_layouts (id, store_id, name, position)
select pg_temp.fid('store_count_layouts', s.scope), s.store_id, 'Spec205', 1
  from spec205_ss s where s.store_id is not null;
insert into public.vendor_order_attempts (id, po_id, store_id, outcome, stage)
select pg_temp.fid('vendor_order_attempts', s.scope), pg_temp.fid('purchase_orders', s.scope), s.store_id, 'failed', 'error'
  from spec205_ss s where s.store_id is not null;
insert into public.waste_log (id, store_id, item_id, quantity)
select pg_temp.fid('waste_log', s.scope), s.store_id, pg_temp.fid('inventory_items', s.scope), 1 from spec205_ss s;
insert into public.weekly_reminder_log (id, user_id, store_id, week_start)
select pg_temp.fid('weekly_reminder_log', s.scope), '20500000-0000-0000-0000-000000000002', s.store_id, date '2026-11-16'
  from spec205_ss s where s.store_id is not null;
insert into public.audit_log (id, store_id, action, detail)
select pg_temp.fid('audit_log', s.scope), s.store_id, 'Spec205 probe', s.scope from spec205_ss s;

-- invitations: brand A, brand B, the D-7 shape (no brand, no stores, invited
-- by ADM-A), and store-list rows naming A1 and B1.
insert into public.invitations (id, email, name, role, store_ids, profile_id, brand_id, invited_by)
values
  (pg_temp.fid('invitations', 'A'),    'inv-a-205@local.test',  'Inv A',  'user',  '{}', pg_temp.fid('inv-profile', 'A'),    current_setting('test.brand_a')::uuid, '20500000-0000-0000-0000-000000000002'),
  (pg_temp.fid('invitations', 'B'),    'inv-b-205@local.test',  'Inv B',  'user',  '{}', pg_temp.fid('inv-profile', 'B'),    current_setting('test.brand_b')::uuid, '20500000-0000-0000-0000-000000000004'),
  (pg_temp.fid('invitations', 'NULL'), 'inv-n-205@local.test',  'Inv N',  'admin', '{}', pg_temp.fid('inv-profile', 'NULL'), null, '20500000-0000-0000-0000-000000000002'),
  (pg_temp.fid('invitations', 'A1'),   'inv-a1-205@local.test', 'Inv A1', 'user',  array[current_setting('test.store_a1')], pg_temp.fid('inv-profile', 'A1'), null, '20500000-0000-0000-0000-000000000004'),
  (pg_temp.fid('invitations', 'B1'),   'inv-b1-205@local.test', 'Inv B1', 'user',  array[current_setting('test.store_b1')], pg_temp.fid('inv-profile', 'B1'), null, '20500000-0000-0000-0000-000000000002');

alter table public.profiles                enable trigger user;
alter table public.inventory_items         enable trigger user;
alter table public.eod_submissions         enable trigger user;
alter table public.eod_entries             enable trigger user;
alter table public.waste_log               enable trigger user;
alter table public.purchase_orders         enable trigger user;
alter table public.po_items                enable trigger user;
alter table public.pos_imports             enable trigger user;
alter table public.pos_import_items        enable trigger user;
alter table public.invitations             enable trigger user;
alter table public.catalog_ingredients     enable trigger user;
alter table public.report_runs             enable trigger user;
alter table public.inventory_counts        enable trigger user;
alter table public.inventory_count_entries enable trigger user;
alter table public.order_approvals         enable trigger user;
-- user_stores triggers stay disabled until after the ALL-policy probes.

-- Fixture tags: (table, pk text, scope).
create temp table spec205_fx(tbl text, k text, scope text);
do $$
declare
  t text;
  s text;
  n int;
begin
  foreach t in array array(select tbl from spec205_tables where tbl not in ('brands','stores','profiles','user_stores')) loop
    foreach s in array array['A1','A2','B1','NULL','A','B','NULLFK'] loop
      execute format('select count(*) from public.%I where id = $1', t) into n using pg_temp.fid(t, s);
      if n = 1 then
        insert into spec205_fx values (t, pg_temp.fid(t, s)::text, s);
      end if;
    end loop;
  end loop;
end $$;
insert into spec205_fx values
  ('brands', current_setting('test.brand_a'), 'A'),
  ('brands', current_setting('test.brand_b'), 'B'),
  ('brands', current_setting('test.brand_c'), 'C'),
  ('stores', current_setting('test.store_a1'), 'A1'),
  ('stores', current_setting('test.store_a2'), 'A2'),
  ('stores', current_setting('test.store_b1'), 'B1');
insert into spec205_fx
select 'profiles', p.id::text,
       case when p.prof_brand = current_setting('test.brand_a')::uuid then 'A'
            when p.prof_brand = current_setting('test.brand_b')::uuid then 'B'
            else 'NULL' end
  from spec205_p p where p.id is not null;
insert into spec205_fx
select 'user_stores', us.user_id::text || ':' || us.store_id::text,
       case us.store_id when current_setting('test.store_a1')::uuid then 'A1' else 'B1' end
  from public.user_stores us where us.user_id::text like '20500000-%';

-- ════════════════════════════════════════════════════════════════
-- AC-5: helper posture
-- ════════════════════════════════════════════════════════════════
select ok(
  (select prosecdef and provolatile = 's' and proconfig = '{"search_path=public, auth"}'
          and prorettype = 'uuid[]'::regtype and pronargs = 0
     from pg_proc where oid = 'public.auth_visible_store_ids()'::regprocedure),
  'AC-5: auth_visible_store_ids() is SECURITY DEFINER, STABLE, search_path=public, auth, no args, returns uuid[] (the store fragment''s ::uuid[] cast relies on this return type)'
);

select ok(
  (select prosecdef and provolatile = 's' and proconfig = '{"search_path=public, auth"}'
          and prorettype = 'uuid'::regtype and pronargs = 0
     from pg_proc where oid = 'public.auth_profile_brand_id()'::regprocedure),
  'AC-5: auth_profile_brand_id() is SECURITY DEFINER, STABLE, search_path=public, auth, no args, returns uuid'
);

select ok(
  has_function_privilege('authenticated', 'public.auth_visible_store_ids()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.auth_profile_brand_id()', 'EXECUTE'),
  'AC-5/OQ-1: authenticated can EXECUTE both helpers'
);

select ok(
  has_function_privilege('anon', 'public.auth_visible_store_ids()', 'EXECUTE')
  and has_function_privilege('anon', 'public.auth_profile_brand_id()', 'EXECUTE'),
  'AC-3/OQ-1: anon can EXECUTE both helpers (most rewritten policies apply to PUBLIC; without this an anon read fails with 42501)'
);

select is(
  (select count(*)::int
     from pg_proc p, aclexplode(p.proacl) a
    where p.oid in ('public.auth_visible_store_ids()'::regprocedure,
                    'public.auth_profile_brand_id()'::regprocedure)
      and a.grantee = 0),
  0,
  'AC-5/OQ-1: PUBLIC holds no privilege on either helper'
);

-- Per-principal helper values.
create temp table spec205_hv(code text, v uuid[], b uuid, store_mismatch text, brand_mismatch text);
do $$
declare
  r record;
  v_v uuid[];
  v_b uuid;
  v_sm text;
  v_bm text;
  v_stores uuid[];
  v_brands uuid[];
begin
  -- Candidates (read as postgres): fixture + seed stores/brands and a random id;
  -- NULL is tested separately because array_agg/unnest would keep it but the
  -- format() of a NULL needs care.
  select array_agg(id order by id) || array[gen_random_uuid()] into v_stores from public.stores;
  select array_agg(id order by id) || array[gen_random_uuid()] into v_brands from public.brands;

  for r in select * from spec205_p order by ord loop
    perform pg_temp.spec205_become(r.code);

    v_v := public.auth_visible_store_ids();
    v_b := public.auth_profile_brand_id();

    -- AC-5b: old function vs the new store fragment, test-side coalesce.
    select string_agg(coalesce(x::text, 'NULL'), ',')
      into v_sm
      from unnest(v_stores || array[null::uuid]) as x
     where public.auth_can_see_store(x)
           is distinct from coalesce((select public.auth_is_super_admin())
                                     or x = any ((select public.auth_visible_store_ids())::uuid[]), false);

    select string_agg(coalesce(x::text, 'NULL'), ',')
      into v_bm
      from unnest(v_brands || array[null::uuid]) as x
     where public.auth_can_see_brand(x)
           is distinct from coalesce((select public.auth_is_super_admin())
                                     or x = (select public.auth_profile_brand_id()), false);

    perform pg_temp.spec205_unbecome();
    insert into spec205_hv values (r.code, v_v, v_b, coalesce(v_sm, ''), coalesce(v_bm, ''));
  end loop;
end $$;

select is(
  (select coalesce(string_agg(format('%s: got %s want %s', p.code,
                     (select coalesce(array_agg(x order by x), '{}') from unnest(h.v) x),
                     (select coalesce(array_agg(x order by x), '{}') from unnest(p.exp_v) x)), '; ' order by p.ord), '')
     from spec205_p p join spec205_hv h using (code)
    where h.v is null
       or (select coalesce(array_agg(x order by x), '{}') from unnest(h.v) x)
          is distinct from (select coalesce(array_agg(x order by x), '{}') from unnest(p.exp_v) x)),
  '',
  'AC-5: auth_visible_store_ids() equals the spec D-2.3 V column for every principal (never NULL: ''{}'' for SA, STALE, ROLE-ONLY, LOOSE, NOBRAND, ANON)'
);

select is(
  (select coalesce(string_agg(format('%s: got %s want %s', p.code, h.b, p.exp_b), '; ' order by p.ord), '')
     from spec205_p p join spec205_hv h using (code)
    where h.b is distinct from p.exp_b),
  '',
  'AC-5: auth_profile_brand_id() equals the spec D-2.3 B column for every principal (NULL for SA, STALE, STALE+L, NOBRAND, ANON)'
);

-- AC-5b: one assertion per principal.
select is(
  (select 'store[' || store_mismatch || '] brand[' || brand_mismatch || ']' from spec205_hv where code = p.code),
  'store[] brand[]',
  'AC-5b: ' || p.code || ' — auth_can_see_store(x) / auth_can_see_brand(b) equal the spec 205 InitPlan predicates for every fixture, seed, NULL and random id'
)
  from spec205_p p order by p.ord;

-- ════════════════════════════════════════════════════════════════
-- AC-7: index
-- ════════════════════════════════════════════════════════════════
select is(
  (select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'audit_log_store_id_created_at_idx'),
  'CREATE INDEX audit_log_store_id_created_at_idx ON public.audit_log USING btree (store_id, created_at DESC)',
  'AC-7: audit_log (store_id, created_at desc) index exists'
);

-- ════════════════════════════════════════════════════════════════
-- AC-6: policy posture manifest (every policy on the 35 tables, post-205)
-- ════════════════════════════════════════════════════════════════
create temp table spec205_manifest(tablename text, policyname text, cmd text, permissive text,
                                   roles text, md5_qual text, md5_check text);
insert into spec205_manifest values
  ('audit_log', 'admin_delete_audit_log', 'DELETE', 'PERMISSIVE', '{public}', 'd17493302b2dcc66b854f16de5d682aa', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('audit_log', 'audit_log_restrict_insert_actor_is_caller', 'INSERT', 'RESTRICTIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'e84f2f759d19e21f4779be9d6f5f75e2'),
  ('audit_log', 'audit_log_restrict_insert_created_at_now', 'INSERT', 'RESTRICTIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '5a5f746af10dfb90ae0726a54811a72d'),
  ('audit_log', 'audit_log_restrict_insert_server_only_actions', 'INSERT', 'RESTRICTIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'd5e596a9f6504f9490510e2ae193409c'),
  ('audit_log', 'audit_log_restrict_select_store_user_actions', 'SELECT', 'RESTRICTIVE', '{public}', '79217da0cf4133585ddd425a8efc1d95', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('audit_log', 'store_member_insert_audit_log', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'e95014e326eb2bc592402b3c33d614f7'),
  ('audit_log', 'store_member_read_audit_log', 'SELECT', 'PERMISSIVE', '{public}', '686dfa73f65c562d83f26b62d36d117e', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('brands', 'brand_member_read_brands', 'SELECT', 'PERMISSIVE', '{public}', 'eb713b9b798dc7810ad469117e9a33e2', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('brands', 'super_admin_manage_brands', 'ALL', 'PERMISSIVE', '{public}', '0e3ff8d2fba935996a95d09de8c402f0', '0e3ff8d2fba935996a95d09de8c402f0'),
  ('catalog_ingredients', 'brand_member_read_catalog_ingredients', 'SELECT', 'PERMISSIVE', '{public}', '39be0d26d6c7496086d1d26a14b4c81c', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('catalog_ingredients', 'privileged_delete_catalog_ingredients', 'DELETE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('catalog_ingredients', 'privileged_insert_catalog_ingredients', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '16d876800d95eee62382b132c539855f'),
  ('catalog_ingredients', 'privileged_update_catalog_ingredients', 'UPDATE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', '16d876800d95eee62382b132c539855f'),
  ('eod_entries', 'admin_update_eod_entries', 'UPDATE', 'PERMISSIVE', '{public}', 'b99eb12b60c195e800fa91fd5e47df83', 'b99eb12b60c195e800fa91fd5e47df83'),
  ('eod_entries', 'store_member_insert_eod_entries', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'd5b9cc572cc5ce72cd6de570a94df08d'),
  ('eod_entries', 'store_member_read_eod_entries', 'SELECT', 'PERMISSIVE', '{public}', 'bb4f5a9aad54d9ad6530fbe872df2c5b', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('eod_submissions', 'admin_update_eod_submissions', 'UPDATE', 'PERMISSIVE', '{public}', '14541bb187014c50c377dcdc963127c3', '14541bb187014c50c377dcdc963127c3'),
  ('eod_submissions', 'store_member_insert_eod_submissions', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'aff07113403e879e69207277ba9eaee8'),
  ('eod_submissions', 'store_member_read_eod_submissions', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('ingredient_conversions', 'brand_member_read_ingredient_conversions', 'SELECT', 'PERMISSIVE', '{public}', '0a58badb4026d97224e21699c4d47a30', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('ingredient_conversions', 'privileged_delete_ingredient_conversions', 'DELETE', 'PERMISSIVE', '{public}', '04a4603bb861139120b7faf74e80a56c', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('ingredient_conversions', 'privileged_insert_ingredient_conversions', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '04a4603bb861139120b7faf74e80a56c'),
  ('ingredient_conversions', 'privileged_update_ingredient_conversions', 'UPDATE', 'PERMISSIVE', '{public}', '04a4603bb861139120b7faf74e80a56c', '04a4603bb861139120b7faf74e80a56c'),
  ('inventory_count_entries', 'store_member_insert_inventory_count_entries', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '3cf554c81184ebfe7770da4f1647eba2'),
  ('inventory_count_entries', 'store_member_read_inventory_count_entries', 'SELECT', 'PERMISSIVE', '{public}', '969a4cc3a26338692e1e06abf36ddb82', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('inventory_counts', 'store_member_insert_inventory_counts', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'aff07113403e879e69207277ba9eaee8'),
  ('inventory_counts', 'store_member_read_inventory_counts', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('inventory_items', 'store_member_delete_inventory_items', 'DELETE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('inventory_items', 'store_member_insert_inventory_items', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'aff07113403e879e69207277ba9eaee8'),
  ('inventory_items', 'store_member_read_inventory_items', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('inventory_items', 'store_member_update_inventory_items', 'UPDATE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'aff07113403e879e69207277ba9eaee8'),
  ('invitations', 'Admins can delete invitations', 'DELETE', 'PERMISSIVE', '{authenticated}', '864eb7d8c16c4222eecc2078e65c73f4', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('invitations', 'Admins can insert invitations', 'INSERT', 'PERMISSIVE', '{authenticated}', 'd41d8cd98f00b204e9800998ecf8427e', '648ee06326c02a6932f517806e68a15c'),
  ('invitations', 'Admins can read invitations', 'SELECT', 'PERMISSIVE', '{authenticated}', 'a64db3f37fe72e313ba8ea5c5bfecd23', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('invitations', 'Admins can update invitations', 'UPDATE', 'PERMISSIVE', '{authenticated}', 'bfe1da6594ae840101c423961fdcc211', '8dc14413955c8e29198ebbfe50465450'),
  ('item_vendors', 'store_member_delete_item_vendors', 'DELETE', 'PERMISSIVE', '{public}', '5709b8b16dd8bb3416007ec9edaffc51', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('item_vendors', 'store_member_insert_item_vendors', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '5709b8b16dd8bb3416007ec9edaffc51'),
  ('item_vendors', 'store_member_read_item_vendors', 'SELECT', 'PERMISSIVE', '{public}', '0c4c1a7ef6c352806718fc38dae287ed', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('item_vendors', 'store_member_update_item_vendors', 'UPDATE', 'PERMISSIVE', '{public}', '5709b8b16dd8bb3416007ec9edaffc51', '5709b8b16dd8bb3416007ec9edaffc51'),
  ('notifications', 'privileged_brand_read_notifications', 'SELECT', 'PERMISSIVE', '{public}', '21c9413273273b5f0743330b67ea0232', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('order_approvals', 'privileged_store_insert_order_approvals', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'f2192809ce60390bda45ec0a0c2847df'),
  ('order_approvals', 'privileged_store_read_order_approvals', 'SELECT', 'PERMISSIVE', '{public}', 'd467fb571dc7a0467da42e4fcfd31600', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('order_approvals', 'privileged_store_update_order_approvals', 'UPDATE', 'PERMISSIVE', '{public}', '14541bb187014c50c377dcdc963127c3', '14541bb187014c50c377dcdc963127c3'),
  ('order_schedule', 'Admins can write order_schedule', 'ALL', 'PERMISSIVE', '{public}', 'd467fb571dc7a0467da42e4fcfd31600', '14541bb187014c50c377dcdc963127c3'),
  ('order_schedule', 'Store members can read order_schedule', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('po_items', 'po_items_restrict_delete_non_draft', 'DELETE', 'RESTRICTIVE', '{public}', 'b5eca86870a0c9d150a61d63a3355137', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('po_items', 'store_member_delete_po_items', 'DELETE', 'PERMISSIVE', '{public}', '952520d5f0f7e85bd86ddd6bdf7b6957', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('po_items', 'store_member_insert_po_items', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '952520d5f0f7e85bd86ddd6bdf7b6957'),
  ('po_items', 'store_member_read_po_items', 'SELECT', 'PERMISSIVE', '{public}', 'c6859ddd19fe4f9d48f794e2a5b10ccc', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('po_items', 'store_member_update_po_items', 'UPDATE', 'PERMISSIVE', '{public}', '952520d5f0f7e85bd86ddd6bdf7b6957', '952520d5f0f7e85bd86ddd6bdf7b6957'),
  ('pos_import_items', 'pos_import_items_restrict_delete', 'DELETE', 'RESTRICTIVE', '{public}', '68934a3e9455fa72420237eb05902327', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('pos_import_items', 'store_member_delete_pos_import_items', 'DELETE', 'PERMISSIVE', '{public}', '46f325e128045d140dc5bd2ae57ca074', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('pos_import_items', 'store_member_insert_pos_import_items', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '46f325e128045d140dc5bd2ae57ca074'),
  ('pos_import_items', 'store_member_read_pos_import_items', 'SELECT', 'PERMISSIVE', '{public}', '2c4eceafc01c15f44eb361bf4bde353b', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('pos_import_items', 'store_member_update_pos_import_items', 'UPDATE', 'PERMISSIVE', '{public}', '46f325e128045d140dc5bd2ae57ca074', '46f325e128045d140dc5bd2ae57ca074'),
  ('pos_imports', 'pos_imports_restrict_delete_aged', 'DELETE', 'RESTRICTIVE', '{public}', '34d7ccf5df0233fadb54378be52c9500', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('pos_imports', 'store_member_delete_pos_imports', 'DELETE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('pos_imports', 'store_member_insert_pos_imports', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'aff07113403e879e69207277ba9eaee8'),
  ('pos_imports', 'store_member_read_pos_imports', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('pos_imports', 'store_member_update_pos_imports', 'UPDATE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'aff07113403e879e69207277ba9eaee8'),
  ('pos_recipe_aliases', 'brand_member_read_pos_recipe_aliases', 'SELECT', 'PERMISSIVE', '{public}', 'e131dbe5753e9ba9f69cb182580338a7', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('pos_recipe_aliases', 'privileged_delete_pos_recipe_aliases', 'DELETE', 'PERMISSIVE', '{public}', 'e66638c2666a8f07a9f432b68acb6d50', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('pos_recipe_aliases', 'privileged_insert_pos_recipe_aliases', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'e66638c2666a8f07a9f432b68acb6d50'),
  ('pos_recipe_aliases', 'privileged_update_pos_recipe_aliases', 'UPDATE', 'PERMISSIVE', '{public}', 'e66638c2666a8f07a9f432b68acb6d50', 'e66638c2666a8f07a9f432b68acb6d50'),
  ('prep_recipe_ingredients', 'brand_member_read_prep_recipe_ingredients', 'SELECT', 'PERMISSIVE', '{public}', '0be190f51f281f74c6f656ccae66a8f9', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('prep_recipe_ingredients', 'privileged_delete_prep_recipe_ingredients', 'DELETE', 'PERMISSIVE', '{public}', 'f722f7a72462aa1a7eb875ba53017d5e', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('prep_recipe_ingredients', 'privileged_insert_prep_recipe_ingredients', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'f722f7a72462aa1a7eb875ba53017d5e'),
  ('prep_recipe_ingredients', 'privileged_update_prep_recipe_ingredients', 'UPDATE', 'PERMISSIVE', '{public}', 'f722f7a72462aa1a7eb875ba53017d5e', 'f722f7a72462aa1a7eb875ba53017d5e'),
  ('prep_recipes', 'brand_member_read_prep_recipes', 'SELECT', 'PERMISSIVE', '{public}', '39be0d26d6c7496086d1d26a14b4c81c', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('prep_recipes', 'privileged_delete_prep_recipes', 'DELETE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('prep_recipes', 'privileged_insert_prep_recipes', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '16d876800d95eee62382b132c539855f'),
  ('prep_recipes', 'privileged_update_prep_recipes', 'UPDATE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', '16d876800d95eee62382b132c539855f'),
  ('profiles', 'Admins can insert profiles in own brand', 'INSERT', 'PERMISSIVE', '{authenticated}', 'd41d8cd98f00b204e9800998ecf8427e', '3376f90da3aad23d483cdc409994a64e'),
  ('profiles', 'Admins can read all profiles', 'SELECT', 'PERMISSIVE', '{public}', '84f219a0880441f6221960971a2e997d', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('profiles', 'Admins can update any profile', 'UPDATE', 'PERMISSIVE', '{public}', '543f5acc234dded8be35a652bf824ac4', '543f5acc234dded8be35a652bf824ac4'),
  ('profiles', 'Users can read own profile', 'SELECT', 'PERMISSIVE', '{public}', 'ea1f5df45681e1946eaa85c22966d773', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('profiles', 'Users can update own profile', 'UPDATE', 'PERMISSIVE', '{public}', 'ea1f5df45681e1946eaa85c22966d773', 'ea1f5df45681e1946eaa85c22966d773'),
  ('profiles', 'super_admin_manage_profiles', 'UPDATE', 'PERMISSIVE', '{public}', '0e3ff8d2fba935996a95d09de8c402f0', '0e3ff8d2fba935996a95d09de8c402f0'),
  ('profiles', 'super_admin_read_all_profiles', 'SELECT', 'PERMISSIVE', '{public}', '0e3ff8d2fba935996a95d09de8c402f0', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('purchase_orders', 'purchase_orders_restrict_delete_aged', 'DELETE', 'RESTRICTIVE', '{public}', '9054464fa8aef27fd4730ab40077bae8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('purchase_orders', 'store_member_delete_purchase_orders', 'DELETE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('purchase_orders', 'store_member_insert_purchase_orders', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'aff07113403e879e69207277ba9eaee8'),
  ('purchase_orders', 'store_member_read_purchase_orders', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('purchase_orders', 'store_member_update_purchase_orders', 'UPDATE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'aff07113403e879e69207277ba9eaee8'),
  ('recipe_ingredients', 'brand_member_read_recipe_ingredients', 'SELECT', 'PERMISSIVE', '{public}', '76a6325d7c50d9e466da3f9510a56c3c', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('recipe_ingredients', 'privileged_delete_recipe_ingredients', 'DELETE', 'PERMISSIVE', '{public}', 'dfeae8a99220f41266a186d3e5b5dbb5', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('recipe_ingredients', 'privileged_insert_recipe_ingredients', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'dfeae8a99220f41266a186d3e5b5dbb5'),
  ('recipe_ingredients', 'privileged_update_recipe_ingredients', 'UPDATE', 'PERMISSIVE', '{public}', 'dfeae8a99220f41266a186d3e5b5dbb5', 'dfeae8a99220f41266a186d3e5b5dbb5'),
  ('recipe_prep_items', 'brand_member_read_recipe_prep_items', 'SELECT', 'PERMISSIVE', '{public}', 'daee58e99e5581edce4fa2a75560761c', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('recipe_prep_items', 'privileged_delete_recipe_prep_items', 'DELETE', 'PERMISSIVE', '{public}', '20bff7a42afb3e70dcca03b905036d57', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('recipe_prep_items', 'privileged_insert_recipe_prep_items', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '20bff7a42afb3e70dcca03b905036d57'),
  ('recipe_prep_items', 'privileged_update_recipe_prep_items', 'UPDATE', 'PERMISSIVE', '{public}', '20bff7a42afb3e70dcca03b905036d57', '20bff7a42afb3e70dcca03b905036d57'),
  ('recipes', 'brand_member_read_recipes', 'SELECT', 'PERMISSIVE', '{public}', '39be0d26d6c7496086d1d26a14b4c81c', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('recipes', 'privileged_delete_recipes', 'DELETE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('recipes', 'privileged_insert_recipes', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '16d876800d95eee62382b132c539855f'),
  ('recipes', 'privileged_update_recipes', 'UPDATE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', '16d876800d95eee62382b132c539855f'),
  ('report_definitions', 'store_member_delete_report_definitions', 'DELETE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('report_definitions', 'store_member_insert_report_definitions', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'aff07113403e879e69207277ba9eaee8'),
  ('report_definitions', 'store_member_read_report_definitions', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('report_definitions', 'store_member_update_report_definitions', 'UPDATE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'aff07113403e879e69207277ba9eaee8'),
  ('report_runs', 'store_member_delete_report_runs', 'DELETE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('report_runs', 'store_member_insert_report_runs', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'aff07113403e879e69207277ba9eaee8'),
  ('report_runs', 'store_member_read_report_runs', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('report_runs', 'store_member_update_report_runs', 'UPDATE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'aff07113403e879e69207277ba9eaee8'),
  ('staff_reports', 'privileged_brand_read_staff_reports', 'SELECT', 'PERMISSIVE', '{public}', '21c9413273273b5f0743330b67ea0232', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('store_count_layouts', 'privileged_delete_count_layouts', 'DELETE', 'PERMISSIVE', '{public}', '14541bb187014c50c377dcdc963127c3', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('store_count_layouts', 'privileged_insert_count_layouts', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '14541bb187014c50c377dcdc963127c3'),
  ('store_count_layouts', 'privileged_update_count_layouts', 'UPDATE', 'PERMISSIVE', '{public}', '14541bb187014c50c377dcdc963127c3', '14541bb187014c50c377dcdc963127c3'),
  ('store_count_layouts', 'store_member_read_count_layouts', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('stores', 'privileged_delete_stores', 'DELETE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('stores', 'privileged_insert_stores', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '16d876800d95eee62382b132c539855f'),
  ('stores', 'privileged_update_stores', 'UPDATE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', '16d876800d95eee62382b132c539855f'),
  ('stores', 'store_member_read_stores', 'SELECT', 'PERMISSIVE', '{public}', '0c5860f01476ff96d136beaa28804a5d', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('user_stores', 'Admins can manage all store links', 'ALL', 'PERMISSIVE', '{public}', 'be6bd4dc69053b390597704ea30e4690', 'b05a4d4429e322a9cf194d6072b5f6d3'),
  ('user_stores', 'Users can read own store links', 'SELECT', 'PERMISSIVE', '{public}', '3a807491e0a912fbfbee0ffa087b82f6', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('vendor_order_attempts', 'store_member_read_vendor_order_attempts', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('vendors', 'brand_member_read_vendors', 'SELECT', 'PERMISSIVE', '{public}', '39be0d26d6c7496086d1d26a14b4c81c', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('vendors', 'privileged_delete_vendors', 'DELETE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('vendors', 'privileged_insert_vendors', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', '16d876800d95eee62382b132c539855f'),
  ('vendors', 'privileged_update_vendors', 'UPDATE', 'PERMISSIVE', '{public}', '16d876800d95eee62382b132c539855f', '16d876800d95eee62382b132c539855f'),
  ('waste_log', 'store_member_delete_waste_log', 'DELETE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('waste_log', 'store_member_insert_waste_log', 'INSERT', 'PERMISSIVE', '{public}', 'd41d8cd98f00b204e9800998ecf8427e', 'aff07113403e879e69207277ba9eaee8'),
  ('waste_log', 'store_member_read_waste_log', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('waste_log', 'store_member_update_waste_log', 'UPDATE', 'PERMISSIVE', '{public}', 'aff07113403e879e69207277ba9eaee8', 'aff07113403e879e69207277ba9eaee8'),
  ('waste_log', 'waste_log_restrict_delete_aged', 'DELETE', 'RESTRICTIVE', '{public}', 'f7e6565b0ee9569f84dfec3288b0a48e', 'd41d8cd98f00b204e9800998ecf8427e'),
  ('weekly_reminder_log', 'weekly_reminder_log_read', 'SELECT', 'PERMISSIVE', '{public}', 'a6365d67d3d66f00c01118576cbff8a8', 'd41d8cd98f00b204e9800998ecf8427e');

select is(
  (select coalesce(string_agg(format('%s.%s', tablename, policyname), ', ' order by tablename, policyname), '')
     from (select tablename::text, policyname::text, cmd::text, permissive::text, roles::text,
                  md5(coalesce(qual, '')), md5(coalesce(with_check, ''))
             from pg_policies
            where schemaname = 'public' and tablename in (select tbl from spec205_tables)
           except
           select * from spec205_manifest) x),
  '',
  'AC-6: no live policy on the 35 R4 tables differs from the post-205 manifest (name, cmd, permissive, roles, qual md5, with_check md5)'
);

select is(
  (select coalesce(string_agg(format('%s.%s', tablename, policyname), ', ' order by tablename, policyname), '')
     from (select * from spec205_manifest
           except
           select tablename::text, policyname::text, cmd::text, permissive::text, roles::text,
                  md5(coalesce(qual, '')), md5(coalesce(with_check, ''))
             from pg_policies
            where schemaname = 'public' and tablename in (select tbl from spec205_tables)) x),
  '',
  'AC-6: every manifest policy is present unchanged (none dropped or renamed; per-(table, cmd) counts unchanged)'
);

-- R6: the two ALL policies' WITH CHECK still equals their pre-205 USING
-- (pre-205 qual md5s from the D-1 capture).
select is(
  (select string_agg(tablename || ':' || md5(with_check), ',' order by tablename)
     from pg_policies
    where schemaname = 'public'
      and (tablename, policyname) in (('order_schedule', 'Admins can write order_schedule'),
                                      ('user_stores',    'Admins can manage all store links'))),
  'order_schedule:14541bb187014c50c377dcdc963127c3,user_stores:b05a4d4429e322a9cf194d6072b5f6d3',
  'AC-6/R6: both ALL policies keep a WITH CHECK byte-identical to their pre-205 USING (write side unchanged)'
);

-- ════════════════════════════════════════════════════════════════
-- AC-3: anon reads 0 rows, no error
-- ════════════════════════════════════════════════════════════════
select is(
  (select coalesce(string_agg(tbl, ', ' order by tbl), '')
     from spec205_tables where not has_table_privilege('anon', 'public.' || tbl, 'SELECT')),
  '',
  'AC-3: anon holds SELECT on every R4 table (spec 097), so the RLS path (not a table grant) decides what anon sees'
);

create temp table spec205_anon(tbl text, n bigint, err text);
do $$
declare
  t text;
  v_n bigint;
  v_err text;
begin
  foreach t in array array(select tbl from spec205_tables order by tbl) loop
    v_n := null; v_err := null;
    perform pg_temp.spec205_become('ANON');
    begin
      execute format('select count(*) from public.%I', t) into v_n;
    exception when others then
      v_err := sqlstate || ' ' || sqlerrm;
    end;
    perform pg_temp.spec205_unbecome();
    insert into spec205_anon values (t, v_n, v_err);
  end loop;
end $$;

select is(
  (select coalesce(string_agg(tbl || ': ' || err, '; ' order by tbl), '') from spec205_anon where err is not null),
  '',
  'AC-3: as anon, SELECT on every R4 table raises no error (no 42501 on the new helpers)'
);

select is(
  (select coalesce(string_agg(tbl || '=' || n, ', ' order by tbl), '') from spec205_anon where n is distinct from 0 and err is null),
  '',
  'AC-3: as anon, every R4 table returns 0 rows'
);

-- ════════════════════════════════════════════════════════════════
-- AC-2: old USING vs new USING, as the real principals
-- ════════════════════════════════════════════════════════════════
create temp table spec205_r4(tbl text, pol text, old_using text, new_using text,
                             primary key (tbl, pol));
insert into spec205_r4(tbl, pol, old_using) values
  ('audit_log', 'store_member_read_audit_log',
   $old$(((store_id IS NOT NULL) AND auth_can_see_store(store_id)) OR ((store_id IS NULL) AND auth_is_privileged()))$old$),
  ('brands', 'brand_member_read_brands',
   $old$(auth_can_see_brand(id) AND ((deleted_at IS NULL) OR auth_is_super_admin()))$old$),
  ('catalog_ingredients', 'brand_member_read_catalog_ingredients',
   $old$auth_can_see_brand(brand_id)$old$),
  ('eod_entries', 'store_member_read_eod_entries',
   $old$(EXISTS ( SELECT 1
   FROM eod_submissions s
  WHERE ((s.id = eod_entries.submission_id) AND auth_can_see_store(s.store_id))))$old$),
  ('eod_submissions', 'store_member_read_eod_submissions',
   $old$auth_can_see_store(store_id)$old$),
  ('ingredient_conversions', 'brand_member_read_ingredient_conversions',
   $old$(EXISTS ( SELECT 1
   FROM catalog_ingredients ci
  WHERE ((ci.id = ingredient_conversions.catalog_id) AND auth_can_see_brand(ci.brand_id))))$old$),
  ('inventory_count_entries', 'store_member_read_inventory_count_entries',
   $old$(EXISTS ( SELECT 1
   FROM inventory_counts c
  WHERE ((c.id = inventory_count_entries.count_id) AND auth_can_see_store(c.store_id))))$old$),
  ('inventory_counts', 'store_member_read_inventory_counts',
   $old$auth_can_see_store(store_id)$old$),
  ('inventory_items', 'store_member_read_inventory_items',
   $old$auth_can_see_store(store_id)$old$),
  ('invitations', 'Admins can read invitations',
   $old$(auth_profile_is_privileged() AND (role = ANY (ARRAY['user'::text, 'admin'::text])) AND ((brand_id IS NULL) OR auth_can_see_brand(brand_id)) AND (NOT (EXISTS ( SELECT 1
   FROM (unnest(COALESCE(invitations.store_ids, '{}'::text[])) sid(store_id)
     LEFT JOIN stores s ON (((s.id)::text = lower(sid.store_id))))
  WHERE ((s.id IS NULL) OR (NOT auth_can_see_brand(s.brand_id)))))) AND ((brand_id IS NOT NULL) OR (cardinality(COALESCE(store_ids, '{}'::text[])) > 0) OR auth_is_super_admin() OR (invited_by = auth.uid())))$old$),
  ('item_vendors', 'store_member_read_item_vendors',
   $old$(EXISTS ( SELECT 1
   FROM inventory_items ii
  WHERE ((ii.id = item_vendors.item_id) AND auth_can_see_store(ii.store_id))))$old$),
  ('notifications', 'privileged_brand_read_notifications',
   $old$(auth_is_privileged() AND auth_can_see_brand(brand_id))$old$),
  ('order_approvals', 'privileged_store_read_order_approvals',
   $old$(auth_is_privileged() AND auth_can_see_store(store_id))$old$),
  ('order_schedule', 'Admins can write order_schedule',
   $old$(auth_is_privileged() AND auth_can_see_store(store_id))$old$),
  ('order_schedule', 'Store members can read order_schedule',
   $old$auth_can_see_store(store_id)$old$),
  ('po_items', 'store_member_read_po_items',
   $old$(EXISTS ( SELECT 1
   FROM purchase_orders po
  WHERE ((po.id = po_items.po_id) AND auth_can_see_store(po.store_id))))$old$),
  ('pos_import_items', 'store_member_read_pos_import_items',
   $old$(EXISTS ( SELECT 1
   FROM pos_imports pi
  WHERE ((pi.id = pos_import_items.import_id) AND auth_can_see_store(pi.store_id))))$old$),
  ('pos_imports', 'store_member_read_pos_imports',
   $old$auth_can_see_store(store_id)$old$),
  ('pos_recipe_aliases', 'brand_member_read_pos_recipe_aliases',
   $old$(EXISTS ( SELECT 1
   FROM recipes r
  WHERE ((r.id = pos_recipe_aliases.recipe_id) AND auth_can_see_brand(r.brand_id))))$old$),
  ('prep_recipe_ingredients', 'brand_member_read_prep_recipe_ingredients',
   $old$(EXISTS ( SELECT 1
   FROM prep_recipes pr
  WHERE ((pr.id = prep_recipe_ingredients.prep_recipe_id) AND auth_can_see_brand(pr.brand_id))))$old$),
  ('prep_recipes', 'brand_member_read_prep_recipes',
   $old$auth_can_see_brand(brand_id)$old$),
  ('profiles', 'Admins can read all profiles',
   $old$((auth_is_privileged() AND auth_can_see_brand(brand_id)) OR (id = auth.uid()))$old$),
  ('purchase_orders', 'store_member_read_purchase_orders',
   $old$auth_can_see_store(store_id)$old$),
  ('recipe_ingredients', 'brand_member_read_recipe_ingredients',
   $old$(EXISTS ( SELECT 1
   FROM recipes r
  WHERE ((r.id = recipe_ingredients.recipe_id) AND auth_can_see_brand(r.brand_id))))$old$),
  ('recipe_prep_items', 'brand_member_read_recipe_prep_items',
   $old$(EXISTS ( SELECT 1
   FROM recipes r
  WHERE ((r.id = recipe_prep_items.recipe_id) AND auth_can_see_brand(r.brand_id))))$old$),
  ('recipes', 'brand_member_read_recipes',
   $old$auth_can_see_brand(brand_id)$old$),
  ('report_definitions', 'store_member_read_report_definitions',
   $old$auth_can_see_store(store_id)$old$),
  ('report_runs', 'store_member_read_report_runs',
   $old$auth_can_see_store(store_id)$old$),
  ('staff_reports', 'privileged_brand_read_staff_reports',
   $old$(auth_is_privileged() AND auth_can_see_brand(brand_id))$old$),
  ('store_count_layouts', 'store_member_read_count_layouts',
   $old$auth_can_see_store(store_id)$old$),
  ('stores', 'store_member_read_stores',
   $old$auth_can_see_store(id)$old$),
  ('user_stores', 'Admins can manage all store links',
   $old$(auth_is_privileged() AND (EXISTS ( SELECT 1
   FROM stores s
  WHERE ((s.id = user_stores.store_id) AND auth_can_see_brand(s.brand_id)))))$old$),
  ('vendor_order_attempts', 'store_member_read_vendor_order_attempts',
   $old$auth_can_see_store(store_id)$old$),
  ('vendors', 'brand_member_read_vendors',
   $old$auth_can_see_brand(brand_id)$old$),
  ('waste_log', 'store_member_read_waste_log',
   $old$auth_can_see_store(store_id)$old$),
  ('weekly_reminder_log', 'weekly_reminder_log_read',
   $old$auth_can_see_store(store_id)$old$);

update spec205_r4 r set new_using = p.qual
  from pg_policies p
 where p.schemaname = 'public' and p.tablename = r.tbl and p.policyname = r.pol;

create function pg_temp.spec205_mode(p_mode text) returns void
language plpgsql as $$
declare
  r record;
begin
  for r in select * from spec205_r4 order by tbl, pol loop
    execute format('alter policy %I on public.%I using (%s)', r.pol, r.tbl,
                   case p_mode when 'old' then r.old_using else r.new_using end);
  end loop;
end $$;

create temp table spec205_obs(mode text, code text, tbl text, ids text[]);
create function pg_temp.spec205_observe(p_mode text) returns void
language plpgsql as $$
declare
  p record;
  t record;
  v_ids text[];
begin
  for p in select * from spec205_p order by ord loop
    for t in select * from spec205_tables order by tbl loop
      perform pg_temp.spec205_become(p.code);
      execute format('select coalesce(array_agg(k order by k), ''{}'') from (select %s as k from public.%I x) s',
                     t.pkexpr, t.tbl)
        into v_ids;
      perform pg_temp.spec205_unbecome();
      insert into spec205_obs values (p_mode, p.code, t.tbl, v_ids);
    end loop;
  end loop;
end $$;

-- ALL-policy reachability: rows an UPDATE ... RETURNING and a DELETE ...
-- RETURNING reach, rolled back via a caught P0205.
create temp table spec205_allobs(mode text, code text, tbl text, upd text, del text);
create function pg_temp.spec205_all_probe(p_mode text) returns void
language plpgsql as $$
declare
  p record;
  t record;
  v_upd text;
  v_del text;
begin
  for p in select * from spec205_p order by ord loop
    for t in select * from spec205_tables where tbl in ('order_schedule', 'user_stores') order by tbl loop
      v_upd := null; v_del := null;
      begin
        perform pg_temp.spec205_become(p.code);
        execute format('with u as (update public.%I x set %I = %I returning %s as k) '
                       'select coalesce(string_agg(k, '','' order by k), '''') from u',
                       t.tbl, case t.tbl when 'user_stores' then 'user_id' else 'id' end,
                       case t.tbl when 'user_stores' then 'user_id' else 'id' end, t.pkexpr)
          into v_upd;
        execute format('with d as (delete from public.%I x returning %s as k) '
                       'select coalesce(string_agg(k, '','' order by k), '''') from d',
                       t.tbl, t.pkexpr)
          into v_del;
        raise exception using errcode = 'P0205';
      exception
        when sqlstate 'P0205' then null;
        when others then
          v_upd := coalesce(v_upd, 'ERR:' || sqlstate);
          v_del := coalesce(v_del, 'ERR:' || sqlstate);
      end;
      perform pg_temp.spec205_unbecome();
      insert into spec205_allobs values (p_mode, p.code, t.tbl, v_upd, v_del);
    end loop;
  end loop;
end $$;

-- user_stores triggers are still disabled (see fixtures); order_schedule has
-- no user triggers. The probes test RLS, not the brand-match trigger.
alter table public.order_schedule disable trigger user;

select pg_temp.spec205_mode('old');
select pg_temp.spec205_observe('old');
select pg_temp.spec205_all_probe('old');
select pg_temp.spec205_mode('new');
select pg_temp.spec205_observe('new');
select pg_temp.spec205_all_probe('new');

alter table public.order_schedule enable trigger user;
alter table public.user_stores    enable trigger user;

-- One assertion per principal: tables whose visible primary keys differ.
select is(
  (select coalesce(string_agg(o.tbl, ', ' order by o.tbl), '')
     from spec205_obs o
     join spec205_obs n on n.code = o.code and n.tbl = o.tbl and n.mode = 'new'
    where o.mode = 'old' and o.code = p.code
      and o.ids is distinct from n.ids),
  '',
  'AC-2: ' || p.code || ' sees exactly the same rows under the old and the new USING text in all 35 R4 tables'
)
  from spec205_p p order by p.ord;

-- One assertion per principal: ALL-policy UPDATE/DELETE reachability.
select is(
  (select coalesce(string_agg(o.tbl, ', ' order by o.tbl), '')
     from spec205_allobs o
     join spec205_allobs n on n.code = o.code and n.tbl = o.tbl and n.mode = 'new'
    where o.mode = 'old' and o.code = p.code
      and (o.upd is distinct from n.upd or o.del is distinct from n.del)),
  '',
  'AC-2: ' || p.code || ' reaches the same order_schedule / user_stores rows by UPDATE ... RETURNING and DELETE ... RETURNING under old and new USING'
)
  from spec205_p p order by p.ord;

-- Restore guard: the catalog carries the new text again.
select is(
  (select coalesce(string_agg(r.tbl || '.' || r.pol, ', ' order by r.tbl, r.pol), '')
     from spec205_r4 r
     join pg_policies p on p.schemaname = 'public' and p.tablename = r.tbl and p.policyname = r.pol
    where p.qual is distinct from r.new_using or r.new_using is null),
  '',
  'AC-2: after the old/new round trip all 36 policies carry the post-205 USING text again'
);

-- ── Non-vacuity guards (new mode) ─────────────────────────────────
-- Visible fixture rows: (code, tbl, scope).
create temp view spec205_vis as
  select o.code, f.tbl, f.scope
    from spec205_obs o
    join spec205_fx f on f.tbl = o.tbl and f.k = any (o.ids)
   where o.mode = 'new';

select is(
  (select coalesce(string_agg(t.tbl, ', ' order by t.tbl), '')
     from spec205_tables t
    where not exists (select 1 from spec205_vis v
                       where v.code = 'ADM-A' and v.tbl = t.tbl and v.scope in ('A1', 'A2', 'A'))),
  '',
  'AC-2 non-vacuity: ADM-A sees at least one brand-A fixture row in every one of the 35 tables'
);

select is(
  (select coalesce(string_agg(distinct v.tbl, ', '), '')
     from spec205_vis v where v.code = 'ADM-A' and v.scope in ('B1', 'B', 'C')),
  '',
  'AC-2 non-vacuity: ADM-A sees no brand-B (or deleted brand-C) fixture row in any table'
);

select is(
  (select string_agg(o.tbl || '=' || cardinality(o.ids), ', ' order by o.tbl)
     from spec205_obs o
    where o.mode = 'new' and o.code = 'STAFF'
      and o.tbl in ('notifications', 'staff_reports', 'order_approvals')),
  'notifications=0, order_approvals=0, staff_reports=0',
  'AC-2 non-vacuity: STAFF (linked to A1, not privileged) sees 0 rows in notifications, staff_reports and order_approvals'
);

select is(
  (select coalesce(string_agg(x, ', ' order by x), '')
     from (
       select 'missing NULL row in ' || f.tbl as x
         from spec205_fx f
        where f.scope = 'NULL'
          and not exists (select 1 from spec205_vis v where v.code = 'SA' and v.tbl = f.tbl and v.scope = 'NULL')
       union all
       select 'visible NULLFK row in ' || v.tbl
         from spec205_vis v where v.code = 'SA' and v.scope = 'NULLFK'
     ) y),
  '',
  'AC-2 non-vacuity: SA sees every NULL-scope fixture row (super_admin arm; audit_log NULL-store via auth_is_privileged) and no NULL-FK child row (EXISTS never matches a NULL key)'
);

select is(
  (select coalesce(string_agg(x, ', ' order by x), '')
     from (
       select 'no B1 row in ' || t as x
         from unnest(array['audit_log','eod_entries','eod_submissions','inventory_count_entries',
                           'inventory_counts','inventory_items','item_vendors','order_approvals',
                           'order_schedule','po_items','pos_import_items','pos_imports',
                           'purchase_orders','report_definitions','report_runs',
                           'store_count_layouts','stores','vendor_order_attempts','waste_log',
                           'weekly_reminder_log']) t
        where not exists (select 1 from spec205_vis v where v.code = 'ADM-A+L' and v.tbl = t and v.scope = 'B1')
       union all
       select 'brand-B row in ' || v.tbl
         from spec205_vis v
        where v.code = 'ADM-A+L' and v.scope = 'B'
     ) y),
  '',
  'AC-2 non-vacuity: ADM-A+L sees B1 rows in every store-scoped table (arm iii kept for admins) but no brand-B row in any brand-scoped table'
);

select * from finish();
rollback;
