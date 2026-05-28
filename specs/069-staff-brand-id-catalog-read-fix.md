# Spec 069: Staff EOD count shows blank ingredient names — NULL-brand staff can't read brand-scoped catalog

Status: READY_FOR_REVIEW

## Severity

**P0 — complete breakage of the staff EOD count feature in production.** Specs
061/062 shipped the staff end-of-day count app; spec 063 folded it into this
repo. As of now, an invited staff user (`profiles.role = 'user'`) who opens the
EOD Count screen sees the correct NUMBER of input rows but EVERY ingredient
name label is blank — they cannot tell what they are counting. The feature is
unusable for the exact user it was built for. This is also **security-adjacent**:
the root cause is the cross-brand RLS access model, so the review fan-out MUST
include **security-auditor**.

## Problem statement

### User's findings (verbatim symptom)

- A staff user (role=`user`) signs into the EOD Count screen. It renders the
  right NUMBER of input rows (29 for the Charles store) but EVERY ingredient
  name label is BLANK — the row reads "Count for " with nothing after it.
- The query
  `inventory_items?select=id,vendor_id,catalog:catalog_ingredients(name,unit)&store_id=eq.<Charles>`
  returns HTTP 200 with 29 rows, BUT the embedded `catalog` object is `null` on
  every row.
- Classic PostgREST behavior: the parent SELECT (`inventory_items`) passes, the
  embedded SELECT (`catalog_ingredients`) is RLS-blocked → the embedded resource
  returns `null` instead of erroring. The parent rows still come back, so the
  list renders the right count with empty names.

### Root cause (confirmed by main Claude's prod queries — recorded verbatim)

- `catalog_ingredients` SELECT policy is `brand_member_read_catalog_ingredients`
  with qual `auth_can_see_brand(brand_id)`
  (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:446-448`).
- `auth_can_see_brand(p_brand_id)` =
  `auth_is_super_admin() OR exists(select 1 from profiles where id = auth.uid() and brand_id = p_brand_id)`
  (`20260509000000_…:200-210`).
- The prod staff user has `profiles.brand_id = NULL` but is assigned (via
  `user_stores`) to a store in the 2AM PROJECT brand. So
  `auth_can_see_brand(2AM)` returns FALSE — `NULL = 2AM` is never true, and the
  user is not a super_admin → `catalog_ingredients` is blocked → blank names.

### The asymmetry (the heart of the bug)

Two different visibility checks gate the two tables the EOD list joins, and they
disagree for NULL-brand staff:

| Table              | Scope kind   | RLS predicate                | NULL-brand staff result |
|--------------------|--------------|------------------------------|-------------------------|
| `inventory_items`  | store-scoped | `auth_can_see_store(store_id)` → checks `user_stores` membership | PASSES (they are a member) |
| `catalog_ingredients` | brand-scoped | `auth_can_see_brand(brand_id)` → checks `profiles.brand_id` | FAILS (their brand_id is NULL) |

The parent passes and the embed fails, which is exactly why the screen renders
the row count but no names.

### This is the SAME NULL-brand-staff root cause as spec 068

Spec 068 just hardened the `user_stores` brand-match trigger
(`20260528010000_user_stores_brand_match_null_brand_guard.sql`) — that trigger's
own design notes (and §4 of spec 068) document that the invite→register path
emits `profiles.brand_id = NULL` for `role='user'` staff invites, and that
`profiles_role_brand_consistent` (`20260509000000_…:347`) explicitly ADMITS
`role='user'` with NULL brand_id. Spec 061's §0 ruling ("staff can read
brand-shared catalog data") was effectively WRONG for real invited staff: its
pgTAP fixture (Tara Manager) had a `brand_id` set (`seed.sql:118-120`, a
seed-author choice), so it never exercised the NULL-brand path that the
production invite flow actually produces.

### PM code survey — which brand-scoped reads the staff app actually performs

The staff EOD surface (`src/screens/staff/screens/EODCount.tsx`) issues exactly
three Supabase reads. Surveyed verbatim:

1. **`order_schedule`** (line 90, `fetchVendorsForToday`) — store-scoped via
   `auth_can_see_store()` (audit note `20260509000000_…:1010`). PASSES for
   staff. **BUT it embeds `vendor:vendors(id, name)` (line 91), and `vendors`
   is ALSO `auth_can_see_brand`-gated** (policy `brand_member_read_vendors`,
   `20260509000000_…:575-577`). So the embedded `vendor` object is ALSO `null`
   for NULL-brand staff. Today this is masked because the code falls back to
   `r.vendor_name` — the denormalized snapshot column on `order_schedule`
   (line 106) — so vendor names still appear. This is a **latent second
   instance of the same bug class**, currently hidden by a fallback.
2. **`inventory_items`** (line 121, `fetchItemsForVendor`) — store-scoped,
   PASSES; embeds `catalog:catalog_ingredients(name, unit)` (line 122) which is
   `auth_can_see_brand`-gated → **THE VISIBLE BUG** (no denormalized fallback
   for the name, so it renders blank).
3. **`eod_submissions`** (line 150, `fetchExistingSubmission`) — store-scoped,
   PASSES; embeds `eod_entries(...)` (also store-scoped). No brand-gated read.

**Conclusion for scope:** in v1 the staff app touches exactly TWO
`auth_can_see_brand`-gated tables — `catalog_ingredients` (visible breakage)
and `vendors` (latent, fallback-masked). It does NOT currently query `recipes`,
`prep_recipes`, or `ingredient_conversions` (confirmed: no `.from('recipes')`
etc. anywhere under `src/screens/staff/`). Both broken embeds derive from the
SAME NULL-brand-vs-`auth_can_see_brand` asymmetry; either fix approach below
closes BOTH at once.

## User story

As a staff member doing an end-of-day count, I need to see the ingredient name
(and unit) next to each input row, so I know what I am counting and can enter
accurate remaining quantities.

## Two fix approaches (the architect decides; both are laid out)

The architect MUST evaluate blast radius and pick **A**, **B**, or a documented
hybrid, then surface the recommendation for user approval before build (per
Open question #1 below). Both approaches close the full bug class (both the
`catalog_ingredients` and `vendors` embeds).

### Option A (root-cause; PM lean) — give invited staff a `brand_id`

- **Backfill** existing NULL-brand staff:
  `update profiles set brand_id = <their single store's brand> where role='user' and brand_id is null`.
  Spec 068's trigger now guarantees a staff user's `user_stores` are all in ONE
  brand, so the backfill brand is unambiguous. The brand is derived from the
  user's `user_stores` → `stores.brand_id`.
- **Fix the invite/register flow** so new staff get a brand_id at registration.
  `registerInvitedUser` (`src/lib/auth.ts:323-400`) currently inserts the
  profile with `brand_id: invitation.brand_id ?? null` (line 373) and THEN
  inserts `user_stores` rows (lines 382-384). The fix sets `profiles.brand_id`
  from the assigned store's brand for `role='user'` invites (the architect
  specifies whether this is computed in the register path, written onto the
  invitation at invite time, or both).
- Makes `auth_can_see_brand` work UNIFORMLY for staff across ALL brand-scoped
  tables (not just the two the EOD screen reads today) — future staff features
  that read `recipes`/`ingredient_conversions` inherit the fix for free.
- **Must reconcile with `profiles_role_brand_consistent`**
  (`20260509000000_…:343-348`): the constraint PERMITS but does not REQUIRE a
  brand_id for `role='user'`, so SETTING one is allowed. Architect verifies the
  constraint admits the backfilled rows (it does by inspection — the
  `(role = 'user')` arm is unconditional — but confirm).
- **Interacts with the spec-068 trigger:** the backfill UPDATE on `profiles`
  does not touch `user_stores`, so the `user_stores_brand_match_trg` does not
  fire on the backfill itself. After the backfill a staff user has a non-NULL
  brand_id, so any FUTURE `user_stores` insert for them goes through the trigger's
  NON-NULL path (store brand must equal profile brand) instead of the NULL-brand
  single-brand path. Architect confirms this ordering is consistent (it is —
  backfill brand == their existing single store brand, so existing rows already
  satisfy the non-NULL invariant).

### Option B (surgical) — make `auth_can_see_brand` also accept brand via `user_stores`

- Change the function body to add a store-membership arm:
  ```sql
  ... OR exists (
    select 1 from public.user_stores us
    join public.stores s on s.id = us.store_id
    where us.user_id = auth.uid() and s.brand_id = p_brand_id
  )
  ```
- Lets a NULL-brand staff user read brand-scoped data for any brand they have a
  store in. Access derives from store membership — arguably MORE correct, since
  `user_stores` is the source of truth for staff scope.
- **Higher blast radius.** `auth_can_see_brand` is called by the SELECT/INSERT/
  UPDATE/DELETE policies of EVERY brand-scoped table and child table:
  `brands`, `catalog_ingredients`, `recipes`, `prep_recipes`, `vendors`,
  `stores` (writes), `recipe_ingredients`, `prep_recipe_ingredients`,
  `recipe_prep_items`, `ingredient_conversions`, `pos_recipe_aliases` — all of
  `20260509000000_…` §6a–6k. Changing the function changes the access surface of
  ALL of them at once. The architect MUST analyze whether broadening read (and
  potentially write, since the same helper gates `privileged_insert/update/
  delete`) access for store-members is acceptable on every one of those tables,
  or whether the change must be scoped to SELECT-only / read-only paths.
  - Note the WRITE policies are `auth_is_privileged() AND auth_can_see_brand(...)`.
    A `role='user'` staff user is NOT privileged (`auth_is_privileged()` =
    admin OR super_admin), so broadening `auth_can_see_brand` does NOT grant
    staff write access — the `auth_is_privileged()` conjunct still gates writes.
    The architect should confirm this reasoning holds for every policy that
    uses the helper, because it is the crux of whether B is safe.

### PM lean (advisory only — architect runs the analysis)

Option A. It fixes the data-model inconsistency at the source, the spec-068
trigger already enforces single-brand staff (so the backfill is unambiguous),
and it keeps `auth_can_see_brand` semantically "your declared brand" rather than
overloading it with store-derived membership. But A requires a one-time data
backfill (mutates prod `profiles` rows) AND an invite-flow code change, whereas
B is a single function body swap with no data migration. The architect weighs
"data migration + code change, clean semantics" (A) against "one function, wide
blast radius, no data change" (B).

## Acceptance criteria

- [ ] **Bug fixed (the core AC):** a `role='user'` staff user with
      `profiles.brand_id = NULL` (pre-fix state) who is a `user_stores` member of
      a 2AM store can read `catalog_ingredients` for that brand. The EOD query
      `inventory_items?select=id,vendor_id,catalog:catalog_ingredients(name,unit)&store_id=eq.<2AM store>`
      returns rows whose embedded `catalog` object is NON-NULL with a populated
      `name` and `unit`. The EOD Count screen renders the ingredient name in
      each row label (no more blank "Count for ").
- [ ] **The `vendors` embed is also fixed:** the same staff user reading
      `order_schedule?select=vendor_id,vendor_name,vendor:vendors(id,name)` gets
      a NON-NULL embedded `vendor` object (closing the latent fallback-masked
      instance). Vendor names no longer depend on the denormalized
      `order_schedule.vendor_name` fallback for that user.
- [ ] **Approach decided and approved:** the design doc states A, B, or a
      hybrid, with the blast-radius analysis, and the chosen approach was
      surfaced to the user for approval before build (Open question #1).
- [ ] **If Option A — backfill correctness:** after the backfill migration,
      every `role='user'` profile that has ≥1 `user_stores` row has a non-NULL
      `brand_id` equal to that user's (single) store brand. A pgTAP assertion
      proves zero `role='user'` rows remain with NULL `brand_id` AND a
      `user_stores` row. Any staff user with NO `user_stores` rows, or (should be
      impossible post-spec-068) stores spanning >1 brand, is FLAGGED in the
      migration (RAISE NOTICE or a pre-flight count) rather than silently
      guessed — the architect specifies the flagging behavior.
- [ ] **If Option A — invite flow:** a newly-invited `role='user'` user, after
      `registerInvitedUser`, has `profiles.brand_id` set to the brand of their
      assigned store(s). A test (jest on the auth path and/or pgTAP on the
      resulting row) proves the new staff profile is brand-stamped, not NULL.
      No regression to admin-invite brand handling (admin invites already
      require a brand per `profiles_role_brand_consistent` and the
      `inviteUser` pre-flight at `auth.ts:274-276`).
- [ ] **If Option B — function change + non-regression:** `auth_can_see_brand`
      returns TRUE for a NULL-brand staff user against a brand they have a
      `user_stores` store in, and FALSE against a brand they do NOT. A pgTAP arm
      proves a NULL-brand staff user STILL cannot read a brand they have no store
      in (no over-broadening). A pgTAP arm proves staff still CANNOT write
      brand-scoped tables (the `auth_is_privileged()` conjunct still denies),
      i.e. broadening read did not leak write.
- [ ] **No cross-brand regression (both options):** an admin/brand-admin in
      brand A still cannot read brand B's `catalog_ingredients`/`vendors` (the
      spec-012a isolation guarantee, probes 1–7 of `20260509000000_…`, is
      preserved). A pgTAP arm asserts brand-A admin sees 0 brand-B rows.
- [ ] **Prod verification plan stated:** the design doc lists the exact
      read-only prod query/queries to run post-deploy to confirm the prod staff
      user now reads non-null `catalog` (mirroring the spec-012a verification-probe
      convention). For Option A the design also states the read-only query to
      confirm the backfill set the expected brand on the affected rows BEFORE the
      migration is written (so the dev knows the row count and target brand).
- [ ] **Tests land on the named tracks** (see Open question #4): pgTAP for the
      RLS/backfill behavior; jest if any frontend or `src/lib/auth.ts` code
      changes (Option A invite path); the EOD-screen regression that the embedded
      join maps to non-null names is asserted at the level the chosen approach
      makes testable (pgTAP for the RLS read; existing `EODCount.test.tsx`
      already mocks a non-null `catalog`, so confirm it still passes and add an
      arm for the previously-null embed if a frontend change lands).

## In scope

- The chosen fix (Option A backfill + invite-flow stamp, OR Option B function
  broadening, OR a documented hybrid) that lets NULL-brand staff read the
  brand-scoped catalog data the EOD screen needs.
- Closing BOTH brand-gated embeds the staff EOD path uses today:
  `catalog_ingredients` (visible) and `vendors` (latent/fallback-masked).
- Whatever migration the chosen approach needs (a backfill + `auth.ts` change
  for A; a `create or replace function` for B).
- Tests per the named tracks (pgTAP mandatory; jest if FE/auth code changes).
- The read-only prod verification queries (stated in the design; run by the
  user/main Claude post-deploy, not part of the migration).

## Out of scope (explicitly)

- **Re-architecting the staff app's data access into `src/lib/db.ts`.** The
  staff subtree's direct `supabase.from(...)` calls are a documented carve-out
  (CLAUDE.md, spec 063 — verbatim port; a future spec may migrate them). This
  spec fixes the RLS/data-model bug, not the access-layer location.
  (Rationale: that migration is its own spec; touching it here expands blast
  radius far beyond the bug.)
- **Denormalizing a `name`/`unit` snapshot onto `inventory_items`** (the way
  `order_schedule.vendor_name` snapshots the vendor). That would mask the bug
  with a fallback rather than fix the access model, and would add a
  write-time-consistency burden. (Rationale: treats the symptom, not the cause;
  and the cause must be fixed for the `catalog` data regardless.)
- **Broadening staff WRITE access to any brand-scoped table.** Staff must remain
  read-only on catalog/vendors; both options preserve this (A via a benign
  brand_id; B because `auth_is_privileged()` still gates writes). No policy is
  rewritten to grant staff inserts/updates. (Rationale: scope is "let staff
  READ ingredient names," nothing more.)
- **Touching `recipes`, `prep_recipes`, `ingredient_conversions` query paths in
  the staff app.** The staff EOD screen does not read them today (PM survey).
  Option A fixes them prospectively as a side effect of a correct brand_id, but
  no staff code is added to query them in this spec. (Rationale: not on the
  affected surface; YAGNI.)
- **Changing the spec-068 `user_stores_brand_match` trigger.** It is correct and
  just shipped; this spec depends on its single-brand guarantee but does not
  modify it. (Rationale: separate, freshly-reviewed concern.)
- **Admin/super-admin brand behavior, the brand picker, or `UsersSection`
  display** (spec 068's surface). Untouched. (Rationale: different bug.)
- **`app.json` slug** — untouched (load-bearing per CLAUDE.md). (Rationale:
  standing policy.)
- **Any realtime publication change.** The staff stack uses no realtime in v1
  (spec 062); neither fix alters `supabase_realtime` membership. (Rationale: not
  engaged; flagged so the dev does not cargo-cult the docker-restart ritual.)

## Open questions resolved

These were prepared with sensible defaults. Consistent with the spec-068
precedent (user not available to answer interactively in this session), the
listed defaults are adopted and recorded here. The architect should treat #1 as
a hard gate — produce the A-vs-B recommendation and surface it for the user's
explicit approval before any build begins.

- **Q1 (LOAD-BEARING — approach A vs B):** Which fix? → A (default): **let the
  architect decide based on a blast-radius analysis** — both close the bug. The
  architect produces the analysis, picks A / B / hybrid, and surfaces the
  recommendation for the user's approval BEFORE build. PM lean is Option A (root
  cause; spec-068 trigger makes the backfill unambiguous), but the architect runs
  the real analysis.
- **Q2 (backfill scope — only if Option A):** → A (default): backfill ALL
  existing `role='user'` profiles with NULL `brand_id`, deriving the brand from
  their `user_stores` → `stores.brand_id`. If any such staff user has NO stores,
  or (should be impossible post-spec-068) stores across multiple brands, FLAG it
  in the migration output rather than guessing a brand. The architect specifies
  the flag mechanism (RAISE NOTICE + skip the row, or a hard pre-flight count).
- **Q3 (broader brand-scoped-table audit):** → A (default): YES — the architect
  surveys which `auth_can_see_brand`-gated tables the staff app queries so the
  whole class is fixed, not just `catalog_ingredients`. **PM survey already did
  this pass** and found exactly two engaged today: `catalog_ingredients`
  (visible) and `vendors` (latent, masked by the `order_schedule.vendor_name`
  fallback) — both must be closed; `recipes`/`prep_recipes`/`ingredient_conversions`
  are NOT queried by the staff surface in v1. The architect confirms this survey
  and notes that Option A fixes the entire class prospectively while Option B
  fixes the entire class immediately.
- **Q4 (tests):** → A (default): pgTAP proving (a) a NULL-brand staff user — then
  backfilled (A) or via the broadened helper (B) — CAN read `catalog_ingredients`
  (and `vendors`) for their store's brand; (b) a cross-brand regression
  (brand-A admin sees 0 brand-B catalog rows); (c) for B, that staff still cannot
  read a no-store brand and still cannot write; for A, that zero NULL-brand
  staff-with-stores rows remain post-backfill. jest only if a frontend or
  `src/lib/auth.ts` change lands (Option A invite path). The existing
  `src/screens/staff/screens/EODCount.test.tsx` already mocks a non-null
  `catalog` embed — confirm it still passes; no new shell smoke needed.

## Dependencies

- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` — defines
  `auth_can_see_brand`, `auth_can_see_store`, `auth_is_privileged`,
  `profiles_role_brand_consistent`, and every brand-scoped RLS policy. The
  central artifact for both options.
- `supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql`
  (spec 068) — the single-brand-staff guarantee Option A's backfill relies on.
- `src/screens/staff/screens/EODCount.tsx` — the three reads
  (`fetchVendorsForToday` :82, `fetchItemsForVendor` :114,
  `fetchExistingSubmission` :144); the two brand-gated embeds live here.
- `src/lib/auth.ts` — `registerInvitedUser` (:323-400) and `inviteUser`
  (:267-320); the invite-flow change for Option A lands here.
- `supabase/seed.sql` — Tara Manager (`role='user'`) has a non-NULL `brand_id`
  (:118-120); relevant because the existing pgTAP/seed fixtures do NOT exercise
  the NULL-brand path. A new test must construct a NULL-brand staff fixture.
- `supabase/tests/auth_can_see_store_brand_scope.test.sql` — reference pattern
  for a hermetic `begin; … rollback;` second-brand RLS fixture.
- CLAUDE.md "Permissive RLS policies ORed" (spec 051/053) — relevant ONLY if a
  reviewer worries B's broadening interacts with a permissive policy; B changes a
  helper function, not a policy, so the spec-053 lint is not directly engaged,
  but the architect should note it.

## Project-specific notes

- **Cmd UI section / legacy:** Neither. This is a backend RLS / data-model fix.
  The affected client surface is the STAFF app (`src/screens/staff/`), not the
  admin Cmd UI. No legacy surface.
- **Which app:** The STAFF app (folded into this repo per spec 063). The bug is
  in this repo — not a sibling-app redirect.
- **Per-store or admin-global:** The fix is about the brand-vs-store scope
  boundary. The data is brand-scoped (`catalog_ingredients`, `vendors`); the
  affected users are store-scoped staff. Both options reconcile the two scopes.
- **Edge function or PostgREST:** PostgREST/RLS. No edge function. The staff EOD
  reads are direct PostgREST (`supabase.from(...)`) governed by RLS policies.
  (The staff app's per-user JWT auth — spec 061 — is unchanged.)
- **Realtime channels touched:** None. Staff stack has no realtime in v1
  (spec 062). Neither option alters `supabase_realtime` publication membership,
  so the `docker restart supabase_realtime_imr-inventory` ritual is NOT required.
- **Migrations needed:** YES. Option A → a one-time `profiles.brand_id` backfill
  migration (+ the `auth.ts` invite-flow change, which is code not migration).
  Option B → a `create or replace function public.auth_can_see_brand(uuid)`
  migration. Either way it must sort after `20260528010000_…`. **No
  migrations-applied CI gate exists** (CLAUDE.md "CI workflow"; spec 064 gate
  never landed) — the dev must MANUALLY verify the migration applies against the
  286 KB prod-shape seed via `npm run dev:db` and that pgTAP passes via
  `scripts/test-db.sh`.
- **Edge functions touched:** None.
- **Web/native scope:** Both. The staff EOD screen renders on web and native;
  the fix is server-side (RLS/data) plus possibly `src/lib/auth.ts` (shared
  across platforms). No web-only or native-only surface.
- **Tests:** pgTAP (mandatory — RLS/backfill behavior, the named track for DB
  tests per spec 022). jest only if FE/`auth.ts` code changes (Option A). No
  shell smoke.

## Review routing (note for the dispatcher)

This bug IS the cross-brand RLS access model. The reviewer fan-out for this spec
MUST include **security-auditor** alongside **code-reviewer** and
**test-engineer** — not code-reviewer + test-engineer alone. **backend-architect
(post-impl mode)** must also be in the fan-out because this spec ships a
migration (backfill or function change) and drift on the RLS contract is exactly
what post-impl review catches.

Security surface to scrutinize specifically:
- Option B broadens `auth_can_see_brand`, which gates ~11 tables' policies — the
  auditor confirms staff get READ-only (not write) access and that no
  cross-brand READ leaks beyond the user's own store brands.
- Option A mutates prod `profiles` rows — the auditor confirms the backfill
  brand derivation is unambiguous (single-brand guarantee from spec 068) and the
  invite-flow change cannot stamp the WRONG brand or leak a brand across an
  invite.
- Both: the brand-A-admin-cannot-see-brand-B isolation (spec 012a) must remain
  intact; the auditor checks the pgTAP regression arm proves it.

## Backend design

> **STATUS GATE.** `Status:` is set to `READY_FOR_BUILD`, but the A-vs-B
> decision (Open question #1) is a **hard user-approval gate**. Build does NOT
> begin until the user explicitly approves the recommendation below. Main Claude
> collects that approval. This section documents BOTH options in full so the
> approved one can be built without a second architecture pass; the
> **Recommendation** subsection states the pick.

### 0. Recommendation (front and center)

**Recommended: Option A — give invited staff a `brand_id` (backfill migration + `registerInvitedUser` stamp).**

Reasoning, in priority order:

1. **Blast radius is bounded and inspectable.** Option A touches exactly two
   surfaces: (a) a one-time `UPDATE` of `profiles` rows that are `role='user'`
   AND `brand_id IS NULL` AND have ≥1 `user_stores` row (a tiny, enumerable set
   — see the pre-flight count query in §5), and (b) one code path
   (`registerInvitedUser` in `src/lib/auth.ts`). Option B changes the body of
   `auth_can_see_brand(uuid)`, which is called by **15 distinct policies/RPCs**
   across **12 tables plus 2 SECURITY DEFINER RPCs** (full enumeration in §1) —
   every one of those becomes a thing the reviewer must re-verify, forever.

2. **Option A restores the system's own invariant; Option B overloads a helper.**
   The 012a migration ALREADY backfilled every `role='user'` row that existed at
   012a time to the 2AM brand (`20260509000000_…:283-286`). The prod staff user
   "Charles" has `brand_id = NULL` only because they were invited AFTER 012a, via
   the invite→register path that hard-codes `brand_id: invitation.brand_id ?? null`
   (`auth.ts:373`). **The NULL-brand staff state is an invite-flow regression
   against an invariant 012a established, not an intentional design.** Option A
   fixes the regression at its source. Option B leaves the NULL-brand state in
   place and teaches `auth_can_see_brand` to paper over it — semantically
   muddying "your declared brand" into "your declared brand OR any brand you have
   a store in," on a helper that 11 brand-isolation policies depend on for the
   spec-012a security boundary.

3. **A one-time backfill alone is INSUFFICIENT — and that cuts toward A, not B.**
   A backfill without the `auth.ts` fix re-breaks on the very next staff invite.
   This is not a reason to prefer B; it is the proof that the *data model* (how
   staff get a brand) is the broken thing, and A fixes the model. B would have to
   live forever as the permanent compensating control for an invite flow that
   keeps emitting NULL.

4. **A fixes the whole class prospectively for free.** Once staff carry a correct
   `brand_id`, `auth_can_see_brand` works uniformly for them across all 11
   brand-scoped tables — so a future staff feature that reads `recipes` or
   `ingredient_conversions` (out of scope today) inherits the fix with zero
   further RLS work. B also fixes the class, but does so by widening read access
   on all 11 tables *immediately* for store-members, which is a larger standing
   security surface than the spec needs.

**The cost of A that the user must weigh and approve:** A mutates production
`profiles` rows (a backfill `UPDATE`) and touches the registration code path.
Per the project's "modifies shared/production systems needs explicit
confirmation" rule, this is exactly the kind of change that gets surfaced for
approval. B's appeal is "one function body, no data migration" — but B's
function body gates the brand-isolation boundary for the entire app, so "small
diff" is misleading about the actual risk.

**Both options are designed in full below.** If the user prefers B (to avoid the
prod data mutation), B is safe to build as specified — the §1 analysis confirms
every WRITE policy keeps its `auth_is_privileged()` conjunct, so B stays
read-only for staff. The decision is the user's; A is the architect's
recommendation.

---

### 1. Blast-radius analysis

#### 1a. Every call site of `auth_can_see_brand(uuid)` (the Option B surface)

Confirmed by reading every migration that references the helper. The PM said
"~11"; the precise count is **15 policy/RPC call sites across 12 tables + 2
RPCs**. For each, I record whether broadening the helper to admit store-members
would change behavior for a `role='user'` staff caller (`auth_is_admin()` =
false, `auth_is_super_admin()` = false, `auth_is_privileged()` = false):

| # | Object | Migration | Command | Predicate (abbreviated) | Staff-caller effect of broadening |
|---|--------|-----------|---------|--------------------------|-----------------------------------|
| 1 | `brands` SELECT | `20260509000000` 6a | SELECT | `auth_can_see_brand(id) AND (deleted_at IS NULL OR super)` | Staff would now SEE their store's brand row. **Intended & benign** (lets the staff app resolve brand name). |
| 2 | `catalog_ingredients` SELECT | 6b | SELECT | `auth_can_see_brand(brand_id)` | **THE FIX.** Staff can read catalog names. Intended. |
| 3 | `catalog_ingredients` INSERT/UPDATE/DELETE | 6b | WRITE | `auth_is_privileged() AND auth_can_see_brand(brand_id)` | **No change** — `auth_is_privileged()` = false for staff. Stays denied. ✅ |
| 4 | `recipes` SELECT | 6c | SELECT | `auth_can_see_brand(brand_id)` | Staff *could* read recipes. Not queried by staff today (out of scope), but read access widens. |
| 5 | `recipes` WRITE | 6c | WRITE | `auth_is_privileged() AND auth_can_see_brand(brand_id)` | **No change** — privileged conjunct denies. ✅ |
| 6 | `prep_recipes` SELECT / WRITE | 6d | SELECT / WRITE | read: helper; write: `privileged AND helper` | Read widens (unused by staff); write stays denied. ✅ |
| 7 | `vendors` SELECT | 6e | SELECT | `auth_can_see_brand(brand_id)` | **THE SECOND FIX** (latent `vendors` embed). Intended. |
| 8 | `vendors` WRITE | 6e | WRITE | `auth_is_privileged() AND auth_can_see_brand(brand_id)` | **No change** — denied. ✅ |
| 9 | `stores` INSERT/UPDATE/DELETE | 6f | WRITE | `auth_is_privileged() AND auth_can_see_brand(brand_id)` | **No change** — denied. ✅ (`stores` SELECT is `auth_can_see_store(id)`, NOT the brand helper — unaffected directly; see recursion note.) |
| 10 | `recipe_ingredients` SELECT / WRITE | 6g | SELECT / WRITE (EXISTS-join on `recipes.brand_id`) | read: helper; write: `privileged AND helper` | Read widens (unused by staff); write denied. ✅ |
| 11 | `prep_recipe_ingredients` SELECT / WRITE | 6h | same shape | Read widens (unused); write denied. ✅ |
| 12 | `recipe_prep_items` SELECT / WRITE | 6i | same shape | Read widens (unused); write denied. ✅ |
| 13 | `ingredient_conversions` SELECT / WRITE | 6j | same shape (EXISTS on `catalog_ingredients.brand_id`) | Read widens (unused); write denied. ✅ |
| 14 | `pos_recipe_aliases` SELECT / WRITE | 6k | same shape (EXISTS on `recipes.brand_id`) | Read widens (unused); write denied. ✅ |
| 15 | `profiles` SELECT "Admins can read all profiles" | `20260517060000` (1) | SELECT | `(auth_is_privileged() AND auth_can_see_brand(brand_id)) OR id = auth.uid()` | **No change** — admin arm has `auth_is_privileged()` (false); self-arm (`id = auth.uid()`) already lets staff read own row. Staff still **cannot** read other profiles. ✅ |
| 16 | `profiles` UPDATE "Admins can update any profile" | `20260517050000` (2) | UPDATE | `(auth_is_privileged() AND auth_can_see_brand(brand_id)) OR (id = auth.uid())` | **No change** — same shape; self-arm only. Staff cannot UPDATE other profiles. ✅ |
| 17 | `profiles` DELETE "Admins can delete profiles" | `20260517060000` (3) | DELETE | `auth_is_privileged() AND auth_can_see_brand(brand_id)` | **No change** — privileged conjunct denies. ✅ |
| 18 | `copy_brand_catalog` / `copy_catalog_to_brand` RPCs | `20260517030000`, `20260518000000` | SECURITY DEFINER RPC | `auth_is_super_admin()` checked FIRST, then `auth_can_see_brand` as defense-in-depth | **No change** — staff fail `auth_is_super_admin()` before the helper is consulted. ✅ |

**Conclusion on Option B safety (the crux):** I confirm the PM's conjecture on
**every** write-or-privileged call site. There is **no** policy or RPC where
broadening `auth_can_see_brand` grants a `role='user'` staff caller anything
beyond SELECT. Every WRITE path is `auth_is_privileged() AND auth_can_see_brand(...)`
or is gated by an earlier `auth_is_super_admin()` check; the `auth_is_privileged()`
conjunct (false for staff) is the load-bearing denial and B does not touch it.

**Two non-obvious Option-B interactions the developer/auditor MUST keep in mind:**

- **Read access widens on 9 tables staff don't query today (#4, #6, #10–14).**
  This is the real cost of B: it is not scoped to the two tables the EOD screen
  needs. A NULL-brand staff member would gain SELECT on `recipes`,
  `prep_recipes`, and all the recipe child tables for their store's brand. The
  spec's "out of scope: touching recipes/etc." is about *client code*, not about
  *RLS reachability* — B makes those tables RLS-reachable for staff even though
  no staff code reads them. That is acceptable per the spec's threat model (staff
  are trusted within their store's brand) but it is a wider grant than A, and the
  security-auditor must sign off on it explicitly.
- **No recursion / no RLS re-entry.** B's new arm does
  `... join public.stores s on s.id = us.store_id where ... s.brand_id = p_brand_id`.
  `auth_can_see_brand` is `SECURITY DEFINER`, so its internal `SELECT` on
  `stores`/`user_stores` runs as the function owner and **bypasses RLS** — it
  does NOT re-enter the `stores` SELECT policy (which itself calls
  `auth_can_see_store` → `auth_can_see_brand`). No infinite recursion, no
  policy-stack re-entry. The lock on `search_path = public, auth` is already
  present and must be preserved byte-for-byte.

#### 1b. The Option A surface

- **Data mutated:** a single `UPDATE public.profiles SET brand_id = <store brand>`
  over rows matching `role = 'user' AND brand_id IS NULL AND EXISTS(user_stores)`.
  The pre-flight count query (§5) tells the developer exactly how many rows and
  which brand BEFORE the migration is written. Spec 068's trigger guarantees each
  such user's `user_stores` are all in ONE brand, so the derived brand is
  unambiguous (the migration still asserts this — see §3a flagging).
- **Constraint legality:** `profiles_role_brand_consistent`
  (`20260509000000_…:343-348`) has an **unconditional** `(role = 'user')` arm —
  it permits NULL or non-NULL brand_id for staff. Setting a brand_id on a
  `role='user'` row is constraint-legal. Confirmed by inspection.
- **Trigger interaction:** the backfill `UPDATE` is on `profiles`, NOT
  `user_stores`, so `user_stores_brand_match_trg` does NOT fire on the backfill.
  After backfill, a staff user has a non-NULL brand_id, so any FUTURE
  `user_stores` insert for them takes the trigger's **non-NULL path** (store
  brand must equal profile brand). Because the backfilled brand == their existing
  single store brand, every existing `user_stores` row already satisfies that
  invariant — no retroactive violation. Confirmed.
- **`profiles_self_brand_lock` interaction (IMPORTANT for the migration author):**
  the backfill runs as a migration (postgres superuser, `auth.uid()` = NULL), so
  the self-edit trigger's `old.id = auth.uid()` guard is never true → the trigger
  does not block the backfill. ✅ But note: once staff carry a brand_id, the
  `profiles_self_brand_lock` trigger means **staff cannot self-change their own
  brand_id** (non-super_admin self-edit of brand_id is rejected). That is the
  desired security posture — staff brand is operator-managed.
- **Code path:** `registerInvitedUser` (`auth.ts:323-400`). It already reads
  `invitation.store_ids` (line 381) and `invitation.brand_id` (line 373) from
  the `get_pending_invitation` RPC, which already returns both columns
  (`20260510000000_…:42-62`). Design for the stamp is in §4.

---

### 2. Data model changes

**Option A:** No schema/DDL changes. One additive backfill migration (a `DO`
block `UPDATE`). No new tables, columns, or indexes. The existing
`profiles_brand_id_idx` (`20260509000000_…:175`) already covers the
`brand_id` predicate. Additive and reversible-by-data (a brand_id can be nulled
again by a super_admin if ever needed); the prior body is recoverable from git.

**Option B:** No schema changes. One `create or replace function
public.auth_can_see_brand(uuid)` migration (body swap only — signature,
volatility, security context, search_path all byte-identical to
`20260509000000_…:200-210`, mirroring how `20260517040000` swapped
`auth_can_see_store`). Idempotent. No down migration (repo convention).

**Proposed migration filename (either option, sorts after `20260528010000`):**

- Option A: `supabase/migrations/20260528020000_staff_brand_id_backfill.sql`
- Option B: `supabase/migrations/20260528020000_auth_can_see_brand_store_member_arm.sql`

`20260528020000` is later than the latest on disk (`20260528010000`). Confirmed
no collision.

#### Migration design — Option A (backfill)

A single idempotent `DO` block, modeled on the 012a backfill block
(`20260509000000_…:247-332`) and the 041 pre-flight (`20260517040000_…:75-84`):

1. **Pre-flight flag (Q2 resolution — explicit flagging, not silent guessing):**
   count `role='user'` profiles with NULL brand_id that have **zero** `user_stores`
   rows (cannot derive a brand) → `RAISE NOTICE` listing their ids and **skip**
   them (they stay NULL; they have no store so `auth_can_see_brand` is moot for
   them until they get one — and the invite-flow stamp will handle them
   prospectively). Separately, count `role='user'` NULL-brand profiles whose
   `user_stores` span **more than one** brand (should be impossible post-068) →
   `RAISE EXCEPTION` and refuse to apply (fail-closed: an ambiguous backfill is a
   data-integrity hazard, mirror the 012a pre-flight's `raise exception` posture).
2. **Backfill:** `UPDATE public.profiles p SET brand_id = (single store brand)`
   for `role='user' AND brand_id IS NULL AND` exactly-one-brand-in-user_stores.
   Derive the brand via `SELECT DISTINCT s.brand_id FROM user_stores us JOIN
   stores s ON s.id = us.store_id WHERE us.user_id = p.id`. `GET DIAGNOSTICS` +
   `RAISE NOTICE '069: backfilled % staff profiles'`.
3. **Post-backfill invariant assertion:** `RAISE EXCEPTION` if any `role='user'`
   profile with ≥1 `user_stores` row STILL has NULL brand_id (proves the backfill
   was complete — this is the AC's "zero NULL-brand-staff-with-stores rows
   remain"). This same assertion is duplicated as a pgTAP arm (§ pgTAP) so it is
   enforced at test time too.

The block is idempotent: the `UPDATE` is predicated on `brand_id IS NULL`, so a
second run no-ops.

#### Migration design — Option B (function swap)

```sql
create or replace function public.auth_can_see_brand(p_brand_id uuid)
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select
    public.auth_is_super_admin()
    or exists (
      select 1 from public.profiles
       where id = auth.uid()
         and brand_id = p_brand_id
    )
    or exists (
      select 1
        from public.user_stores us
        join public.stores s on s.id = us.store_id
       where us.user_id = auth.uid()
         and s.brand_id = p_brand_id
    );
$$;
```

Plus `comment on function` documenting the spec-069 store-member arm, and
re-asserting the explicit `grant execute ... to authenticated, anon` (idempotent,
mirrors `20260517040000_…:116`). No trigger, no policy, no schema change.

---

### 3. RLS impact

**No new tables → no new policies in either option.**

- **Option A:** Zero policy changes. The fix is purely that
  `auth_can_see_brand(brand_id)` now returns TRUE for backfilled staff because
  their `profiles.brand_id` matches — the existing
  `brand_member_read_catalog_ingredients` / `brand_member_read_vendors` policies
  start admitting them with no policy edit. This is the cleanest possible RLS
  footprint: **the policies are already correct; only the data they read was
  wrong.**
- **Option B:** Zero policy text changes; the helper body changes underneath 15
  call sites (§1a). The CLAUDE.md "permissive policies are ORed" lint (spec
  051/053) is **not** directly engaged — B changes a *function*, not a *policy* —
  but the security-auditor should note that the lint's pgTAP probe
  (`permissive_policy_lint.test.sql`) scans policy USING/WITH-CHECK text for
  trivially-wide tokens; B introduces none, so the lint stays green. Flagged for
  completeness.

#### 3a. Backfill flagging behavior (Option A, Q2)

As above: zero-store staff → `RAISE NOTICE` + skip (not an error — legitimately
has no brand to derive); multi-brand staff → `RAISE EXCEPTION` + refuse (should
be impossible post-068; if it ever happens it is a data hazard and must block
the deploy). This matches the spec's "FLAG rather than silently guess."

---

### 4. API contract / `registerInvitedUser` change (Option A only)

**PostgREST/RLS, no edge function, no RPC change.** The fix is a one-line
behavioral change in the existing `registerInvitedUser` profile INSERT.

**Design decision — WHERE to derive the staff brand:** there are two candidate
moments, and I rule between them:

- **(rejected) at invite time** (`inviteUser`, write `brand_id` onto the
  `invitations` row): an admin inviting a staff user already passes `storeIds`;
  the invitation's brand could be derived from the first store. **Rejected
  because** it duplicates the derivation logic in two places and the invitation
  row's `brand_id` is currently intentionally NULL for `role='user'`
  (`auth.ts:302` passes `opts.brandId`, which `InviteUserDrawer` sends as null for
  staff). Changing invite-time semantics is a wider blast than needed and risks
  the admin-invite path.
- **(chosen) at register time** (`registerInvitedUser`): derive the brand from
  the assigned stores at the moment the profile is created. The register flow
  already has `invitation.store_ids` in hand. **This is the minimal change and
  keeps the invitation row's existing NULL-brand-for-staff semantics intact.**

**Chosen mechanism — derive via a SECURITY DEFINER RPC, not a client `stores`
read.** At register time the user has just `signUp`'d; their session's RLS
context may not yet admit a `stores` SELECT for the assigned store (staff read
`stores` via `auth_can_see_store` → `user_stores`, but the `user_stores` rows are
inserted LATER in the flow, at lines 382-384). A client-side
`supabase.from('stores').select('brand_id')` could therefore return zero rows
(RLS) and silently leave brand_id NULL — re-introducing the bug. The robust
design is to derive the brand server-side. Two acceptable shapes; developer
picks:

- **(preferred) extend the existing `get_pending_invitation` RPC** to also return
  the resolved brand for staff: add a computed column
  `resolved_brand_id uuid` = `COALESCE(brand_id, (SELECT s.brand_id FROM stores s
  WHERE s.id = (store_ids[1])::uuid))`. `registerInvitedUser` then writes
  `brand_id: invitation.resolved_brand_id`. This keeps the derivation server-side
  (SECURITY DEFINER bypasses RLS), single-sourced, and requires no new RPC. NOTE:
  changing the RPC's return column set requires DROP+CREATE (SQLSTATE 42P13 — same
  pattern as `20260510000000_…:40`), so this becomes part of the Option-A
  migration. The TS `get_pending_invitation` return type in `auth.ts` is read
  loosely (`invitation.brand_id`), so adding a column is backward-compatible.
- **(alternative) a dedicated `resolve_invite_brand(p_email text) returns uuid`
  SECURITY DEFINER RPC** called between signUp and the profile INSERT. More code,
  but smaller change to the existing RPC. Developer's choice; the preferred shape
  is fewer moving parts.

**`registerInvitedUser` change (signature unchanged):**

```ts
// auth.ts:373 — today:
brand_id: invitation.brand_id ?? null,
// after (preferred shape):
brand_id: invitation.role === 'user'
  ? (invitation.resolved_brand_id ?? invitation.brand_id ?? null)
  : (invitation.brand_id ?? null),
```

Admin invites are **unchanged**: they already require a non-NULL `brand_id`
(pre-flight at `auth.ts:274-276` + the `invitation.brand_id` admin guard at
`auth.ts:345-350`), and the `role==='user'` branch above does not touch the admin
path. **No regression to admin-invite brand handling** (the AC requirement).

**Error cases:** if a staff invitation somehow has zero `store_ids` AND NULL
`brand_id`, `resolved_brand_id` is NULL and the profile is created with NULL
brand_id (constraint-legal for `role='user'`) — the staff user simply has no
brand until assigned a store, same as a zero-store user in the backfill. This is
a benign no-op, not an error; the invite flow already permits zero-store
invitations.

**`src/lib/db.ts` surface:** **No change.** `registerInvitedUser` lives in
`src/lib/auth.ts`, which is a documented carve-out allowed to call
`supabase.from/rpc` directly (CLAUDE.md). No new `db.ts` helper; no snake→camel
mapping change. The staff EOD reads in `src/screens/staff/` are also a documented
carve-out and are **not modified** (the fix is server-side; the existing
`fetchItemsForVendor` / `fetchVendorsForToday` queries start returning non-null
embeds with no client change).

---

### 5. Edge function changes

**None, either option.** No function is added or modified; no `verify_jwt`
change; no service-token logic touched. The staff EOD reads are direct PostgREST
governed by RLS (per-user JWT, spec 061), unchanged.

---

### 6. Realtime impact

**No realtime publication change — confirmed.** Neither option adds a table to or
removes one from `supabase_realtime`. The staff stack uses no realtime in v1
(spec 062), and `catalog_ingredients`/`vendors`/`profiles` membership in the
publication is untouched. **The `docker restart supabase_realtime_imr-inventory`
ritual does NOT apply** — flagged here so the developer does not cargo-cult it.
(For Option A the `store-{id}`/`brand-{id}` admin channels are irrelevant to the
staff fix; for Option B the helper-body swap does not alter publication
membership.)

---

### 7. Frontend store impact

**`src/store/useStore.ts`: no change, either option.** The admin Zustand store is
not on the affected surface. The staff app uses its own `useStaffStore`
(`src/screens/staff/store/`), and the bug is fixed server-side — the existing
EOD fetch helpers begin returning non-null `catalog`/`vendor` embeds with no
store-slice change. The optimistic-then-revert / `notifyBackendError` pattern is
**not** engaged (this is a read-path fix, no mutation, no optimistic UI).

For **Option A**, the only frontend-adjacent change is `src/lib/auth.ts`
(`registerInvitedUser`), which is backend-owned per the carve-out and does not
require frontend-developer coordination — there is no UI, store, or component
change. (If the developer chooses the "extend `get_pending_invitation`" shape,
the loose TS read of the RPC result means no type-file churn either.)

---

### 8. Read-only prod verification queries (run post-deploy by main Claude / user)

Mirroring the spec-012a verification-probe convention
(`20260509000000_…:48-132`). Replace `${ANON_KEY}` from `supabase status`;
`<CHARLES_STORE>` is the Charles store id; `<STAFF_EMAIL>`/`<STAFF_PW>` are the
prod staff user's credentials.

**PRE-MIGRATION (Option A — run BEFORE writing the migration, to know the row
count + target brand; read-only):**

```sql
-- How many staff rows will the backfill touch, and to which brand?
select p.id, p.name,
       (select array_agg(distinct s.brand_id)
          from public.user_stores us
          join public.stores s on s.id = us.store_id
         where us.user_id = p.id) as derived_brands
  from public.profiles p
 where p.role = 'user'
   and p.brand_id is null
   and exists (select 1 from public.user_stores us where us.user_id = p.id);
-- Expect: ≥1 row (Charles); derived_brands = {2AM} (single-element array).
-- If any row's derived_brands has length > 1 → STOP (multi-brand; 068 invariant
-- broken). If a staff user appears with NULL derived_brands → zero-store, will
-- be skipped+NOTICE'd by the migration.
```

**POST-DEPLOY (both options — confirm the staff user can now read the embeds):**

```bash
# 1. Get the staff user's token (per-user JWT).
TOKEN=$(curl -s -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
  -d '{"email":"<STAFF_EMAIL>","password":"<STAFF_PW>"}' | jq -r .access_token)

# 2. THE CORE AC — catalog embed is non-null:
curl -s "${SUPABASE_URL}/rest/v1/inventory_items?select=id,vendor_id,catalog:catalog_ingredients(name,unit)&store_id=eq.<CHARLES_STORE>" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN}" \
  | jq '[.[] | select(.catalog == null)] | length'
# Expected: 0  (zero rows with a null catalog embed — every name populated)

# 3. THE LATENT AC — vendor embed is non-null:
curl -s "${SUPABASE_URL}/rest/v1/order_schedule?select=vendor_id,vendor_name,vendor:vendors(id,name)&store_id=eq.<CHARLES_STORE>" \
  -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN}" \
  | jq '[.[] | select(.vendor == null and .vendor_id != null)] | length'
# Expected: 0  (no non-null vendor_id rows with a null vendor embed)
```

**POST-DEPLOY (Option A — confirm the backfill landed):**

```sql
-- Zero staff-with-stores rows should remain NULL-brand:
select count(*) from public.profiles p
 where p.role = 'user' and p.brand_id is null
   and exists (select 1 from public.user_stores us where us.user_id = p.id);
-- Expected: 0
```

**POST-DEPLOY (both — cross-brand isolation NOT regressed):** re-run spec-012a
Probe 1 (brand-A admin sees 0 brand-B `catalog_ingredients`) and the analogous
`vendors` read — both must still return 0. For Option B specifically, also
confirm a staff user reading a brand they have **no** store in returns 0 (run the
catalog read with a `brand_id=eq.<brand-they-have-no-store-in>` filter under the
staff token → expect length 0).

---

### 9. pgTAP arms (mandatory track — DB tests)

New hermetic `begin; … rollback;` test file:
`supabase/tests/staff_null_brand_catalog_read.test.sql`. Fixture pattern copied
from `auth_can_see_store_brand_scope.test.sql` (second-brand insert inside the
txn) and `staff_role_eod_rls.test.sql` (seed manager `22222222-…` as the
`role='user'` staff fixture, JWT impersonation via `set_config('request.jwt.claims', …)`).

**Fixture setup (common):** a second brand B + a brand-B store + a brand-B
`catalog_ingredients` row, all inside the txn. A NULL-brand staff user: take the
seed manager (`role='user'`), set `brand_id = NULL` inside the txn, ensure they
have a `user_stores` grant for a brand-A store (seed gives Towson + Frederick)
and NO grant for any brand-B store.

Arms (the developer finalizes the count; these are the required assertions):

1. **NULL-brand staff CANNOT read brand-A catalog (pre-fix proof).** With the
   staff user at `brand_id = NULL`, assert `auth_can_see_brand(brand_A)` = FALSE
   AND a SELECT on `catalog_ingredients` for brand A returns 0 rows. (Establishes
   the bug exists before the fix is applied within the test.)
2. **After fix, NULL-brand-then-fixed staff CAN read brand-A catalog.**
   - *Option A variant:* set the staff user's `brand_id = brand_A` (simulating
     the backfill), then assert `auth_can_see_brand(brand_A)` = TRUE and the
     `catalog_ingredients` SELECT for brand A returns > 0 rows.
   - *Option B variant:* leave `brand_id = NULL`, apply the broadened helper
     (already in the migration under test), assert `auth_can_see_brand(brand_A)`
     = TRUE via the `user_stores` arm and the SELECT returns > 0 rows.
3. **Cross-brand isolation preserved.** The same staff user (fixed via A, or
   NULL via B) reading brand-B catalog returns **0** rows /
   `auth_can_see_brand(brand_B)` = FALSE. (No store in brand B → no access.
   **This is the no-over-broadening arm — load-bearing for Option B.**)
4. **Staff STILL CANNOT write `catalog_ingredients` (privileged-only preserved).**
   `throws_ok`/RLS-denial on an INSERT into `catalog_ingredients` for brand A
   under the staff JWT — proves broadening read did not leak write. **Critical
   for Option B; also a good guard for A.** (Mirror arm (9) of
   `staff_role_eod_rls.test.sql` which already proves staff cannot INSERT
   `recipes`.)
5. **The `vendors` embed class is fixed too.** Same as arm 2 but for `vendors` —
   `auth_can_see_brand`-gated `vendors` SELECT for brand A returns > 0 rows for
   the fixed/broadened staff user.
6. **EOD embed integration-style.** Run the actual EOD shape
   `SELECT id, vendor_id FROM inventory_items WHERE store_id = <brand-A store>`
   joined to `catalog_ingredients` under the staff JWT and assert the catalog
   `name` is NON-NULL for every row (proves the embedded join resolves, not just
   the bare table SELECT). (At pgTAP level this is the join returning non-null
   `name`; the PostgREST embed nullability is covered by the §8 prod probe and
   the existing `EODCount.test.tsx` mock.)
7. **Brand-A admin still sees 0 brand-B catalog/vendors (spec-012a regression).**
   Impersonate the seed admin (brand A) and assert brand-B catalog + vendors
   SELECT both return 0 — the isolation guarantee (012a probes 1–7) is intact.

**Option-A-specific additional pgTAP file/arms** (backfill correctness — best as
a small dedicated file `supabase/tests/staff_brand_backfill.test.sql` OR extra
arms in the above, developer's call):

8. **Backfill correctness.** Construct a NULL-brand `role='user'` profile with a
   single brand-A `user_stores` grant; run the backfill logic; assert the
   resulting `brand_id` == brand A. (If testing the migration's `DO` block
   directly is awkward in pgTAP, assert the equivalent `UPDATE` and the
   post-condition: zero `role='user'`-with-stores rows remain NULL-brand.)
9. **Zero NULL-brand-staff-with-stores remain (post-backfill invariant).** The AC
   assertion — `SELECT count(*)` of the offending shape == 0. (Duplicates the
   migration's own post-backfill `RAISE EXCEPTION` guard at test level.)
10. **Zero-store staff are skipped, not errored.** A NULL-brand `role='user'`
    profile with NO `user_stores` rows is left NULL by the backfill and does NOT
    cause the migration to fail (matches the §3a flagging design).

**jest:** required **only for Option A** (because `src/lib/auth.ts` changes). Add
a jest arm asserting `registerInvitedUser`, given a mocked staff invitation
(`role='user'`, `store_ids=[brandAStore]`, `brand_id` null but `resolved_brand_id`
brand A), writes `brand_id: <brand A>` to the profile INSERT (not null). The
existing `src/screens/staff/screens/EODCount.test.tsx` already mocks a non-null
`catalog` embed — **confirm it still passes; no new arm needed there** unless a
client change lands (it does not). For **Option B**, **no jest** (no FE/auth
code change — pgTAP only).

---

### 10. Risks and tradeoffs (explicit)

- **(A) Prod data mutation.** The backfill `UPDATE`s prod `profiles`. Mitigated
  by: the pre-flight count query (§8) run BEFORE writing the migration so the
  blast is known; the multi-brand `RAISE EXCEPTION` fail-closed (won't apply on
  ambiguous data); idempotency. **This is the change that requires explicit user
  approval** per the auto-mode "modifies production systems" rule.
- **(A) Re-break risk if the `auth.ts` stamp is omitted.** A backfill without the
  register-flow fix re-breaks on the next invite. The build MUST ship both halves
  together; the pgTAP arm (8) + jest arm guard the data shape, but only the
  `auth.ts` change prevents recurrence. Flagged as the #1 thing post-impl review
  must confirm landed together.
- **(A) `get_pending_invitation` return-shape change** (if the preferred RPC
  shape is chosen) requires DROP+CREATE (42P13). The DROP/CREATE is in one
  migration txn so no client observes a missing function (same as
  `20260510000000`). Low risk, flagged for the developer.
- **(B) Standing read-access widening on 9 unused tables.** B makes `recipes`,
  `prep_recipes`, and recipe child tables RLS-readable for staff even though no
  staff code reads them (§1a). Acceptable under the spec's threat model but a
  wider standing surface than A; the security-auditor must explicitly sign off.
- **(B) Helper is hot-path on every brand-scoped query.** Broadening
  `auth_can_see_brand` adds a `user_stores ⋈ stores` EXISTS to the function. On
  the 286 KB seed (one brand, a handful of stores, ~143 catalog rows) this is
  negligible; `profiles_brand_id_idx` and the `user_stores` PK cover the
  point-lookups. But the helper runs on EVERY brand-scoped row read for EVERY
  caller (including admins, who now do an extra `user_stores` probe they don't
  need because their `profiles.brand_id` arm already matched — short-circuited by
  the OR, so the extra arm only runs when the first two miss). Performance risk is
  low but non-zero; flagged.
- **(Both) No migrations-applied CI gate** (CLAUDE.md "CI workflow"; spec 064
  gate never landed). The developer MUST manually verify the migration applies
  against the 286 KB prod-shape seed via `npm run dev:db` and that pgTAP passes
  via `scripts/test-db.sh`. State this in the build notes.
- **(Both) Migration ordering.** `20260528020000_` sorts after `20260528010000`
  (spec 068 trigger) and after `20260528000000`. Option A's backfill DEPENDS on
  the 068 single-brand guarantee being already applied — the ordering guarantees
  it. Confirmed no collision with anything on disk.
- **Edge-function cold-start: N/A** — no edge function touched.

---

## Handoff
next_agent: backend-developer
prompt: GATED ON USER APPROVAL OF OPTION A vs B (see ## Backend design §0 —
  architect recommends Option A; main Claude must collect the user's explicit
  approval BEFORE you begin, because Option A mutates prod profiles rows). Once
  approved, implement the approved option against the design in this spec:
  for Option A — the backfill migration
  20260528020000_staff_brand_id_backfill.sql (idempotent DO block with the §3a
  pre-flight flagging: NOTICE+skip zero-store staff, RAISE EXCEPTION on
  multi-brand staff, post-backfill zero-NULL-brand invariant assertion) PLUS the
  registerInvitedUser brand stamp in src/lib/auth.ts (preferred shape: extend
  get_pending_invitation to return resolved_brand_id via DROP+CREATE in the same
  migration, then write brand_id from it for role='user' invites only — admin
  path unchanged); for Option B — the create-or-replace
  auth_can_see_brand(uuid) migration 20260528020000_auth_can_see_brand_store_member_arm.sql
  (add the user_stores⋈stores arm, byte-identical signature/volatility/security
  context/search_path, comment + idempotent grant). Add the pgTAP arms in §9
  (staff_null_brand_catalog_read.test.sql; for A also the backfill-correctness
  arms). jest only for Option A (registerInvitedUser stamps brand_id, not null;
  confirm EODCount.test.tsx still passes). No realtime publication change → no
  docker restart. Manually verify the migration applies against the 286 KB seed
  via npm run dev:db and pgTAP via scripts/test-db.sh (no migrations-applied CI
  gate exists). After implementation, set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed. The review fan-out MUST include security-auditor
  (this IS the cross-brand RLS model) plus code-reviewer, test-engineer, and
  backend-architect (post-impl).
payload_paths:
  - specs/069-staff-brand-id-catalog-read-fix.md

---

## Files changed

Implemented **Option A** (user-approved) — backfill migration + `registerInvitedUser`
brand stamp. Both halves ship together (a backfill alone re-breaks on the next
invite — spec §10 risk #2). The architect's preferred shape was used: extend
`get_pending_invitation` to return `resolved_brand_id` in the SAME migration as
the backfill (DROP+CREATE for the return-shape change, SQLSTATE 42P13), and
stamp `profiles.brand_id` from it for `role='user'` invites only.

### migrations
- `supabase/migrations/20260528020000_staff_brand_id_backfill.sql` — NEW. Two
  halves in one file: **(Half 1)** an idempotent `DO` block backfilling
  `profiles.brand_id` for `role='user' AND brand_id IS NULL AND has ≥1 user_stores`
  rows, deriving the (single, per spec-068) store brand. §3a pre-flight flagging:
  `RAISE EXCEPTION` fail-closed on any multi-brand NULL-brand staff (ambiguous),
  `RAISE NOTICE` + skip zero-store staff (no brand to derive), and a
  post-backfill `RAISE EXCEPTION` invariant assertion (zero NULL-brand-staff-with-stores
  may remain). **(Half 2)** DROP+CREATE `get_pending_invitation(text)` to add a
  `resolved_brand_id uuid` column = `COALESCE(brand_id, brand of store_ids[1])`,
  derived server-side (SECURITY DEFINER bypasses RLS at register time). No RLS
  policy change, no schema/DDL change, no realtime publication change.

### src/lib
- `src/lib/auth.ts` — `registerInvitedUser` profile INSERT now sets
  `brand_id: invitation.role === 'user' ? (resolved_brand_id ?? brand_id ?? null) : (brand_id ?? null)`.
  Admin path byte-for-byte unchanged (it already carries a non-NULL brand_id and
  `resolved_brand_id` COALESCEs to it). The `inviteUser` path is untouched.

### tests — pgTAP (DB track)
- `supabase/tests/staff_brand_id_backfill.test.sql` — NEW, `plan(13)`. Arms:
  (1) NULL-brand staff cannot see brand A (pre-fix proof); (2) brand-stamped
  staff CAN read brand-A `catalog_ingredients` (the core fix); (3) cross-brand
  isolation preserved (brand-A staff cannot read brand-B catalog — no
  over-broadening); (4) staff still CANNOT write `catalog_ingredients`
  (privileged-only preserved, 42501); (5) the `vendors` embed class is fixed
  too; (6) EOD `inventory_items ⋈ catalog_ingredients` join resolves non-null
  catalog name (the literal bug); (7) brand-A admin still sees 0 brand-B
  catalog + vendors (spec-012a isolation); (8) `get_pending_invitation` returns
  the correct `resolved_brand_id` for a staff invite; (9) admin path passes
  `brand_id` straight through; (10) backfill correctness (NULL → store brand);
  (11) zero NULL-brand-staff-with-stores remain (post-backfill invariant);
  (12) zero-store staff skipped, not errored; (13) `resolved_brand_id` NULL for
  a zero-store staff invite (benign no-op).

### tests — jest (unit track)
- `src/lib/registerInvitedUser.test.ts` — NEW, 4 cases. Asserts the profile
  INSERT receives `brand_id = resolved_brand_id` for staff invites; falls back
  to `brand_id ?? null` when `resolved_brand_id` absent; admin path reads
  `invitation.brand_id` exclusively (incl. a divergence guard). Mocks the
  `./supabase` boundary (`rpc` / `auth.signUp` / `from(...).insert`). Existing
  `src/screens/staff/screens/EODCount.test.tsx` confirmed still passing (no
  client change).

### Verification performed
- `npx supabase db reset` — all migrations apply clean against the 286 KB
  prod-shape seed; the new migration logged `069: backfilled 0 staff profile(s)`
  (seed's Tara Manager already carries `brand_id = 2AM`, so the
  `where brand_id is null` guard correctly skips her).
- `bash scripts/test-db.sh` — **37/37** pgTAP files pass (was 36).
- `npm test` — **35 suites / 334 tests** pass, incl. `EODCount.test.tsx` and the
  new `registerInvitedUser.test.ts`.
- `npm run typecheck` + `npm run typecheck:test` — both clean.
- End-to-end on the local seed (in a rolled-back txn): a NULL-brand staff user
  reading Towson's `inventory_items` left-joined to `catalog_ingredients` saw
  **143/143 rows with a NULL-visible catalog name** (the blank-name bug); after
  the backfill stamp, **0/143** — every name resolves. `get_pending_invitation`
  probed live: staff invite → `resolved_brand_id = 2AM`; admin invite →
  passthrough. Backfill re-run = `UPDATE 0` (idempotent).
- **NOT pushed to prod** — main Claude applies after review + RC, then runs the
  read-only prod verification queries in §8.

---

## (superseded) Original PM handoff
next_agent: backend-architect
prompt: Design the contract for this spec. The load-bearing decision is Option A
  (give invited staff a brand_id — backfill + invite-flow stamp) vs Option B
  (broaden auth_can_see_brand to also accept brand via user_stores membership) —
  read both write-ups in the spec, run the blast-radius analysis (B touches the
  policies of ~11 brand-scoped tables via one helper; A touches prod profiles
  rows + the registerInvitedUser path), pick A / B / hybrid, and surface the
  recommendation for the user's explicit approval BEFORE build. Confirm the PM
  survey that the staff EOD path engages exactly two auth_can_see_brand-gated
  tables today (catalog_ingredients visible, vendors latent/fallback-masked) and
  that recipes/prep_recipes/ingredient_conversions are not staff-queried in v1.
  State the read-only prod verification queries, the migration that must sort
  after 20260528010000, the pgTAP arms (NULL-brand staff CAN read after fix;
  cross-brand admin isolation preserved; for B staff stay read-only and no
  no-store-brand leak; for A zero NULL-brand-staff-with-stores rows remain), and
  jest only if auth.ts/FE changes. No realtime publication change → no docker
  restart. Then set Status: READY_FOR_BUILD. The review fan-out MUST include
  security-auditor (this IS the cross-brand RLS model) plus code-reviewer,
  test-engineer, and backend-architect (post-impl).
payload_paths:
  - specs/069-staff-brand-id-catalog-read-fix.md
