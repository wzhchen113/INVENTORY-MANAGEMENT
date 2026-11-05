## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical or High. All 22 acceptance criteria pass with tests behind them. Full jest is green at 3562/3562 and `typecheck:test` exits 0. The one Should-fix is a risk that two copies of a check could drift apart later; it is not a bug today. Ship is conditional on the owner items and the CI-on-main check below.

## Findings summary
- **code-reviewer:** 0 Critical, 1 Should-fix, 12 Nits (2 of them out of scope). The implementation matches the `## Backend design` with no deviations. The spec-139 `ExportLocalePicker` defaults behave exactly as before. In `PhoneOrdering`, all new hooks sit above the no-store early return. All six export sites take the snapshot before their first `await` and keep the record-then-clear order. There are no inline colors and no direct Supabase calls.
  - **Should-fix:** the "does this CSV go to the US Foods / SYSCO import file?" check is written out at two new press-time sites (`src/screens/cmd/sections/ReorderSection.tsx:591`, `src/screens/cmd/sections/phone/PhoneOrdering.tsx:865`), and the `runCsv` bodies repeat it (`:565`, `:835`). I confirmed all four are the same expression today, so nothing is broken now. If they drift, a prompt could appear for a file that has no language, or be skipped for one that does. Suggested fix: one exported `hasImportFormat(payload, vendor, vendors)` helper.
  - **Top nits:**
    - The local state name `prompt` shadows `window.prompt`. Rename it to `exportPrompt` to match the phone code.
    - The `cancel` dependency in the `ExportLanguagePrompt` effect changes on every render. This is harmless because `firedRef` guards it.
    - Some comments are stale or redundant, including the "REMOVABLE" comment, which is process state rather than a reason.
    - The prompt announces the same `aria` label twice, once for the sheet and once for the radiogroup.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 1 Low.
  - **Low:** only the prompt's render path checks for a store switch. The confirm handlers never compare the `storeId` saved at open time with the live store. This has no impact on data integrity today, because the file, the snapshot and the draft-PO record all come from the same live values. It would only matter if a later refactor removed the prompt's mismatch branch. The optional fix is a one-line bail at each of the four confirm sites.
  - **Verified:**
    - The snapshot rule from the 2026-08-08 security review still holds when the user decides how long the prompt stays open.
    - Every dismiss path has no side effects.
    - The picked locale never reaches `setLocale` or `profiles`.
    - CSV formula injection: the existing `csvSafeCell` guard covers the localized names, and the import file ignores the locale.
    - There is no new DB, RPC or edge-function surface, and no XSS sink.
- **test-engineer:** 22 PASS, 0 FAIL, 0 NOT TESTED.
  - The test engineer added 2 AC-13 cases to `ReorderSection.exportLanguagePrompt.spec183.test.tsx`, because the developer's suite did not cover AC-13.
  - No existing test case was deleted. Per-file case counts are unchanged, and the diffs of the four routed `ReorderSection.*` suites have no removed lines. The 17 removed lines in the phone spec-156 suite are the signature and describe-name changes plus the explicit `{ confirm }` flag. No assertion was weakened.
  - **Remaining coverage gaps (non-blocking):**
    - Phone AC-13 has no behavioural test.
    - The SYSCO import skip is tested only through the US Foods fixture. Both go through the same `pickImportVendor` branch.
    - There is no phone version of AC-15(a), the payload being replaced while the prompt is open. The phone code is safe by structure.
    - AC-14's "not awaited, with `.catch`" is checked by reading the source only.
    - The desktop AC-13 test uses a `useT` mock that ignores language, so it catches routing regressions but does not prove real Spanish-UI rendering.
- **backend-architect:** not run after implementation, because the change is frontend-only. The architect's design-mode check (§0) and the security audit (item 5) both confirm there are no migrations, RLS, RPC, edge-function or `db.ts` changes. No drift findings apply.

### Gate status (from the dispatch facts and the test-engineer report)
- Full `npx jest`: 284/284 suites and 3562/3562 tests pass.
- `npm run typecheck:test`: exits 0.
- `npm run typecheck`: exits 2 **locally only**, with exactly 24 `TS2688` errors. They come from empty duplicate `node_modules/@types/* 2` folders, which were created before this work. The test engineer showed it exits 0 when those folders are left out of `--types`, and it reports no code errors. This is an environment problem, **not a broken build**. CI's clean `node_modules` should not hit it. Locally, deleting the `node_modules/@types/* 2` folders, or running a clean `npm ci`, clears it.
- CI on `main`: nothing has been pushed for this spec, so no run reflects it yet. I had no shell and could not check the current latest runs of either gate on `main`.

## Recommended next steps (ordered)
1. **Owner decisions before commit.** None of these block on code; they are the owner's calls.
   - a. **`pdfLatinOnly` hint: keep or drop.** The PM added it; the owner did not ask for it. Removing it is self-contained:
      - delete the `{format === 'pdf' ? … : null}` block (testID `export-lang-pdf-hint`) in `src/components/cmd/ExportLanguagePrompt.tsx`
      - delete the `section.reorder.exportLanguagePrompt.pdfLatinOnly` key from `src/i18n/en.json`, `es.json` and `zh-CN.json`
      - delete the one test "the PDF-only hint renders for PDF only" in `src/components/cmd/ExportLanguagePrompt.test.tsx`

      If it is kept, replace the "REMOVABLE (owner did not ask for it)" comment with a plain reason (code-reviewer nit).
   - b. **Human review of the es / zh-CN copy** for the 8 `section.reorder.exportLanguagePrompt.*` keys. The test engineer confirmed the three catalogs have the same keys but did not judge translation quality. The copy matches the architect's suggestions.
2. **(Optional, Should-fix, before commit if cheap.)** Pull the import-file check into one exported helper, for example `hasImportFormat(payload, vendor, vendors)` next to `narrowReorderToVendor`. Use it in desktop `onCsvPress`, phone `requestExport` and both `runCsv` branches. Re-run full `npx jest` and `npm run typecheck:test` afterwards. This does not block shipping, because the copies are the same today.
3. **Commit boundary.** The staged index also holds files from other specs: 176, 177, 179 and 180, plus `App.tsx` and `src/screens/staff/i18n/index.ts`, which are not in this spec's `## Files changed`. When the user commits, they should decide whether spec 183 goes in its own commit. The 17 files in this spec's `## Files changed` list define its boundary. Main Claude does not auto-commit.
4. **After the user pushes to `main`:** confirm the latest run of **both** `.github/workflows/test.yml` and `.github/workflows/db-migrations-applied.yml` on `main` is green (`gh run list --branch main --workflow <file> --limit 1`). Also check `e2e.yml` by hand, per the pending gate-promotion note. If any gate is red or still running, surface the run URL and wait. This spec has no migration, so `db-migrations-applied` should not be affected by it, but the rule requires checking both gates regardless.
5. **iOS live pass.** This is blocked on the Xcode install (spec 181) and tracked there. Check two things:
   - **Phone quick-order prompt on native:** does the prompt reliably appear after the overflow sheet dismisses? It relies on a 350 ms `PHONE_SHEET_HANDOFF_MS` delay between the two modals, which is only verified in jest with fake timers. If it fails, nothing is exported or recorded. The fallback is the single-`Modal` "language step" design in §3, a change to the host only.
   - **Native share sheet right after the prompt modal closes:** this race already existed before spec 183 (§6.2). If it reproduces, a follow-up should defer only the `sharePurchaseOrder` call.
6. **Optional follow-ups (not blocking):**
   - Security Low: a one-line bail at each of the 4 confirm sites when `currentStore?.id !== openedForStoreId`.
   - Test gaps: a phone AC-13 test, a SYSCO-specific import-skip case, and a phone AC-15(a) case.
   - Nits: rename `prompt` to `exportPrompt` in `ReorderSection.tsx`; hold `onCancel` in a ref, or key the effect on `storeMismatch` only; fix the stale or redundant comments; drop the duplicate aria announcement; refresh the `ExportLocalePicker` header comment; make the quick-order `onPress` check `reorderPayload` too, so the prompt does not open and then do nothing; remove the unneeded `'zh-CN' as any` in the phone spec-183 test.
   - Local environment: clear the `node_modules/@types/* 2` duplicates.

## Out of scope for this review
- Factor out a `recordThenClear(vendor, exportedAt)` helper so spec 156 AC-10 is pinned in one place. Also dedupe the code/name resolver blocks that desktop and phone `runQuickOrder` both carry. Both duplications existed before this spec, and the design kept them on purpose. Each is a candidate for its own spec (code-reviewer).
- Phone `runQuickOrder` has no `busy` guard or `try/finally`, so a second export can start while a share is still pending. This existed before the spec, and AC-16 covers desktop only. It is a candidate for a separate spec (code-reviewer).
- Deferring the native share sheet after a modal dismisses (architect §6.2). This existed before the spec; follow up only if the iOS live pass reproduces it.
- The CSV formula guard does not catch formulas that start after leading spaces. This existed before the spec, and Excel does not evaluate those, so no action is needed (security-auditor).
- CJK PDF for the reorder export, a remembered last-picked language, and the POsSection quick-order prompt. The spec puts all three out of scope by owner decision 5.
