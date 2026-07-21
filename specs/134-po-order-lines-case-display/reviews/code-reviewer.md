# Code review for spec 134

Scope reviewed: `src/utils/poCaseDisplay.ts`, `src/utils/poCaseDisplay.test.ts`,
the `POsSection.tsx` ORDERED/UNIT $ cell wiring + `poResolveEdit` guard swap,
and the `section.purchaseOrders.*` i18n additions in `en.json`/`es.json`/
`zh-CN.json`. The concurrent spec-135 `section.reorder` hunk was left
unexamined per instructions.

## Critical

None. The one real correctness risk called out in the spec (§3, the AC-2/AC-5
guard tension) is handled correctly:

- `poResolveEdit` (`src/utils/poCaseDisplay.ts:82-99`) makes the display-string
  comparison (`trimmed === poOrderedDisplay(orderedQty, caseQty)`) the PRIMARY
  guard before ever computing `poCasesToBase`, exactly as designed. I traced
  the `caseQty=6, orderedQty=85` fractional-focus-blur path by hand: seed
  `"14.17"` → untouched text `"14.17"` → string match → `{write:false, base:
  85}`. No `85 → 84` corruption. The jest pin at
  `src/utils/poCaseDisplay.test.ts:60-62` exercises this exact case.
- AC-4 invariant verified: `POsSection.tsx:123` (subtotal) and `:660-661`
  (LINE $) both still compute `li.orderedQty * li.costPerUnit` — neither was
  touched, and the case-display helpers are not consulted anywhere in that
  computation. Confirmed the identity holds for both whole-case and
  fractional lines via the jest pins at `poCaseDisplay.test.ts:109-125`.
- `caseQty <= 1` passthrough is byte-identical to pre-spec behavior:
  `isCaseRow` gates every branch (`POsSection.tsx:615,627,636,640,654`), and
  for a unit row `poCasesToBase`/`poCasePrice`/`poOrderedToCases` are all
  identity functions, so nothing changes for those rows.
- Fixed column widths are respected — no header/caption widths changed
  (`:582-585` unchanged), and the new sub-caption `<Text>` nodes are nested
  inside the existing `width: 100` / `width: 80` wrapper `<View>`s
  (`:612`, `:634`, `:650`), not new columns.
- No `supabase.from`/`rpc` calls added, no store slice changes (confirmed
  `updatePoLineQty` at `useStore.ts:2707-2724` is untouched and still follows
  optimistic-then-revert + `notifyBackendError`), no inline color literals (new
  sub-captions use `C.fg3`), no `window.confirm`/`Alert.alert`, no web-only
  APIs, and the i18n additions land identically-keyed across all three
  catalogs (`en.json:687-689`, `es.json:687-689`, `zh-CN.json:687-689`).

## Should-fix

- `src/utils/poCaseDisplay.ts:89` / `POsSection.tsx:618-619` — the
  empty-field-writes-0 behavior the implementer flagged in the spec's
  Implementation notes is real and reachable in production, not just a test
  gap. `Number('')` is `0` (finite, non-negative), so clearing the ORDERED
  input and blurring resolves to `poResolveEdit('', orderedQty, caseQty)` →
  `base = poCasesToBase(0, caseQty) = 0` (or `Math.round(0)*caseQty = 0` for a
  case row) → since `0 !== orderedQty` for any nonzero line, this **writes**
  `ordered_qty = 0` to a real draft line with no confirmation. I confirmed
  this is pre-existing (the pre-spec guard `n === li.orderedQty` had the same
  hole via `Number(raw)`), so it is not a regression introduced by this spec
  and correctly out of scope to fix here — but it is a live footgun on the
  exact surface this spec just made more prominent (an operator now blanks a
  field expecting to retype a *case* count, a slower/more deliberate edit than
  a raw unit number). Recommend opening a follow-up spec/ticket for an
  explicit empty-string guard (`if (trimmed === '') return { write: false,
  base: orderedQty }`) rather than leaving it silently inherited.

## Nits

- `POsSection.tsx:615,627,636,640,654` — `isCaseRow(li.caseQty)` is
  recomputed 5 times per row render (cheap, pure, but repetitive). Hoisting
  `const caseRow = isCaseRow(li.caseQty);` once above the JSX for the row
  would read more clearly and match the "compute once, branch on it" style
  used elsewhere in this file's `isDraft` ternaries.
- `POsSection.tsx:615` vs the `poResolveEdit` reference model — the unit-row
  (`caseQty <= 1`) `TextInput` still seeds `String(li.orderedQty)` (per
  design, unchanged), while `poResolveEdit`'s primary guard compares against
  `poOrderedDisplay(orderedQty, caseQty)`, which for a unit row is
  `formatQty(orderedQty)`. For an `orderedQty` with more than 2 decimal
  places (e.g. `12.345`), `String()` and `formatQty()` diverge as strings
  (`"12.345"` vs `"12.35"`), so the primary string guard would not catch an
  untouched line in that rare case — it still resolves correctly today only
  because the secondary base-diff guard is an exact identity for unit rows
  (`poCasesToBase` is a no-op there). Worth a one-line comment noting *why*
  the mismatch is safe for unit rows, so a future edit to `poCasesToBase`
  (e.g. adding unit-row rounding) doesn't silently reopen the 85→84-style
  hole this spec just closed for case rows.
- `POsSection.tsx:627-631` and `:640-644` — the `× {caseQty} / case`
  sub-caption `<Text>` block is duplicated verbatim between the draft
  (`TextInput`) and read-only (`Text`) branches. This mirrors the file's
  existing `isDraft ? ... : ...` duplication style elsewhere, so it's
  in-pattern rather than a new anti-pattern — flagging only as a minor,
  out-of-scope observation, not something to refactor in this PR.
- (out-of-scope) `src/screens/cmd/sections/__tests__/POsSection.test.tsx`
  fixtures (e.g. lines 317, 355, 372, 446-447, 499) omit `caseQty` entirely
  from their `PoLine` literals, so they exercise only the unit-row path
  (`isCaseRow(undefined) → false`) and never mount a `caseQty > 1` row. No
  component-level test in this file covers the new case-row rendering branch
  end-to-end (only the pure-helper suite does) — flagging for awareness, not
  as a finding to act on here since coverage is test-engineer's lane.
