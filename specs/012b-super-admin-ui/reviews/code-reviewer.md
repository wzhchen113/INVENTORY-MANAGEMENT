# Code reviewer findings — Spec 012b

> Note: code-reviewer agent emitted findings as inline output (its system
> prompt restricts file writes); main Claude transcribed verbatim into
> this file so release-coordinator can read it.

## Critical

- **`src/lib/auth.ts:355–358` and `src/lib/auth.ts:363–365`** — Direct
  `supabase.from(...)` calls inside `fetchAllUsers` that are NOT auth
  operations. The two new `supabase.from('stores')` (brand-store filter)
  and `supabase.from('invitations')` (email inference) additions are
  data-layer queries that belong in `db.ts` per CLAUDE.md ("All
  PostgREST/RPC traffic flows through `src/lib/db.ts`"). `fetchAllUsers`
  is a new bulk-read function added in this spec; it should either live
  in `db.ts` or delegate its sub-queries to existing `db.ts` helpers.
  The `inviteUser` / `registerInvitedUser` functions in `auth.ts` are a
  pre-existing tolerated exception for the auth flow, but the
  `fetchAllUsers` additions are pure data reads with no auth-session
  dependency — they are incorrectly placed.

- **`src/screens/cmd/sections/BrandsSection.tsx:116`** — `refreshAfterInvite`
  calls `fetchBrandAdmins(selectedId).then(setAdmins)` — a direct import
  from `db.ts` invoked from a screen component. CLAUDE.md convention
  routes all data operations through `useStore`. The same function is
  also called directly at line 79 inside the `useEffect`.
  `fetchBrandAdmins` and `fetchBrandsWithStats` (line 54) are both called
  directly from the screen rather than through store actions. This is
  inconsistent with every other section in `src/screens/cmd/sections/`
  — they all read from `useStore` slices and dispatch store actions. The
  fact that the results are local component state (not shared) doesn't
  exempt the calls from the convention. Either add `loadBrandAdmins` /
  `loadBrandStats` actions to `useStore` (preferred), or document
  clearly in a comment why this section deviates from the store
  convention.

## Should-fix

- **`src/lib/auth.ts:378` and `src/lib/db.ts:1704–1705`** — Email
  resolution matches invitation rows by **display name**
  (`find((inv) => inv.name === p.name)` /
  `inviteByName.set(inv.name, inv)`). Two admins sharing a display name
  get swapped emails. Practical fix: use `profile_id` for the
  active-profile join in `fetchBrandAdmins`, or switch to using `email`
  as the join key.

- **`src/lib/db.ts:1607–1629`** — `fetchBrandsWithStats` counts ALL
  profiles for a brand (`profiles(count)`) regardless of role. The
  left-pane list displays the count as "admins"
  (`BrandsSection.tsx:292`: `{b.memberCount} admins`). Wrong label for
  brands that have both admin and user-role profiles. Either filter the
  embed to `role=admin` or change the UI label to "members".

- **`src/store/useStore.ts:391–414`** — `createBrand` does not trigger a
  re-fetch of `BrandsSection`'s local `brandStats` state. The store
  swaps the temp-id for the real UUID in `brandsList`, but
  `BrandsSection` maintains a separate `brandStats` populated by a
  direct `fetchBrandsWithStats()` call in its own `useEffect`. The dep
  array of that effect is `[isSuperAdmin, brandsList.length]` (line 69)
  — which does NOT change when a brand is created (optimistic insert
  keeps the count the same, then swap keeps it the same). Newly created
  brand shows in the picker immediately but NOT in the left-pane list
  until navigate-away-and-back. Fix: call `fetchBrandsWithStats` inside
  the `createBrand` success path, or use a version counter dep rather
  than `brandsList.length`.

- **`src/components/cmd/BrandFormDrawer.tsx:57–61` and
  `src/components/cmd/InviteAdminDrawer.tsx:120–132`** — The `keydown`
  handler `useEffect` captures `handleSave` (capturing `name`/`values`
  and `submitting`) via closure without including `handleSave` in the
  dep array (suppressed by `eslint-disable`). Stale-closure bug: if the
  user types between renders, the keydown handler fires with stale form
  state. The safe pattern used elsewhere is to store `handleSave` in a
  `useRef` and read `.current` inside the handler. The `eslint-disable`
  comment papers over the real issue.

- **`src/components/cmd/BrandFormDrawer.tsx:79,134` and
  `src/components/cmd/InviteAdminDrawer.tsx:150,205` and
  `src/screens/cmd/sections/BrandsSection.tsx:254,415`** — Inline hex
  literals `'#000'` hardcoded as text color for badge labels and button
  text. CLAUDE.md requires theming through `useColors()` /
  `useCmdColors()` tokens. On dark-mode palette `C.accent` may not be
  light, so the assumption that `'#000'` is always readable on
  `C.accent` background is palette-dependent. Add a `C.accentFg` token
  or use `C.fg` with comment.

- **`App.tsx:34` and `src/store/useStore.ts:41`** —
  `ACTIVE_BRAND_KEY = 'imr.cmd.superAdmin.activeBrand'` is duplicated
  verbatim in both files. If the key ever changes, two sites must be
  updated in sync. Extract to a shared constant.

## Nits

- **`src/components/cmd/BrandPicker.tsx:121`** — Phone FlatList uses
  `'__all__'` as a local sentinel key. Architect explicitly chose `null`
  to avoid collision (Risks #5). Local-only collision can't happen at
  runtime here, but confusing for future readers. Rename to
  `'__all_brands__'`.
- **`src/screens/cmd/sections/BrandsSection.tsx:38`** — `tabId` initial
  value `'profile.tsx'` looks like a filename. Mirrors VendorsSection
  intentionally; add a brief comment.
- **`src/screens/cmd/sections/BrandsSection.tsx:69`** — `useEffect` dep
  `brandsList.length` is a fragile proxy for "was a brand created". Add
  comment noting why instead of stable version counter.
- **`src/hooks/useRole.ts:4`** — Existing comment "when the staff
  cleanup is done in every consumer, this file goes away" is now
  incorrect: `useIsSuperAdmin()` is permanent. Add clarification.
- **`src/components/cmd/BrandFormDrawer.tsx:82`** — Uses `fontWeight:
  '600'` inline instead of `sans(600)` from typography helper. Rest of
  the file uses `sans(...)` consistently.
- **`src/lib/db.ts:1702–1705`** — Comment "Pull invitation emails for
  active profiles whose email isn't in the profiles table" is
  misleading. Profiles table has no email column. Reword.
- **`src/lib/auth.ts:398–397`** (out-of-scope) — `fetchAllUsers`
  invitations query at line 363 fetches ALL invitations with no brand
  filter even when `opts.brandId` is supplied. Consider adding
  `.eq('brand_id', opts.brandId)` when `opts.brandId` is set.
