# Release proposal — spec 141 (staff EOD count — keypad-sheet redesign)

## Verdict
verdict: SHIP_READY
rationale: Zero Critical from any reviewer, security PASS at all severities with the owner's "keep current staff permissions" guardrail fully verified, 0 test FAILs with full jest + both typechecks green, and both CI gates green on `main` (frontend-only, no migration → `db-migrations-applied.yml` unaffected).

## Findings summary
- code-reviewer: 0 Critical / 2 Should-fix / 3 nits (+1 out-of-scope note). Top issues: (1) the new `isCounted` predicate wasn't used to collapse two pre-existing duplicate inline "counted" checks — the rule now lives in three places in `EODCount.tsx`; (2) a stale comment + now-dead `onScrollToIndexFailed`/`listRef` handler left over from the removed DOM-focus jump path. Neither is a behavior bug. AC-REG-8 (no backend delta) independently grep-verified.
- security-auditor: 0 findings at all severities (Critical/High/Medium/Low). Guardrail preserved with evidence — no `supabase/`, `db.ts`, RPC, edge-function, auth, RLS, or `user_stores` change; submit payload byte-unchanged; note field correctly OMITTED (not half-wired); Today/Yesterday window not widened (`dayOffset ∈ {0,1}`); keypad input sanitized through pure `appendKeypadDigit` (digits + single `.`, 5-char clamp, no injection sink); locked rows double-gated; no cross-store/cross-vendor write path; no secrets/PII in logs; no new dependency.
- test-engineer: 16 PASS / 3 PARTIAL / 0 FAIL. Full jest 144 suites / 1496 tests exit 0; both typechecks exit 0; i18n parity machine-guarded across EN/ES/中文; AC-REG-8 no-backend-delta git-verified. Partials are coverage gaps, not observed defects: AC-3 scrim-tap dismiss untested (source-correct, ✕-close path covered); AC-7 orchestrator-level SKIP/NEXT/DONE wiring untested at the live-`<EODCount/>` level (unit `advanceUncounted` + presentational `StaffKeypadSheet` levels ARE covered); AC-REG-7 search-narrowing has zero coverage but is PRE-EXISTING (byte-unmodified by this diff, git-confirmed against HEAD), not introduced here.
- backend-architect: not invoked — no backend surface touched (frontend-only spec, no contract to drift against).

### Main-session browser verification (load-bearing, 390px, real STAFF account)
Signed in as `manager@local.test` → StaffStack, selected a store, drove the live staff EOD count. Confirmed: new count rows (dashed counted indicator, CS/unit wells, "0 of 31 counted", Default/Custom order toggle preserved); tapping a well opens the staff keypad BOTTOM SHEET (dark theme, active-field select, digit pad); entering "2" cases on a case-of-4 item → "= 8 lbs total" (correct case math); NEXT ITEM advanced to the next item AND marked the first counted (green ✓, well "2", meta "total 8 lbs", progress "1 of 31 counted"); 2-cell Today/Yesterday toggle + late-submission banner render; zero console errors; staff app renders DARK at runtime. This live NEXT-ITEM advance-and-mark run substantially exercises the AC-7 orchestrator wiring and the AC-3 sheet the test-engineer flagged as untested. Not exercised live: submit-gate-block / DONE-when-all-counted (needs all 31 counted) and scrim-tap dismiss (both reuse unchanged patterns).

## Recommended next steps (ordered)
SHIP_READY:
1. Commit the spec-141 staff EOD keypad-redesign work and deploy (web → Vercel). No prod-apply step — frontend-only, no migration, so `db-migrations-applied.yml` needs no action.
2. (post-ship follow-up, non-blocking) code-reviewer Should-fix #1 — route `renderEodRow` (`EODCount.tsx:863-893`) and `onSubmit`'s `isBlank` (lines 702-703) through the memoized `isCounted` so the counted-once rule has one source of truth. Pure refactor, no behavior change.
3. (post-ship follow-up, non-blocking) code-reviewer Should-fix #2 — drop or re-comment the dead `onScrollToIndexFailed`/`listRef` handler + stale scroll-jump comment (`EODCount.tsx:1326-1342`) left from the removed DOM-focus path. Harmless no-op today.
4. (post-ship follow-up, non-blocking) test-engineer AC-7 gap — add 2-3 `EODCount.test.tsx` integration tests pressing `eod-sheet-next`/`eod-sheet-skip` against a live render (re-seat on next uncounted, wraparound, "Done ✓" relabel+close, and one Custom-view pass proving `orderedForAdvance` not `items` is iterated). Live browser run gives interim confidence; the automated test locks it in.
5. (post-ship follow-up, non-blocking) test-engineer AC-3 gap — small `BottomSheet.test.tsx` pressing `staff-sheet-scrim` → asserts `onClose`, plus a press inside the body does NOT fire `onClose` (swallow guard).

Rationale for post-ship: the 2 code Should-fixes are cleanup of this spec's own refactor, not behavior bugs (code-reviewer explicitly calls them "quick follow-ups," not blockers). The AC-3/AC-7 partials are PARTIAL not FAIL — the logic is covered at unit + presentational levels, source reads correct, and the main-session live run confirmed the NEXT-ITEM advance/mark and sheet-open behavior end-to-end. None gate a hard rule: no Critical, no broken AC, no permission/capability change (the guardrail), and both CI gates green on `main`.

## Out of scope for this review
- AC-REG-7 search-narrowing test coverage — pre-existing gap (git-confirmed unchanged by this diff). Belongs in a separate follow-up ticket adding a `matchesQuery.test.ts` + an `eod-search` narrowing test to `EODCount.test.tsx`.
- Note-field persistence (OQ-A) — deliberately omitted this build; a persisted note would be a capability/backend change and needs its own spec.
- The three-site cases/units total-math duplication (`renderEodRow`/`sheetTotal`/`onSubmit`) — predates spec 141, spec required byte-for-byte preservation; consolidation is a future cleanup.

## Handoff
next_agent: NONE
prompt: SHIP_READY — spec 141 staff EOD keypad redesign; 0 Critical across all reviewers, security PASS all severities (guardrail preserved), 0 test FAIL, full jest 1496 green, both CI gates green on main, frontend-only (no migration). Commit + deploy; 2 code Should-fixes and 3 test PARTIALs are all non-blocking post-ship follow-ups.
payload_paths:
  - specs/141-staff-eod-count-keypad-redesign/reviews/release-proposal.md
