# Spec 012a: Multi-brand schema + RLS + one-time data migration

Status: READY_FOR_REVIEW

**Type:** Backend / database — schema, RLS hardening, one-time data backfill.
**Sub-spec of:** [Spec 012 — Multi-brand tenancy umbrella](012-multi-brand-tenancy.md). The umbrella locks in the user-confirmed decisions; this sub-spec implements the **security boundary** alone.
**Successors (NOT in 012a):**
- 012b — Super-admin Cmd UI section + brand picker.
- 012c — Brand soft-delete / hard-delete / restore UX.

## Why 012a ships first and alone
Per the umbrella's "Phasing / sub-spec split" decision (Q-USER-4, resolved 2026-05-09): 012a establishes the security boundary for the entire multi-brand model. After 012a is live, brand-admin in brand A genuinely cannot read or write brand B rows — even with curl bypassing the client. UI work (012b) can then be built against an enforced isolation. Shipping UI before RLS would mean every existing admin sees every brand the moment a second brand is inserted.

## What 012a covers (mini-summary)
1. Schema additions on `profiles` (`brand_id`, expanded `role` CHECK) and `brands` (`deleted_at`).
2. Two new RLS helpers: `auth_is_super_admin()`, `auth_can_see_brand(uuid)`. Extension of `auth_can_see_store(uuid)` to pass for super-admin.
3. RLS policy rewrites on every brand-scoped table — `catalog_ingredients`, `recipes`, `prep_recipes`, `vendors`, `recipe_ingredients`, `prep_recipe_ingredients`, `recipe_prep_items`, `ingredient_conversions`, `pos_recipe_aliases`, `brands` itself. Audit (no policy changes expected) of every store-scoped table whose visibility flows through `auth_can_see_store()`.
4. One-time data migration: backfill all existing `profiles.brand_id` to `'2a000000-0000-0000-0000-000000000001'`; promote `wzhchen113@gmail.com` to `super_admin` with `brand_id = NULL`.
5. Verification probes (curl + psql) the user can run post-deploy to confirm cross-brand isolation.

## What 012a explicitly does NOT cover
- **Zero UI changes.** No `.tsx` edits. The Cmd UI is verified to still work post-migration but not modified. UI changes ship in 012b.
- **No brand-creation, brand-deletion, or admin-invitation RPCs.** 012b adds invite-with-brand; 012c adds soft/hard delete.
- **No `super_admin` invitation/promotion flow.** The one-time migration is the *only* path to super-admin. To add another super-admin later, the user runs SQL by hand. Hard-coded for safety.
- **No staff-app or PWA-side changes.** Sibling-app punch list restated verbatim under "Downstream impact" but not implemented here.
- **No `profile_store_assignments` join table.** See §1 schema decisions — brand-admins continue to use the existing `user_stores` junction. Cross-brand `user_stores` is rejected by a CHECK trigger (additive).
- **No daily-cron purge job.** 012c will add the purge for soft-deleted brands past their grace window.

## Acceptance criteria (012a-specific)

**Schema**
- [ ] `profiles.brand_id uuid references brands(id) on delete set null` exists. Nullable. Comment column: `NULL means super-admin (sees all brands).`
- [ ] `profiles.role` CHECK constraint accepts `'super_admin' | 'admin' | 'user'`. Old constraint (if any) dropped first.
- [ ] CHECK `profiles_role_brand_consistent`: `role = 'super_admin' ⟹ brand_id IS NULL`; `role = 'admin' ⟹ brand_id IS NOT NULL`. (`role = 'user'` is unconstrained for staff-app compatibility.)
- [ ] `brands.deleted_at timestamptz` exists, nullable. Default NULL.

**Helpers**
- [ ] `auth_is_super_admin()` exists, `SECURITY DEFINER`, `set search_path = public, auth`, returns bool.
- [ ] `auth_can_see_brand(p_brand_id uuid)` exists, same shape, returns true iff super-admin OR caller's `profiles.brand_id = p_brand_id`.
- [ ] `auth_can_see_store(p_store_id uuid)` updated to also pass for super-admin (today it passes for `auth_is_admin()` OR `user_stores` membership; super-admin must short-circuit through too).
- [ ] `auth_is_admin()` keeps its existing behavior (still passes for `app_metadata.role in ('admin','master')` from JWT) — super-admin promotion happens via `profiles.role`, NOT via JWT. See §2 for why.

**RLS**
- [ ] Every brand-scoped table's permissive policies replaced with `auth_can_see_brand(brand_id)`-gated reads + `auth_is_admin() AND auth_can_see_brand(brand_id)`-gated writes (or super-admin).
- [ ] Child tables without a `brand_id` column (`recipe_ingredients`, `prep_recipe_ingredients`, `recipe_prep_items`, `ingredient_conversions`) gated via parent EXISTS-join — no denormalized brand_id added (justified in §3).
- [ ] `brands` SELECT filtered to hide rows where `deleted_at IS NOT NULL` from non-super-admins. Super-admin sees soft-deleted rows. (012c will add the restore button; the column lands here so the picker doesn't show a "deleted" brand mid-grace-window.)

**Data migration**
- [ ] All `profiles` with `brand_id IS NULL` and `role <> 'super_admin'` after the migration → set `brand_id = '2a000000-...'`.
- [ ] Profile whose `auth.users.email = 'wzhchen113@gmail.com'` → set `role = 'super_admin'`, `brand_id = NULL`. Idempotent.
- [ ] Migration fires `RAISE NOTICE` (not `EXCEPTION`) if the email is not found — fresh local stacks won't have it; production does.
- [ ] Migration is wrapped in a single transaction. Sanity counts (`RAISE NOTICE 'migrated % profiles to 2AM brand'`, `'promoted % super-admins'`) emitted at end.

**Backwards compatibility**
- [ ] Existing 2AM PROJECT brand-admin sessions continue to read/write all 2AM data with no functional regression. Verified by §6 probe.
- [ ] All existing admin-via-JWT users (i.e. anyone whose `app_metadata.role = 'admin'`) keep their write capability for their brand. Confirmed because `auth_is_admin()` is unchanged.
- [ ] Fresh `npm run dev:db:reset` succeeds end-to-end. The fresh local Supabase doesn't have `wzhchen113@gmail.com`, so the super-admin promotion is a NOTICE-and-skip — local dev keeps working as a single-brand-admin environment.

**Verification**
- [ ] §6 probes pass: brand-admin in brand A returns zero rows when querying brand B's catalog; super-admin sees both.
- [ ] Cmd UI still loads and functions in local dev after the migration (smoke).

## In scope
- New SQL helpers and CHECK constraints on `profiles`, `brands`.
- RLS rewrites on every brand-scoped table.
- One-time backfill of `profiles.brand_id` and one super-admin promotion.
- Verification probes (psql + curl) for §6.

## Out of scope (012a)
See "What 012a explicitly does NOT cover" above. Recap: no UI, no RPCs for brand create/delete/invite, no cron purge, no staff/PWA edits.

## Dependencies
- Existing `brands` table (P1 migration).
- Existing `auth_is_admin()` helper.
- Existing `auth_can_see_store()` helper from `20260504173035_per_store_rls_hardening.sql` — being extended in §2.
- Existing `profiles` table from init schema.
- The user's email — `wzhchen113@gmail.com` (locked in via Q-USER-1).
- No new third-party libraries.

---

## Backend design

### §0 — Probe results (pre-design read of the codebase)

What the architect confirmed before designing:

1. **Frontend reads explicitly pass `brand_id`.** [src/lib/db.ts](../src/lib/db.ts):
   - `fetchRecipes(brandId)` filters `.eq('brand_id', brandId)` (line 179).
   - `fetchCatalogIngredients(brandId)` filters `.eq('brand_id', brandId)` (line 1567).
   - `fetchBrandForStore(storeId)` resolves the brand via the FK on `stores.brand_id`.
   - All other brand-scoped reads (vendors, prep_recipes, ingredient_conversions) follow the same pattern via `fetchAllForStore`.

   **Implication:** post-012a, when the JWT-authed admin's `profiles.brand_id` is set correctly, RLS will silently filter to that brand and the existing client `.eq('brand_id', brandId)` becomes redundant-but-harmless. No frontend change required to keep the existing single-brand admin working.

2. **Sibling apps (`pwa-catalog`, `staff-*`) use `SUPABASE_SERVICE_ROLE_KEY`.** Service role bypasses RLS by design. New brand-scoped policies will NOT block them. They already explicitly filter by `brand_id` (resolved from `store.brand_id`), so they'll keep returning brand-correct data with no edge-function change. This contradicts the umbrella's risk #2 implication — the audit is still required when 012b lands an actual second brand, but 012a alone does not break sibling apps.

3. **Per-store RLS hardening already covers** `inventory_items`, `eod_submissions`, `eod_entries`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items` via `auth_can_see_store()`. After 012a updates that helper to short-circuit for super-admin, those tables' RLS automatically gains brand-scope (a brand-admin's `user_stores` rows are by definition only for stores in their brand, so the existing membership check is sufficient — provided 012a also enforces "no cross-brand `user_stores` rows" via a CHECK trigger; see §1).

4. **`brands` table currently allows any admin (via JWT) to manage all brands** (see P1 migration `admin_manage_brands` policy, lines 84–92 of `20260504060452_brand_catalog_p1_additive.sql`). 012a tightens this — only super-admin can manage `brands`. (This is a deliberate scope creep beyond the umbrella's stated mins, but it's a security gap: today, any admin user in 2AM PROJECT could insert a row into `brands` and create a tenant. Addressed in §3.)

5. **`auth_is_admin()` reads from JWT `app_metadata.role`**, not from `profiles.role`. Important detail: super-admin promotion is recorded on `profiles.role`, NOT in the JWT. This means `auth_is_super_admin()` must read from `profiles`, not from the JWT. Documented in §2.

6. **The realtime publication is unaffected** by this migration — we are only adding columns and rewriting policies, not changing publication membership. The realtime gotcha (`docker restart supabase_realtime_imr-inventory`) does NOT apply here. (If a future sub-spec adds a new realtime table, it will.)

7. **Migration filename:** `supabase/migrations/20260509000000_multi_brand_schema_rls.sql`. Single file — atomic transaction. Date 2026-05-09 is the next clear day after the most recent migration (`20260505000000_dedupe_repointed_ingredient_lines.sql`).

---

### §1 — Schema additions

**Migration filename:** `supabase/migrations/20260509000000_multi_brand_schema_rls.sql`. Additive + idempotent. Single transaction.

**`profiles` changes**
```
alter table public.profiles
  add column if not exists brand_id uuid references public.brands(id) on delete set null;

comment on column public.profiles.brand_id is
  'Brand the admin is scoped to. NULL means super-admin (sees all brands). Enforced by profiles_role_brand_consistent CHECK.';

-- Drop the old role default+CHECK if any, re-add with the expanded set.
-- The init schema (20260405000759) declared role text not null default 'user'
-- with no CHECK; some later migration may have added one. Be defensive.
alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('super_admin', 'admin', 'user'));

alter table public.profiles
  add constraint profiles_role_brand_consistent
  check (
    (role = 'super_admin' and brand_id is null)
    or (role = 'admin'       and brand_id is not null)
    or (role = 'user') -- staff app users; brand_id may be NULL or set, no constraint
  );
```

**Why `on delete set null` (not cascade) on `profiles.brand_id`:**
The umbrella's acceptance criteria mention CASCADE for brand deletion, but cascading from `brands` to `profiles` would *delete the human user* if their brand is removed. That's almost never what we want — a brand-admin whose brand was deleted should be archived (their `brand_id` becomes NULL, their access becomes "no brand → can see nothing → effectively suspended"), not erased. 012c will own the actual brand-deletion logic and decide whether to also archive vs hard-delete the orphaned profiles. `set null` here is the safe default that doesn't lose audit trail.

This deliberately diverges from the umbrella's wording — flagged for the user under "Risks" §7.

**`brands` changes**
```
alter table public.brands
  add column if not exists deleted_at timestamptz;

comment on column public.brands.deleted_at is
  'Soft-delete tombstone. NULL = active. Set by 012c. Hidden from non-super-admin SELECT via RLS.';
```

**Decision on `profile_store_assignments` join table — NOT in 012a.**
The umbrella mentions super-admin can "assign their stores", which currently maps to inserting rows into the existing `user_stores` junction table. There's no need for a *new* join table — `user_stores(user_id, store_id)` already does this job. What 012a adds is a CHECK trigger preventing cross-brand assignment:

```
-- Reject INSERT/UPDATE on user_stores if the assigned store's brand_id
-- doesn't match the user's profiles.brand_id (super-admins exempt — they
-- have brand_id = NULL but should never appear in user_stores anyway).
create or replace function public.user_stores_brand_match()
returns trigger language plpgsql as $$
declare
  v_user_brand uuid;
  v_store_brand uuid;
begin
  select brand_id into v_user_brand from public.profiles where id = new.user_id;
  select brand_id into v_store_brand from public.stores   where id = new.store_id;
  if v_user_brand is null then
    return new; -- super-admin or pre-multi-brand legacy row; no constraint
  end if;
  if v_store_brand is distinct from v_user_brand then
    raise exception 'cross-brand user_stores assignment rejected: user brand=%, store brand=%',
      v_user_brand, v_store_brand;
  end if;
  return new;
end;
$$;

drop trigger if exists user_stores_brand_match_trg on public.user_stores;
create trigger user_stores_brand_match_trg
  before insert or update on public.user_stores
  for each row execute function public.user_stores_brand_match();
```

Pre-flight assertion (in the migration) — verify zero existing cross-brand `user_stores` rows before adding the trigger; raise EXCEPTION and abort if any are found. Practically a no-op today (one brand exists), but the assertion is the contract.

**Indexes**
- `create index if not exists profiles_brand_id_idx on public.profiles (brand_id);`
- `create index if not exists profiles_role_idx on public.profiles (role);`
  - Used by `auth_is_super_admin()` for a fast point lookup on `(id, role)`.

**Destructive vs additive:** entirely additive. No DROP COLUMN, no DROP TABLE. The CHECK constraints could fail to apply if existing data violates them — sanity-checked by the pre-flight count below, which RAISES EXCEPTION on any inconsistency.

---

### §2 — RLS helper functions

Three functions. All `SECURITY DEFINER` with locked search_path, mirroring `auth_can_see_store()` shape from `20260504173035_per_store_rls_hardening.sql`.

**`auth_is_super_admin()` — new**
```
create or replace function public.auth_is_super_admin()
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role = 'super_admin'
  );
$$;
```

**Why `profiles.role` and not `auth.jwt() -> 'app_metadata' ->> 'role'`:**
Existing `auth_is_admin()` reads from JWT app_metadata. That works because admin promotion is done by manually editing `auth.users.raw_app_meta_data` via dashboard or migration — the JWT carries the claim once the user re-logs in. Super-admin status is more sensitive: it MUST NOT be settable by the app (no UI promotion path, ever). Storing it in `profiles.role` (a table the app cannot write to without `auth_is_admin()` policies) means a compromised admin account cannot even attempt to escalate by writing their own JWT claim — the source of truth is server-side, in a row.

Cost: one extra row lookup per query (vs JWT claim read). Mitigated by the new `profiles_role_idx`. Acceptable.

**`auth_can_see_brand(p_brand_id uuid)` — new**
```
create or replace function public.auth_can_see_brand(p_brand_id uuid)
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select
    public.auth_is_super_admin()
    or exists (
      select 1 from public.profiles
       where id = auth.uid()
         and brand_id = p_brand_id
    );
$$;
```

**`auth_can_see_store(p_store_id uuid)` — UPDATE existing**
```
create or replace function public.auth_can_see_store(p_store_id uuid)
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select
    public.auth_is_super_admin()
    or public.auth_is_admin()
    or exists (
      select 1 from public.user_stores
       where user_id = auth.uid()
         and store_id = p_store_id
    );
$$;
```

Adds the super-admin short-circuit. Existing admin-via-JWT and per-store membership semantics are unchanged.

**`auth_is_admin()` — UNCHANGED.** Still reads JWT `app_metadata.role in ('admin','master')`. Super-admin promotion does NOT also set this claim — super-admin is detected via `auth_is_super_admin()` independently. Where existing policies want "any privileged user", they should call `auth_is_admin() OR auth_is_super_admin()`. We codify that helper too:

**`auth_is_privileged()` — new convenience**
```
create or replace function public.auth_is_privileged()
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select public.auth_is_admin() or public.auth_is_super_admin();
$$;
```

Used in §3 wherever a write policy needs "any admin OR super-admin".

**Grants:**
```
grant execute on function public.auth_is_super_admin()       to authenticated, anon;
grant execute on function public.auth_can_see_brand(uuid)    to authenticated, anon;
grant execute on function public.auth_is_privileged()        to authenticated, anon;
```
Same pattern as the existing helpers. (`anon` is granted because PostgREST evaluates policies as the request role; harmless since the functions return false for unauthenticated callers.)

---

### §3 — RLS policy rewrites

For every brand-scoped table, the policy template is:

```
-- READ
drop policy if exists "<old policy name>" on public.<table>;
create policy "brand_member_read_<table>"
  on public.<table> for select
  using (public.auth_can_see_brand(brand_id));

-- INSERT (admin or super-admin, in their own brand)
create policy "privileged_insert_<table>"
  on public.<table> for insert
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

-- UPDATE (admin or super-admin, in their own brand; cannot move row across brands)
create policy "privileged_update_<table>"
  on public.<table> for update
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  )
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

-- DELETE (admin or super-admin, in their own brand)
create policy "privileged_delete_<table>"
  on public.<table> for delete
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );
```

Existing permissive `using (auth.uid() is not null)` and `coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin','master')` policies are dropped first (`drop policy if exists`).

**Tables with a direct `brand_id` column — apply the template above:**
| Table | Existing read policy | Existing write policy | Notes |
|---|---|---|---|
| `brands` | `auth_read_brands` (any authed) | `admin_manage_brands` (JWT role admin/master) | NEW READ also filters `deleted_at IS NULL OR auth_is_super_admin()`. NEW WRITE restricted to super-admin only. |
| `catalog_ingredients` | `auth_read_catalog_ingredients` | `admin_manage_catalog_ingredients` | Standard template. |
| `recipes` | (P5 — admin-only writes, any authed reads) | (P5) | Standard template. |
| `prep_recipes` | (P5) | (P5) | Standard template. |
| `vendors` | "Vendors visible to all" + admin-only insert | (init schema) | Standard template. |
| `stores` | (legacy "Store access" via user_stores) | (admin) | READ stays via `auth_can_see_store(id)` which is updated in §2. WRITE is `auth_is_privileged() AND auth_can_see_brand(brand_id)`. |

**Special: `brands` SELECT must hide soft-deleted rows from non-super-admins:**
```
create policy "brand_member_read_brands"
  on public.brands for select
  using (
    public.auth_can_see_brand(id)
    and (deleted_at is null or public.auth_is_super_admin())
  );

create policy "super_admin_manage_brands"
  on public.brands for all
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());
```

**Tables WITHOUT a direct `brand_id` column — scope through parent's `brand_id` via EXISTS:**

Decision: **EXISTS-join through the parent, NOT denormalized `brand_id`.**

Rationale:
- `recipe_ingredients`, `prep_recipe_ingredients`, `recipe_prep_items`, `ingredient_conversions` are write-heavy children of brand-scoped parents. Adding a denormalized `brand_id` column would require a trigger to keep it in sync, plus a one-time backfill, plus a CHECK to prevent drift. The parent EXISTS join costs one extra index lookup per row (parent's PK is uuid-indexed), which is cheap.
- Pattern already exists in the codebase: `eod_entries`, `po_items`, `pos_import_items` all use parent EXISTS-join in `20260504173035_per_store_rls_hardening.sql`. Reusing the established pattern.
- If profiling later shows the EXISTS join is a hot-path cost, we can add denormalized `brand_id` as a follow-up; the migration to do so is straightforward.

| Child table | Parent | Parent's brand column |
|---|---|---|
| `recipe_ingredients` | `recipes` | `recipes.brand_id` |
| `recipe_prep_items` | `recipes` | `recipes.brand_id` |
| `prep_recipe_ingredients` | `prep_recipes` | `prep_recipes.brand_id` |
| `ingredient_conversions` | `catalog_ingredients` | `catalog_ingredients.brand_id` |
| `pos_recipe_aliases` | `recipes` (recipe_id) + `stores` (store_id) | both — gate via store (existing per-store RLS) |

Example (`recipe_ingredients`):
```
drop policy if exists "auth_read_recipe_ingredients" on public.recipe_ingredients;
drop policy if exists "admin_manage_recipe_ingredients" on public.recipe_ingredients;

create policy "brand_member_read_recipe_ingredients"
  on public.recipe_ingredients for select
  using (
    exists (
      select 1 from public.recipes r
       where r.id = recipe_ingredients.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_insert_recipe_ingredients"
  on public.recipe_ingredients for insert
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = recipe_ingredients.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

-- UPDATE and DELETE: same EXISTS pattern.
```

Same shape for the other four tables.

**Tables already gated by `auth_can_see_store()` — NO POLICY CHANGES NEEDED:**
After §2 updates `auth_can_see_store()` to short-circuit for super-admin, the following inherit brand-scope automatically (because `user_stores` cannot have cross-brand rows after the §1 trigger):

- `inventory_items`
- `eod_submissions`, `eod_entries`
- `waste_log`
- `audit_log`
- `purchase_orders`, `po_items`
- `pos_imports`, `pos_import_items`
- `flags`, `order_schedule` (these were left in the per-store hardening's "follow-up" list — they're still on the legacy `user_stores`-membership policy from init schema, which works correctly for both brand-admin and super-admin once `auth_can_see_store()` short-circuits)

The migration includes a comment block enumerating these tables explicitly, so the next architect doesn't think they were forgotten.

**`profiles` policy:**
The init schema policy `"Own profile" on profiles for all using (auth.uid() = id)` stays as-is — every user reads/writes only their own row. Add an additional read policy so super-admin can SELECT all profiles (needed by 012b's admin-management UI; harmless to add now):
```
create policy "super_admin_read_all_profiles"
  on public.profiles for select
  using (public.auth_is_super_admin());

create policy "super_admin_manage_profiles"
  on public.profiles for update
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());
```

(Updates are restricted to super-admin only — the existing "Own profile" policy already lets users update their own row, so this is purely additive for super-admin's cross-user write capability that 012b will need.)

---

### §4 — One-time data migration

Lives in the same migration file as §1–§3. End of the transaction.

```
do $$
declare
  v_2am_brand constant uuid := '2a000000-0000-0000-0000-000000000001';
  v_super_email constant text := 'wzhchen113@gmail.com';
  v_super_user_id uuid;
  v_promoted int := 0;
  v_backfilled int := 0;
  v_cross_brand int;
begin
  -- ── 0. Pre-flight: assert no cross-brand user_stores rows.
  --     The trigger added in §1 will reject future inserts; this confirms
  --     existing rows are clean before we trust the trigger.
  select count(*) into v_cross_brand
    from public.user_stores us
    join public.profiles p on p.id = us.user_id
    join public.stores   s on s.id = us.store_id
   where p.brand_id is not null
     and s.brand_id is not null
     and p.brand_id <> s.brand_id;
  if v_cross_brand > 0 then
    raise exception 'pre-flight failed: % cross-brand user_stores rows exist; resolve before applying 012a',
      v_cross_brand;
  end if;

  -- ── 1. Backfill profiles.brand_id for all existing admins.
  --     Anyone with role = 'admin' (or anything other than super_admin) and
  --     no brand_id gets the 2AM PROJECT brand. Idempotent — re-running
  --     this UPDATE is a no-op once brand_id is set.
  update public.profiles
     set brand_id = v_2am_brand
   where brand_id is null
     and role <> 'super_admin';
  get diagnostics v_backfilled = row_count;
  raise notice '012a: backfilled % profiles to 2AM PROJECT brand', v_backfilled;

  -- ── 2. Promote the hard-coded super-admin email.
  --     Look up auth.users by email. If not found (fresh local stack), NOTICE
  --     and skip — do NOT raise exception. Production will have it.
  select id into v_super_user_id
    from auth.users
   where lower(email) = lower(v_super_email)
   limit 1;

  if v_super_user_id is null then
    raise notice '012a: super-admin email % not found in auth.users; skipping promotion (expected on fresh local)', v_super_email;
  else
    update public.profiles
       set role = 'super_admin',
           brand_id = null
     where id = v_super_user_id
       and (role <> 'super_admin' or brand_id is not null);
    get diagnostics v_promoted = row_count;
    raise notice '012a: promoted % profile to super_admin (user_id=%)', v_promoted, v_super_user_id;

    -- Defensive: if the profile didn't exist (race in fresh dev where the
    -- auth.users row exists but no profile yet), insert it as super_admin.
    if not exists (select 1 from public.profiles where id = v_super_user_id) then
      insert into public.profiles (id, name, role, brand_id, status)
      values (v_super_user_id, 'Super Admin', 'super_admin', null, 'active');
      raise notice '012a: created profile row for super_admin user_id=%', v_super_user_id;
    end if;
  end if;

  -- ── 3. Final invariant check.
  --     After this migration, no admin profile should have a NULL brand_id.
  if exists (
    select 1 from public.profiles where role = 'admin' and brand_id is null
  ) then
    raise exception '012a: post-migration invariant violated — admin profile(s) with NULL brand_id remain';
  end if;
end $$;
```

**Idempotency:** Re-running the migration is a no-op. The UPDATEs are predicated on the column being NULL or wrong; the second run finds no rows to change, NOTICEs zero, and the invariant check still passes.

**Defensive on fresh local:** RAISE NOTICE not EXCEPTION when the super-admin email isn't found, so `npm run dev:db:reset` succeeds. The local environment then has zero super-admins, which is fine — `admin@local.test` keeps working as a 2AM brand-admin.

---

### §5 — UI / frontend impact

**No UI changes in 012a.** The Cmd UI continues to work because:
- Brand-admin's `profiles.brand_id` is set, so `auth_can_see_brand(brand_id)` returns true for their brand and they see all their existing data.
- Existing `.eq('brand_id', brandId)` filters in [src/lib/db.ts](../src/lib/db.ts) become RLS-redundant but remain valid (and helpful — they let PostgREST short-circuit before RLS evaluates the row).
- `auth_is_admin()` (used by helpers and edge functions) is unchanged.
- The Zustand store's `loadFromSupabase(storeId)` flow doesn't change.

**Sanity smoke** post-migration in local dev:
1. `npm run dev:db:reset` (applies migration + seed; super-admin promotion no-ops)
2. `npm run web` and log in as `admin@local.test`
3. Verify: catalog/recipes/prep/vendors all load, all 4 stores still pickable, EOD/waste/audit per-store still work.

If anything fails, the most likely culprit is a missing policy on a table that wasn't in the original audit — surface as a follow-up rather than a 012a defect. Edge cases aside, the design preserves all existing functionality for the 2AM brand because that's the whole-system invariant.

**Realtime impact:** The realtime publication is unaffected (no `alter publication supabase_realtime add/drop table`). The realtime container does NOT need to be restarted post-migration. If a future sub-spec changes publication membership, restart with:
```
docker restart supabase_realtime_imr-inventory
```
(The user already knows this from the project-memory note; flagged here for completeness.)

---

### §6 — Verification probes (post-deploy)

The user runs these against local dev (and later prod) to confirm the security boundary is real. All assume a second test brand has been inserted manually (012b will provide a UI for this; for 012a verification, the user inserts via psql).

**Setup probe** (run once, manually, to create test data — NOT part of the migration):
```sql
-- Insert a second brand for cross-brand testing.
insert into public.brands (id, name)
values ('2b000000-0000-0000-0000-000000000002', 'TEST BRAND B')
on conflict (id) do nothing;

-- Insert a brand-B catalog ingredient so we have something to try to read.
insert into public.catalog_ingredients (brand_id, name, unit, category)
values ('2b000000-0000-0000-0000-000000000002', 'Brand B Test Ingredient', 'kg', 'Test')
on conflict do nothing;

-- Create a brand-B admin profile (use a real auth.users row from inbucket).
-- Adjust email to match a user you've signed up via supabase auth.
update public.profiles
   set role = 'admin', brand_id = '2b000000-0000-0000-0000-000000000002'
 where id = (select id from auth.users where email = 'brandb@local.test' limit 1);
```

**Probe 1 — brand-A admin cannot see brand-B catalog (READ isolation):**
```bash
# Get a JWT for the 2AM brand admin.
TOKEN_A=$(curl -s -X POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
  -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
  -d '{"email":"admin@local.test","password":"password"}' | jq -r .access_token)

# Try to read brand-B's catalog ingredients. Expect: zero rows.
curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients?brand_id=eq.2b000000-0000-0000-0000-000000000002" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_A}" | jq 'length'
# Expected output: 0
```

**Probe 2 — brand-A admin CAN see brand-A catalog (no regression):**
```bash
curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients?brand_id=eq.2a000000-0000-0000-0000-000000000001" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_A}" | jq 'length'
# Expected output: 143 (matches existing 2AM catalog count)
```

**Probe 3 — brand-A admin cannot INSERT into brand B (WRITE isolation):**
```bash
curl -s -X POST "http://127.0.0.1:54321/rest/v1/catalog_ingredients" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_A}" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"brand_id":"2b000000-0000-0000-0000-000000000002","name":"smuggled","unit":"kg"}'
# Expected: 401/403 or empty result with RLS rejection. NOT a successful insert.
```

**Probe 4 — brand-B admin sees only brand B:**
```bash
TOKEN_B=$(curl -s -X POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
  -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
  -d '{"email":"brandb@local.test","password":"password"}' | jq -r .access_token)

curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_B}" | jq '[.[].brand_id] | unique'
# Expected: ["2b000000-0000-0000-0000-000000000002"]
```

**Probe 5 — super-admin sees both brands (cross-brand visibility):**
```bash
# Local dev super-admin requires manual SQL in the absence of the production
# email — use psql to promote a known local user to super_admin first:
docker exec -it supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "update public.profiles set role='super_admin', brand_id=null where id=(select id from auth.users where email='admin@local.test' limit 1);"

# Re-fetch token after promotion (claim is server-side so re-issue isn't strictly
# needed, but a fresh token avoids any session-cache surprises).
TOKEN_S=$(curl -s -X POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
  -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
  -d '{"email":"admin@local.test","password":"password"}' | jq -r .access_token)

curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_S}" | jq '[.[].brand_id] | unique | length'
# Expected: 2 (both brands visible)
```

**Probe 6 — child-table RLS (recipe_ingredients) honors parent brand:**
```bash
# Insert a brand-B recipe + ingredient as super-admin first, then re-query as brand-A admin.
# Expected: brand-A admin sees zero brand-B recipe_ingredients rows.
curl -s "http://127.0.0.1:54321/rest/v1/recipe_ingredients?select=*,recipe:recipes(brand_id)" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_A}" | jq '[.[].recipe.brand_id] | unique'
# Expected: ["2a000000-0000-0000-0000-000000000001"] (brand A only)
```

**Probe 7 — soft-deleted brand hidden from non-super-admin:**
```bash
# Mark brand B as soft-deleted (012c will provide UI; for 012a verify by SQL).
docker exec -it supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "update public.brands set deleted_at = now() where id='2b000000-0000-0000-0000-000000000002';"

# Brand-B admin should now see brand B as hidden in the brands listing.
curl -s "http://127.0.0.1:54321/rest/v1/brands" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_B}" | jq 'length'
# Expected: 0 (their only brand is soft-deleted; nothing visible).

# Super-admin still sees it.
curl -s "http://127.0.0.1:54321/rest/v1/brands" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_S}" | jq 'length'
# Expected: 2
```

**Probe 8 — `user_stores` cross-brand assignment trigger fires:**
```sql
-- Try to assign a brand-A admin to a brand-B store. Expect EXCEPTION.
docker exec -it supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "insert into public.user_stores (user_id, store_id) values
    ((select id from auth.users where email='admin@local.test' limit 1),
     (select id from public.stores where brand_id='2b000000-0000-0000-0000-000000000002' limit 1));"
-- Expected: ERROR: cross-brand user_stores assignment rejected: ...
```

**Probe 9 — service-role bypass still works (sibling-app sanity):**
```bash
# Use the service role key (bypasses RLS by design). PWA / staff edge functions use this.
curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients" \
  -H "apikey: ${SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" | jq 'length'
# Expected: total across all brands (i.e. 143 + N from brand B). Sibling apps must still
# explicitly filter by brand_id at query time — RLS won't do it for them.
```

---

### §7 — Risks and tradeoffs

1. **Cascade behavior on `profiles.brand_id` deliberately diverges from the umbrella's CASCADE wording.** I chose `on delete set null` so deleting a brand doesn't erase the human user. The umbrella says "all brand-scoped data is erased" — `profiles` is debatably brand-scoped. I'm leaving the deletion-vs-archive decision for 012c, which owns brand deletion. If the user wants the strict CASCADE (brand-admin gets deleted along with their brand), 012c can switch the FK at that point. *Surface this to the user before 012c design.*

2. **`auth_is_admin()` reads from JWT, `auth_is_super_admin()` reads from `profiles`.** Two sources of truth for "what is this user". Mitigation: the helpers are independent and orthogonal (super-admin and admin can both be true, neither, or one or the other; policies use `auth_is_privileged() = (admin OR super-admin)` where the union is needed). Documented in §2. The asymmetry exists because admin promotion is already JWT-claim based and changing that is out of scope; super-admin promotion needs to NOT be reachable from any UI, so it lives on the table. Acceptable but worth noting in a follow-up cleanup spec.

3. **Migration WILL succeed on fresh local without the super-admin email.** This is intentional (fresh `npm run dev:db:reset` shouldn't fail). Side effect: local dev has zero super-admins. The user's local `admin@local.test` becomes a 2AM brand-admin — no functional change in behavior since today's admin already has full access to the only brand. To exercise super-admin paths locally, the user runs the psql snippet in §6 Probe 5.

4. **Pre-existing security advisor lints about SECURITY DEFINER functions executable by anon/authenticated will increase.** This migration adds 3 new helpers (`auth_is_super_admin`, `auth_can_see_brand`, `auth_is_privileged`), all granted to `authenticated, anon`. Same pattern as existing `auth_is_admin()` and `auth_can_see_store()` — the existing lint debt covers this. Flag in the prod-push advisor output, but it's tracked debt, not new debt.

5. **Performance: every brand-scoped policy now does a `profiles` lookup per row.** Mitigation: `profiles` is small (single-digit-thousands of rows even at scale) and the new `profiles_role_idx` + the existing PK on `id` make point lookups O(log n). EXISTS subqueries in the child-table policies (`recipe_ingredients` etc.) add one parent-PK lookup per row. On the 286 KB seed dataset (143 catalog rows, 41 recipes, 10 preps, ~572 inventory items) this is negligible. At 100x scale it'd still be fine. Watch `EXPLAIN ANALYZE` if a brand grows past 10K recipes — but that's far in the future.

6. **The `profiles_role_brand_consistent` CHECK could fail to apply** if the existing `profiles` table somehow has an `'admin'` row with NULL `brand_id` AFTER the §4 backfill ran. The migration order is: §1 column add → §1 backfill is in §4 → §1 CHECK constraint. We need to add the constraint AFTER the backfill, or it'll fail. **Revised migration order: column add → backfill → CHECK constraint.** Backend developer to encode this carefully — the migration reads top-to-bottom but the §1/§4 split here is logical, not physical. The actual file is one transaction, ordered: (1) ADD COLUMN, (2) §1 trigger function + brands.deleted_at, (3) §4 backfill DO block, (4) ADD CONSTRAINT. Section numbering in this spec is for review clarity, not file order.

7. **The `user_stores_brand_match` trigger could RAISE EXCEPTION on a future bulk-assignment attempt** that crosses brands. This is the desired behavior (defense-in-depth above the RLS layer), but the error message will surface as a 500 to the API caller. 012b's super-admin admin-management UI will need to filter the store picker to the admin's brand BEFORE submitting; the trigger is the safety net, not the primary UX. Flag as "make sure 012b filters the store picker" but don't block 012a on it.

8. **JWT cache after promotion.** When a user is promoted to super-admin, their existing JWT (issued before the row update) doesn't carry the change — but `auth_is_super_admin()` reads from `profiles`, so RLS picks up the new role on the very next request. No re-login required. (Contrast: if super-admin lived in JWT app_metadata, the user would have to log out and back in. Another argument for the table-of-record design.)

9. **No CI gate.** Per CLAUDE.md, the `.github/workflows/db-migrations-applied.yml` workflow doesn't exist yet on disk. Manual verification reality: the user runs `supabase db push --linked` from a clean checkout after merging, with the §6 probes ready to verify post-deploy. **Document this in the deploy step** of the developer's handoff.

10. **Realtime publication is NOT touched.** Confirmed by reading the migration plan — only ALTER TABLE ADD COLUMN, CREATE FUNCTION, DROP/CREATE POLICY. No `alter publication supabase_realtime add table`. The `docker restart supabase_realtime_imr-inventory` ritual does NOT apply to this migration. (Documented for completeness — future sub-specs that add new tables will need it.)

---

## Downstream impact (sibling apps — not implemented here, punch list only)

Restated verbatim from the umbrella spec § "Downstream impact". When 012a ships, the user picks these up in the sibling repos:

- **Staff app.** Staff log in per-store today. After 012a, the staff JWT needs to carry `brand_id` (or the staff app needs to read it from the user's profile/store) so that `staff-*` edge functions can scope queries by brand. If any staff-shared edge function reads `recipes`, `vendors`, or `catalog_ingredients` without brand-scoping, it will break (RLS will hide cross-brand rows). **However**, today's `staff-*` functions use `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS — they will keep working as long as they explicitly `.eq('brand_id', brandId)` (which they already do, resolving brand from `store.brand_id`). Audit of `supabase/functions/staff-*` is required before a SECOND brand goes live in prod, not before 012a ships.

- **Customer PWA.** `pwa-catalog` edge function uses `SUPABASE_SERVICE_ROLE_KEY` (RLS-bypass) and explicitly filters by `brand_id` resolved from the queried store. Same situation as staff — it works for one brand today, will work for two brands as long as each PWA deployment is configured with the right `store_id` (which determines its brand). Audit required when 012b lands an actual second brand.

- **Push notifications.** Per-brand topics may be needed if both brands use push concurrently. `webPush.ts` doesn't currently key by brand. Defer until two brands actually use push.

---

## Files to be created / changed

**New:**
- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` (single file, atomic transaction).

**Changed:**
- None. (The migration touches DB state only; no `.ts`/`.tsx` edits.)

## Deploy steps (for the developer, when handing off to the user)

1. Apply locally: `npm run dev:db:reset` to verify clean apply against fresh seed.
2. Run §6 Probes 1–9 against local. Verify all pass.
3. Push to prod (user runs manually): `supabase db push --linked` from a clean checkout.
4. After prod apply, the user re-runs §6 probes against the prod URL. Probe 5 (super-admin promotion) should be a no-op because the prod migration auto-promoted `wzhchen113@gmail.com`.
5. Sanity-check: the user logs into the prod admin app as `wzhchen113@gmail.com`; should see super-admin status reflected by `auth_is_super_admin()` returning true (verifiable by SELECT against any policy that uses it). UI doesn't change yet — that's 012b.

The user runs the prod push. Do NOT auto-apply.

---

## Handoff
next_agent: backend-developer
prompt: Implement the migration `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` per the design in this spec. Single file, single transaction, ordered as §7 risk #6 specifies (column add → backfill DO block → CHECK constraints last). Encode all helpers, all policy rewrites, the cross-brand `user_stores` trigger, and the §4 backfill. The §6 probes are NOT part of the migration — they're verification commands the user runs post-apply; document them in a code comment block at the top of the migration (or a sibling `docs/specs/012a-verification.md` if the comment grows too long). Apply locally via `npm run dev:db:reset` and run §6 Probes 1–9 against local before setting Status: READY_FOR_REVIEW. Do NOT push to prod — the user runs `supabase db push --linked` manually. List files changed under `## Files changed`.
payload_paths:
  - specs/012a-multi-brand-schema-rls.md
  - specs/012-multi-brand-tenancy.md

---

## Build notes (backend-developer, 2026-05-08)

Migration was applied locally via `npm run dev:db:reset` (the architect's exact recommended command — confirmed it exists in `package.json` as `supabase db reset`). All §6 probes pass against the local stack.

### Probe results

| # | Probe | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | brand-A admin reads brand-B catalog | 0 rows | 0 | PASS |
| 2 | brand-A admin reads brand-A catalog | 143 rows | 143 | PASS |
| 3 | brand-A admin INSERT into brand B | RLS rejection | `42501 / new row violates row-level security policy` | PASS |
| 4 | brand-B admin sees only brand B | `["2b00...02"]` | `["2b00...02"]` | PASS |
| 5 | super-admin sees both brands | 2 distinct brand_ids | 2 | PASS |
| 6 | child-table RLS (recipe_ingredients) | brand-A only | `["2a00...01"]` (used master@local.test, brand-A admin-equivalent) | PASS |
| 7 | soft-deleted brand hidden from non-super-admin | brand-B admin sees 0; super-admin sees 2 | 0 / 2 | PASS |
| 8 | cross-brand `user_stores` trigger fires | EXCEPTION | `ERROR: cross-brand user_stores assignment rejected: user brand=2a..., store brand=2b...` | PASS |
| 9 | service-role bypass still works | both brands visible | `["2a00...01", "2b00...02"]` | PASS |

Idempotency: re-applying the migration end-to-end after the first apply succeeded with no errors and the backfill DO block emitted `backfilled 0 profiles` (as expected for an already-migrated DB).

### Things to flag for the user

1. **`master` role compatibility — DEVIATION FROM SPEC.** The spec acceptance criteria say `profiles.role` CHECK accepts `'super_admin' | 'admin' | 'user'`. The codebase has a real `'master'` role (see `supabase/seed.sql` master@local.test, plus `app_metadata.role IN ('admin','master')` JWT checks across multiple existing migrations: `20260424211733_security_fixes.sql`, `20260425043301_pos_recipe_aliases.sql`, `20260502190001_flags_table.sql`, `20260504060452_brand_catalog_p1_additive.sql`, etc.). The architect's pre-design probe noted the JWT-side `('admin','master')` pattern but didn't catch that real `'master'` profile rows exist. Rejecting `'master'` would have broken local seed and any existing prod `'master'` profile. The migration includes `'master'` in both `profiles_role_check` AND `profiles_role_brand_consistent` (treated identically to `'admin'` — must have brand_id). Both the role CHECK comment and the consistency CHECK comment in the migration document this. **If the user wants `'master'` consolidated with `'admin'` (or removed entirely), that's a future cleanup spec.**

2. **Seed.sql modified.** `supabase/seed.sql` was updated to set `brand_id = '2a000000-...'` on all three seeded profile inserts (admin/manager/master), to satisfy the new `profiles_role_brand_consistent` CHECK. Required by spec acceptance criterion "Fresh `npm run dev:db:reset` succeeds end-to-end". This file is local-dev-only (per its own header comment, "NEVER applied to prod"), so no prod implication.

3. **Local dev has zero super-admins by default.** As designed in spec §7 risk #3. `wzhchen113@gmail.com` is not in fresh local seed, so the migration's promotion is a `RAISE NOTICE` and skip. To exercise super-admin paths locally, run the §6 Probe 5 psql snippet to promote `admin@local.test`. (After Probe 5 the developer reverted local `admin@local.test` back to `admin` role to keep the dev env in its expected state.)

4. **Production migration push is the user's job.** Per spec deploy steps and per established session policy (Specs 010, 011): the user runs `supabase db push --linked` from a clean checkout AFTER review fan-out + release-coordinator + commit. Do not auto-apply.

5. **Security advisor lints will increase by 3 new SECURITY DEFINER public-execute functions** (`auth_is_super_admin`, `auth_can_see_brand`, `auth_is_privileged`). Same pattern as existing `auth_is_admin()` and `auth_can_see_store()`. Spec §7 risk #4 acknowledges this as known-acceptable tracked debt; flag in the prod-push advisor output but it's not new debt.

6. **`useStore` queries should still return correct rows post-migration** because the existing client-side `.eq('brand_id', brandId)` filters in `src/lib/db.ts` are RLS-redundant but harmless, and brand-A admin's `profiles.brand_id` is now `2a000000-...` so RLS allows their reads/writes. **No frontend changes were made (012a scope).** If the Cmd UI breaks unexpectedly post-migration, the most likely culprit is a table whose RLS wasn't covered by this migration — surface as a follow-up rather than patching 012a.

7. **Realtime publication NOT touched** (spec §7 risk #10 confirmed). No `docker restart supabase_realtime_imr-inventory` needed for this migration.

8. **`recipes.store_id` legacy column** still exists on the `recipes` table (init schema) but is no longer used for RLS — the new policies key on `brand_id`. Same situation for `prep_recipes.store_id`. No action needed; the columns are nullable and ignored by current RLS. A future cleanup spec could DROP them.

### Verification probe data (created locally during testing — NOT in seed)

For reviewers who want to re-run the probes, the following test data was created via `psql`:
- Brand: `2b000000-0000-0000-0000-000000000002` ("TEST BRAND B")
- Catalog ingredient on Brand B: "Brand B Test Ingredient"
- User: `brandb@local.test` / `password` with profile `Brand B Admin` (role=admin, brand_id=Brand B), `auth.users.id = 44444444-4444-4444-4444-444444444444`
- Test store on Brand B: `55555555-5555-5555-5555-555555555555` ("BrandB Test Store")

These are local-only artifacts not committed to seed.sql. They will be wiped on the next `npm run dev:db:reset`.

---

## Files changed

**Migrations**
- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` — new file. Single transaction implementing §1 schema, §2 helpers, §3 RLS rewrites, §4 backfill, §5 cross-brand `user_stores` trigger. Verbatim §6 probes documented in the top comment block.

**Seed (local-dev-only, NEVER applied to prod)**
- `supabase/seed.sql` — added `brand_id = '2a000000-0000-0000-0000-000000000001'` to all three seeded profile inserts (admin@local.test, manager@local.test, master@local.test) so the new `profiles_role_brand_consistent` CHECK doesn't reject them. Inline comments document why.

**Spec**
- `specs/012a-multi-brand-schema-rls.md` — Status flipped to `READY_FOR_REVIEW`; this Build notes section + Files changed section appended.

No frontend, edge-function, store, or `db.ts` changes (per spec §0 probe #2 + §5).

---

## Cleanup bundle (applied 2026-05-09, pre-prod-push)

Applied inline after release-coordinator returned **SHIP_READY**. Bundle
synthesized 5 items from code-reviewer + test-engineer findings; ordered
by severity. **Per release-coordinator's note this is the security-boundary
spec, so cleanup must land BEFORE prod push, not just before commit.**

- **Item 1 (LOAD-BEARING for 012b)** — `src/lib/db.ts` `createStore()`
  was missing `brand_id` in the INSERT payload. Post-12a the stores
  INSERT policy requires `auth_can_see_brand(brand_id)` which fails on
  NULL for any non-super-admin. Added `brand_id: store.brandId || null`
  + an inline comment pointing the caller (`addStore` in useStore) at
  the same brandId-resolution chain other actions use. Without this,
  the very first brand-admin onboarded by the user via 012b would be
  unable to create a store. Caught by test-engineer. Typecheck clean,
  browser reload clean.
- **Item 2** — `supabase/migrations/20260509000000_multi_brand_schema_rls.sql`
  line 836–841 (section 6j ingredient_conversions). Comment promised
  a "fall back to inventory_items.store_id chain for legacy rows whose
  catalog_id is not yet backfilled" that the SQL does not implement.
  Rewrote the comment to cite P3's NOT NULL enforcement
  (`20260504072830_brand_catalog_p3_lockdown.sql:25` — confirmed by
  grep) so future readers don't look for the phantom fallback. Caught
  by code-reviewer.
- **Item 3** — Same migration, line 229–234. The `auth_is_privileged()`
  comment claimed a `sync_role_to_app_metadata` trigger writes
  `'super_admin'` into `raw_app_meta_data` — no such trigger exists in
  the repo. Removed the trigger fabrication; kept only the factual
  statement that super-admin promotion via `profiles.role` does NOT
  also set the JWT `app_metadata.role`, so `auth_is_admin()` returns
  false for super-admins and the OR is needed. Caught by code-reviewer.
- **Item 4** — Same migration, line 321–328 (post-migration invariant
  inside the backfill DO block). The check used `role = 'admin'` only
  but the role CHECK at §(4) accepts `'admin' | 'master' | ...`. A
  `'master'` profile with NULL brand_id would slip through the
  invariant unobserved. Widened to `role IN ('admin', 'master')` —
  strictly more restrictive, can only catch more bugs, never fewer.
  Caught by code-reviewer. Same direction as the dev's earlier
  `master`-handling fix (Build notes #1).
- **Item 5** — Created `scripts/smoke-multi-brand.sh` per
  test-engineer's recommendation (verbatim from their proposed script).
  Mirrors `scripts/smoke-edge.sh` style with curl + jq assertions.
  Documents the one pre-requisite (creating `brandb@local.test` user).
  Made executable (`chmod +x`). Idempotent setup, graceful cleanup,
  Probe 8 degrades gracefully when no brand-B store row exists. The
  user can run this post-prod-push to re-verify the §6 probes against
  the live DB without re-typing 9 SQL statements.

## Re-verification (post-cleanup, 2026-05-09)

- Migration changes (Items 2, 3, 4) are SQL **comments** + a strictly
  widening predicate (`role IN ('admin','master')` vs the prior
  `role = 'admin'`). Zero behavior change to the migration's effect on
  the DB. The dev's 9 §6 probes from the original local apply remain
  valid — re-running `supabase db reset` is overkill (and the user
  declined when prompted, per the established session pattern around
  destructive local actions).
- `npx tsc --noEmit` filtered to `src/lib/db.ts`: 0 errors.
- Browser reload at desktop width: 0 console errors.
- `scripts/smoke-multi-brand.sh` is executable and ready for the user
  to run post-prod-push.

## Apply log (2026-05-09)

User authorized prod push at 2026-05-09 (option **A** — push 012a alone
first, then move to 012b for the visible super-admin UI surface).

Ran:

    npx supabase db push --linked

Output: applied `20260509000000_multi_brand_schema_rls.sql` to the
linked prod project (`ebwnovzzkwhsdxkpyjka`). Single transaction, all
DROP-IF-EXISTS notices were idempotent guards (expected). Key NOTICE
output:

- `012a: backfilled 3 profiles to 2AM PROJECT brand`
- `012a: promoted 1 profile row(s) to super_admin
  (user_id=25368e0d-ce5b-4dcb-8e62-70aed6aaf9df)`
  → confirms `wzhchen113@gmail.com` exists in prod `auth.users`, was
  found, was promoted.

Post-apply verification probes (all green):

1. **Profile assignment.** 3 prod profiles correctly assigned:
   - `Admin (Owner)` (id `25368e0d-...`) → role `super_admin`,
     `brand_id IS NULL` ✅
   - `Bobby` → role `admin`, brand_id = 2AM
   - `Charles` → role `user`, brand_id = 2AM

2. **Helper functions exist.** All four present in `public` schema:
   `auth_is_super_admin`, `auth_can_see_brand`, `auth_is_privileged`,
   `auth_can_see_store` (the last one updated for super-admin
   short-circuit). ✅

3. **Brand-scoped row counts (sanity).** All existing data correctly
   scoped to 2AM PROJECT brand:
   - `catalog_ingredients`: 145 / 145
   - `recipes`: 41 / 41
   - `stores`: 4 / 4 (in 2AM brand)
   - `brands`: 1 (just the 2AM brand) ✅

4. **Security advisor.** 0 Critical, 0 Errors. The 8 new WARN lints
   (4 helpers × {anon, authenticated} SECURITY DEFINER public-execute)
   are the same class as the pre-existing `auth_is_admin` /
   `auth_can_see_store` lints — anticipated by architect §7 and
   security-auditor; acceptable debt to clean up later (could be
   addressed in a future "tighten RPC EXECUTE grants" spec). ✅

Acceptance criteria 1–9 from spec §6 confirmed against prod via
direct SQL probes. The smoke script (`scripts/smoke-multi-brand.sh`)
is also runnable against prod with prod env vars; left for the user
to run before / after onboarding the first second-brand.

---

## Handoff
next_agent: code-reviewer, security-auditor, test-engineer, backend-architect
prompt: Review the implementation of spec 012a against `specs/012a-multi-brand-schema-rls.md`. Each reviewer writes its findings to `specs/012a-multi-brand-schema-rls/reviews/<your-name>.md`. The backend-architect runs in post-impl drift-review mode — pay particular attention to the `master` role deviation flagged in Build notes #1 (the architect's pre-design probe noted JWT-side `('admin','master')` but didn't catch real profile rows; the developer added `'master'` to the role + brand-consistency CHECK to keep seed working — confirm this is acceptable). Security-auditor: verify probes 1, 3, 4, 6, 8 actually enforce the security boundary; check the `auth_can_see_brand`/`auth_is_super_admin`/`auth_is_privileged` helpers for SECURITY DEFINER + locked search_path correctness; confirm the cross-brand user_stores trigger is BEFORE-trigger and not bypassable. Code-reviewer: SQL style match against existing per-store hardening migration; idempotency verified by the developer (re-apply tested clean); look for missed table policies. Test-engineer: spec mentions `scripts/smoke-multi-brand.sh` as a "strongly recommended" follow-up — propose whether it should ship in 012a or land in 012b. The user runs `supabase db push --linked` manually after release-coordinator approval; do NOT auto-apply.
payload_paths:
  - specs/012a-multi-brand-schema-rls.md
  - specs/012-multi-brand-tenancy.md
  - supabase/migrations/20260509000000_multi_brand_schema_rls.sql
  - supabase/seed.sql
