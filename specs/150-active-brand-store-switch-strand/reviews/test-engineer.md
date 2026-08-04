## Test report for spec 150

### Acceptance criteria status

- AC-1 Cold start with a cached brand that has no visible store lands on "All brands" **and** a real store; the persisted key is rewritten. → PASS — `src/store/useStore.activeBrand.test.ts::active-brand restore (Spec 150 D) > (a) rescues a device stuck on a brand with no visible stores`. Asserts `currentBrandId` → `null`, `AsyncStorage.setItem` called with `(ACTIVE_BRAND_KEY, '')`, and `currentStore.id` → `'store-a'` (not the `{id:''}` placeholder). Fails under pre-fix code (no `reconcileActiveBrand` existed) — genuinely discriminates.
- AC-2 Cold start with a VALID cached brand keeps it and lands on a store inside that brand. → PASS — same file, `> (b) keeps a VALID cached brand and lands on a store inside it`. Asserts landing store is `store-c` (in `brand-2`), not `allStores[0]` (`store-a`, `brand-1`) — pins the "validated brand, not `allStores[0]`" half of the design too.
- AC-3 Picking a store-less brand live falls back instead of stranding. → PASS — `useStore.activeBrand.test.ts::setCurrentBrandId — store-less brand > (c)` and `(c2)`; also exercised at the component layer in `PhoneStoreSwitch.test.tsx::reports the diversion when a store-less brand is picked` (mocked setter, verifies the component reads the returned outcome rather than re-deriving the guard).
- AC-4 A brand that has stores still switches normally (spec 111 overlay included) and still narrows the list to that brand's stores. → PASS — `useStore.activeBrand.test.ts::a brand that DOES have stores still switches normally` (asserts `switching === 'brand'`, the spec-111 takeover flag, plus the setter's non-diverted return value); narrowing itself is separately pinned in `storeVisibility.test.ts::narrows to the active brand...`.
- AC-5 Role visibility unchanged: privileged roles with no `user_stores` rows still see every store; non-privileged still see only their grants. → PASS — `useStore.activeBrand.test.ts::role visibility (Spec 150 — no broadening, no narrowing)` (2 cases) + `storeVisibility.test.ts::privileged roles see every store regardless of grants` / `non-privileged roles see only their grants` + the shared it.each fixtures in `TitleBar.test.tsx` and `PhoneStoreSwitch.test.tsx`.
- AC-6 The load-order guard: an unknown store set / user never clears a cached brand. → PASS — `useStore.activeBrand.test.ts::(e) does NOT clear a cached brand while the store set is still unknown` and `reconcileActiveBrand > is a no-op when the store set or the user is unknown` (both branches: empty `stores`, and `currentUser === null`).
- AC-REG Explicit "All brands" pick keeps its clear-the-store semantics. → PASS — `useStore.activeBrand.test.ts::an explicit "All brands" pick keeps its existing clear-the-store semantics`. Asserts `currentStore.id === ''` is preserved (this is the ONE place the `{id:''}` placeholder is still supposed to appear).
- AC-7 (F1) A diverted brand pick toasts the diversion, not "Switched brand"; an applied pick keeps the existing copy. → PASS — `PhoneStoreSwitch.test.tsx::reports the diversion when a store-less brand is picked` (asserts `text1`/`text2` exact copy, asserts the plain toast was NOT also fired) and `::keeps the plain switched-brand toast when the pick is applied as asked`, plus the pre-existing brand-pick test now additionally asserts the plain toast copy.
- AC-8 (F2) `TitleBar` and `PhoneStoreSwitch` render exactly `visibleStoresFor(...)` for the same fixture, and the helper matches the pre-refactor inline logic for every role × grants × brand-context combo. → PASS — `storeVisibility.test.ts::matches for every role × grants × brand-context combination` (100 combos: 4 roles × 5 grant shapes × 5 brand contexts, checked against a verbatim `legacyInline` transcription) + `TitleBar.test.tsx::TitleBar — store switcher uses the shared predicate` (5 cases) + `PhoneStoreSwitch.test.tsx::renders exactly the shared predicate output` (5 cases). Verified the two component suites use a byte-identical `FIXTURE_STORES` array (same ids/brandIds/names) and identical `test.each`/`it.each` rows — a real shared-fixture pin, not two independently-invented fixtures that happen to look similar.

### Test run

```
npx tsc --noEmit                 → clean, no output
npm run typecheck:test           → clean, no output
npx jest                         → Test Suites: 184 passed, 184 total
                                    Tests:       1847 passed, 1847 total
                                    Snapshots:   2 passed, 2 total
```

Matches the spec's claimed "184 suites / 1847 tests" exactly. All gates green — no failures to report back to the developer.

Per-file spot checks (jest --verbose, all green):
- `src/lib/storeVisibility.test.ts` — 7 tests (the 100-combo equivalence check runs as one `it` with an internal double/triple loop).
- `src/store/useStore.activeBrand.test.ts` — 15 tests, matching the spec's claimed count exactly.
- `src/components/cmd/TitleBar.test.tsx` — 8 tests total, +5 new (matches spec's claimed "+5").
- `src/screens/cmd/sections/phone/__tests__/PhoneStoreSwitch.test.tsx` — 17 tests total, **+11 new** (6 pre-existing). The spec's Verification section claims "+9 cases" — undercounts by 2 (the `it.each(['super_admin','master'])` and the 5-row shared-predicate `it.each` each expand to more cases than the prose implies). Actual coverage exceeds the claim; flagging as a documentation-accuracy nit only, not a gap.

### Notes

**Gap (non-blocking) — non-privileged role never exercises the cold-start `reconcileActiveBrand` path.** Every test in `useStore.activeBrand.test.ts::active-brand restore (Spec 150 D)` (the describe block that drives `login()` → synchronous `setCurrentBrandId(cachedBrand)` → `await flush()`, mimicking `App.tsx`'s restore ordering) uses the default `makeUser()`, which is `role: 'super_admin'`. The two places `role: 'user'` appears are (1) a live-pick test that seeds `useStore.setState` directly rather than going through `login()`'s restore tail, and (2) a plain-login test with no cached brand at all (`currentBrandId` starts `null`, so `reconcileActiveBrand`'s early-return branch fires and the store-set/role validation is never reached). So the exact scenario named in the review brief — a non-privileged user cold-booting with a *stale* cached brand whose stores exist but aren't granted to them — is not integration-tested end-to-end through `login()`. The two primitives it's built from ARE independently well-tested (`visibleStoresFor`'s role branching across all 4 roles in `storeVisibility.test.ts`, and `reconcileActiveBrand`'s mechanism against the default super_admin user), and `reconcileActiveBrand` has no role-conditional logic of its own beyond calling `visibleStoresFor`, so the practical risk is low — but it is a real, literally-named-in-the-brief edge with no direct pin. Recommend one additional case in `useStore.activeBrand.test.ts`: `login(makeUser({ role: 'user', stores: ['store-b'] }))` + `setCurrentBrandId('brand-2')` (a brand with real stores, none granted to this user) + `flush()`, asserting the brand is reconciled to `null` and the user lands on `store-b`.

**Not independently re-verified — the spec's "Browser (local stack...)" manual-QA section.** That section documents a developer walkthrough (super_admin with zero `user_stores`, empty-brand pick, cold-boot recovery, 390×844 + 1440×900) that I did not re-run in this pass; it would require booting the local Supabase stack and driving a real browser session. Given the jest coverage above pins the same scenarios at the unit/integration level (including the exact toast copy and persisted-key rewrite), I did not treat this as blocking, but flagging that the browser claims themselves are developer-asserted, not re-verified by me.

**Framework.** No new test framework introduced — all new tests are jest (component + store-slice unit), consistent with the existing three-track split. No pgTAP or shell-smoke changes were needed (frontend-only fix, no migration/edge-function/`db.ts` contract change, confirmed by the diff).

**Hard-rule files.** `app.json` slug untouched. No seed.sql mutation. Nothing in this diff touches those guardrails.

**i18n parity.** Not a manually-eyeballed claim — `src/i18n/i18n.test.ts::en, es, zh-CN have identical key sets` is a generic flattened-key-set diff over the three catalogs and ran (and passed) as part of the full suite above, so it automatically covers the three new keys (`brandNoStoresToast`, `brandNoStoresDetail`, `emptyInBrand`) added to all three files in this diff.
