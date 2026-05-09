# Spec 012: Multi-brand tenancy + super-admin + brand-scoped admin permissions (umbrella)

Status: READY_FOR_ARCH

> **Umbrella spec.** Scope is too large to ship as one PR. The architect is
> expected to split this into sub-specs (suggested phasing in section
> "Phasing / sub-spec split"). Each sub-spec gets its own design + build +
> review pass. This umbrella locks in the *decisions* and the *invariants*
> that all sub-specs must respect.

## User story

As the owner of multiple restaurant brands (e.g. "2AM PROJECT" and
"Baltimore Seafood") sharing one Supabase backend, I want each brand to be
a fully-isolated tenant — its own catalog, recipes, preps, menu, vendors,
stores, and inventory — so that a brand-admin can only see and modify their
own brand's data, and so deleting a brand erases all of its data without
collateral damage to other brands.

As the platform owner, I want a super-admin role (held by me) that can
create and delete brands, invite/suspend/delete admins, and assign each
admin to a brand and to specific stores within that brand.

## Acceptance criteria

These are invariants for the umbrella. Each sub-spec will refine them into
testable conditions for its slice.

### Tenancy + isolation
- [ ] A row in any brand-scoped table (`catalog_ingredients`, `recipes`,
  `prep_recipes`, `vendors`, `stores`, and anything that transitively
  inherits brand via FK) is reachable via PostgREST/RPC by an authenticated
  user **only if** that user's `brand_id` matches the row's `brand_id`, or
  the user is `super_admin`.
- [ ] A brand-admin attempting `GET /rest/v1/recipes?select=*` while logged
  in to brand A returns zero brand-B rows (verified by curl bypassing the
  client-side filter).
- [ ] `auth_can_see_brand(brand_id uuid)` SQL helper exists, mirrors the
  shape of `auth_can_see_store()`, and is used by every brand-scoped RLS
  policy.
- [ ] `auth_is_super_admin()` SQL helper exists. `auth_is_admin()` keeps
  its current contract (admin OR super_admin both pass it) so existing
  call sites don't silently lose access.

### Roles + assignment
- [ ] Three roles exist on `profiles.role`: `super_admin`, `admin`, `user`
  (the `user` row is reserved for the staff app — admin app does not
  surface it, but the column needs to accept it).
- [ ] `profiles.brand_id uuid` column exists. `super_admin` profiles have
  `brand_id IS NULL` (cross-brand). `admin` profiles MUST have `brand_id
  NOT NULL` (enforced by CHECK).
- [ ] `user_stores` rows for a brand-admin are constrained to stores
  whose `brand_id` matches the admin's `brand_id` (enforced by CHECK or
  trigger; cross-brand store assignment is rejected at the DB layer).

### Super-admin capabilities (UI + RPC)
- [ ] Super-admin UI surface ships under a new Cmd UI section (working
  name: **"Tenants"**, sidebar item visible only when
  `auth_is_super_admin()` is true) at `src/screens/cmd/sections/`.
- [ ] Super-admin can: create brand, soft-delete brand, hard-delete brand
  (with grace period — see "Brand deletion" below), invite admin (assigned
  to a brand at invite time), suspend admin, delete admin, assign admin to
  stores within their brand, switch the active brand context for their own
  session.
- [ ] Brand creation seeds the new brand with: empty catalog, empty
  vendors, empty recipes/preps, zero stores. No 2AM PROJECT data leaks
  into the new brand.

### Brand deletion
- [ ] Brand deletion is a two-step flow: soft-delete (`brands.deleted_at`
  set, RLS hides it from everyone except super-admin) → hard-delete after
  a grace period.
- [ ] Hard-delete cascades through every brand-scoped FK and erases all
  rows: `catalog_ingredients` (already CASCADE), `vendors`, `stores`
  (and all per-store data — `inventory_items`, `eod_submissions`,
  `eod_entries`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`,
  `pos_imports`, `pos_import_items`, `flags`, `order_schedule`),
  `recipes`, `recipe_ingredients`, `recipe_prep_items`, `prep_recipes`,
  `prep_recipe_ingredients`, `pos_recipe_aliases`, `ingredient_conversions`
  (via catalog FK), and any `profiles` whose `brand_id` matches (deleted)
  or reassigned to NULL with status `archived` — TBD per question 12 below.
- [ ] Hard-delete is gated by a typed-confirmation prompt
  (super-admin types the brand name).
- [ ] No table is silently exempt; the architect's design doc must
  enumerate every table with `brand_id` (direct or transitive) and
  declare its delete behavior (CASCADE / SET NULL / RESTRICT / archive).

### First super-admin onboarding
- [ ] One-time SQL migration grants `super_admin` to a single
  hard-coded email address (the user's). No UI path to promote anyone to
  super-admin ever exists; subsequent super-admin grants are dashboard SQL
  only (intentional — see Q2 resolution below).

### Backwards compatibility
- [ ] Every existing 2AM PROJECT row (144 catalog ingredients, all stores,
  all recipes/preps, all profiles) keeps its current `brand_id` of
  `2a000000-0000-0000-0000-000000000001` and remains reachable to its
  current admin users with no functional regression.
- [ ] Existing `admin`-role profiles are migrated to `admin` with
  `brand_id = '2a000000-...'` (i.e., they become 2AM PROJECT brand-admins,
  not super-admins) by the same migration, except the one hard-coded
  super-admin email.
- [ ] The existing per-store RLS hardening from
  `20260504173035_per_store_rls_hardening.sql` remains in force; the
  brand-scope check is *added* on top, not a replacement.

## In scope

- New SQL: `auth_can_see_brand()`, `auth_is_super_admin()` helpers.
- Schema: `profiles.brand_id`, `profiles.role` accepting `super_admin`,
  `brands.deleted_at` for soft-delete, CHECK constraints for role/brand
  consistency, CASCADE FKs for brand deletion.
- RLS hardening on every brand-scoped table to filter by
  `auth_can_see_brand(brand_id)`.
- Super-admin UI section (Cmd UI only — no legacy AdminScreens.tsx work).
- Brand picker for super-admin (active-brand context switch in their own
  session — likely a header dropdown when role = super_admin).
- Admin invitation flow extended to take `brand_id` + initial store
  assignments.
- Brand soft-delete + hard-delete RPC/edge function with typed-name
  confirmation.
- One-time data migration: backfill `profiles.brand_id`, promote
  hard-coded email to `super_admin`.
- Realtime: `useRealtimeSync` already takes a `brandId` arg; verify it
  flows from the active-brand context (store assignment will need a one-line
  update if it currently hardcodes the 2AM brand id).

## Out of scope (explicitly)

- **Per-section permission grants** (e.g. "admin X can edit menu but not
  delete vendors"). The user said "assign their stores and permissions"
  but the resolved decision is brand + store scope ONLY for v1; per-section
  ACLs are deferred to a later spec. See Q1 resolution.
- **Cross-brand catalog sharing.** Each brand owns its own
  `catalog_ingredients`. Salt at brand A and salt at brand B are
  independent rows, even if SKU is identical. See Q5 resolution.
- **Staff app changes.** The staff app lives in a sibling repo. This spec
  flags the downstream punch list but does not implement it. See
  "Downstream impact" below.
- **Customer PWA changes.** Same — sibling repo, downstream punch list.
- **Soft-delete of admins.** Suspending an admin is an in-place status
  change (`profiles.status = 'suspended'`), not a soft-delete. Hard-delete
  is allowed but a confirmation prompt is required.
- **Multi-brand membership for one user.** A profile has exactly one
  `brand_id` (or NULL if super-admin). A user who needs to admin two
  brands needs two accounts. Revisit only if the platform actually grows.
- **Restoring soft-deleted brands.** Soft-delete → hard-delete is one-way
  (the grace period exists for "oops" undo within the window, but no
  long-tail restore flow). Restore-from-soft-delete during the grace
  window is in scope; restore after hard-delete is not.
- **Audit/compliance retention strategy** for hard-deleted brand data.
  Hard-delete means hard-delete. If long-term retention is needed for
  legal reasons that's a separate spec (export-before-delete tooling).
- **App.json slug or app store identifier changes** triggered by
  multi-brand. Each brand does NOT get its own iOS/Android binary in this
  spec; they share the IMR admin app and switch in-app.
- **Test framework introduction.** Multi-brand is the right time to add
  one but it's a separate decision; this spec assumes manual + smoke-test
  verification per existing project norm. Test-engineer reviewer will
  surface this as a recommendation, not a blocker.

## Open questions resolved

- **Q1 — Permission granularity.** *PM default applied; user can override.*
  → A: **Brand + store scope only for v1.** No per-section ACLs. Rationale:
  The existing model is "admin can do anything to data they can see"; the
  user's stated need is satisfied by gating *what* an admin can see, not
  *what they can do with it*. Per-section grants are a much larger surface
  (every RPC + every table + every UI action checks a capability matrix)
  and would balloon scope. If the user wants this anyway, surface before
  architect handoff.

- **Q2 — Super-admin onboarding.** → A: **Hard-coded email in a one-time
  migration.** Migration UPDATEs `profiles.role = 'super_admin'` WHERE
  `email = '<user's email>'`. No UI path to promote. Subsequent
  super-admin grants are intentionally manual SQL — there should be no way
  for a compromised admin account to escalate to super-admin via the app.
  *PM needs the user's email to write the migration.* See Open questions
  below.

- **Q3 — Cascade delete behavior.** → A: **Hard delete cascades
  everything brand-scoped, including audit_events, eod_submissions,
  pos_imports.** User confirmed "if one day I need to delete a brand
  their entire schema database should be erased." The two-step
  soft-delete → grace period → hard-delete pattern provides the
  safety net. Compliance retention is out of scope (see "Out of scope").

- **Q4 — Migration plan for the existing brand.** → A: One migration
  does everything: (1) add `profiles.brand_id`, (2) backfill all existing
  profiles to `brand_id = '2a000000-...'`, (3) promote the hard-coded
  super-admin email, (4) add CHECK constraints, (5) flip RLS policies.
  Atomic. Sanity-counts at the end like the brand-catalog phase 2
  migration.

- **Q5 — Cross-brand catalog sharing.** → A: **No sharing.** Each brand
  has its own `catalog_ingredients` rows. The schema today already does
  this (`catalog_ingredients.brand_id NOT NULL`). Confirms current
  design.

- **Q6 — UI surface for super-admin.** → A: **New Cmd UI section
  "Tenants" in the sidebar**, visible only when role = super_admin.
  Plus a header brand-picker dropdown for super-admin (so they can
  context-switch into a brand to debug it). Brand-admins see no change
  in chrome — the brand they're scoped to is implicit.

- **Q7 — Brand-admin invitation flow.** → A: Extend the existing
  `consume_invitation` RPC + invitation table with `brand_id` and
  `initial_store_ids[]`. No UI rebuild required if the existing flow has
  an admin-form to send invites; just add the brand picker (super-admin
  only) and store multiselect to the form. Architect to confirm against
  the actual invitation surface.

- **Q8 — Realtime impact.** → A: `useRealtimeSync` already accepts a
  `brandId` argument and subscribes to `brand-{brandId}`. The wiring at
  the call site (`CmdNavigator.tsx`) needs to read the current brand
  from the active-brand context (super-admin: from picker; brand-admin:
  from `profiles.brand_id`). Realtime publication gotcha applies as
  always (see CLAUDE.md memory note) — re-snapshot the slot if a
  publication change is part of the migration.

- **Q9 — Brand deletion confirmation UX.** → A: **Type-the-brand-name
  confirmation + 30-day soft-delete grace window before hard-delete.**
  Soft-delete is reversible (super-admin restore button) within 30 days;
  hard-delete is NOT reversible. Hard-delete after grace requires the
  super-admin to type the brand name a second time. PM defaults applied;
  user can shorten/lengthen the window.

- **Q10 — Sibling-app coordination.** → A: Out of scope for this spec
  but enumerated below. Architect's design doc must include the
  downstream punch list verbatim.

- **Q11 — P4 of the brand-catalog refactor.** → A: P4 was the *frontend
  code change* (`src/lib/db.ts` + Zustand store reads) that started using
  `catalog_id` instead of `item_id`. It landed as a regular code commit,
  not as a SQL migration, which is why the migration sequence skips
  P4 — there was nothing for it to *do* in SQL. Confirmed by reading
  the P3 header ("Run only after the Phase 4 commit (57a7821) is in
  place"). Not a blocker; documenting for the architect.

## Open questions for the user — RESOLVED 2026-05-09

All four answered by the user; recorded here so architect can build against
them without re-asking.

- **Q-USER-1 — Hard-coded super-admin email.** **`wzhchen113@gmail.com`**
  (same as the user's git identity). The 012a one-time migration grants
  `super_admin` to this email's `auth.users.id` via the `profiles.role`
  column. Locked in.
- **Q-USER-2 — Permission granularity confirmation.** **Brand + store
  scope only, no per-section ACLs** (PM default accepted). Brand-admins
  get full read/write on their assigned brand and stores; no per-section
  capability matrix. If the user later wants "admin X cannot delete
  vendors" granularity, that's a future spec layered on top.
- **Q-USER-3 — Soft-delete grace period.** **30 days** (PM default
  accepted). Soft-deleted brands are hidden from the active picker but
  restorable for 30 days; after that a daily job (or manual super-admin
  purge button) hard-deletes via cascade.
- **Q-USER-4 — Sub-spec split.** **012a → 012b → 012c, shipped in that
  order** (PM default accepted). 012a (schema + RLS + migration) MUST
  ship alone first because it's the security boundary. 012b adds the
  super-admin Cmd UI + brand picker. 012c adds the destructive
  soft-delete / hard-delete / restore UX last.

## Phasing / sub-spec split (recommended for the architect)

The architect should split this umbrella into the following sub-specs.
Order matters — each builds on the previous:

1. **012a — Schema + RLS + data migration.** Adds `profiles.brand_id`,
   `auth_can_see_brand()`, `auth_is_super_admin()`, RLS policies on every
   brand-scoped table, CHECK constraints, FK CASCADE updates, one-time
   data migration (backfill all existing profiles, promote super-admin
   email). No UI changes. Verifiable with curl: brand-admin in brand A
   cannot read brand B rows. *Ship this alone first to lock down the
   security boundary before any UI lands.*

2. **012b — Super-admin Cmd UI section + brand picker.** New "Tenants"
   sidebar item, brand picker in the header for super-admin, admin
   invitation form extended with brand + store assignment. Read-only
   listing of brands and admins. No delete UX yet. *Ship this so the
   super-admin can manage tenants before adding the destructive flows.*

3. **012c — Brand soft-delete + hard-delete + restore.** Full destructive
   UX with grace window, typed-name confirmation, restore button. Edge
   function or RPC for the cascade. *Ship last because it's the highest
   blast radius.*

The architect can collapse 012b + 012c if the UI surface is small enough,
but 012a MUST ship alone because it's the security boundary.

## Dependencies

- Existing `brands` table (already in place, P1 migration).
- Existing `auth_is_admin()` helper (will be extended, not replaced).
- Existing `auth_can_see_store()` helper (the brand check sits ABOVE
  this; both must pass for store-scoped access).
- Existing `consume_invitation` RPC (will be extended in 012b).
- `useRealtimeSync` already takes `brandId` (no change to the hook itself,
  just the call site wiring).
- The user's email address (blocking question Q-USER-1).
- No new third-party libraries.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. New "Tenants" section under
  `src/screens/cmd/sections/`. **Will not touch `AdminScreens.tsx`.**
- **Per-store or admin-global:** Both. The brand boundary is *above* the
  per-store boundary. Super-admin is global; brand-admin is per-brand;
  store-membership remains per-store within the admin's brand.
- **Realtime channels touched:** `brand-{brandId}` already exists.
  Verify the brand id flows from the active-brand context, not a
  hardcoded 2AM constant. Realtime publication gotcha applies — if RLS
  changes touch the publication, `docker restart
  supabase_realtime_imr-inventory` is required after the migration runs.
- **Migrations needed:** Yes — at minimum: profiles schema bump, helpers,
  RLS rewrites on every brand-scoped table, CHECK constraints, FK
  CASCADE updates, one-time data backfill. Architect's design will
  enumerate.
- **Edge functions touched:** `consume_invitation` likely. A new
  `delete-brand` edge function may be the cleanest place to put the
  cascade orchestration (it's destructive enough that it should live
  outside RLS-as-policy and behave as a controlled service action).
  Architect to decide RPC-vs-edge.
- **Web/native scope:** Web first (super-admin will mostly use desktop).
  Native should keep working (no new mobile-only UI required) but the
  sidebar visibility check needs to render correctly on both.
- **`app.json` slug:** No change. Each brand does not get its own
  binary; they share the IMR admin app.
- **Tests:** No test framework yet. Critical security boundary —
  test-engineer should propose at minimum a smoke-test script
  (`scripts/smoke-multi-brand.sh`) that creates two brands, two
  brand-admins, and curls each one's PostgREST surface to verify zero
  cross-brand leakage. PM flagging as non-blocking but strongly
  recommended.

## Downstream impact (sibling apps — not implemented here, punch list only)

When 012a ships, the following will need follow-up work in the sibling
repos. The user picks these up when they touch those repos. Architect's
design doc should restate this list verbatim:

- **Staff app.** Staff log in per-store today. After 012a, the staff JWT
  needs to carry `brand_id` (or the staff app needs to read it from the
  user's profile/store) so that `staff-*` edge functions can scope queries
  by brand. If any staff-shared edge function reads `recipes`, `vendors`,
  or `catalog_ingredients` without brand-scoping, it will break (RLS will
  hide cross-brand rows). Audit of `supabase/functions/staff-*` against
  the new RLS policies is required before deploying 012a to prod.
- **Customer PWA.** `pwa-catalog` edge function uses a service-token bearer
  and bypasses RLS. After 012a, this function must explicitly filter by
  the brand it's serving (likely via a query param, an env var per
  deployment, or a brand subdomain). Today it implicitly serves the only
  existing brand. Audit of `supabase/functions/pwa-catalog/` is required.
- **Push notifications.** Per-brand topics may be needed if both brands
  use push concurrently. `webPush.ts` doesn't currently key by brand.
  Defer until two brands actually use push.

## Risks

- **Two-app deploy coupling.** Shipping 012a to prod without auditing the
  sibling staff/PWA repos can take staff/PWA traffic offline for the new
  brand (or for the existing brand if a service-token edge function
  loses access to data it expected). Mitigation: 012a deploy is
  explicitly gated on the sibling-app audit.
- **Realtime publication snapshot.** RLS changes mid-session require a
  realtime container restart. Documented but easy to forget on prod.
- **Hard-delete blast radius.** A super-admin clicking through the
  typed-name confirm in haste could nuke real revenue/audit data with no
  recovery. Mitigation: 30-day soft-delete grace window. Could also
  require a second super-admin (if there's ever more than one) — out of
  scope for v1.
- **Profile + store cross-brand drift.** Existing `user_stores` rows are
  not currently constrained to be same-brand. Migration must verify zero
  cross-brand `user_stores` rows exist before adding the CHECK, or the
  CHECK will fail to apply. (In practice: today every store is in the
  one brand, so this should be a no-op, but the migration should assert
  it.)

## Definition of done (umbrella)

This umbrella is DONE when 012a + 012b + 012c are all merged and:
- Two brands exist in prod (real "Baltimore Seafood" or a test brand).
- One brand-admin scoped to each brand has been invited and has logged in.
- Cross-brand read attempts return zero rows (verified by curl).
- Brand soft-delete + restore + hard-delete have been exercised on a
  throwaway test brand.
- The sibling-app punch list has been handed to the user (with the user
  acknowledging it's their follow-up, not the admin app's).
