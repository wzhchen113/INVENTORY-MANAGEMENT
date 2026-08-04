# Security audit for spec 150

Scope reviewed: staged diff (`git diff HEAD`) — `src/lib/storeVisibility.ts` (new),
`src/store/useStore.ts`, `src/components/cmd/TitleBar.tsx`,
`src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx`, the three i18n catalogs,
`App.tsx` (comment only), plus the four test files. No migration, no edge
function, no `src/lib/db.ts` change, no `package.json` change.

Verdict: **no Critical, no High.** Nothing here BLOCKS. The refactor is a
strict-equivalence extraction on the two chrome consumers and a **tightening**
inside the store; the server-side boundary (RLS) is untouched.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `src/store/useStore.ts:1007-1010` — the login-tail defensive fallback
  (`allStores.find(grant) || allStores[0]`) can select a store the user has no
  `user_stores` grant for whenever `visible` is empty, and `allStores` may be a
  **stale in-memory list from a previous session in the same tab**: `logout()`
  (`src/store/useStore.ts:1026-1044`) never clears the `stores` slice (only
  initialiser at `src/store/useStore.ts:881`), and `login()` falls back to
  `get().stores` when `fetchStores()` returns zero rows
  (`src/store/useStore.ts:993`). Impact is bounded and cosmetic: the chrome
  could render a prior/ungranted store's name + address on a shared browser
  until the next fetch, while every store-scoped read stays RLS-blocked
  (`store_member_read_stores` → `auth_can_see_store(id)`,
  `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:616-618`). This
  is **pre-existing** — spec 150 preserves the old expression verbatim as the
  tail — so it is not a regression. Fix (optional, follow-up): clear `stores` in
  `logout()`, or drop the bare `allStores[0]` arm now that `visible[0]` exists.

- `src/store/useStore.ts:1145-1147` — the brand-switch store pick keeps the
  legacy unfiltered `knownStores.find((s) => s.brandId === target)` when
  `currentUser` is `null`, i.e. it does not apply the grants filter in that
  window. Practically unreachable (both brand pickers are super-admin-gated via
  `useIsSuperAdmin()`, `src/hooks/useRole.ts:24-27`, which requires a loaded
  user) and identical to pre-spec-150 behaviour; RLS is still the gate. Noted
  only because it is the one branch where the new code deliberately does *not*
  route through the shared predicate.

- Informational, pre-existing, **out of scope for this spec**: the client
  predicate's "privileged sees every store" arm
  (`src/lib/storeVisibility.ts:28-30`) faithfully mirrors the DB, but the DB
  arm itself is not brand-scoped — `auth_can_see_store()` short-circuits on
  `auth_is_admin()` (JWT role in `admin`/`master`), with no brand check
  (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:216-227`),
  while `brands` SELECT *is* brand-scoped (`auth_can_see_brand(id)`, same file
  `:422-427`). So a brand-X `admin` can read `public.stores` rows of brand Y
  (name/address) even though they cannot read brand Y itself. Not introduced by
  spec 150 and not a client-side bug; flagged because this spec canonicalises
  the client mirror of that rule in a shared module and a future reader may take
  `storeVisibility.ts`'s doc comment as evidence the DB is brand-scoped here. If
  cross-brand store metadata is meant to be hidden from non-super-admins, that
  is a DB-side spec.

### Answers to the specific questions asked

1. **Does `visibleStoresFor` preserve pre-refactor semantics in all three
   consumers?** Yes.
   - `TitleBar` (`src/components/cmd/TitleBar.tsx:91`): the removed inline block
     and `src/lib/storeVisibility.ts:45-52` are token-for-token the same
     expression (privileged set → all stores, else `user?.stores?.includes`,
     then `brandId === null || s.brandId === brandId`).
   - `PhoneStoreSwitch` (`src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx:69-71`):
     same substitution; the only other change is dropping the derived `isAdmin`
     from the `useMemo` deps, which is safe because it was a pure function of
     `currentUser` (still a dep).
   - `useStore`: this consumer is **narrower** than before, never wider.
     `setCurrentBrandId`'s brand-switch pick was `stores.find(s => s.brandId === brandId)`
     with **no** per-user filter; it is now `visibleStoresFor(...)[0]`
     (`src/store/useStore.ts:1145-1146`), so a non-privileged user can no longer
     land on an ungranted store. Same for the login tail
     (`src/store/useStore.ts:1003-1006`) and the diverted-brand fallback
     (`src/store/useStore.ts:1116-1120`).
   - Equivalence is machine-pinned against a verbatim transcription of the old
     expression over 4 roles × 5 grant shapes × 5 brand contexts
     (`src/lib/storeVisibility.test.ts:17-64`). I ran the four spec-150 suites:
     47/47 pass.

2. **No broadening for non-privileged roles?** Confirmed. The privileged set is
   `admin | master | super_admin` (`src/lib/storeVisibility.ts:29`), exactly the
   pre-refactor set and exactly 3 of the 4 values of `UserRole`
   (`src/types/index.ts:10`); `user` is unchanged and still limited to its
   `user_stores` grants. No new role was added to the set, and no call site
   passes a synthetic/elevated user — every call passes either the live
   `currentUser` slice or `login()`'s own `user` argument.

3. **Fail-closed on a null user?** Yes, and it is pinned
   (`src/lib/storeVisibility.test.ts:91-94`). `isPrivilegedRole(null)` is
   `false`, and the non-privileged arm's `user?.stores?.includes(...)` yields
   `undefined` → empty list. Both new store paths handle "user not known yet"
   explicitly rather than acting on the empty result: the divert guard requires
   `knownUser !== null` (`src/store/useStore.ts:1100`) and
   `reconcileActiveBrand` returns the current value untouched when
   `user === null` or `stores.length === 0` (`src/store/useStore.ts:1180`). That
   fail-*open* is on a cosmetic filter only (it declines to CLEAR a cached brand),
   never on an access decision, so it does not expose anything.

4. **Can the brand-fallback logic surface stores a restricted user shouldn't
   see?** No. Every fallback resolves through the same predicate with the live
   `currentUser`: the diverted-brand path uses
   `visibleStoresFor(knownStores, get().currentUser, null)` and picks
   `fallback.find(grant) || fallback[0]` from that already-filtered list
   (`src/store/useStore.ts:1116-1120`), so for a non-privileged user `fallback`
   contains only granted stores. `reconcileActiveBrand` writes only
   `currentBrandId` + the localStorage key — it never touches `currentStore`
   (`src/store/useStore.ts:1174-1189`). The only unfiltered arm left is the
   `currentUser === null` branch noted under Low.

5. **Is client-side visibility still cosmetic, with RLS untouched?** Yes.
   - The diff contains zero `supabase/` files and zero `src/lib/db.ts` changes;
     `stores` is still read by `fetchStores()` (`src/lib/db.ts:59-78`) with no
     brand or user parameter — the row set is decided server-side by
     `store_member_read_stores`/`auth_can_see_store`.
   - `currentBrandId` is never sent to the backend. Grepping all non-test
     consumers, it is used only for `.filter()` comparisons, `brandsList.find`,
     and chip/row highlighting — it is not a query predicate, so a
     hand-edited `imr.cmd.superAdmin.activeBrand` localStorage value
     (`src/store/useStore.ts:124`, `144-152`) can only change which of the
     already-authorised rows are displayed. Post-150 an unrecognised value now
     self-heals to "All brands" instead of blanking the UI.
   - No injection sink: brand/store names land in React Native `<Text>` and
     `Toast` `text1`/`text2` (`src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx:106-115`,
     `:186-191`) — no HTML/`dangerouslySetInnerHTML` path, so the new
     `{brand}` interpolation in `en/es/zh-CN` is not an XSS surface.
   - The displayed brand name resolves only from `brandsList` (super-admin-only
     load, RLS-scoped by `brand_member_read_brands` →`auth_can_see_brand(id)`)
     or the already-loaded `brand` slice, and falls back to the generic copy
     when neither matches (`src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx:82-84`).
     No name for a brand the user cannot read can appear.

### Also checked, clean

- No secrets, tokens, keys, or `process.env` / `EXPO_PUBLIC_*` usage introduced
  (diff-wide grep for `process.env|EXPO_PUBLIC|SERVICE_ROLE|apikey|Bearer`
  returns only an unrelated comment line).
- No new `console.log/warn/error` and no PII added to any log or toast payload —
  the new toast carries a brand name the user just tapped.
- No new edge function, so the `verify_jwt` / `ADMIN_ROLES`+`super_admin` /
  `escapeHtml` / last-of-role / self-guard checklists do not apply.
- No destructive path (no delete, no role change, no `auth.admin.*`).
- No new `useRole()` (placeholder) usage as a security boundary; the phone sheet
  still gates the brand list on `useIsSuperAdmin()`, which reads the live
  `profiles.role` — same as before this spec, and it gates UI + a fetch whose
  rows RLS already scopes.

### Dependencies

No `package.json` / lockfile changes in this diff — `npm audit` skipped per
process step 3.
