# Spec 096: Brand-shared custom units + dual case/each cost display

Status: READY_FOR_REVIEW

## User story

As a store manager maintaining the brand inventory catalog in the admin Cmd UI,
I want (1) a custom unit I create on one ingredient — like "Pack" — to become a
reusable pick in EVERY ingredient's unit dropdown for that brand, and (2) the
catalog list to show BOTH the case price and the per-each price for an ingredient,
so that I stop re-typing the same unit on every item and so that a packaging item
(e.g. a 3.25oz Cup w/ Lid, 2000 to a case) reads its true per-piece cost instead of
the misleading "$0.18/cases".

## Background (current state — investigated)

### Unit model (Issue 1)
- "Default unit" and "pack unit" are free-text strings on each ingredient:
  `catalog_ingredients.unit` / `catalog_ingredients.sub_unit_unit`
  (`supabase/migrations/20260504060452_brand_catalog_p1_additive.sql:38,42` — plain
  `text`, no CHECK / domain). There is **no shared unit registry** anywhere.
- The default-unit dropdown options are derived client-side as
  `CANONICAL_UNITS ∪ {distinct purchaseUnit across ALL conversions} ∪ {'each'} ∪ {this ingredient's stored value}`
  (`src/components/cmd/IngredientForm.tsx:461-499`). Pack-unit options are
  `CANONICAL_UNITS ∪ {this ingredient's stored value}`
  (`IngredientForm.tsx:509-524`). The Conversions tab's purchase-unit picker unions
  distinct `purchaseUnit` across all conversions
  (`src/screens/cmd/sections/InventoryCatalogMode.tsx:873-880`).
- Typing a custom unit via the `'+ custom…'` sentinel (spec 046) saves it ONLY as a
  string on that one ingredient (`IngredientForm.tsx:657-710` default,
  `:727-788` pack). It never enters any shared pool. So "Pack" created on American
  Cheese never appears in Provolone's or Tortillas' dropdowns — **this is the owner's
  complaint.**
- Because pack-unit options do NOT union conversion-derived units, a custom unit only
  ever appears in a sibling ingredient's *default-unit* dropdown if that sibling
  happens to have a conversion row for it — never reliably, and never in the
  *pack-unit* dropdown.
- Conversions are stored per-`(catalog_id, purchase_unit)` with a unique constraint
  (`supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql:44-49`). Types:
  `src/types/index.ts:246-258` (`IngredientConversion`; field `inventoryItemId` is
  semantically `catalog_id`).

### Cost-display model (Issue 2)
- The catalog list row prints `$<costPerUnit>/<default-unit label>`
  (`InventoryCatalogMode.tsx:490-491`), where the shown number is the stock-weighted
  average of per-store `costPerUnit` (`:386-388`).
- `costPerUnit` = stored `cost_per_unit`, else fallback `case_price / case_qty`
  (`src/lib/db.ts:3769-3779`). The fallback **deliberately** does NOT divide by
  `sub_unit_size` — that conflation is the documented "12×-error" the code comment
  guards against.
- Example (3.25oz Cup w/ Lid): `unit = "cases"`, `case_qty = 1`,
  `sub_unit_size = 2000`, `sub_unit_unit = "each"`. The real pack count (2000) lives
  in `sub_unit_size`, which the cost calc ignores; the label just echoes the default
  unit. Result: a per-cup figure ($0.18) renders as the misleading "$0.18/cases".
- The editor's case-size preview has the SAME root cause
  (`IngredientForm.tsx:790-813`): it reads `case_qty` (1), not `sub_unit_size` (2000),
  so it shows "1 case = 1 each" when the real breakdown is "1 case = 2000 each".

## Acceptance criteria

### Issue 1 — brand-shared custom unit NAMES
- [ ] AC1 — A custom unit name committed via the `'+ custom…'` flow on ANY ingredient
  in a brand becomes a selectable option in the **default-unit** AND **pack-unit**
  dropdowns of EVERY ingredient in that same brand, on next form open. Concrete test:
  create "Pack" on American Cheese, save; open Provolone's editor (same brand); "Pack"
  appears as a pickable option in both the default-unit and pack-unit dropdowns
  without re-typing.
- [ ] AC2 — Picking a shared unit name (e.g. "Pack") on a second ingredient sets that
  ingredient's `unit` / `sub_unit_unit` string and persists on save, but does NOT copy
  or share any conversion factor or pack size. Each ingredient still defines its own
  `case_qty` / `sub_unit_size` / Conversions-tab rows independently. Concrete test:
  American Cheese's "Pack" has `sub_unit_size = 24`; selecting "Pack" on Tortillas
  leaves Tortillas' `sub_unit_size` at its own value (no inheritance).
- [ ] AC3 — The shared pool is **brand-scoped**: a unit name created under brand A is
  NOT offered in brand B's ingredient dropdowns. Concrete test: a name in brand A's
  pool does not appear in any brand-B ingredient editor.
- [ ] AC4 — Canonical units and the existing per-ingredient stored-value fallback
  (spec 046 edit-mode display) continue to work unchanged; the shared pool is unioned
  on top of, not in place of, the existing option sources. The `'+ custom…'` sentinel
  remains the last row; the existing case-insensitive "snap to canonical" behavior
  (spec 046 AC6) still fires before a new name is added to the pool.
- [ ] AC5 — Creating a custom unit name that case-insensitively matches one already in
  the pool does NOT create a duplicate pool entry (de-dupe on `lower(name)`, mirroring
  the `catalog_ingredients_brand_name_lower_unique` precedent).

### Issue 2 — dual case/each cost display
- [ ] AC6 — In the catalog list row (`InventoryCatalogMode.tsx:~490`), when an
  ingredient's smallest-unit count differs from its tracking unit (i.e. there is a
  meaningful per-each breakdown), the row surfaces BOTH a case/purchase price AND a
  per-each price. Exact labels and formatting are an architect/design call (see Open
  questions for the architect Q-B), but both numbers MUST be visible at a glance from
  the list. Concrete test: the 3.25oz Cup w/ Lid row shows the case price AND a
  per-each figure on the order of $0.18/each — it no longer renders ONLY
  "$0.18/cases".
- [ ] AC7 — The per-each figure is computed from the documented fields without
  re-introducing the spec-093 12×-error: it divides the case/purchase cost by the
  REAL per-case piece count (the `sub_unit_size` axis for packaging items), and the
  existing `costPerUnit` fallback in `src/lib/db.ts:3769-3779` is NOT changed to
  divide by `sub_unit_size` (that field stays the separate recipe-costing axis). The
  per-each derivation is additive, not a rewrite of `costPerUnit`.
- [ ] AC8 — Ingredients where tracking unit == smallest unit (no sub-unit breakdown,
  `sub_unit_size <= 1` or unset) render with no behavior change versus today — a single
  price, no redundant "$X/each ($X/each)" doubling.
- [ ] AC9 — The editor case-size preview (`IngredientForm.tsx:790-813`) reflects the
  REAL case breakdown. For the Cup example it reads "1 case = 2000 each" (driven by the
  actual per-case piece count), not "1 case = 1 each". The fix must remain correct for
  the spec-093 case where `case_qty` legitimately holds units-per-case (e.g. "1 case =
  20 lbs") — i.e. it must not silently swap one mislabel for another. The architect
  resolves exactly which field(s) drive this preview given the data-model decision in
  Q-A.

### Cross-cutting
- [ ] AC10 — No regression to recipe cost math, the Conversions tab, EOD count, or
  Reorder. Custom unit strings continue to flow through `unitLabel()` and the existing
  `null`-aware conversion paths unchanged (spec 046 §Q1 audit). pwa-catalog / staff-*
  edge functions consume `unit` / `sub_unit_unit` as opaque text and must not need to
  parse the pool.

## In scope

- A brand-scoped registry/pool of custom unit NAMES (storage mechanism — new table vs.
  derived-from-existing-data — is the architect's call; see Q-C), decoupled from the
  per-ingredient conversion factor and pack size.
- Wiring the default-unit AND pack-unit dropdowns in
  `src/components/cmd/IngredientForm.tsx` to union the brand pool into their options.
- Writing a newly-committed custom unit name into the pool (or whatever the storage
  decision implies) at save time, brand-scoped, de-duped case-insensitively.
- The Conversions-tab purchase-unit picker (`InventoryCatalogMode.tsx:873-880`) may
  also union the pool for consistency — architect confirms whether that is in this spec
  or deferred.
- Catalog list row dual case/each price display (`InventoryCatalogMode.tsx:~490`).
- The additive per-each cost derivation (NOT a change to `costPerUnit`'s fallback).
- The editor case-size-preview fix (`IngredientForm.tsx:790-813`).

## Out of scope (explicitly)

- **Sharing conversion factors / pack sizes across ingredients.** Confirmed product
  decision: share the NAME only. A "Pack" of cheese ≠ a "Pack" of tortillas physically;
  each ingredient keeps its own `case_qty` / `sub_unit_size` / conversion rows.
- **A managed CRUD screen for the unit pool** (rename / delete / merge pool entries).
  This spec only ADDS names to the pool and offers them; lifecycle management of the
  pool is a possible follow-up. Rationale: the owner asked for reuse, not pool
  administration; adding a management surface is scope the owner did not request.
- **Backfilling / re-modeling existing "cases" items** unless Q-A is resolved toward
  re-modeling. Default lean is display-only fix; see Q-A. Flagged because it carries a
  data-migration cost.
- **Changing the `costPerUnit` fallback math** in `src/lib/db.ts:3769-3779`. The
  per-each figure is computed additively; the spec-093 anti-12×-error guard stands.
- **Renaming or restructuring `CANONICAL_UNITS` / `isCanonicalUnit`** (spec 046
  carve-out continues).
- **Translation of any new unit-pool label / the per-each price label** beyond reusing
  existing i18n keys where they exist. IngredientForm stays English-only per spec 038;
  any genuinely new catalog-row string the architect introduces should reuse the
  existing `section.inventory.*` key pattern, and a missing key is an architect call,
  not a silent hardcode.
- **Staff app / customer PWA UI.** This is admin-only (Cmd UI). Those apps read the
  same columns as opaque text; AC10 guards no-regression.
- **Touching `app.json` slug** (`towson-inventory` is load-bearing; untouched).

## Open questions resolved

- Q: Share the conversion/size, or just the unit name? → A (owner): **Name only.** Each
  ingredient defines its own conversion/size for that unit. Drives AC2 and the entire
  "decoupled pool" framing.
- Q: For the misleading "$/cases" cost, change the unit label, hide the figure, or show
  more? → A (owner): **Show BOTH** the case price and the smallest-unit (per-each)
  price so a manager sees purchase cost and per-piece cost at a glance. Drives AC6.
- Q: One spec or two? → A (PM): **One spec.** Justification: both issues are the same
  data-model knot — the `unit` / `sub_unit_unit` / `case_qty` / `sub_unit_size` quartet.
  Issue 2's correct per-each math depends on settling how the per-case piece count is
  represented (Q-A), which is the very axis Issue 1's pool-vs-conversion split clarifies.
  Splitting them would force the architect to resolve Q-A twice. They share the
  `IngredientForm.tsx` UNITS & PACK block and the `InventoryCatalogMode.tsx` catalog row.
  The acceptance criteria are independently testable, so a reviewer can still verify each
  half in isolation.

## Open questions for the architect

- **Q-A · Re-model existing "cases" items, or display-only fix? (decision required.)**
  Many packaging items today use tracking unit `"cases"` with the real per-case count
  pushed into `sub_unit_size` (the Cup example: `unit="cases"`, `case_qty=1`,
  `sub_unit_size=2000`). Two paths:
  - **(a) Display-only (PM lean).** Leave the data as-is; AC6/AC7/AC9 read the per-each
    count from `sub_unit_size` when `case_qty` is the degenerate `1`. No migration. Risk:
    the heuristic "which field holds the real piece count" must be specified precisely
    and may be ambiguous for items that legitimately use `case_qty` (spec-093 "1 case =
    20 lbs"). The architect MUST define the exact rule that distinguishes a packaging
    item (count in `sub_unit_size`) from a bulk item (count in `case_qty`) and prove
    AC9's "must not swap one mislabel for another" holds for both.
  - **(b) Re-model (e.g. tracking unit `"each"` + `case_qty = 2000`).** Cleaner long
    term; makes `costPerUnit`'s existing `case_price / case_qty` fallback produce the
    per-each figure directly. Cost: a data migration over existing catalog rows + EOD /
    Reorder revalidation (those features read `case_qty` as units-per-case) + a
    backfill-safety story. **Flag any data-migration implications** and whether prod rows
    can be classified safely.
  The architect picks (a) or (b) and justifies. If (b), the migration timestamp slot is
  the next available `>= 20260617000000_*.sql`, and pgTAP coverage of the backfill is
  required (spec 022 DB track). PM lean is (a) for blast-radius, but defers to the
  architect's read of how reliably prod "cases" rows can be classified.
- **Q-B · Catalog-row dual-price layout.** AC6 fixes the data; the exact rendering is a
  design call: two stacked lines ("$X/case" over "$Y/each"), a single line
  ("$X/case · $Y/each"), or label change. Architect/frontend pick the cleanest fit for
  the existing mono-font right-aligned cost cell at `InventoryCatalogMode.tsx:490-491`,
  reusing `section.inventory.*` i18n keys where possible.
- **Q-C · Pool storage mechanism.** Options: (i) a new `brand_custom_units (brand_id,
  name, …)` table with `lower(name)` uniqueness, surfaced through `src/lib/db.ts` and
  realtime; (ii) derive the pool at read time from existing `catalog_ingredients.unit` /
  `sub_unit_unit` / `ingredient_conversions.purchase_unit` distinct values for the brand
  (no new table, no migration — leans on data already present). (ii) is lighter and may
  satisfy AC1-AC5 entirely client-side by broadening the existing union derivations to
  cover BOTH `unit` and `sub_unit_unit` across the brand's ingredients; (i) is more
  explicit and enables the deferred management screen later. Architect decides. If (i),
  it needs RLS mirroring `catalog_ingredients` (auth-read, admin-write), a `db.ts`
  helper (no direct `supabase.from` outside `db.ts`), and a realtime consideration on
  `brand-{id}` (see risk below).
- **Q-D · Conversions-tab picker scope.** Confirm whether unioning the pool into the
  Conversions-tab purchase-unit picker (`InventoryCatalogMode.tsx:873-880`) is in this
  spec or deferred. PM lean: include it for consistency since it is the same union
  pattern, low marginal cost.

## Dependencies

- Builds directly on spec 046 (custom-unit free-text input + `CUSTOM_UNIT_SENTINEL` +
  `validateCustomUnit`) — the `'+ custom…'` commit path is the write-side entry point
  for the pool.
- Reads spec 004 (conversions model) and the spec-093 case-vs-sub-unit field semantics
  (the `case_qty` vs `sub_unit_size` distinction — referenced in code comments at
  `db.ts:3773-3777` and `IngredientForm.tsx:711-724,790-813`; there is no
  `specs/093-*.md` file on disk, the label is inline only).
- Existing files in play: `src/components/cmd/IngredientForm.tsx`,
  `src/screens/cmd/sections/InventoryCatalogMode.tsx`, `src/lib/db.ts`,
  `src/types/index.ts`, `src/utils/unitConversion.ts` (`CANONICAL_UNITS`),
  `src/utils/enumLabels.ts` (`unitLabel`).
- Migration only if Q-A=(b) or Q-C=(i) — otherwise none.

## Project-specific notes

- **Cmd UI section.** `src/screens/cmd/sections/InventoryCatalogMode.tsx` and the
  shared drawer component `src/components/cmd/IngredientForm.tsx`. No legacy admin
  surface (spec 025 deleted it).
- **Per-store or admin-global.** Brand-global. `catalog_ingredients` and the unit pool
  are brand-scoped (not per-store). The cost figures shown in the list aggregate
  per-store `inventory_items.cost_per_unit` / `case_price` (stock-weighted) — that
  aggregation already exists and is unchanged; only the displayed derivation gains the
  per-each line.
- **Realtime channels touched.** `brand-{id}`. If Q-C=(i) (new pool table), the table
  must be added to the realtime publication, and the publication gotcha applies (a
  mid-session publication change needs `docker restart supabase_realtime_imr-inventory`
  to re-snapshot the slot — call out as a risk in the design doc). If Q-C=(ii)
  (derived), no publication change — the pool rides the existing `catalog_ingredients`
  fan-out.
- **Edge function or PostgREST.** PostgREST/RPC via `src/lib/db.ts`. No edge function
  expected. If Q-C=(i), the pool helper goes through `db.ts` (no direct `supabase.from`
  outside the documented carve-outs).
- **Migrations needed.** Conditional — yes only if Q-A=(b) and/or Q-C=(i); otherwise no.
- **Edge functions touched.** None expected. AC10 guards pwa-catalog / staff-* no-regression.
- **Web/native scope.** Both. All edits are cross-platform (`SelectField`, `Text`,
  existing dropdown patterns). No web-only surface.
- **Tests (spec 022 tracks).** jest for any new pure helper (e.g. a per-each-cost
  derivation function and the pool de-dupe/union logic — mirror spec 046's
  `validateCustomUnit` test placement). pgTAP ONLY if Q-A=(b) (backfill migration) or
  Q-C=(i) (new table + RLS). No shell smoke expected. Architect names the exact tracks
  in the design doc.
- **`app.json` slug.** Untouched.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. The two product decisions (share unit NAME
  only; show both case and per-each price) are locked — do not relitigate them. Your
  decisions to make are Q-A (re-model "cases" items vs display-only — this gates whether
  there's a migration and how AC7/AC9 compute the per-each count), Q-B (catalog-row
  dual-price layout), Q-C (pool storage: new brand_custom_units table vs derive from
  existing distinct unit values), and Q-D (Conversions-tab picker scope). Specify the
  exact field rule that distinguishes a packaging item (piece count in sub_unit_size)
  from a bulk item (count in case_qty) so AC9 doesn't swap one mislabel for another.
  Name the test tracks and any migration slot, then set Status: READY_FOR_BUILD.
payload_paths:
  - specs/096-shared-units-and-dual-cost-display.md

---

## Backend design

### TL;DR for the reviewing user (blast radius)

**This design ships ZERO migrations and ZERO backend changes.** Both issues are
solved entirely in the React/TS frontend against data already loaded into the
admin Zustand store. Concretely:

- **Q-A = (a) display-only.** No prod data migration. No EOD/Reorder
  revalidation, because no column's meaning changes and no row is rewritten.
- **Q-C = (ii) derived pool.** No `brand_custom_units` table, no RLS, no
  realtime-publication change, no `docker restart`.
- **Q-B / Q-D** are pure frontend layout / option-list changes.

So the blast radius is: `IngredientForm.tsx`, `InventoryCatalogMode.tsx`, one
new pure helper module, the `en/es/zh-CN.json` i18n catalogs, and jest tests.
`src/lib/db.ts`, `supabase/migrations/`, `supabase/functions/`, RLS, and the
realtime publication are all **untouched**. The one hard constraint the build
must honor is the spec-093 anti-12×-error guard at `db.ts:3769-3779`, which this
design explicitly does NOT modify (AC7).

Why no migration is the right call (not just the cheap one): Q-A(b) would
require a heuristic to classify which existing prod "cases" rows hold a real
piece count in `sub_unit_size` vs. which legitimately hold units-per-case in
`case_qty` — and then mutate `unit` + `case_qty` on the basis of that guess.
That guess is *exactly* the AC9 "must not swap one mislabel for another" hazard,
applied destructively to prod rows that EOD and Reorder read. The same field
rule that makes the heuristic possible (below) also makes it unnecessary: if we
can read the right field at *display* time, we never have to *rewrite* the row.
Display-only contains the risk to pixels; re-modeling spreads it to `case_qty`,
which is load-bearing for two other features.

---

### Q-A — Re-model vs display-only: **DISPLAY-ONLY (a). No migration.**

#### The exact packaging-vs-bulk field rule

The distinction is already structurally encoded by spec 093. Spec 093 defined:

- `case_qty` (→ `catalog_ingredients.case_qty`) = **units-per-case**: how many
  *tracking units* are in one purchased case. This is what Reorder (088) and EOD
  (086) read. Bound to the "units / case" input (`IngredientForm.tsx:718`).
- `sub_unit_size` (→ `catalog_ingredients.sub_unit_size`) = **sub-units per ONE
  tracking unit**: the recipe-costing axis. Bound to the "sub-unit / unit" input
  (`IngredientForm.tsx:724`). Deliberately NOT divided into `costPerUnit`
  (`db.ts:3773-3777`).

The per-each (smallest-unit) count for an ingredient is therefore:

> **`piecesPerCase = caseQty × subUnitSize`**, with each factor defaulting to
> `1` when absent/zero (mirroring `mapItem`'s `parseFloat(...) || 1` at
> `db.ts:3761-3762`).

This single formula is correct for BOTH shapes without any "which field holds
the truth" branch — that is the property AC9 demands. Worked checks:

| Item | `unit` | `case_qty` | `sub_unit_size` | `piecesPerCase` = qty×size | Reads as |
|------|--------|-----------|-----------------|-----------|----------|
| **Cup w/ Lid** (legacy pre-093 shape) | `"cases"` | `1` | `2000` | 1 × 2000 = **2000** | "1 case = 2000 each" ✓ (AC9) |
| **Bulk flour** (spec-093 "1 case = 20 lbs") | `"lbs"` (or `"cases"`) | `20` | `1` | 20 × 1 = **20** | "1 case = 20 lbs" ✓ (AC9) |

The two examples occupy *different axes* of the same product
(`caseQty × subUnitSize`), so multiplying them can never double-count: the Cup
puts its count in the `subUnitSize` axis and leaves `caseQty=1`; the bulk item
puts its count in the `caseQty` axis and leaves `subUnitSize=1`. The product is
the true piece count in both, and an item that legitimately uses both axes
(e.g. a case of 4 bags, each bag 10 each → `caseQty=4`, `subUnitSize=10`) yields
`40` pieces/case, which is also correct. **No heuristic, no field-precedence
guess, no mutation — `caseQty × subUnitSize` is a total function over the
existing columns.** This is why display-only is not just lower-risk but
*strictly more robust* than a re-model: the re-model would have to pick ONE axis
to canonicalize into and discard the other, which is the lossy step AC9 warns
against.

#### Per-each cost derivation (AC6, AC7, AC8)

Additive helper, NOT a change to `costPerUnit`. Place it next to the existing
pure unit helpers (mirrors spec 046's `validateCustomUnit` placement) — proposed
`src/utils/perEachCost.ts`:

```ts
// piecesPerCase = caseQty × subUnitSize, each defaulting to 1.
export function piecesPerCase(caseQty: number, subUnitSize: number): number;

// Returns the per-smallest-unit cost, or null when there is no meaningful
// breakdown (piecesPerCase <= 1) — null signals "render single price, AC8".
// casePrice path: casePrice / piecesPerCase when casePrice > 0.
// Fallback when casePrice is 0/unset but a tracking-unit cost exists:
//   costPerUnit / subUnitSize  (costPerUnit is already per-tracking-unit, so
//   only the sub-unit axis remains to divide out — this does NOT touch the
//   db.ts fallback; it consumes its OUTPUT).
export function perEachCost(args: {
  casePrice: number;       // g.primary.casePrice (per-store stock-weighted upstream if needed)
  costPerUnit: number;     // the already-computed per-tracking-unit cost (avgCost in the row)
  caseQty: number;
  subUnitSize: number;
}): number | null;
```

- **AC6 / the Cup:** `casePrice` ≈ $360, `piecesPerCase` = 2000 →
  `$0.18/each`. The row shows the case price AND `$0.18/each`. ✓
- **AC7:** the per-each figure divides by the *real* piece count
  (`caseQty × subUnitSize`); it never re-introduces the 12×-error because
  `db.ts:3769-3779` is unchanged and the new math lives in a separate helper.
- **AC8:** when `piecesPerCase <= 1` (tracking unit == smallest unit, the common
  case), `perEachCost` returns `null` and the row renders exactly as today — one
  price, no "$X/each ($X/each)" doubling.

Decision rule for whether a row shows the dual line: **show the per-each line iff
`piecesPerCase > 1` AND a per-each cost is derivable (non-null).** "Meaningful
per-each breakdown" in AC6/AC8 == `piecesPerCase > 1`.

#### Editor case-size preview fix (AC9)

`IngredientForm.tsx:790-813` currently renders `1 case = ${caseQty} ${contentsUnit}`.
Spec 093 already made the noun-after-`=` the case *contents*. The remaining
defect is that for the Cup, `caseQty=1` so it reads "1 case = 1 each" while the
real breakdown is 2000. Fix: drive the number off `piecesPerCase` (=
`caseQty × subUnitSize`), not `caseQty` alone, and keep the same finite/positive
guard. Result:

- Cup: `1 × 2000 = 2000` → **"1 case = 2000 each"** ✓
- Bulk: `20 × 1 = 20` → **"1 case = 20 lbs"** ✓ (unchanged from spec 093)

The preview and the catalog-row per-each derivation MUST use the same
`piecesPerCase` helper so they can never drift — a reviewer can assert identity
by both importing `src/utils/perEachCost.ts`.

> **Note on `contentsUnit` for the Cup:** today line 805 picks
> `subUnitUnit || unit || 'each'`. For the Cup, `sub_unit_unit = "each"`, so the
> contents unit is correctly "each". For the bulk item the contents unit is the
> tracking unit ("lbs"). No change to the contents-unit selection is needed —
> only the number changes from `caseQty` to `piecesPerCase`.

---

### Q-C — Pool storage: **DERIVED AT READ TIME (ii). No table, no migration.**

The brand pool is computed client-side from data already in the store. There is
no `brand_custom_units` table, no RLS work, no realtime-publication change, and
no `db.ts` helper (so the "no `supabase.from` outside db.ts" rule is trivially
satisfied — nothing new touches Supabase).

#### Why (ii) over (i)

- **AC1–AC5 are fully satisfiable client-side.** The data needed is already
  loaded: `inventory` rows each carry catalog `unit` + `subUnitUnit` via the
  JOIN (`db.ts:3768,3795`), and `ingredientConversions` is a flat, brand-scoped
  array in the store (`IngredientForm.tsx:377`). The `IngredientForm` knows the
  active brand via `currentStore.brandId` (`IngredientForm.tsx:379,529`).
- **A table buys only the deferred management screen**, which the spec puts
  explicitly out of scope ("A managed CRUD screen for the unit pool … is a
  possible follow-up"). Building the table now is infrastructure for a feature
  the owner did not request — and it would drag in RLS, a `db.ts` helper, AND
  the realtime-publication gotcha (`docker restart supabase_realtime_imr-inventory`
  + a deploy step), all to store strings we can already derive.
- **Brand-scope (AC3) holds by construction.** The store only ever holds the
  active brand's `inventory` + `ingredientConversions` (loaded per
  `fetchAllForStore`, `useStore.ts:985-990`; "all stores" still takes a single
  brand's catalog/conversions, `useStore.ts:980-990`). A name from brand B is
  never in the array, so it can never appear in brand A's dropdowns. No
  `brand_id` filter is even needed in the derivation — the loaded data is
  already the brand's slice. (Defense-in-depth note for the dev: if you prefer
  an explicit guard, filter `inventory` by `it.storeId`'s brand, but it is
  redundant given the loader.)

#### The brand-pool derivation (new pure helper)

Proposed `src/utils/brandUnitPool.ts` — a pure function the form calls:

```ts
// Returns a de-duped, case-folded set of unit NAMES for the brand, unioning
// BOTH axes across every loaded ingredient plus every conversion purchase unit.
// De-dupe key is lower(name), value preserves first-seen casing — mirrors
// catalog_ingredients_brand_name_lower_unique (AC5).
export function deriveBrandUnitPool(args: {
  inventory: { unit: string; subUnitUnit: string }[];
  conversions: { purchaseUnit: string }[];
}): string[];  // case-preserved, lower()-deduped
```

Union sources (this is the key AC1 gap-closer):
`{ distinct inventory.unit } ∪ { distinct inventory.subUnitUnit } ∪
{ distinct ingredientConversions.purchaseUnit }`, de-duped on `lower(name)`.

**Why this closes the AC1 gap the spec flags:** today the default-unit dropdown
unions only `conversions.purchaseUnit` (`IngredientForm.tsx:463-466`) and the
pack-unit dropdown unions *nothing* derived (`:509-524`). So a custom name like
"Pack" saved as a sibling's `subUnitUnit` never propagates. By unioning BOTH
`unit` AND `subUnitUnit` across the brand into the pool, and feeding the pool
into BOTH dropdowns, a name committed on any ingredient (whether it landed in
that ingredient's `unit` or its `subUnitUnit`) shows up in every other
ingredient's default-AND-pack dropdowns on next open (AC1).

#### Wiring into the two dropdowns (AC1, AC4)

- **`defaultUnitOptions`** (`IngredientForm.tsx:461-499`): add the brand pool to
  the accumulator `acc` after the existing `CANONICAL_UNITS` ∪ conversions ∪
  `'each'` seed, BEFORE the sort. Keep: the stored-value verbatim append
  (`:493-494`), the `'+ custom…'` sentinel last (`:497`), and the existing
  `isCustom` case-preservation path. Pool entries fold into the lowercase `acc`
  set the same way conversion units do, so `unitLabel` rendering is unchanged.
- **`packUnitOptions`** (`IngredientForm.tsx:509-524`): today this is
  `CANONICAL_UNITS ∪ {stored value}` only. Insert the brand pool between the
  canonical seed and the stored-value/sentinel tail. This is the line that makes
  a shared name appear in the **pack-unit** dropdown — the half AC1 calls out as
  missing today.

**AC4 (additive, not replacing):** the pool is unioned ON TOP of every existing
source; canonical units, the spec-046 stored-value fallback, the `'+ custom…'`
sentinel-last invariant, and the case-insensitive snap-to-canonical
(`validateCustomUnit` at commit, `:675`/`:753`) all stay. The snap-to-pool
behavior is already implicit: `validateCustomUnit(draft, knownKeys)` is passed
`knownKeys` built from the dropdown's own option values
(`:672-674`, `:747-752`); once the pool is unioned into those options,
`knownKeys` automatically includes pool names, so typing an existing pool name
case-insensitively snaps to it instead of creating a near-duplicate — this is
what satisfies **AC5** with no new code (the de-dupe is the existing
`validateCustomUnit` mechanism operating over the widened option set). The dev
should confirm `knownKeys` at both commit sites is derived from the
pool-inclusive option list (it already is, since `knownKeys` reads
`defaultUnitOptions` / `packUnitOptions`).

#### AC2 — no conversion/size inheritance

Picking a pool name only calls `set('unit', v)` / `set('subUnitUnit', v)`
(`:703`, `:781`) — it writes the string and nothing else. `case_qty`,
`sub_unit_size`, and Conversions-tab rows are untouched. AC2 holds for free
because the pool is *names only* and the pick path already writes only the
string field. No code change is needed to *prevent* inheritance; there is no
inheritance path to begin with.

#### The "write to the pool" step is a no-op (by design)

Because the pool is derived from `inventory` + `conversions`, committing a custom
unit on ingredient X and saving X (which persists `unit`/`subUnitUnit` to
`catalog_ingredients` via the existing save path) automatically makes that name
appear in the derived pool on the next form open — the brand's `inventory` is
reloaded (realtime `brand-{id}` fan-out, or the next `loadAll`). There is no
separate "insert into pool" write. This is the entire reason (ii) needs no
migration: the persistence already happens through `catalog_ingredients`.

> **Realtime (AC10, no change):** the pool rides the EXISTING `catalog_ingredients`
> fan-out on `brand-{id}`. No publication membership change → **the
> `docker restart supabase_realtime_imr-inventory` gotcha does NOT apply to this
> spec.** Calling this out explicitly because the spec's risk section flagged it
> as conditional on Q-C=(i); we chose (ii), so it is off the table.

---

### Q-B — Catalog-row dual-price layout: **single line with a `·` separator.**

`InventoryCatalogMode.tsx:490-491` is a single right-aligned mono cell. Decision:
keep it one line, append the per-each figure after a `·` separator (the
separator already used elsewhere in this file, e.g. the `· custom` / `·
unregistered` suffixes and the StatCard `sub` rows):

- **Breakdown present** (`piecesPerCase > 1`, per-each non-null):
  `"$<case>/<caseLabel> · $<each>/each"` — e.g. `$360.00/case · $0.18/each`.
- **No breakdown** (AC8): unchanged — `"$<avgCost>/<unitLabel(g.unit)>"`.
- **No cost:** unchanged — `T('section.inventory.noCost')`.

Rationale for one line over two stacked lines: the row already has two stacked
`View`s (name/id row + category/stores/cost row); the cost lives on the second
row's right edge with `fontVariant: ['tabular-nums']`. A second stacked cost line
would unbalance the two-line row height across the FlatList. A single
`·`-separated string preserves row height and the tabular-nums alignment. If the
combined string is too wide on narrow native widths, the frontend dev may wrap
the per-each portion to a second `<Text>` line within the same right-aligned
column — that is a presentation detail left to the frontend dev, but the default
is one line.

**i18n (reuse `section.inventory.*`):** the case label and "each" need keys. The
existing namespace block is `section.inventory` (`en.json:252-265`). Reuse
`section.inventory.noCost` unchanged. Add — in all three catalogs
(`en.json` / `es.json` / `zh-CN.json`), since the catalog row IS localized
(unlike IngredientForm which is English-only per spec 038):

- `section.inventory.perEach` → e.g. `"each"` (the `/each` suffix unit word).
- For the case label, reuse `unitLabel(g.unit, T)` for the case side (it already
  renders "case"/"cases"/etc. from the stored unit) — so **no new "case" key is
  required**; only the per-each `each` word is genuinely new. A missing key here
  would be a silent hardcode (spec's i18n rule), so `section.inventory.perEach`
  is the one addition. If the frontend dev finds `unitLabel('each', T)` already
  yields a localized "each", they may use that instead and skip the new key —
  architect's preference is to reuse `unitLabel` and add `perEach` only if
  `unitLabel('each')` is not already localized in es/zh-CN.

---

### Q-D — Conversions-tab purchase-unit picker: **INCLUDE in this spec.**

`InventoryCatalogMode.tsx:873-880` (`purchaseUnitOptions`) currently unions only
`ingredientConversions.purchaseUnit`. Union the same `deriveBrandUnitPool` result
here too, so the Conversions-tab purchase-unit dropdown offers the brand's shared
unit names. Low marginal cost (same helper, same union pattern), and it keeps the
three unit-pickers consistent — otherwise a name created via the IngredientForm
flow would be missing from the Conversions tab, which is a confusing asymmetry
for the same screen. This is additive (free-text entry below the picker is
unchanged, `handleAdd` at `:882` still lowercases and validates).

---

### Acceptance-criteria → design-element map

| AC | Satisfied by |
|----|--------------|
| AC1 | `deriveBrandUnitPool` unions `unit` + `subUnitUnit` + `purchaseUnit`; fed into BOTH `defaultUnitOptions` and `packUnitOptions` (Q-C wiring). |
| AC2 | Pick path writes only `set('unit'/'subUnitUnit')`; pool is names-only — no inheritance path exists. |
| AC3 | Store holds only the active brand's `inventory`/`conversions` (`useStore.ts:980-990`); pool is brand-scoped by construction. |
| AC4 | Pool unioned ON TOP of canonical ∪ conversions ∪ stored-value; sentinel-last + snap-to-canonical preserved. |
| AC5 | Existing `validateCustomUnit(draft, knownKeys)` over the pool-inclusive option list de-dupes on lower(name). |
| AC6 | Row renders `$case · $each` when `piecesPerCase > 1` (Q-B). |
| AC7 | `perEachCost` divides by `caseQty × subUnitSize`; `db.ts:3769-3779` untouched. |
| AC8 | `perEachCost` returns `null` when `piecesPerCase <= 1` → single price, no doubling. |
| AC9 | Editor preview uses `piecesPerCase` (= `caseQty × subUnitSize`); proven correct for Cup (2000) AND bulk (20 lbs). |
| AC10 | No DB/edge/RLS/publication change; `unit`/`subUnitUnit` stay opaque text; `unitLabel` + null-aware paths unchanged. |

### Data model changes

**None.** No new table, column, index, or migration. `case_qty` / `sub_unit_size`
keep their spec-093 meanings.

### RLS impact

**None.** No table added or altered.

### API contract

**None.** No PostgREST view, no RPC, no `db.ts` change. All new logic is pure
client-side helpers consuming data already in the Zustand store. The spec-093
guard at `db.ts:3769-3779` is explicitly preserved (AC7).

### Edge function changes

**None.** `verify_jwt` settings unchanged. AC10's pwa-catalog / staff-* no-regression
holds because those functions read `unit`/`sub_unit_unit` as opaque text and never
parse a pool (there is no pool to parse — it is derived in the admin client only).

### `src/lib/db.ts` surface

**No change.** Two new pure helpers live under `src/utils/` (not `db.ts`, since
they touch no Supabase): `src/utils/perEachCost.ts` and
`src/utils/brandUnitPool.ts`. No snake_case→camelCase mapping is involved — the
helpers consume already-mapped `InventoryItem` / `IngredientConversion` shapes.

### Realtime impact

**`brand-{id}` only, via the EXISTING `catalog_ingredients` fan-out — no
publication change.** A newly-committed unit name persists to
`catalog_ingredients.unit`/`sub_unit_unit` through the existing save path; the
existing realtime reload re-derives the pool. **The publication / `docker restart`
gotcha does NOT apply** (it was conditional on Q-C=(i), which we did not pick).

### Frontend store impact

**No store-slice change.** The `inventory` and `ingredientConversions` slices are
read as-is; no new state, no optimistic-then-revert path (nothing new is
written through the store — the only writes are the existing
`unit`/`subUnitUnit` saves, which already use the optimistic+`notifyBackendError`
pattern at `useStore.ts:1107-1113`/`1159-1167` and are unchanged).

### Test tracks (spec 022)

- **jest only.** No pgTAP (no table/migration). No shell smoke.
  - `src/utils/perEachCost.test.ts` — `piecesPerCase` (Cup → 2000, bulk → 20,
    case-of-bags → 40, both-axes-unset → 1) and `perEachCost` (Cup → 0.18,
    AC8 `null` when `piecesPerCase <= 1`, casePrice-vs-costPerUnit fallback).
  - `src/utils/brandUnitPool.test.ts` — union across `unit`/`subUnitUnit`/
    `purchaseUnit`; lower(name) de-dupe with first-seen casing (AC5);
    empty-input → empty pool.
  - Mirrors spec 046's `validateCustomUnit` test placement.

### Risks and tradeoffs (explicit)

1. **Display-only leaves the prod data "messy."** The Cup row keeps
   `unit="cases"`, `case_qty=1`, `sub_unit_size=2000` — semantically odd but
   correct under the `piecesPerCase` reading. Tradeoff accepted: a clean re-model
   is a *separate, opt-in* spec that can run a classify-then-migrate pass with
   pgTAP backfill coverage when the owner wants it. This spec deliberately does
   not gamble prod `case_qty` values on a heuristic. **If the user wants the
   re-model instead, that is a different spec with a migration in the
   `>= 20260617000000_*.sql` slot and EOD/Reorder revalidation — flag at review.**
2. **Derived pool has no lifecycle management.** A typo'd unit name committed on
   any ingredient enters the derived pool until that ingredient's
   `unit`/`subUnitUnit` is corrected. This is identical to today's behavior for
   conversion-derived units and is explicitly out of scope (no CRUD screen). The
   `validateCustomUnit` snap-to-existing mitigates *new* duplicates (AC5).
3. **Performance on the 286 KB seed.** `deriveBrandUnitPool` is O(n) over the
   brand's `inventory` + `conversions` (low hundreds of rows), memoized in the
   form the same way `defaultUnitOptions` already is. The catalog row's
   `perEachCost` is O(1) per row inside the existing `renderItem`. Negligible.
4. **`piecesPerCase` correctness depends on data hygiene.** If an item wrongly
   populates BOTH axes (e.g. `case_qty=2000` AND `sub_unit_size=2000` for the
   Cup), `piecesPerCase` would over-count (4,000,000). This is a pre-existing
   data-entry hazard, not introduced here; the editor's "1 case = N" preview now
   makes such a mistake *visible* (it would read "1 case = 4,000,000 each"),
   which is a net improvement. No guard added beyond the existing numeric input
   validation.
5. **`casePrice` source for the per-each line.** The row's `avgCost` is
   stock-weighted across stores (`InventoryCatalogMode.tsx:386-388`). The
   per-each line should derive from a consistent basis: prefer
   `avgCost`-derived (`perEachCost` via the `costPerUnit/subUnitSize` branch when
   `casePrice` is heterogeneous across stores) OR `g.primary.casePrice` when
   present. The frontend dev picks the basis that matches the existing `avgCost`
   semantics; flag any ambiguity to the architect in post-impl review. Default:
   feed `avgCost` as `costPerUnit` and `g.primary.casePrice` as `casePrice` into
   the helper, letting the helper prefer the casePrice branch when available.
6. **No cold-start / edge concern** — no edge function touched.

### Build ownership

**Frontend-developer only.** Every change is in `.tsx` / `.ts` frontend files +
i18n JSON + jest. No backend developer is needed: no migration, no `db.ts`
change, no edge function, no RLS. The backend-architect will review in post-impl
mode to confirm the spec-093 guard (`db.ts:3769-3779`) was NOT touched and that
no code reached Supabase outside `db.ts`.

## Handoff
next_agent: frontend-developer
prompt: Implement Spec 096 against the ## Backend design section. This is a
  frontend-only build — no migration, no db.ts change, no edge function, no RLS.
  Add two pure helpers (src/utils/perEachCost.ts, src/utils/brandUnitPool.ts)
  with jest tests; wire the derived brand pool into IngredientForm's
  defaultUnitOptions AND packUnitOptions AND the Conversions-tab
  purchaseUnitOptions (Q-D in scope); render the dual case/each price on the
  catalog row (Q-B: single `·`-separated line, show per-each only when
  piecesPerCase > 1); and fix the editor case-size preview to use
  piecesPerCase = caseQty × subUnitSize. Do NOT modify the costPerUnit fallback
  at db.ts:3769-3779 (AC7). Add section.inventory.perEach to en/es/zh-CN.json
  only if unitLabel('each') is not already localized. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/096-shared-units-and-dual-cost-display.md

## Files changed

Frontend-only build (no migration / no db.ts / no edge function / no RLS /
no realtime-publication change, per the spec scope). The spec-093 `costPerUnit`
guard at `db.ts:3769-3779` was NOT touched (AC7).

Created:
- `src/utils/perEachCost.ts` — `piecesPerCase(caseQty, subUnitSize)` (= caseQty ×
  subUnitSize, each factor defaulting to 1) and `perEachCost({ casePrice,
  costPerUnit, caseQty, subUnitSize })` (null when piecesPerCase ≤ 1; primary
  `casePrice / piecesPerCase`; fallback `costPerUnit / subUnitSize`).
- `src/utils/perEachCost.test.ts` — unit-project jest coverage for both helpers,
  including the AC7 "divide by real piece count, not caseQty alone" case and the
  AC8 null path.
- `src/utils/brandUnitPool.ts` — `deriveBrandUnitPool({ inventory, conversions })`:
  de-duped (case-folded, first-seen casing) union of `inventory.unit` ∪
  `inventory.subUnitUnit` ∪ `conversions.purchaseUnit`.
- `src/utils/brandUnitPool.test.ts` — unit-project jest coverage (empty, both-axis
  union, conversions union, case-insensitive de-dupe, first-seen casing).

Edited:
- `src/components/cmd/IngredientForm.tsx` — derive `brandUnitPool`; fold it into
  BOTH `defaultUnitOptions` AND `packUnitOptions` (the AC1 gap-closer); drive the
  case-size preview number off `piecesPerCase` instead of `caseQty` alone (AC9),
  guarding render-nothing on raw empty `caseQty`.
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` — dual case/each cost on the
  catalog row (single `·`-separated line; per-each segment only when
  `piecesPerCase > 1` AND `perEachCost` non-null; LEFT side is the real
  `g.primary.casePrice`, the mislabel fix); fold `brandUnitPool` into the
  Conversions-tab `purchaseUnitOptions` (Q-D).
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — added
  `section.inventory.perCase` (`"case"` / `"caja"` / `"箱"`) for the singular
  case-price label; i18n parity test stays green.
