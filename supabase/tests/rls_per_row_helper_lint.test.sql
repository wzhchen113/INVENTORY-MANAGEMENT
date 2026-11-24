-- supabase/tests/rls_per_row_helper_lint.test.sql
--
-- Spec 205 (AC-4) shape lint: no SELECT policy, and no USING of an ALL
-- policy, on public.* calls the per-row visibility helpers
-- auth_can_see_store(...) / auth_can_see_brand(...).
--
-- Why: both helpers are SECURITY DEFINER, so Postgres cannot inline them and
-- calls them once per candidate row (0.5-1.1 ms per call on prod; 1.5 s for
-- the inventory read). Spec 205 rewrote all 36 such policies to the InitPlan
-- form, evaluated once per query:
--   store: ((select public.auth_is_super_admin())
--           or <store> = any ((select public.auth_visible_store_ids())::uuid[]))
--   brand: ((select public.auth_is_super_admin())
--           or <brand> = (select public.auth_profile_brand_id()))
-- The ::uuid[] cast is required: without it ANY takes the subquery form and
-- fails with 42883 (uuid = uuid[]); extra parentheses do not help.
--
-- Scope: public.* only, PERMISSIVE and RESTRICTIVE, cmd in (SELECT, ALL),
-- `qual` only. `with_check` is NOT scanned: write-side checks run once per
-- written row and keep the old helpers by design (the two ALL policies
-- "Admins can write order_schedule" and "Admins can manage all store links"
-- still call them in WITH CHECK). INSERT/UPDATE/DELETE policies are out of
-- scope for the same reason. storage.objects policies are out of scope.
--
-- Allowlist: seeded empty. A policy that must keep a per-row call adds one
-- VALUES row (schemaname, tablename, policyname) with a one-line reason, in
-- the same PR that introduces it.
--
-- Plan (3 arms):
--   (1) offender count under the allowlist is 0.
--   (2) string_agg of offenders is '' (readable CI failure).
--   (3) negative: a throwaway policy using auth_can_see_store(id) IS caught
--       (drop-then-assert, as permissive_policy_lint arm (3); a savepoint
--       rollback would lose the pgTAP counters).

begin;
create extension if not exists pgtap;

select plan(3);

-- ─── Arm (1): offender count is 0 ────────────────────────────────
select is(
  (
    with allowlist(schemaname, tablename, policyname) as (
      -- Seeded empty. Add rows as: values ('public'::name, '<table>'::name, '<policy>'::name) -- reason
      select null::name, null::name, null::name where false
    ),
    offenders as (
      select p.schemaname, p.tablename, p.policyname
        from pg_policies p
       where p.schemaname = 'public'
         and p.cmd in ('SELECT', 'ALL')
         and (coalesce(p.qual, '') like '%auth_can_see_store(%'
              or coalesce(p.qual, '') like '%auth_can_see_brand(%')
         and not exists (select 1 from allowlist a
                          where a.schemaname = p.schemaname
                            and a.tablename  = p.tablename
                            and a.policyname = p.policyname)
    )
    select count(*)::int from offenders
  ),
  0,
  'arm (1): no SELECT/ALL policy on public.* calls auth_can_see_store(...) / auth_can_see_brand(...) per row in its USING. '
  || 'Use ((select public.auth_is_super_admin()) or <store> = any ((select public.auth_visible_store_ids())::uuid[])) / '
  || '((select public.auth_is_super_admin()) or <brand> = (select public.auth_profile_brand_id())); '
  || 'the ::uuid[] cast is required (without it ANY takes the subquery form and fails with 42883); see spec 205'
);

-- ─── Arm (2): offenders listed ───────────────────────────────────
select is(
  (
    with allowlist(schemaname, tablename, policyname) as (
      select null::name, null::name, null::name where false
    ),
    offenders as (
      select p.schemaname, p.tablename, p.policyname, p.cmd
        from pg_policies p
       where p.schemaname = 'public'
         and p.cmd in ('SELECT', 'ALL')
         and (coalesce(p.qual, '') like '%auth_can_see_store(%'
              or coalesce(p.qual, '') like '%auth_can_see_brand(%')
         and not exists (select 1 from allowlist a
                          where a.schemaname = p.schemaname
                            and a.tablename  = p.tablename
                            and a.policyname = p.policyname)
    )
    select coalesce(string_agg(format('%s.%s "%s" (%s)', schemaname, tablename, policyname, cmd),
                               ', ' order by tablename, policyname), '')
      from offenders
  ),
  '',
  'arm (2): offending policies (per-row auth_can_see_store/auth_can_see_brand in a SELECT/ALL USING). '
  || 'Rewrite them to the spec 205 InitPlan form: = any ((select public.auth_visible_store_ids())::uuid[]) / '
  || '= (select public.auth_profile_brand_id()), each OR (select public.auth_is_super_admin())'
);

-- ─── Arm (3): the lint can fail ──────────────────────────────────
create table public.__lint_probe_per_row_helper (id uuid primary key);
alter table public.__lint_probe_per_row_helper enable row level security;
create policy "__lint_probe_per_row_helper_select"
  on public.__lint_probe_per_row_helper
  for select
  using (public.auth_can_see_store(id));

do $$
declare
  v_hit_count int;
begin
  select count(*)::int into v_hit_count
    from pg_policies p
   where p.schemaname = 'public'
     and p.cmd in ('SELECT', 'ALL')
     and (coalesce(p.qual, '') like '%auth_can_see_store(%'
          or coalesce(p.qual, '') like '%auth_can_see_brand(%')
     and p.tablename = '__lint_probe_per_row_helper';
  perform set_config('test.per_row_helper_probe_hits', v_hit_count::text, true);
end $$;

drop policy "__lint_probe_per_row_helper_select" on public.__lint_probe_per_row_helper;
drop table public.__lint_probe_per_row_helper;

select is(
  current_setting('test.per_row_helper_probe_hits', true)::int,
  1,
  'arm (3): a throwaway SELECT policy using (public.auth_can_see_store(id)) IS caught by the lint query. '
  || 'If this fails, the detection predicate in arms (1)/(2) has regressed.'
);

select * from finish();
rollback;
