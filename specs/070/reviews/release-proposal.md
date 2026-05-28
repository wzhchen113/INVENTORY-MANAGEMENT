# Release proposal — spec 070 (staff app UI/UX redesign)

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical; both code-reviewer Should-fix items are already resolved in a post-review FE fix-pass, and the staff suite is green (70/70) with a clean typecheck.

## Review scope note (why only two reviewers)
Spec 070 is a **pure frontend / theme** change — a clean-modern re-skin of the
staff EOD surface plus an OS-driven dark mode. The spec's own scope is explicit:
no migrations, no RLS, no edge functions, no `src/lib/db.ts`, no realtime, no
`profiles.dark_mode` write, no `RoleRouter`/NavigationContainer touch, no
`app.json` slug change (spec §"Out of scope" and §"Project-specific notes":
Migrations needed: No; Edge functions touched: None). With no backend, auth, or
data-scope surface, there is nothing for **security-auditor** or the post-impl
**backend-architect** to assess — running them would produce empty reports. The
proportionate fan-out for this spec is **code-reviewer + test-engineer**, which
is what was run. This is the correct set, not a gap.

## Findings summary
- **code-reviewer**: 0 Critical, 2 Should-fix, 4 Nits. Top issues (BOTH Should-fix now fixed):
  - Should-fix #1 — `Banner` carried `borderRadius: radius.lg` (16) but no `marginHorizontal`, so its soft-card corners were occluded flush at the safe-area edges (§6 card-corner intent silently unrealized). **Fixed**: `marginHorizontal: spacing.lg` added to `styles.banner`.
  - Should-fix #2 — `Button.tsx` registered an empty `styles.primary: {}` applied on every primary render (dead StyleSheet entry implying structural rules that live elsewhere). **Fixed**: empty `primary` removed; style array switched to `!isPrimary && styles.secondary` so only the outline variant carries structural chrome.
  - Nit #1 (`signOutBtn` hardcoded `minHeight: 44` vs the `touchTarget.min` token) — **also fixed** (token imported into EODCount, value swapped to `touchTarget.min`).
  - Nits #2 (`makeToneStyles` per-render allocation) and #3 (three `useColorScheme()` subscriptions in `ListRow`) — left as-is; reviewer marked them optional / spec-sanctioned (the §6 ListRow spec explicitly allows the direct `useColorScheme()` call).
  - Nit #4 (`StorePicker` root `View` not `SafeAreaView`) — **pre-existing from spec 062, not introduced by 070**; logged as a follow-up candidate, out of scope here.
- **security-auditor**: not invoked — no security surface (pure frontend; no auth/RLS/SQL/edge-function/secret handling). See scope note.
- **test-engineer**: verdict **PASS**. Staff suite green at **9 suites / 70 tests** (up from 8/58). Closed two real coverage gaps it found during review: (1) added 6 `makeElevation` tests to `theme.test.ts` (the spec §3 mandated `makeElevation` stay unit-testable but it had zero tests); (2) created `ListRow.test.tsx` (6 tests covering both the `Pressable` and non-pressable `View` branches, including a `backgroundColor` non-null assertion that would have caught the original flat-card regression where a dropped style function shipped flat cards). **Acceptance criteria AC1–AC9, AC11, AC12: PASS.** AC10 (browser screenshots) is its one NOT-TESTED item — see below.
- **backend-architect (post-impl)**: not invoked — no contract/drift surface (no backend changed). See scope note.

### Acceptance-criteria status (from test-engineer)
- AC1–AC9, AC11, AC12 — **PASS** (mix of unit-tested, behavioral, and design-math-spot-checked).
- AC10 (4 browser-verified screenshots, light/dark × StorePicker/EODCount) — **NOT TESTED by the test-engineer** (no browser access in the test run). The frontend-developer captured 5 screenshots over headless Chrome (spec §"Verification performed") and confirmed both themes; the AC requires their capture, which the spec records as done. test-engineer raised one **non-blocking process note**: the screenshots live at ephemeral `/tmp/070-*.png` paths rather than committed fixtures / CI artifacts — recommend capturing them as build artifacts in future screenshot-AC specs. This is a process improvement, **not a code defect and not a blocking Critical**.

## Independent verification (main Claude, post fix-pass)
- `npx tsc --noEmit` — clean (exit 0).
- `npx jest src/screens/staff` — 70/70 green.
- Cards confirmed **real** in the DOM and visually in BOTH themes — the View-drops-style-function bug that had shipped flat cards is fixed:
  - Light: white `#FFFFFF` card on `#F7F8FA` bg, layered `boxShadow`, `borderWidth: 0`.
  - Dark: `surface #1F2228` card, hairline `rgba(255,255,255,0.18)` border, `boxShadow`, `borderRadius: 16`, `flexDirection: row`.

## Recommended next steps (ordered)
SHIP_READY:
1. **Confirm the latest `test.yml` run on `main` is green, then commit and (web) deploy.** Per the CLAUDE.md hard rule, SHIP_READY is gated on the most recent `test.yml` run on `main` being green; spec 070 is not yet committed (Status `READY_FOR_REVIEW`, working tree clean). At commit time, run `gh run list --branch main --workflow test.yml --limit 1` and confirm green before/after the push. The commit is the **user's to authorize** — main Claude does not auto-commit on SHIP_READY. **This spec applies NO prod migration (pure frontend)**, so there is no DB-deploy or migration-drift step — web ships via the standard Vercel `expo export`.
2. (optional, non-blocking follow-ups — do NOT gate ship):
   - Capture screenshot-AC artifacts as committed fixtures or CI artifacts instead of `/tmp` paths (test-engineer process note).
   - `code-reviewer` Nit #2 (`makeToneStyles` direct lookup / `switch`) and Nit #3 (hook consolidation in `ListRow`) — cosmetic, optional.

## Out of scope for this review
- **`StorePicker` root `View` → `SafeAreaView`** (code-reviewer Nit #4) — pre-existing from spec 062, status-bar overlap risk on notched devices. Belongs in a small follow-up spec, not 070.
- **Interaction-flow rethink** (per-item steppers, entry-progress indicator, review-before-submit summary) — explicitly deferred by the user in the spec.
- **Staff-branded sign-in** (fork or conditionally theme `LoginScreen.tsx`) — separate, carefully-scoped decision; redesigning it would touch the shared admin login.
- **Manual light/dark override toggle + `profiles.dark_mode` persistence for staff** — spec ships system-driven (Q1→a) with zero settings UI; a manual toggle is a noted follow-up candidate.

## Handoff
next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/070/reviews/release-proposal.md
