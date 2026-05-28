# Spec 068 — backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Spec: `specs/068-invite-store-list-brand-scope.md`
Entry status: READY_FOR_REVIEW
Verdict frame: matches design / deviation-justified / contract-break

Reviewed the implementation against the `## Backend design` appendix I authored
(§0–§14). Files inspected:

- `src/utils/userPermissions.ts` (§3 `deriveAccessibleStores`)
- `src/screens/cmd/sections/UsersSection.tsx` (§3 `UserRow` wiring)
- `src/components/cmd/InviteUserDrawer.tsx` (§2 store filter)
- `supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql` (§4 trigger)
- `supabase/tests/user_stores_brand_match_null_brand.test.sql` (§12.3 pgTAP)
- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:357-387` (the ORIGINAL trigger, for byte comparison)
- `src/types/index.ts:44-63` (User shape — generic constraint check)
- `supabase/tests/auth_can_see_store_brand_scope.test.sql` (the fixture-pattern model the design pointed at)

---

## Drift point 1 — §2 InviteUserDrawer brand filter — MATCHES DESIGN

Every clause of §2 landed exactly as designed:

- `brandStores` derived from `brand?.id` via `brandId = brand?.id ?? null`
  (`InviteUserDrawer.tsx:76`) then `stores.filter((s) => s.brandId === brandId)`,
  memoized on `[stores, brandId]` (`:84-87`). Authoritative source is
  `useStore.brand?.id` per §1. ✅
- All three consumers switched off the global `stores`: the counter denominator
  is `brandStores.length` (`:404`), the empty-state branch is
  `brandStores.length === 0` (`:430`), and the `.map` renders `brandStores`
  (`:449`). ✅
- No-brand notice (`!brandId`, `:407-429`) is a NEW warn-block modeled on the
  admin-path warning, copy "Switch into a brand first to assign stores" — and is
  correctly DISTINCT from the retained "No stores visible yet" copy
  (`:430-446`), exactly the two-state split §2 mandated. The dev did not reuse
  the misleading "invite can still proceed" copy for the no-brand case. ✅
- Stale-selection prune effect keyed on `[brandId, visible]` (`:96-108`) prunes
  `storeIds` to the active brand's set on a header brand-switch, with a no-op
  guard to avoid the extra render. Mirrors the existing `visible`-keyed reset.
  ✅ — and the eslint-disable + the "keyed on brandId not brandStores" comment
  show the dev understood the dependency-array subtlety I flagged.
- `handleSave` store-name join resolves against `brandStores`, not global
  `stores` (`:133-136`), closing the cross-brand-name-leak-into-email defense-
  in-depth path. ✅

Regression surface I asked to preserve is intact: the `role==='admin' && !brand`
warning (`:367-385`), the Cmd+S/Esc handlers (`:171-182`), and `requiredValid`
(`:110-113`) are untouched. No drift.

## Drift point 2 — §3 access predicate + extraction — MATCHES DESIGN

`deriveAccessibleStores` (`userPermissions.ts:94-112`) is the §3 predicate
verbatim:

- `super_admin` → `[...allStores]` (all stores). ✅
- `admin || master` → `allStores.filter((s) => s.brandId === user.brandId)`
  (own-brand). ✅
- `user` → `allStores.filter((s) => user.stores.includes(s.id))` (literal
  grants). ✅

This is precisely the net predicate I wrote into §3. The branch order is
correct: `super_admin` is tested FIRST, so the `brandId === null` super_admin
never falls into the `admin/master` filter and never renders an empty list —
the exact edge case §3 called out. ✅

Extraction to `src/utils/userPermissions.ts` per the spec-033 precedent I
recommended in §12.2 / §3: done, and it lives alongside `canDeleteUser` /
`deriveLastOfRole` (the same spec-033 helpers), which is the right home. The
generic constraint `<S extends { id: string; brandId: string }>` typechecks
against `Store` (`types/index.ts:459` — `brandId: string`, non-null), and the
`Pick<User, 'role' | 'brandId' | 'stores'>` arg matches `User` (`:44-45,63`).
✅

`UserRow` wiring (`UsersSection.tsx:302`) replaced the old whole-`stores`
assignment with `deriveAccessibleStores(user, stores)`, and the chip render
loops `accessibleStores` (`:346-364`). Import added (`:14`). The Bobby case
(admin, 2AM, viewed in a mixed-brand cache) now renders exactly the 2AM stores,
never Baltimore. ✅ No drift.

## Drift point 3 — §4 trigger (load-bearing) — MATCHES DESIGN

This is the contract-critical artifact. Compared the landed body
(`20260528010000_…:69-128`) against the original (`20260509000000_…:357-387`)
line by line:

- **Non-NULL-brand path byte-for-byte unchanged.** Landed `:112-116`:
  `if v_store_brand is distinct from v_user_brand then raise exception
  'cross-brand user_stores assignment rejected: user brand=%, store brand=%',
  v_user_brand, v_store_brand;`. Original `:375-378`: identical, including the
  raise string and the `%` arg order. ✅
- **NULL-brand branch enforces "at most one distinct brand."** The new branch
  (`:83-110`) replaces the original unconditional `return new` with a conflict
  lookup: it selects any existing `user_stores` row for the same `user_id`
  whose store's `brand_id IS DISTINCT FROM v_store_brand`, and RAISES if
  `found`. First grant has no conflict → passes; second same-brand → passes;
  second cross-brand → raises. This is the §4 contract precisely. ✅
- **`store_id` exclusion for idempotent UPDATE.** The lookup carries
  `and us.store_id is distinct from new.store_id` (`:99`), so a no-op/idempotent
  UPDATE of an existing grant does not self-conflict. This is exactly the
  refinement §4 asked for ("excludes the row being mutated"). ✅
- **P0001 / security definer / search_path.** `language plpgsql security
  definer set search_path = public` (`:71-73`) preserved verbatim from the
  original. The NULL-branch raise (`:104-106`) uses a bare `raise exception`
  with no SQLSTATE override → defaults to P0001 → PostgREST HTTP 400, exactly as
  §4 specified and consistent with the non-NULL raise. ✅
- **Trigger binding re-created idempotently.** `:125-128` is the original
  `drop trigger if exists user_stores_brand_match_trg … ; create trigger … for
  each row execute function public.user_stores_brand_match();` pattern,
  byte-identical to `20260509000000_…:383-386`. The binding still resolves the
  function by name, so the `create or replace` body swap + idempotent re-bind is
  belt-and-suspenders correct. ✅
- **Raise message convention.** NULL-branch string
  `'cross-brand user_stores assignment rejected: user has no brand and store
  brands differ (existing brand=%, new store brand=%)'` (`:105-106`) is a
  stable, distinct, lower-case message following the existing convention — and
  it adds the two brand ids for log-grep, which is a nice touch beyond what I
  sketched. ✅

Ordering: `20260528010000` sorts after `20260509000000` and after the unrelated
`20260528000000_actor_fk_cascade_audit.sql` already on disk (confirmed that
migration carries no spec-068 content — the design's "today's earlier
migration" was an ordering note only). ✅ No drift on the load-bearing artifact.

## Drift point 4 — harness deviations — ALL THREE ARE JUSTIFIED, NO CONTRACT CHANGE

The dev's three pgTAP deviations are sound judgment within my design, not drift:

1. **7 arms instead of my 6-arm sketch (added fixture-sanity + no-op-UPDATE
   arms).** ⚠️ deviation-justified.
   - The fixture-sanity arm (`:135-140`) asserts the test user really is
     `brand_id IS NULL` — a guard against a future `profiles_role_brand_
     consistent` change silently backfilling it and making the NULL-branch arms
     vacuously pass. That is exactly the kind of fixture-rot trap pgTAP should
     defend; it strengthens the suite.
   - The no-op-UPDATE arm (arm 6, `:227-236`) directly exercises the `store_id`
     exclusion I added to §4. My §4 introduced that exclusion clause but my
     §12.3 sketch did not enumerate an arm for it — the dev correctly closed
     that coverage gap. This is the test catching up to the design, not
     diverging from it.
   - Both additions are strictly additive coverage. The 5 behavioral arms I
     specified (non-NULL raise, non-NULL pass, NULL first pass, NULL same-brand
     pass, NULL cross-brand raise) are all present (arms 1-5, `:147-220`). No
     contract assertion was dropped or weakened.

2. **Fresh in-txn `role='admin'` fixture for the regression arms instead of the
   seed admin.** ⚠️ deviation-justified — in fact necessary.
   - The seed admin holds all four brand-A `user_stores` rows, so there is no
     spare brand-A store for a clean positive-control INSERT (arm 2 would hit a
     PK collision on `(user_id, store_id)`). A fresh brand-A admin with zero
     grants makes arms 1-2 self-contained and order-independent. The fixture is
     created inside the hermetic `begin; … rollback;` with backing `auth.users`
     rows (`:99-131`) and torn down on rollback. This is the correct call and is
     well-documented in the header (`:42-46`). The non-NULL path it exercises is
     the byte-identical original path, so the regression arm is still a true
     regression of the unchanged behavior.

3. **`throws_ok` 4-arg form with NULL expected-message (SQLSTATE-only
   assertion).** ✅ matches design intent.
   - §4 / §12.3 explicitly said "Assert on the raise occurring, not exact text"
     and "no SQLSTATE override needed — default … P0001." The 4-arg
     `throws_ok(sql, 'P0001', null, description)` form asserts the SQLSTATE
     without pinning the raise text, which is the more robust choice and matches
     established repo usage (`legacy_permissive_policy_dropout.test.sql` uses the
     same shape on `user_stores` inserts). The header comment (`:30-34`)
     correctly explains why the 3-arg form would mis-bind the description as
     expected-text. This is exactly within my design, not a deviation.

Net: all three are within-design judgment calls that harden the suite. None
changes the contract being asserted.

## Drift point 5 — §11 super_admin residual — HANDLED AS INTENDED

§11 flagged the residual concern: after §4, could a super_admin acquire
`user_stores` rows that trip the at-most-one-brand rule? Confirmed the landed
trigger handles it exactly as the design intended:

- A super_admin profile has `brand_id IS NULL` (enforced by
  `profiles_role_brand_consistent`, `20260509000000_…:344`). So a super_admin
  assigned `user_stores` rows enters the SAME NULL-brand branch as a NULL-brand
  staff user — it does NOT get a special bypass.
- The practical effect, as §4 documented: a super_admin who (atypically) appears
  in `user_stores` is constrained to a single brand across their grants. The
  original trigger's intent was "don't hard-block a NULL-brand row outright"
  (it tolerated them); the new behavior preserves that for the FIRST grant and
  only blocks a genuine cross-brand SECOND grant. The migration's header
  (`:44-49`) explains this preservation-in-spirit, and §11 surfaced it to the
  security-auditor for confirmation, which is the right disposition.
- Crucially, this does NOT regress any legitimate super_admin behavior:
  super_admins do not appear in `user_stores` in prod (their visibility is via
  `auth_can_see_store()` brand scoping, not grants), and §0's prod query
  returned zero cross-brand rows. So no real super_admin row trips the rule. The
  residual is theoretical and correctly bounded. ✅

This is precisely the residual I described in §11 — not new, not worse, and
explicitly within the security-auditor's remit. No drift.

## Drift point 6 — no data-cleanup migration — CONFIRMED ABSENT (CORRECT)

§0/§5 mandated NO data-cleanup migration (zero bad rows in prod). Confirmed: the
only spec-068 migration on disk is `20260528010000_…` (the §4 trigger). There is
no cleanup migration, and the trigger migration's header explicitly states "No
data-cleanup migration ships" (`:27-28, :55-56`). ✅ Correct per design.

## Drift point 7 — scope — CLEAN, NO OUT-OF-DESIGN DRIFT

Cross-checked the changed surface against §14's expected file list. The
implementation touched exactly:

- `src/utils/userPermissions.ts` (+ `.test.ts`) — §3 helper + jest.
- `src/screens/cmd/sections/UsersSection.tsx` — §3 `UserRow` wiring.
- `src/components/cmd/InviteUserDrawer.tsx` (+ `.test.tsx`) — §2 filter + jest.
- `supabase/migrations/20260528010000_…sql` — §4 trigger.
- `supabase/tests/user_stores_brand_match_null_brand.test.sql` — §12.3 pgTAP.

The §14 "NOT to be touched" list is respected — verified by inspection that
`UsersSection.tsx` adds no per-user `user_stores` fetch (it consumes
`fetchAllUsers`'s existing `user.stores` / `user.brandId`, §7), `InviteUserDrawer`
adds no `inviteUser` brand pre-check (the invite mutation path is unchanged,
§7), and no RLS policy was added on `user_stores`/`stores` (§6 — the spec-053
permissive-policy lint is not engaged). I did not find any `db.ts` change, any
`supabase.from/rpc` call introduced outside the documented carve-outs, or any
`app.json` touch. The unrelated `20260528000000_actor_fk_cascade_audit.sql` is
pre-existing and carries no spec-068 content. ✅

---

## Findings by severity

**Critical:** none.
**Should-fix:** none.
**Minor:** none.

Every design point landed as specified. The three harness deviations the
dispatch flagged for my judgment (7 arms, fresh admin fixture, SQLSTATE-only
`throws_ok`) are sound, well-documented, within-design calls that strengthen
coverage without altering any asserted contract. The load-bearing §4 trigger is
byte-for-byte correct on the non-NULL path and implements the NULL-branch
at-most-one-brand rule with the idempotent-UPDATE exclusion exactly as designed.
No contract break, no architectural drift.

One non-blocking observation, carried forward verbatim from §4 (NOT a finding
against the implementation): `registerInvitedUser`'s row-by-row insert loop
(`auth.ts:382-384`) remains non-transactional, so a direct-API caller assembling
cross-brand `store_ids` would write grant #1, then have grant #2 rejected by the
tightened trigger — a partial insert with no surrounding txn. As I argued in §4,
this is acceptable because the invariant "no user holds cross-brand rows" still
holds (the conflicting row is the one rejected) and the UI filter prevents
legitimate clients from assembling such input. The dev correctly left this loop
untouched per my explicit "do NOT refactor the loop into a transaction in this
spec" instruction. Flagged here only so the security-auditor's note and this
review agree; it is a documented follow-up, not drift.

**SHIP_READY** from the architecture/drift perspective.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 findings by severity (Critical 0,
  Should-fix 0, Minor 0). Implementation matches the spec 068 design appendix on
  all 7 drift points; the three pgTAP harness deviations are justified within-
  design judgment calls; the load-bearing §4 trigger is correct (non-NULL path
  byte-identical, NULL-branch at-most-one-brand rule with idempotent-UPDATE
  store_id exclusion, P0001/security-definer/search_path preserved, binding
  re-created idempotently); no data-cleanup migration (correct); scope clean.
  SHIP_READY from the architecture perspective. Awaiting the other reviewer files
  before release-coordinator synthesizes.
payload_paths:
  - specs/068/reviews/backend-architect.md
