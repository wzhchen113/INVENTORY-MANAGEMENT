# Release proposal — spec 079 (E2E Phase 2 — behavioral depth + flake-proofing)

## Verdict
verdict: SHIP_READY
rationale: Zero Critical from any reviewer, 18/18 ACs covered and load-bearing, both Should-fix fixed in the post-review pass, full suite green (Playwright 14/14, jest 386/386, pgTAP 38/38, e2e tsc 0), and latest `test.yml` on main is green.

## What shipped

Spec 079 EXTENDS the spec-078 Playwright harness — it deepens behavioral coverage and flake-proofs the whole suite. No harness rebuild, no config rewrite, no new auth model. No DB migration, no RPC, no RLS, no edge-function change.

Harness / `e2e/` tree (backend-developer surface, zero `src/` edits):
- **`fixtures/db.ts` EXTRACT** — the service-role client + `assertLocalStack` prod-URL guard were EXTRACTED (not newly introduced) from `global-setup.ts`/`global-teardown.ts` into one DRY module; adds a `todayIso()` that mirrors `EODCount.todayIso()` LOCAL-time derivation byte-for-byte. `global-setup`/`global-teardown` refactored to import it — behavior-identical (the Towson `order_schedule` vendor-scoped teardown still fires; pgTAP arm C stays green).
- **Spec-072 scroll guard** (`eod.spec.ts`) — nested `test.describe` with a scoped `test.use({ viewport: 375×812 })` (Desktop Chrome would pass vacuously) asserting Submit-in-viewport + `eod-item-list` internal-scroll (overflow-y auto/scroll AND `scrollHeight>clientHeight` anti-vacuous tripwire, fires first) + body-does-not-scroll.
- **EOD persistence** (`eod.spec.ts`) — online case synchronizes on the in-place `eod-prefill-banner` (the deterministic RPC-landed signal; the original `queue-indicator` checkpoint was vacuous for online submits), reloads + re-asserts the banner, then performs the suite's **one** service-role read of `eod_submissions` for (Towson, today, US FOOD), value-matched to this run's submitted `7` (not row-presence-only); idempotent via `staff_submit_eod` upsert.
- **Invite durable-effect** (`invite.spec.ts`) — asserts the run-unique email (`e2e-invite+<runId>@local.test`) renders as a Users-list row, keyed off this run's email, never a count.
- **Reorder action depth** (`reorder.spec.ts`) — clicks `reorder-refresh` (guaranteed floor outside the export gate), asserts the LOADING->REFRESH transition + section stays mounted, and defensively asserts the export buttons enabled only when the `showExport` payload gate is satisfied.
- **Nav-testID flake-proofing** — `SIDEBAR_LABEL` (i18n-fragile label text) replaced with `SIDEBAR_NAV` testID map across all 4 nav call sites (`dashboard`/`reorder`/`audit`/`invite` specs); zero `waitForTimeout`/sleep anywhere; `auth`/`dark-mode` audited clean, unchanged.
- **README flake checklist** (`tests/README.md`) — verbatim 8-point Track-4 flake checklist (AC-FLAKE-2), the service-role-read carve-out rationale, the `fixtures/db.ts` layout entry, AC-PROMO1 restated unchanged.

Frontend (5 net-new production testIDs, all inert leaf attributes):
- `src/screens/staff/screens/EODCount.tsx` — `eod-item-list` on the populated `<FlatList>`.
- `src/components/cmd/TreeGroup.tsx` — `nav-${item.id}` on the non-editMode `<TouchableOpacity>` (instruments every sidebar item; editMode `<View>` intentionally not instrumented).
- `src/screens/cmd/sections/ReorderSection.tsx` — `reorder-export-csv`, `reorder-export-pdf`, `reorder-refresh`.

Both code-reviewer Should-fix items were fixed in the post-review fix-pass (both in `e2e/reorder.spec.ts`).

## Findings summary
- **code-reviewer**: 0 Critical, 2 Should-fix (BOTH FIXED, per the Resolution block), 7 Nits (deferred). Should-fix #1 — documented the deliberate non-retrying `csv.isVisible()` snapshot intent (buttons-absent is a legitimate terminal empty-payload state, so a retrying assertion would hang then fail on a valid path). Should-fix #2 — made the CSV/PDF export assertions symmetric (`toBeEnabled()` only for both, dropping the redundant PDF `toBeVisible()` round-trip). The 7 Nits are all cosmetic (clarifying comments, one verbose test name, a README wording tweak, confirmations-of-intent) and affect neither correctness nor flake-resistance.
- **security-auditor**: not invoked — proportionate. The only DB touch is the local-stack service-role fixture, which was EXTRACTED to `e2e/fixtures/db.ts` (not newly introduced); 078's audit already cleared it, and the `assertLocalStack` prod-URL guard is byte-for-byte unchanged. The 5 testIDs are production-inert selector hooks. No new auth/secret/RLS surface. The code + test fan-out is the right proportion for this spec.
- **test-engineer**: PASS. 18/18 ACs covered, all load-bearing. Self-ran all four tracks: jest 386/386 (40 suites), pgTAP 38/38, e2e tsc exit 0, Playwright 14/14. Anti-vacuous audit clean: the spec-072 scroll guard runs at 375×812 (not vacuously at desktop) with the `scrollHeight>clientHeight` tripwire firing first; the EOD persistence service-role read is value-matched to this run's `7` (not row-presence-only) and `todayIso()` mirrors the app's LOCAL-time derivation; the invite durable-effect is keyed off the run-unique email; the spec-074 window E2E is correctly NOT included (date-keyed-fixture complexity + pgTAP-Towson arm-C collision; already covered by 8+ injected-clock jest tests).
- **backend-architect (post-impl)**: not invoked — proportionate. Zero schema/RPC/RLS/migration surface (test infra + inert testIDs); nothing for a drift review to check.

## Recommended next steps (ordered)
SHIP_READY:
1. Commit and deploy. The commit is the user's to authorize (main Claude does not auto-commit on SHIP_READY).
2. On push, both `test.yml` (the gate) and `e2e.yml` (now proven green from the 078-fix push) will run. Per the CLAUDE.md CI rule, confirm the latest `test.yml` run on `main` is green after the push before continuing pipeline work.
3. (Follow-up, non-blocking) This Phase-2 deepening counts toward the AC-PROMO1 promotion clock (>=20 consecutive green runs on `main` AND observed flake rate <5%) that would flip `e2e.yml` from advisory to a required gate. Flipping the gate remains a separate user-authorized follow-up; this spec makes the bar reachable, it does not flip it.
4. (Follow-up, optional) The 7 deferred Nits are cosmetic and can be folded into a later housekeeping pass if desired.

Note on production footprint: this spec applies NO prod migration, but it DOES touch 3 production `src/` files — `EODCount.tsx`, `TreeGroup.tsx`, `ReorderSection.tsx` — for inert `testID` props only (no behavior change). These ship via the web deploy (`npx expo export --platform web` -> Vercel); no DB/RPC/RLS/edge surface is altered.

## Out of scope for this review
- **Spec-074 dashboard-window E2E (Monday-reset attention queue).** Deferred to a future spec 080 candidate — needs a date-keyed past-dated missed-order fixture the current weekday-keyed harness can't produce, and a Towson-based fixture would collide with the pgTAP `missed_order_audit_rpc` arm-C assertion. Already covered by 8+ deterministic injected-clock jest tests; correctly carries zero test code here.
- **Promoting `e2e.yml` to a required/gating check.** Separate user-authorized follow-up once the AC-PROMO1 bar is met.
- **A Reorder mutating action (mark-ordered / generate PO).** That product surface does not exist; the reorder deepening uses the export/refresh surface that does.
- **Service-role reads beyond the single EOD persistence spot-check.** The lone read is the documented exception, not a pattern to spread.
- **New browser projects (Firefox/WebKit), parallelism, native/Detox E2E, visual-regression.** All locked out by spec 078.
