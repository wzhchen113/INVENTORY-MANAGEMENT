# Release proposal — spec 014 (Cmd UI Breadbot fetch port)

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical, all five mandated architectural checks pass, and every acceptance criterion either PASSES or has its NOT TESTED status driven by environmental constraints (no live Breadbot upstream, no non-Breadbot store in seed) rather than broken code paths.

## Findings summary
- code-reviewer: 0 Critical, 3 Should-fix, 5 Nits. Should-fix list: (a) UTC vs local-time drift in `FetchBreadbotModal.tsx:70-78` range-default initializers and reset effect at lines 94-99 — affects users whose local timezone is behind UTC around midnight UTC; mirrors a pre-existing legacy bug. (b) Race window in `POSImportsSection.tsx:184-193` `onConfirm` where `previewMatches[idx]` may be `undefined` if `matchRecipe` hasn't completed; silently records `recipeMapped: false`. (c) Duplicate `useStore((s) => s.recipes)` subscription in `BreadbotPreviewCard` (`POSImportsSection.tsx:564`) — re-render perf nit, not a correctness defect.
- security-auditor: 0 Critical, 0 High, 0 Medium, 1 Low. The Low is a pre-existing edge-function authorization gap (`fetch-breadbot-sales` does not enforce `storeName ↔ JWT user_stores`) inherited from legacy and explicitly out of scope per spec 014; recommended as its own follow-up spec. Auth path, RLS on writes, input validation, secrets handling, realtime, and toast-error redaction all verified clean for the new code.
- test-engineer: 18 PASS, 0 FAIL, 17 NOT TESTED across 35 ACs. NOT TESTED is dominated by environmental constraints (no live Breadbot endpoint, no non-Breadbot seeded store, custom date-picker not driveable via DOM eval); static code analysis confirms correct implementation for every NOT TESTED item. One Medium finding: the "Invalid range" Toast at `FetchBreadbotModal.tsx:186-194` is unreachable because the BACKFILL button is `disabled` for inverted ranges; inline warn caption replaces it. This is a deviation from the spec letter (spec said "toast and blocks submission"), not a broken UX path — submission is blocked and the error is surfaced.
- backend-architect: 0 Critical, 0 Should-fix, 3 Minor (ParsedRow type duplication, deliberate dual `useStore` subscription, harmless `backfillRunning` double-reset). One UX deviation: preview card renders above the imports table rather than hiding it; backend-irrelevant. All five mandated load-bearing checks pass: contract correction (no `computeDiff` / `RunImportModal` in Breadbot single-fetch path), pending CSV diff invalidation on modal open, section-local fetch state with no new useStore slice, range backfill loop matches legacy byte-for-byte, legacy fallback (duplicate constants in `posBreadbot.ts`) is the design's allowed Q1 path and documented in the spec.

## Recommended next steps (ordered)

1. Commit and deploy spec 014 as-is. Browser walkthrough verified the visible flow end-to-end (modal opens, tabs work, cancel works, edge function call shape correct via 502 from local stack); the live-fetch path will be exercised by the user on next real Breadbot pull.

2. (Optional follow-ups, not blocking ship — log as a separate cleanup spec or roll into the legacy-screen deletion next month.)
   a. Extract `daysAgoISO(n)` / `yesterdayISO()` helpers in `src/lib/posBreadbot.ts` mirroring `todayISO()`'s local-component arithmetic; use them in `FetchBreadbotModal.tsx:70-78` and the reset effect at lines 94-99. Same fix should land in legacy `POSImportScreen.tsx` when that file is touched again.
   b. Add `disabled={committing || previewMatches.length !== preview.rows.length}` to the IMPORT confirm `TouchableOpacity` in `POSImportsSection.tsx`. Cheap one-line guard against the matchRecipe race.
   c. Thread `recipes` as a prop into `BreadbotPreviewCard`; remove the duplicate `useStore` subscription. Bundles cleanly with the BackfillSummaryCard prop pattern already used.
   d. Decide on the "Invalid range" UX: either remove the BACKFILL button `disabled` guard for inverted ranges so the toast path fires (matches spec letter), or update the AC wording to reflect "helper text + disabled button" (matches current implementation). Either resolution is fine.

## Out of scope for this review
- Per-store authorization check inside `fetch-breadbot-sales` edge function (security-auditor Low) — separate spec.
- `ParsedRow` type and constant duplication between `posBreadbot.ts` and legacy `POSImportScreen.tsx` — folds into the legacy-screen deletion when `EXPO_PUBLIC_NEW_UI` becomes default.
- Consolidating `savePOSImport` calls (currently called from two surfaces with the same signature) into a single `useStore.importPOS` responsibility — architectural simplification, not a defect.
- UX choice to render the preview card above the imports.log table instead of hiding the table — explicitly endorsed by the design's stack-layout convention; cosmetic deviation only.
