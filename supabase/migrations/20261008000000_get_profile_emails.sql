-- ============================================================
-- Spec 163 - real login emails for the admin Users & Brands screens.
--
-- public.get_profile_emails(p_user_ids uuid[]) returns (user_id, email) from
-- auth.users for the requested profile ids, limited to the profiles the caller
-- may see. The client cannot read auth.users, so before this the Users screen
-- (fetchAllUsers) and the Brands members tab (fetchBrandAdmins) guessed emails
-- from `invitations` rows - any account created without an invitation rendered
-- "(email not loaded)".
--
-- PII: this exposes auth.users.email through a SECURITY DEFINER function. RLS
-- does NOT filter definer reads of public.profiles, and auth.users has no
-- client-facing RLS, so the WHERE clause in the body is the ONLY gate.
-- auth.uid() / auth.jwt() still resolve to the CALLER inside a definer function
-- (they read the request.jwt.claims GUC, not current_user).
--
-- LOCKSTEP (R1): visibility MUST equal the privileged arm of the spec-043
-- profiles SELECT policy "Admins can read all profiles"
-- (20260517060000_profiles_rls_sweep.sql):
--     public.auth_is_privileged() and public.auth_can_see_brand(brand_id)
-- The self-arm (`or id = auth.uid()`) is DELIBERATELY omitted: non-privileged
-- callers get 0 rows, their own row included. Change both together.
--
-- p_user_ids is narrow-only: it ANDs into the predicate and can never widen
-- the result. NULL or '{}' returns 0 rows (fail-closed; no "return all" mode).
--
-- REALTIME: no publication change. auth.users is not (and must not be) in
-- supabase_realtime.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): execute_sql this body via the
-- Supabase MCP, INSERT the exact version '20261008000000' into
-- supabase_migrations.schema_migrations, then VERIFY the function by
-- NORMALIZED-MD5 and confirm has_function_privilege('anon', ...) = false.
--
-- Design authority: specs/163-admin-user-emails.md "## Backend design".
-- ============================================================

begin;

-- language sql (not plpgsql): with RETURNS TABLE (user_id, email), plpgsql
-- would turn the output columns into variables that collide with unqualified
-- column references. Matches the auth_* helper shape
-- (20260509000000_multi_brand_schema_rls.sql).
create or replace function public.get_profile_emails(p_user_ids uuid[])
returns table (user_id uuid, email text)
language sql stable security definer set search_path = public, auth as $$
  select p.id, u.email::text
    from public.profiles p
    join auth.users      u on u.id = p.id          -- inner join: orphan auth users never appear
   where p.id = any(p_user_ids)                     -- narrow-only; NULL/empty array -> 0 rows
     and public.auth_is_privileged()                -- verbatim spec-043 privileged arm ...
     and public.auth_can_see_brand(p.brand_id)      -- ... (super_admin short-circuits inside)
     and coalesce(u.email, '') <> '';               -- phone-only / blank auth users emit no row
$$;

comment on function public.get_profile_emails(uuid[]) is
  'spec 163: auth.users emails for the requested profile ids, limited to profiles '
  'the caller may see. Visibility MUST equal the privileged arm of the profiles '
  'SELECT policy "Admins can read all profiles" (auth_is_privileged() and '
  'auth_can_see_brand(brand_id)); change both together. Self-arm deliberately '
  'omitted: non-privileged callers get 0 rows. p_user_ids only narrows; NULL or '
  'empty returns 0 rows.';

-- REVOKE FROM `public` IS LOAD-BEARING: CREATE FUNCTION grants EXECUTE to
-- PUBLIC (anon inherits it), and spec 097's ALTER DEFAULT PRIVILEGES
-- (20260618000000_public_grants_explicit.sql) gives anon an EXPLICIT grant on
-- new public functions - so both `public` and `anon` must be revoked. Same
-- idiom as spec 162 (20260829000000_auto_place_order_attempts.sql).
-- service_role keeps its default-privilege grant; harmless - it has no
-- auth.uid(), so auth_is_privileged() is false and it gets 0 rows.
revoke all     on function public.get_profile_emails(uuid[]) from public, anon;
grant  execute on function public.get_profile_emails(uuid[]) to authenticated;

commit;
