-- ============================================================
-- Spec 205 - RLS visibility checks run once per query, not once per row.
--
-- Design authority: specs/205-rls-visibility-once-per-query.md
-- "## Backend design" (D-1 .. D-9).
--
-- WHAT THIS DOES (one transaction):
--   1. lock_timeout + fail-closed pre-flight (the 36 expected policies; the
--      two ALL policies carry an explicit WITH CHECK equal to their USING).
--   2. Locks the 35 tables (profiles, stores, user_stores last).
--   3. Two new helpers, no row argument, so a policy can call them as an
--      uncorrelated scalar subquery `(select helper())` that Postgres plans as
--      an InitPlan and evaluates ONCE per query instead of once per row:
--        public.auth_visible_store_ids() returns uuid[]
--        public.auth_profile_brand_id()  returns uuid
--   4. 36 `alter policy ... using (...)` rewrites (SELECT policies and the
--      USING of two ALL policies). No policy is created or dropped; names,
--      cmd, permissive, roles and every WITH CHECK are unchanged.
--   5. Index audit_log (store_id, created_at desc).
--   6. Fail-closed post-flight.
--
-- NOT REPLAYABLE (by design): the pre-flight fails closed, so re-running this
-- file after a successful apply raises (the helpers already exist and the 36
-- per-row policies are gone). If execute_sql succeeded but the
-- schema_migrations insert failed, insert the row; do not re-run.
-- The pre-flight's expected list is the 36 policies that existed when this
-- file was written: a new per-row policy dated before this file must be
-- added to the expected list (or the pre-flight will fail closed on it).
--
-- POSTURE: both helpers are `language sql stable security definer
-- set search_path = public, auth`, the same as auth_can_see_store /
-- auth_can_see_brand. EXECUTE is revoked from PUBLIC and granted to
-- authenticated, anon and service_role. anon is required (OQ-1): most of the
-- rewritten policies have no TO clause, so they apply to anon too, and anon
-- holds SELECT on every public table (spec 097). Without EXECUTE, an anon read
-- would fail at executor start with 42501 instead of returning []. For anon,
-- auth.uid() is null, so auth_visible_store_ids() = '{}' and
-- auth_profile_brand_id() = null: 0 rows, no error, the same as before.
--
-- EQUIVALENCE (spec D-2.3; proved by supabase/tests/
-- rls_visibility_once_per_query.test.sql):
--   auth_can_see_store(x) -> ((select auth_is_super_admin())
--                              or x = any ((select auth_visible_store_ids())::uuid[]))
--   auth_can_see_brand(b) -> ((select auth_is_super_admin())
--                              or b = (select auth_profile_brand_id()))
--   auth_visible_store_ids() = arm (ii) of auth_can_see_store (auth_is_admin()
--   and the store's brand matches profiles.brand_id) UNION arm (iii) (the
--   caller's user_stores links). Super_admin (arm i) stays a separate OR arm
--   so NULL-id rows keep today's outcome. For a non-super_admin and a NULL id
--   the old predicate is false and the new one is NULL: both deny in USING.
--   The one call under NOT (invitations, store list) is wrapped in
--   coalesce(..., false) so NULL and false cannot diverge there.
--   The `::uuid[]` cast in `= any ((select ...)::uuid[])` is load-bearing.
--   The grammar's select_with_parens absorbs any number of parentheses, so
--   without the cast `= any ((select ...))` is the subquery form of ANY and
--   fails with 42883 uuid = uuid[]. The cast (to the type the helper already
--   returns) makes the operand a scalar subquery, planned as one InitPlan:
--   `store_id = ANY ((InitPlan 1).col1)`. The rls_visibility_once_per_query
--   suite pins prorettype = uuid[] so the cast can never silently coerce.
--   Zero-argument helpers already in a rewritten qual (auth_is_privileged,
--   auth_is_super_admin, auth_profile_is_privileged) are wrapped in
--   (select ...) too. No rewritten qual names auth_is_admin (spec 157 LINT-1).
--   auth.uid() is wrapped only in profiles; invitations keeps the bare
--   `invited_by = auth.uid()` (spec D-2.5; pinned by invitations_hardening K-b
--   and profiles_insert_hardening K-13).
--
-- CHANGE BOTH TOGETHER: auth_visible_store_ids() duplicates arms (ii)+(iii) of
-- auth_can_see_store(); auth_profile_brand_id() duplicates the non-super_admin
-- arm of auth_can_see_brand(). Any edit to one must be mirrored in the other,
-- and rls_visibility_once_per_query.test.sql re-run. Write-side policies,
-- RPCs and edge functions still call auth_can_see_store/auth_can_see_brand.
-- New SELECT/ALL policies must use the InitPlan form; enforced by
-- supabase/tests/rls_per_row_helper_lint.test.sql.
--
-- POLICY COMMENTS are not edited. Several still say "delegates to
-- auth_can_see_store()"; that remains semantically true (equivalent
-- predicate). This header is the record of the text change.
--
-- REALTIME: no supabase_realtime publication change, so no realtime restart
-- is needed for this migration. postgres_changes delivery is authorized per
-- subscriber through these same SELECT policies; the InitPlan is evaluated
-- per execution with that subscriber's claims.
--
-- LOCKS: ALTER POLICY takes an ACCESS EXCLUSIVE lock per table. All 35 are
-- taken up front in one LOCK statement, profiles / stores / user_stores last
-- (in-flight readers take AccessShare on those three inside the helpers, so
-- locking them last shortens the deadlock window). lock_timeout = 5s; a
-- 55P03 or 40P01 rolls the whole transaction back and is safe to retry.
--
-- PROD APPLY (owner go-ahead only; project ebwnovzzkwhsdxkpyjka): Supabase
-- MCP execute_sql of this file as one call, then insert version
-- 20261123120000 into supabase_migrations.schema_migrations, then the spec
-- AC-14 post-check. Push to main right after, or db-migrations-applied fails.
--
-- ------------------------------------------------------------
-- R9 ROLLBACK (hand-written; NOT a migration file - that would trip the
-- drift gate). Restores the pre-205 USING texts. The two ALL policies never
-- had their WITH CHECK touched, so there is nothing to remove. Functions are
-- dropped last (pg_depend blocks the drop while a policy references them).
-- The rollback takes the same 35-table lock up front as the forward path
-- (profiles, stores, user_stores last). To run it: strip the leading '-- '
-- from every line from '-- begin;' through '-- commit;'.
-- After a prod rollback, delete the schema_migrations row AND revert the
-- commit.
--
-- begin;
-- set local lock_timeout = '5s';
-- lock table
--   public.audit_log,
--   public.brands,
--   public.catalog_ingredients,
--   public.eod_entries,
--   public.eod_submissions,
--   public.ingredient_conversions,
--   public.inventory_count_entries,
--   public.inventory_counts,
--   public.inventory_items,
--   public.invitations,
--   public.item_vendors,
--   public.notifications,
--   public.order_approvals,
--   public.order_schedule,
--   public.po_items,
--   public.pos_import_items,
--   public.pos_imports,
--   public.pos_recipe_aliases,
--   public.prep_recipe_ingredients,
--   public.prep_recipes,
--   public.purchase_orders,
--   public.recipe_ingredients,
--   public.recipe_prep_items,
--   public.recipes,
--   public.report_definitions,
--   public.report_runs,
--   public.staff_reports,
--   public.store_count_layouts,
--   public.vendor_order_attempts,
--   public.vendors,
--   public.waste_log,
--   public.weekly_reminder_log,
--   public.profiles,
--   public.stores,
--   public.user_stores
--   in access exclusive mode;
-- alter policy "store_member_read_eod_submissions" on public.eod_submissions using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_inventory_counts" on public.inventory_counts using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_inventory_items" on public.inventory_items using (public.auth_can_see_store(store_id));
-- alter policy "Store members can read order_schedule" on public.order_schedule using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_pos_imports" on public.pos_imports using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_purchase_orders" on public.purchase_orders using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_report_definitions" on public.report_definitions using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_report_runs" on public.report_runs using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_count_layouts" on public.store_count_layouts using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_vendor_order_attempts" on public.vendor_order_attempts using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_waste_log" on public.waste_log using (public.auth_can_see_store(store_id));
-- alter policy "weekly_reminder_log_read" on public.weekly_reminder_log using (public.auth_can_see_store(store_id));
-- alter policy "store_member_read_stores" on public.stores using (public.auth_can_see_store(id));
-- alter policy "privileged_store_read_order_approvals" on public.order_approvals using (public.auth_is_privileged() and public.auth_can_see_store(store_id));
-- alter policy "Admins can write order_schedule" on public.order_schedule using (public.auth_is_privileged() and public.auth_can_see_store(store_id));
-- alter policy "store_member_read_eod_entries" on public.eod_entries using (exists (select 1 from public.eod_submissions s where s.id = eod_entries.submission_id and public.auth_can_see_store(s.store_id)));
-- alter policy "store_member_read_inventory_count_entries" on public.inventory_count_entries using (exists (select 1 from public.inventory_counts c where c.id = inventory_count_entries.count_id and public.auth_can_see_store(c.store_id)));
-- alter policy "store_member_read_item_vendors" on public.item_vendors using (exists (select 1 from public.inventory_items ii where ii.id = item_vendors.item_id and public.auth_can_see_store(ii.store_id)));
-- alter policy "store_member_read_po_items" on public.po_items using (exists (select 1 from public.purchase_orders po where po.id = po_items.po_id and public.auth_can_see_store(po.store_id)));
-- alter policy "store_member_read_pos_import_items" on public.pos_import_items using (exists (select 1 from public.pos_imports pi where pi.id = pos_import_items.import_id and public.auth_can_see_store(pi.store_id)));
-- alter policy "store_member_read_audit_log" on public.audit_log using ((store_id is not null and public.auth_can_see_store(store_id)) or (store_id is null and public.auth_is_privileged()));
-- alter policy "brand_member_read_catalog_ingredients" on public.catalog_ingredients using (public.auth_can_see_brand(brand_id));
-- alter policy "brand_member_read_prep_recipes" on public.prep_recipes using (public.auth_can_see_brand(brand_id));
-- alter policy "brand_member_read_recipes" on public.recipes using (public.auth_can_see_brand(brand_id));
-- alter policy "brand_member_read_vendors" on public.vendors using (public.auth_can_see_brand(brand_id));
-- alter policy "brand_member_read_brands" on public.brands using (public.auth_can_see_brand(id) and (deleted_at is null or public.auth_is_super_admin()));
-- alter policy "privileged_brand_read_notifications" on public.notifications using (public.auth_is_privileged() and public.auth_can_see_brand(brand_id));
-- alter policy "privileged_brand_read_staff_reports" on public.staff_reports using (public.auth_is_privileged() and public.auth_can_see_brand(brand_id));
-- alter policy "Admins can read all profiles" on public.profiles using ((public.auth_is_privileged() and public.auth_can_see_brand(brand_id)) or id = auth.uid());
-- alter policy "brand_member_read_ingredient_conversions" on public.ingredient_conversions using (exists (select 1 from public.catalog_ingredients ci where ci.id = ingredient_conversions.catalog_id and public.auth_can_see_brand(ci.brand_id)));
-- alter policy "brand_member_read_pos_recipe_aliases" on public.pos_recipe_aliases using (exists (select 1 from public.recipes r where r.id = pos_recipe_aliases.recipe_id and public.auth_can_see_brand(r.brand_id)));
-- alter policy "brand_member_read_prep_recipe_ingredients" on public.prep_recipe_ingredients using (exists (select 1 from public.prep_recipes pr where pr.id = prep_recipe_ingredients.prep_recipe_id and public.auth_can_see_brand(pr.brand_id)));
-- alter policy "brand_member_read_recipe_ingredients" on public.recipe_ingredients using (exists (select 1 from public.recipes r where r.id = recipe_ingredients.recipe_id and public.auth_can_see_brand(r.brand_id)));
-- alter policy "brand_member_read_recipe_prep_items" on public.recipe_prep_items using (exists (select 1 from public.recipes r where r.id = recipe_prep_items.recipe_id and public.auth_can_see_brand(r.brand_id)));
-- alter policy "Admins can manage all store links" on public.user_stores using (public.auth_is_privileged() and exists (select 1 from public.stores s where s.id = user_stores.store_id and public.auth_can_see_brand(s.brand_id)));
-- alter policy "Admins can read invitations" on public.invitations using (
--   public.auth_profile_is_privileged()
--   and invitations.role in ('user', 'admin')
--   and (invitations.brand_id is null or public.auth_can_see_brand(invitations.brand_id))
--   and not exists (
--     select 1
--       from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
--       left join public.stores s on s.id::text = lower(sid.store_id)
--      where s.id is null
--         or not public.auth_can_see_brand(s.brand_id)
--   )
--   and (
--     invitations.brand_id is not null
--     or cardinality(coalesce(invitations.store_ids, '{}'::text[])) > 0
--     or public.auth_is_super_admin()
--     or invitations.invited_by = auth.uid()
--   )
-- );
-- drop index if exists public.audit_log_store_id_created_at_idx;
-- drop function if exists public.auth_visible_store_ids();
-- drop function if exists public.auth_profile_brand_id();
-- commit;
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ------------------------------------------------------------
-- Pre-flight (fail closed). Exact-text md5s are deliberately NOT embedded:
-- a future Postgres major re-deparses differently and a CI replay would fail
-- on history. The exact-text comparison is spec AC-13, out of band.
-- ------------------------------------------------------------
do $$
declare
  v_extra   text;
  v_missing text;
  v_bad     text;
begin
  -- The helpers must not exist yet: `create or replace` below would otherwise
  -- keep an existing function's owner and grants (spec 205 security review).
  if to_regprocedure('public.auth_visible_store_ids()') is not null
     or to_regprocedure('public.auth_profile_brand_id()') is not null then
    raise exception 'spec 205 pre-flight: public.auth_visible_store_ids() or public.auth_profile_brand_id() already exists (already applied? do not re-run; see the header)';
  end if;

  with expected(tablename, policyname, cmd) as (
    values
      ('audit_log',               'store_member_read_audit_log',               'SELECT'),
      ('brands',                  'brand_member_read_brands',                  'SELECT'),
      ('catalog_ingredients',     'brand_member_read_catalog_ingredients',     'SELECT'),
      ('eod_entries',             'store_member_read_eod_entries',             'SELECT'),
      ('eod_submissions',         'store_member_read_eod_submissions',         'SELECT'),
      ('ingredient_conversions',  'brand_member_read_ingredient_conversions',  'SELECT'),
      ('inventory_count_entries', 'store_member_read_inventory_count_entries', 'SELECT'),
      ('inventory_counts',        'store_member_read_inventory_counts',        'SELECT'),
      ('inventory_items',         'store_member_read_inventory_items',         'SELECT'),
      ('invitations',             'Admins can read invitations',               'SELECT'),
      ('item_vendors',            'store_member_read_item_vendors',            'SELECT'),
      ('notifications',           'privileged_brand_read_notifications',       'SELECT'),
      ('order_approvals',         'privileged_store_read_order_approvals',     'SELECT'),
      ('order_schedule',          'Admins can write order_schedule',           'ALL'),
      ('order_schedule',          'Store members can read order_schedule',     'SELECT'),
      ('po_items',                'store_member_read_po_items',                'SELECT'),
      ('pos_import_items',        'store_member_read_pos_import_items',        'SELECT'),
      ('pos_imports',             'store_member_read_pos_imports',             'SELECT'),
      ('pos_recipe_aliases',      'brand_member_read_pos_recipe_aliases',      'SELECT'),
      ('prep_recipe_ingredients', 'brand_member_read_prep_recipe_ingredients', 'SELECT'),
      ('prep_recipes',            'brand_member_read_prep_recipes',            'SELECT'),
      ('profiles',                'Admins can read all profiles',              'SELECT'),
      ('purchase_orders',         'store_member_read_purchase_orders',         'SELECT'),
      ('recipe_ingredients',      'brand_member_read_recipe_ingredients',      'SELECT'),
      ('recipe_prep_items',       'brand_member_read_recipe_prep_items',       'SELECT'),
      ('recipes',                 'brand_member_read_recipes',                 'SELECT'),
      ('report_definitions',      'store_member_read_report_definitions',      'SELECT'),
      ('report_runs',             'store_member_read_report_runs',             'SELECT'),
      ('staff_reports',           'privileged_brand_read_staff_reports',       'SELECT'),
      ('store_count_layouts',     'store_member_read_count_layouts',           'SELECT'),
      ('stores',                  'store_member_read_stores',                  'SELECT'),
      ('user_stores',             'Admins can manage all store links',         'ALL'),
      ('vendor_order_attempts',   'store_member_read_vendor_order_attempts',   'SELECT'),
      ('vendors',                 'brand_member_read_vendors',                 'SELECT'),
      ('waste_log',               'store_member_read_waste_log',               'SELECT'),
      ('weekly_reminder_log',     'weekly_reminder_log_read',                  'SELECT')
  ),
  live as (
    select tablename::text, policyname::text, cmd::text
      from pg_policies
     where schemaname = 'public'
       and cmd in ('SELECT', 'ALL')
       and qual ~ 'auth_can_see_(store|brand)\('
  )
  select
    (select string_agg(format('%s.%s (%s)', tablename, policyname, cmd), ', ' order by tablename, policyname)
       from (select * from live except select * from expected) x),
    (select string_agg(format('%s.%s (%s)', tablename, policyname, cmd), ', ' order by tablename, policyname)
       from (select * from expected except select * from live) y)
    into v_extra, v_missing;

  if v_extra is not null or v_missing is not null then
    raise exception 'spec 205 pre-flight: per-row visibility policy set differs from the 36 expected. extra: [%] missing: [%]',
      coalesce(v_extra, ''), coalesce(v_missing, '');
  end if;

  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into v_bad
    from pg_policies
   where schemaname = 'public'
     and (tablename, policyname) in (('order_schedule', 'Admins can write order_schedule'),
                                     ('user_stores',    'Admins can manage all store links'))
     and (with_check is null
          or regexp_replace(with_check, '\s+', ' ', 'g') <> regexp_replace(qual, '\s+', ' ', 'g'));

  if v_bad is not null then
    raise exception 'spec 205 pre-flight: ALL policy without an explicit WITH CHECK equal to its USING: %', v_bad;
  end if;

  if (select count(*) from pg_policies
       where schemaname = 'public'
         and (tablename, policyname) in (('order_schedule', 'Admins can write order_schedule'),
                                         ('user_stores',    'Admins can manage all store links'))) <> 2 then
    raise exception 'spec 205 pre-flight: expected both ALL policies to exist';
  end if;
end
$$;

-- ------------------------------------------------------------
-- Locks: alphabetical, with profiles, stores, user_stores last.
-- ------------------------------------------------------------
lock table
  public.audit_log,
  public.brands,
  public.catalog_ingredients,
  public.eod_entries,
  public.eod_submissions,
  public.ingredient_conversions,
  public.inventory_count_entries,
  public.inventory_counts,
  public.inventory_items,
  public.invitations,
  public.item_vendors,
  public.notifications,
  public.order_approvals,
  public.order_schedule,
  public.po_items,
  public.pos_import_items,
  public.pos_imports,
  public.pos_recipe_aliases,
  public.prep_recipe_ingredients,
  public.prep_recipes,
  public.purchase_orders,
  public.recipe_ingredients,
  public.recipe_prep_items,
  public.recipes,
  public.report_definitions,
  public.report_runs,
  public.staff_reports,
  public.store_count_layouts,
  public.vendor_order_attempts,
  public.vendors,
  public.waste_log,
  public.weekly_reminder_log,
  public.profiles,
  public.stores,
  public.user_stores
  in access exclusive mode;

-- ------------------------------------------------------------
-- Helpers (must exist before any policy references them).
-- ------------------------------------------------------------
create or replace function public.auth_visible_store_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, auth
as $$
  select array(
    select s.id
      from public.stores s
     where public.auth_is_admin()
       and exists (
         select 1 from public.profiles p
          where p.id = auth.uid()
            and p.brand_id = s.brand_id
       )
    union
    select us.store_id
      from public.user_stores us
     where us.user_id = auth.uid()
  );
$$;

create or replace function public.auth_profile_brand_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select p.brand_id from public.profiles p where p.id = auth.uid();
$$;

revoke all on function public.auth_visible_store_ids() from public;
revoke all on function public.auth_profile_brand_id()  from public;
grant execute on function public.auth_visible_store_ids() to authenticated, anon, service_role;
grant execute on function public.auth_profile_brand_id()  to authenticated, anon, service_role;

comment on function public.auth_visible_store_ids() is
  'spec 205: store ids for which arms (ii) and (iii) of auth_can_see_store (spec 041) hold for the caller — own-brand stores when auth_is_admin() and profiles.brand_id matches stores.brand_id, UNION the caller''s user_stores links. Super_admin (arm i) is NOT folded in; policies OR (select auth_is_super_admin()) separately. Never NULL. CHANGE BOTH TOGETHER: any edit to auth_can_see_store must be mirrored here, and supabase/tests/rls_visibility_once_per_query.test.sql re-run.';

comment on function public.auth_profile_brand_id() is
  'spec 205: the caller''s profiles.brand_id or NULL, for every role. Mirrors the non-super_admin arm of auth_can_see_brand (spec 012a). CHANGE BOTH TOGETHER with auth_can_see_brand.';

-- ------------------------------------------------------------
-- The 36 rewrites. USING only: WITH CHECK is untouched on every policy.
-- ------------------------------------------------------------

-- Direct store-scoped (13).
alter policy "store_member_read_eod_submissions" on public.eod_submissions
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_inventory_counts" on public.inventory_counts
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_inventory_items" on public.inventory_items
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "Store members can read order_schedule" on public.order_schedule
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_pos_imports" on public.pos_imports
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_purchase_orders" on public.purchase_orders
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_report_definitions" on public.report_definitions
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_report_runs" on public.report_runs
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_count_layouts" on public.store_count_layouts
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_vendor_order_attempts" on public.vendor_order_attempts
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_waste_log" on public.waste_log
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "weekly_reminder_log_read" on public.weekly_reminder_log
  using ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[]));
alter policy "store_member_read_stores" on public.stores
  using ((select public.auth_is_super_admin()) or id = any ((select public.auth_visible_store_ids())::uuid[]));

-- Store plus privileged (2). The ALL policy's WITH CHECK stays
-- (auth_is_privileged() AND auth_can_see_store(store_id)).
alter policy "privileged_store_read_order_approvals" on public.order_approvals
  using ((select public.auth_is_privileged())
         and ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[])));
alter policy "Admins can write order_schedule" on public.order_schedule
  using ((select public.auth_is_privileged())
         and ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[])));

-- Store-scoped EXISTS children (5).
alter policy "store_member_read_eod_entries" on public.eod_entries
  using (exists (select 1 from public.eod_submissions s
                  where s.id = eod_entries.submission_id
                    and ((select public.auth_is_super_admin()) or s.store_id = any ((select public.auth_visible_store_ids())::uuid[]))));
alter policy "store_member_read_inventory_count_entries" on public.inventory_count_entries
  using (exists (select 1 from public.inventory_counts c
                  where c.id = inventory_count_entries.count_id
                    and ((select public.auth_is_super_admin()) or c.store_id = any ((select public.auth_visible_store_ids())::uuid[]))));
alter policy "store_member_read_item_vendors" on public.item_vendors
  using (exists (select 1 from public.inventory_items ii
                  where ii.id = item_vendors.item_id
                    and ((select public.auth_is_super_admin()) or ii.store_id = any ((select public.auth_visible_store_ids())::uuid[]))));
alter policy "store_member_read_po_items" on public.po_items
  using (exists (select 1 from public.purchase_orders po
                  where po.id = po_items.po_id
                    and ((select public.auth_is_super_admin()) or po.store_id = any ((select public.auth_visible_store_ids())::uuid[]))));
alter policy "store_member_read_pos_import_items" on public.pos_import_items
  using (exists (select 1 from public.pos_imports pi
                  where pi.id = pos_import_items.import_id
                    and ((select public.auth_is_super_admin()) or pi.store_id = any ((select public.auth_visible_store_ids())::uuid[]))));

-- audit_log (1).
alter policy "store_member_read_audit_log" on public.audit_log
  using ((store_id is not null
          and ((select public.auth_is_super_admin()) or store_id = any ((select public.auth_visible_store_ids())::uuid[])))
         or (store_id is null and (select public.auth_is_privileged())));

-- Direct brand-scoped (4).
alter policy "brand_member_read_catalog_ingredients" on public.catalog_ingredients
  using ((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id()));
alter policy "brand_member_read_prep_recipes" on public.prep_recipes
  using ((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id()));
alter policy "brand_member_read_recipes" on public.recipes
  using ((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id()));
alter policy "brand_member_read_vendors" on public.vendors
  using ((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id()));

-- brands (1).
alter policy "brand_member_read_brands" on public.brands
  using (((select public.auth_is_super_admin()) or id = (select public.auth_profile_brand_id()))
         and (deleted_at is null or (select public.auth_is_super_admin())));

-- Brand plus privileged (2).
alter policy "privileged_brand_read_notifications" on public.notifications
  using ((select public.auth_is_privileged())
         and ((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id())));
alter policy "privileged_brand_read_staff_reports" on public.staff_reports
  using ((select public.auth_is_privileged())
         and ((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id())));

-- profiles (1).
alter policy "Admins can read all profiles" on public.profiles
  using (((select public.auth_is_privileged())
          and ((select public.auth_is_super_admin()) or brand_id = (select public.auth_profile_brand_id())))
         or id = (select auth.uid()));

-- Brand-scoped EXISTS children (5).
alter policy "brand_member_read_ingredient_conversions" on public.ingredient_conversions
  using (exists (select 1 from public.catalog_ingredients ci
                  where ci.id = ingredient_conversions.catalog_id
                    and ((select public.auth_is_super_admin()) or ci.brand_id = (select public.auth_profile_brand_id()))));
alter policy "brand_member_read_pos_recipe_aliases" on public.pos_recipe_aliases
  using (exists (select 1 from public.recipes r
                  where r.id = pos_recipe_aliases.recipe_id
                    and ((select public.auth_is_super_admin()) or r.brand_id = (select public.auth_profile_brand_id()))));
alter policy "brand_member_read_prep_recipe_ingredients" on public.prep_recipe_ingredients
  using (exists (select 1 from public.prep_recipes pr
                  where pr.id = prep_recipe_ingredients.prep_recipe_id
                    and ((select public.auth_is_super_admin()) or pr.brand_id = (select public.auth_profile_brand_id()))));
alter policy "brand_member_read_recipe_ingredients" on public.recipe_ingredients
  using (exists (select 1 from public.recipes r
                  where r.id = recipe_ingredients.recipe_id
                    and ((select public.auth_is_super_admin()) or r.brand_id = (select public.auth_profile_brand_id()))));
alter policy "brand_member_read_recipe_prep_items" on public.recipe_prep_items
  using (exists (select 1 from public.recipes r
                  where r.id = recipe_prep_items.recipe_id
                    and ((select public.auth_is_super_admin()) or r.brand_id = (select public.auth_profile_brand_id()))));

-- user_stores (1, ALL). WITH CHECK stays byte-identical (spec 195 T3).
alter policy "Admins can manage all store links" on public.user_stores
  using ((select public.auth_is_privileged())
         and exists (select 1 from public.stores s
                      where s.id = user_stores.store_id
                        and ((select public.auth_is_super_admin()) or s.brand_id = (select public.auth_profile_brand_id()))));

-- invitations (1, to authenticated). The store-list call sits under NOT, so
-- it is coalesced to false (spec D-2.4). invited_by = auth.uid() stays bare
-- (spec D-2.5).
alter policy "Admins can read invitations" on public.invitations
  using (
    (select public.auth_profile_is_privileged())
    and invitations.role in ('user', 'admin')
    and (invitations.brand_id is null
         or ((select public.auth_is_super_admin()) or invitations.brand_id = (select public.auth_profile_brand_id())))
    and not exists (
      select 1
        from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
        left join public.stores s on s.id::text = lower(sid.store_id)
       where s.id is null
          or not coalesce(((select public.auth_is_super_admin()) or s.brand_id = (select public.auth_profile_brand_id())), false)
    )
    and (
      invitations.brand_id is not null
      or cardinality(coalesce(invitations.store_ids, '{}'::text[])) > 0
      or (select public.auth_is_super_admin())
      or invitations.invited_by = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- Index (R8). Not CONCURRENTLY: one transaction, the table is already
-- AccessExclusive-locked above, and it is small (~4k rows on prod).
-- ------------------------------------------------------------
create index if not exists audit_log_store_id_created_at_idx
  on public.audit_log (store_id, created_at desc);

-- ------------------------------------------------------------
-- Post-flight (fail closed).
-- ------------------------------------------------------------
do $$
declare
  v_left text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into v_left
    from pg_policies
   where schemaname = 'public'
     and cmd in ('SELECT', 'ALL')
     and qual ~ 'auth_can_see_(store|brand)\(';
  if v_left is not null then
    raise exception 'spec 205 post-flight: per-row visibility call left in: %', v_left;
  end if;

  if (select count(*) from pg_policies
       where schemaname = 'public'
         and (tablename, policyname) in (('order_schedule', 'Admins can write order_schedule'),
                                         ('user_stores',    'Admins can manage all store links'))
         and with_check like '%auth_can_see_%') <> 2 then
    raise exception 'spec 205 post-flight: an ALL policy WITH CHECK was changed';
  end if;

  if public.auth_visible_store_ids() is null then
    raise exception 'spec 205 post-flight: auth_visible_store_ids() returned NULL';
  end if;
end
$$;

commit;
