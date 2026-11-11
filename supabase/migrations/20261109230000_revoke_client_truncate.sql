-- ============================================================
-- Spec 197 - revoke TRUNCATE from client roles (anon, authenticated, PUBLIC)
-- on every relation in public, now and for relations created later.
--
-- Why spec 097 left `D` in place: 20260618000000_public_grants_explicit.sql
-- granted an explicit no-TRUNCATE list (select, insert, update, delete,
-- references, trigger), but GRANT only adds. The image's existing
-- `arwdDxtm` table grants and the existing (postgres, public, tables)
-- default-ACL entry (`anon=arwdDxtm`, `authenticated=arwdDxtm`) already held
-- `D`, so they stayed. That migration's "closed by construction" comments
-- (lines 62, 75, 185) were wrong until this migration; it cannot be edited,
-- so the correction is recorded here and in specs/197-revoke-client-truncate.md.
--
-- No client path uses TRUNCATE (PostgREST, Realtime and pg_graphql expose no
-- TRUNCATE verb). The risk is a future SECURITY INVOKER function running
-- dynamic SQL as the caller. TRUNCATE bypasses RLS and row triggers, so the
-- privilege is the only control.
--
-- What changes:
--   1. revoke TRUNCATE on all tables in schema public (tables, partitioned
--      tables, views, materialized views, foreign tables) from anon,
--      authenticated, PUBLIC.
--   2. the (postgres, public, tables) default ACL loses `D` for anon and
--      authenticated: arwdDxtm -> arwdxtm. The entry stays (still non-empty).
--
-- What does NOT change:
--   - service_role and postgres keep TRUNCATE (spec 041 / 097 position:
--     service_role is a separate trusted grant audience; the owner always has it).
--   - supabase_admin's default ACL for public still carries `D` for clients.
--     Accepted leftover: prod's postgres is not a superuser and not a member of
--     supabase_admin, so a migration cannot change it.
--   - MAINTAIN (`m`) is deliberately out of scope (candidate follow-up spec).
--   - No global (defaclnamespace = 0) postgres table entry exists locally or on
--     prod; the DO block below fails closed if one carries client TRUNCATE.
--
-- Idempotent: both statements are no-ops on an already-migrated DB, and the DO
-- block passes on a clean state.
--
-- Fail-closed: the DO block re-reads the catalog and raises with a '197:'
-- prefix if any direct client TRUNCATE entry remains (e.g. a relation not owned
-- by postgres, where postgres's REVOKE only warns) or if the postgres default
-- ACL still grants it. The raise rolls back the whole transaction, including a
-- schema_migrations insert placed before the final commit.
-- Check (a) covers only the kinds TRUNCATE can act on: relkind r (tables and
-- partitions), p (partitioned) and f (foreign; PG14+ FDW truncate). That set
-- must match probe arms 1-3 literally (spec 197 D-11). Views and matviews are
-- not checked: TRUNCATE on them fails with "is not a table" whatever the ACL
-- says, and pgTAP's supabase_admin-owned views (tap_funky, pg_all_foreign_keys)
-- carry an inert client D a postgres migration cannot revoke. The revoke above
-- still covers every kind `ON ALL TABLES` reaches, views included.
--
-- No publication change, so NO `docker restart supabase_realtime_imr-inventory`
-- step. No PostgREST reload needed.
--
-- PROD-APPLY (spec 064 drift gate): owner go-ahead required. Run the
-- P0 pre-checks in specs/197-revoke-client-truncate.md D-7 first (save the P0.5
-- rollback statements). execute_sql this exact body via the Supabase MCP BEFORE
-- pushing, with this line added just before the final commit:
--   insert into supabase_migrations.schema_migrations (version, name)
--   values ('20261109230000', 'revoke_client_truncate');
-- Do NOT use MCP apply_migration (it writes its own version).
--
-- ROLLBACK: forward-only. Re-grant per (table, grantee) from the saved P0.5
-- output, never `on all tables` (re-opens spec 041's profiles escalation), then
--   alter default privileges for role postgres in schema public
--     grant truncate on tables to anon, authenticated;
-- and remove/flip supabase/tests/public_no_client_truncate.test.sql in the same
-- change. See spec 197 D-8.
--
-- Tests: supabase/tests/public_no_client_truncate.test.sql
-- ============================================================

begin;

revoke truncate on all tables in schema public from anon, authenticated, public;

alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated, public;

-- --- Fail-closed post-state check ------------------------------------------
do $$
declare
  v_n    int;
  v_list text;
begin
  -- (a) direct ACL entries: client TRUNCATE on any public relation.
  select count(*),
         coalesce(string_agg(
           format('%s / %s', c.oid::regclass,
                  case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end),
           ', ' order by c.oid::regclass::text, a.grantee), '')
    into v_n, v_list
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'f')
     and a.privilege_type = 'TRUNCATE'
     and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid);

  if v_n > 0 then
    raise exception '197: client TRUNCATE still granted on %', v_list;
  end if;

  -- (b) postgres default ACL for tables, schema public or global.
  --     Keep this query IDENTICAL to probe arm (4) (and the arm 11a/11b
  --     detectors) in supabase/tests/public_no_client_truncate.test.sql.
  select count(*)
    into v_n
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) a
   where d.defaclrole = 'postgres'::regrole::oid
     and d.defaclobjtype = 'r'
     and d.defaclnamespace in ('public'::regnamespace::oid, 0::oid)
     and a.privilege_type = 'TRUNCATE'
     and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid);

  if v_n > 0 then
    raise exception '197: postgres default ACL still grants TRUNCATE to a client role';
  end if;
end $$;

commit;
