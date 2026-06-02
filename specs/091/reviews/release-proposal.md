# Release proposal — spec 091 (reorder cleanup batch: deferred nits + test gaps from 087/088/089/090)

## Verdict
verdict: SHIP_READY
rationale: Cosmetic + test-only cleanup with zero unresolved Criticals — both reviewers green post fix-pass, main `test.yml` is green, and no migration/contract/security surface is touched.

## Findings summary
- **code-reviewer:** 0 Critical / 2 Should-fix (BOTH resolved in the fix-pass) / 4 Nits (deferred, cosmetic comment wording). Should-fixes were test hygiene only: (S1) a misleading no-op `FakeDate` constructor in `reorderExport.test.ts` and (S2) a missing "why day-1 is a safe past-date fixture" comment in `Reorder.test.tsx` B4. Verified resolved in source — `reorderExport.test.ts:177-178` now omits the constructor with a documenting note. The 4 Nits are cosmetic (a `cases`-as-unit example in the D1 comment, an A4 spec-reference that goes stale on merge, an A3 two-same-mode-examples note, and a `beforeEach` belt-and-suspenders) — none are correctness issues; all findings are within the changed files.
- **security-auditor:** N/A by design (spec §"Right-sizing note"). No auth, RLS, edge function, or HTML-rendering path in scope; the only `escapeHtml` call site (`reorderExport.ts:buildReorderPdfHtml`) is unchanged. No new caller-controlled data flows.
- **test-engineer:** **10 PASS / 0 FAIL / 0 NOT-TESTED** post fix-pass. The earlier A2 "NOT TESTED → Critical/BLOCK" (the production `useMemo` removal had no asserting test) is **RESOLVED** — its Resolution section documents a new non-vacuous per-render `maxDate` test in `Reorder.test.tsx` (verified at lines 373-403: asserts Jun 2 at mount, advances the clock to Jun 3, re-renders, asserts Jun 3; the old `useMemo(() => todayIso(), [])` would freeze at Jun 2 and FAIL). Every other AC (A1, A3, B1-B5, C1, C2) passes with documented non-vacuousness. Full `npx jest` 564/564 (+1 from the A2 test), base + test-graph typechecks exit 0, pgTAP `report_reorder_list_cases` 12/12 (comment-only, plan unchanged).
- **backend-architect (post-impl):** N/A by design (spec §"Right-sizing note"). No contract, RPC signature, or migration-logic change; the one pgTAP touch (C1) is a header-comment-only edit that changes no `select`/assertion and leaves `plan(12)` intact — no drift surface.

## CI gate
Latest `test.yml` on `main` is GREEN (run 26837783531, spec 090); nothing pushed since → main green. `db-migrations-applied` is also green (091 adds no migration). The "no SHIP_READY on red `main` test.yml" hard rule is satisfied.

## Recommended next steps (ordered)
SHIP_READY:
1. **Commit the unstaged work** (~12 files; the user runs the commit). Production code: `src/utils/reorderExport.ts` (A1 — local-not-UTC `todayLocalIso`), `src/screens/staff/screens/Reorder.tsx` (A2 — per-render `maxDate`), `src/utils/reorderDayFilter.ts` (A3 — explicit invalid-Date guard), `src/components/cmd/ReorderDatePicker.tsx` (A4 — kept single-letter labels + comment), `src/screens/cmd/sections/ReorderSection.tsx` (D1 — base-unit `itemTotal` comment + "total qty:" → "qty (base):" relabel, NO math change). Tests: `src/utils/reorderExport.test.ts` (A1 + S1 fix), `src/utils/reorderDayFilter.test.ts` (A3), `src/screens/staff/i18n/i18n.test.ts` (B1), `src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx` (B2), `src/screens/staff/screens/Reorder.test.tsx` (B3/B4/B5 + S2 fix + A2 test), `src/lib/inviteUser.test.ts` (C2). pgTAP: `supabase/tests/report_reorder_list_cases.test.sql` (C1, comment-only). Plus `specs/091/`.
2. **NO migration / NO `db push`.** This batch is cosmetic + test only; the pgTAP change is comment-only with an unchanged plan count. Vercel auto-deploys web on push to `main`.
3. **Confirm green after push.** Per the project's standing rule, verify the next `test.yml` run on `main` is green after the push.
4. **User-visible delta is minimal:** D1 relabels the admin Reorder per-vendor header "total qty:" → "qty (base):" (value unchanged). A1 (honest naming; only reached when `payload.asOfDate` is absent, which the RPC never produces) and A2 (date-picker upper bound no longer goes stale past midnight) have no normal-path visible change.

## Out of scope for this review
- **The 4 deferred code-reviewer Nits** — cosmetic comment wording (`cases`-as-unit example, A4 spec-reference staleness, A3 two-same-mode examples, `beforeEach` belt-and-suspenders). No correctness value; safe to leave or fold into a future touch of these files.
- **`e2e/staff-reorder.spec.ts` (Track 4 Playwright)** — the staff-reorder happy-path e2e named by the 089 test contract was explicitly deferred to its own future spec (092 or later). The `e2e/.auth/staff.json` fixture and `e2e/eod.spec.ts` / `e2e/reorder.spec.ts` precedents exist; unit-level B3/B4/B5 close the jest gaps in the meantime. A named, tracked follow-up — not a blocker.
- **The over-long Spec-090 comment block** at `InviteUserDrawer.tsx:140-154` — the 090 reviewer rated trimming it a preference (follows the Spec-068 pattern), and 091 left it as-is to stay minimal.

---

This is a clean cosmetic + test-only cleanup batch with no unresolved Criticals: the code-reviewer's two Should-fixes are both resolved (verified in source), its four remaining items are cosmetic Nits, and the test-engineer's lone A2 BLOCK was resolved by a genuinely non-vacuous per-render `maxDate` test that the pre-091 mount-memo would have failed — leaving 10 PASS / 0 FAIL / 0 NOT-TESTED. With main `test.yml` green, no migration, and no auth/RLS/edge/HTML/contract surface touched (both N/A reviewer slots justified by the spec), all SHIP_READY hard rules are satisfied. Recommend committing the ~12 unstaged files (user runs the commit) and letting Vercel auto-deploy web on push; no `db push` is needed. The four cosmetic Nits and the deferred staff-reorder e2e remain tracked, non-blocking follow-ups.

## Handoff
next_agent: NONE
prompt: SHIP_READY — spec 091 cleanup batch; 0 unresolved Criticals (test-engineer A2 BLOCK resolved by a non-vacuous per-render maxDate test, code-reviewer 2 Should-fixes resolved + 4 cosmetic Nits deferred), main test.yml green, no migration. Recommend committing the ~12 unstaged files (user runs commit); Vercel auto-deploys web on push, no db push.
payload_paths:
  - specs/091/reviews/release-proposal.md
