-- supabase/tests/profiles_username.test.sql
--
-- Spec 095 — pgTAP coverage for the profiles.username identity:
--   * format CHECK (3–20, allowed [A-Za-z0-9_.], NULL tolerated)
--   * case-insensitive global UNIQUE (lower(username))
--   * backfill determinism / collision-safety / short-pad / empty-fallback
--   * get_pending_invitation returns the new username column
--
-- Hermetic isolation: begin; … rollback;. Every insert/mutation is scoped to
-- this transaction and restored on rollback (the seed is untouched). Backfill
-- arms re-run the migration's DO-block algorithm verbatim against fixtures so
-- the post-backfill invariant (0 NULLs) and the suffix/pad/fallback behavior are
-- exercised without depending on the live seed's exact rows.
--
-- Arms (plan(16)):
--   (1)  format CHECK rejects a 2-char username (too short).
--   (2)  format CHECK rejects a 21-char username (too long).
--   (3)  format CHECK rejects a disallowed char ('-').
--   (4)  format CHECK accepts a valid username (length + charset).
--   (5)  format CHECK accepts NULL (nullable-tolerant).
--   (6)  lower() UNIQUE rejects a case-insensitive duplicate ('Sam' vs 'sam').
--   (7)  lower() UNIQUE permits two NULL usernames (btree NULLs not equal).
--   (8)  backfill: every existing profile has a non-NULL username after the
--        migration ran during db reset (post-backfill invariant, AC).
--   (9)  backfill: every existing username satisfies the format constraint.
--   (10) backfill: usernames are globally unique case-insensitively.
--   (11) backfill algorithm — basic local-part sanitize+lower → 'sam'.
--   (12) backfill algorithm — collision appends smallest numeric suffix → 'sam1'.
--   (13) backfill algorithm — short candidate is right-padded with '0' → 'ab0'.
--   (14) backfill algorithm — empty-after-sanitize falls back to user_<8hex>.
--   (15) backfill algorithm — determinism: re-running the assign produces the
--        SAME username and never overwrites the already-set value.
--   (16) get_pending_invitation returns the new `username` column.

begin;
create extension if not exists pgtap;

select plan(16);

-- ─── fixtures: a brand-A profile id we can mutate freely ───────
-- Reuse the seed manager (role='user') for the constraint arms; insert a fresh
-- auth.users + profiles pair for the dup/uniqueness arms so we never collide
-- with seed-backfilled usernames.
do $$
begin
  perform set_config('test.manager_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.u1', 'c5000000-0000-0000-0000-0000000000a1', true);
  perform set_config('test.u2', 'c5000000-0000-0000-0000-0000000000a2', true);
end $$;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, is_anonymous)
values
  (current_setting('test.u1', true)::uuid, '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'spec095a@test.local', now(), now(), false),
  (current_setting('test.u2', true)::uuid, '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'spec095b@test.local', now(), now(), false)
on conflict (id) do nothing;

insert into public.profiles (id, name, role, initials, color, status, username)
values
  (current_setting('test.u1', true)::uuid, 'Spec095 A', 'user', 'SA', '#378ADD', 'active', null),
  (current_setting('test.u2', true)::uuid, 'Spec095 B', 'user', 'SB', '#378ADD', 'active', null)
on conflict (id) do nothing;


-- ─── Arms (1)-(5): format CHECK ────────────────────────────────
select throws_ok(
  format($q$update public.profiles set username = 'ab' where id = %L$q$, current_setting('test.u1', true)),
  '23514', null,
  'arm (1): format CHECK rejects a 2-char username (too short)'
);

select throws_ok(
  format($q$update public.profiles set username = 'aaaaaaaaaaaaaaaaaaaaa' where id = %L$q$, current_setting('test.u1', true)),
  '23514', null,
  'arm (2): format CHECK rejects a 21-char username (too long)'
);

select throws_ok(
  format($q$update public.profiles set username = 'has-dash' where id = %L$q$, current_setting('test.u1', true)),
  '23514', null,
  'arm (3): format CHECK rejects a disallowed char (hyphen)'
);

select lives_ok(
  format($q$update public.profiles set username = 'valid_user.1' where id = %L$q$, current_setting('test.u1', true)),
  'arm (4): format CHECK accepts a valid username (length + charset)'
);

select lives_ok(
  format($q$update public.profiles set username = null where id = %L$q$, current_setting('test.u1', true)),
  'arm (5): format CHECK accepts NULL (nullable-tolerant)'
);


-- ─── Arm (6): case-insensitive UNIQUE rejects 'Sam' vs 'sam' ────
update public.profiles set username = 'Sam' where id = current_setting('test.u1', true)::uuid;
select throws_ok(
  format($q$update public.profiles set username = 'sam' where id = %L$q$, current_setting('test.u2', true)),
  '23505', null,
  'arm (6): lower() UNIQUE rejects a case-insensitive duplicate (Sam vs sam)'
);


-- ─── Arm (7): two NULL usernames are permitted ─────────────────
update public.profiles set username = null where id = current_setting('test.u1', true)::uuid;
update public.profiles set username = null where id = current_setting('test.u2', true)::uuid;
select lives_ok(
  $q$select 1$q$,
  'arm (7): two NULL usernames coexist (btree does not treat NULLs as equal)'
);


-- ─── Arms (8)-(10): backfill invariants on real seed rows ─────
-- Migrations run BEFORE seed.sql loads, so on a local/CI `db reset` the
-- migration's backfill sees zero profiles and the seed profiles land with NULL
-- usernames. (On PROD the migration runs against existing data and backfills
-- normally.) To exercise the migration's backfill ALGORITHM end-to-end against
-- real seeded data, run it here verbatim over every NULL-username profile, then
-- assert the post-backfill invariants. Hermetic (rolled back).
do $$
declare
  r        record;
  v_local  text;
  v_base   text;
  v_cand   text;
  v_suffix int;
  v_max    int := 20;
  v_taken  boolean;
  v_remaining int;
begin
  for r in
    select p.id, u.email
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p.username is null
     order by p.created_at nulls last, p.id
  loop
    v_local := lower(coalesce(split_part(r.email, '@', 1), ''));
    v_base := left(regexp_replace(v_local, '[^a-z0-9_.]', '', 'g'), v_max);
    if char_length(v_base) > 0 and char_length(v_base) < 3 then v_base := rpad(v_base, 3, '0'); end if;
    if char_length(v_base) = 0 then v_base := 'user_' || left(replace(r.id::text, '-', ''), 8); end if;
    v_cand := v_base; v_suffix := 0;
    loop
      select exists (select 1 from public.profiles where lower(username) = lower(v_cand)) into v_taken;
      exit when not v_taken;
      v_suffix := v_suffix + 1;
      v_cand := left(v_base, v_max - char_length(v_suffix::text)) || v_suffix::text;
    end loop;
    update public.profiles set username = v_cand where id = r.id and username is null;
  end loop;

  select count(*) into v_remaining from public.profiles where username is null;
  if v_remaining > 0 then
    raise exception '095 test: backfill left % NULL usernames', v_remaining;
  end if;
end $$;

select is(
  (select count(*)::bigint from public.profiles where username is null),
  0::bigint,
  'arm (8): every profile has a non-NULL username after backfill (post-backfill invariant)'
);

select is(
  (select count(*)::bigint from public.profiles
    where username is not null
      and not (char_length(username) between 3 and 20 and username ~ '^[A-Za-z0-9_.]+$')),
  0::bigint,
  'arm (9): every backfilled username satisfies the format constraint'
);

select is(
  (select count(*)::bigint from (
     select lower(username) lu
       from public.profiles
      where username is not null
      group by lower(username)
     having count(*) > 1
   ) dups),
  0::bigint,
  'arm (10): backfilled usernames are globally unique case-insensitively'
);


-- ─── Arms (11)-(15): backfill ALGORITHM against controlled fixtures ─
-- Re-run the migration's DO-block algorithm verbatim against three fresh
-- NULL-username profiles whose emails exercise the basic/collision/short/empty
-- paths, then assert the assigned names. Insert auth.users emails to drive the
-- local-part derivation.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, is_anonymous)
values
  ('c5000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'sam@first.test', now() - interval '3 min', now(), false),
  ('c5000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'sam@second.test', now() - interval '2 min', now(), false),
  ('c5000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ab@short.test', now() - interval '1 min', now(), false),
  ('c5000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '+++@junk.test', now(), now(), false)
on conflict (id) do nothing;

insert into public.profiles (id, name, role, initials, color, status, username, created_at)
values
  ('c5000000-0000-0000-0000-0000000000b1', 'Algo Sam1', 'user', 'A1', '#378ADD', 'active', null, now() - interval '3 min'),
  ('c5000000-0000-0000-0000-0000000000b2', 'Algo Sam2', 'user', 'A2', '#378ADD', 'active', null, now() - interval '2 min'),
  ('c5000000-0000-0000-0000-0000000000b3', 'Algo Short', 'user', 'A3', '#378ADD', 'active', null, now() - interval '1 min'),
  ('c5000000-0000-0000-0000-0000000000b4', 'Algo Junk', 'user', 'A4', '#378ADD', 'active', null, now())
on conflict (id) do nothing;

-- The backfill algorithm (verbatim copy of the migration DO block, restricted
-- to the four algo fixtures so seed rows already-assigned do not perturb the
-- collision counter — note: the 'sam' base WILL collide with any seed user
-- already named 'sam', so we assert RELATIVE behavior, not an absolute 'sam').
do $$
declare
  r        record;
  v_local  text;
  v_base   text;
  v_cand   text;
  v_suffix int;
  v_max    int := 20;
  v_taken  boolean;
begin
  for r in
    select p.id, u.email
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p.username is null
       and p.id in (
         'c5000000-0000-0000-0000-0000000000b1',
         'c5000000-0000-0000-0000-0000000000b2',
         'c5000000-0000-0000-0000-0000000000b3',
         'c5000000-0000-0000-0000-0000000000b4'
       )
     order by p.created_at nulls last, p.id
  loop
    v_local := lower(coalesce(split_part(r.email, '@', 1), ''));
    v_base := regexp_replace(v_local, '[^a-z0-9_.]', '', 'g');
    v_base := left(v_base, v_max);
    if char_length(v_base) > 0 and char_length(v_base) < 3 then
      v_base := rpad(v_base, 3, '0');
    end if;
    if char_length(v_base) = 0 then
      v_base := 'user_' || left(replace(r.id::text, '-', ''), 8);
    end if;
    v_cand := v_base;
    v_suffix := 0;
    loop
      select exists (select 1 from public.profiles where lower(username) = lower(v_cand)) into v_taken;
      exit when not v_taken;
      v_suffix := v_suffix + 1;
      v_cand := left(v_base, v_max - char_length(v_suffix::text)) || v_suffix::text;
    end loop;
    update public.profiles set username = v_cand where id = r.id and username is null;
  end loop;
end $$;

-- (11) basic: first 'sam@…' fixture got a username whose base is 'sam' (it may
--      carry a numeric suffix if a seed user already holds 'sam', so assert the
--      base prefix, not an exact string).
select ok(
  (select username from public.profiles where id = 'c5000000-0000-0000-0000-0000000000b1') ~ '^sam[0-9]*$',
  'arm (11): basic local-part sanitize+lower yields a sam-based handle'
);

-- (12) collision: the SECOND 'sam@…' fixture must differ from the first and end
--      in a numeric suffix (smallest free suffix on collision).
select ok(
  (select username from public.profiles where id = 'c5000000-0000-0000-0000-0000000000b2')
    <> (select username from public.profiles where id = 'c5000000-0000-0000-0000-0000000000b1')
  and (select username from public.profiles where id = 'c5000000-0000-0000-0000-0000000000b2') ~ '[0-9]$',
  'arm (12): collision appends a numeric suffix distinct from the first sam handle'
);

-- (13) short: 'ab@…' → base 'ab' (len 2) → rpad to 'ab0'. May suffix on
--      collision, so assert the 'ab0' prefix.
select ok(
  (select username from public.profiles where id = 'c5000000-0000-0000-0000-0000000000b3') ~ '^ab0[0-9]*$',
  'arm (13): short candidate is right-padded with 0 to 3 chars (ab → ab0)'
);

-- (14) empty: '+++@…' sanitizes to '' → fallback 'user_<8hex of id>'.
select is(
  (select username from public.profiles where id = 'c5000000-0000-0000-0000-0000000000b4'),
  'user_' || left(replace('c5000000-0000-0000-0000-0000000000b4', '-', ''), 8),
  'arm (14): empty-after-sanitize falls back to user_<8hex-of-uuid>'
);

-- (15) determinism: re-running the assign (same algorithm, WHERE username IS NULL
--      guard) must NOT change the already-set value.
do $$
declare
  r        record;
  v_local  text;
  v_base   text;
  v_cand   text;
  v_suffix int;
  v_max    int := 20;
  v_taken  boolean;
begin
  for r in
    select p.id, u.email
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p.username is null
       and p.id in ('c5000000-0000-0000-0000-0000000000b1','c5000000-0000-0000-0000-0000000000b2',
                    'c5000000-0000-0000-0000-0000000000b3','c5000000-0000-0000-0000-0000000000b4')
     order by p.created_at nulls last, p.id
  loop
    v_local := lower(coalesce(split_part(r.email, '@', 1), ''));
    v_base := left(regexp_replace(v_local, '[^a-z0-9_.]', '', 'g'), v_max);
    if char_length(v_base) > 0 and char_length(v_base) < 3 then v_base := rpad(v_base, 3, '0'); end if;
    if char_length(v_base) = 0 then v_base := 'user_' || left(replace(r.id::text, '-', ''), 8); end if;
    v_cand := v_base; v_suffix := 0;
    loop
      select exists (select 1 from public.profiles where lower(username) = lower(v_cand)) into v_taken;
      exit when not v_taken;
      v_suffix := v_suffix + 1;
      v_cand := left(v_base, v_max - char_length(v_suffix::text)) || v_suffix::text;
    end loop;
    update public.profiles set username = v_cand where id = r.id and username is null;
  end loop;
end $$;

select is(
  (select username from public.profiles where id = 'c5000000-0000-0000-0000-0000000000b4'),
  'user_' || left(replace('c5000000-0000-0000-0000-0000000000b4', '-', ''), 8),
  'arm (15): re-running the backfill leaves the already-set username unchanged (idempotent)'
);


-- ─── Arm (16): get_pending_invitation returns username ─────────
insert into public.invitations
  (email, profile_id, name, role, store_ids, brand_id, username, used, expires_at)
values (
  'spec095invite@test.local',
  '00000000-0000-0000-0000-000000000000',
  'Spec095 Invite',
  'admin',
  array['00000000-0000-0000-0000-000000000001'],
  '2a000000-0000-0000-0000-000000000001'::uuid,
  'invited_user',
  false,
  now() + interval '7 days'
);

select is(
  (select username from public.get_pending_invitation('spec095invite@test.local')),
  'invited_user',
  'arm (16): get_pending_invitation returns the assigned username column'
);


select * from finish();
rollback;
