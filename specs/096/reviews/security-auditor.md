# Security audit for spec 096 (re-review after fix cycle)

Spec: `specs/096-shared-units-and-dual-cost-display.md` (READY_FOR_REVIEW)
Scope still display-only: no migration, no RPC, no edge function, no RLS change, no
`package.json` change. All changes are client-side TypeScript. Re-verified against the
current code.

This is a re-review of the single **Medium** (cross-brand unit-name leak) and the
single **Low** from the prior pass. Both are addressed below against the actual code,
not the change description.

## Verdict up front

The Medium is **RESOLVED**. No residual cross-brand exposure. No Critical, no High, no
remaining Medium. The one Low is unchanged and remains non-action-requiring. Nothing
blocks.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None remaining.

**RESOLVED — prior Medium (cross-brand unit-name leak via the `inventory` axis).**
The prior finding was that `deriveBrandUnitPool` unioned `inventory.unit` ∪
`inventory.subUnitUnit`, and `inventory` is loaded by `fetchInventory()` with no
`storeId`/brand pin, so a non-pinned `admin`/`master` (whose `inventory_items` SELECT
RLS short-circuits on `auth_is_admin()`) saw brand B's custom unit names in brand A's
dropdowns — contradicting AC3's "brand-scoped by construction." The fix removes the
`inventory` axis entirely. Verified end-to-end:

- **Function no longer accepts `inventory`.** `deriveBrandUnitPool`'s signature is now
  `{ catalogIngredients: {unit, subUnitUnit}[]; conversions: {purchaseUnit}[] }`
  (`src/utils/brandUnitPool.ts:51-53`). The body unions only
  `catalogIngredients.unit` ∪ `catalogIngredients.subUnitUnit` ∪
  `conversions.purchaseUnit` (`brandUnitPool.ts:64-66`). No `inventory` parameter
  exists to pass.

- **Both call sites pass the brand-scoped slice, not `inventory`.**
  - `src/components/cmd/IngredientForm.tsx:393-396` —
    `deriveBrandUnitPool({ catalogIngredients, conversions: allConversions })`, where
    `catalogIngredients = useStore((s) => s.catalogIngredients)`
    (`IngredientForm.tsx:380`).
  - `src/screens/cmd/sections/InventoryCatalogMode.tsx:929` (the CatalogConversionsTab
    `purchaseUnitOptions` memo) — same call, `catalogIngredients = useStore((s) =>
    s.catalogIngredients)` (`InventoryCatalogMode.tsx:872`).
  - A `grep` for `deriveBrandUnitPool` / `.inventory` across all three files confirms
    no surviving path feeds `inventory` into the pool. The only `s.inventory` read in
    InventoryCatalogMode (`:77`) feeds the per-store stock tables, never the pool.

- **`catalogIngredients` cannot carry another brand's rows — grounded in the
  store-population code, not the signature.** This is the load-bearing check, because
  the fix's correctness rests on `catalogIngredients` being genuinely brand-scoped
  where `inventory` was not. Both populating paths in
  `src/store/useStore.ts#loadFromSupabase` are sound:
  - **Single-store load** (`useStore.ts:1000-1004`): `catalogIngredients:
    data.catalogIngredients` comes from `fetchAllForStore(sid)`, which resolves the
    store's brand and calls `fetchCatalogIngredients(brandId)` (`db.ts:3536`). That
    query hard-filters **server-side** with `.eq('brand_id', brandId)`
    (`db.ts:3441`). This is a WHERE clause on the request, NOT reliance on RLS — so
    even a `super_admin` whose `catalog_ingredients` RLS would admit cross-brand rows
    receives exactly one brand's catalog. This is categorically unlike
    `fetchInventory()`, which is called with no `storeId` and no brand filter
    (`db.ts:3535`) and therefore returns every store/brand the caller's RLS admits.
  - **"All Stores" (`__all__`) load** (`useStore.ts:973-998`): `catalogIngredients:
    firstWithBrand?.catalogIngredients` — the catalog of the **single first store that
    has a brand** (`allData.find((d) => d?.brand)`, `:978-981`). It is NOT a
    `flatMap` across stores. Contrast `inventory: allData.flatMap((d) => d?.inventory
    || [])` at `:985` — the cross-brand axis from the prior finding is still
    cross-brand for `inventory`, but `inventory` no longer reaches the pool, so that
    is now inert with respect to the dropdowns. (The current prod seed is single-brand
    so `__all__` collapses to one brand regardless; the structural point is that even
    multi-brand, the catalog axis takes one brand's copy by construction, exactly as
    its load comment claims at `:970-972`.)

  Net: there is no path by which a second brand's `catalog_ingredients` rows enter
  `catalogIngredients`, so the pool — and therefore the default-unit, pack-unit, and
  Conversions-tab purchase-unit dropdowns — is brand-scoped by construction. AC3 now
  holds for real, not by an incorrect premise.

- **The previously-wrong load-bearing comments are corrected.**
  `brandUnitPool.ts:7-21` now documents the correct rationale — `catalogIngredients`
  is brand-scoped (citing the `useStore.ts` "first store's copy" behavior), while
  `inventory` is flat-mapped across every visible store and short-circuits on
  `auth_is_admin()` with no brand pin, which is why sourcing from it leaked. The
  `IngredientForm.tsx:384-392` comment no longer claims the store "only ever holds the
  active brand's inventory"; it now correctly says `inventory` is cross-brand and
  states why the pool is sourced from `catalogIngredients` instead. The
  `InventoryCatalogMode.tsx:923-928` comment carries the same corrected note. The next
  maintainer reasoning from these comments will reach the right conclusion.

- **Test pins the new shape.** `src/utils/brandUnitPool.test.ts` exercises the
  two-arg signature (`catalogIngredients` + `conversions`) across the union, the
  `lower(name)` de-dupe with first-seen casing (AC5), the both-axes gap-closer (AC1),
  and the empty/whitespace skips. No test references `inventory`, so a regression that
  re-introduces the axis would not silently pass the suite by reusing an old fixture.

  One residual semantic note (NOT a security finding, recorded for completeness): the
  AC1 gap-closer is now served from `catalog_ingredients.unit` / `sub_unit_unit`
  rather than `inventory_items`. Per the corrected `brandUnitPool.ts:18-21` rationale,
  the catalog is the authoring source of truth for name/unit/sub_unit_unit and
  inventory rows only FK back to it, so the catalog is a superset of the brand's unit
  names — switching the source loses no legitimately-shared name. That is a
  functional-coverage assertion (test-engineer's lane), not a security one; I flag it
  only so the trade is on record. From the isolation standpoint the change is strictly
  safer.

### Low

- `src/screens/cmd/sections/InventoryCatalogMode.tsx:427` (was `:418-424` in the prior
  pass — the dual-cost string shifted line position but is otherwise unchanged) — the
  dual cost string interpolates `g.primary.casePrice.toFixed(2)`, `perEach.toFixed(2)`,
  and `unitLabel(...)` / `T('section.inventory.perCase')` into a template literal
  rendered as a React Native `<Text>` child. No injection surface: RN `<Text>` does not
  interpret markup, react-native-web emits escaped DOM text on web, `unitLabel` returns
  a plain i18n/verbatim string (never HTML), and numerics go through `.toFixed(2)`.
  Re-confirmed safe; **not a finding requiring action.** Recorded only to note the
  free-text-unit-into-label path was re-checked after the line move.

### Input handling / secrets / dependencies — re-checks performed

- **Injection:** No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, or
  HTML-email path in the helper or either edited TSX. Custom unit names still flow
  through `trim()` / `toLowerCase()` de-dupe in `brandUnitPool.ts` and render only as
  `<Text>` labels / `SelectField` option values. Folding sibling-ingredient catalog
  names into a dropdown introduces no injection surface (escaped on web, inert on
  native).
- **Secrets:** No `process.env` / `Deno.env` / service-role / apiKey / token reads
  added by the fix. The two helpers remain pure functions over already-loaded Zustand
  state. No client-reachable service key.
- **PII / data exposure in logs:** No `console.*` and no `notifyBackendError` added by
  this diff. The one data-mingling concern (the prior Medium) is now closed; nothing
  else exfiltrates rows.
- **Network / SSRF:** No `fetch`, `supabase.from`, `supabase.rpc`, or
  `supabase.functions.invoke` added. Both helpers consume already-RLS-filtered store
  state; no new request egress.
- **Cost math (AC7):** Unchanged from the prior pass — `perEachCost` /
  `piecesPerCase` are additive and do not touch the spec-093 `costPerUnit` guard
  (`db.ts:3769-3779`), so the 12×-error cannot be re-introduced.
- **Auth flow / realtime:** No new subscription, no publication change. The pool rides
  the existing `catalog_ingredients` fan-out on `brand-{id}`; nothing subscribes to a
  store/brand the caller can't already see.

### Dependencies

No `package.json` / `package-lock.json` changes in this spec — `npm audit` not run
(prior review had no dependency finding; nothing changed). The diff adds no
dependencies.

---

## Verdict

The prior **Medium** (cross-brand unit-name leak) is **RESOLVED with no residual
exposure**. The fix removes the `inventory` axis from `deriveBrandUnitPool` and sources
the pool from `catalogIngredients`, which is brand-scoped both by a server-side
`.eq('brand_id', brandId)` filter on the single-store load (`db.ts:3441`) and by
taking a single brand's catalog on the `__all__` load (`useStore.ts:979-981`) — neither
path can introduce a second brand's rows, unlike the cross-brand `inventory` flat-map
it replaced. AC3 ("brand-scoped by construction") now holds for real, and the
previously-incorrect load-bearing comments are corrected. The one **Low** (dual-cost
`<Text>` interpolation) is unchanged and remains safe. No Critical, no High, no
remaining Medium. **Nothing blocks; spec is clear from a security standpoint.**
