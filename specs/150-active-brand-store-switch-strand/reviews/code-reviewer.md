# Code review for spec 150

Scope reviewed: `src/lib/storeVisibility.ts` (new), `src/store/useStore.ts`
(`reconcileActiveBrand`, `setCurrentBrandId`, `login()` tail), `App.tsx`
(comment-only), `src/components/cmd/TitleBar.tsx`,
`src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx`, i18n (`en`/`es`/`zh-CN`),
and the four associated test files.

Overall: this is a clean, well-scoped fix. The shared predicate is genuinely
one function now (verified: `TitleBar.tsx`, `PhoneStoreSwitch.tsx`, and
`useStore.ts` all import `visibleStoresFor` from `src/lib/storeVisibility.ts`,
no residual inline copies). The module-placement rationale for
`storeVisibility.ts` (can't live in `lib/cmdSelectors.ts` without a cycle) is
verified correct — `cmdSelectors.ts` imports `useStore` directly (line 2) and
`hooks/useRole` (line 8), which itself imports `useStore` (line 7); either path
closes a cycle if `useStore.ts` imported `cmdSelectors.ts`. The additive
`setCurrentBrandId` return value doesn't break any existing caller — checked
all four production call sites (`useStore.ts:1299`, `useStore.ts:1365`,
`BrandPicker.tsx:64`, `PhoneStoreSwitch.tsx:103`); the first three discard the
return value, which is a legal narrowing of `() => string | null` to a
`() => void`-shaped call. i18n keys are present and parallel across all three
locales. Traced the `login()` → `reconcileActiveBrand` → `setCurrentBrandId`
interaction against every AC in the spec and against `useStore.activeBrand.test.ts`'s
fixtures by hand; the state transitions match in every case I traced (AC-1
through AC-8, AC-REG).

No Critical or Should-fix findings.

### Critical
(none)

### Should-fix
(none)

### Nits
- `src/store/useStore.ts:1095-1101` vs `src/store/useStore.ts:1179-1183` — the
  "is this brand stranded for this user?" guard (`brandId !== null &&
  stores.length > 0 && user !== null && visibleStoresFor(...).length === 0`)
  is written out independently in `setCurrentBrandId` and again (inverted) in
  `reconcileActiveBrand`. Both call the shared `visibleStoresFor`, so this
  isn't the byte-for-byte drift spec 150 itself fixed, but the two guard
  conditions could still drift from each other in a future edit. A small
  `isBrandStranded(stores, user, brandId): boolean` helper alongside
  `visibleStoresFor` in `storeVisibility.ts` would remove the duplication.
  Low priority — the guard is three short, well-commented lines in each spot.
- `src/store/useStore.ts:1015-1019` — `login()`'s `db.fetchStores().catch(...)`
  fallback (network-failure path) does not call `reconcileActiveBrand`, so a
  device stuck on a store-less cached brand is not rescued when the initial
  fetch itself fails (as opposed to succeeding with an empty/short list). In
  practice this is close to a no-op gap: `get().stores` is unpersisted and
  empty on a true cold boot, so even a `reconcileActiveBrand` call there would
  hit the "store set unknown" no-op branch. Worth a one-line comment (or a
  follow-up spec) noting the catch path is deliberately not in scope for the
  rescue, so a future reader doesn't wonder why it's asymmetric with the
  `.then` tail.
- `src/store/useStore.ts:1004-1010` — the `userStore` resolution in `login()`
  is a four-deep `||` fallback chain (`visible.find` → `visible[0]` →
  `allStores.find` → `allStores[0]`). It's accurately commented ("Defensive
  tail: preserves the pre-spec-150 pick..."), but a named intermediate (e.g.
  split the "visible-first" and "legacy allStores" halves into two lines with
  a comment on each) would make the four branches easier to scan at a glance.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 0 Should-fix, 3 Nits.
payload_paths:
  - specs/150-active-brand-store-switch-strand/reviews/code-reviewer.md
