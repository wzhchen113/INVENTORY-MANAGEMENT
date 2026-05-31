-- ============================================================
-- Spec 082 — fix "(email not loaded)" for registered users in
-- the admin Users & access section (Option A+B; backend-only).
--
-- THE BUG (root-caused + prod-confirmed; see spec 082)
-- ----------------------------------------------------
-- profiles has no email column. fetchBrandAdmins (src/lib/db.ts) infers
-- each user's email from the invitations row that registered them. But
-- consume_invitation only ever set `used = true` — it never linked the
-- invitation to the registering profile — and fetchBrandAdmins filtered
-- the invitations query to `used = false`. So the moment a user
-- registers, their invitation flips to used=true, drops out of the
-- query, and there is no row left to infer the email from → every
-- registered user renders "(email not loaded)" and Reset-PW / Delete
-- lose the email.
--
-- THE FIX (this migration = the "B" half; "A" is the db.ts read change)
-- ---------------------------------------------------------------------
-- (a) Redefine consume_invitation to ALSO set profile_id = auth.uid() on
--     consume, so the invitation is linked to the registering profile.
--     fetchBrandAdmins then matches the invite by profile_id (id-match
--     wins over the fragile name-match, eliminating the same-display-name
--     email-swap hazard the db.ts comment frets about).
-- (b) One-time idempotent backfill: link EXISTING used invitations to
--     their already-registered profiles, since those rows were consumed
--     BEFORE (a) shipped and carry the sentinel profile_id. profiles has
--     no email, so the link path is
--     invitations.email → auth.users.email → auth.users.id (= profiles.id).
--     Migrations run as postgres → can read auth.users.
--
-- GROUND TRUTH (spec 082 §0 — corrections to the original premise):
--   invitations.profile_id is NOT NULL with the SENTINEL default
--   '00000000-0000-0000-0000-000000000000' (createInvite inserts the
--   sentinel to satisfy NOT NULL on pending invites — see
--   src/lib/auth.ts). It is NEVER literal NULL. So "unset" means
--   "== sentinel", and this migration must NEVER write NULL or the
--   sentinel back (that would violate NOT NULL / re-orphan a row).
--
-- IDEMPOTENCY: CREATE OR REPLACE on the function + a sentinel-guarded
--   backfill UPDATE → the whole migration is re-runnable. A second run
--   links zero new rows (already-linked rows carry a real profile_id ≠
--   sentinel and are excluded by the guard).
--
-- RLS: NO policy changes, NO new tables/columns. consume_invitation is
--   SECURITY DEFINER and runs as its owner, so the new profile_id write
--   bypasses the invitations UPDATE policy exactly as the existing
--   used=true write already does. The backfill runs as postgres
--   (superuser bypasses RLS) and reading auth.users in-migration is the
--   standard pattern (cf. staff_brand_id_backfill, legacy_permissive_
--   policy_dropout). No supabase_realtime publication change → the
--   realtime restart ritual does NOT apply here.
--
-- ORDERING: 20260531000000 sorts AFTER 20260530000000 — clean tail
--   append, no reordering of applied prod migrations. The
--   db-migrations-applied drift gate will see one new local migration
--   not yet in prod → run `npx supabase db push --linked` post-merge.
--
-- NO down migration — repo convention; the prior consume_invitation body
--   is recoverable from git (20260424211733_security_fixes.sql:87-108),
--   and the backfill is additive (it only fills sentinels).
-- ============================================================


-- ─── (a) Redefine consume_invitation to link profile_id ────────
-- Identical shape to 20260424211733_security_fixes.sql:87-108 — returns
-- boolean, language plpgsql, SECURITY DEFINER, SET search_path = public,
-- the auth.uid() null-guard, the `get diagnostics`/`return v_updated > 0`.
-- The ONLY change is the SET clause: profile_id = auth.uid() is added.
-- auth.uid() is the freshly-authenticated registering user, whose
-- profiles.id == auth.users.id by construction (registerInvitedUser
-- creates the profile with id = authData.user.id). Past the null-guard
-- auth.uid() is guaranteed non-null, so we never write the sentinel/NULL.
-- The `where used = false` predicate is unchanged → still idempotent: a
-- second consume of an already-used invite updates zero rows, returns
-- false, and never overwrites a previously-set profile_id.
create or replace function public.consume_invitation(p_invitation_id uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  if auth.uid() is null then
    return false;
  end if;
  update public.invitations
     set used = true,
         profile_id = auth.uid()        -- NEW (spec 082): link the invite to the registering profile
   where id = p_invitation_id
     and lower(email) = lower(p_email)
     and used = false
     and (expires_at is null or expires_at > now());
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Re-affirm the existing grant for self-documentation / drift-safety
-- (no-op if already granted; CREATE OR REPLACE preserves grants). NOT
-- granted to anon — consume requires auth.uid().
grant execute on function public.consume_invitation(uuid, text) to authenticated;

-- Defense-in-depth (spec 082 review — security-auditor + architect): the
-- function pre-dates the spec-005 anon-lockdown standard and still carried
-- legacy PUBLIC/anon EXECUTE grants. The `auth.uid() is null → return false`
-- guard already neutralizes anon, but leaving the grant is the inconsistency
-- 20260505065303_admin_rpcs_lock_anon.sql exists to close. Since we are
-- already redefining this function, revoke them here. The only caller
-- (registerInvitedUser) runs as `authenticated`, which keeps its grant above.
revoke execute on function public.consume_invitation(uuid, text) from public, anon;


-- ─── (b) One-time idempotent backfill of legacy used invites ───
-- Link EXISTING used invitations (consumed before (a) shipped, so they
-- carry the sentinel profile_id) to their registered profiles. Design
-- decisions baked into the predicate (spec 082 §1):
--   * lower(i.email) = lower(u.email) — defensive case-normalization on
--     both sides (consume_invitation/createInvite lowercase on write, but
--     auth.users.email casing is not guaranteed).
--   * profile_id = sentinel — only fill un-linked rows; NEVER overwrite a
--     real link. This is the idempotency guard: a second run matches zero
--     rows. It also guarantees we never write NULL/sentinel (we only set
--     to a concrete u.id), so the NOT NULL constraint is never violated.
--   * exists (... profiles p where p.id = u.id) — only link if a profile
--     actually exists (handles invites whose auth user was later deleted;
--     they keep the sentinel and fall back to name-match in db.ts).
-- Resends (multiple used invites for the same email) each match the same
-- u.id — all point at that one person's profile, which is correct.
do $$
declare
  v_linked int;
begin
  update public.invitations i
     set profile_id = u.id
    from auth.users u
   where i.used = true
     and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
     and lower(i.email) = lower(u.email)
     and exists (select 1 from public.profiles p where p.id = u.id);
  get diagnostics v_linked = row_count;
  raise notice '082: backfilled profile_id on % legacy used invitation(s) (0 expected on local — seed has no invitations)', v_linked;
end $$;
