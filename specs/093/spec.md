# Spec 093: Ingredient case-size canonical fix (`case_qty` write-to-wrong-column)

Status: READY_FOR_REVIEW

> **Owner-answered.** The five §Open-questions decisions are resolved (see
> §Open questions resolved): Q1=(a) fix + keep sub-unit, Q2=(a) audit + backfill,
> Q3=(a) align to `case_qty`, Q4=(b) form + verify consumers, Q5=reconcile to
> match Q1(a). One path requires a **prod data backfill migration** (Q2(a)) the
> owner will run via explicit `supabase db push`. This is the exact silent
> 12×-class data error class that `unitConversion.ts:237-243` documents — the
> backfill must ship with a documented backout and a hand-review list for split
> rows (e.g. American Cheese 4/5).

## User story

As a **store manager configuring a catalog ingredient** in the admin "Edit
ingredient" drawer (Cmd UI), I want the "UNITS & PACK" fields to write the case
size to the same column that the reorder and end-of-day features read, and the
grey readback line to describe a conversion I recognize, so that when I set
"1 case = 20 lbs" the reorder-by-the-case suggestion and the EOD Cases box
actually use that case size instead of silently ignoring it.

Secondary (the owner's literal complaint, which surfaced the bug):
As a store manager, I want the readback to stop saying
`= 1 lbs × 20 cases = 20 cases per order` for a `cases / 1 / 20 / lbs` row,
because that sentence is both grammatically inverted and arithmetically
meaningless ("1 lb × 20 case = 20 case" is not a real conversion).

## Background (verified — file:line refs)

**The form writes the wrong column.** In
[src/components/cmd/IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx)
the "UNITS & PACK" fields bind through
[IngredientFormDrawer.tsx] → [src/lib/db.ts:278-280](../src/lib/db.ts) as:

| Form field (label / help)                                | Form key      | Writes to       |
|----------------------------------------------------------|---------------|-----------------|
| DEFAULT UNIT (tracking unit)                             | `unit`        | `unit` ✅       |
| **PACKS / ORDER** ("how many packs at a time", default '1') | `caseQty`     | `case_qty` ❌   |
| **UNITS / PACK** ("default units in one pack")          | `subUnitSize` | `sub_unit_size` ❌ |
| PACK UNIT ("the shipping wrapper — case, box, tray")    | `subUnitUnit` | `sub_unit_unit` |

The readback at [IngredientForm.tsx:778-801](../src/components/cmd/IngredientForm.tsx)
renders `= {caseQty} {packLabel} × {subUnitSize} {unit} = {total} {unit} per order`,
i.e. it treats `case_qty` as "packs per order" and `sub_unit_size` as
"units per pack".

**But `case_qty` canonically means UNITS-PER-CASE everywhere else:**
- Reorder (spec 088) — [supabase/migrations/20260602000000_reorder_suggested_cases.sql:380,437](../supabase/migrations/20260602000000_reorder_suggested_cases.sql): `suggested_cases = ceil(suggested_qty / case_qty)`.
- EOD (spec 086) — [src/screens/staff/screens/EODCount.tsx:358,606](../src/screens/staff/screens/EODCount.tsx): `total = cases × (case_qty || 1) + units`.
- [src/lib/orderCalculator.ts:23](../src/lib/orderCalculator.ts): `caseQty // units per case`.
- [src/utils/unitConversion.ts:237-243](../src/utils/unitConversion.ts): explicitly states `case_qty` and `sub_unit_size` are DIFFERENT axes, that conflating them once produced a documented "12× error", and that `sub_unit_size` = sub-units per *tracking unit* (e.g. a bag of 10 each), NOT per case.

**Consequence of the column swap.** Setting "1 case = 20 lbs" via the form
writes `case_qty=1`, `sub_unit_size=20`. Therefore:
- Reorder-by-the-case (088) reads `case_qty=1` → "no case size" → shows nothing for that item.
- EOD Cases box (086) reads `case_qty=1` → treats 1 case = 1 unit, miscounting by 20×.
The case size set in this form is invisible to the two features that consume it.

**Prod data is itself split** ([supabase/seed.sql:254+](../supabase/seed.sql),
pulled from prod 2026-05-02):
- `#1 Togo Box`: `case_qty=450`, `sub_unit_size=1` (case size in `case_qty` — canonical).
- `1/8 Brown Paper Bag`: `case_qty=1`, `sub_unit_size=500` (case size in `sub_unit_size` — the wrong column).
- `American Cheese`: `case_qty=4`, `sub_unit_size=5 lbs` (splits both axes).

**Cost-math divergence.** Every seeded `default_cost` equals
`default_case_price / case_qty` (confirming units-per-case intent), yet
[unitConversion.ts:278 `calcUnitCost()`](../src/utils/unitConversion.ts)
divides by `case_qty × sub_unit_size`, and the fallback cost path at
[db.ts:3710-3716](../src/lib/db.ts) does the same (`total = caseQty * subUnitSize`).
These diverge on every `sub_unit_size > 1` row.

## Acceptance criteria

- [ ] **Readback wording (owner's literal complaint).** For a row with
  DEFAULT UNIT=`cases`, the case-size field=`20`, PACK UNIT=`lbs`, the grey
  "UNITS & PACK" readback reads as a plain, correct conversion — e.g.
  `1 case = 20 lbs · order = 1 case → 20 lbs` — and never emits the inverted
  `= 1 lbs × 20 cases = 20 cases per order` form. Exact string is a FE detail;
  the test asserts the readback contains "1 case = 20 lbs" and does NOT contain
  "20 cases per order" for that input.
- [ ] **Column binding (Q1(a)).** Saving "1 case = 20 lbs" from the drawer
  persists `case_qty=20` (units-per-case) on `catalog_ingredients`, NOT
  `case_qty=1, sub_unit_size=20`. Verified by reading the row after save.
- [ ] **Sub-unit retained as a separate axis (Q1(a)).** The
  `sub_unit_size`/`sub_unit_unit` fields remain in the drawer as a distinct,
  clearly-relabeled recipe-costing sub-unit breakdown (e.g. a case of bags where
  each bag = 10 each). Setting the case size does not write to `sub_unit_size`,
  and setting the sub-unit breakdown does not write to `case_qty`. The two are
  never conflated. Verified by saving a row with BOTH a case size and a distinct
  sub-unit and reading back independent `case_qty` and `sub_unit_size` values.
- [ ] **Reorder round-trip (Q4(b)).** After saving a row as "1 case = 20 lbs"
  via the fixed form, the reorder (088) path computes `suggested_cases =
  ceil(suggested_qty / 20)` for that item (i.e. case size is no longer
  invisible). No behavior change to the reorder screen itself — this is an
  end-to-end proof against a fixed row. Track-2 (pgTAP) or Track-1 fixture.
- [ ] **EOD round-trip (Q4(b)).** After saving the same row, the EOD (086)
  Cases box computes `total = cases × 20 + units`. No behavior change to the EOD
  screen itself — end-to-end proof against a fixed row. Track-1 (jest) against
  the EODCount calc.
- [ ] **Label/help reconciliation (Q5 → Q1(a)).** Labels are reconciled so
  case-size vs. the retained sub-unit breakdown is unmistakable, and the
  "PACK UNIT" help ("the shipping wrapper — case, box, tray") is fixed so it no
  longer contradicts `unitConversion`'s "sub-unit = per tracking unit" meaning.
  Exact copy is finalized at architect/FE time (owner has no specific wording
  preference). Asserted by snapshot/string test on the rendered labels+help:
  the case-size field and the sub-unit field carry distinct labels, and the help
  text for the sub-unit/pack field describes "per tracking unit," not a
  shipping-wrapper-only meaning.
- [ ] **Existing-data posture (Q2(a)).** A prod backfill migration moves rows
  that encode case size in `sub_unit_size` (e.g. `1/8 Brown Paper Bag`
  `case_qty=1, sub_unit_size=500`) into `case_qty`, ships with a documented
  backout, and produces a hand-review list for split rows that populate BOTH
  axes (e.g. `American Cheese` `case_qty=4, sub_unit_size=5 lbs`) — split rows
  are NOT auto-mutated; they are flagged for owner hand-review. The architect
  designs the migration; the owner runs the explicit `supabase db push`.
- [ ] **Cost calc (Q3(a)).** `calcUnitCost` ([unitConversion.ts:278](../src/utils/unitConversion.ts))
  and the db.ts:3710 fallback are aligned to `case_price / case_qty`, matching
  how prod `default_cost` was computed. A jest test pins
  `calcUnitCost(20.00, 20, anything) === 1.00` (i.e. the third argument /
  `sub_unit_size` no longer affects the per-unit cost).
- [ ] No regression to the spec 045/046/052/054 behaviors of this drawer
  (custom-unit input, abstract-unit warning, default-unit help, custom-unit
  help-persists-under-error). Existing tests for those specs stay green.

## In scope

- Fixing the column binding for the case-size field in
  `IngredientForm.tsx` / `IngredientFormDrawer.tsx` / `db.ts:278-280` so the
  case size lands in the canonical `case_qty` column (Q1(a)).
- Keeping `sub_unit_size`/`sub_unit_unit` in the drawer as a *separate*,
  clearly-relabeled recipe-costing sub-unit breakdown, never conflated with case
  size (Q1(a)).
- Rewording the grey "UNITS & PACK" readback to a correct, plain-language
  conversion. (Owner's literal complaint.)
- Reconciling the PACK-UNIT / sub-unit labels + help so they stop contradicting
  `unitConversion`'s documented meaning; exact copy finalized at architect/FE
  time (Q5 → Q1(a)).
- A prod backfill migration (Q2(a)) that moves "case size in `sub_unit_size`"
  rows into `case_qty`, with a documented backout and a hand-review list for
  split rows; owner runs the explicit `supabase db push`.
- Aligning `calcUnitCost` + the db.ts:3710 fallback cost path to
  `case_price / case_qty` (Q3(a)).
- Regression tests proving reorder (088) and EOD (086) compute correct numbers
  for a fixed row, with no behavior change to those screens (Q4(b)).

## Out of scope (explicitly)

- **Hiding `sub_unit_size`/`sub_unit_unit` from the drawer (Q1 alt (b)).** Owner
  chose Q1(a) — keep them as a separate, relabeled sub-unit breakdown. Rationale:
  they are load-bearing for recipe costing; removing them would break that path.
- **Fix-forward-only / no data migration (Q2 alt (b)).** Owner chose Q2(a) —
  audit + backfill. Rationale: leaving the catalog internally inconsistent until
  each row is re-saved keeps the silent 12×-class miscount live for existing rows.
- **Audit-only report with no automated mutation (Q2 alt (c)).** Owner chose
  Q2(a) — the migration mutates non-split rows automatically; only split rows go
  to hand-review. Rationale: an audit-only posture leaves the bulk fix as manual
  toil the owner explicitly opted out of.
- **Keeping the `case_qty × sub_unit_size` cost divisor (Q3 alt (b)).** Owner
  chose Q3(a) — align to `case_price / case_qty`. This also means prod
  `default_cost` values are NOT recomputed/migrated (they already match the
  Q3(a) formula). Rationale: a price recompute is a data migration of its own and
  is not needed under Q3(a).
- **Deferring cost math to a later spec (Q3 alt (c)).** Owner chose Q3(a) — cost
  math is fixed in 093, not deferred. Rationale: leaving the divisor wrong keeps
  `calcUnitCost` diverging from prod `default_cost` on every `sub_unit_size > 1`
  row.
- **Redesigning the Conversions tab / item-specific conversion rows.** The
  abstract-unit → physical-meaning mapping lives there; this spec only touches
  the catalog case/pack fields. Rationale: separate surface, separate spec.
- **Changing the `default_cost` *values* already in prod.** Under Q3(a) the
  prod values already match `case_price / case_qty`, so no value migration runs.
  Rationale: a price recompute is a data migration of its own and should not ride
  a form-bug fix silently.
- **Staff app or customer PWA UI changes.** This is the admin Cmd UI drawer.
  The staff EOD *read* of `case_qty` (086) is verified-correct and only gets a
  regression check, not a behavior change (Q4(b)). Rationale: this repo is
  admin+staff; the bug is in the admin write path.
- **Any change to `app.json` `slug`** (`towson-inventory`). Not touched by this
  spec; flagged only because it is load-bearing and DO-NOT-AUTO-FIX.
- **Broadening which roles can edit the catalog**, realtime channel changes, or
  brand-catalog propagation semantics. The catalog write already propagates to
  all stores via `catalog_ingredients` (db.ts:271-280); 093 keeps that as-is.

## Open questions resolved

- **Q1 — Canonical meaning + fate of `sub_unit_size`.** → **(a) Fix + keep
  sub-unit.** Write the case size to `case_qty` (units-per-case, matching reorder
  088 / EOD 086 / orderCalculator / unitConversion). KEEP
  `sub_unit_size`/`sub_unit_unit` in the drawer as a *separate*, clearly-relabeled
  recipe-costing sub-unit breakdown (e.g. a case of bags where each bag = 10
  each) — never conflated with case size.
- **Q2 — Existing prod data (mixed encodings).** → **(a) Audit + backfill.** A
  prod migration moves "case size in `sub_unit_size`" rows into `case_qty`, with
  a documented backout AND a hand-review list for split rows (e.g. American
  Cheese 4/5). The architect designs the migration; the owner runs the explicit
  `supabase db push`.
- **Q3 — `calcUnitCost` divergence.** → **(a) Align to `case_qty`.** Change
  `calcUnitCost` ([unitConversion.ts:278](../src/utils/unitConversion.ts)) and
  the db.ts:3710 fallback to `case_price / case_qty`, matching how prod
  `default_cost` was computed. Keep the jest pin
  `calcUnitCost(20.00, 20, anything) === 1.00`.
- **Q4 — Scope reach.** → **(b) Form + verify consumers.** Fix the form PLUS add
  regression tests proving reorder (088) and EOD (086) compute correct numbers
  for a fixed row. No behavior change to those screens — just end-to-end proof.
- **Q5 — Labels.** → **Reconcile to match Q1(a).** Relabel so case-size vs.
  sub-unit is unmistakable, and fix the "PACK UNIT = shipping wrapper" help that
  contradicts `unitConversion`'s "sub-unit = per tracking unit" meaning. Owner has
  NO specific wording preference — exact copy is finalized at architect/FE time.

## Dependencies

- Spec 088 reorder migration —
  [supabase/migrations/20260602000000_reorder_suggested_cases.sql](../supabase/migrations/20260602000000_reorder_suggested_cases.sql)
  (consumer of `case_qty`; round-trip AC depends on it).
- Spec 086 EOD count — [src/screens/staff/screens/EODCount.tsx](../src/screens/staff/screens/EODCount.tsx)
  (consumer of `case_qty`).
- [src/lib/orderCalculator.ts](../src/lib/orderCalculator.ts),
  [src/utils/unitConversion.ts](../src/utils/unitConversion.ts) (canonical
  definitions + cost math).
- Catalog write path: [src/lib/db.ts:271-300](../src/lib/db.ts),
  `IngredientFormDrawer.tsx`.
- Prior drawer specs whose behavior must not regress: 045 (pack-unit clarity),
  046 (custom unit input), 052 (default-unit help), 054 (custom-unit help
  persists under error).
- **Prod backfill migration (Q2(a)).** New timestamped migration under
  `supabase/migrations/`; requires the owner's explicit `supabase db push` and a
  documented backout (mirrors the spec 064 "don't drift via dashboard" posture
  and the prod-state mirror policy). Split rows that populate both axes are
  flagged for hand-review, not auto-mutated.

## Project-specific notes

- **Cmd UI section / legacy:** Admin Cmd UI — `src/components/cmd/IngredientForm.tsx`
  + `IngredientFormDrawer.tsx`, reached from the ingredient sections under
  `src/screens/cmd/sections/`. No legacy admin surface (spec 025 deleted it).
- **Per-store or admin-global:** The case/pack fields are **catalog-level**
  (`catalog_ingredients`) and propagate to ALL stores per
  [db.ts:271-273](../src/lib/db.ts) — i.e. brand-global, not per-store. Per-store
  fields (cost, par, stock, vendor) are untouched here. Editing still respects
  the existing catalog-write RLS; 093 does not change who may edit.
- **Edge function or PostgREST:** PostgREST/RPC via `db.ts` for the form write.
  No edge function involved. The Q2(a) backfill is a plain SQL migration, not an
  edge function.
- **Realtime channels touched:** Catalog edits already fan out on `brand-{id}`
  via `useRealtimeSync`. No new channel. Risk to flag at build time: the
  realtime-publication-snapshot gotcha if any new table/column is added to a
  publication (per CLAUDE.md + MEMORY) — but 093 adds no new tables/columns
  (the backfill mutates existing rows of an existing table), so likely N/A;
  architect to confirm.
- **Migrations needed:** **Yes — Q2(a) backfill migration** (prod-touching).
  New timestamped file under `supabase/migrations/`, documented backout,
  split-row hand-review list, owner-run `supabase db push`.
- **Edge functions touched:** None.
- **Web/native scope:** The drawer renders in both web (Vercel) and native
  (EAS) via react-native-web; the fix is platform-agnostic (no web-only CSS /
  web-push). Tests should not assume a platform.
- **Tests (spec 022 tracks):**
  - Track-1 (jest): readback string assertion; `calcUnitCost(20.00, 20, anything)
    === 1.00` pin (Q3(a)); EOD calc round-trip (Q4(b)); label/help snapshot;
    independent `case_qty` vs. `sub_unit_size` write assertion (Q1(a)).
  - Track-2 (pgTAP): reorder `suggested_cases` round-trip for a fixed row
    (Q4(b)); and a backfill-correctness test (count of mis-encoded rows = 0 after
    migration; split rows untouched and surfaced in the hand-review list) (Q2(a)).
  - Track-3 (shell smoke): apply-order smoke for the backfill migration (Q2(a)).

## Backend design

> Authored by `backend-architect` (design mode). The developer authors the
> migration + code; signatures, schema, and the migration predicate below are
> the contract.

### 0. Precise restatement of the bug (read before touching anything)

The spec's "writes the wrong column" framing is one step too coarse. The
**db.ts write mapping is already correct** — [db.ts:278-280](../src/lib/db.ts)
maps `caseQty → case_qty` and `subUnitSize → sub_unit_size`, which is the
canonical direction. The defect is **upstream, in the form**: the UI input a
manager reaches for to type "the case size" is the field *labeled*
`UNITS / PACK`, which is bound to the form key `subUnitSize`
([IngredientForm.tsx:712](../src/components/cmd/IngredientForm.tsx)). The field
labeled `PACKS / ORDER` (bound to `caseQty`,
[IngredientForm.tsx:711](../src/components/cmd/IngredientForm.tsx)) is the one
that actually feeds the canonical `case_qty` column, but its label/help
("how many packs at a time", default `'1'`) tells the manager to leave it at 1.

Net effect for "1 case = 20 lbs": manager types `20` into `UNITS / PACK`
(`subUnitSize → sub_unit_size`) and leaves `PACKS / ORDER` at `1`
(`caseQty → case_qty`). Case size lands in `sub_unit_size`; `case_qty` stays 1.

**So the fix is a form re-bind + relabel, not a db.ts mapping change.** The
case-size input must feed `caseQty` (→ `case_qty`); the *separate* sub-unit
breakdown input must feed `subUnitSize` (→ `sub_unit_size`). db.ts:278-280 is
left exactly as-is — it is the one correct seam in the chain. This is the
cheapest correct fix and it preserves the existing `mapItem`/`catalogUpdates`
contract verbatim.

### 1. Data model changes

**No DDL.** `catalog_ingredients` already has the two `numeric default 1`
columns this spec needs — `case_qty` and `sub_unit_size`
([20260504060452_brand_catalog_p1_additive.sql:40-41](../supabase/migrations/20260504060452_brand_catalog_p1_additive.sql)).
No new table, column, index, or constraint. The only migration is a **data
backfill** (UPDATE-only) plus an **audit table for split-row hand-review**.

Proposed migration filename:
`supabase/migrations/20260602120000_spec093_case_qty_backfill.sql`
(strictly after the latest on disk, `20260602000000_reorder_suggested_cases.sql`;
today is 2026-06-02). **Additive + reversible** — no destructive DDL; the only
mutation is an UPDATE of `case_qty`/`sub_unit_size` on a conservatively-scoped
row set, captured in a side table so the backout is a deterministic restore.

#### 1a. The backfill predicate (the hard part — designed conservatively)

The data genuinely has three populations (confirmed against
[seed.sql:254-398](../supabase/seed.sql), the prod mirror):

| Population | Shape | Examples (seed) | Action |
|---|---|---|---|
| **A. Canonical** | `case_qty > 1 AND sub_unit_size <= 1` | `#1 Togo Box` 450/1, `8oz Cup` 250/1, `Tortilla` 40/1, `Coca Cola` 35/1 | **Leave untouched.** Already correct. |
| **B. Mis-filed (auto-migrate)** | `case_qty <= 1 AND sub_unit_size > 1` | `1/8 Brown Paper Bag` 1/500, `16oz Fries Cup` 1/500, `2oz Cup` 1/2000, `Egg Large` 1/360, `Crawfish` 1/20, `Broccoli` 1/15 | **Auto-migrate:** `case_qty := sub_unit_size`, `sub_unit_size := 1`. |
| **C. Split / both axes (ambiguous)** | `case_qty > 1 AND sub_unit_size > 1` | `American Cheese` 4/5, `Banana Pudding` 8/5, `Ground Beef` 6/10, `Pita Bread` 12/10, `Wings` 4/10, `Philly Steak` 27/6, `Chicken Tenderloin` 4/10 | **DO NOT mutate.** Insert into the hand-review table for owner. |
| **D. Neither / degenerate** | `case_qty <= 1 AND sub_unit_size <= 1` | `Napkin (Togo)` 1/1, `Milk` 1/1, `Fry Oil Canola` 1/1, `Floor Cleaner Fabuloso` 1/1 | **Leave untouched.** No case size to recover; nothing to do. |

**Exact predicates** (numeric-safe; `coalesce(...,1)` mirrors how reorder 088
normalizes nulls at [reorder migration:391](../supabase/migrations/20260602000000_reorder_suggested_cases.sql)):

```
-- Population B — auto-migrate (the ONLY rows the UPDATE touches)
WHERE coalesce(case_qty, 1) <= 1
  AND coalesce(sub_unit_size, 1) > 1

-- Population C — hand-review only (NEVER mutated)
WHERE coalesce(case_qty, 1) > 1
  AND coalesce(sub_unit_size, 1) > 1
```

Why this split is the conservative choice (surfaced as a risk in §10, not
hidden): Population B's `case_qty <= 1` proves no case-size data already lives
in the canonical column, so moving `sub_unit_size` there cannot overwrite a
legitimate value — the move is information-preserving and unambiguous. The
instant *both* axes carry `> 1` (Population C) we cannot tell, from the row
alone, whether `sub_unit_size` is a real recipe-costing sub-unit (e.g. a 4-case
of 5-lb blocks → 4 cases × 5 lb) or a second mis-file. The spec's own example
`American Cheese 4/5` is exactly this. Auto-mutating C risks re-introducing the
documented 12×-class error
([unitConversion.ts:237-243](../src/utils/unitConversion.ts)) in the opposite
direction — so C goes to a human, by owner mandate (AC "Existing-data posture").

**`sub_unit_unit` is NOT part of the predicate.** Population B rows carry mixed
`sub_unit_unit` values — most are `'each'` but some are empty (`3.25oz Cup`
1/2000 `''`, `4LB Brown Paper Bag` 1/400 `''`). Gating on `sub_unit_unit` would
silently skip the empty-unit mis-files and leave them broken. The numeric
predicate alone is the correct gate; the migration copies whatever
`sub_unit_unit` was there into nothing (it stays put — see §1b note).

#### 1b. Migration structure (the developer authors the SQL; this is the shape)

The migration is a single transaction with five ordered steps. Pseudocode /
shape only (architect output carries no committed SQL):

1. **Create the audit/backout table** (idempotent, survives the txn so the
   backout and the hand-review list persist):
   `public.spec093_case_qty_backfill_audit (catalog_id uuid primary key,
    name text, brand_id uuid, old_case_qty numeric, old_sub_unit_size numeric,
    old_sub_unit_unit text, new_case_qty numeric, new_sub_unit_size numeric,
    population char(1), migrated_at timestamptz default now())`.
   `population` is `'B'` (auto-migrated) or `'C'` (flagged, not mutated). This
   one table is BOTH the backout source (Population B rows) AND the
   hand-review list (Population C rows) — single artifact, two readers.
2. **Snapshot Population B** into the audit table with `population='B'`,
   recording `old_*` = current and `new_*` = (`sub_unit_size`, `1`).
3. **Snapshot Population C** into the audit table with `population='C'`,
   `old_*` = current, `new_*` = NULL (no proposed change — these are for the
   owner to resolve by hand). A `RAISE NOTICE` reports the Population C count so
   the owner sees "N split rows flagged for review" in the `db push` output.
4. **UPDATE Population B only** —
   `set case_qty = sub_unit_size, sub_unit_size = 1` where the §1a B-predicate
   holds. `sub_unit_unit` is intentionally left as-is (it described the pack
   wrapper; for a pure case-size row it is now vestigial but harmless and the
   reorder/EOD/cost paths never read it). Update `updated_at = now()` so
   realtime fan-out (§6) replays the change.
5. **Documented backout** — ship as a commented-out `-- ROLLBACK / BACKOUT`
   block at the foot of the same file (the project has no down-migration
   convention; this mirrors the "documented backout" wording the owner asked
   for). The backout restores from the audit table:
   `update catalog_ingredients c set case_qty = a.old_case_qty,
    sub_unit_size = a.old_sub_unit_size, updated_at = now()
    from spec093_case_qty_backfill_audit a
    where a.catalog_id = c.id and a.population = 'B';`
   followed by `drop table spec093_case_qty_backfill_audit;`. The owner runs
   this by hand if the push needs reverting — it is NOT auto-applied.

**Idempotency / re-run safety.** The B-predicate is self-extinguishing: after
step 4, migrated rows have `sub_unit_size = 1`, so they no longer match
`sub_unit_size > 1` and a re-run is a no-op on data. Guard the audit-table
insert with `on conflict (catalog_id) do nothing` so a second apply doesn't
double-insert. The supabase migration ledger already prevents re-application in
the normal path; this is belt-and-suspenders for a hand-run.

**Multi-brand note.** The predicate is brand-agnostic (no `brand_id` filter) —
it fixes the mis-encoding wherever it exists. The audit table records
`brand_id` so the owner's hand-review list is sortable per brand. Today only
`2AM PROJECT` has catalog rows, but copy-brand-catalog
([20260517030000_copy_brand_catalog.sql](../supabase/migrations/20260517030000_copy_brand_catalog.sql))
means cloned brands could carry the same mis-encoding; the unscoped predicate
catches them.

### 2. RLS impact

**None.** No new RLS policy, no policy change. Rationale:
- The backfill runs as the migration role (superuser-equivalent during
  `db push`), which bypasses RLS — policies are irrelevant to the UPDATE.
- The new `spec093_case_qty_backfill_audit` table is an **internal migration
  artifact**, never read by the app, never reached over PostgREST. It needs no
  RLS policy and no grant to `anon`/`authenticated`. To stay clean against the
  spec 053 permissive-policy lint and the spec 065 anon-grant posture, the
  migration should NOT grant any privilege on it to `anon`/`authenticated`
  (RLS-enabled-no-policy = deny-all to those roles, which is the desired
  posture for a back-office table). If the developer prefers, `revoke all on
  public.spec093_case_qty_backfill_audit from anon, authenticated;` makes the
  intent explicit.
- The form write path is unchanged: catalog edits already go through the
  existing `catalog_ingredients` UPDATE in
  [db.ts:296-301](../src/lib/db.ts), gated by the catalog-write RLS established
  in the brand-catalog P5 / per-store-hardening migrations. 093 does not change
  who may edit (explicit out-of-scope item).

**Lint interaction to verify at build:** confirm the audit table does not trip
[supabase/tests/permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql)
— it won't, because that probe only flags *permissive policies* with
trivially-wide USING/CHECK, and this table has **no policy at all**. Flagged so
the dev doesn't reflexively add a wide policy "to be safe."

### 3. API contract

**Unchanged — PostgREST table UPDATE, no RPC.** The form write continues
through `db.updateInventoryItem` → resolve `catalog_id` → `supabase.from(
'catalog_ingredients').update(catalogUpdates)`
([db.ts:289-301](../src/lib/db.ts)). No new RPC is justified: the operation is a
single-table column update already covered by the existing helper, and an RPC
would add a SECURITY DEFINER surface for zero benefit (cf. the CLAUDE.md
"DB access centralized" + "don't add RPC surface without cause" posture).

- **Request shape (unchanged):** the existing `catalogUpdates` partial. After
  the form fix, a "1 case = 20 lbs" save sends `{ case_qty: 20, sub_unit_size:
  1, sub_unit_unit: 'lbs', updated_at }` instead of today's
  `{ case_qty: 1, sub_unit_size: 20, ... }`. **The keys and the db.ts mapping
  are identical** — only the *values the form puts in `caseQty` vs.
  `subUnitSize`* change.
- **Response shape:** unchanged (PostgREST returns the updated row / 204).
- **Error cases:** unchanged — surfaced via the store's optimistic-then-revert
  + `notifyBackendError` (§7). No new error class.

### 4. Edge function changes

**None.** No edge function reads or writes `case_qty`/`sub_unit_size` in a way
this spec touches; the backfill is a plain SQL migration (explicit in the
spec). `verify_jwt` settings unchanged. The `staff-*` service-token path is not
involved — EOD reads `case_qty` through the staff app's own data path and only
gets a *regression test* (§8), no code change.

### 5. `src/lib/db.ts` surface

**No new helper; no signature change to `updateInventoryItem`.** The existing
[db.ts:264-280](../src/lib/db.ts) write path already carries `caseQty`,
`subUnitSize`, `subUnitUnit` through `catalogUpdates` with the correct
snake_case mapping. The frontend keeps calling
`updateItem(item.id, toUpdates(values))` exactly as today.

**One required change in db.ts (Q3(a) cost alignment), NOT a new surface — a
fix to the existing fallback at [db.ts:3710-3716](../src/lib/db.ts):**

```
// mapItem() fallback cost — BEFORE:
const total = caseQty * subUnitSize;
return total > 0 && cp > 0 ? cp / total : 0;
// AFTER (divide by case_qty alone, matching prod default_cost):
return caseQty > 0 && cp > 0 ? cp / caseQty : 0;
```

`subUnitSize` is then unused in that IIFE; the dev removes the now-dead local or
leaves it (it is still read for the `subUnitSize` field of the returned object
at [db.ts:3731](../src/lib/db.ts)). The snake_case→camelCase mapping
(`cat.case_qty → caseQty`, `cat.sub_unit_size → subUnitSize`) is unchanged.

This fallback only fires when a per-store `cost_per_unit` is absent
([db.ts:3712](../src/lib/db.ts) returns the stored value first), so for seeded
data — which has explicit `cost_per_unit` — behavior is unchanged in practice;
the fix aligns the *derivation* with `case_price / case_qty` for the rows that
do fall through.

### 6. Realtime impact

**Channel: `brand-{id}`. No new channel; no publication membership change.**

- Catalog edits already fan out on `brand-{id}` via
  [useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) — the form write
  touches `catalog_ingredients`, which is brand-scoped, so an admin editing the
  case size triggers the debounced (400ms) reload on the `brand-{id}` channel.
  This is unchanged.
- **The backfill migration adds NO table/column to the `supabase_realtime`
  publication.** It UPDATEs existing rows of an already-published table
  (`catalog_ingredients`). Therefore the realtime-publication-snapshot gotcha
  (CLAUDE.md + MEMORY: `docker restart supabase_realtime_imr-inventory` after a
  publication-membership change) **does NOT apply here** — flagged explicitly
  per the spec's request to confirm. The new `*_audit` table is intentionally
  *not* added to any publication (it is a back-office artifact).
- One nuance for the backfill: it mutates rows server-side, not through a
  client session. If an admin has the catalog open during the owner's
  `db push`, the row UPDATEs (with bumped `updated_at`) will replay on their
  `brand-{id}` channel and refresh their view — which is correct and desirable.
  No action needed; noting it so it isn't mistaken for a bug.

### 7. Frontend store impact

**Slice: the catalog/inventory slice of [useStore.ts](../src/store/useStore.ts)
via `updateItem` → `db.updateInventoryItem`.** The
optimistic-then-revert-with-`notifyBackendError` pattern
([useStore.ts:23](../src/store/useStore.ts)) **already wraps this write and is
unchanged.** No store action is added or modified — the form fix changes which
*value* flows into the existing `caseQty`/`subUnitSize` fields of the
`Partial<InventoryItem>` that `toUpdates()` builds
([IngredientFormDrawer.tsx:66-84](../src/components/cmd/IngredientFormDrawer.tsx)),
not the store mechanics.

The frontend changes are confined to the **form component layer**:
- [IngredientForm.tsx:711-712](../src/components/cmd/IngredientForm.tsx) — the
  two `InputLine`s. Re-bind so the **case-size** input writes `caseQty` and the
  **sub-unit breakdown** input writes `subUnitSize`, with reconciled labels
  (§9). The db-facing form keys (`caseQty`, `subUnitSize`) keep their names so
  `toUpdates()` and db.ts need no change — only the *labels and onChange
  targets* of the visible inputs move.
- [IngredientForm.tsx:778-801](../src/components/cmd/IngredientForm.tsx) — the
  grey readback. Rewrite to a plain conversion (§9).
- [IngredientForm.tsx:708,720,774](../src/components/cmd/IngredientForm.tsx) —
  help strings reconciled (§9). `blankValues()`
  ([IngredientForm.tsx:63-66](../src/components/cmd/IngredientForm.tsx)) keeps
  `caseQty: '1', subUnitSize: '1'` defaults — correct for "1 unit per case / no
  sub-unit breakdown."
- The `IngredientFormValues.subUnitSize` doc comment
  ([IngredientForm.tsx:35](../src/components/cmd/IngredientForm.tsx)) currently
  says `"default unit size (e.g. 40 lbs per case)"` — that comment encodes the
  bug. Update it to describe the sub-unit-per-tracking-unit meaning.

### 8. Cost-math alignment (Q3(a))

Two call sites, both divide by `case_qty` alone after the fix:

1. **`calcUnitCost` ([unitConversion.ts:278-282](../src/utils/unitConversion.ts)):**
   change `const totalPerCase = caseQty * subUnitSize;` →
   `const totalPerCase = caseQty;`. The `subUnitSize` parameter is retained in
   the signature (third arg) for call-site compatibility but no longer affects
   the result — this satisfies the AC pin `calcUnitCost(20.00, 20, anything)
   === 1.00`. Keeping the 3-arg signature avoids churning every caller; the dev
   may optionally annotate the param as unused.

   > **Decision flagged for reviewers:** I am keeping the third parameter rather
   > than deleting it, because the AC literally pins a 3-arg call
   > (`calcUnitCost(20.00, 20, anything)`) and because `calcCasePrice`
   > ([unitConversion.ts:285](../src/utils/unitConversion.ts)) — the inverse —
   > still multiplies by `subUnitSize`. **Open sub-question for the owner/FE
   > (non-blocking):** should `calcCasePrice` also drop `subUnitSize` to stay
   > the exact inverse of `calcUnitCost`? The spec only names `calcUnitCost`,
   > so I am scoping `calcCasePrice` OUT by default; if it is used in a
   > round-trip it will now disagree with `calcUnitCost` on `sub_unit_size > 1`
   > rows. See §10 risk R4.

2. **db.ts:3710 fallback** — covered in §5.

### 9. Labels + readback reconciliation (Q5)

Exact copy is FE's call (owner has no preference); the design pins the
*semantics* the strings must satisfy so the §AC label/help test is writable:

- **Case-size field** (binds `caseQty → case_qty`): label must read as
  units-per-case, e.g. `units / case` or `case size`. Help: "how many tracking
  units come in one case (e.g. 20 lbs per case)".
- **Sub-unit breakdown field** (binds `subUnitSize → sub_unit_size`): label
  must be visibly distinct from the case-size field, e.g. `sub-unit / unit` or
  `pack breakdown`. Help: must describe **per-tracking-unit** meaning — "how
  many sub-units make up ONE tracking unit (e.g. a bag of 10 each)" — and MUST
  NOT describe a shipping-wrapper-only meaning. This directly fixes the
  contradiction the spec calls out.
- **PACK UNIT help** ([IngredientForm.tsx:720,774](../src/components/cmd/IngredientForm.tsx)):
  the current `"the shipping wrapper — case, box, tray"` contradicts
  `unitConversion`'s "sub-unit = per tracking unit." Reword so it describes the
  unit OF the sub-unit breakdown (e.g. "the unit each sub-unit is measured in —
  each, lb, oz"), keeping the existing "define abstract units on the
  Conversions tab" sentence.
- **Readback** ([IngredientForm.tsx:778-801](../src/components/cmd/IngredientForm.tsx)):
  drive it off the **case-size** value now, as a plain conversion. For DEFAULT
  UNIT=`cases`/case size=`20`/PACK UNIT=`lbs` it must render a string that
  **contains `1 case = 20 lbs`** and **does NOT contain `20 cases per order`**
  (the exact AC assertion). A correct template:
  `1 {caseUnit} = {caseQty} {unit}` (the `× … per order` arithmetic that
  produced the inverted sentence is deleted). Guard the same
  finite/positive checks as today so it renders nothing for empty input.

> **Label-vs-DEFAULT-UNIT nuance (note for FE, not a blocker):** the readback's
> "1 case = 20 lbs" reads cleanly when DEFAULT UNIT is the pack noun (`cases`)
> and PACK UNIT is the contents (`lbs`) — which is how the mis-encoded prod rows
> are shaped. When DEFAULT UNIT is already the base unit (e.g. `each` with case
> size 450, like `#1 Togo Box`), phrase it as `1 case = 450 each` using a
> literal "case" noun, falling back to `subUnitUnit` when present. FE picks the
> noun source; the test only pins the `cases`/`lbs` example from the AC.

### 10. Risks and tradeoffs (explicit)

- **R1 — Backfill predicate ambiguity (HIGHEST RISK; surfaced for owner).**
  Population C (both axes `> 1`) is genuinely undecidable from the row alone.
  The design refuses to auto-mutate it and routes it to a hand-review table by
  owner mandate. **Residual exposure:** a Population *B* row whose
  `sub_unit_size` was, in truth, a legitimate sub-unit (and whose `case_qty`
  legitimately is 1) would be mis-migrated. Scanning the seed, no such row is
  evident — every `case_qty<=1, sub_unit_size>1` row reads as a wrapped
  pack-of-N (cups, bags, eggs, produce by weight) whose `sub_unit_size` is the
  case size. But the prod mirror is 2026-05-02; if a manager added a genuine
  "tracked-in-bags-of-10, ordered-one-bag-at-a-time" row since, it would be in
  Population B and get flattened. **Mitigation already in the design:** the
  audit table records `old_*` for every B row, so the backout reverses any
  individual mis-call; and the owner reviews the C list anyway. **Owner
  decision point:** accept B as auto-safe, or additionally pre-review the B
  list before the UPDATE? The design auto-migrates B per the AC ("the migration
  mutates non-split rows automatically"); flagging in case the owner wants B
  surfaced for eyeballing too (would be a one-line change: split the migration
  into snapshot-then-manual-UPDATE).

- **R2 — `default_cost` vs. migrated `case_qty` interaction (IMPORTANT — read
  carefully).** Prod `default_cost` was computed as
  `default_case_price / case_qty` *with the OLD case_qty*. For a Population B
  row like `1/8 Brown Paper Bag` (`case_qty=1`, `default_case_price=50`,
  `default_cost=50.00`), `50/1 = 50` was the stored per-"each" cost — but with
  `case_qty` now = 500, the Q3(a) formula `case_price/case_qty` would yield
  `50/500 = 0.10`. **The spec explicitly scopes `default_cost` value migration
  OUT** ("Changing the `default_cost` *values* already in prod" — out of
  scope), on the stated rationale that a price recompute is its own migration.
  So after the backfill, `catalog_ingredients.default_cost` for migrated B rows
  will be **internally inconsistent** with `default_case_price / case_qty`.
  Whether that matters depends on who reads `default_cost`: the per-store
  `inventory_items.cost_per_unit` is the value the app actually uses
  ([db.ts:3711](../src/lib/db.ts) prefers it), and the db.ts:3710 *fallback*
  only fires when that is absent. **I am honoring the spec's out-of-scope
  boundary and NOT recomputing `default_cost`** — but this is the single most
  likely "why is the cost wrong now?" surprise post-deploy, so it is called out
  here in writing for the owner. If the owner wants the catalog-level
  `default_cost` re-derived for migrated B rows, that is a one-line addition to
  step 4 (`default_cost = default_case_price / sub_unit_size` using the OLD
  divisor) — but it is a data-value change the spec deliberately deferred, so I
  am NOT putting it in the design without an explicit owner yes.

- **R3 — Migration ordering.** The new file
  `20260602120000_spec093_case_qty_backfill.sql` sorts strictly after every
  existing migration including `20260602000000_reorder_suggested_cases.sql`.
  It depends only on `catalog_ingredients` existing (P1, 2026-05-04) — satisfied.
  No ordering hazard. The `db-migrations-applied.yml` drift gate
  ([CLAUDE.md CI workflow](../CLAUDE.md)) will require the owner to actually run
  `supabase db push` so prod's `schema_migrations` gains this entry, else the
  next CI run hard-fails on missing-in-prod. **This is the intended posture**
  (owner runs the explicit push) — flag it so the push is not forgotten and the
  gate is not surprised.

- **R4 — `calcCasePrice` left asymmetric.** Per §8, `calcCasePrice` keeps its
  `× subUnitSize` factor while `calcUnitCost` drops it. If any code round-trips
  cost→price→cost they will now disagree on `sub_unit_size > 1` rows. The spec
  names only `calcUnitCost`; I scoped `calcCasePrice` out. Surfaced for the
  reviewers / owner — cheap to align if desired, but it is a scope expansion.

- **R5 — Performance on the 286 KB seed / prod.** Negligible. The backfill is a
  single UPDATE over `catalog_ingredients` (143 rows in seed; low hundreds in
  prod). No index needed; the unique index on `(brand_id, lower(name))` is
  untouched. No edge-function cold-start concern (no edge function involved).

- **R6 — Existing-behavior regressions (specs 045/046/052/054).** The form fix
  touches the same UNITS & PACK block those specs hardened (custom-unit input,
  abstract-unit warning, default-unit help, custom-unit-help-persists-under-
  error). The re-bind/relabel must preserve: the `CustomUnitInput` swap for
  pack/default units ([IngredientForm.tsx:657-776](../src/components/cmd/IngredientForm.tsx)),
  the `abstractUnitWarning` block ([IngredientForm.tsx:802-808](../src/components/cmd/IngredientForm.tsx)),
  and the empty-`subUnitUnit` → `pack(s)` placeholder semantics
  ([IngredientForm.tsx:788](../src/components/cmd/IngredientForm.tsx)) — though
  the readback rewrite changes what's rendered, the placeholder logic for the
  pack-unit *select* stays. AC requires those specs' tests stay green; the dev
  must run them.

### 11. Test plan (three tracks — maps to the spec's Tests section)

- **Track-1 (jest):**
  - `calcUnitCost(20.00, 20, anything) === 1.00` and a `sub_unit_size`-varies-
    nothing pin (e.g. `calcUnitCost(20, 20, 5) === 1.00`) — Q3(a).
  - Readback string: render the form with DEFAULT UNIT=`cases`, case size=`20`,
    PACK UNIT=`lbs`; assert the readback **contains** `1 case = 20 lbs` and
    **does not contain** `20 cases per order` — owner's literal complaint.
  - Independent-axes write: drive `toUpdates()` (or the form's onChange chain)
    for "case size 20, sub-unit 10" and assert the resulting partial has
    `caseQty === 20` AND `subUnitSize === 10` (neither conflated) — Q1(a). This
    is a pure-function test on `toUpdates` /
    [IngredientFormDrawer.tsx:66-84](../src/components/cmd/IngredientFormDrawer.tsx),
    no DB.
  - Label/help snapshot: assert the case-size field and sub-unit field carry
    distinct labels and the sub-unit/pack help text describes "per tracking
    unit," not shipping-wrapper-only — Q5.
  - EOD round-trip: against the EODCount calc
    ([EODCount.test.tsx](../src/screens/staff/screens/EODCount.test.tsx) harness),
    feed an item with `caseQty=20` and assert `total = cases × 20 + units` —
    Q4(b). No EOD code change.
  - Regression: the existing 045/046/052/054 form tests must stay green (R6).
- **Track-2 (pgTAP):**
  - **Backfill correctness** (new test, mirror the in-txn fixture +
    `set role` master-JWT pattern of
    [report_reorder_list_cases.test.sql](../supabase/tests/report_reorder_list_cases.test.sql)):
    insert fixtures for each population (B: `1/500`; C: `4/5`; A: `450/1`;
    D: `1/1`); run the backfill body inside the txn; assert (1) count of
    mis-encoded rows `where coalesce(case_qty,1)<=1 and
    coalesce(sub_unit_size,1)>1` **= 0** after; (2) the C fixture is
    **unchanged** in `catalog_ingredients` AND **present** in the audit table
    with `population='C'`; (3) the B fixture now has `case_qty=500,
    sub_unit_size=1`; (4) A and D fixtures untouched. Rollback discards the
    fixtures so the seed is clean.
  - **Reorder round-trip** for a fixed row: insert a catalog row with
    `case_qty=20` + an `inventory_items` row, call `report_reorder_list`, assert
    `suggested_cases = ceil(suggested_qty / 20)` — Q4(b). Extends the existing
    [report_reorder_list_cases.test.sql](../supabase/tests/report_reorder_list_cases.test.sql)
    rather than duplicating the harness.
- **Track-3 (shell smoke):** apply-order smoke — confirm
  `20260602120000_spec093_case_qty_backfill.sql` applies cleanly in sequence
  after a fresh reset (the `scripts/test-db.sh` / `npm run dev:db` path), and
  that the audit table exists post-apply. Mirrors the spec's apply-order smoke
  note.

### 12. Build split (who does what)

- **Backend slice** (`backend-developer`): the migration
  `20260602120000_spec093_case_qty_backfill.sql` (audit table + B-UPDATE +
  C-flag + documented backout); the `calcUnitCost` divisor change
  ([unitConversion.ts:278](../src/utils/unitConversion.ts)); the db.ts:3710
  fallback cost change; the Track-2 pgTAP tests; the Track-3 shell smoke.
- **Frontend slice** (`frontend-developer`): the form re-bind + relabel
  ([IngredientForm.tsx:711-712](../src/components/cmd/IngredientForm.tsx)); the
  readback rewrite ([IngredientForm.tsx:778-801](../src/components/cmd/IngredientForm.tsx));
  help-string reconciliation ([IngredientForm.tsx:708,720,774](../src/components/cmd/IngredientForm.tsx));
  the `IngredientFormValues.subUnitSize` doc-comment fix; the Track-1 jest tests
  (readback, label/help snapshot, independent-axes, EOD round-trip,
  `calcUnitCost` pin can live with either slice but reads naturally with FE
  since it pins UI-driven cost).

The two slices are independent except for the shared semantic contract: FE
keeps the form keys `caseQty`/`subUnitSize` and the db.ts mapping unchanged, so
backend and frontend can land in parallel.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the §Backend design in this spec. Backend slice —
  author migration supabase/migrations/20260602120000_spec093_case_qty_backfill.sql
  (audit table + Population-B UPDATE + Population-C hand-review flag + documented
  backout block; predicates in §1a), change the calcUnitCost divisor
  (unitConversion.ts:278) and the db.ts:3710 fallback to divide by case_qty
  alone, and add the Track-2 pgTAP backfill-correctness + reorder round-trip
  tests and the Track-3 apply-order smoke. DO NOT recompute default_cost values
  (R2 — out of scope) and DO NOT mutate Population-C rows. Frontend slice —
  re-bind the UNITS & PACK inputs so the case-size field feeds caseQty (→case_qty)
  and the sub-unit field feeds subUnitSize (→sub_unit_size), keeping the form
  keys and db.ts mapping unchanged; rewrite the grey readback to a plain
  conversion (must contain "1 case = 20 lbs", must NOT contain "20 cases per
  order"); reconcile the case-size/sub-unit labels and the PACK-UNIT help per §9;
  add the Track-1 jest tests. Both — keep specs 045/046/052/054 form tests green
  (R6). After implementation set Status: READY_FOR_REVIEW and list files changed
  under ## Files changed.
payload_paths:
  - specs/093/spec.md

## Files changed — backend (spec 093)

> Backend slice implemented by `backend-developer`. `Status:` intentionally left
> `READY_FOR_BUILD` — the frontend dev flips it to `READY_FOR_REVIEW` after its
> slice lands (sequential, to avoid a spec-file race). Frontend slice (form
> re-bind/relabel, readback rewrite, Track-1 form jest) is NOT yet done.

**Migrations**
- `supabase/migrations/20260602120000_spec093_case_qty_backfill.sql` — new.
  Audit table `public.spec093_case_qty_backfill_audit` (idempotent
  `create table if not exists`, RLS-enabled, `revoke all` from
  anon/authenticated, not in any publication); snapshot Population B (pop `'B'`,
  `new_* = (sub_unit_size, 1)`) and Population C (pop `'C'`, `new_* = NULL`) with
  `on conflict (catalog_id) do nothing`; `RAISE NOTICE` of the Population-C count;
  UPDATE Population B only (`case_qty = sub_unit_size, sub_unit_size = 1,
  updated_at = now()`); commented `-- BACKOUT` block at the foot. `default_cost`
  NOT recomputed (R2). Population C NOT mutated.

**src/utils/unitConversion.ts**
- `calcUnitCost` (Q3a) — divisor changed from `caseQty * subUnitSize` to
  `caseQty` alone; 3-arg signature kept (third param annotated unused via
  `void`). `calcCasePrice` left unchanged (R4 — out of scope).

**src/lib/db.ts**
- `mapItem` fallback cost (`costPerUnit` IIFE, ~line 3710, Q3a) — changed from
  `cp / (caseQty * subUnitSize)` to `caseQty > 0 && cp > 0 ? cp / caseQty : 0`.
  Write mapping at db.ts:278-280 left exactly as-is (§0 — already correct).

**Tests — Track-2 pgTAP**
- `supabase/tests/spec093_case_qty_backfill.test.sql` — new. 8 assertions:
  backfill correctness across one fixture per population (B 1/500 → 500/1; C 4/5
  unchanged + flagged pop `'C'`; A 450/1 untouched; D 1/1 untouched; no
  mis-encoded rows remain; B recorded in audit with old 1/500 snapshot) + reorder
  round-trip (`case_qty=20`, par 50 → `suggested_cases = ceil(50/20) = 3`).

**Tests — Track-3 shell smoke**
- `scripts/smoke-migrate-spec093.sh` — new (executable). Apply-order smoke:
  migration applies cleanly against the live container, audit table exists with
  back-office posture (RLS on, no anon/authenticated grant), 0 mis-encoded rows
  remain, and re-apply is a data no-op.

**Tests — Track-1 jest**
- `src/components/cmd/IngredientForm.test.ts` — added a
  `calcUnitCost (spec 093 Q3a)` describe block (pins
  `calcUnitCost(20.00, 20, anything) === 1.00`, `calcUnitCost(20, 20, 5) ===
  1.00`, `case_price / case_qty` regardless of sub_unit_size, and the
  non-positive-`case_qty` guard). The form-side jest (readback, label/help,
  independent-axes, EOD round-trip) is the frontend dev's lane.

### Local verification (stack up)
- `npx tsc --noEmit` — clean.
- `npx jest` — 56 suites / 568 tests pass (incl. the 4 new `calcUnitCost` pins;
  EODCount + 045/046/052/054 form tests green — no regression).
- `npm run test:db` — 43/43 DB test files pass (new spec093 test 8/8; reorder
  cases 12/12; permissive-policy lint 4/4 — new audit table does not trip it).
- `bash scripts/smoke-migrate-spec093.sh` — all checks pass against the seeded
  local DB (52 Population-B rows fixed → 0 mis-encoded; 42 Population-C rows
  flagged; idempotent re-apply).
- `npx supabase db reset` — migration applies cleanly in-sequence after
  `20260602000000_reorder_suggested_cases.sql`; present in the local ledger.

### Operational note for the owner (surfaced, not a blocker)
On a local `supabase db reset`, migrations run BEFORE `seed.sql` loads, so the
backfill sees an empty catalog and touches 0 rows (RAISE NOTICE reads `0 split
rows`); the seed then re-inserts the prod-shaped mis-encodings. On **prod**, the
owner's `supabase db push` runs the migration against the already-populated
`catalog_ingredients`, so it DOES fix the live rows (52 B-rows + 42 C-flags in
the current seed mirror). The Track-3 smoke is the tool that exercises the
migration against seeded/prod-shaped data locally. The migration is correct;
this is purely the reset migrations-then-seed ordering artifact.

## Files changed — frontend (spec 093)

> Frontend slice implemented by `frontend-developer` (second/last slice). This
> flips `Status:` to `READY_FOR_REVIEW`. The §0 framing held: the defect was
> the form re-bind/relabel, NOT a db.ts mapping change — db.ts:278-280 and the
> form keys (`caseQty`/`subUnitSize`) are untouched.

**src/components/cmd/IngredientForm.tsx**
- **Doc comment (`IngredientFormValues.subUnitSize`, ~line 35)** — rewrote the
  bug-encoding `"default unit size (e.g. 40 lbs per case)"` to the
  sub-units-per-tracking-unit meaning; also clarified `subUnitUnit`'s comment.
- **Case-size input (~line 718)** — relabeled `packs / order` → `units / case`,
  help reworded to "how many tracking units come in one case (e.g. 20 lbs per
  case)". Still binds the canonical form key `caseQty` (→ `case_qty`). This is
  now the input a manager reaches for to type the case size, feeding the column
  reorder (088) and EOD (086) read.
- **Sub-unit input (~line 724)** — relabeled `units / pack` → `sub-unit / unit`,
  help reworded to "how many sub-units make up ONE tracking unit (e.g. a bag of
  10 each)". Still binds `subUnitSize` (→ `sub_unit_size`) — the separate
  recipe-costing axis, never conflated with the case size.
- **PACK UNIT help (both CustomUnitInput + SelectField branches, ~lines
  732/786)** — reworded the `"the shipping wrapper — case, box, tray"` copy
  (which contradicted `unitConversion`'s "sub-unit = per tracking unit") to
  "the unit each sub-unit is measured in — each, lb, oz"; kept the "define
  abstract units on the Conversions tab" sentence (§9).
- **Grey readback (~lines 790-810)** — rewrote the inverted
  `= {caseQty} {packLabel} × {subUnitSize} {unit} = {total} {unit} per order`
  to a plain `1 case = {caseQty} {contentsUnit}` driven off the case-size value;
  `contentsUnit = subUnitUnit || unit`. Deleted the `× … per order` arithmetic.
  Kept the finite/positive guard (renders nothing for empty/zero case size).
- R6 preserved: the `CustomUnitInput` "+ custom…" swap, the
  `abstractUnitWarning` block, and the pack-unit SelectField placeholder are
  unchanged.

**src/components/cmd/IngredientForm.help-text.test.tsx**
- Updated the `PACK_UNIT_HELP` expected constant to the spec 093 §9 copy (a
  legitimate test update — §9 rewrites that string). Behavioral assertions
  (help persists under error; renders in both SelectField + CustomUnitInput
  branches) preserved; added a header note documenting the spec-093 copy change.

**src/components/cmd/IngredientForm.spec093.test.tsx** — new (Track-1 jest, 9
tests across 3 describes):
- Readback: render DEFAULT UNIT=`cases` / case size=`20` / PACK UNIT=`lbs`,
  assert the readback **contains** `1 case = 20 lbs` and **does NOT contain**
  `20 cases per order` (nor `per order` / `×`); `subUnitUnit`-empty fallback
  (`1 case = 450 each`); empty-case-size guard renders nothing.
- Label/help: case-size vs. sub-unit fields carry distinct labels (and the old
  `units / pack` / `packs / order` labels are gone); sub-unit help is
  per-tracking-unit; PACK UNIT help no longer says "shipping wrapper".
- Independent-axes: drive the two numeric inputs' onChange for "case size 20,
  sub-unit 10" and assert the accumulated form state has `caseQty === '20'` AND
  `subUnitSize === '10'` (neither conflated).

**src/screens/staff/screens/EODCount.test.tsx**
- Added one EOD round-trip test against the existing harness: an item with
  `case_qty=20` computes `total = cases × 20 + units` (3 × 20 + 4 = 64). No EOD
  code change — pins the consumer against the spec-093 fixed-row shape.

### Local verification (frontend slice)
- `npx tsc --noEmit` — clean.
- `npx jest` — 57 suites / 578 tests pass (was 56/568 pre-frontend; +10 new
  tests: 9 in `IngredientForm.spec093.test.tsx` + 1 EOD round-trip). The
  spec 045/046/052/054 form tests (incl. the updated `help-text` PACK_UNIT_HELP
  pin) stay green — no R6 regression. The backend dev's `calcUnitCost` pins in
  `IngredientForm.test.ts` are untouched and pass.
- In-browser verification is the dispatcher's step (this agent has no preview
  tools).
