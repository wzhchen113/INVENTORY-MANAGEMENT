-- ============================================================
-- Spec 083 — fix "(email not loaded)" for registered users in the admin
-- Users & access section (the REAL loader: fetchAllUsers, not the
-- fetchBrandAdmins path spec 082 fixed). Backend-only, DATA-ONLY backfill.
--
-- THE BUG (root-caused + prod-confirmed; see spec 083)
-- ----------------------------------------------------
-- profiles has no email column. fetchAllUsers (src/lib/auth.ts) infers each
-- user's email from the invitations row that registered them, indexing
-- invitations by profile_id (winning) then by name (fallback). The lookup
-- query fetchInvitationsForUserLookup (src/lib/db.ts) added
-- `.eq('brand_id', brandId)` whenever a brand was scoped. Two affected prod
-- users — Bobby (admin) and Charles (user) — carry invitations whose
-- brand_id IS NULL while their profiles carry a real brand. So the moment a
-- brand is selected, the `.eq('brand_id', brandId)` filter EXCLUDES their
-- NULL-brand invitations, the email lookup misses, and the row renders
-- "(email not loaded)" — which also disables Reset-Password and Delete on
-- those rows (UsersSection bails on empty email). Same NULL-brand bug class
-- specs 068/069 fixed on the profiles/staff side; this is that class landing
-- on the invitations table.
--
-- THE FIX (two parts — this migration is the data half)
-- -----------------------------------------------------
-- (1) This migration: a one-time idempotent backfill of invitations.brand_id
--     from each linked profile's brand, so even a brand-scoped view resolves.
-- (2) The TS half (src/lib/db.ts): drop the `.eq('brand_id', brandId)` on the
--     email-inference query so a NULL-brand invitation can never again hide
--     from inference (belt-and-suspenders against any FUTURE NULL-brand row).
--     That change is in db.ts, not here.
--
-- THE TWO-PATH BACKFILL PREDICATE
-- -------------------------------
-- profiles has no email column, so brand is derived from the linked profile
-- via two mutually-exclusive UPDATE statements (one DO block):
--   * UPDATE #1 (primary): profile_id join. For NULL-brand invitations
--     LINKED to a profile (profile_id <> sentinel) whose profiles.brand_id is
--     non-null, set invitations.brand_id to that profile's brand. profile_id
--     is unambiguous (one profile per id) → no ambiguity guard needed.
--     Bobby/Charles were profile_id-linked by the spec-082 backfill, so they
--     take THIS path.
--   * UPDATE #2 (fallback): name match for SENTINEL-still rows only. Derive
--     brand from a name match against profiles, but ONLY when the name
--     resolves to EXACTLY ONE distinct non-null brand (the count(distinct …)
--     = 1 guard). 0 or >1 matches are left NULL — never guessed. A pre-flight
--     RAISE NOTICE surfaces the >1-brand ambiguous count for operator
--     visibility. This precedence (profile_id wins over name) matches
--     fetchAllUsers' own invByProfileId ?? invByName ordering, so the data
--     and the loader agree.
--
-- GROUND TRUTH (spec 082 §0 — carried forward):
--   invitations.profile_id is NOT NULL with the SENTINEL value
--   '00000000-0000-0000-0000-000000000000' (createInvite inserts the sentinel
--   to satisfy NOT NULL on pending invites). It is NEVER literal NULL. So
--   "unlinked" means "== sentinel"; UPDATE #1 keys off `<> sentinel` and
--   UPDATE #2 off `= sentinel`. The two WHERE clauses are mutually exclusive,
--   so no row is touched twice and the order of the two UPDATEs is irrelevant.
--
-- SENTINEL / NULL SAFETY: both UPDATEs ONLY ever set brand_id to a concrete
--   non-null brand. They NEVER write NULL or the sentinel. invitations linked
--   to a profile that itself has NULL brand are LEFT NULL (nothing to derive —
--   the accepted bootstrap gap, spec 083 AC #3). brand_id is nullable on
--   invitations (20260510000000_invitations_brand_id.sql), so a residual NULL
--   is constraint-legal.
--
-- IDEMPOTENCY: both UPDATEs are predicated on `i.brand_id is null`, which is
--   the idempotency guard — a second run matches zero rows because the
--   just-filled rows are no longer NULL. AC #2. The post-backfill invariant
--   below (RAISE EXCEPTION) proves completeness: every NULL-brand invitation
--   that STILL remains must be genuinely unresolvable.
--
-- ORDERING: 20260531010000 sorts strictly AFTER spec 082's
--   20260531000000_consume_invitation_sets_profile_id.sql — clean tail append,
--   no reordering of applied prod migrations. This ordering is LOAD-BEARING:
--   UPDATE #1 depends on spec 082's profile_id backfill having ALREADY run
--   (that is what links Bobby/Charles to their profiles). If reordered,
--   UPDATE #1 would find sentinel profile_ids and fall through to the weaker
--   name-match path. The db-migrations-applied drift gate will see one new
--   local migration not yet in prod → run `npx supabase db push --linked`
--   post-merge.
--
-- RLS: NO policy changes, NO new tables/columns, NO function/RPC body change.
--   This is a pure DATA backfill (no DDL). It runs as the migration role
--   (postgres superuser → bypasses RLS), so the invitations write policies do
--   not gate it — same posture as the spec-069 and spec-082 backfills. The
--   CLAUDE.md "permissive policies are ORed" lint (spec 053) is NOT engaged —
--   no policy text changes. No grant change → no anon-lockdown re-affirmation
--   needed.
--
-- REALTIME: NO supabase_realtime publication change. invitations is not a
--   realtime-published table and its membership is untouched; UsersSection
--   uses no realtime channel. Therefore the
--   `docker restart supabase_realtime_imr-inventory` ritual does NOT apply —
--   flagged so it is not cargo-culted into the deploy steps.
--
-- LOCAL-SEED REALITY: the 286 KB seed has ZERO invitation rows (spec 082
--   §0.2). On `db reset` both UPDATEs report 0 row(s) and the post-backfill
--   invariant trivially holds (no rows to violate it). All pgTAP fixtures are
--   created in-txn (supabase/tests/invitations_brand_id_backfill.test.sql).
--
-- NO down migration — repo convention; the backfill is additive (it only
--   fills NULL brand_id from the linked profile) and a brand_id can be nulled
--   again by a super_admin if ever needed.
-- ============================================================

do $$
declare
  v_via_profile  int;
  v_via_name     int;
  v_ambiguous    int;
  v_remaining    int;
begin
  -- ── Pre-flight: ambiguous name-only rows (defense-in-depth notice).
  --    Count NULL-brand, sentinel-profile_id invitations whose name matches
  --    >1 profile carrying DISTINCT non-null brands. These are deliberately
  --    LEFT NULL by UPDATE #2's exactly-one guard (cannot safely pick a brand).
  select count(*) into v_ambiguous
  from public.invitations i
  where i.brand_id is null
    and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
    and (
      select count(distinct p.brand_id)
        from public.profiles p
       where p.name = i.name
         and p.brand_id is not null
    ) > 1;
  if v_ambiguous > 0 then
    raise notice
      '083: % NULL-brand sentinel invitation(s) name-match >1 distinct-brand profile — left NULL (ambiguous, cannot derive a single brand)',
      v_ambiguous;
  end if;

  -- ── UPDATE #1 (primary): profile_id join. For NULL-brand invitations
  --    LINKED to a profile (profile_id <> sentinel) whose profiles.brand_id
  --    is non-null, set invitations.brand_id to that profile's brand.
  --    profile_id is NOT NULL with the sentinel default (spec 082 §0); a real
  --    profile_id is unambiguous (one profile per id), so no ambiguity guard
  --    is needed on this path. Predicated on brand_id IS NULL → idempotent.
  update public.invitations i
     set brand_id = p.brand_id
    from public.profiles p
   where i.brand_id is null
     and i.profile_id <> '00000000-0000-0000-0000-000000000000'::uuid
     and p.id = i.profile_id
     and p.brand_id is not null;
  get diagnostics v_via_profile = row_count;
  raise notice '083: backfilled invitations.brand_id via profile_id on % row(s)', v_via_profile;

  -- ── UPDATE #2 (fallback): name match for SENTINEL-still rows only.
  --    For NULL-brand invitations whose profile_id is STILL the sentinel,
  --    derive brand from a name match against profiles — but ONLY when the
  --    name resolves to EXACTLY ONE distinct non-null brand (the exactly-one
  --    guard). Rows matching 0 or >1 distinct brands are left NULL. The
  --    subquery returns the single distinct brand; the `= 1` cardinality
  --    guard in the WHERE makes the scalar subquery safe.
  update public.invitations i
     set brand_id = (
       select distinct p.brand_id
         from public.profiles p
        where p.name = i.name
          and p.brand_id is not null
     )
   where i.brand_id is null
     and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
     and (
       select count(distinct p.brand_id)
         from public.profiles p
        where p.name = i.name
          and p.brand_id is not null
     ) = 1;
  get diagnostics v_via_name = row_count;
  raise notice '083: backfilled invitations.brand_id via name fallback on % row(s)', v_via_name;

  -- ── Post-backfill invariant: every NULL-brand invitation that STILL
  --    remains must be unresolvable — i.e. NOT (linked-to-a-branded-profile)
  --    AND NOT (name-matches exactly one branded profile). If any row is
  --    resolvable yet still NULL, the backfill was incomplete → fail closed.
  --    This is the checkable AC, duplicated as a pgTAP arm.
  select count(*) into v_remaining
  from public.invitations i
  where i.brand_id is null
    and (
      -- resolvable via profile_id to a branded profile …
      (i.profile_id <> '00000000-0000-0000-0000-000000000000'::uuid
       and exists (
         select 1 from public.profiles p
          where p.id = i.profile_id and p.brand_id is not null))
      or
      -- … OR resolvable via an unambiguous (exactly-one) name match
      (i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
       and (
         select count(distinct p.brand_id)
           from public.profiles p
          where p.name = i.name and p.brand_id is not null
       ) = 1)
    );
  if v_remaining > 0 then
    raise exception
      '083: post-backfill invariant violated — % resolvable NULL-brand invitation(s) still have NULL brand_id',
      v_remaining;
  end if;
end $$;
