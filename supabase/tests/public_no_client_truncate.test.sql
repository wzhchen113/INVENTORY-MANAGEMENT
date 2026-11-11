-- supabase/tests/public_no_client_truncate.test.sql
--
-- Spec 197 - regression guard: no client role may TRUNCATE anything in
-- `public`, now or on relations created later. Pins the posture set by
-- supabase/migrations/20261109230000_revoke_client_truncate.sql.
--
-- WHY THIS EXISTS
-- ---------------
-- Spec 097 (20260618000000_public_grants_explicit.sql) granted an explicit
-- no-TRUNCATE list, but GRANT only adds: the image's existing `arwdDxtm`
-- table grants and the `(postgres, public, 'r')` default-ACL entry already
-- held `D`, so anon and authenticated kept TRUNCATE on most public tables
-- (all but the few with an explicit revoke). No client path uses TRUNCATE;
-- the risk is a FUTURE
-- SECURITY INVOKER function that runs dynamic SQL as the caller. TRUNCATE
-- bypasses RLS and row triggers, so the privilege is the only control.
--
-- Cross-reference: spec 097's positive grant posture (SELECT everywhere,
-- profiles/audit-table locks) lives in public_grants_explicit.test.sql. This
-- file owns the schema-wide NEGATIVE TRUNCATE invariant and the default-ACL
-- check. The overlap with that file's arm 5 (profiles TRUNCATE) is intended.
--
-- "Client roles" = anon, authenticated, PUBLIC (grantee oid 0).
-- Relkind set (arms 1-3) = ('r','p','f'): the kinds TRUNCATE can act on
-- (tables incl. partitions, partitioned tables, foreign tables via PG14+ FDW
-- truncate). It MUST match the migration's DO block (a) literally (spec 197
-- D-11). Views/matviews are excluded: TRUNCATE on them fails with "is not a
-- table" whatever the ACL says, and pgTAP's own supabase_admin-owned views
-- (tap_funky, pg_all_foreign_keys, created by `create extension` below)
-- carry an inert client D. Privileged-role arms (6a/6b) use ('r','p') only.
--
-- TWO DETECTION ARMS, DIFFERENT JOBS
--   effective  has_table_privilege(<role>, c.oid, 'TRUNCATE') for anon and
--              authenticated. The security question: includes direct, PUBLIC
--              and inherited-through-membership grants.
--   direct     aclexplode(c.relacl), privilege_type = 'TRUNCATE', grantee in
--              (0, anon, authenticated). The remediation question: where the
--              grant lives. The only arm that names PUBLIC as PUBLIC.
--
-- NO ALLOWLIST. There is no legitimate client-TRUNCATE exception. If one is
-- ever needed it gets a role-keyed VALUES allowlist (097 shape) in the same PR.
--
-- supabase_admin's default ACL in public still carries `D` for clients. That
-- is an accepted leftover (prod's postgres cannot change it); arms 1-3 are the
-- backstop if such a relation ever appears. Arm 4 deliberately ignores it.
--
-- Plan (17 assertions):
--   (1)   effective client TRUNCATE pairs = 0
--   (2)   direct client TRUNCATE ACL entries = 0
--   (3)   string_agg of offending `public.<rel> / <role|PUBLIC>` = ''
--   (4)   postgres default ACL (public or global) grants no client TRUNCATE
--   (5)   postgres/public default ACL still grants anon+authenticated the six
--         spec 097 privileges (arwdxt; `m` deliberately not pinned)
--   (6a)  service_role keeps TRUNCATE on every public table
--   (6b)  postgres keeps TRUNCATE on every public table
--   (7)   inventory_items: anon keeps SELECT; authenticated keeps
--         SELECT/INSERT/UPDATE/DELETE (the revoke removed only TRUNCATE)
--   (8a)  a new postgres-owned table is born without client TRUNCATE
--   (8b)  ... with service_role TRUNCATE
--   (8c)  ... and SELECT for anon, authenticated, service_role
--   (9a)  self-test: explicit grant to authenticated -> effective count 1
--   (9b)  ... direct count 1
--   (10a) self-test: grant to PUBLIC -> effective count 2 (both roles via PUBLIC)
--   (10b) ... direct count 1 (the grantee-0 entry)
--   (11a) self-test: per-schema default grant to authenticated -> arm 4 = 1
--   (11b) self-test: GLOBAL default grant to authenticated -> arm 4 = 1
--
-- ORDER MATTERS: arms 1-7 read the untouched catalog; arm 8 runs before
-- 11a/11b so the born table sees the clean default ACL; 11a reverts before 11b.
--
-- ROLE: runs as postgres (scripts/test-db.sh). No `set role` (spec 067
-- segfault precedent); has_table_privilege reads the catalog for any role.
--
-- HERMETIC: begin; ... rollback;. Self-tests mutate, stash the count with
-- set_config(..., true), drop/revert, THEN assert (drop-then-assert, spec 053 /
-- 097). No savepoint + rollback to savepoint: that would discard assertions
-- from pgTAP's counters and trip test-db.sh's "planned N but ran M" detector.
--
-- GOTCHA: has_table_privilege(role, t, 'A,B') is true if ANY listed privilege
-- is held, so multi-privilege checks AND separate single-privilege calls.

begin;
create extension if not exists pgtap;

select plan(17);


-- ─── Arm (1): effective client TRUNCATE pairs = 0 ──────────────
select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) v(rolename)
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'f')
      and has_table_privilege(v.rolename, c.oid, 'TRUNCATE')
  ),
  0,
  'arm (1): public_no_client_truncate - no public relation lets anon or authenticated TRUNCATE (effective privilege, incl. PUBLIC and role membership). ' ||
  'If this fails, a table regained client TRUNCATE: most likely a `grant all on <t> to anon/authenticated` or a relation created by a role whose default ACL still carries D (supabase_admin). ' ||
  'Fix: `revoke truncate on <t> from anon, authenticated, public;` or replace `grant all` with the spec 097 explicit list (select,insert,update,delete,references,trigger). ' ||
  'See arm (3) for the exact pairs, arm (2) for where the grant lives. Spec 197 / 20261109230000_revoke_client_truncate.sql.'
);


-- ─── Arm (2): direct client TRUNCATE ACL entries = 0 ───────────
select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'f')
      and a.privilege_type = 'TRUNCATE'
      and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
  ),
  0,
  'arm (2): public_no_client_truncate - no public relation ACL holds a TRUNCATE entry for anon, authenticated or PUBLIC. ' ||
  'If this fails, revoke the stored entry: `revoke truncate on <t> from anon, authenticated, public;` (PUBLIC entries need `from public`). ' ||
  'Arm (3) names each entry, PUBLIC labelled as PUBLIC. Spec 197 / 20261109230000_revoke_client_truncate.sql.'
);


-- ─── Arm (3): readable list of offending pairs = '' ────────────
-- DISTINCT union of arms 1 and 2. Effective and direct hits for anon /
-- authenticated share a label, so they dedupe; PUBLIC only comes from the
-- direct arm.
select is(
  (
    with effective as (
      select n.nspname, c.relname, v.rolename as label
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) v(rolename)
      where n.nspname = 'public'
        and c.relkind in ('r', 'p', 'f')
        and has_table_privilege(v.rolename, c.oid, 'TRUNCATE')
    ),
    direct as (
      select n.nspname, c.relname,
             case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as label
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      where n.nspname = 'public'
        and c.relkind in ('r', 'p', 'f')
        and a.privilege_type = 'TRUNCATE'
        and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
    ),
    offenders as (
      select nspname, relname, label from effective
      union
      select nspname, relname, label from direct
    )
    select coalesce(
      string_agg(format('%s.%s / %s', nspname, relname, label), ', ' order by nspname, relname, label),
      ''
    )
    from offenders
  ),
  '',
  'arm (3): public_no_client_truncate - offending (public.<rel> / <anon|authenticated|PUBLIC>) list is empty. ' ||
  'If this fails the TAP output above lists each pair. Revoke TRUNCATE on each from the named grantee. See arm (1) remediation. Spec 197.'
);


-- ─── Arm (4): postgres default ACL grants no client TRUNCATE ───
-- Counts (default-ACL row, grantee) entries for role postgres, object type
-- tables, in schema public OR global (defaclnamespace = 0; the global row is a
-- tripwire: a schema-scoped revoke cannot undo it). supabase_admin is
-- deliberately excluded (accepted leftover, spec 197 Residual risk).
select is(
  (
    select count(*)::int
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole = 'postgres'::regrole::oid
      and d.defaclobjtype = 'r'
      and d.defaclnamespace in ('public'::regnamespace::oid, 0::oid)
      and a.privilege_type = 'TRUNCATE'
      and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
  ),
  0,
  'arm (4): public_no_client_truncate - the postgres default ACL for tables (schema public and global) grants TRUNCATE to no client role, so new tables are born without it. ' ||
  'If this fails: `alter default privileges for role postgres in schema public revoke truncate on tables from anon, authenticated, public;` ' ||
  'and, for a global entry, the same statement WITHOUT `in schema public`. Spec 197 / 20261109230000_revoke_client_truncate.sql.'
);


-- ─── Arm (5): postgres/public default ACL keeps spec 097's list ─
-- Missing (role, privilege) pairs over {anon, authenticated} x the six
-- privileges spec 097 grants. A missing entry row yields 12, so this also
-- proves the entry still exists. MAINTAIN (`m`) is image-owned and not pinned.
select is(
  (
    select count(*)::int
    from (values ('anon'), ('authenticated')) r(rolename)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('REFERENCES'), ('TRIGGER')) p(privname)
    where not exists (
      select 1
      from pg_default_acl d
      cross join lateral aclexplode(d.defaclacl) a
      where d.defaclrole = 'postgres'::regrole::oid
        and d.defaclobjtype = 'r'
        and d.defaclnamespace = 'public'::regnamespace::oid
        and a.grantee = r.rolename::regrole::oid
        and a.privilege_type = p.privname
    )
  ),
  0,
  'arm (5): public_no_client_truncate - the postgres/public table default ACL still grants anon and authenticated SELECT, INSERT, UPDATE, DELETE, REFERENCES and TRIGGER (only D removed). ' ||
  'If this fails, the spec 197 revoke (or a later edit) removed more than TRUNCATE, or the entry is gone. Restore with the spec 097 ' ||
  '`alter default privileges for role postgres in schema public grant select, insert, update, delete, references, trigger on tables to anon, authenticated;`.'
);


-- ─── Arm (6a): service_role keeps TRUNCATE ─────────────────────
select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not has_table_privilege('service_role', c.oid, 'TRUNCATE')
  ),
  0,
  'arm (6a): public_no_client_truncate - service_role keeps TRUNCATE on every public table (separate trusted grant audience, spec 041 / 097). ' ||
  'If this fails, a revoke reached service_role; spec 197 must only touch anon, authenticated and PUBLIC.'
);


-- ─── Arm (6b): postgres keeps TRUNCATE ─────────────────────────
select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not has_table_privilege('postgres', c.oid, 'TRUNCATE')
  ),
  0,
  'arm (6b): public_no_client_truncate - postgres keeps TRUNCATE on every public table (owner). ' ||
  'If this fails, a table is owned by another role or a revoke reached postgres. Spec 197.'
);


-- ─── Arm (7): the revoke removed only TRUNCATE (sample table) ──
-- Live-table complement to arm (5), which pins the default ACL. Asserts only
-- what the app needs on public.inventory_items: anon keeps SELECT, and
-- authenticated keeps SELECT/INSERT/UPDATE/DELETE (the admin Cmd UI writes it).
-- anon INSERT/UPDATE/DELETE are deliberately NOT asserted: they are business
-- policy, and a later spec may tighten them without touching TRUNCATE.
-- Separate single-privilege calls (see GOTCHA in header).
select ok(
  has_table_privilege('anon', 'public.inventory_items', 'SELECT')
  and has_table_privilege('authenticated', 'public.inventory_items', 'SELECT')
  and has_table_privilege('authenticated', 'public.inventory_items', 'INSERT')
  and has_table_privilege('authenticated', 'public.inventory_items', 'UPDATE')
  and has_table_privilege('authenticated', 'public.inventory_items', 'DELETE'),
  'arm (7): public_no_client_truncate - on public.inventory_items, anon still holds SELECT and authenticated still holds SELECT, INSERT, UPDATE and DELETE. ' ||
  'If this fails, check first whether a later spec intentionally tightened grants on this table; if so, pick another sample table. ' ||
  'Otherwise a revoke removed more than TRUNCATE (compare arm 5 and spec 097). Spec 197.'
);


-- ─── Arm (8): a new postgres-owned table is born clean ─────────
-- Born under the fixed (postgres, public, 'r') default ACL. Must run before
-- arms 11a/11b, which mutate that ACL.
create table public.__truncate_probe_born (id uuid primary key);

do $$
declare
  v_client int;
  v_svc    int;
  v_select int;
begin
  select
    (select count(*)::int
       from (values ('anon'), ('authenticated')) v(rolename)
      where has_table_privilege(v.rolename, 'public.__truncate_probe_born'::regclass, 'TRUNCATE'))
    +
    (select count(*)::int
       from pg_class c
       cross join lateral aclexplode(c.relacl) a
      where c.oid = 'public.__truncate_probe_born'::regclass
        and a.privilege_type = 'TRUNCATE'
        and a.grantee = 0::oid)
    into v_client;

  select case when has_table_privilege('service_role', 'public.__truncate_probe_born'::regclass, 'TRUNCATE') then 1 else 0 end
    into v_svc;

  select count(*)::int into v_select
    from (values ('anon'), ('authenticated'), ('service_role')) v(rolename)
   where has_table_privilege(v.rolename, 'public.__truncate_probe_born'::regclass, 'SELECT');

  perform set_config('test.t197_born_client', v_client::text, true);
  perform set_config('test.t197_born_svc', v_svc::text, true);
  perform set_config('test.t197_born_select', v_select::text, true);
end $$;

drop table public.__truncate_probe_born;

select is(
  current_setting('test.t197_born_client', true)::int,
  0,
  'arm (8a): public_no_client_truncate - a new postgres-owned public table is born WITHOUT TRUNCATE for anon, authenticated or PUBLIC. ' ||
  'If this fails, the (postgres, public, tables) default ACL still carries D for a client role: see arm (4). Spec 197.'
);
select is(
  current_setting('test.t197_born_svc', true)::int,
  1,
  'arm (8b): public_no_client_truncate - a new postgres-owned public table is born WITH TRUNCATE for service_role. ' ||
  'If this fails, the default-ACL revoke reached service_role. Spec 197.'
);
select is(
  current_setting('test.t197_born_select', true)::int,
  3,
  'arm (8c): public_no_client_truncate - a new postgres-owned public table is born with SELECT for anon, authenticated and service_role (spec 097 default grant still applies). ' ||
  'If this fails, the default ACL lost more than TRUNCATE: see arm (5) and spec 097.'
);


-- ─── Arm (9): self-test, explicit grant to authenticated ───────
create table public.__truncate_probe_direct (id uuid primary key);
grant truncate on public.__truncate_probe_direct to authenticated;

do $$
declare
  v_eff int;
  v_dir int;
begin
  select count(*)::int into v_eff
    from (values ('anon'), ('authenticated')) v(rolename)
   where has_table_privilege(v.rolename, 'public.__truncate_probe_direct'::regclass, 'TRUNCATE');

  select count(*)::int into v_dir
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
   where c.oid = 'public.__truncate_probe_direct'::regclass
     and a.privilege_type = 'TRUNCATE'
     and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid);

  perform set_config('test.t197_direct_eff', v_eff::text, true);
  perform set_config('test.t197_direct_dir', v_dir::text, true);
end $$;

drop table public.__truncate_probe_direct;

select is(
  current_setting('test.t197_direct_eff', true)::int,
  1,
  'arm (9a): public_no_client_truncate - the effective detector flags a throwaway table granted TRUNCATE to authenticated (exactly 1: authenticated only). ' ||
  'If this fails, the has_table_privilege detector of arm (1) regressed, or the table was born with client TRUNCATE (see arm 8a). Spec 197.'
);
select is(
  current_setting('test.t197_direct_dir', true)::int,
  1,
  'arm (9b): public_no_client_truncate - the direct detector flags the same table (exactly 1 ACL entry: authenticated). ' ||
  'If this fails, the aclexplode detector of arm (2) regressed. Spec 197.'
);


-- ─── Arm (10): self-test, grant to PUBLIC ──────────────────────
-- Every role is a member of PUBLIC, so the effective detector reports both
-- anon and authenticated (2); the direct detector reports the single
-- grantee-0 entry (1).
create table public.__truncate_probe_public (id uuid primary key);
grant truncate on public.__truncate_probe_public to public;

do $$
declare
  v_eff int;
  v_dir int;
begin
  select count(*)::int into v_eff
    from (values ('anon'), ('authenticated')) v(rolename)
   where has_table_privilege(v.rolename, 'public.__truncate_probe_public'::regclass, 'TRUNCATE');

  select count(*)::int into v_dir
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
   where c.oid = 'public.__truncate_probe_public'::regclass
     and a.privilege_type = 'TRUNCATE'
     and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid);

  perform set_config('test.t197_public_eff', v_eff::text, true);
  perform set_config('test.t197_public_dir', v_dir::text, true);
end $$;

drop table public.__truncate_probe_public;

select is(
  current_setting('test.t197_public_eff', true)::int,
  2,
  'arm (10a): public_no_client_truncate - a TRUNCATE grant to PUBLIC makes both anon and authenticated effective (exactly 2, via PUBLIC membership). ' ||
  'If this fails, the effective detector of arm (1) regressed. Spec 197.'
);
select is(
  current_setting('test.t197_public_dir', true)::int,
  1,
  'arm (10b): public_no_client_truncate - the direct detector flags the PUBLIC grant as exactly 1 grantee-0 entry. ' ||
  'If this fails, the aclexplode detector of arm (2) no longer catches PUBLIC (grantee 0), or the table was born with client TRUNCATE. Spec 197.'
);


-- ─── Arm (11a): self-test, per-schema default ACL regains D ────
-- The detector in the DO block below must stay IDENTICAL to arm (4)'s query
-- (and to the migration's DO block (b)); change all of them together.
alter default privileges for role postgres in schema public
  grant truncate on tables to authenticated;

do $$
declare
  v_n int;
begin
  select count(*)::int into v_n
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) a
   where d.defaclrole = 'postgres'::regrole::oid
     and d.defaclobjtype = 'r'
     and d.defaclnamespace in ('public'::regnamespace::oid, 0::oid)
     and a.privilege_type = 'TRUNCATE'
     and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid);

  perform set_config('test.t197_defacl_schema', v_n::text, true);
end $$;

alter default privileges for role postgres in schema public
  revoke truncate on tables from authenticated;

select is(
  current_setting('test.t197_defacl_schema', true)::int,
  1,
  'arm (11a): public_no_client_truncate - the arm (4) default-ACL detector flags a per-schema `grant truncate on tables to authenticated` (exactly 1 entry). ' ||
  'If this fails, the arm (4) detector regressed, or the default ACL already carried client D before this arm. Spec 197.'
);


-- ─── Arm (11b): self-test, GLOBAL default ACL tripwire ─────────
-- The detector in the DO block below must stay IDENTICAL to arm (4)'s query
-- (and to the migration's DO block (b)); change all of them together.
-- No `in schema` creates a defaclnamespace = 0 row. The revoke returns it to
-- the built-in default, so Postgres deletes the row.
alter default privileges for role postgres
  grant truncate on tables to authenticated;

do $$
declare
  v_n int;
begin
  select count(*)::int into v_n
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) a
   where d.defaclrole = 'postgres'::regrole::oid
     and d.defaclobjtype = 'r'
     and d.defaclnamespace in ('public'::regnamespace::oid, 0::oid)
     and a.privilege_type = 'TRUNCATE'
     and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid);

  perform set_config('test.t197_defacl_global', v_n::text, true);
end $$;

alter default privileges for role postgres
  revoke truncate on tables from authenticated;

select is(
  current_setting('test.t197_defacl_global', true)::int,
  1,
  'arm (11b): public_no_client_truncate - the arm (4) detector flags a GLOBAL (defaclnamespace = 0) `grant truncate on tables to authenticated` (exactly 1 entry). ' ||
  'If this fails, the global tripwire in arm (4) regressed, or the schema default ACL still carries client D. Spec 197.'
);


select * from finish();
rollback;
