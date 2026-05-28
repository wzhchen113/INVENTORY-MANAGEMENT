-- ============================================================
-- Spec 069 — give invited staff a brand_id so NULL-brand staff can read
-- brand-scoped catalog data (catalog_ingredients, vendors) in the EOD app.
--
-- THE BUG
-- -------
-- The staff EOD Count screen embeds catalog:catalog_ingredients(name,unit) and
-- vendor:vendors(id,name). Both target tables are brand-scoped: their SELECT
-- policies gate on auth_can_see_brand(brand_id) (20260509000000_…:200-210,
-- :446-448 catalog, :575-577 vendors). auth_can_see_brand checks the caller's
-- profiles.brand_id. A staff user (role='user') invited AFTER spec 012a lands
-- with profiles.brand_id = NULL (the invite→register path hard-codes
-- brand_id: invitation.brand_id ?? null at src/lib/auth.ts:373, and the
-- invitation row carries NULL for role='user' invites). So
-- auth_can_see_brand(2AM) returns FALSE for them — NULL = 2AM is never true —
-- and the brand-scoped embeds return null. The parent inventory_items /
-- order_schedule rows still pass (those are store-scoped via
-- auth_can_see_store), so the EOD list renders the right ROW COUNT but every
-- ingredient name label is blank. THE LITERAL P0.
--
-- THE 012a-INVARIANT-RESTORATION RATIONALE
-- ----------------------------------------
-- The 012a migration ALREADY backfilled every role!='super_admin' profile that
-- existed at 012a time to the 2AM brand (20260509000000_…:283-286), explicitly
-- INCLUDING role='user' staff rows. The NULL-brand staff state exists ONLY
-- because the invite→register flow regressed against that invariant for users
-- invited after 012a. This migration restores 012a's invariant for the staff
-- rows the post-012a invite flow left NULL — it is a regression repair, not a
-- new design. (Half 2 below — the registerInvitedUser stamp — stops the
-- regression at its source so the backfill does not re-break on the next
-- invite; the two halves ship together. Spec 069 §10 risk #2.)
--
-- WHY limit-1 / single-brand DERIVATION IS SAFE
-- ---------------------------------------------
-- Spec 068's user_stores_brand_match trigger
-- (20260528010000_user_stores_brand_match_null_brand_guard.sql) now guarantees
-- a NULL-brand staff user's user_stores rows are all within a SINGLE brand: the
-- first grant defines the brand and any later cross-brand grant is rejected. So
-- "the brand derived from this staff user's stores" is unambiguous — there is
-- at most one distinct brand_id across their grants. The DO block below still
-- ASSERTS this (RAISE EXCEPTION on any multi-brand staff user) rather than
-- trusting the invariant blindly (§3a fail-closed flagging).
--
-- WHAT THIS MIGRATION DOES (two halves — both required)
-- -----------------------------------------------------
-- Half 1 (backfill): one idempotent DO block UPDATEs profiles.brand_id for
--   every row matching role='user' AND brand_id IS NULL AND has ≥1 user_stores
--   row, setting it to that user's (single) store brand. Pre-flight flagging:
--     * zero-store NULL-brand staff  → RAISE NOTICE + SKIP (no brand to derive;
--       auth_can_see_brand is moot until they get a store; the Half-2 stamp
--       handles them prospectively). NOT an error.
--     * multi-brand NULL-brand staff → RAISE EXCEPTION + refuse to apply
--       (should be impossible post-068; an ambiguous backfill is a
--       data-integrity hazard — fail closed, mirror the 012a pre-flight posture
--       at 20260509000000_…:268-271).
--   Post-backfill invariant assertion: RAISE EXCEPTION if any role='user'
--   profile with ≥1 user_stores row STILL has NULL brand_id (proves the
--   backfill was complete — the AC's "zero NULL-brand-staff-with-stores rows
--   remain"; duplicated as a pgTAP arm).
--
-- Half 2 (durability — get_pending_invitation widen): DROP+CREATE the
--   get_pending_invitation(text) RPC to also return resolved_brand_id — the
--   brand the invitation's store assignments resolve to. registerInvitedUser
--   (src/lib/auth.ts) stamps profiles.brand_id from resolved_brand_id for
--   role='user' invites so newly-invited staff land WITH a brand. Derivation is
--   server-side (the RPC is SECURITY DEFINER → bypasses RLS) because at register
--   time the new user's user_stores rows don't exist yet, so a client-side
--   stores SELECT would be RLS-blocked and silently leave brand_id NULL
--   (spec 069 §4). Admin invites are UNCHANGED — they already carry a non-NULL
--   invitation.brand_id, and resolved_brand_id COALESCEs to it.
--
-- PROD FOOTPRINT (verified read-only by main Claude, spec 069 §8 pre-flight):
--   exactly 1 row today — the "Charles" staff user → 2AM brand
--   (derived_brands = {2AM}, single-element). Zero multi-brand staff. The
--   UPDATE touches that 1 row; idempotent on re-run.
--
-- TRIGGER / CONSTRAINT INTERACTIONS (confirmed, spec 069 §1b):
--   * profiles_self_brand_lock: the backfill runs as the migration role
--     (postgres superuser, auth.uid() = NULL), so the trigger's
--     old.id = auth.uid() self-edit guard is never true → it does NOT block
--     the backfill. (And once staff carry a brand_id, that trigger then
--     prevents staff self-changing their own brand_id — the desired posture.)
--   * user_stores_brand_match_trg (spec 068): fires on user_stores writes, NOT
--     on profiles writes — this UPDATE is on profiles, so the trigger does NOT
--     fire on the backfill. After backfill, future user_stores inserts for the
--     staff user take the trigger's NON-NULL path (store brand == profile
--     brand); since the backfilled brand == their existing single store brand,
--     every existing user_stores row already satisfies that invariant.
--   * profiles_role_brand_consistent (20260509000000_…:343-348): the
--     (role='user') arm is UNCONDITIONAL — it permits NULL or non-NULL brand_id
--     for staff, so SETTING a brand_id on a role='user' row is constraint-legal.
--
-- ORDERING: 20260528020000 sorts AFTER 20260528010000 (the spec 068 trigger,
--   whose single-brand guarantee the backfill relies on) and after
--   20260528000000. Latest on disk at authoring time; no collision.
--
-- REALTIME: NO supabase_realtime publication change. catalog_ingredients /
--   vendors / profiles membership is untouched, the staff stack uses no
--   realtime (spec 062), so the `docker restart supabase_realtime_imr-inventory`
--   ritual does NOT apply. Flagged so it is not cargo-culted.
--
-- RLS: NO policy changes, NO new tables. The fix is purely that
--   auth_can_see_brand(brand_id) now returns TRUE for backfilled staff because
--   their profiles.brand_id matches — the existing brand_member_read_*
--   policies start admitting them with no policy edit. (The CLAUDE.md "permissive
--   policies are ORed" lint, spec 053, is not engaged — no policy text changes.)
--
-- NO down migration — repo convention; the prior get_pending_invitation body is
--   recoverable from git, and a brand_id can be nulled again by a super_admin if
--   ever needed.
-- ============================================================


-- ─── Half 1: one-time backfill (idempotent DO block) ───────────
do $$
declare
  v_multi_brand int;
  v_zero_store  int;
  v_backfilled  int;
  v_remaining   int;
  r             record;
begin
  -- ── Pre-flight (a): multi-brand NULL-brand staff → FAIL CLOSED.
  --    Should be impossible post-spec-068. If any role='user' NULL-brand
  --    profile's user_stores span >1 distinct brand, the backfill brand is
  --    ambiguous — refuse to apply rather than guess (§3a). Mirror the 012a
  --    pre-flight RAISE EXCEPTION posture (20260509000000_…:268-271).
  select count(*) into v_multi_brand
  from (
    select us.user_id
      from public.user_stores us
      join public.stores s on s.id = us.store_id
      join public.profiles p on p.id = us.user_id
     where p.role = 'user'
       and p.brand_id is null
     group by us.user_id
    having count(distinct s.brand_id) > 1
  ) multi;

  if v_multi_brand > 0 then
    raise exception
      '069: pre-flight failed: % NULL-brand staff profile(s) have user_stores spanning >1 brand — ambiguous backfill, resolve before applying (spec 068 invariant violated)',
      v_multi_brand;
  end if;

  -- ── Pre-flight (b): zero-store NULL-brand staff → NOTICE + skip.
  --    No store → no brand to derive. auth_can_see_brand is moot for them
  --    until they get a store; the Half-2 stamp handles them prospectively.
  --    NOT an error — the invite flow legitimately permits zero-store invites.
  select count(*) into v_zero_store
    from public.profiles p
   where p.role = 'user'
     and p.brand_id is null
     and not exists (select 1 from public.user_stores us where us.user_id = p.id);

  if v_zero_store > 0 then
    raise notice
      '069: % NULL-brand staff profile(s) have zero user_stores rows — skipped (no brand to derive; will be stamped at next store assignment / invite)',
      v_zero_store;
    for r in
      select p.id, p.name
        from public.profiles p
       where p.role = 'user'
         and p.brand_id is null
         and not exists (select 1 from public.user_stores us where us.user_id = p.id)
    loop
      raise notice '069:   skipped zero-store staff id=% name=%', r.id, r.name;
    end loop;
  end if;

  -- ── Backfill: set brand_id to the user's single store brand for every
  --    role='user' NULL-brand profile that HAS ≥1 user_stores row. The
  --    DISTINCT subquery is safe because pre-flight (a) proved there is at
  --    most one distinct brand per such user. Predicated on brand_id IS NULL
  --    → idempotent (a second run no-ops). The user_stores_brand_match trigger
  --    does NOT fire here (this is a profiles UPDATE, not a user_stores write).
  update public.profiles p
     set brand_id = (
       select distinct s.brand_id
         from public.user_stores us
         join public.stores s on s.id = us.store_id
        where us.user_id = p.id
     )
   where p.role = 'user'
     and p.brand_id is null
     and exists (select 1 from public.user_stores us2 where us2.user_id = p.id);
  get diagnostics v_backfilled = row_count;
  raise notice '069: backfilled % staff profile(s) to their store brand', v_backfilled;

  -- ── Post-backfill invariant: zero role='user' rows WITH a user_stores grant
  --    may remain NULL-brand. This is the AC assertion; duplicated as a pgTAP
  --    arm so it is enforced at test time too.
  select count(*) into v_remaining
    from public.profiles p
   where p.role = 'user'
     and p.brand_id is null
     and exists (select 1 from public.user_stores us where us.user_id = p.id);

  if v_remaining > 0 then
    raise exception
      '069: post-backfill invariant violated — % role=user profile(s) with a user_stores grant still have NULL brand_id',
      v_remaining;
  end if;
end $$;


-- ─── Half 2: get_pending_invitation widen (durability fix) ─────
-- Postgres rejects CREATE OR REPLACE FUNCTION when the return-type column set
-- changes (SQLSTATE 42P13). DROP first, then re-create — same pattern as
-- 20260510000000_…:40. The window between DROP and CREATE is the same migration
-- transaction, so no client observes a missing function. registerInvitedUser
-- reads resolved_brand_id from the new return set and stamps profiles.brand_id
-- for role='user' invites (the TS read of the RPC result is loose, so adding a
-- column is backward-compatible).
--
-- resolved_brand_id = COALESCE(
--   invitation.brand_id,                         -- admin invites already carry it
--   (brand of the invitation's first store)      -- staff invites: derive server-side
-- )
-- store_ids is text[] on the invitations row; (store_ids[1])::uuid is the first
-- assigned store. SECURITY DEFINER → the stores lookup bypasses RLS (the
-- registering user has no user_stores rows yet at register time). If the
-- invitation has zero store_ids AND NULL brand_id, resolved_brand_id is NULL
-- and the staff profile is created NULL-brand (constraint-legal for role='user')
-- — a benign no-op matching the zero-store backfill skip.
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
    i.expires_at
    from public.invitations i
   where i.email = lower(p_email)
     and i.used = false
     and (i.expires_at is null or i.expires_at > now())
   limit 1;
$$;

comment on function public.get_pending_invitation(text) is
  'Spec 069 — returns the pending invitation for an email, including
   resolved_brand_id: the brand the invitation resolves to
   (COALESCE(brand_id, brand of store_ids[1])). registerInvitedUser stamps
   profiles.brand_id from resolved_brand_id for role=user (staff) invites so
   newly-invited staff land with a brand and can read brand-scoped catalog data
   (the spec 069 EOD fix). Admin invites already carry brand_id and are
   unchanged. SECURITY DEFINER so the stores lookup bypasses RLS at register
   time (the new user has no user_stores rows yet).';

grant execute on function public.get_pending_invitation(text) to anon, authenticated;
