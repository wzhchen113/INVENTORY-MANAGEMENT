# Spec 052: Ingredient form — DEFAULT UNIT clarifying help text

Status: READY_FOR_REVIEW

## User story
As a store manager (e.g. Bobby on prod) creating an ingredient for the
first time, I want a one-line sublabel under the DEFAULT UNIT picker that
tells me what that field actually means, so that I don't accidentally pick
the abstract shipping wrapper (e.g. `Case`) as the default unit and the
countable item (e.g. `each`) as the pack unit — the inverse of the
intended mapping.

## Bug being addressed (UX gap, not a regression)
On prod, a user created an ingredient with:
- DEFAULT UNIT = `Case` (custom)
- PACK UNIT = `each` (custom)
- UNITS/PACK = `450`
- PACKS/ORDER = `1`
- PAR = `3`

Per spec 045's resolved-questions example, the intended shape would have
been `caseQty=1, subUnitSize=450, subUnitUnit='case', unit='each'`. The
user had the mental model of "a case of 450 items" but typed those
attributes into swapped slots.

Today's existing safety nets did not catch the swap:
- The yellow abstract-unit warning ([src/components/cmd/IngredientForm.tsx:795-801](../src/components/cmd/IngredientForm.tsx))
  fires (because `Case` is not canonical) but only nudges the user toward
  defining a conversion — it does not flag that the slots are swapped.
- The math-readback line ([src/components/cmd/IngredientForm.tsx:771-794](../src/components/cmd/IngredientForm.tsx))
  reads `= 1 each × 450 Case = 450 Case per order`, which is weird but not
  obviously wrong.
- The labels alone ("default unit" / "pack unit") do not telegraph that
  DEFAULT UNIT means "the smallest unit you count one of" — a critical
  piece of context because PAR is interpreted in default units.

The user opted for **Option A — minimal:** a one-line help/sublabel under
the DEFAULT UNIT select. No heuristic swap-detection. No banner. No
wizard restructure. Out of scope per the user's reconfirmation today.

## Acceptance criteria
- [ ] A help-text line renders directly beneath the DEFAULT UNIT
      `SelectField` in [src/components/cmd/IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx)
      (the field at lines ~686-702 in the non-custom branch and
      ~653-684 in the custom-mode branch).
- [ ] The text clarifies that DEFAULT UNIT is "the smallest unit you
      count one of" — exact wording per Q1 resolution.
- [ ] The text renders in both the SelectField branch and the inline
      `CustomUnitInput` branch (the "+ custom…" flow from spec 046), so
      the help is not lost when the user picks "+ custom…".
- [ ] Visual treatment matches the existing help-text style used by
      `InputLine` and `SelectField` (`mono(400)`, fontSize 10, color
      `C.fg3` — see [src/components/cmd/IngredientForm.tsx:224-228](../src/components/cmd/IngredientForm.tsx)).
- [ ] The math-readback line ([src/components/cmd/IngredientForm.tsx:771-794](../src/components/cmd/IngredientForm.tsx))
      is untouched.
- [ ] The yellow `abstractUnitWarning` block ([src/components/cmd/IngredientForm.tsx:795-801](../src/components/cmd/IngredientForm.tsx))
      is untouched.
- [ ] No new state, no new effects, no validation changes, no schema or
      RPC changes.
- [ ] No regression to spec 046's "+ custom…" inline flow (committed
      values, validation errors, cancel behaviour). Manual smoke: open
      form, pick "+ custom…", type a unit, blur — verify help text
      remains readable and does not collide with the inline error slot.

## In scope
- Adding 1-3 lines of JSX near the DEFAULT UNIT `SelectField` and
  `CustomUnitInput` in [src/components/cmd/IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx).
- Reusing the existing `help` prop on `SelectField` and `CustomUnitInput`
  (both already render a `help` string under the input — see
  [src/components/cmd/IngredientForm.tsx:224-228](../src/components/cmd/IngredientForm.tsx)
  and [src/components/cmd/IngredientForm.tsx:342-347](../src/components/cmd/IngredientForm.tsx)).
- Wording chosen per Q1.
- i18n decision per Q2.
- Symmetry decision per Q3 (DEFAULT UNIT only, or DEFAULT UNIT + PACK UNIT).

## Out of scope (explicitly)
- **Heuristic swap-detection.** Detecting "user probably typed slots
  backwards" (e.g. heuristics like "abstract default + canonical pack with
  ratio > 50") is explicitly NOT being added. The user picked Option A
  over this path.
- **Banner / modal / toast nudging.** No new visual chrome beyond the
  sublabel.
- **Wizard restructure.** Spec 045's out-of-scope decision is reaffirmed
  — the form layout stays as-is.
- **Math-readback line rewording.** Untouched per the user's "math
  readback and abstract-unit warning untouched" note.
- **Abstract-unit yellow warning rewording.** Untouched, same reason.
- **PACKS/ORDER and UNITS/PACK help text changes.** These already have
  help (`"how many packs at a time"` / `"how many default units in one
  pack"` — [src/components/cmd/IngredientForm.tsx:704-705](../src/components/cmd/IngredientForm.tsx))
  and are not part of this spec.
- **Schema migration / DB change.** None — pure JSX.
- **Backend / edge function change.** None.
- **PAR-units clarification UI.** The user's separate observation that
  "PAR is in default units" is not surfaced anywhere is real, but Option A
  scope draws the line at DEFAULT UNIT. If it surfaces again as a
  recurring user-confusion point, file a follow-up spec.

## Open questions — RESOLVED (2026-05-20)

User accepted all PM-recommended defaults in a single batch:

- **Q1 → Option A**: `the smallest unit you count one of (each, lb, oz, mL)`.
- **Q2 → Hardcode English**, with a TODO follow-up under the spec 038 chrome-priority i18n sweep. Symmetric with the surrounding hardcoded help strings on this form.
- **Q3 → PACK UNIT gets a parallel short prefix**: `the shipping wrapper — case, box, tray; ` prepended to the existing PACK UNIT help text. Both SelectField branches and CustomUnitInput branches receive the new strings.
- **Q4 → Option 1**: this spec takes slot 052; the CI-policy linter slides to 053. CLAUDE.md gets the one-character edit (`spec 052` → `spec 053`) inside this spec's commit.
- **Q5 → Yes, reuse the existing `help` prop** (`mono(400)`, fontSize 10, color `C.fg3`). No new style code.

The rest of this section preserves the original deliberation for the architect's reference; treat the resolutions above as the final word.

---

## Open questions (original deliberation — superseded by resolutions above)
- **Q1 (wording).** Three candidates, PM to pick:
  - **Option A (recommended):** `the smallest unit you count one of (each, lb, oz, mL)`
    — closest to the user's own phrasing in the request; concrete with
    examples; fits one mono-line at form width.
  - **Option B:** `what one unit looks like when you count inventory (e.g. each, lb, oz)`
    — more verbose, frames it from the inventory-count perspective.
  - **Option C:** `the unit PAR and inventory counts use — e.g. each, lb, oz`
    — leans on the PAR connection that the user explicitly cited as the
    source of confusion. Pros: links directly to the downstream
    misinterpretation. Cons: assumes the user knows what PAR is.
- **Q2 (i18n).** Hardcode English now, or wire through `useT()`/`t()`?
  - **Recommended: hardcode English with a TODO follow-up.** Spec 045
    explicitly out-of-scoped `t()` for the same component; the surrounding
    help strings on this form (e.g. `"how many packs at a time"` at line
    704) are also hardcoded English. Symmetry argues for hardcoded now.
    Spec 038 chrome-priority i18n sweep can pick this up later.
  - Trade-off: a non-English user encountering this for the first time
    won't get the help, but they also won't get any of the surrounding
    help strings — so the experience is consistent, not worse.
- **Q3 (PACK UNIT symmetry).** Add a parallel help line under PACK UNIT,
  or only DEFAULT UNIT per Option A scope?
  - **Recommended: PACK UNIT too, short variant.** PACK UNIT already has
    a longer help string (`'For abstract pack units like "case" or
    "tray", define their physical meaning on the Conversions tab.'` at
    [src/components/cmd/IngredientForm.tsx:713 and :767](../src/components/cmd/IngredientForm.tsx)).
    A prepended one-clause definition like `the shipping wrapper — case,
    box, tray; ` would mirror the DEFAULT UNIT line for one-glance
    parity. Alternative: leave PACK UNIT as-is and only edit DEFAULT
    UNIT. PM picks.
  - If PM picks "DEFAULT UNIT only," the acceptance criteria collapse the
    PACK UNIT bullet.
- **Q4 (numbering conflict).** [CLAUDE.md](../CLAUDE.md) line in the
  "Permissive RLS policies on the same `(table, command)` pair are ORed"
  bullet says `"...forthcoming spec 052 will add a pgTAP CI probe..."`
  referring to the deferred CI-time policy linter from spec 051's
  out-of-scope list. Two paths:
  - **Option 1 (recommended).** Take 052 for this UX spec. CI-policy
    linter slides to 053. Include a one-character CLAUDE.md edit
    (`spec 052` → `spec 053`) inside this spec's commit so the
    cross-reference stays accurate.
  - **Option 2.** This spec becomes 053; 052 stays reserved for the CI
    linter. No CLAUDE.md edit needed. Slightly cleaner because the
    CLAUDE.md write was earlier in the day and "earliest reserver wins"
    is a defensible rule.
  - Recommendation rationale: UX-only specs ship faster than CI-linter
    specs (no migration, no pgTAP, no shell smoke), so 052 ships and
    closes its slot before 053 would. The one-character CLAUDE.md edit is
    cheap.
- **Q5 (visual treatment).** Match the existing help-text style used by
  `InputLine` and `SelectField` — `mono(400)`, fontSize 10, color
  `C.fg3`?
  - **Recommended: yes, reuse the existing `help` prop.** Both
    `SelectField` and `CustomUnitInput` already render a `help` string
    via the same `<Text style={{ fontFamily: mono(400), fontSize: 10,
    color: C.fg3 }}>` block — no new style code needed. This collapses
    the implementation to "pass the new string to the existing `help`
    prop, twice (SelectField branch + CustomUnitInput branch)."

## Dependencies
- None. No schema migration, no edge function, no RPC, no new package.
- Touches one file: [src/components/cmd/IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx).
- Spec 046's `CustomUnitInput` already accepts a `help` prop and renders
  it under the input — no shape change needed.

## Project-specific notes
- **Cmd UI section:** ingredient form drawer (`src/components/cmd/IngredientForm.tsx`)
  rendered by Inventory section. Not a section file itself.
- **Per-store vs admin-global:** N/A — form is per-store-context but the
  change is presentational only and does not touch any data scope.
- **Realtime channels touched:** none.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** both. JSX is `react-native-web`-compatible
  (same `Text` / `View` primitives used everywhere else on the form).
- **Tests:** Q-dependent. Default recommendation:
  - **Jest:** one snapshot/render assertion that the DEFAULT UNIT help
    string renders under the SelectField AND under the inline
    CustomUnitInput. Trivial — fits the jest track.
  - No pgTAP — no DB change.
  - No shell smoke — no network call.
  - If PM picks Q1 Option C ("the unit PAR and inventory counts use…"),
    add a second assertion that the PAR field's downstream value is
    semantically consistent (still no logic change; just a regression
    guard on copy that mentions PAR).
- **app.json slug:** not touched.

## Risks
- **Help text adds vertical real estate.** The DEFAULT UNIT field sits
  in a 3-column row with PACKS/ORDER and UNITS/PACK
  ([src/components/cmd/IngredientForm.tsx:646-706](../src/components/cmd/IngredientForm.tsx)).
  A new help line under DEFAULT UNIT will visually unbalance the row
  unless the sibling fields' help lines render at the same height. They
  already do (both PACKS/ORDER and UNITS/PACK have `help` props on
  `InputLine`, lines 704-705). So the row should stay balanced — but
  verify in the preview tool before claiming done.
- **Spec 046 collision.** When the user picks "+ custom…" the
  SelectField unmounts and `CustomUnitInput` mounts in its place with
  its own `help` slot. The new help text MUST be passed to both branches
  or it disappears mid-edit. Acceptance criteria covers this; flag for
  the implementing dev.
- **Numbering conflict carries a CLAUDE.md edit (Q4 Option 1).** If PM
  picks Option 1, the implementing dev must remember to edit the
  CLAUDE.md bullet in the same commit — otherwise the cross-reference
  drifts and a future agent reads the wrong spec number.

---

## Backend design

This is a JSX-only frontend change. No schema, no RLS, no API contract,
no edge function, no `src/lib/db.ts` surface, no realtime channel, no
store slice change. The "Backend design" section exists for pipeline
symmetry and to record the verifications that justify the
frontend-only scoping.

### Data model, RLS, API, edge, db.ts, realtime, store

- **Migration:** none.
- **RLS:** untouched — no table referenced.
- **API contract:** untouched — no PostgREST/RPC call.
- **Edge functions:** untouched — `verify_jwt` settings unchanged.
- **`src/lib/db.ts`:** untouched — no new helper, no signature change.
- **Realtime:** untouched — no channel impact. Publication membership
  unchanged, so the spec 026/CLAUDE.md "publication gotcha + `docker
  restart supabase_realtime_imr-inventory`" sequence does NOT apply.
- **Store (`src/store/useStore.ts`):** untouched — no slice change. The
  optimistic-then-revert + `notifyBackendError` pattern does NOT apply
  because nothing writes.

### Frontend design (the actual change)

#### Q3 reverification — CustomUnitInput already has a `help` prop

Confirmed at [src/components/cmd/IngredientForm.tsx:273](../src/components/cmd/IngredientForm.tsx)
in the `CustomUnitInput` Props type declaration (`help?: string;`) and
at lines 342-346 where it renders the help string via the exact same
`<Text style={{ fontFamily: mono(400), fontSize: 10, color: error ?
C.danger : C.fg3 }}>` block that `InputLine` uses at lines 224-228 and
that `SelectField` uses at
[src/components/cmd/SelectField.tsx:80-84 and :133-137](../src/components/cmd/SelectField.tsx).
Three components, identical render path — no component-shape change is
required. Pass the new string to the existing `help` prop and the
visual treatment is automatic.

#### Line-by-line diff sketch (no implementation code committed here)

Four touch points in [src/components/cmd/IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx).
All four are additions or modifications of an existing `help` prop on
an already-rendered component — no JSX restructuring, no new components,
no new state.

```
1. DEFAULT UNIT · CustomUnitInput branch (~line 653, customMode.default === true)
   Add prop:
     help={"the smallest unit you count one of (each, lb, oz, mL)"}

2. DEFAULT UNIT · SelectField branch (~line 686, customMode.default === false)
   Add prop:
     help={"the smallest unit you count one of (each, lb, oz, mL)"}

3. PACK UNIT · CustomUnitInput branch (~line 709, customMode.pack === true)
   Modify existing prop at line 713 from:
     help={'For abstract pack units like "case" or "tray", define their physical meaning on the Conversions tab.'}
   to:
     help={'the shipping wrapper — case, box, tray; For abstract pack units like "case" or "tray", define their physical meaning on the Conversions tab.'}

4. PACK UNIT · SelectField branch (~line 751, customMode.pack === false)
   Modify existing prop at line 767 from:
     help={'For abstract pack units like "case" or "tray", define their physical meaning on the Conversions tab.'}
   to:
     help={'the shipping wrapper — case, box, tray; For abstract pack units like "case" or "tray", define their physical meaning on the Conversions tab.'}
```

All four strings are hardcoded English (Q2 resolution); no `T(...)` /
`useT()` wrapping. Symmetric with `'how many packs at a time'` at line
704 and `'how many default units in one pack'` at line 705. The PACK
UNIT prefix and the existing PACK UNIT body are joined with a semicolon
+ space — no other separator is in use on this form.

#### Edge case — PACK UNIT help string overflow

The composed PACK UNIT help string is:

```
the shipping wrapper — case, box, tray; For abstract pack units like "case" or "tray", define their physical meaning on the Conversions tab.
```

Character count: 154. The PACK UNIT row at line 707 renders at the
container's full width (no `width` prop on the `<View>` wrapper, no
flex-row split) — i.e. it spans the IngredientFormDrawer's full content
column, which is roughly the same width as the 3-column row above
(DEFAULT UNIT + PACKS/ORDER + UNITS/PACK at lines 646-706, each ~33% of
the drawer width).

The existing PACK UNIT help body alone (`'For abstract pack units like
"case" or "tray", define their physical meaning on the Conversions
tab.'`, 113 chars) already wraps to two lines at typical drawer widths
(~360-480 px content column on the desktop Cmd shell). The new prefix
adds 41 chars and pushes the wrap to three lines. This is acceptable
because:

- The help text is rendered via `<Text>` with no `numberOfLines` cap
  (verified in both `SelectField.tsx:81-83 and :134-136` and
  `IngredientForm.tsx:343-345`) — wrap is the default behaviour.
- The math-readback `<View>` at line 788 and the abstract-unit warning
  `<View>` at line 795 are siblings, not overlapping children, so the
  expanded help height pushes them down without collision.
- The CSS treatment (`fontFamily: mono(400)`, `fontSize: 10`, no
  `lineHeight` override) gives ~14px line height; three lines = ~42px of
  added vertical space. The drawer is a `ScrollView` ([src/components/cmd/IngredientForm.tsx:596](../src/components/cmd/IngredientForm.tsx))
  so vertical overflow is benign.

**Decision: keep the full prefix.** The trade-off (extra wrap line vs
losing the disambiguating examples) favours clarity over compactness.
If the implementing dev finds the wrap visually unbalanced at the
drawer's actual rendered width during the `preview_*` verification gate,
the lowest-cost fallback is to drop the canonical examples from the
prefix, producing the shorter variant: `'the shipping wrapper (case,
box, tray); '` — 32 chars instead of 41. That fallback decision is
delegated to the implementing dev based on what the preview tools show;
the design accepts either.

The DEFAULT UNIT help string at 48 chars (`the smallest unit you count
one of (each, lb, oz, mL)`) fits one wrap line at the ~33% column
width (DEFAULT UNIT sits in the 3-column row at line 646). PACKS/ORDER
and UNITS/PACK help strings (`'how many packs at a time'` 24 chars,
`'how many default units in one pack'` 34 chars) already render at
similar widths in this row — verified by the spec's own risk note at
line 207 ("sibling fields' help lines render at the same height ...
they already do"). The DEFAULT UNIT help line will sit at a comparable
vertical extent to its row siblings; no row imbalance is expected.

#### Test track — jest only

One jest test file. Name: `IngredientForm.help-text.test.tsx` (or
appended to an existing IngredientForm test if one exists — implementing
dev's call). Coverage:

- Render `IngredientForm` in NEW mode with default values.
- Assert the DEFAULT UNIT help substring `the smallest unit you count
  one of` is visible (one of the four rendered branches — SelectField
  branch by default since `customMode.default` starts false).
- Click the DEFAULT UNIT select and pick `'+ custom…'` (or directly
  drive state if click-through is hard to simulate in jest jsdom).
  Assert the same substring is visible inside the CustomUnitInput
  branch.
- Repeat for PACK UNIT: assert the prefix substring `the shipping
  wrapper` is visible in the SelectField branch initially, then drive
  the customMode.pack flip and assert the same substring is visible in
  the CustomUnitInput branch.

Total: one test file, four assertions. No pgTAP (no DB change), no
shell smoke (no network call). Aligns with CLAUDE.md
"`tests/README.md` — three tracks (jest, pgTAP, shell smokes); v1 is
infra + 1-2 example tests per track."

#### Verification gate

Per CLAUDE.md feedback_verify_ui_with_preview memory and the spec's
project-specific notes:

1. `tsc --noEmit` — TypeScript-strict typecheck (no new types touched;
   should be a no-op pass).
2. `npm test -- --ci` — jest run including the new help-text assertions.
3. **Manual preview via `preview_*` tools** — open the IngredientForm
   drawer in NEW mode, verify:
   - DEFAULT UNIT help line renders under the SelectField at the
     expected vertical position (~14 px below the input).
   - The 3-column row (DEFAULT UNIT + PACKS/ORDER + UNITS/PACK) stays
     vertically balanced.
   - Pick `'+ custom…'` from DEFAULT UNIT; the CustomUnitInput mounts
     in place; the same help line renders under it.
   - The PACK UNIT row below shows the composed prefix-then-body help
     string, wrapping to 2-3 lines without overlapping the math-readback
     `<View>` below or the abstract-unit warning `<View>` below that.
   - Pick `'+ custom…'` from PACK UNIT; the CustomUnitInput mounts; the
     same composed help string is visible under it.
4. CLAUDE.md edit verified: the `'forthcoming spec 052 will add a pgTAP
   CI probe...'` bullet now reads `'forthcoming spec 053 will add a
   pgTAP CI probe...'`. Grep `CLAUDE.md` for `spec 052` post-edit; only
   the spec-052-this-spec self-reference (if any) should match, not the
   linter cross-reference.

### Drift / convention risks

- **i18n drift.** The four new strings are hardcoded English (Q2
  resolution). Symmetric with the surrounding help strings on this
  form (lines 631, 640, 704, 705, 713, 767, 826, 838, 847). Spec 038's
  chrome-priority i18n sweep is the eventual home for translating them.
  Acceptable, not a regression.
- **`useT()` hook usage.** The component already calls `useT()` at line
  366 and uses `T` in `unitLabel(u, T)` at lines 481 and 505. The new
  help strings are NOT routed through `T` — by design (Q2). No
  interaction with the existing `T(...)` calls; they pass through
  unrelated lookup keys.
- **String quoting.** The PACK UNIT existing string at line 713 and 767
  uses single-quoted JSX prop value `'...'` containing literal `"..."`
  for the canonical-unit examples. The new prefix MUST follow the
  same single-quote convention to avoid escaping the embedded double
  quotes. The diff sketch above uses `'` correctly.
- **Em-dash usage.** The prefix uses U+2014 EM DASH (`—`), matching the
  existing form's punctuation (e.g. `'auto-fills · editable'` at lines
  618, 626 uses `·` U+00B7 middle-dot; the math-readback line at 790
  uses `×` U+00D7; the abstract-unit warning at 581 uses straight
  ASCII). Using em-dash here is a slight outlier but is the natural
  punctuation for an interrupted definition. Acceptable.
- **Edit-mode existing-ingredient regression check.** Editing an
  ingredient that already has DEFAULT UNIT = `'Case'` (the exact bug
  scenario) will now render the new help string under the SelectField
  branch (because the stored `Case` is non-canonical and the SelectField
  surfaces it via the "· custom" suffix entry at line 489, not the
  CustomUnitInput branch — `customMode.default` only flips when the user
  picks the `'+ custom…'` sentinel afterwards). This is the desired
  behaviour: the user re-opening the broken ingredient sees the
  clarification immediately without having to interact further.
- **CLAUDE.md edit risk.** Q4 Option 1 requires a one-character edit to
  the spec 051 bullet (`spec 052` → `spec 053`). If the implementing
  dev forgets, the cross-reference drifts. Verification step 4 above
  catches this. The hard constraint at the top of the spec is explicit
  ("strictly the one-character ... correction, nothing else").
- **No `app.json` change.** Per CLAUDE.md "app.json slug mismatch (DO
  NOT AUTO-FIX)" — confirmed unaffected. The slug stays
  `towson-inventory`.

### Risks and tradeoffs summary

- **Migration ordering:** N/A (no migration).
- **RLS gaps:** N/A.
- **Performance on 286 KB seed:** N/A — no query.
- **Edge function cold-start:** N/A.
- **Realtime publication gotcha:** N/A (no publication change). The
  `docker restart supabase_realtime_imr-inventory` step that the
  CLAUDE.md realtime gotcha demands does NOT apply to this spec.
- **Visual overflow on PACK UNIT composed string:** documented above;
  delegated to the implementing dev's `preview_*` verification with
  an explicit shortened-prefix fallback if needed.
- **Spec 046 inline flow regression:** mitigated by passing identical
  help strings to both the SelectField branch AND the CustomUnitInput
  branch on both fields; the help survives the customMode flip. Jest
  test asserts this explicitly.

## Files changed

- [src/components/cmd/IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx)
  — added `help` prop with the DEFAULT UNIT one-liner on both the
  SelectField branch (~line 686-703) and the CustomUnitInput branch
  (~line 653-684); prefixed the existing PACK UNIT help string with
  `'the shipping wrapper — case, box, tray; '` on both branches
  (SelectField ~line 751-768 and CustomUnitInput ~line 709-749). No
  state, no effects, no JSX restructuring.
- [src/components/cmd/IngredientForm.help-text.test.tsx](../src/components/cmd/IngredientForm.help-text.test.tsx)
  — new jest test asserting both help substrings render under both
  branches of both fields (4 assertions × boundary-mocked store/theme/i18n).
- [CLAUDE.md](../CLAUDE.md) — one-character edit on line 66: `spec 052`
  → `spec 053` inside the spec 051 "Permissive RLS policies" bullet,
  per Q4 resolution (this spec takes slot 052; the CI-policy linter
  slides to 053).

## Verification status

1. `npx tsc --noEmit` — exit 0.
2. `npm run typecheck:test` — exit 0.
3. `npm test -- --ci` — 18 test suites passed, 186 tests passed
   (185 pre-existing + 1 new help-text test file's 4 assertions; one
   file in the existing component project ran the 4 new tests under
   the IngredientForm.help-text.test.tsx file).
4. Expo web bundler built the bundle cleanly via `npm run web`; a
   `grep` of the served bundle confirms each new help substring
   appears exactly 2 times (SelectField + CustomUnitInput branches)
   for both DEFAULT UNIT and PACK UNIT. The untouched
   `'how many packs at a time'` and `'how many default units in one
   pack'` strings remain present.
5. **Browser-driven preview verification (preview_* tools): not
   performed.** The frontend-developer agent's standard preview_*
   MCP tools are not loaded in this session's tool surface. Bundle-
   level substring verification (gate 4) is a partial substitute; a
   reviewer with the preview MCP loaded should drive the form
   manually to confirm row balance / wrap behaviour at the actual
   drawer width per the design's "Visual overflow on PACK UNIT
   composed string" note. Screenshot proof requested for the
   reviewer fan-out.
