# Spec 150: Active-brand validation — phone store switcher shows no stores

Status: READY_FOR_REVIEW

> Bug fix from a live owner report: on a phone, the store-switch sheet
> (`PhoneStoreSwitch`, spec 148) offered BRANDS but listed **no stores** ("No
> stores available"), while the desktop shell showed the full store list for the
> same account. Frontend-only; no backend / migration / edge-function /
> `src/lib/db.ts` contract change.

## Root cause (reproduced, not inferred)

The reported theory — that the phone sheet filters stores by an explicit
per-user access list that is empty for `super_admin` / `master` — is **wrong**.
`PhoneStoreSwitch`'s predicate is a byte-for-byte copy of `TitleBar`'s
(`admin | master | super_admin` see every store; everyone else sees their
`user_stores` grants; then narrow to `currentBrandId`), and both tiers were
verified to behave identically in a browser.

The real cause is the **brand narrowing combined with per-device persistence**:

1. `currentBrandId` is persisted per device (`imr.cmd.superAdmin.activeBrand`
   in localStorage / AsyncStorage) and re-applied on every cold start
   (`App.tsx` restore path).
2. A brand with **no role-visible active store** (a brand created for testing,
   or one whose stores are all `status != 'active'`) narrows the list to zero.
   `setCurrentBrandId` then set `currentStore` to the `{ id: '' }` placeholder,
   so every store-scoped surface — the store switcher included — rendered empty.
3. The choice is persisted, so the state **survived reloads**. The phone stayed
   stuck; desktop looked fine only because its cached value differed (or was
   null = "All brands").

The phone-specific trap door: the phone sheet is the only surface that offers
brand switching *inside* the store switcher, so a tap meant as "filter" silently
teleported the session into a store-less brand — with the store list the user
opened the sheet for now blank.

Verified parity before the fix: with the same state, the desktop TitleBar
dropdown rendered `No results`. So "make the phone match desktop" would have
been a no-op.

## Design

### D — root fix (store)

- `visibleStoresFor(stores, user, brandId)` — one module-level pure predicate in
  `useStore.ts` mirroring the chrome's store-switcher filter.
- `reconcileActiveBrand(knownStores?)` — new store action. If `currentBrandId`
  resolves to zero visible stores, drop to "All brands" (`null`) **and rewrite
  the persisted key**, which is what rescues a device already stuck. No-op when
  the store set or the user is not yet known (cold boot), so a valid cached
  brand is never cleared prematurely. Does not touch `currentStore`.
- `login()`'s `fetchStores` tail calls it — the first moment both halves are
  known (the restore path re-applies the cached brand synchronously, before the
  fetch resolves) — and then resolves the landing store from the *validated*
  brand instead of `allStores[0]`, which could sit in a different brand.
- `setCurrentBrandId()` refuses to enter a store-less brand when the store set
  is known: it falls back to "All brands" and keeps / picks a real store rather
  than the `{ id: '' }` placeholder. An explicit "All brands" pick keeps its
  existing clear-the-store semantics (the consumer forces section `Brands`).
  Adding stores to an empty brand is unaffected — the BrandsSection Stores tab
  is scoped by its own selected-row `brandId`, not by `currentBrandId`.

Both tiers inherit the fix (it lives in the shared store). Brand narrowing is
otherwise unchanged: a brand that *does* have stores still narrows to exactly
those stores.

### C — copy (phone sheet)

The residual empty state names the brand it is scoped to
(`chrome.phone.storeSwitch.emptyInBrand`: "No stores in {brand} — pick another
brand below") instead of the bare "No stores available", which read as "you have
no access". Defense-in-depth for the pre-`fetchStores` window where the brand
cannot be validated. New key added to `en` / `es` / `zh-CN`.

### Follow-ups (approved in the same pass)

**F1 — honest diverted-brand toast.** `setCurrentBrandId` now *returns* the
brand id actually in effect (additive; existing callers ignore it). The phone
sheet reads that return value to tell a real switch from a diverted one and
shows `"<brand> has no stores" / "Showing all brands"` instead of the
misleading "Switched brand". The guard's condition is NOT re-derived in the
component. Two-line toast (`text1` + `text2`, the `notifyBackendError` shape)
because one line truncates at phone width — verified in the browser.
Desktop's `BrandPicker.handlePick` has **no toast path at all** (it switches
silently and only requests the `Brands` section when the user explicitly picks
"All brands"), so per instruction it is left as-is: a diverted desktop pick
silently lands on "All brands", which the always-visible BRAND chip already
reflects. Flagged for a future spec if the owner wants desktop parity.

**F2 — shared visibility predicate (option B).** The access filter that was
copy-pasted byte-for-byte into `TitleBar` and `PhoneStoreSwitch` (and then a
third time inside the store for D) now lives once in
`src/lib/storeVisibility.ts` (`visibleStoresFor` + `isPrivilegedRole`) and is
consumed by all three. It is a standalone pure module rather than an export off
`useStore.ts` because component tests routinely mock the whole store module
(which would stub the shared predicate out of the surfaces that are supposed to
share it), and it cannot live in `lib/cmdSelectors.ts` without closing a require
cycle (`cmdSelectors → hooks/useRole → useStore`). Behaviour is unchanged; the
equivalence is pinned against a verbatim transcription of the old inline
expression.

## Acceptance criteria

- AC-1 A cold start with a cached brand that has no visible store lands on
  "All brands" **and** a real store; the persisted key is rewritten.
- AC-2 A cold start with a VALID cached brand keeps it and lands on a store
  inside that brand.
- AC-3 Picking a store-less brand live falls back instead of stranding.
- AC-4 A brand that has stores still switches normally (spec 111 overlay
  included) and still narrows the list to that brand's stores.
- AC-5 Role visibility unchanged: privileged roles with no `user_stores` rows
  still see every store; non-privileged still see only their grants.
- AC-6 The load-order guard: an unknown store set / user never clears a cached
  brand.
- AC-REG Explicit "All brands" pick keeps its clear-the-store semantics.
- AC-7 (F1) A diverted brand pick toasts the diversion, not "Switched brand";
  an applied pick keeps the existing copy.
- AC-8 (F2) `TitleBar` and `PhoneStoreSwitch` render exactly
  `visibleStoresFor(...)` for the same fixture, and the helper matches the
  pre-refactor inline logic for every role × grants × brand-context combo.

## Verification

Jest (184 suites / 1847 tests green, plus `tsc --noEmit` and `typecheck:test`):

- `useStore.activeBrand.test.ts` — 15 cases, AC-1…AC-6 + AC-REG, incl. the
  setter's returned outcome.
- `storeVisibility.test.ts` — old-vs-new equivalence over 4 roles × 5 grant
  shapes × 5 brand contexts, plus the contract cases (AC-8).
- `PhoneStoreSwitch.test.tsx` — +9 cases: super_admin/master with no grants,
  both empty copies, the diverted vs applied toast (AC-7), and the shared-
  predicate render table.
- `TitleBar.test.tsx` — +5 cases: the desktop half of the shared-predicate pin,
  against the SAME fixture as the phone half (AC-8).

Browser (local stack, super_admin with zero `user_stores`, second brand with no
stores, 390×844 + 1440×900): baseline 4 stores; picking the empty brand keeps
all 4 (was 0) and toasts "BALTIMORE SEAFOOD has no stores / Showing all brands";
picking a real brand keeps the plain "Switched brand"; cold boot on the seeded
stuck key recovers and rewrites the key; valid cached brand still restores; a
1-store brand still narrows to that 1 store on both phone and desktop; desktop
diverts silently to the "All brands" chip. No console errors.

## Files changed

- `src/lib/storeVisibility.ts` (new — the shared predicate, F2)
- `src/store/useStore.ts`
- `src/components/cmd/TitleBar.tsx` (consumes the shared predicate, F2)
- `src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx`
- `src/i18n/en.json`
- `src/i18n/es.json`
- `src/i18n/zh-CN.json`
- `App.tsx` (comment only — documents why no reconcile call belongs there)
- `src/lib/storeVisibility.test.ts` (new)
- `src/store/useStore.activeBrand.test.ts` (new)
- `src/screens/cmd/sections/phone/__tests__/PhoneStoreSwitch.test.tsx`
- `src/components/cmd/TitleBar.test.tsx`
- `src/store/useStore.switching.test.ts` (comment only — T8b scope note)
- `specs/150-active-brand-store-switch-strand.md` (new)
