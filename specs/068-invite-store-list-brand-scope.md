# Spec 068: Invite-user store list not scoped to the active brand

Status: READY_FOR_REVIEW

## Problem statement

(User's investigation, verbatim findings condensed.)

The underlying brand→store data allocation in prod is correct — no
cross-contamination at the data level:

- **2AM PROJECT** brand (`2a0000…`) → 4 stores: Charles (`1ea549`),
  Frederick (`0f2403`), Reisters (`298e09`), Towson (`000000`).
- **Baltimore Seafood** brand (`e14071…`) → 1 store: Baltimore Seafood
  (`8df66b`, 2324 Boston St).
- The Brands page reflects this correctly (2AM PROJECT: 4 stores ·
  Baltimore Seafood: 1 store).

**The bug is in the Invite User form UI.** When the operator opens
`+ INVITE USER`, the STORES checkbox list shows all 5 stores from both
brands combined ("0 of 5 selected"), even when scoped to a specific
brand context. It is not filtering the store list by the active brand.

Expected:
- In **2AM PROJECT** context → STORES list shows only Charles, Frederick,
  Reisters, Towson (4 stores).
- In **Baltimore Seafood** context → STORES list shows only Baltimore
  Seafood (1 store).

The same UI issue is visible on existing user **Bobby** in Users &
Access — his store chips show all five stores across both brands,
mixing brands. Symptom of the same form/query not scoping store options
to the current brand.

### PM code survey (confirms the diagnosis + one nuance)

- The invite form is `src/components/cmd/InviteUserDrawer.tsx` (NOT
  `InviteAdminDrawer`). Line 48 reads `const stores = useStore((s) =>
  s.stores)` and line ~390 maps the full unfiltered array into the
  STORES multi-select. There is no `brandId` filter. This is the
  "0 of 5 selected" symptom exactly.
- `src/screens/cmd/sections/UsersSection.tsx` `UserRow` (lines 295–298):
  for any `admin` / `master` / `super_admin` row it sets
  `accessibleStores = stores` (the ENTIRE store list), NOT the user's
  actual `user_stores`. Store-user rows correctly filter to
  `user.stores`. This strongly suggests **Bobby's cross-brand chips are
  a pure display artifact** — if Bobby is an admin-tier role, his row
  renders all five stores regardless of his real `user_stores`. The
  architect's prod query must confirm.
- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:357–387`
  — the `user_stores_brand_match_trg` trigger already raises on
  cross-brand inserts, BUT has a NULL-brand exemption (lines 372–374):
  if the invitee's `profiles.brand_id IS NULL` the guard is skipped.
  `user`-role invites get `brand_id = NULL` (see
  `InviteUserDrawer.tsx:108`), so the DB does NOT currently block a
  cross-brand `user_stores` row for a store-user invite. That is a
  real latent gap, not merely a display issue — see Open question #1
  and the security note below.

## User story

As an admin inviting a user (or editing an existing user's store
access), I want the STORES list scoped to the brand I'm operating in,
so I don't accidentally grant a user access to a store in a different
brand and so the displayed store access reflects the user's real
assignments.

## Acceptance criteria

- [ ] In `InviteUserDrawer`, the STORES multi-select renders only stores
      whose `brandId` matches the active brand context (per Open question
      #2 resolution). When the active brand is 2AM PROJECT the list shows
      exactly the 4 2AM stores; when Baltimore Seafood, exactly the 1
      Baltimore store. The "N of M selected" counter's `M` equals the
      filtered count, not the global store count.
- [ ] When no brand is active (e.g. super-admin "All brands" view with
      no brand selected), the drawer's store list behaves per the Open
      question #2 resolution — the architect specifies the exact rule
      (e.g. empty list + guidance to pick a brand first, mirroring the
      existing `role==='admin' && !brand` warning block). The chosen
      behavior is documented in the design doc and asserted by a test.
- [ ] Selecting stores and submitting an invite never produces a
      `user_stores` row whose store brand differs from the brand context
      the form was operating in. (Enforced primarily by the filtered
      options; defense-in-depth at the DB layer is Open question #4.)
- [ ] `UsersSection` `UserRow` store chips render the user's ACTUAL
      accessible stores, brand-consistent with the user, instead of the
      entire global `stores` array for admin-tier rows. After the fix,
      Bobby's chips show only his real brand's stores (per Open question
      #3 — the architect specifies whether admin-tier rows show their
      brand's stores or their literal `user_stores`).
- [ ] If the architect's prod query returns ZERO cross-brand
      `user_stores` rows: NO data-cleanup migration ships; the change is
      a query/display fix only, and an acceptance test asserts the
      filtered store count for each brand context.
- [ ] If the architect's prod query returns cross-brand `user_stores`
      rows: a separate cleanup migration is added that removes/repairs
      exactly those rows, with a pgTAP assertion that zero cross-brand
      rows remain (`s.brand_id IS DISTINCT FROM p.brand_id` returns no
      rows). The cleanup is documented as a distinct concern from the UI
      fix in the design doc.
- [ ] If the architect closes the `user_stores` INSERT brand gap
      (Open question #4 — e.g. tightening the NULL-brand exemption or
      adding a brand-match guard on the assignment path), a pgTAP test
      proves a cross-brand assignment is rejected for the affected role
      class, and a previously-allowed-then-now-blocked case is covered.
- [ ] Jest covers the `InviteUserDrawer` store-options filter (correct
      stores shown per brand context; correct empty/no-brand behavior).
- [ ] No regression to the existing `role==='admin'` brand-required
      warning path, the `stores.length === 0` empty-state, or the
      Cmd+S / Esc keyboard handlers in the drawer.

## In scope

- Brand-scoping the STORES multi-select options in
  `src/components/cmd/InviteUserDrawer.tsx`.
- Correcting the store-chip display in
  `src/screens/cmd/sections/UsersSection.tsx` `UserRow` so admin-tier
  rows no longer render the entire global store list.
- The architect's read-only prod query to classify Bobby's case as
  display-only vs. real data leak (Open question #1) — gates whether a
  cleanup migration and/or an INSERT-path guard land.
- Conditional data-cleanup migration (only if cross-brand rows found).
- Conditional `user_stores` INSERT brand-match hardening (only if the
  architect decides the latent NULL-brand-exemption gap is in scope for
  this fix — see Open question #4).
- Tests per the named tracks.

## Out of scope (explicitly)

- Any change to the brand→store data allocation itself — it is correct;
  this is a UI/query scoping bug. (Rationale: user confirmed data is
  clean at the source.)
- The Brands page store counts / `BrandsSection.tsx` store list — it
  already filters correctly (`allStores.filter((s) => s.brandId ===
  sel.id)`, BrandsSection.tsx:162). (Rationale: not the affected
  surface.)
- `InviteAdminDrawer` redesign — brand-admin invites are already
  brand-scoped via the `brandId` prop; only confirm it is unaffected,
  do not refactor it. (Rationale: different component, different code
  path; touching it expands blast radius.)
- Changing how `useStore.stores` is loaded globally / introducing a
  server-side brand filter on `fetchStores` — the store list is a
  global cache (`db.ts:44 fetchStores`, no brand filter) reused across
  the app; brand-scoping is a per-consumer concern and doing it at the
  component layer avoids regressing every other consumer. The architect
  may revisit if a shared selector is cleaner, but a global fetch change
  is out of scope. (Rationale: minimal blast radius.)
- Broadening the `user_stores_brand_match_trg` to non-`user_stores`
  tables or to a general brand-RLS sweep. (Rationale: that is a separate
  hardening spec; this fix is targeted.)
- `app.json` slug — untouched (load-bearing, per CLAUDE.md).

## Open questions resolved

These were presented to the user with sensible defaults. The user was
not available to answer interactively in this session; per the request,
the listed defaults are adopted and recorded here. The architect should
treat #1 as a hard gate (run the prod query first) and may flag any
default for the user if the prod query surprises.

- Q1 (LOAD-BEARING — architect must resolve via prod query FIRST):
  Is Bobby's cross-brand chip display a pure DISPLAY bug (his
  `user_stores` rows are clean — only his brand's stores — and the UI
  renders an unfiltered all-stores query) OR did the unfiltered form
  actually WRITE a cross-brand `user_stores` row (real data leak)?
  → A (default): Architect runs this read-only prod query EARLY, before
  designing:
  ```sql
  select us.user_id, us.store_id,
         s.brand_id as store_brand, p.brand_id as user_brand
  from user_stores us
  join stores   s on s.id = us.store_id
  join profiles p on p.id = us.user_id
  where s.brand_id is distinct from p.brand_id;
  ```
  Any rows = real cross-brand data leak → fix is query filter + cleanup
  migration + it reveals a latent RLS/trigger gap (see security note).
  Zero rows = display-only → fix is the query/display filter, no
  cleanup. PM survey predicts display-only (UsersSection renders the
  full `stores` array for admin-tier rows regardless of assignments),
  but the query is authoritative.

- Q2 (brand-context source): How does the Invite form know the "current
  brand" to filter by? → A (default): filter by the brand context the
  form is operating in — for a brand-admin that is their own
  `profiles.brand_id`; for a super-admin it is whatever brand they have
  selected in the header brand picker (`useStore.brand`). Architect
  confirms the actual wiring (the drawer already reads `useStore.brand`
  at line 49 and uses `brand?.id` for the admin-role brand box).

- Q3 (scope): Invite form only, or also the edit-existing-user-stores
  surface (and the chip display)? → A (default): BOTH — same brand-scope
  logic. Includes correcting `UsersSection` `UserRow` chips so admin-tier
  rows stop rendering the entire global store list. Architect specifies
  whether admin-tier rows show their brand's stores or their literal
  `user_stores`.

- Q4 (super-admin / cross-brand rule + latent DB gap): Should a
  super-admin ever be ABLE to assign a cross-brand store? And does the
  fix close the `user_stores` INSERT NULL-brand-exemption gap? →
  A (default): a single `user_stores` assignment must never span a brand
  inconsistent with the user's own `brand_id`. A super-admin managing
  brand X's users picks only from brand X's stores. Architect reconciles
  this with the existing `profiles_role_brand_consistent` constraint and
  the `user_stores_brand_match_trg` NULL-brand exemption
  (multi_brand_schema_rls.sql:372–374) — and decides whether closing
  that exemption for `user`-role invites belongs in THIS spec or a
  follow-up. If it ships here, pgTAP covers it (see AC + Tests).

- Q5 (tests): → A (default): jest for the `InviteUserDrawer` store-options
  filter and the `UserRow` chip display; pgTAP ONLY if the architect adds
  or changes a `user_stores` INSERT brand-match guard; data-cleanup
  verification (pgTAP) if a cleanup migration lands.

## Dependencies

- `src/components/cmd/InviteUserDrawer.tsx` (the invite form — store
  multi-select).
- `src/screens/cmd/sections/UsersSection.tsx` (the chip display in
  `UserRow`).
- `src/store/useStore.ts` — `stores`, `brand` selectors.
- `src/lib/db.ts:44 fetchStores` — read-only reference for how the store
  cache is populated (global, unfiltered); informs why filtering happens
  at the consumer.
- `src/lib/auth.ts` — `inviteUser` (the invite mutation path that writes
  `user_stores`); relevant if the architect adds defense-in-depth.
- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` —
  `user_stores_brand_match_trg` + `profiles_role_brand_consistent`
  (Open question #4 reconciliation).
- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`
  — brand-scoped store visibility (context for the RLS model).
- CLAUDE.md "Permissive RLS policies ORed" bullet (spec 051) — relevant
  if the fix touches RLS policies on `user_stores` / `stores`.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI. Files under
  `src/screens/cmd/sections/` (`UsersSection.tsx`) and
  `src/components/cmd/` (`InviteUserDrawer.tsx`). No legacy surface.
- **Per-store or admin-global:** The Users surface is admin-global but
  brand-aware (`UsersSection` already filters `fetchAllUsers({ brandId })`
  by the active brand). The store options must be brand-scoped. This
  feature is about brand-scoping within the admin surface, not per-store
  RLS visibility per se — though it intersects with
  `auth_can_see_store()` brand scoping.
- **Realtime channels touched:** None. `UsersSection` intentionally has
  no realtime channel (on-mount + post-action fetch). No change.
- **Migrations needed:** CONDITIONAL — only if the prod query (Q1)
  returns cross-brand rows (cleanup migration) and/or the architect
  closes the INSERT-path gap (Q4 guard migration). Default expectation
  per PM survey: display-only → no migration. The CI has no
  migrations-applied gate (spec 064 context: gate never landed) — if a
  migration ships, manually verify it applies against prod-shape.
- **Edge functions touched:** Likely none. `inviteUser` flows through
  `src/lib/auth.ts`; the architect confirms whether the invite mutation
  is a PostgREST/RPC path or an edge function and whether any
  defense-in-depth lands there. If an edge function IS touched, the
  CLAUDE.md edge-function bullets (role gate parity, `callEdgeFunction`
  envelope) apply.
- **Web/native scope:** Web + native (the Cmd drawer renders on both via
  `ResponsiveSheet`); no web-only surface here.
- **Tests:** jest (UI filter + chip display); pgTAP (conditional —
  brand-match guard and/or cleanup verification). No shell smoke needed.

## Review routing (note for the dispatcher)

This bug has a potential SECURITY dimension: cross-brand store access.
The PM survey found the `user_stores_brand_match_trg` trigger SKIPS its
guard when the invitee's `profiles.brand_id IS NULL`, which is exactly
the case for `user`-role invites — so a cross-brand `user_stores` row
for a store user is NOT currently blocked at the DB layer. Whether that
gap was ever exercised is what the prod query (Q1) determines.

When this spec reaches review, the reviewer fan-out MUST include
**security-auditor** in addition to **code-reviewer** and
**test-engineer** — not code-reviewer + test-engineer alone.

---

## Backend design

Author: backend-architect. Entry status READY_FOR_ARCH.

### 0. Q1 classification — settled by main Claude's prod queries (no further query needed)

Main Claude ran the two definitive read-only prod queries. Results, recorded
here so the dev does not re-run them:

- **Cross-brand `user_stores` rows across ALL of prod: ZERO.** The Q1 query
  (`… where s.brand_id is distinct from p.brand_id`) returned `rows: []`.
- **Bobby specifically:** `role='admin'`, `brand_id = 2a000000-… (2AM PROJECT)`,
  actual `user_stores = {Towson}` (one 2AM store). The UI showing him five
  chips across both brands is **100% a display artifact**.

**Conclusion: this is a DISPLAY + form-options bug, not a data leak.**

This resolves the AC fork:

- AC "If the architect's prod query returns ZERO cross-brand rows: NO
  data-cleanup migration ships" → **ENGAGED. No cleanup migration. State this
  explicitly to the dev: do NOT add a data-cleanup migration.** There are zero
  bad rows to repair; a migration would be a no-op against prod and pure risk.
- AC "If … returns cross-brand rows: a separate cleanup migration …" → **NOT
  ENGAGED.** Skip entirely.

### 1. Brand-context wiring (Q1-form / Q2) — where the "active brand" comes from

Surveyed the store and the drawer. The Cmd UI's notion of "current brand" is a
single source: the **`brand` slice** of `useStore` (`{ id, name } | null`),
already read by both target components today.

- **Super-admin brand switcher exists.** `setCurrentBrandId(brandId)`
  (`src/store/useStore.ts:629-666`) is the header brand picker's setter. It sets
  `currentBrandId`, then re-derives `currentStore` for the new brand, and the
  `loadFromSupabase`→`fetchBrandForStore` side-effect writes the `brand` slice
  (`{ id, name }`). On "All brands" (`brandId === null`) it sets `brand: null`
  (`useStore.ts:642`). So for a super-admin, `useStore.brand?.id` is the
  brand they have selected in the header, or `null` in the all-brands view.
- **Brand-admin / master:** `brand` is seeded from their own
  `profiles.brand_id` at login via `hydrateBrand(result.brand)`
  (`auth.ts:140-143` produces the `{ id, name }`; `useStore.ts:368 hydrateBrand`
  applies it). A non-super admin cannot switch it away from their own brand.

**Authoritative source for the filter predicate (both fixes): `useStore.brand?.id`.**
This is exactly what `InviteUserDrawer.tsx:76` already uses (`const brandId =
brand?.id ?? null`) for the admin-role brand box, and what `UsersSection.tsx:49`
already uses to scope `fetchAllUsers({ brandId })`. We are extending an
existing pattern, not inventing one. No new store state, no new selector.

The drawer does **not** have its own brand selector — confirmed by reading the
full component. The role picker (`isMaster ? …`) shows a **read-only** brand
box for `role==='admin'` (lines 310-330) and a warning block when no brand is
active (lines 331-349). So the "brand the invite is FOR" IS `useStore.brand` —
a super-admin inviting an admin for brand X must first switch into brand X via
the header picker (the existing warning block already enforces this for the
admin path). We extend that same contract to the store list.

### 2. Fix design — `src/components/cmd/InviteUserDrawer.tsx` (store multi-select)

Pure client-side filter. No DB, no contract change.

- Derive a filtered list once: the options become
  `stores.filter((s) => s.brandId === brand?.id)`. Source of `brand?.id` is §1.
- Three places consume it, all must switch from `stores` to the filtered list:
  - the `· {n} of {M} selected` counter (line 367-369) — `M` must be the
    filtered count, per AC.
  - the empty-state branch (`stores.length === 0`, line 371) — see no-brand
    rule below.
  - the `.map(…)` that renders the checkboxes (line 390).
- **`handleSave` store-name join (lines 97-100) must filter against the same
  filtered list**, not the global `stores`, so a stale `storeIds` entry from a
  brand-switch can't leak a cross-brand store name into the email. (Defense in
  depth; the options filter already prevents selecting one.)
- **No-brand rule (AC "When no brand is active").** When `brand?.id` is null/
  undefined (super-admin "All brands" view), the filtered list is empty. Render
  a **brand-required notice** that mirrors the EXISTING admin-path warning
  block (lines 331-349) — "Switch into a brand before assigning stores / Pick a
  brand from the header brand picker." Do NOT reuse the existing "No stores
  visible yet" copy (lines 381-386) — that messaging tells the operator the
  invite can still proceed, which is wrong for the no-brand case and would be a
  misleading affordance. Distinguish the two states:
  - `!brand?.id` → brand-required notice (new, modeled on the warn block).
  - `brand?.id` set AND filtered list empty (brand genuinely has no stores) →
    keep the existing "No stores visible yet" copy.
- **Stale-selection hygiene on brand switch.** `storeIds` persists in form
  state across a header brand-switch while the drawer is open. Since options
  are now brand-filtered, a previously-checked store from the old brand would
  be invisible but still in `storeIds`. Add an effect keyed on `brand?.id` that
  prunes `storeIds` to the filtered set when the brand changes (mirrors the
  existing `visible`-keyed reset effect at lines 60-72). This keeps the counter
  honest and prevents the handleSave join from carrying an orphan.

This satisfies the AC "never produces a `user_stores` row whose store brand
differs from the brand context" at the **primary (UI) layer**. The DB layer is
§4.

### 3. Fix design — `src/screens/cmd/sections/UsersSection.tsx` `UserRow` chips

The data is **already present** — no new fetch, no `db.ts` change.
`fetchAllUsers` (`auth.ts:476-497`) already populates `user.stores` (the user's
real `user_stores` ids, brand-clipped when brand-filtered) and `user.brandId`.
The bug is purely that `UserRow` (lines 295-298) **ignores `user.stores`** for
admin-tier rows and substitutes the entire global `stores` array.

**Decision on Q3 (what admin-tier rows show):** render each user's **brand's
stores**, i.e. for admin/master/super_admin rows show
`stores.filter((s) => s.brandId === user.brandId)`; for `user`-role rows keep
the existing `stores.filter((s) => user.stores.includes(s.id))`.

Rationale for brand's-stores (not literal `user_stores`) on the admin tier:

- An admin's effective store visibility is brand-wide via
  `auth_can_see_store()` brand scoping (`20260517040000_…`), NOT their
  `user_stores` rows. Bobby (admin, 2AM) can see all four 2AM stores
  operationally even though he has one `user_stores` row. Rendering literal
  `user_stores` for admins would UNDER-report (show Bobby one chip) and
  misrepresent his real access. Brand's-stores matches the access model.
- **super_admin edge case:** `super_admin.brandId` is `null`. The filter
  `s.brandId === null` yields an empty list, which would render "no stores
  assigned" — misleading for the all-brands role. Handle explicitly: for
  `role==='super_admin'`, render ALL stores (they see every brand) OR a
  dedicated "all brands" chip. **Recommend: render all `stores`** for
  super_admin only — it is truthful (they see everything) and the dev already
  has the array. Document this branch in a comment.

Net predicate in `UserRow`:

```
const accessibleStores =
    user.role === 'super_admin'
      ? stores                                              // sees every brand
      : user.role === 'admin' || user.role === 'master'
        ? stores.filter((s) => s.brandId === user.brandId)  // brand-wide
        : stores.filter((s) => user.stores.includes(s.id)); // literal grants
```

After this, Bobby (admin, 2AM, viewed by a super-admin in 2AM context) shows
exactly the 2AM stores present in the `stores` array, never Baltimore Seafood.

**Caveat the dev must know (and the test must encode):** `UsersSection` passes
the GLOBAL `stores` array into each row (`UsersSection.tsx:34, 211`). When a
non-super admin is logged in, `useStore.stores` is already brand-scoped by
their session, so the filter is mostly redundant for them but still correct.
When a **super-admin** is viewing, `stores` may span brands (depending on
whether they've loaded multiple), so the per-row `s.brandId === user.brandId`
filter is what actually does the work. The filter is keyed on **the row user's
brand**, not the viewer's active brand — this is correct: the Users list shows
users from (potentially) the active brand, and each row should reflect that
user's own access, independent of which brand the viewer is parked in.

### 4. Latent trigger gap (Q4) — DECISION: close it in THIS spec

**Reconciliation, settled definitively (the dispatch asked for this):**

- `profiles_role_brand_consistent` (`20260509000000_…:347`) admits
  `(role = 'user')` with brand_id **either NULL or set** — staff are NOT
  required to have a brand_id.
- The invite→register path **produces NULL** brand_id for staff:
  `InviteUserDrawer.tsx:108` passes `brandId: null` for `role='user'`;
  `inviteUser` stores `brand_id = null` on the invitation (`auth.ts:302`);
  `registerInvitedUser` inserts the profile with `brand_id: invitation.brand_id
  ?? null` (`auth.ts:373`) and THEN inserts `user_stores` rows
  (`auth.ts:382-384`).
- The seed's Tara Manager has a brand_id (`seed.sql:119`) — but that is a
  **seed-author choice** (the seed comment at line 115 literally says "brand_id
  is unconstrained for 'user' role"). It is NOT what the invite flow generates.
  So the "Tara has a brand_id" observation does **not** moot the gap; the
  PRODUCTION invite path yields NULL.
- Therefore the trigger's NULL-exemption (`user_stores_brand_match():372-374`,
  `if v_user_brand is null then return new`) **is a real, reachable
  cross-brand write hole** for `user`-role (staff) invites. A staff invite
  carrying `store_ids` from two different brands would write both `user_stores`
  rows unchallenged at registration time. Zero rows exploited it in prod (§0),
  but it is dormant, not closed.

**Decision: close it here, as defense-in-depth, paired with the UI fix.**
Rationale: (a) the spec explicitly scopes "conditional `user_stores` INSERT
brand-match hardening" as in-scope at the architect's call; (b) the
security-auditor is mandated in the fan-out specifically for the cross-brand
dimension — landing the UI fix without closing the DB hole invites a Critical
finding ("the form is fixed but the table still accepts cross-brand rows for
NULL-brand users"); (c) the change is small, additive, and independently
testable via pgTAP. Deferring to a follow-up leaves a known write hole open
for a release cycle with no upside.

**Trigger redesign (the dev authors the SQL; signature/behavior below):**

New migration: `supabase/migrations/20260528000000_user_stores_brand_match_null_brand.sql`
(use the actual timestamp at authoring time; must sort AFTER
`20260509000000_…` and after all P5 migrations — it does, 2026-05-28 > 2026-05-04).

- **Additive, non-destructive.** `create or replace function
  public.user_stores_brand_match()` — keep `security definer`,
  `set search_path = public`, and the existing trigger binding (no
  `drop trigger`/`create trigger` needed if the function body is replaced in
  place; the dev may re-create the trigger idempotently with the existing
  `drop trigger if exists … ; create trigger …` pattern for clarity).
- **New behavior:** when `v_user_brand IS NULL`, instead of unconditionally
  `return new`, **derive the brand from the store and require all of the
  user's `user_stores` rows to share a single brand**. Concretely:
  - Look up `v_store_brand` (already done).
  - If `v_user_brand IS NULL`: the user has no declared brand, so the
    *assignment itself* defines the brand. Reject the row if it would make the
    user's `user_stores` span more than one brand. Implementation: after
    establishing `v_store_brand`, check whether the user ALREADY has any
    `user_stores` row pointing at a store whose `brand_id` differs from
    `v_store_brand`; if so, RAISE. (For the very first row there is nothing to
    conflict with, so it passes — that is correct: a NULL-brand staff user is
    allowed to be assigned stores within ONE brand.)
  - Preserve the existing super-admin tolerance note in a comment, but the
    practical effect is now: NULL-brand users may hold `user_stores` rows for
    at most one brand.
- **Keep the existing non-NULL path byte-identical** (`v_store_brand IS
  DISTINCT FROM v_user_brand` → raise). Do not touch it.
- **Raise message convention.** Use a stable, lower-case message consistent
  with the existing one. Existing:
  `'cross-brand user_stores assignment rejected: user brand=%, store brand=%'`.
  For the NULL-brand multi-brand case use a distinct, stable string, e.g.
  `'cross-brand user_stores assignment rejected: user has no brand and store brands differ'`
  (no SQLSTATE override needed — the default plpgsql `raise exception` maps to
  P0001 → PostgREST HTTP 400, same as today). The pgTAP test asserts on the
  raise, not the exact text, but keep it stable for log-grep.

**Why a trigger change and not an RLS policy or an `inviteUser` guard:**
- RLS on `user_stores` gates WHO may insert (privileged/per-store), not the
  cross-brand INVARIANT — and adding a permissive policy here risks the
  CLAUDE.md "permissive policies are ORed" footgun (spec 051/053). A trigger is
  the right layer; it is exactly where the existing guard already lives.
- A client-side guard in `inviteUser`/`registerInvitedUser` is bypassable by
  any direct PostgREST/psql writer and is the very "recover-by-psql-only"
  class the CLAUDE.md destructive-op guards exist to prevent. The DB trigger is
  the single source of truth; the UI filter (§2) is the UX layer on top.

**Interaction with `registerInvitedUser`'s loop (`auth.ts:382-384`).** Today
it inserts rows one-by-one without a transaction. With the tightened trigger,
a staff invite whose `store_ids` span two brands will: insert row 1 (ok),
insert row 2 (RAISES) → row 2 throws, rows are not rolled back as a unit
(no surrounding txn), the catch at `auth.ts:397` returns
`{ error: e.message }`. This is acceptable for THIS spec (the UI filter
prevents cross-brand `store_ids` from being assembled in the first place, so
the trigger only fires for a direct-API attacker, for whom partial insert +
error is fine — no cross-brand row was written, the SECOND one was blocked).
**Do NOT refactor the loop into a transaction in this spec** — that is a
behavior change to the registration path outside this bug's blast radius;
note it as a follow-up if the dev feels strongly. Flag for the
security-auditor to confirm they agree partial-insert-then-block is acceptable
(I assess it is: the invariant "no user holds cross-brand rows" still holds
because the conflicting row is the one rejected).

### 5. No data-cleanup migration (explicit)

**Per §0, ZERO cross-brand `user_stores` rows exist in prod. The dev must NOT
add a data-cleanup migration.** The only migration in this spec is the §4
trigger hardening. There is nothing to clean.

### 6. RLS impact

**None.** No new tables. No policy changes. The §4 change is a trigger function
body, which is not an RLS policy and does not touch `pg_policies`. The
CLAUDE.md "permissive policies ORed" lint (spec 053) is therefore not engaged
by this spec — but the dev should NOT add any `user_stores`/`stores` policy as
a side-quest (explicitly out of scope per the spec).

### 7. API contract / `src/lib/db.ts` surface

**No `src/lib/db.ts` changes. No new helper, no signature change.**

- The chip fix (§3) consumes data already returned by `fetchAllUsers`
  (`src/lib/auth.ts` — a documented carve-out that legitimately calls
  `supabase` directly; it predates and is exempt from the db.ts funnel). No new
  fetch is needed because `User.stores` and `User.brandId` are already
  populated. **The dev must NOT add a per-user `user_stores` fetch** — it would
  duplicate data already on the row and add N+1 reads.
- The form fix (§2) is pure client filtering over `useStore.stores`.
- The invite mutation path (`inviteUser`/`registerInvitedUser` in `auth.ts`) is
  **unchanged**. The §4 trigger enforces the invariant server-side; no
  client-code change there. Note for the dev: do not add a brand pre-check in
  `inviteUser` for `store_ids` — the trigger is authoritative and the UI filter
  prevents the bad input.
- No PostgREST-vs-RPC decision to make; no new endpoint.
- snake_case→camelCase: no new fields, so no new mapping.

### 8. Edge function changes

**None.** No `verify_jwt` change, no service-token work. The invite flow's only
edge calls are the fire-and-forget `send-invite-email` / `send-welcome-email`
(`auth.ts:309, 394`), which are untouched and carry no store/brand data that
changes here.

### 9. Realtime impact

**None.** `UsersSection` deliberately has no realtime channel (on-mount +
post-action refetch, per its header comment lines 18-23 and the spec's
"Realtime channels touched: None"). The trigger change does not alter
`supabase_realtime` publication membership.

**Publication gotcha — NOT engaged.** Because this migration does not
`ALTER PUBLICATION supabase_realtime …`, the `docker restart
supabase_realtime_imr-inventory` dev step is **not** required for this spec.
Flagging explicitly so the dev does not cargo-cult it.

### 10. Frontend store impact

**No `useStore.ts` slice changes.** Both fixes read existing slices (`brand`,
`stores`) and existing row data (`User.stores`, `User.brandId`). The
optimistic-then-revert / `notifyBackendError` pattern does **not** apply — these
are read/display fixes and a server-side invariant; there is no new optimistic
mutation. The invite mutation already surfaces errors via `Toast.show` on
`result.error` (`InviteUserDrawer.tsx:113-121`), and with §4 the trigger's
raise will arrive as `result.error` through `inviteUser`'s catch — the existing
toast path renders it. No change needed there, but the §4 raise string is what
the operator will see if they somehow hit it.

### 11. Risks and tradeoffs (explicit)

- **Migration ordering.** The §4 migration must sort after `20260509000000_…`
  (it does, by date). It is a `create or replace function` — idempotent and
  safe to re-run. Additive, non-destructive. No down-migration concern beyond
  "replace the function body back" (the dev should keep the prior body
  recoverable from git history; we do not ship a down migration — none exist in
  this repo's convention).
- **No migrations-applied CI gate** (CLAUDE.md "CI workflow"). The dev must
  **manually verify** the migration applies against prod-shape: run
  `npm run dev:db` (which loads the 286 KB seed) and confirm the function
  replaces cleanly and the pgTAP test passes via `scripts/test-db.sh`.
- **Behavioral tightening risk (§4).** The trigger now REJECTS what it
  previously allowed (NULL-brand cross-brand `user_stores`). Prod has zero such
  rows (§0), so no existing data trips it. The only new failure path is a
  direct-API attempt to assign a NULL-brand user across brands — which is the
  intended block. The legitimate single-brand staff-assignment case still
  passes (first row establishes the brand). The pgTAP "previously-allowed-
  then-now-blocked" arm (AC) proves this boundary.
- **Performance on 286 KB seed.** The §4 trigger adds, in the NULL-brand
  branch only, one `EXISTS`-style lookup over the user's own `user_stores`
  rows (a handful per user). Negligible. The non-NULL path is unchanged. The
  chip filter (§3) is an in-memory `.filter` over the already-loaded `stores`
  array (single-digit to low-double-digit count) per row — trivial. The form
  filter (§2) is one `.filter` over the same small array. No new queries, no
  N+1, no cold-start surface (no edge function).
- **RLS gap residual.** After §4, the only remaining theoretical path to a
  cross-brand `user_stores` row is a super-admin (brand_id NULL on the
  *profile being assigned*, i.e. assigning stores TO a super_admin) — but
  super_admins legitimately span brands and the existing comment
  (lines 369-371) deliberately tolerates them; this is unchanged and correct.
  Surface to the security-auditor for confirmation that super_admin tolerance
  is intended (it is, per the original trigger comment and the all-brands role
  model).
- **UI consistency risk (§3 super_admin branch).** Showing ALL stores for a
  super_admin row is truthful but could look odd next to a brand-admin showing
  4. Acceptable — it reflects the real access model. The alternative (an "all
  brands" pseudo-chip) is a nicety the dev may add but is not required by AC.

### 12. Test plan

**jest (frontend-developer):**

1. `src/components/cmd/InviteUserDrawer.test.tsx` (new; model on
   `src/components/cmd/CopyToBrandDialog.test.tsx` / `IngredientForm.*.test.tsx`
   for the `useStore` mock shape):
   - With `brand = {id: '2a…', name:'2AM'}` and a mixed-brand `stores` array,
     the rendered checkbox options are exactly the 2AM stores; the `N of M`
     counter's `M` equals the filtered count (not the global count).
   - With `brand = {id: 'e1…', name:'Baltimore Seafood'}`, options are exactly
     the one Baltimore store.
   - With `brand = null` (super-admin all-brands), the brand-required notice
     renders and NO store checkboxes render (assert the warn-block copy, not
     the "No stores visible yet" copy).
   - Regression: the existing `role==='admin' && !brand` warning still renders;
     the `stores.length===0` (brand set, no stores) empty-state still renders
     its original copy; submit stays disabled when required fields are blank.
   - (If feasible in the harness) brand-switch prunes a stale `storeIds` entry.

2. `src/screens/cmd/sections/__tests__/UsersSection.test.tsx` (new; model on
   the sibling `__tests__/VendorsSection.test.tsx`), OR a focused unit test on
   the `UserRow` accessible-stores predicate if `UserRow` is exported/extracted
   for testability (the dev may extract the predicate to a small pure function,
   mirroring how `deriveLastOfRole`/`canDeleteUser` were extracted to
   `src/utils/userPermissions.ts` for unit coverage — that is the established
   pattern here and is the cleaner path):
   - admin row with `brandId='2a…'` against a mixed-brand `stores` array →
     chips are exactly the 2AM stores (Bobby case: not five, not Baltimore).
   - `user`-role row → chips are exactly `stores ∩ user.stores` (unchanged
     behavior).
   - super_admin row (`brandId=null`) → chips are all stores (or the documented
     all-brands rendering).
   - **Recommended:** extract `deriveAccessibleStores({ role, brandId,
     userStoreIds }, stores)` to `src/utils/userPermissions.ts` and unit-test
     it there (no RN render needed), consistent with the spec-033 extraction
     precedent. The architect endorses this as the lower-friction, higher-value
     test surface.

**pgTAP (backend-developer) — ENGAGED because §4 changes the trigger:**

3. `supabase/tests/user_stores_brand_match_null_brand.test.sql` (new; model on
   `supabase/tests/auth_can_see_store_brand_scope.test.sql` for the hermetic
   `begin; … rollback;` + second-brand fixture pattern, and on
   `delete_last_privileged_guard.test.sql` for role promotion mid-txn). Arms:
   - **Non-NULL path unchanged (regression):** a brand-A user assigned a
     brand-B store still RAISES (existing behavior preserved). 1-2 arms.
   - **NULL-brand FIRST row passes:** a `role='user'` profile with
     `brand_id IS NULL` assigned ONE store (brand A) → INSERT succeeds.
   - **NULL-brand SECOND cross-brand row blocked (the new guard):** same
     NULL-brand user, then assigned a brand-B store → INSERT RAISES. This is
     the AC "previously-allowed-then-now-blocked" arm — under the OLD function
     this insert succeeded; under the new one it is rejected.
   - **NULL-brand SECOND same-brand row passes:** same user, second brand-A
     store → succeeds (single-brand multi-store staff assignment still works).
   - Use `throws_ok`/`lives_ok`. Assert on the raise occurring, not exact text.
   - Fixture: insert a second brand + a brand-B store inside the txn, exactly
     as `auth_can_see_store_brand_scope.test.sql:58-62` does; roll back.

**No data-cleanup verification test** (no cleanup migration — §5).

**No shell smoke** needed (per spec).

### 13. Review routing (confirmed)

The reviewer fan-out for this spec MUST include **security-auditor**, alongside
**code-reviewer** and **test-engineer**. The cross-brand `user_stores`
dimension (§4) and the prod-classification call (§0) are the security surface.
**backend-architect (post-impl mode)** should also be in the fan-out because
this spec ships a migration (trigger change) — drift on the trigger contract is
exactly what post-impl review catches. Confirmed in the handoff below.

### 14. Files the dev will touch (architect's expectation)

- `src/components/cmd/InviteUserDrawer.tsx` — store-options brand filter +
  no-brand notice + stale-selection prune (§2). [frontend]
- `src/screens/cmd/sections/UsersSection.tsx` — `UserRow` accessible-stores
  predicate (§3); optionally extract the predicate to
  `src/utils/userPermissions.ts`. [frontend]
- `src/utils/userPermissions.ts` — (recommended) new
  `deriveAccessibleStores(...)` pure helper for unit coverage. [frontend]
- `supabase/migrations/20260528000000_user_stores_brand_match_null_brand.sql` —
  trigger function hardening (§4). [backend]
- `src/components/cmd/InviteUserDrawer.test.tsx` — jest (§12.1). [frontend]
- `src/screens/cmd/sections/__tests__/UsersSection.test.tsx` and/or
  `src/utils/userPermissions.test.ts` — jest (§12.2). [frontend]
- `supabase/tests/user_stores_brand_match_null_brand.test.sql` — pgTAP
  (§12.3). [backend]

NOT to be touched: `src/lib/db.ts` (no new helper — §7), `src/lib/auth.ts`
(invite path unchanged — §7), any RLS policy (§6), `InviteAdminDrawer.tsx`
(out of scope), `BrandsSection.tsx` (already correct), `app.json` slug.

## Handoff
next_agent: frontend-developer, backend-developer
prompt: Implement against the design in this spec. frontend-developer owns §2
  (InviteUserDrawer store-options brand filter + no-brand notice + stale-
  selection prune), §3 (UsersSection UserRow accessible-stores predicate,
  recommended-extracted to src/utils/userPermissions.ts), and the jest tests in
  §12.1 / §12.2 — NO src/lib/db.ts or auth.ts change (data is already on the
  User row). backend-developer owns §4 (the user_stores_brand_match() trigger
  hardening migration closing the NULL-brand cross-brand exemption) and the
  pgTAP test in §12.3; additive create-or-replace, sorts after 20260509000000,
  no publication change so NO realtime container restart, manually verify it
  applies against the seed via npm run dev:db + scripts/test-db.sh since there
  is no migrations-applied CI gate. Do NOT add a data-cleanup migration (zero
  bad rows in prod — §0/§5). After implementation, set Status: READY_FOR_REVIEW
  and list files changed under ## Files changed. The review fan-out MUST include
  security-auditor (cross-brand dimension) plus code-reviewer, test-engineer,
  and backend-architect (post-impl, because a migration ships).
payload_paths:
  - specs/068-invite-store-list-brand-scope.md

## Files changed

### Frontend (§2, §3, §12.1, §12.2) — frontend-developer

- `src/utils/userPermissions.ts` — new pure helper `deriveAccessibleStores(user, allStores)`
  (generic over the store element type) implementing the §3 role-based access
  predicate: super_admin → all stores; admin/master → own-brand stores; user →
  literal user_stores grants. (spec-033 extraction precedent)
- `src/screens/cmd/sections/UsersSection.tsx` — `UserRow` store chips now derive
  from `deriveAccessibleStores(user, stores)` instead of rendering the entire
  global `stores` array for admin-tier rows (the Bobby cross-brand display
  artifact). Added the helper import.
- `src/components/cmd/InviteUserDrawer.tsx` — §2: STORES multi-select options
  filtered to the active brand (`brandStores = stores.filter(s => s.brandId ===
  brandId)`, memoized); counter denominator fixed to the filtered count;
  no-brand notice ("Switch into a brand first to assign stores") rendered when
  `brandId` is null, distinct from the existing brand-set-but-empty "No stores
  visible yet" copy; brand-keyed effect prunes stale `storeIds` on a header
  brand-switch; `handleSave` store-name join resolved against `brandStores`.
- `src/utils/userPermissions.test.ts` — appended `deriveAccessibleStores` suite
  (super_admin all-stores, admin own-brand incl. Bobby's exact 4-of-5 case,
  master own-brand, user literal grants, empty-grant + unknown-brand edges).
- `src/components/cmd/InviteUserDrawer.test.tsx` — new: options filtered per
  brand context + counter `M`; Baltimore single-store context; no-brand notice
  shows + no checkboxes; regressions (admin brand-warning, brand-set-empty copy,
  send disabled until required fields); brand-switch stale-selection prune.

### Backend (§4, §12.3) — backend-developer

- `supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql`
  — additive `create or replace function public.user_stores_brand_match()`
  (keeps `security definer` + `set search_path = public`) closing the NULL-brand
  cross-brand exemption. The non-NULL-brand path is byte-for-byte unchanged
  (store brand must equal `profiles.brand_id`); the NULL-brand branch no longer
  unconditionally returns NEW — instead it rejects a row that would make the
  user's `user_stores` span more than one distinct brand (first grant always
  passes; multi-store within a single brand still allowed). Uses
  `IS DISTINCT FROM` for the conflict lookup and excludes the row being mutated
  by `store_id` so an idempotent re-assign does not self-conflict on UPDATE.
  Raises (default SQLSTATE P0001 → PostgREST HTTP 400) with a stable, distinct
  message. Trigger binding `user_stores_brand_match_trg` re-created idempotently.
  No publication change → no realtime container restart. No data-cleanup
  migration (zero bad rows in prod — §0/§5).
- `supabase/tests/user_stores_brand_match_null_brand.test.sql` — pgTAP, hermetic
  `begin; … rollback;`, `plan(7)`. Fixture: a second brand + brand-B store, a
  fresh NULL-brand `role='user'` profile, and a fresh non-NULL brand-A
  `role='admin'` profile (the seed admin already holds all four brand-A stores,
  so a fresh one keeps the regression arms self-contained). Arms: fixture NULL
  sanity; (1) non-NULL cross-brand still RAISES (regression); (2) non-NULL
  same-brand SUCCEEDS (regression); (3) NULL-brand first grant SUCCEEDS;
  (4) NULL-brand second same-brand grant SUCCEEDS; (5) NULL-brand second
  cross-brand grant RAISES — the "previously-allowed-then-now-blocked" arm
  (documented OLD-vs-NEW behavior in the arm comment); (6) NULL-brand no-op
  UPDATE of an existing same-brand grant SUCCEEDS (no self-conflict). `throws_ok`
  uses the 4-arg form with NULL expected-message to assert SQLSTATE without
  pinning exact text (per §12.3).

### Verification (backend half)

- `npx supabase db reset` — all migrations apply cleanly against the 286 KB
  seed, including `20260528010000_…`.
- `bash scripts/test-db.sh` — 36/36 pgTAP files pass (was 35; +1 new file, 7
  assertions).
- `npm test` — 330/330 jest pass (unchanged by the backend half; the FE half's
  `userPermissions` suite is included in that count).
- Seed regression: Tara Manager (`role='user'`) carries a non-NULL `brand_id`
  (seed.sql:118-120), so she does NOT hit the tightened NULL branch and her
  existing grants are unaffected; `db reset` + full pgTAP confirm no breakage.
