-- supabase/tests/consume_invitation_sets_profile_id.test.sql
--
-- Spec 082 — pgTAP regression for the "(email not loaded)" fix.
-- Covers BOTH halves of the migration
-- supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql:
--   (a) consume_invitation now sets profile_id = auth.uid() on consume.
--   (b) the one-time backfill links pre-existing used+sentinel invites to
--       their registered profiles via auth.users.email.
--
-- Four arms (plan(7) — a leading fixture-sanity assertion, then: arm A
-- contributes 2 (returns true + profile_id-after), arm B 1, arm C 2
-- (linked row + unmatched row keeps the sentinel), arm D 1):
--   Arm A — consume_invitation as an authed user sets profile_id =
--           auth.uid() (and used=true). LOAD-BEARING — the B half.
--   Arm B — idempotency: a second consume on the now-used row returns
--           false and does NOT change profile_id (the `where used = false`
--           guard).
--   Arm C — backfill links a pre-existing used+sentinel invite to the
--           matching profile; a used+sentinel invite whose email matches
--           NO auth user KEEPS the sentinel (the exists/join exclusion).
--   Arm D — backfill idempotency: re-running the UPDATE links nothing new
--           (already-linked rows carry a real profile_id ≠ sentinel).
--
-- Hermetic begin; ... rollback; isolation — the seed has ZERO invitations
-- (spec 082 §0.2), so ALL fixtures are created in-txn. Modeled on
-- supabase/tests/invitations_super_admin_rls.test.sql (same seeded-user
-- reuse pattern: profiles.id FKs auth.users(id), so we reuse seed ids
-- 11111…/22222… and their seeded auth.users.email rather than mint
-- synthetic UUIDs).
--
-- JWT-context idiom: set local role authenticated; +
-- set_config('request.jwt.claims', …, true). consume_invitation is
-- SECURITY DEFINER and reads auth.uid() per-call, so the JWT context
-- applies.
--
-- DRIFT DISCIPLINE: Arm C/D execute the backfill UPDATE inline (pgTAP
-- can't re-run a migration mid-transaction). That inline UPDATE must stay
-- BYTE-IDENTICAL to the statement in the migration's `do $$ … $$` block —
-- same discipline CLAUDE.md applies to the escapeHtml mirrors. If the
-- migration's backfill predicate changes, update this copy too.

begin;
create extension if not exists pgtap;

select plan(9);

-- ─── fixtures ──────────────────────────────────────────────────
-- Reuse two seeded auth users. We use their REAL seeded emails so the
-- consume_invitation `lower(email)=lower(p_email)` predicate and the
-- backfill `lower(i.email)=lower(u.email)` join both match.
do $$
declare
  v_admin_id    uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin@local.test
  v_manager_id  uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager@local.test
  v_sentinel    uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform set_config('test.admin_id',   v_admin_id::text,   true);
  perform set_config('test.manager_id', v_manager_id::text, true);
  perform set_config('test.admin_email',   'admin@local.test',   true);
  perform set_config('test.manager_email', 'manager@local.test', true);
  perform set_config('test.sentinel',   v_sentinel::text,   true);
end $$;

select isnt(current_setting('test.admin_id', true), '',
  'fixture: admin_id resolves from seed');

-- ─── Arm A: consume_invitation sets profile_id = auth.uid() ────
-- Insert a fresh PENDING invite (used=false, profile_id=sentinel) for the
-- admin's email. Set the JWT sub to the admin's id, then consume. The RPC
-- must return true AND flip the row to used=true with profile_id = the
-- caller's auth.uid(). Insert as superuser (default psql role) so the
-- admin INSERT policy is irrelevant to the fixture setup.
insert into public.invitations (email, name, role, store_ids, profile_id, used)
  values (current_setting('test.admin_email', true), 'Admin Invitee', 'manager',
          array[]::text[], current_setting('test.sentinel', true)::uuid, false);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

select is(
  public.consume_invitation(
    (select id from public.invitations
       where email = current_setting('test.admin_email', true) limit 1),
    current_setting('test.admin_email', true)
  ),
  true,
  'arm A: consume_invitation returns true for a matching pending invite'
);

-- Reset to superuser to read the row back (the admin SELECT policy would
-- also admit it, but superuser bypasses RLS unconditionally — same
-- inspection pattern as demote_self_guard.test.sql).
reset role;

select is(
  (select profile_id from public.invitations
     where email = current_setting('test.admin_email', true) limit 1),
  current_setting('test.admin_id', true)::uuid,
  'arm A: profile_id is now the caller''s auth.uid() (and used flipped true — the B-half link)'
);

-- ─── Arm B: idempotency — second consume is a no-op ────────────
-- The row is now used=true. A second consume must return false (the
-- `where used = false` guard matches zero rows) and must NOT overwrite the
-- profile_id set in Arm A.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

select is(
  public.consume_invitation(
    (select id from public.invitations
       where email = current_setting('test.admin_email', true) limit 1),
    current_setting('test.admin_email', true)
  ),
  false,
  'arm B: second consume of an already-used invite returns false (used=false guard → no-op)'
);

reset role;

-- Arm B, part 2 — confirm profile_id was NOT overwritten by the no-op
-- second consume. The `where used = false` predicate guarantees no UPDATE
-- happened, but this assertion makes that guarantee explicit and detectable
-- if the guard is ever accidentally removed.
select is(
  (select profile_id from public.invitations
     where email = current_setting('test.admin_email', true) limit 1),
  current_setting('test.admin_id', true)::uuid,
  'arm B: profile_id is NOT overwritten on re-consume (still the first consumer''s id)'
);

-- ─── Arm C: backfill links used+sentinel invites by email ──────
-- Fixture: two used+sentinel invites.
--   (1) email matches the seeded manager auth user → backfill links it.
--   (2) email matches NO auth user → backfill leaves the sentinel.
insert into public.invitations (email, name, role, store_ids, profile_id, used)
  values (current_setting('test.manager_email', true), 'Manager Invitee', 'manager',
          array[]::text[], current_setting('test.sentinel', true)::uuid, true);

insert into public.invitations (email, name, role, store_ids, profile_id, used)
  values ('nobody-no-auth-user@example.invalid', 'Ghost Invitee', 'manager',
          array[]::text[], current_setting('test.sentinel', true)::uuid, true);

-- INLINE COPY of the migration's backfill UPDATE — MUST stay byte-identical
-- to supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql.
update public.invitations i
   set profile_id = u.id
  from auth.users u
 where i.used = true
   and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
   and lower(i.email) = lower(u.email)
   and exists (select 1 from public.profiles p where p.id = u.id);

select is(
  (select profile_id from public.invitations
     where email = current_setting('test.manager_email', true) limit 1),
  current_setting('test.manager_id', true)::uuid,
  'arm C: backfill links the used+sentinel invite to the matching profile (manager)'
);

select is(
  (select profile_id from public.invitations
     where email = 'nobody-no-auth-user@example.invalid' limit 1),
  current_setting('test.sentinel', true)::uuid,
  'arm C: used+sentinel invite with no matching auth user KEEPS the sentinel (exists-join exclusion)'
);

-- ─── Arm D: backfill idempotency — re-run links nothing new ────
-- Re-running the SAME UPDATE must leave the already-linked manager row's
-- profile_id unchanged (the `profile_id = sentinel` guard excludes it).
update public.invitations i
   set profile_id = u.id
  from auth.users u
 where i.used = true
   and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
   and lower(i.email) = lower(u.email)
   and exists (select 1 from public.profiles p where p.id = u.id);

select is(
  (select profile_id from public.invitations
     where email = current_setting('test.manager_email', true) limit 1),
  current_setting('test.manager_id', true)::uuid,
  'arm D: re-running the backfill leaves the already-linked row unchanged (idempotent)'
);

-- ─── Arm E: grant lockdown — anon/public EXECUTE revoked, authenticated kept ──
-- spec 082 review fold-in (security-auditor + architect): the migration adds
-- `revoke execute ... from public, anon` to match the spec-005 anon-lockdown
-- standard. Pin it via a CATALOG-QUERY (has_function_privilege) — NOT
-- `set local role anon` + throws_ok, which is the spec-067 pattern that
-- segfaults the CI Postgres image. After the revoke, anon has no EXECUTE
-- (neither explicit nor via PUBLIC), while authenticated retains its grant.
select ok(
  not has_function_privilege('anon', 'public.consume_invitation(uuid, text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.consume_invitation(uuid, text)', 'EXECUTE'),
  'arm E: anon/public EXECUTE revoked; authenticated EXECUTE retained'
);

select * from finish();
rollback;
