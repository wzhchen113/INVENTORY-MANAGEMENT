-- ============================================================
-- Spec 095 — username login.
--
-- Adds a global, case-insensitive username identity to profiles so users can
-- sign in with EITHER username OR email. Supabase has no native username auth,
-- so the username→email mapping is resolved server-side (the username-resolve
-- edge function reads this column via the service-role client); this migration
-- only owns the data model + a one-time deterministic backfill.
--
-- THREE PARTS (all additive — no destructive drops):
--   1. profiles.username column (nullable text), format CHECK, and a
--      case-insensitive UNIQUE index on lower(username).
--   2. invitations.username carrier column (nullable, format CHECK, NO
--      uniqueness — uniqueness is enforced on profiles at register time) so the
--      admin invite flow can thread an assigned username through to
--      registerInvitedUser. get_pending_invitation is redefined to return it,
--      carrying forward the spec-069 resolved_brand_id shape verbatim.
--   3. A one-time, deterministic, collision-safe BACKFILL (idempotent DO block,
--      `WHERE username IS NULL` guard) assigning a username to every existing
--      profile from its auth.users email local-part. Post-assertion: 0 NULLs.
--
-- DESIGN DECISIONS (backend-architect, see spec §"Delegated decisions"):
--   (a) UNIQUE on lower(username), NOT citext — citext is not enabled in this
--       codebase and the lower() idiom is already pervasive (lower(email)
--       throughout auth.ts / get_pending_invitation / consume_invitation). No
--       new extension dependency, no prod extension-enable step.
--   (c) Backfill sanitizes by REMOVAL of disallowed chars (not replacement):
--       email local-part → lower() → strip [^a-z0-9_.] → left(20) → rpad to 3
--       with '0' if short → 'user_<8-hex-of-uuid>' if empty → smallest numeric
--       suffix on case-insensitive collision (re-truncating the base so the
--       result never exceeds 20). Stable order (created_at, id) → deterministic
--       suffix assignment; re-running produces identical output. Reserved-name
--       blocking is enforced in the TS validator for FORWARD admin assignment
--       only — the backfill is exempt (it must not fail; a reserved-derived
--       backfilled name is acceptable and admins can reassign later).
--
-- ROLLOUT SAFETY: fully additive. The app already reads profiles with select *,
--   so a new nullable column is transparent. Rollback = drop the column / index
--   / constraint (git holds the prior shape); no down migration (repo
--   convention).
--
-- REALTIME: NO supabase_realtime publication change. profiles membership is
--   untouched and login is pre-session, so the
--   `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
--   Flagged so it is not cargo-culted.
--
-- RLS: NO policy changes, NO new tables. username rides the existing profiles
--   SELECT/UPDATE policies (spec-043 sweep) — a user reads their own username,
--   admin/master read within-brand, super_admin reads all. The resolver does
--   NOT use these policies (it runs service-role inside the edge function), so
--   the brand-scoped profiles SELECT staying as-is does not break cross-brand
--   login. No new permissive policy → the spec-051/053 permissive-policy lint
--   is not engaged. invitations.username rides the existing admin-only
--   invitation policies.
-- ============================================================


-- ─── Part 1: profiles.username column + constraints ────────────
alter table public.profiles
  add column if not exists username text;

-- Format CHECK (nullable-tolerant): 3–20 chars, allowed [A-Za-z0-9_.] only.
-- Stored as-typed; uniqueness/comparison is case-folded via the index below.
alter table public.profiles
  drop constraint if exists profiles_username_format;
alter table public.profiles
  add constraint profiles_username_format check (
    username is null
    or (
      char_length(username) between 3 and 20
      and username ~ '^[A-Za-z0-9_.]+$'
    )
  );

-- Case-insensitive global UNIQUE. btree does not treat multiple NULLs as equal,
-- so multiple NULL usernames are permitted pre/post backfill; the partial
-- predicate is for clarity only.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username))
  where username is not null;


-- ─── Part 2: invitations.username carrier + RPC widen ──────────
alter table public.invitations
  add column if not exists username text;

-- Same format CHECK shape as profiles, but NO uniqueness on invitations —
-- uniqueness is enforced on profiles at register time (the
-- profiles_username_lower_key index is the server-side authority); the admin UI
-- pre-flight surfaces collisions early.
alter table public.invitations
  drop constraint if exists invitations_username_format;
alter table public.invitations
  add constraint invitations_username_format check (
    username is null
    or (
      char_length(username) between 3 and 20
      and username ~ '^[A-Za-z0-9_.]+$'
    )
  );

-- get_pending_invitation: add `username` to the return set so
-- registerInvitedUser can stamp profiles.username from the invitation. Carries
-- forward the spec-069 resolved_brand_id body VERBATIM — do NOT regress to the
-- older 20260424211733 shape. Postgres rejects CREATE OR REPLACE when the
-- return-type column set changes (42P13), so DROP then CREATE in the same
-- migration transaction (no client observes a missing function). Grant + body
-- preserved.
drop function if exists public.get_pending_invitation(text);

create function public.get_pending_invitation(p_email text)
returns table (
  id uuid,
  email text,
  name text,
  role text,
  store_ids text[],
  brand_id uuid,
  resolved_brand_id uuid,
  username text,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    i.id,
    i.email,
    i.name,
    i.role,
    i.store_ids,
    i.brand_id,
    coalesce(
      i.brand_id,
      (
        select s.brand_id
          from public.stores s
         where i.store_ids is not null
           and array_length(i.store_ids, 1) >= 1
           and s.id = (i.store_ids[1])::uuid
      )
    ) as resolved_brand_id,
    i.username,
    i.expires_at
    from public.invitations i
   where i.email = lower(p_email)
     and i.used = false
     and (i.expires_at is null or i.expires_at > now())
   limit 1;
$$;

comment on function public.get_pending_invitation(text) is
  'Spec 069 + 095 — returns the pending invitation for an email, including
   resolved_brand_id (COALESCE(brand_id, brand of store_ids[1]) — spec 069) and
   username (the admin-assigned username threaded through to registerInvitedUser
   — spec 095). SECURITY DEFINER so the stores lookup bypasses RLS at register
   time (the new user has no user_stores rows yet).';

grant execute on function public.get_pending_invitation(text) to anon, authenticated;


-- ─── Part 3: one-time deterministic backfill (idempotent) ──────
-- Assign a username to every profile whose username is currently NULL, derived
-- from its auth.users email local-part. The migration runs as the postgres role
-- and can read auth.users (same pattern as staff_brand_id_backfill /
-- consume_invitation_sets_profile_id). `WHERE username IS NULL` guard →
-- re-running never overwrites an already-set username, and assignment order
-- (created_at, id) is stable so collision suffixes are deterministic.
do $$
declare
  r          record;
  v_local    text;
  v_base     text;
  v_cand     text;
  v_suffix   int;
  v_max      int := 20;
  v_taken    boolean;
  v_remaining int;
begin
  for r in
    select p.id, u.email, p.created_at
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p.username is null
     order by p.created_at nulls last, p.id
  loop
    -- 1. local-part → lower(). NULL/empty email collapses to '' → fallback.
    v_local := lower(coalesce(split_part(r.email, '@', 1), ''));

    -- 2. sanitize by REMOVAL of any char not in [a-z0-9_.].
    v_base := regexp_replace(v_local, '[^a-z0-9_.]', '', 'g');

    -- 3. truncate to 20.
    v_base := left(v_base, v_max);

    -- 4. pad-if-short (<3): right-pad with '0' to length 3.
    if char_length(v_base) > 0 and char_length(v_base) < 3 then
      v_base := rpad(v_base, 3, '0');
    end if;

    -- 5. empty-after-sanitize / no-email fallback: deterministic handle from the
    --    profile UUID (8 hex chars → 'user_xxxxxxxx', length 13, all allowed).
    if char_length(v_base) = 0 then
      v_base := 'user_' || left(replace(r.id::text, '-', ''), 8);
    end if;

    -- 6. collision suffix: smallest integer >= 1 making lower(candidate) unique
    --    case-insensitively, re-truncating the BASE to (20 - len(suffix)) before
    --    appending so the result never exceeds 20.
    v_cand := v_base;
    v_suffix := 0;
    loop
      select exists (
        select 1 from public.profiles
         where lower(username) = lower(v_cand)
      ) into v_taken;
      exit when not v_taken;
      v_suffix := v_suffix + 1;
      v_cand := left(v_base, v_max - char_length(v_suffix::text)) || v_suffix::text;
    end loop;

    update public.profiles
       set username = v_cand
     where id = r.id
       and username is null;  -- belt-and-braces: never overwrite
  end loop;

  -- Post-backfill assertion: zero NULL usernames remain (AC "count NULL = 0").
  select count(*) into v_remaining
    from public.profiles
   where username is null;

  if v_remaining > 0 then
    raise exception
      '095: post-backfill invariant violated — % profile(s) still have NULL username',
      v_remaining;
  end if;
end $$;
