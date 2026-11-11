-- ============================================================
-- Spec 195 - remove own-row writes on public.user_stores (closes 164-H1 and the
-- cross-brand step of 187-H2).
--
-- Policy diff on public.user_stores (all PERMISSIVE, role public):
--   "Users can read own store links"    SELECT, using (user_id = auth.uid())
--                                       -> kept, predicate unchanged, comment added
--   "Users can manage own store links"  ALL, using/check (user_id = auth.uid())
--                                       -> DROPPED
--   "Admins can manage all store links" ALL, auth_is_privileged() AND EXISTS
--                                       (store s ... auth_can_see_brand(s.brand_id))
--                                       -> untouched (keeps its spec 051 comment)
--
-- After this migration the only RLS write path is the brand-scoped admin arm.
-- register_invited_profile() (SECURITY DEFINER, owner postgres, which bypasses
-- RLS on user_stores) and the service-role edge functions (manage-store-user,
-- delete-user) do not go through RLS and are unaffected. Nothing in this repo
-- writes user_stores as the owning user.
--
-- Reads do not change: the dropped ALL policy had the same USING as the read
-- policy, so (read OR own-row-ALL OR admin) = (read OR admin).
--
-- Trigger-before-RLS (spec D-0): user_stores_brand_match_trg is BEFORE ROW, so it
-- runs before the RLS WITH CHECK on INSERT. A NULL-brand caller who still holds a
-- link in another brand gets P0001 from the trigger, not 42501. The policy drop is
-- what refuses a first link, a same-brand link, and the unlink-then-relink route.
-- The trigger and user_stores_brand_match() are NOT changed here.
--
-- Fail-closed: the DO block after the drop checks the post-state in pg_policies
-- and raises with a '195:' prefix on any mismatch, including a missing read
-- policy. It runs in the same transaction as the drop, so a raise rolls the drop
-- back and nothing changes. The read-policy comment is set only after the check
-- passes, so it cannot pre-empt the '195:' message.
--
-- No grant change: authenticated keeps INSERT/UPDATE/DELETE on user_stores, which
-- the admin arm needs. A refusal is the RLS message ('new row violates row-level
-- security policy for table "user_stores"'), not 'permission denied'.
--
-- No publication change (user_stores is not in supabase_realtime), so NO
-- `docker restart supabase_realtime_imr-inventory` step.
-- No PostgREST schema reload needed: RLS is evaluated per query.
--
-- PROD-APPLY: owner go-ahead required. Re-run P-1..P-7 from
-- specs/195-user-stores-own-row-writes.md first; stop unless P-1's admin
-- md5(qual) and md5(with_check) both equal b05a4d4429e322a9cf194d6072b5f6d3.
-- Apply this exact body with execute_sql BEFORE pushing, then record the version
-- so the db-migrations-applied.yml drift gate sees it:
--   insert into supabase_migrations.schema_migrations (version, name)
--   values ('20261109195000', 'user_stores_drop_own_row_writes');
-- Re-run P-1: exactly two policies, admin qual/with_check byte-equal to the T3
-- literal in supabase/tests/user_stores_own_row_writes.test.sql.
--
-- ROLLBACK (emergency only; re-opens 164-H1 and the 187-H2 cross-brand step):
--   create policy "Users can manage own store links" on public.user_stores
--     as permissive for all to public
--     using (user_id = auth.uid()) with check (user_id = auth.uid());
--   comment on policy "Users can manage own store links" on public.user_stores is
--     'spec 051: own-row self-management. Drops the legacy OR-arm `auth.uid() IS NOT NULL` that admitted any authed caller to manage any other user''s grants.';
--   comment on policy "Users can read own store links" on public.user_stores is null;
-- Leave the schema_migrations row in place, then land a forward migration that
-- re-creates the policy. In the same PR revert arm (9) of
-- legacy_permissive_policy_dropout.test.sql AND retire or invert
-- supabase/tests/user_stores_own_row_writes.test.sql (most of its arms go red
-- once the own-row policy exists). No down-migration ships.
--
-- Tests: supabase/tests/user_stores_own_row_writes.test.sql,
--        supabase/tests/legacy_permissive_policy_dropout.test.sql (arm 9)
-- ============================================================

begin;

-- DROP POLICY takes an AccessExclusiveLock on user_stores, which every
-- store-scoped RLS check reads through auth_can_see_store(). Fail fast rather
-- than queue reads behind a long transaction. A timeout changes nothing; retry.
set local lock_timeout = '5s';

drop policy if exists "Users can manage own store links" on public.user_stores;

-- --- Fail-closed post-state check (AC-2) -----------------------------------
do $$
declare
  v_n         int;
  v_names     text;
  v_read_qual text;
  v_adm_qual  text;
  v_adm_check text;
begin
  -- W: exactly one permissive write policy, and it is the admin arm.
  select count(*), coalesce(string_agg(policyname, ', ' order by policyname), '')
    into v_n, v_names
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'user_stores'
     and permissive = 'PERMISSIVE'
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');

  if v_n <> 1 or v_names <> 'Admins can manage all store links' then
    raise exception
      '195: expected exactly one permissive write policy on public.user_stores (Admins can manage all store links), found % (%)',
      v_n, v_names;
  end if;

  -- R: exactly one permissive SELECT policy, the own-row read, predicate intact.
  select count(*), coalesce(string_agg(policyname, ', ' order by policyname), ''),
         max(qual)
    into v_n, v_names, v_read_qual
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'user_stores'
     and permissive = 'PERMISSIVE'
     and cmd = 'SELECT';

  if v_n <> 1
     or v_names <> 'Users can read own store links'
     or v_read_qual is distinct from '(user_id = auth.uid())' then
    raise exception
      '195: expected exactly one permissive SELECT policy on public.user_stores (Users can read own store links, qual (user_id = auth.uid())), found % (%) qual %',
      v_n, v_names, coalesce(v_read_qual, '<null>');
  end if;

  -- A: the admin arm, now the only RLS write path, is still brand-scoped.
  select qual, with_check
    into v_adm_qual, v_adm_check
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'user_stores'
     and policyname = 'Admins can manage all store links';

  if v_adm_qual is null
     or v_adm_check is null
     or position('auth_can_see_brand' in v_adm_qual) = 0
     or position('auth_can_see_brand' in v_adm_check) = 0 then
    raise exception
      '195: "Admins can manage all store links" on public.user_stores is not brand-scoped (qual %, with_check %)',
      coalesce(v_adm_qual, '<null>'), coalesce(v_adm_check, '<null>');
  end if;
end $$;

-- Set after the check, so a missing read policy raises the '195:' R message
-- above instead of failing here.
comment on policy "Users can read own store links" on public.user_stores is
  'spec 195: own-row READ only; no own-row write policy by design.';

commit;
