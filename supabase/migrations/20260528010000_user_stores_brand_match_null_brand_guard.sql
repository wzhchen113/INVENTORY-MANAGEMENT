-- ============================================================
-- Spec 068 §4 — close the NULL-brand cross-brand user_stores hole.
--
-- BACKGROUND
-- ----------
-- The cross-brand defense-in-depth trigger public.user_stores_brand_match()
-- shipped in 20260509000000_multi_brand_schema_rls.sql:357-387. It blocks a
-- cross-brand INSERT/UPDATE by comparing the store's brand_id to the assigned
-- user's profiles.brand_id — BUT it SKIPS the check entirely when the user's
-- profiles.brand_id IS NULL (the old body's `if v_user_brand is null then
-- return new;` short-circuit, lines 372-374).
--
-- That NULL branch is reachable: the invite→register path produces a NULL
-- brand_id for staff (role='user') invites. InviteUserDrawer passes
-- brandId: null for role='user'; inviteUser stores brand_id = null on the
-- invitation; registerInvitedUser inserts the profile with brand_id NULL and
-- THEN inserts the user_stores rows (src/lib/auth.ts). The
-- profiles_role_brand_consistent CHECK (same migration, :347) explicitly
-- admits role='user' with brand_id NULL, so this is a supported state — not a
-- data bug. The seed's Tara Manager carries a non-NULL brand_id, but that is a
-- seed-author choice (seed.sql:115 comment), NOT what the invite flow emits.
--
-- Net: a NULL-brand staff user could, via a direct PostgREST/psql writer (or a
-- pre-fix client carrying store_ids from two brands), be granted user_stores
-- rows spanning multiple brands with no DB-layer objection. Prod has ZERO such
-- rows today (main Claude's read-only Q1 query returned []), so this migration
-- is purely PREVENTIVE — it closes a dormant write hole, it does not repair
-- existing data. No data-cleanup migration ships (spec 068 §0/§5).
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Additive `create or replace function public.user_stores_brand_match()` that
-- tightens ONLY the NULL-brand branch:
--   * Non-NULL-brand user  → UNCHANGED, byte-for-byte: the store's brand must
--                            equal the user's brand or the row is rejected.
--   * NULL-brand user      → instead of an unconditional pass, the assignment
--                            itself defines the brand. The row is rejected if
--                            it would make the user's user_stores span more
--                            than one distinct brand. The FIRST grant always
--                            passes (nothing to conflict with); a NULL-brand
--                            staff user may therefore hold multiple grants, but
--                            all within a SINGLE brand.
--
-- The super-admin tolerance noted in the original trigger is preserved in
-- spirit: a profile with brand_id NULL that is a super_admin legitimately
-- spans brands. In practice super_admins do not appear in user_stores; if one
-- does (e.g. for testing) the "at most one brand among their grants" rule is
-- the only constraint, which matches the original intent of not hard-blocking
-- a NULL-brand row outright. Surfaced to the security-auditor in spec 068 §11.
--
-- IDEMPOTENT / NON-DESTRUCTIVE: `create or replace function` swaps the body in
-- place. The trigger binding user_stores_brand_match_trg already points at this
-- function by name (20260509000000_…:383-386), so a body swap alone suffices;
-- we re-create the trigger idempotently below (drop-if-exists + create) for
-- clarity, matching the original migration's own pattern. No down migration —
-- this repo ships none by convention; the prior body is recoverable from git.
--
-- ORDERING: 20260528010000 sorts AFTER 20260509000000 (the original trigger)
-- and after 20260528000000 (today's earlier migration). It is the latest
-- migration on disk at authoring time.
--
-- REALTIME: this migration does NOT touch the supabase_realtime publication, so
-- the `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
--
-- RLS: no policy changes, no new tables — this is a trigger-function body only.
-- The CLAUDE.md "permissive policies are ORed" lint (spec 053) is not engaged.
-- ============================================================

create or replace function public.user_stores_brand_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_brand     uuid;
  v_store_brand    uuid;
  v_conflict_brand uuid;
begin
  select brand_id into v_user_brand  from public.profiles where id = new.user_id;
  select brand_id into v_store_brand from public.stores   where id = new.store_id;

  if v_user_brand is null then
    -- Spec 068 §4: a NULL-brand user (e.g. a staff/'user' invite) has no
    -- declared brand, so the assignment itself defines the brand. Permit
    -- multiple grants, but only within a SINGLE brand. Reject the row if the
    -- user ALREADY holds a user_stores row whose store brand differs from this
    -- row's store brand. The first grant has nothing to conflict with and so
    -- passes — that is correct (a NULL-brand staff user may be assigned stores
    -- within one brand). `IS DISTINCT FROM` keeps NULL-vs-non-NULL brand pairs
    -- comparing safely, mirroring the non-NULL path below. We exclude the row
    -- being mutated (by store_id) so an idempotent re-assign of the same store
    -- does not self-conflict on UPDATE.
    select s.brand_id
      into v_conflict_brand
      from public.user_stores us
      join public.stores s on s.id = us.store_id
     where us.user_id = new.user_id
       and us.store_id is distinct from new.store_id
       and s.brand_id is distinct from v_store_brand
     limit 1;

    if found then
      raise exception
        'cross-brand user_stores assignment rejected: user has no brand and store brands differ (existing brand=%, new store brand=%)',
        v_conflict_brand, v_store_brand;
    end if;

    return new;
  end if;

  -- Non-NULL-brand path — UNCHANGED from 20260509000000_…:375-378.
  if v_store_brand is distinct from v_user_brand then
    raise exception 'cross-brand user_stores assignment rejected: user brand=%, store brand=%',
      v_user_brand, v_store_brand;
  end if;

  return new;
end;
$$;

-- Re-create the trigger idempotently. The binding is unchanged from
-- 20260509000000_…; recreating it here documents the binding alongside the new
-- body and is a no-op on a second run.
drop trigger if exists user_stores_brand_match_trg on public.user_stores;
create trigger user_stores_brand_match_trg
  before insert or update on public.user_stores
  for each row execute function public.user_stores_brand_match();
