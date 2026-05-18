# Spec 045: Ingredient form pack/unit clarity

Status: READY_FOR_REVIEW

## User story

As a store manager creating or editing an ingredient via the catalog
`+ NEW INGREDIENT` button, I want the "UNITS & PACK" section labels to read
unambiguously so that I don't have to guess which field means "how big is the
pack" vs. "how many packs at a time" — today the labels `pack size` and
`default unit size` invert what a first-time user expects.

## Acceptance criteria

- [ ] In `src/components/cmd/IngredientForm.tsx` the field currently labeled
      `pack size` reads `packs / order` and shows help text
      `how many packs at a time`. The underlying form field stays
      `caseQty` — no rename of the binding.
- [ ] The field currently labeled `default unit size` reads `units / pack`
      and shows help text `how many default units in one pack`. Underlying
      form field stays `subUnitSize`.
- [ ] A live math readback line renders directly below the four UNITS & PACK
      controls when `Number(caseQty) > 0 && Number(subUnitSize) > 0`. Shape:
      `= {caseQty} {pack-unit}(s) × {subUnitSize} {unit} = {total} {unit} per order`
      where `total = caseQty × subUnitSize` (numeric multiply). Hidden
      otherwise — no zero/empty rendering.
- [ ] The math line falls back gracefully when `subUnitUnit` is empty: omit
      the `(s)` suffix and just render `{caseQty} pack(s) × …`. Similarly,
      when `unit` is empty, render `= {total} per order` without a unit
      noun.
- [ ] The pack-unit pluralization uses an inline rule: append `s` unless the
      string already ends in `s` (case-insensitive). Known imperfection —
      see Open question 3.
- [ ] The math line is shown in BOTH `mode: 'new'` AND `mode: 'edit'`
      (matches every other input in this section — none of them mode-gate).
- [ ] `caseQty` / `subUnitSize` / `subUnitUnit` / `unit` semantics, save
      path, blank values, and validators are UNCHANGED. No
      `IngredientFormDrawer` change. No `useStore` change. No `db.ts`
      change.
- [ ] No DB migration. No edge function. No `app.json` change.
- [ ] `npm run typecheck` exits 0.
- [ ] Existing inventory items load and save without regression — values
      persisted by the prior labeling still round-trip identically.

## In scope

- Two label string edits and two help-string edits in
  `src/components/cmd/IngredientForm.tsx` (the `InputLine` calls at the
  current line ~414 / ~415).
- One new derived render block (the math readback) immediately under the
  existing `<View>` that holds the four UNITS & PACK controls.
- A tiny inline pluralization helper local to the component (no shared
  util).

## Out of scope (explicitly)

- Restructuring the form into a wizard — user explicitly said no.
- Translating these labels through `t()` — deferred per Spec 038's
  chrome-priority subset; surfaced to architect as Open question 1.
- Renaming DB columns `case_qty` / `sub_unit_size` — labels are UI-only.
- The pack-unit dropdown UI itself — working fine.
- Robust pluralization (irregular plurals like `box → boxes`,
  `tray → trays`, `case → cases`). English-only "good enough" rule
  documented in acceptance criteria.
- Plural handling for non-English pack-unit names.
- Any change to the `THRESHOLDS`, `EXPIRY`, `COSTING`, `VENDOR DEFAULT`,
  or `FLAGS` sections.
- The `default unit` (top-of-section) label, which already reads cleanly.
- The yellow `abstractUnitWarning` banner — unrelated, leave intact.

## Open questions resolved

- Q: Is this a data-model bug or a labeling bug? → A: Labeling only.
  `caseQty`, `subUnitSize`, `subUnitUnit`, `unit` semantics are correct;
  the user couldn't read them. The example `1 case of 40 each` maps to
  `caseQty=1, subUnitSize=40, subUnitUnit='case', unit='each'`.
- Q: Should we move the help-text placeholders (`e.g. 1 (case)` /
  `e.g. 40 (per case)`) too? → A: Yes, replace with the new help strings
  `how many packs at a time` and `how many default units in one pack`.
  The old placeholders were the source of the confusion.
- Q: Mode-gate the math line? → A: No. Show in both NEW and EDIT — it's
  read-only feedback and every other field in the section is mode-agnostic.
- Q: Render the math when only one of the two numeric fields is filled?
  → A: No. Both `> 0` required. Otherwise we'd show e.g.
  `= 1 case × 0 each = 0 each per order` which is noise.

## Open questions for the architect

1. Should the new labels (`packs / order`, `units / pack`) and help text
   route through `t()` since we're already touching them, or stay
   English-only per Spec 038's chrome-priority subset decision? Spec
   says deferred; flag so the architect can confirm.
2. Pluralization heuristic — current proposal appends `s` when the pack
   unit doesn't end in `s`. That mishandles `box → boxs`, plus future
   non-English pack-unit names. Accept "good enough" or specify a more
   complete rule?
3. Any chance the label rename breaks a jest snapshot or other automated
   coverage (no pgTAP / shell smoke risk — labels are UI-only)?
   Surfacing for completeness — architect to check before dispatching dev.

## Dependencies

- None new. The change is contained to
  `src/components/cmd/IngredientForm.tsx` (only).
- No new migration, no new edge function, no new store slice, no new
  hook, no theme change, no `app.json` change.

## Project-specific notes

- Cmd UI section / legacy: Cmd UI section — the form is rendered inside
  the catalog ingredient drawer surface under
  `src/screens/cmd/sections/`. No legacy AdminScreens path to consider
  (deleted in spec 025).
- Per-store or admin-global: N/A — this is a pure UI labeling change; no
  RLS surface touched and no data scoping decision involved.
- Realtime channels touched: None.
- Migrations needed: No.
- Edge functions touched: None.
- Web/native scope: Both — the component already renders cross-platform
  via React Native primitives. No web-only or native-only code paths in
  the proposed change.
- Tests track: jest (snapshot or render assertion if any exists for
  `IngredientForm`). No pgTAP, no shell smoke. Architect to confirm
  whether an existing snapshot needs regen.

## Backend / architecture design

UI-only polish. No data model, RLS, API, edge function, `db.ts`, realtime,
or `useStore` surface. The four spec constraints (`caseQty`,
`subUnitSize`, `subUnitUnit`, `unit` bindings unchanged; no migration;
no edge function; no store) hold — this design only resolves the four
open questions.

### Q1 — `t()` routing: DEFER (confirm default)
Keep English-only. Spec 038 explicitly scoped translation to chrome
(navigation, section headers, primary CTAs); `IngredientForm` body was
out of that subset. Adding four orphan keys (`packs / order`,
`units / pack`, and two help strings) to `en.json` + `es.json` without
finishing the broader form pass inflates the catalog with isolated
strings whose siblings (`default unit`, `pack unit`, `par`, `reorder pt`,
`max`, every THRESHOLDS / EXPIRY / COSTING / VENDOR DEFAULT label) are
still English. Defer to a future "IngredientForm i18n pass" spec.

### Q2 — Math line mode-gating: BOTH (matches spec acceptance criterion line 34)
Show in `mode: 'new'` AND `mode: 'edit'`. Rationale already captured in
the spec's resolved questions — every other field in the section is
mode-agnostic and editing users benefit from the readback when adjusting
pack math on existing items. The render gate stays the numeric guard
(`Number(caseQty) > 0 && Number(subUnitSize) > 0`), not `mode`.

### Q3 — Pluralization: simple suffix rule, accept "good enough"
Implement the rule from acceptance-criterion line 31 exactly: append `s`
unless the pack-unit string already ends in `s` (case-insensitive).
Inline helper local to the component, no shared util.

Rejected the slightly-smarter `s/x/z` variant. It would correctly emit
`boxes` for `box` but the actual seed-data pack units in
[supabase/seed.sql](supabase/seed.sql) are `case`, `tray`, `bag`,
`bottle`, `pack` — none hit the `x/z` edge. Adding the branch buys
cosmetic correctness for `box` while introducing a rule that's still
wrong for `tray → trays` (works), `dozen → dozens` (works), but breaks
on irregulars (`loaf → loaves`) the moment those appear. The spec
already accepts known imperfection; minimum rule is the honest choice.

Pack-unit dropdown values are user-typed strings on `catalog_brand_units`
so the helper must defensively handle empty string (already covered by
the acceptance criterion's fallback — render `pack(s)` literal when
`subUnitUnit` is empty).

### Q4 — Snapshot test risk: NONE
Confirmed via repo-wide `grep -n toMatchSnapshot`: zero matches across
`src/`, `tests/`, and `supabase/`. The jest harness from spec 022 / 033
uses behavioral assertions, not snapshots. No `IngredientForm` test file
exists. Safe to rename labels without regen.

### Risks / tradeoffs
- The math line introduces a new line of vertical chrome inside the
  drawer at densities where the form already pushes against the
  available height on smaller laptop viewports. Mitigated by the
  numeric-gate (line is hidden in the common just-opened state) and by
  keeping the readback to a single line of text.
- `Number(caseQty) > 0` swallows non-numeric inputs (e.g. `"abc"` →
  `NaN > 0` → false). That is the desired behavior — `caseQty` /
  `subUnitSize` are stored as strings in form state and pass through
  `numericOnly`-flagged `InputLine` controls; the multiply uses
  `Number()` coercion. No new validator.
- Future i18n: when the deferred `IngredientForm` translation pass
  lands, the math template `= {a} {unit}(s) × {b} {unit} = {total} {unit} per order`
  will need ICU pluralization, not the `s`-suffix rule. Call out in that
  future spec — not this one.

### Files touched
- `src/components/cmd/IngredientForm.tsx` (only). Two `InputLine`
  prop changes (label + help) at ~line 414 / ~415, one new
  derived-render `<View>` block below line 416, one inline
  `pluralize(unit: string): string` helper near the top of the
  component.

## Files changed

- `src/components/cmd/IngredientForm.tsx` — two `InputLine` prop pairs
  swapped (`pack size` → `packs / order`, `default unit size` →
  `units / pack`, with new help text); one new derived-render `<View>`
  inserted between the `pack unit` selector and the
  `abstractUnitWarning` block holding the live math readback gated on
  `Number(caseQty) > 0 && Number(subUnitSize) > 0`, with inline
  `s`-suffix pluralization for the pack-unit noun.
- `src/components/cmd/IngredientForm.tsx` — code-reviewer S1/S2/S3
  follow-up: (S1) `units / pack` help text now reads
  `"how many default units in one pack"` (parallel with the prior
  field's `"how many packs at a time"`); (S2) empty `subUnitUnit`
  branches to the literal `'pack(s)'` placeholder before pluralization
  instead of substituting `'pack'` and routing through the
  pluralization rule; (S3) the `endsWith('s')` suffix check is now
  case-insensitive (`.toLowerCase().endsWith('s')`) so values like
  `CASES` or `Bottles` are not double-suffixed.

## Implementation notes

- `npm run typecheck` → exit 0.
- `npm test` → 142/142 pass across 12 suites, 0 snapshots (matches
  architect Q4 confirmation: no snapshot tests on `IngredientForm`).
- Metro web bundle at `http://localhost:8081/...AppEntry.bundle...`
  rebuilt and contains all four new strings (`packs / order`,
  `units / pack`, `how many packs at a time`, `default units in one
  pack`) plus the math template literal. Visual browser screenshot
  not captured from this turn — `preview_*` MCP tools were not in the
  available tool list for the frontend-developer subagent's tool surface
  this run.

## Handoff

next_agent: code-reviewer
prompt: Review the implementation of spec 045. The change is contained
  to `src/components/cmd/IngredientForm.tsx` per the architect's design
  notes — two `InputLine` label/help pairs and one new derived-render
  math readback block, with inline `s`-suffix pluralization. No
  backend, no store, no `db.ts`, no i18n catalog touched. Write findings
  to `specs/045/reviews/code-reviewer.md`.
payload_paths:
  - specs/045-ingredient-form-pack-unit-clarity.md
  - src/components/cmd/IngredientForm.tsx
