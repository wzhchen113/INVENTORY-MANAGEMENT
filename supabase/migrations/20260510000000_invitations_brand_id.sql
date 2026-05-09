-- Spec 012b §1 — invitations.brand_id column + RPC widen.
--
-- Additive only. Idempotent. Safe to re-apply.
--
-- 1. Adds public.invitations.brand_id (nullable, FK to brands(id)
--    with on delete cascade — pending invites for a deleted brand are
--    pointless, so let them go away with the brand).
-- 2. Adds a partial index on invitations.brand_id for the super-admin
--    "list admins per brand" query in BrandsSection.
-- 3. Re-creates public.get_pending_invitation(p_email text) so the
--    return set includes brand_id — registerInvitedUser reads this
--    field to write profiles.brand_id (load-bearing for the
--    profiles_role_brand_consistent CHECK from 012a).
--
-- The migration is a no-op until the §4 frontend changes ship in the
-- same PR — the existing inviteUser/registerInvitedUser ignore the
-- column until they're rewritten to read/write it.

-- ─── 1. Column ──────────────────────────────────────────────────────
alter table public.invitations
  add column if not exists brand_id uuid references public.brands(id) on delete cascade;

comment on column public.invitations.brand_id is
  'Brand the invitee will be scoped to on registration. NULL allowed for legacy
   invitations from before 012b ships and for role=user invitations (staff app).
   Required by registerInvitedUser when role=admin per profiles_role_brand_consistent.';

-- ─── 2. Index ───────────────────────────────────────────────────────
create index if not exists invitations_brand_id_idx
  on public.invitations (brand_id)
  where brand_id is not null;

-- ─── 3. RPC widen ───────────────────────────────────────────────────
-- Postgres rejects CREATE OR REPLACE FUNCTION when the return-type
-- column set changes (SQLSTATE 42P13). DROP first, then re-create.
-- The window between DROP and CREATE is the same transaction, so
-- registerInvitedUser cannot observe a missing function. The frontend
-- changes that ship in the same PR start writing brand_id to the
-- profiles row from the new return set.
drop function if exists public.get_pending_invitation(text);

create function public.get_pending_invitation(p_email text)
returns table (
  id uuid,
  email text,
  name text,
  role text,
  store_ids text[],
  brand_id uuid,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select id, email, name, role, store_ids, brand_id, expires_at
    from public.invitations
   where email = lower(p_email)
     and used = false
     and (expires_at is null or expires_at > now())
   limit 1;
$$;

grant execute on function public.get_pending_invitation(text) to anon, authenticated;
