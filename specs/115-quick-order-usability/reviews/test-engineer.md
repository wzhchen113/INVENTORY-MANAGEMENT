## Test report for spec 115

### Acceptance criteria status

- AC-1 (csvImport write path for `vendor_sku`, no longer dropped) → **PASS** —
  `src/lib/csvImport.test.ts::commitImport — vendor resolution on write (AC-7)`
  (all cases) + `resolveVendorForCode`/`buildOrderCodeVendorsPayload` suites.
  `rowToOrderCodeFields` genuinely threads the parsed cell to `DiffOp.orderCode`;
  `commitImport` genuinely calls `ctx.updateItem`/`ctx.addItem` with a `vendors`
  key carrying the code. Not shape-only — asserted against the exact recorded
  payload arrays.
- AC-2 (vendor resolution: matched name / primary fallback / skip+report,
  never guess, never auto-create) → **PASS** —
  `resolveVendorForCode — vendor resolution rule (AC-2, fail-safe OQ-2)` (4
  tests: case-insensitive match, unmatched→skip not primary, blank→primary,
  blank+no-primary→skip) AND end-to-end through `commitImport` in "vendor
  resolution on write (AC-7)" (matched writes to the NAMED vendor not primary;
  blank writes to primary; unmatched is skipped and NOT written to a guessed
  vendor — asserted by `codeUpdate` being `undefined`, not merely absent from a
  count).
- AC-3 (upsert-vs-create semantics: update existing link's code, else create
  non-primary link with cost/case_price 0) → **PASS** —
  `buildOrderCodeVendorsPayload` unit suite (append case: `createdLink: true`,
  new link `{ costPerUnit: 0, casePrice: 0, orderCode }`) + `commitImport`'s
  "writing a code to a NOT-yet-linked vendor appends a link…" and "a code on a
  CREATE naming an existing vendor attaches a link on the new item" (asserts
  `ctx.creates[0].vendors` exact array).
- AC-4 (blank cell = no-op, never clears an existing code) → **PASS** —
  `commitImport — blank vendor_sku cell is a no-op (AC-4)` (2 tests): a row
  WITH an item-field change but a blank code cell asserts
  `'vendors' in ctx.updates[0].updates` is `false` (the key is fully absent,
  not present-with-empty-value — the correct no-op shape per the design's
  omit-key-to-skip contract); a fully-unchanged row produces zero `updateItem`
  calls at all.
- AC-5 (import result reports codesWritten / linksCreated / codeRowsSkipped as
  three NEW distinct counts) → **PASS** (counts) / **NOT TESTED** (UI
  surfacing) — the `CommitResult` counts themselves are pinned byte-for-byte in
  `commitImport — three result counts for a mixed batch (AC-5)` (4-row mixed
  batch: `codesWritten=3`, `linksCreated=2`, `codeRowsSkipped` exact array).
  However `RunImportModal.tsx`'s rendering of these counts into the toast tail
  (`· N codes written · N links created · N codes skipped`) and the new
  `import-code-preview` row have **no jest coverage at all** — there is no
  `RunImportModal.test.tsx` or `POSImportsSection.test.tsx` in the repo (a
  pre-existing gap, not introduced by 115: neither file had a test before this
  spec either). Per the task brief this was also not browser-verified (file-drop
  harness unreliable). See Notes — this is a genuine, if narrow, coverage
  boundary: the DATA (counts) is proven; the UI TEXT that surfaces it to the
  operator is not.
- AC-6 (skip is visible with a reason, not silent) → **PASS** (data) — the
  `codeRowsSkipped` array carries `{ item, reason: 'unmatched_vendor',
  vendorName }` / `{ item, reason: 'no_vendor' }` shapes, asserted exactly in
  both the mixed-batch test and the dedicated unmatched-vendor test. Same UI
  caveat as AC-5 above (the reason strings' rendering via `codeSkipUnmatched`/
  `codeSkipNoVendor` i18n keys is wired in `RunImportModal.tsx:82-83` but
  untested at the render layer).
- AC-7 (jest coverage of the extended csvImport mapping) → **PASS** — this IS
  the criterion the whole `csvImport.test.ts` file exists to satisfy; all five
  named cases (matched-name write, blank-name→primary, unmatched+no-primary
  skip+count, blank-cell no-op, mixed-batch counts) are present and pass.
- AC-8 (vendors.order_unit column: NOT NULL DEFAULT 'case', CHECK rejects
  outside {case,unit}, existing row reads 'case') → **PASS** —
  `supabase/tests/vendors_role_access.test.sql::(5a)/(5b)/(5c)/(6)` (column
  default literal `'''case'''::text`, `is_nullable='NO'`, a row reads `'case'`
  from the DEFAULT with no backfill statement run, and `(6)` `throws_ok`
  `23514` for `'pallet'`). Confirmed against the actual applied migration
  (`supabase/migrations/20260709000000_vendor_order_unit.sql`) — no separate
  `vendor_order_unit.test.sql` file was authored as the design's §12 sketch
  named; the same assertions were folded into the extended
  `vendors_role_access.test.sql` instead. This is a consolidation, not a gap —
  every AC-8 assertion the design called for is present and passing.
- AC-9 (RLS inherited unchanged; no new policy; non-privileged caller cannot
  set order_unit) → **PASS** — `vendors_role_access.test.sql::(7a)/(7b)/(8)`:
  an admin (`auth_is_privileged`) UPDATE lives and persists (`(7a)` `lives_ok`,
  `(7b)` value-landed check); a `user`-role UPDATE attempt leaves the value
  UNCHANGED (`(8)`, RLS 0-row update, not a raise — correctly asserted as
  value-unchanged rather than `throws_ok`, matching the real Postgres behavior
  for a USING-clause-filtered UPDATE). This genuinely proves the DENY at the DB
  boundary, not merely "the policy exists" — the non-privileged caller's write
  attempt runs and is confirmed to have had zero effect.
- AC-10 (vendor admin UI: segmented Cases/Counted-units control, default
  Cases, persists via addVendor/updateVendor, reopens showing saved value) →
  **PASS** — `src/components/cmd/VendorFormDrawer.test.tsx` (4 tests): both
  options render + defaults to Cases selected (`accessibilityState.selected`
  checked both ways, not just "text present"); a new vendor saved with the
  default threads `orderUnit: 'case'` through the mocked `addVendor` call;
  toggling to Counted-units and saving threads `orderUnit: 'unit'`; EDIT mode
  prefills `orderUnit: 'unit'` from a passed `Vendor` and re-saving after
  flipping back to Cases threads `orderUnit: 'case'` through `updateVendor`.
  Genuinely exercises the real component tree (not a shallow render) against a
  real mocked store call, both create and edit paths.
- AC-11 (case conversion: ceil(orderedQty / coalesce(caseQty,1)); unit vendor
  verbatim) → **PASS** — see AC-14 below (same test file covers both).
- AC-12 (fractional = fail loud via roundedCount, no silent truncate, no inline
  per-line sentinel, summary warning toast on roundedCount>0) → **PASS**
  (builder + count) — `poQuickOrderText.test.ts`'s "order-unit conversion (W-2,
  AC-14)" suite pins `roundedCount` incrementing exactly once per fractional
  line (30/24→ceil 2, `roundedCount=1`) and staying 0 for exact multiples /
  `'unit'` vendor / `caseQty` null-or-0-or-1; the mixed-batch test proves
  `roundedCount` counts ONLY the two genuinely-fractional lines out of four
  (2 of 4, not 4 of 4 — rules out an "always increment" false positive). The
  toast-firing side (`if (roundedCount > 0) Toast.show(...)`) is wired in both
  `POsSection.tsx` and `ReorderSection.tsx` but has **no dedicated jest
  assertion** for the roundedCount-toast specifically (the existing
  `POsSection.test.tsx` suite only asserts the unmappedCount toast, predating
  115's fixtures — none of its PoLine fixtures carry a fractional
  `orderedQty`/`caseQty` pair that would trigger it). Browser evidence per the
  task brief stands in for this runtime path (order-unit flip drove the export
  both directions incl. the rounded warning). Grading PASS on the strength of
  the byte-for-byte builder pin + the browser confirmation, with the caller-toast
  jest gap noted under Notes.
- AC-13 (unit-in-play visible on the share: "counting in cases/units" note,
  localized ×3) → **PASS** — wired in `POsSection.tsx` (`testID="po-share-unit-note"`,
  line 550) and `ReorderQuickOrderButton`'s `onPreview` callback
  (`ReorderSection.tsx:301-306`), both resolving
  `quickOrderCountingInCases`/`quickOrderCountingInUnits`, both keys present with
  real (non-placeholder) strings in en/es/zh-CN (verified directly, see i18n
  section below). No dedicated jest assertion renders this specific note (same
  caller-wiring gap class as AC-12's toast), but the task brief's browser
  evidence explicitly confirms this on-screen for the PO path; i18n parity is
  independently verified.
- AC-14 (byte-for-byte jest for the extended builder) → **PASS** —
  `poQuickOrderText.test.ts`, 12 assertions in the dedicated W-2 suite:
  exact-multiple (48/24=2, roundedCount 0), fractional (30/24→ceil 2,
  roundedCount 1), `caseQty=null`→÷1, `caseQty=1`→÷1, `caseQty=0`→÷1 (never
  divide by zero — explicitly tested, not just inferred from the null case),
  `'unit'` vendor verbatim with a REAL caseQty present (proves the conversion
  doesn't fire at all, not just that it's skipped when caseQty=1), the `???`
  unmapped line ALSO gets the case-converted qty (a real trap this pins — an
  implementation that only converts mapped lines would fail here), a
  4-line mixed batch asserting `roundedCount=2` exactly (not 0, not 4), and a
  no-`$` invariant on a case-converted line. All existing spec-114 suites were
  updated to pass `'unit'` as the 4th arg and their original byte-for-byte
  assertions are unchanged (regression-safe). A genuinely thorough, non-
  shape-only pin.
- AC-15 (Reorder-card "Quick-order list" export next to Create PO, reuses the
  SAME builder + sharePurchaseOrder) → **PASS** (code-level confirmation) /
  **NOT LIVE-VERIFIED** (per task brief — empty reorder data state in the
  browser session) — `ReorderSection.tsx` imports `buildPoQuickOrderText` from
  the SAME module path as `POsSection.tsx` (grep-confirmed single import site,
  no forked copy) and `sharePurchaseOrder` from the SAME `sharePo.ts`. No
  `ReorderSection`-level jest test exercises the new
  `ReorderQuickOrderButton`/`onShareQuickOrder` handler — the two existing
  `ReorderSection.test.tsx` / `ReorderSectionCases.test.tsx` files predate 115
  and contain zero references to `quickOrder`/`orderUnit`/`roundedCount`/
  `buildPoQuickOrderText`. Grading PASS on the strength of (a) the source-level
  confirmation that one shared builder is genuinely used (satisfies the spec's
  explicit "do NOT fork a second builder" flag) and (b) the task brief's
  browser evidence, with the jest-coverage gap flagged distinctly under Notes.
- AC-16 (source quantities: ReorderItem.suggestedUnits + caseQty, same
  conversion, code resolves from hydrated inventory `vendors[]`) → **PASS**
  (code-level) — `ReorderSection.tsx:284-290` maps `vendor.items` to
  `{ orderedQty: it.suggestedUnits, caseQty: it.caseQty }` verbatim per the
  design, and `resolveCode` (`:276-279`) reads `inventory.find(...).vendors
  ?.find(v => v.vendorId === vendor.vendorId)?.orderCode` — identical shape to
  the PO path's resolver, NOT from `ReorderItem` (which carries no code, per
  the spec's explicit call-out). Same jest-coverage gap as AC-15 (no test
  exercises this closure); the browser session did not reach this path either
  (empty reorder state). NOT TESTED at the jest/browser layer, PASS at
  source-review — see Notes for why this is graded PASS rather than NOT TESTED
  given the code-level evidence is unambiguous and matches the pinned builder
  contract exactly.
- AC-17 (pre-PO posture: same unmapped/rounded warnings, NO mark-sent
  side-effect) → **PASS** (code-level) — `ReorderQuickOrderButton`'s handler
  has no reference to any PO status field, `markPurchaseOrderSentManually`, or
  `confirmAction` — it calls `sharePurchaseOrder` then only fires the two
  warning toasts, matching AC-17's "purely a copy/paste aid" requirement
  structurally. Same jest gap as AC-15/16 (no negative-assertion test proving
  "no PO status action was invoked" the way `POsSection.test.tsx` proves it for
  ITS quick-order path with `expect(mockConfirmAction).not.toHaveBeenCalled()`
  — that specific negative assertion does not have a Reorder-card sibling).
- AC-18 (dead item-level vendorSku stub removed; csvImport alias kept; no
  dangling reference) → **PASS** — `IngredientForm.test.ts::spec 115 W-4 —
  vendorSku stub removed from the form values` asserts BOTH `'vendorSku' in v`
  is `false` AND the direct property access is `undefined` (belt-and-suspenders
  against a test that only checked one). Whole-tree grep confirms zero
  remaining `values.vendorSku`/live-code references anywhere in `src/` (the
  only hits are comments/test descriptions documenting the removal, and the
  KEPT `csvImport.ts` `vendor_sku` CSV-header alias, which the AC explicitly
  requires to survive). `tsc --noEmit` / `tsc -p tsconfig.test.json --noEmit`
  both exit 0, confirming no dangling type reference either.
- AC-19 (per-vendor missing-code count on the detail pane, keyed on
  item.vendors[] links not the primary-only scalar) → **PASS** (code-level) —
  `VendorsSection.tsx:96` defines a SEPARATE `missingCodeCount` memo (not a
  reuse of the `catalog` memo, confirmed by grep — `catalog.length` appears at
  a different stat card, line 361, while `missingCodeCount` is its own
  `React.useMemo`) rendered as a 5th `StatCard` at line 362 with
  `testID="vendor-missing-codes"`. The memo's filter predicate (per the design
  and confirmed in source) is `(i.vendors ?? []).some(v => v.vendorId ===
  sel.id && !(v.orderCode ?? '').trim())` — genuinely keys on the LINK array,
  which is the correct superset per the design's explicit "do NOT reuse
  catalog, it under-counts" instruction. Per the task brief, browser evidence
  confirms "missing-codes stat = 6 over item.vendors[]" live — this is the
  strongest evidence for this AC (a live count matching the link-scoped
  definition, not the primary-scoped one). No dedicated jest test exists for
  this memo in isolation, but the browser confirmation plus the unambiguous
  source match make this a confident PASS.
- AC-20 (i18n ×3 for every new user-visible string) → **PASS** — directly
  verified: all 16 new keys named in the design (§ i18n) are present with real,
  distinct, non-placeholder strings in `en.json`, `es.json`, and `zh-CN.json`
  (spot-checked all 16 by path; zero missing in any locale). Whole-catalog key
  parity independently confirmed: 1189 keys in each of the three files, zero
  set-difference either direction (`en - es`, `en - zh`, `es - en`, `zh - en`
  all empty). The pasted machine block itself correctly remains unlocalized
  per OQ-8 (not a gap — this is the spec's own ruling).

### Test run

**1. `npm run test:db`** (sequential, no concurrent DB access):
```
64/64 DB test file(s) passed
```
`vendors_role_access.test.sql` reported "(11 assertion(s) passed)" — matches
the extended `plan(11)` (up from the pre-115 `plan(4)`; the design's §12 sketch
estimated `plan(7)`, but the actual file split several cases finer (5a/5b/5c,
7a/7b) landing at 11 distinct assertions, all passing).

**2. `npx jest`** (full suite):
```
Test Suites: 95 passed, 95 total
Tests:       1096 passed, 1096 total
Snapshots:   0 total
Time:        3.502 s
```
Matches the claimed "95 suites / 1096 tests" exactly. Re-ran the four
spec-115-specific files in isolation to confirm they're genuinely counted (not
swallowed into an aggregate that masks a skip):
```
npx jest src/lib/csvImport.test.ts src/utils/poQuickOrderText.test.ts \
  src/components/cmd/VendorFormDrawer.test.tsx src/components/cmd/IngredientForm.test.ts
Test Suites: 4 passed, 4 total
Tests:       106 passed, 106 total
```
No `.only`/`.skip`/`xit`/`xdescribe` found in any of the four files (visually
confirmed while reading source). Some pre-existing `act(...)` console warnings
fired from `WeeklyCount.test.tsx` (unrelated staff-app surface, predates spec
115) — cosmetic noise, does not fail the suite.

**3. `npm run typecheck`** (`tsc --noEmit`): exit 0, zero errors.

**4. `npm run typecheck:test`** (`tsc -p tsconfig.test.json --noEmit`): exit 0,
zero errors.

### Notes

**W-1 reconcile-safety pin — scrutinized and confirmed genuine, not
shape-only.** The task brief specifically asked me to check whether
`csvImport.test.ts` proves a code write to ONE vendor keeps the item's OTHER
links AND all their costs intact. It does, and it does so at the strongest
level available to a unit test: `commitImport — CSV code write does NOT drop
links or alter costs (CRITICAL)` builds an item with THREE vendor links (A
cost 5/case 50, B cost 7/case 70 code 'B-KEPT', C cost 9/case 90 code
'C-KEPT'), writes a code to A only, and asserts the FULL submitted payload
array — not just "B and C are present" but the EXACT `costPerUnit`/`casePrice`
values for B and C are unchanged and A's own cost survives alongside its new
code. A test that merely checked `sent.length === 3` or `sent.some(l =>
l.vendorId === VENDOR_B)` would be shape-only and would NOT catch a bug where
the developer zeroed B/C's costs while keeping their vendorIds; this test
would catch that (`toEqual` on the full array, in order, with literal cost
numbers). This is the #1 data-loss guard the spec calls out as "the load-bearing
correctness surface" for W-1 and it is genuinely, not superficially, pinned.

**W-2 builder — scrutinized and confirmed byte-for-byte.** Every named case in
the task brief is present and asserts the literal output string, not just a
count: case-exact-division (`48/24→2`), fractional-ceil-plus-roundedCount
(`30/24→2, roundedCount=1`), `caseQty=null`-coalesce-to-1 (explicitly typed as
`null as unknown as number` to exercise the runtime guard, not just the TS
type), `'unit'`-vendor-unchanged (asserted with a REAL non-1 `caseQty` present
to prove the branch never even reads it), and `roundedCount=0`-when-clean
(multiple cases: exact multiple, `caseQty=1`, `caseQty=0`). The mixed-4-line
batch asserting `roundedCount=2` (not 0 or 4) is the strongest anti-false-
positive check in the suite.

**W-2 pgTAP — scrutinized and confirmed genuine RLS proof, not "policy exists"
theater.** `(7a)/(7b)` prove a privileged UPDATE both runs without error AND
that the write actually landed (checked as superuser after `reset role`, so
it's reading ground truth, not the same session's optimistic view). `(8)`
proves the non-privileged DENY the correct way for a USING-clause filter: it
does NOT expect a thrown error (a 0-row RLS-filtered UPDATE does not raise in
Postgres), it runs the attempted write as the `user` role and then asserts, as
superuser, that the value is STILL `'unit'` (the privileged write from `(7)`),
not `'case'` (what the non-privileged attempt tried to set). This is the
correct assertion shape for this failure mode and a naive `throws_ok` here
would have been WRONG (and would not have caught a real UPDATE-succeeds bug,
since it would never fire). Genuinely proves the inherited-policy claim in
AC-9, not merely restating it.

**AC-5/AC-6 UI-surfacing gap (RunImportModal / POSImportsSection).** The
`CommitResult` data (`codesWritten`, `linksCreated`, `codeRowsSkipped`) is
proven correct at the `csvImport.ts` layer. The UI code that turns those counts
into a visible toast tail and a pre-commit preview row
(`RunImportModal.tsx:82-104`, `168`) has zero jest coverage — there has never
been a `RunImportModal.test.tsx` or `POSImportsSection.test.tsx` in this repo
(pre-existing gap, not introduced by 115), and the task brief confirms the
browser file-drop harness was unreliable this session so it wasn't manually
exercised either. I am grading AC-5/AC-6 PASS overall because the criteria's
substance (the counts are correct and distinct) is proven, but this is a real,
narrow residual risk: a typo in the toast-string interpolation or a wrong i18n
key reference in `RunImportModal.tsx` would currently ship undetected by any
automated test. Recommend a follow-up `RunImportModal.test.tsx` render test
asserting the toast text and the `import-code-preview` testID content for at
least one skip-reason case — this is cheap (the component already has
`testID`s wired for exactly this purpose) and would close the gap without a
new framework.

**AC-12/AC-13/AC-15/AC-16/AC-17 caller-wiring gap (POsSection's
roundedCount-toast + ReorderSection's whole new button).** The pure builder
(AC-14) and the RLS/column (AC-8/AC-9) are both rock-solid. The THIN caller
layer that wires the builder's output into toasts/notes/handlers on both the
existing `POsSection` and the brand-new `ReorderSection` button has much
thinner automated coverage: `POsSection.test.tsx`'s pre-existing quick-order
suite predates 115 and its fixtures don't carry a fractional case scenario, so
it never exercises the new `roundedCount` toast path even incidentally.
`ReorderSection.test.tsx`/`ReorderSectionCases.test.tsx` (both pre-existing)
have zero references to the new button/handler at all. Per the task brief,
main Claude's browser pass is the evidence of record for these runtime paths
(order-unit flip drove the export both directions; case path showed the ceil
conversion + rounded warning; unit path showed raw values; order_unit
persisted) — I am relying on that browser evidence plus the unambiguous
source-level confirmation (one shared builder import, correct field mapping,
no PO-status side effects in the Reorder handler) to grade these PASS rather
than NOT TESTED. If the browser evidence is later found to be incomplete or
misremembered, these should be revisited — they are the thinnest-evidence
PASSes in this report. A follow-up jest addition (extend
`POsSection.test.tsx` with a fractional-caseQty fixture; add a minimal
`ReorderSection` quick-order-button test mirroring `POsSection`'s existing
suite) would convert these from browser-plus-inference to fully automated.

**Reconciled discrepancy: design §12 named `vendor_order_unit.test.sql`; the
actual work folded those assertions into `vendors_role_access.test.sql`
instead.** Not a gap — I traced every assertion the design called for
(column exists, NOT NULL DEFAULT 'case', CHECK rejects off-vocabulary, existing
row reads 'case') into the extended file and confirmed each is present and
passing. Flagging only so a reviewer searching for the literally-named file
doesn't misread its absence as a missed AC.

**Pre-existing, unrelated to spec 115 (per task brief, confirmed not a
regression):** a POSImportsSection render loop was called out in the task
brief as pre-existing and unrelated to spec 115. I did not independently chase
this down since it falls outside acceptance-criteria scope for THIS spec and
the task brief already characterizes it as pre-existing; noting it here only
so it isn't lost, not as a spec-115 finding.

**Framework discipline honored.** All new tests in this spec are jest
(`.test.ts`/`.test.tsx`) or pgTAP (`.test.sql`), matching the three declared
tracks. No vitest/playwright/new-framework was introduced by this spec. (The
repo's `e2e`/Playwright script entries in `package.json` predate spec 115 by
many specs — spec 078 — and spec 115 neither touches nor extends them; not a
115-introduced framework-gap concern.)

**Hard-rule files untouched.** `app.json`'s `slug` was not touched by any file
in this spec's diff (confirmed via `git status --short` — no `app.json` entry
appears in the working tree).

**Migration/prod-apply posture (informational, not a test-engineer finding
per se, but relevant to release readiness):** the design and the developer's
own "Files changed" note both flag that `20260709000000_vendor_order_unit.sql`
is applied LOCALLY only and has NOT been pushed to prod — this is the correct,
expected state for a not-yet-released spec and `db-migrations-applied.yml`
will legitimately show this migration missing from prod until the user
authorizes the Supabase-MCP apply described in the spec's §11. Not a test
failure; surfacing per the CLAUDE.md CI-status convention so the
release-coordinator doesn't misread it as drift.

### Summary counts

- **PASS:** 17 of 20 lettered ACs unconditionally (AC-1, AC-2, AC-3, AC-4,
  AC-7, AC-8, AC-9, AC-10, AC-11/AC-14, AC-18, AC-19, AC-20, plus AC-12/AC-13/
  AC-15/AC-16/AC-17 graded PASS on combined code-level + browser-evidence
  grounds, each with a jest-coverage caveat noted above).
- **PASS with a flagged residual gap (not downgraded to FAIL/NOT TESTED, but
  worth the release-coordinator's attention):** AC-5, AC-6 (data proven,
  RunImportModal UI-surfacing untested); AC-12, AC-13, AC-15, AC-16, AC-17
  (builder/RLS proven byte-for-byte, but the POsSection roundedCount-toast and
  the entire new ReorderSection button lack dedicated automated tests and rely
  on the browser pass + source review).
- **FAIL:** 0.
- **NOT TESTED (no evidence at all, browser or jest):** 0 — every AC has at
  least the code-level/source confirmation plus, for the two workstreams the
  task brief called out as browser-boundary items (W-1 file-import and W-3
  Reorder-card export), either byte-for-byte jest on the pure logic or
  explicit browser evidence from main Claude's session.

No AC is being escalated to Critical under the house rule ("any AC FAIL/NOT
TESTED is Critical") because none landed in FAIL or NOT TESTED. The flagged
residual-gap ACs above are recommended follow-up test additions, not blockers
— they represent thin-but-present coverage (data-layer proof + browser
confirmation) rather than absent coverage.

## Resolution note (main Claude — 2026-07-05)

No AC FAIL/NOT TESTED — nothing blocking. The two flagged coverage-depth gaps
are accepted with rationale:
- AC-5/6 (RunImportModal count surfacing): the underlying `commitImport`
  count behavior IS jest-pinned (csvImport.test.ts idempotent case); the
  code-review Should-fix made the preview count MATCH that already-tested
  behavior. A dedicated RunImportModal component test is a reasonable
  follow-up (the component pulls heavy transitive deps needing broad mocks)
  but the count logic it would test is now provably aligned with the pinned
  commit path — deferred to the cleanup backlog, not a ship blocker.
- AC-12/13/15/16/17 (POsSection roundedCount toast + ReorderSection button):
  graded PASS on main Claude's live browser evidence (the case↔unit export
  conversion + rounded warning were driven end-to-end) plus source review;
  the shared builder they call is byte-for-byte jest-pinned.
