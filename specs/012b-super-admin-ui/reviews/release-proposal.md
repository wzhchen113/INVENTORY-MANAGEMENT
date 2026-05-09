# Release proposal — Spec 012b

## Verdict

**FIXES_NEEDED** (because 2 code-reviewer Criticals violate CLAUDE.md "all
PostgREST/RPC traffic flows through `src/lib/db.ts`" convention, plus
test-engineer's 1 FAIL on AC S1 "catalog ingredient count missing from
Brands list" is a spec-text deviation that should land in the same
cleanup bundle).

Per CLAUDE.md hard rule — "release-coordinator cannot recommend SHIP_READY
if any reviewer flagged a Critical (security, broken acceptance criteria,
contract drift, broken build)" — these architectural-convention Criticals
qualify as contract drift. Verdict is FIXES_NEEDED regardless of the
otherwise-clean security review and successful probe walk.

## Reviewer roll-up

| Reviewer            | Critical | Should-fix | Notes / Nits | Output file |
|---------------------|----------|------------|--------------|-------------|
| code-reviewer       | **2**    | 6          | 7 nits       | `specs/012b-super-admin-ui/reviews/code-reviewer.md` |
| security-auditor    | 0        | —          | 3 warnings (all pre-existing — W-1 invitations RLS gap, W-2 invitations brand-scope at RLS layer, W-3 latent `master` role ambiguity) | `specs/012b-super-admin-ui/reviews/security-auditor.md` |
| test-engineer       | —        | —          | 18 PASS, **1 FAIL** (AC S1 catalog ingredient count missing), 5 NOT TESTED (now covered by probe walk) | `specs/012b-super-admin-ui/reviews/test-engineer.md` |
| probe walk (main Claude §6) | — | — | super-admin path PASS at desktop 1440 / tablet 1024 / phone 414; negative test PASS (BrandPicker + Brands group hidden when role flips back to master); zero console errors | `specs/012b-super-admin-ui/reviews/probe-walk.md` |

Overall: 2 Criticals (architectural), 6 Should-fix, 1 AC FAIL, 0 security
blockers, all live-probe gaps closed.

## Cleanup bundle (apply pre-commit AND pre-prod-push)

Ordered by severity (Critical → Should-fix → Nit). Top-down apply, then
re-verify with a `tsc --noEmit` and a quick re-probe of BrandsSection +
BrandPicker.

### Critical (architectural contract drift — CLAUDE.md convention)

1. **`src/lib/auth.ts:355-358, 363-365`** — Move the `supabase.from('stores')`
   brand-store filter and `supabase.from('invitations')` email-inference
   sub-queries out of `fetchAllUsers` into `db.ts` helpers (e.g.
   `fetchStoresForBrand(brandId)` and `fetchPendingInvitationEmailsByBrand(brandId)`),
   and have `fetchAllUsers` delegate. Pure data reads with no auth-session
   dependency belong in `db.ts` per CLAUDE.md.

2. **`src/screens/cmd/sections/BrandsSection.tsx:54, 79, 116`** — Add
   `loadBrandStats` and `loadBrandAdmins` actions to `useStore`, expose
   the resulting `brandStats` / `brandAdminsByBrandId` slices, and
   replace the three direct `db.ts` imports/calls with the store hooks.
   Matches every other section under `src/screens/cmd/sections/`.

### Should-fix (correctness + UX)

3. **`src/lib/db.ts:1607-1629` + `src/screens/cmd/sections/BrandsSection.tsx`
   list-pane render + header summary** — AC S1 spec deviation:
   add `catalogIngredientCount` to the `fetchBrandsWithStats` SELECT
   (left join `catalog_ingredients` count) and render it in the list
   row + header summary alongside `storeCount` and `memberCount`.
   ~3 lines of code; closes the test-engineer FAIL.

4. **`src/lib/auth.ts:378` and `src/lib/db.ts:1704-1705`** — Replace
   name-based invitation→profile email resolution with `profile_id` (or
   `email` directly) join. Two admins sharing a display name currently
   get swapped emails.

5. **`src/lib/db.ts:1607-1629`** — `fetchBrandsWithStats` counts ALL
   profiles for a brand but UI labels the result "admins"
   (`BrandsSection.tsx:292`). Either filter the embed to `role=admin`
   or change the UI label to "members".

6. **`src/store/useStore.ts:391-414` + `BrandsSection.tsx:69`** —
   `createBrand` doesn't trigger a `brandStats` re-fetch (the local
   `useEffect` dep `brandsList.length` doesn't tick on optimistic
   insert + UUID swap). Newly created brand shows in picker
   immediately but NOT in the left-pane list until navigate-away-and-back.
   Fix: re-fetch `brandStats` in `createBrand`'s success path, or use
   a version counter dep. Resolves implicitly once item #2 lands and
   `createBrand` invalidates the store-level slice.

7. **`src/components/cmd/BrandFormDrawer.tsx:57-61` and
   `src/components/cmd/InviteAdminDrawer.tsx:120-132`** — Stale-closure
   bug in the keydown `useEffect`: `handleSave` captured via closure
   without dep, suppressed by `eslint-disable`. Switch to the
   `useRef`-backed pattern used elsewhere in the codebase.

8. **`src/components/cmd/BrandFormDrawer.tsx:79,134`,
   `src/components/cmd/InviteAdminDrawer.tsx:150,205`,
   `src/screens/cmd/sections/BrandsSection.tsx:254,415`** — Replace
   inline `'#000'` hex literals with a token from `useCmdColors()`
   (add `C.accentFg` if needed); current code assumes black is always
   readable on `C.accent`, which is palette-dependent.

9. **`App.tsx:34` and `src/store/useStore.ts:41`** — Extract the
   duplicated `ACTIVE_BRAND_KEY = 'imr.cmd.superAdmin.activeBrand'`
   constant into a single export from `useStore.ts` and import it in
   `App.tsx`.

### Nits (apply if cheap, otherwise defer)

10. `src/components/cmd/BrandPicker.tsx:121` — rename `'__all__'`
    sentinel key to `'__all_brands__'` for future-reader clarity.
11. `src/screens/cmd/sections/BrandsSection.tsx:38` — add comment
    explaining `tabId='profile.tsx'` mirrors VendorsSection.
12. `src/screens/cmd/sections/BrandsSection.tsx:69` — add comment
    explaining the `brandsList.length` dep (or replace with version
    counter once item #6 lands).
13. `src/hooks/useRole.ts:4` — update the stale "this file goes away"
    comment now that `useIsSuperAdmin()` is permanent.
14. `src/components/cmd/BrandFormDrawer.tsx:82` — switch
    `fontWeight: '600'` to `sans(600)` for consistency.
15. `src/lib/db.ts:1702-1705` — reword the misleading "profiles table
    has email" comment.
16. `src/lib/auth.ts:363` — when `opts.brandId` is supplied, scope
    the invitations query with `.eq('brand_id', opts.brandId)`.

## Justification

Two reviewer Criticals exist (`code-reviewer.md` C1 and C2). Per
CLAUDE.md's hard rule, that alone forces FIXES_NEEDED — the rule does
not distinguish between "convention drift" and "broken build" Criticals.
Both Criticals describe ~5 files of mechanical relocation work
(`auth.ts` sub-queries → `db.ts`; `BrandsSection.tsx` direct `db.ts`
calls → `useStore` actions); they are not invasive but they ARE
architectural and should land before commit. Bundling the test-engineer
S1 FAIL (catalog ingredient count, ~3 lines) and the 6 Should-fix items
into the same cleanup pass keeps the review-fix loop tight. Security
review is clean (W-1/W-2/W-3 are all pre-existing and the developer
surfaced them honestly); the probe walk closes the 5 NOT TESTED gaps.

## Out-of-scope follow-ups

These were flagged by reviewers but belong in a separate spec, not this
commit:

- **Security W-1**: widen invitations RLS (`SELECT/INSERT/UPDATE/DELETE`)
  policies to `... OR public.auth_is_super_admin()`. Not a regression
  introduced by 012b; masked in prod today by `wzhchen113@gmail.com`'s
  pre-012a JWT app_metadata. Track as a tiny follow-up migration before
  any second super-admin is provisioned.
- **Security W-2**: `invitations` SELECT policy is JWT-admin only, not
  brand-scoped. Pre-existing; pair with W-1 in the same follow-up
  migration.
- **Security W-3**: `'master'` role + 012a CHECK ambiguity. Latent,
  not introduced by 012b. No action needed unless a future spec creates
  master profiles via the invite flow.
- **Brand renaming + soft-delete**: explicitly deferred to **Spec 012c**
  per the BrandsSection footer note ("brand renaming and soft-delete
  are out of scope for 012b").
- **Test framework gap**: 5th spec in a row with no jest/vitest/playwright.
  Test-engineer recommended `scripts/smoke-012b-invite-flow.sh` to cover
  the load-bearing 012a invite-bug fix. Worth tracking as its own
  testing-infra spec.
- **Stale `inviteUserLegacy` shim** (`src/lib/auth.ts:204-224`,
  `src/screens/AdminScreens.tsx:1400`): legacy AdminScreens form is
  being retired; the soft regression in its behavior (admin
  invitations now fail pre-flight) is acceptable per spec Risks #1.
  Final removal lands when `EXPO_PUBLIC_NEW_UI` becomes default
  (per CLAUDE.md, target: next month).
- **`npm audit` pre-existing transitive deps** (5 moderate + 1 high in
  jsPDF / Expo toolchain chains). Out of scope for 012b; track as a
  separate dep-cleanup spec.
- **Cross-brand `store_ids` legacy invitations latent risk** in
  `registerInvitedUser` loop (security-auditor §"Register-invited-user
  data flow"). New `InviteAdminDrawer` cannot create such bad
  invitations; pre-existing issue, low blast radius.

## Prod-push gate

Per the established session pattern across Specs 003 / 006 / 007 / 008 /
009 / 010 / 011 / 012a:

1. Apply this cleanup bundle inline.
2. Re-run `tsc --noEmit` + a quick BrandsSection / BrandPicker re-probe
   (resize at 1440 / 1024 / 414).
3. User authorizes commit.
4. User authorizes "push to prod" — at which point the local migration
   `20260510000000_invitations_brand_id.sql` (currently applied locally
   only) gets pushed via `npx supabase db push`.

## Handoff

next_agent: NONE
prompt: FIXES_NEEDED, 16 items (2 Critical convention violations + 1 AC FAIL + 6 Should-fix + 7 nits), top: move `fetchAllUsers` sub-queries from `auth.ts` into `db.ts` per CLAUDE.md.
payload_paths:
  - specs/012b-super-admin-ui/reviews/release-proposal.md
