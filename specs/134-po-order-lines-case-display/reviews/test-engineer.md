## Test report for spec 134

### Acceptance criteria status

- AC-1 (case rows show cases, unit rows unchanged) → PASS (code-verified) — display logic pinned by
  `src/utils/poCaseDisplay.test.ts::poOrderedDisplay` cases (`84,6→"14"`, `85,6→"14.17"`, `84,1→"84"`);
  wiring verified by reading `POsSection.tsx:634-646` (read-only cell: `isCaseRow` branch renders
  `poOrderedDisplay(...) + casesUnit`, else unchanged `{li.orderedQty} {li.unit}`). Live-render/visual
  confirmation (sub-caption placement, actual pixels) is **covered by main-session browser
  verification**, not blocking here.
- AC-2 (case rows edit in cases on a draft; write only on base-unit diff) → PASS —
  `poCaseDisplay.test.ts` "whole-case line" block (`poResolveEdit('13',84,6)→{write:true,base:78}`)
  and unit-row block (`poResolveEdit('12.5',10,1)→{write:true,base:12.5}`, `poResolveEdit('84',84,1)→
  {write:false}`). Wiring verified in `POsSection.tsx:611-626` — `onEndEditing` calls `poResolveEdit`
  and only writes when `write` is true, `defaultValue` seeds from `poOrderedDisplay` on case rows.
- AC-3 (case price in UNIT $ column, labelled) → PASS (code-verified) — `poCasePrice` pinned in
  `poCaseDisplay.test.ts` ("case price + LINE $ identity" block: `poCasePrice(2.5,6)===15`,
  `poCasePrice(2.5,1)===2.5`); wiring at `POsSection.tsx:650-659` renders
  `$${poCasePrice(li.costPerUnit, li.caseQty).toFixed(2)}` plus a `/cs` sub-caption
  (`section.purchaseOrders.casePriceSuffix`) only when `isCaseRow`. Visual label placement —
  **covered by main-session browser verification**.
- AC-4 (LINE $ / subtotal unchanged) → PASS — `POsSection.tsx:660-661` (LINE $) and `:692-693`
  (subtotal) are byte-identical to `git show HEAD` (`li.orderedQty * li.costPerUnit`, `subtotal`
  untouched); the math identity (`cases × casePrice === orderedQty × costPerUnit`, whole-case AND
  fractional) is pinned in `poCaseDisplay.test.ts::"case price + LINE $ identity"` (2 `toBeCloseTo`
  assertions).
- AC-5 (fractional cases display exact, never silently corrupt) → PASS — this is the load-bearing
  set and it is directly pinned: `poOrderedToCases(85,6)` → `toBeCloseTo(14.1666,3)` (exact, not
  rounded) and `poOrderedDisplay(85,6)==='14.17'`; the untouched-fractional-line no-write guard is
  pinned by `poResolveEdit('14.17',85,6)==={write:false,base:85}` (the exact 85→84 corruption
  scenario the design calls out); a retyped fractional edit is pinned by
  `poResolveEdit('14',85,6)==={write:true,base:84}`. Verified the primary guard is string-equality to
  the display seed (not a base-value diff) by reading `poCaseDisplay.ts:82-99` — matches the design's
  §3 correctness note precisely (base-only diff would have written 84 on an untouched line; the code
  checks `trimmed === poOrderedDisplay(...)` first).
- AC-6 (mixed table reads cleanly, columns stay aligned) → PASS (code-verified) — read
  `POsSection.tsx:580-696`: ORDERED (width 100), RECEIVED (width 90, untouched), UNIT $ (width 80),
  LINE $ (width 90) column widths and the subtotal spacer row (`:689-691`, three `View`s at width
  100/90/80) are unchanged from `git show HEAD`; new sub-captions live inside `View`s wrapping the
  existing fixed-width cells, not as new columns, so header/subtotal alignment is preserved
  structurally. Actual on-screen alignment with a live mixed-caseQty PO — **covered by main-session
  browser verification**.
- AC-7 (i18n ×3) → PASS — confirmed all three keys present in all three catalogs:
  `src/i18n/en.json:687-689` (`perCaseCaption: "× {count} / case"`, `casesUnit: "cs"`,
  `casePriceSuffix: "/cs"`), `src/i18n/es.json:687-689` (`"× {count} / caja"`, `"cj"`, `"/cj"`),
  `src/i18n/zh-CN.json:687-689` (`"× {count} / 箱"`, `"箱"`, `"/箱"`). No hardcoded English found at
  the new call sites (`POsSection.tsx:629,637,642,656` all route through `T(...)`). Column headers
  (`orderedCol`/`unitCol`) confirmed untouched, matching the design's explicit no-header-change
  decision.
- AC-8 (tests — jest) → PASS — `src/utils/poCaseDisplay.test.ts`, 17/17 passing (see Test run below).
  Verified the suite actually pins every case named in the AC text: `caseQty=6,orderedQty=84→14` +
  edit-13→78 ("whole-case line" describe block, 4 its); `caseQty=6,orderedQty=85→"14.17"` exact +
  untouched-no-write ("fractional-case line" describe block, 3 its); `caseQty=1`(and `0`) → units
  verbatim / no case treatment ("unit rows" describe block, 4 its); case price identity + LINE $
  identity ("case price + LINE $ identity" describe block, 3 its, including the fractional-display
  identity). Plus `isCaseRow` (1 it) and input-validation guard NaN/negative (2 its) = 17 total,
  matching the developer's stated count.

### Test run

```
npx tsc --noEmit                              → clean, no output, exit 0
npx tsc -p tsconfig.test.json --noEmit         → clean, no output, exit 0
npx jest                                       → Test Suites: 124 passed, 124 total
                                                  Tests:       1353 passed, 1353 total
                                                  Time:        4.7s
npx jest src/utils/poCaseDisplay.test.ts -v    → 17 passed, 17 total (all names listed, see below)
```

`poCaseDisplay.test.ts` verbose output (all 17 green):
- isCaseRow › is true only for caseQty > 1
- whole-case line (caseQty=6, orderedQty=84 → 14 cases) › displays 14 cases exact
- whole-case line › an edit to 13 cases writes 78 base units
- whole-case line › an untouched line (retyping the seed) issues NO write
- whole-case line › "14.0" retyped resolves to the same 84 base → no write
- fractional-case line (caseQty=6, orderedQty=85 → 14.17 cases) › displays the exact decimal, NOT rounded
- fractional-case line › an UNTOUCHED fractional line (seed focus+blur) issues NO write — no 85→84 corruption
- fractional-case line › a fractional line the operator DOES retype writes the whole-case product
- unit rows (caseQty=1 / 0 / null → no case treatment) › display, conversion, and edit are verbatim base units for caseQty=1
- unit rows › caseQty=0 behaves as a unit row
- unit rows › unit rows preserve fractional edits verbatim
- unit rows › an untouched unit row issues NO write
- poResolveEdit input validation (per §3 guard) › non-numeric text (NaN) never writes
- poResolveEdit input validation › negative text never writes
- case price + LINE $ identity (AC-3 / AC-4) › case price is costPerUnit × caseQty
- case price + LINE $ identity › cases × casePrice === orderedQty × costPerUnit for whole-case lines
- case price + LINE $ identity › cases × casePrice === orderedQty × costPerUnit even for fractional display

No failures. Full suite total (1353/124) matches the developer's disclosed number in the spec's
Implementation notes exactly — no regression introduced elsewhere.

### Verification of the developer's disclosed scope-down (empty-string → 0 write)

Read the pre-change guard at `git show HEAD:src/screens/cmd/sections/POsSection.tsx:613`:

```
if (!Number.isFinite(n) || n < 0 || n === li.orderedQty) return;
```

For `rawText = ''`, `Number('')` is `0` — finite and non-negative — so if `li.orderedQty !== 0` the
guard falls through and the pre-existing code called `updatePoLineQty(sel.id, li.poItemId, 0)`. That
is, an emptied ORDERED field silently wrote `0` **before** this spec, on every row.

Tracing the new `poResolveEdit('', orderedQty, caseQty)` (`poCaseDisplay.ts:82-99`): `trimmed=''`,
`n=Number('')=0`, passes the finite/non-negative check, does not string-match the non-empty display
seed, `base = poCasesToBase(0, caseQty)` = `0` for both case and unit rows, and (assuming
`orderedQty !== 0`) `base !== orderedQty` → `{ write: true, base: 0 }`. Same outcome: writes `0`.

**The developer's characterization is accurate** — empty-string → 0-write is byte-identical
pre/post-spec, genuinely pre-existing, and the decision to not add a new jest pin for it (rather than
silently changing behavior or silently leaving an untested footgun) is a reasonable, disclosed
scope-down, not a coverage gap introduced by this spec. Confirmed no existing test (`POsSection.test.tsx`)
exercises `po-line-qty-*` `onEndEditing` at all (grepped `fireEvent`/`po-line-qty` — zero hits on the
input), so there was no prior regression-guard to preserve here either.

### Confirmation: no existing test pinned the old ORDERED-cell unit display

Grepped `src/screens/cmd/sections/__tests__/POsSection.test.tsx` for `orderedQty`, `po-line-qty`,
`caseQty`, `costPerUnit`, and rendered-text assertions (`getByText`/`toHaveTextContent`). The four
`poLinesById` mock fixtures (lines 317, 355, 372, 446-447, 499) never set `caseQty` (so it is
`undefined` → `isCaseRow(undefined)` is `false` via `Number.isFinite`, correctly falling through to
the unchanged unit-row path) and none of the `getByText`/`toBeTruthy` assertions in the file target
the ORDERED cell's rendered string, the UNIT $ cell, or the `onEndEditing` guard. The guard swap at
`POsSection.tsx:617-618` and the cell re-render are genuinely non-breaking to this suite, consistent
with the developer's Implementation notes claim that `POsSection.test.tsx` is "unchanged... it does
not pin the ORDERED cell / guard."

### Notes

- **Framework:** jest only, per spec's own "Tests (spec 022 tracks)" section (no DB/RPC/edge surface
  in this frontend-only spec) — no framework gap, no pgTAP/shell-smoke work needed and none was added.
- **Live browser verification (AC-1 render, AC-3 render, AC-6 mixed-table alignment):** per the
  spec's own Implementation notes, the implementing agent does not have browser tooling and explicitly
  deferred this to the main session. This report defers to that plan — those three ACs are marked PASS
  on code-verification grounds (the logic and wiring are correct and jest-pinned at the pure-function
  layer) but the actual pixel-level render (sub-caption legibility inside the fixed-width cells, a
  live mixed-caseQty PO fetched from the local DB, DB-column round-trip of `round(cases)×caseQty`)
  still needs the main session's `admin@local.test` walkthrough described in the spec's own
  Implementation notes checklist. Not treating this as a blocking NOT TESTED per the task instruction,
  but flagging it is not yet closed.
- **OQ-1 / OQ-2 (owner-flagged forks):** both are PM-recorded defaults pending explicit owner
  confirmation, not test gaps — no action needed from this report; the coverage above only asserts the
  spec's stated OQ-1 resolution (exact-decimal display + write-diff guard) is correctly implemented
  and tested, not that the owner has signed off on the choice itself.
- **No mutation of seed data, no local Supabase stack needed** — this is a pure-function + component
  jest track with no DB dependency, consistent with the spec's "no migration, no RPC, no edge
  function" backend design.

### Conclusion

8/8 acceptance criteria PASS. No FAIL, no blocking NOT TESTED. Full `npx jest` is green
(1353/1353, 124/124 suites) and both typecheck gates (`tsconfig.json`, `tsconfig.test.json`) are
clean. The one open item (live browser walkthrough) is explicitly assigned to the main session per
the task's own instructions and is not treated as blocking here.
