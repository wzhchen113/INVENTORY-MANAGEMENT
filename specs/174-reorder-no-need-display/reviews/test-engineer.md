## Test report for spec 174

### Acceptance criteria status

Test file shorthand:
- P = `src/lib/eodNoNeed.spec174.test.ts`
- E = `src/utils/reorderExport.noNeed.spec174.test.ts` (+ `src/utils/__snapshots__/reorderExport.noNeed.spec174.test.ts.snap`)
- S = `src/screens/staff/lib/reorderExportStaff.noNeed.spec174.test.ts` (+ its `.snap`)
- D = `src/screens/cmd/sections/__tests__/ReorderSection.pdfNoNeed.spec174.test.tsx` (+ its `.snap`)
- H = `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.noNeed.spec174.test.tsx`

- AC-1 (shared flag rule, constant import, no new literal) → PASS. P: `isReorderNoNeed` true/false/null-safe cases, plus the staff barrel identity test. `git diff -U0 -- src` shows no added `'no_need'` literal outside `eodNoNeed.ts`. All six call sites use `isReorderNoNeed`. Staff builders import it from the staff barrel.
- AC-2 (admin CSV On Hand = label, en/es/zh-CN, no number) → PASS. E `AC-2 — %s: the NO NEED row prints the label in On Hand, not the stale number`.
- AC-3 (admin CSV other cells unchanged, Flags keeps raw token) → PASS. E `AC-3 — %s: every other cell matches the unflagged clone; Flags keeps the raw token`.
- AC-4 (admin CSV byte-identical for numeric-only, 3 locales; existing suite unmodified) → PASS. E `AC-4 — buildReorderCsv(%s) matches the f7b2759 pin` (snapshots written pre-change per the implementer). `src/utils/reorderExport.test.ts` passes, and `git diff --stat` shows it untouched.
- AC-5 (jsPDF autoTable body On Hand label, both tables, other cells unchanged) → PASS. D `AC-5 — %s: have-enough table …` and `AC-5 — %s: needs table …`.
- AC-6 (es label; zh-CN gives English; no CJK) → PASS. D the `cases` rows for es and zh-CN, plus `AC-6 — zh-CN passes no CJK glyph to jsPDF (body cells or doc.text)`. Source check: `onHandOf` uses the coerced `locale`, not `localeIn`.
- AC-7 (jsPDF head/body unchanged for numeric-only; existing tests unmodified) → PASS. D `AC-7 — %s head/body match the f7b2759 pin` (en, es). The existing ReorderSection suites pass.
- AC-8 (shared PDF-HTML label, escaped, English, signature unchanged) → PASS. E `AC-8 — the NO NEED row prints the English label in On Hand; the other six cells are unchanged` and `AC-8 — the whole document differs … in exactly that one cell`. The signature is unchanged in the diff.
- AC-9 (shared PDF-HTML byte-identical for numeric-only) → PASS. E `AC-9 — buildReorderPdfHtml matches the f7b2759 pin`.
- AC-10 (staff CSV label, other cells unchanged, numeric byte-identical in 3 locales) → PASS. S `AC-10 — %s: On Hand is the label; every other cell matches the unflagged clone` and `AC-10 — buildStaffReorderCsv(%s) matches the f7b2759 pin`.
- AC-11 (staff text HAVE ENOUGH line `{name}: {label}`, no on-hand/unit, other lines identical) → PASS. S `AC-11 — %s: the NO NEED line is {name}: {label} with no on-hand or unit`, `AC-11 — en keeps the pre-existing item.itemName …`, `AC-11 — %s: every other line … unchanged`, and the 3-locale text pin.
- AC-12 (staff PDF-HTML label escaped and localized, both boxes, numeric byte-identical) → PASS. S `AC-12 — %s: enough box …`, `… differs … in exactly that cell`, `… also covers a needs-box placement`, and the 3-locale pin.
- AC-13 (existing staff export suite unmodified) → PASS. `reorderExportStaff.test.ts` passes and `git diff --stat` shows it untouched.
- AC-14 (edited NO NEED line renders tag `phone-order-noneed-<id>`, localized, in the name column) → PASS. H `AC-14 — an edited NO NEED line renders the tag, under the name, inside the line` and `AC-14 — the tag is localized through the active locale (es)`. Both run on the PhoneOrdering and PhoneApproveOrder surfaces.
- AC-15 (fg3 pill styling via tokens, non-interactive, name keeps numberOfLines=1) → PASS. H `AC-15 — fg3 flag-pill styling …` asserts `borderColor === LightCmd.border`, transparent background, radius 999, no onPress, label color `fg3`, and name `numberOfLines === 1`. Source inspection: no hex in the new block. It uses `C.border`, `C.fg3`, `CmdRadius.pill`, and `mono(600)` at 9 px.
- AC-16 (non-flagged line has no tag) → PASS. H `AC-16 — a non-flagged edited line renders no NO NEED tag` and `AC-16 — only the NO NEED line is tagged when both lines are shown`.
- AC-17 (line filter unchanged; unedited NO NEED row shows no line or tag; stats unchanged) → PASS. H `AC-17 — an UNEDITED NO NEED row renders neither its line nor the tag` and `AC-17 — the card stats line is identical with the flag on and off`. The diff does not touch the filter, stats, or stepper.
- AC-18 (`PhoneApproveOrder.tsx` not edited, inherits the tag, existing tests unmodified) → PASS. It is absent from `git status`. H runs every arm via `describe.each(SURFACES)` on both screens, and the existing PhoneApproveOrder tests pass.
- AC-19 (new phone render test covers AC-14/16/17; existing PhoneOrdering tests unmodified) → PASS. File H exists and covers the edited-with-tag, unedited-no-line, and non-flagged-no-tag arms. The existing phone suites pass.
- AC-20 (label only for flagged rows; each builder has a "zero but not NO NEED" arm) → PASS. Arms: E (CSV and HTML), S (CSV, text, HTML), D (jsPDF), and P (predicate). Each also keeps the `onHand 0 / suggestedQty 0 / needsOrder false / flags ['no_par']` row in its pin fixture.
- AC-21 (i18n parity if a key is added) → PASS, trivially. No key was added: `git status src/i18n` is clean, and all surfaces reuse `section.reorder.noNeed`. E also pins `reorderNoNeedLabel('en') === t('en','section.reorder.noNeed')`.
- AC-22 (full jest + both typechecks) → NOT RUN BY ME, as instructed. Main Claude runs these. The implementer reported 262 suites / 3280 tests passing and both typechecks at exit 0. Every pre-existing test file I checked is unmodified.
- AC-23 (browser check at 390 px) → PENDING. Main Claude is running it with preview tools. It is not an uncovered gap. Jest cannot cover the real jsPDF and CSV file output or the 390 px visual layout.

Summary: 21 PASS (AC-1 to AC-21), 0 FAIL, 0 NOT TESTED. AC-22 is owned by main Claude and AC-23 is pending.

### Test run

Command: `npx jest --ci src/lib/eodNoNeed src/utils/reorderExport src/screens/staff/lib/reorderExportStaff src/screens/cmd/sections/__tests__/ReorderSection src/screens/cmd/sections/phone`

Result: 52 suites passed, 52 total. 574 tests passed. 15 snapshots passed, with `--ci` so none were written or updated. 0 failures.

The run covers the five spec 174 files and these existing suites:
- `src/lib/eodNoNeed.test.ts`
- `src/utils/reorderExport.test.ts`
- `src/screens/staff/lib/reorderExportStaff.test.ts`
- every `ReorderSection*` suite
- every phone suite, including the PhoneOrdering and PhoneApproveOrder tests

The only noise is the known `process.env.EXPO_OS` console.warn from expo-linking.

`git diff --stat` on `reorderExport.test.ts`, `reorderExportStaff.test.ts`, `PhoneApproveOrder.tsx`, and `src/i18n` is empty. All four are unmodified.

### Notes

- All of this is jest only. Spec 174 has no DB, RPC, or edge-function change, so there is no pgTAP or shell-smoke track. No new framework was introduced.
- The jest tests mock jsPDF, so real PDF rendering is not exercised. The column width of "NO HACE FALTA" in es is also not checked. Both are cosmetic and rest on the AC-23 browser check, which runs in en only.
- The byte-identity pins are snapshots, and the implementer says they were captured on the unmodified `f7b2759` builders before the source edit. I cannot independently verify that ordering. I did verify that they pass with `--ci` against the current source, and that the current source diff only adds ternary branches whose `else` arm is the old expression verbatim. That matches the claim.
- The staff exports print uppercase "NO NEED" / "NO HACE FALTA", while the staff screen uses sentence case. This is the accepted tradeoff in design §6 N2. It is not a defect.
- The spec 173 staged files (`src/lib/db.ts`, etc.) were ignored as asked.
- No source or tests were edited.
