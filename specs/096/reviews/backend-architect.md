# Spec 096 — Backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Spec: `specs/096-shared-units-and-dual-cost-display.md` (Status: READY_FOR_REVIEW)
Verdict: **Implementation honors the design. No architectural drift. 0 Critical, 0 Should-fix, 3 Minor.**

The build is faithful to the `## Backend design` section I authored: Q-A = display-only
(zero migrations, zero backend), Q-C = derived pool (no `brand_custom_units` table),
Q-B = single `·`-separated catalog line, Q-D = Conversions-tab picker included. Every
hard constraint I set is intact. Findings below are Minor only.

---

## 1. "Single `piecesPerCase` helper shared by both surfaces" — HOLDS

Confirmed at the import level and by absence of any re-implementation:

- `src/utils/perEachCost.ts:29` is the sole definition of `piecesPerCase`.
- `src/screens/cmd/sections/InventoryCatalogMode.tsx:22` imports `{ perEachCost, piecesPerCase }` from that module; uses it at line 399.
- `src/components/cmd/IngredientForm.tsx:9` imports `{ piecesPerCase }` from the SAME module; uses it at line 858 for the editor preview.
- A repo-wide grep for `piecesPerCase` returns only the definition, the two call sites, the JSDoc, and the test. Neither surface inlines `caseQty * subUnitSize` — the formula exists in exactly one place. The §Q-A "must use the same `piecesPerCase` helper" property is structurally guaranteed: the editor preview number and the catalog per-each divisor cannot drift because they are the same function applied to the same `(caseQty, subUnitSize)` axes.

`deriveBrandUnitPool` is likewise single-sourced (`src/utils/brandUnitPool.ts:35`) and imported by both `IngredientForm.tsx:8` and `InventoryCatalogMode.tsx:23` — the form folds it into `defaultUnitOptions` (`:509`) AND `packUnitOptions` (`:554`), and the catalog folds it into `purchaseUnitOptions` (`:920`). The three unit-pickers consume one derivation. AC1 gap-closer (union BOTH `unit` and `subUnitUnit`) is present at `brandUnitPool.ts:48-49`.

## 2. AC7 12×-error guard — INTACT (divisor traced)

Traced the divisor end to end:

- Catalog row: `perEach = perEachCost({ casePrice: g.primary.casePrice, costPerUnit: avgCost, caseQty: g.primary.caseQty, subUnitSize: g.primary.subUnitSize })` (`InventoryCatalogMode.tsx:400-405`).
- `perEachCost` primary path: `casePrice / pieces` where `pieces = piecesPerCase(caseQty, subUnitSize) = caseQty × subUnitSize` (`perEachCost.ts:62,67-68`). It divides by the REAL per-case piece count, **never by `caseQty` alone**. For the 3.25oz Cup (`caseQty=1, subUnitSize=2000`) this is `49 / 2000 = $0.0245`, not the 12×-class `49 / 1 = $49.00`. The test at `perEachCost.test.ts:77-83` pins exactly this anti-regression.
- The fallback path (`costPerUnit / subUnitSize`, `:74-76`) consumes the OUTPUT of the `db.ts` fallback (`costPerUnit` is already per-tracking-unit) and only divides out the remaining sub-unit axis — it does not re-derive from `case_price`.
- `src/lib/db.ts:3769-3779` `costPerUnit` fallback is **byte-for-byte unchanged**: still `caseQty > 0 && cp > 0 ? cp / caseQty : 0`, with the spec-093 comment block (`:3773-3777`) explicitly noting `sub_unit_size` must NOT divide the per-unit cost. The new math is strictly additive in a separate module; it never reaches `db.ts`. AC7 satisfied.

## 3. DB / contract / RLS / realtime drift — NONE (as designed)

- **Migrations:** none added. `supabase/migrations/` untouched. Confirmed no `>= 20260617000000_*.sql` slot was consumed.
- **`db.ts`:** no change beyond the (untouched) fallback above. No new `supabase.from` / `rpc` anywhere — the two new modules import nothing from Supabase; they consume already-mapped camelCase `InventoryItem` / `IngredientConversion` shapes off the Zustand store. The "no `supabase.from` outside `db.ts`" rule is trivially satisfied.
- **RLS / edge functions / `config.toml`:** untouched. `pwa-catalog` / `staff-*` continue to read `unit`/`sub_unit_unit` as opaque text; there is no pool to parse (it's derived in the admin client only). AC10 holds.
- **Realtime:** no `supabase_realtime` publication membership change. The derived pool rides the EXISTING `catalog_ingredients` fan-out on `brand-{id}` — a newly-committed unit name persists through the existing `unit`/`subUnitUnit` save path and re-derives on the next reload. **The `docker restart supabase_realtime_imr-inventory` publication gotcha does NOT apply to this spec** (it was conditional on Q-C=(i), which we did not pick). This matches the design's explicit call-out.
- **Brand-scope (AC3):** holds by construction. Both files source `inventory`/`ingredientConversions` from `useStore` (`IngredientForm.tsx:379-380`, `InventoryCatalogMode.tsx:77,864-865`), which only ever holds the active brand's slice. No `brand_id` filter is needed or present — consistent with the design.

## 4. Two behavioral outcomes of the "number-only" preview fix — BOTH INTENDED, NO AMENDMENT NEEDED

These are the direct, foreseen consequences of the decisions I locked in §Q-A
("only the number changes from `caseQty` to `piecesPerCase`") and §Q-B
("show the per-each line iff `piecesPerCase > 1`"). The developer implemented them
exactly as specified. Neither warrants a design amendment within this spec's scope.

### (a) "1 case = 2000 cases" for empty `sub_unit_unit` + `unit='cases'` — INTENDED (with a documentation nuance, Minor)

`IngredientForm.tsx:862`: `contentsUnit = values.subUnitUnit || values.unit || 'each'`.
For an item with empty `sub_unit_unit` and `unit='cases'`, this resolves to `'cases'`,
and with `pieces = 2000` the preview reads **"1 case = 2000 cases"**.

This is the intended output of my design as written. My §Q-A note scoped the fix to
the NUMBER and explicitly left `contentsUnit` selection unchanged. The implementation
comment at `IngredientForm.tsx:850-851` correctly records this ("Contents-unit
selection is UNCHANGED per the architect's design (only the number changes)").

Nuance worth recording (this is the Minor, not a defect): my design's worked example
assumed the Cup carries `sub_unit_unit="each"` (so it reads "2000 each"). For the
*subset* of legacy rows where `sub_unit_unit` is EMPTY and `unit='cases'`, the noun
falls through to the tracking unit `'cases'`, yielding the tautological-looking
"1 case = 2000 cases". This is still strictly MORE correct than the pre-096
"1 case = 1 each" (the number is now right), and it is the honest readback of a row
whose contents unit genuinely is unset. Fixing the *noun* for that subset would mean
inferring a smallest-unit label the data doesn't carry — which is precisely the
"guess what the data means" hazard §Q-A chose to avoid at display time. So: working
as designed. The clean resolution (populating `sub_unit_unit` on those rows) belongs
to the opt-in re-model spec flagged in Risk #1, not here. No amendment.

### (b) Black Pepper now renders dual "$42.00/case · $8.40/each" — INTENDED

Seed row (`supabase/seed.sql:272`): `unit='each'`, `case_qty='1'`, `sub_unit_size='5'`,
`sub_unit_unit='lbs'`, `case_price='42.00'`.
- `pieces = piecesPerCase(1, 5) = 5` (> 1) → `showPerEach = true`.
- `perEach = 42.00 / 5 = 8.40`; `casePrice 42 > 0` → `hasCaseSide = true`.
- Row renders `$42.00/case · $8.40/each` (`InventoryCatalogMode.tsx:418-420`).

This is the intended outcome. My §Q-B decision rule is "show the per-each line iff
`piecesPerCase > 1` AND a per-each cost is derivable," and `piecesPerCase = caseQty ×
subUnitSize` is the TOTAL function I specified precisely so it fires for legacy
packaging items whose real piece count lives in `sub_unit_size` regardless of which
axis holds it. Black Pepper (`subUnitSize=5`) is exactly that shape: 5 lbs to a case,
$8.40/lb. Surfacing both the $42 case price and the $8.40 per-lb figure is the AC6
behavior the owner asked for ("purchase cost and per-piece cost at a glance"). It is
not a regression of AC8 — AC8 only suppresses the per-each segment when
`piecesPerCase <= 1`, which is not this row. Working as designed. No amendment.

One observation on the *label* for (b), recorded as Minor #2 below: the right-hand
segment reads "/each" (via `unitLabel('each', T)`) even though Black Pepper's
sub-unit is `lbs`. The per-each figure is correctly $8.40 **per lb**, but the literal
word is the generic "each." See Minor #2.

---

## Minor findings (non-blocking)

**Minor #1 — design example vs. empty-`sub_unit_unit` reality (documentation, not code).**
The "2000 cases" readback in outcome (a) is correct behavior but reads oddly for the
empty-`sub_unit_unit` subset. The code comment at `IngredientForm.tsx:850-851` already
documents the architect intent. No action required for this spec; the noun-cleanup is
in-scope only for the opt-in re-model spec (Risk #1). Recording so the release
proposal and the eventual re-model spec inherit the rationale rather than re-discovering
it.

**Minor #2 — the per-each segment label is always the generic "/each", even when the
sub-unit is a named unit like `lbs` (Black Pepper).** `InventoryCatalogMode.tsx:420-421`
hardcodes `unitLabel('each', T)` for the right-hand divisor label. For Black Pepper the
*figure* ($8.40) is correctly per-lb, but the *word* says "each," so the row reads
"$8.40/each" where "$8.40/lb" would be more precise. This is consistent with my §Q-B,
which named the key `perEach` / reused `unitLabel('each')` and treated the right side as
a generic smallest-unit label — i.e. it is within the design envelope, not drift. But
it is a latent UX imprecision for named-sub-unit items. Cheapest correct fix if the
owner wants it later: label the per-each side with `unitLabel(g.primary.subUnitUnit || 'each', T)`
so packaging items show "/each" and bulk-with-named-sub-unit items show "/lb". Flagging
for the release proposal as a possible follow-up polish, NOT a blocker — the numbers are
all correct; only the noun is generic. (Note: this is a frontend label call; it touches
no contract.)

**Minor #3 — `perEachCost`'s `costPerUnit`-fallback branch is exercised by tests but
effectively dormant in the catalog UI.** The fallback (`costPerUnit / subUnitSize`,
`perEachCost.ts:74-76`) only fires when `casePrice <= 0` but `costPerUnit > 0` — and the
catalog passes `g.primary.casePrice` which is positive for essentially all seed rows
carrying a per-case breakdown. The branch is well-tested (`perEachCost.test.ts:85-105`)
and the design called for it as defense-in-depth for heterogeneous-`casePrice`-across-
stores rows (Risk #5), so this is intended, not dead code. Recording only so a future
reader doesn't mistake the well-covered branch for a hot path. No action.

---

## Acceptance-criteria spot-check (design map vs. code)

| AC | Design element | In code | Status |
|----|----------------|---------|--------|
| AC1 | pool unions `unit`+`subUnitUnit`+`purchaseUnit`, fed into both dropdowns | `brandUnitPool.ts:48-49`; `IngredientForm.tsx:509,554` | met |
| AC2 | pick writes only `set('unit'/'subUnitUnit')`, no inheritance | pool is names-only; no size/qty write on pick | met |
| AC3 | brand-scoped by store slice | `useStore` inventory/conversions only ever active brand | met (by construction) |
| AC4 | pool ON TOP of canonical ∪ conversions ∪ stored-value; sentinel last | `IngredientForm.tsx:498-529` (isCustom unchanged, `+ custom…` last) | met |
| AC5 | de-dupe on `lower(name)` via existing `validateCustomUnit` over widened options | pool folded into option keys; `brandUnitPool.ts:44-45` | met |
| AC6 | `$case · $each` when `pieces > 1` | `InventoryCatalogMode.tsx:411-424` | met |
| AC7 | divide by `caseQty × subUnitSize`; `db.ts` fallback untouched | `perEachCost.ts:62,67`; `db.ts:3769-3779` unchanged | met |
| AC8 | `null` when `pieces <= 1` → single price | `perEachCost.ts:64`; `showPerEach` gate `:411` | met |
| AC9 | preview number = `piecesPerCase`; correct for Cup (2000) AND bulk (20) | `IngredientForm.tsx:858,866`; guard on RAW `caseQty` `:857` | met |
| AC10 | no DB/edge/RLS/publication change; opaque text | confirmed §3 above | met |

## Risk re-confirmation (from the design's Risks section)

- **Risk #1 (display-only leaves prod data "messy").** Confirmed accepted: the empty-
  `sub_unit_unit` "2000 cases" readback (outcome a) is the visible face of this. If the
  user wants the clean re-model, that is a SEPARATE spec with a migration in the
  `>= 20260617000000_*.sql` slot + EOD/Reorder revalidation + pgTAP backfill coverage —
  not a change to this build. Flagging here per the design's instruction to "flag at review."
- **Risk #5 (`casePrice` basis).** The dev chose `g.primary.casePrice` as the case-side
  basis and `avgCost` as the `costPerUnit` fallback (`InventoryCatalogMode.tsx:401-402`),
  which is the design's stated default. No ambiguity remained for me to resolve.

---

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 3 Minor.
  Implementation honors the design: single shared piecesPerCase helper (both
  surfaces import it, neither re-implements), AC7 12x-error guard intact (divisor
  is caseQty x subUnitSize, db.ts:3769-3779 untouched), and zero DB/contract/RLS/
  realtime drift (display-only as designed). Both flagged behavioral outcomes —
  "2000 cases" preview for empty sub_unit_unit, and Black Pepper's dual
  "$42.00/case · $8.40/each" — are the INTENDED consequences of the locked
  display-only / number-only design and need no amendment within this spec. The
  three Minors are non-blocking (a documentation nuance, a generic "/each" label
  for named sub-units, and a well-tested-but-dormant fallback branch).
payload_paths:
  - specs/096/reviews/backend-architect.md
