# Release proposal — spec 154: Phone-frame illustrations for the Add-to-Home-Screen tutorial

## Verdict

verdict: SHIP_READY
rationale: Zero Critical / High / Medium findings across all three reviewers, all 11 acceptance criteria PASS with independently reproduced gates (tsc, typecheck:test, jest 196/2067, web export exit 0), and the change is frontend-only with no backend, dependency, or asset surface.

## Findings summary

- **code-reviewer**: 0 Critical, 0 should-fix, 2 nits. Explicitly endorsed the three design calls the spec asked about — palette-as-prop (keeps spec-063 staff slice isolation intact: `StepIllustration.tsx` imports no theme hook, no catalog, no store), labels-as-prop from each surface's own catalog, and the `fontFamily` mono→system drop for the drawn OS labels ("good catch, well-reasoned, and honestly disclosed"). Independently verified the AC-5 no-color-literal claim (zero hex matches), the `Record<InstallArt, ArtSpec>` compile-time exhaustiveness, the single-`scale` SVG/RN-Text layering, and byte-identical `art.*` label reuse against each locale's existing spec-153 step prose (es and zh-CN spot-checked). Nits: (a) the a11y props shipped as `importantForAccessibility="no-hide-descendants"` (stronger than the spec's literal `"no"` / `accessibilityRole="image"` shorthand) but that deviation wasn't listed alongside the other two in the Implementation notes — documentation completeness only, no code change requested; (b) `ios-add-confirm` / `android-confirm` draw similar dialogs with independently authored geometry, explicitly noted as out-of-scope and *not* proposed for this spec (the two OS dialogs genuinely differ).

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 2 informational Lows. Nine-point checklist all clean: no new network/storage call, no store contract change, no PII or secrets in the new keys, no dependency added (`package.json` and `package-lock.json` absent from the diff), no injection surface (labels render as escaped RN `<Text>`, never `dangerouslySetInnerHTML` or raw SVG `<text>`), no unbounded arithmetic (both call sites clamp `width`, `scale` divides by a module constant), AC-REG3 confirmed by `git diff --stat`. The transitive-import isolation is the notable positive result: the chain `StepIllustration → installGuide → notificationState → webPush` is **type-only** at the last hop, so the supabase-touching `webPush` runtime module is never pulled into the staff bundle — spec-063 slice isolation survives the staff card reaching into shared `src/components/`. Trademark check clean: no vendor logo, wordmark, glyph trace or brand color; `appIcon()` draws an abstract three-bar mark in `P.highlight`; drawn strings are functional, localized OS labels. Lows: (1) `art.appName` hard-codes `"I.M.R"` in six files, duplicating the manifest `short_name` — drift surface for a future brand rename, not a security issue; (2) the trademark note itself, filed as a business call, "noted, not blocking."

- **test-engineer**: 8/8 primary ACs PASS, 3/3 regression ACs PASS, no FAIL and no NOT-TESTED. Gates re-run directly rather than taken from the spec: `npx tsc --noEmit` clean, `npm run typecheck:test` clean, `npx jest` 196 suites / 2067 tests / 2 snapshots green (matching the implementer's claimed delta from 195/2033 at spec 153), `npx expo export --platform web` exit 0 with no new files under `assets/` or `public/`. AC-REG1 diff discipline re-derived independently: `git diff --cached -U0 | grep -c '^-[^-]'` returns 0 removed lines in all three touched spec-153 test files (128 inserted, 0 deleted), and `ResponsiveCmdShell.spec153.test.tsx` is absent from `git status --porcelain` entirely — byte-for-byte unchanged since `63191f5`. AC-8 is structurally load-bearing, not just assertion-bearing: every illustration query passes `{ includeHiddenElements: true }`, so a query that starts passing without it is itself evidence the a11y hiding regressed. One non-blocking coverage gap flagged (see below).

- **backend-architect**: not invoked — correct for this spec. The diff contains no `supabase/**`, no `src/lib/db.ts`, no store slice, no `vercel.json`, no `app.json`; there is no contract to drift against.

## Recommended next steps (ordered)

1. **Commit the spec-154 changeset.** No fix round is required; no reviewer requested a code change. Per project convention the user runs the commit.
2. **Confirm both CI gates on `main` after the push.** `gh run list --branch main --workflow test.yml --limit 1` and `gh run list --branch main --workflow db-migrations-applied.yml --limit 1` must both be green before further pipeline work. Baseline going in is green at `63191f5` (spec-153 state). `db-migrations-applied` has nothing new to assert — this spec adds no migration — but the standing rule is to check both gates, not just `test.yml`.
3. **Deploy is automatic.** Vercel builds on push to `main` via `npx expo export --platform web`; that exact command already passed locally with exit 0. No migration to apply, no edge function to deploy, no environment variable to set.
4. *(Optional, non-blocking)* Post-deploy, eyeball the tutorial once on a **real iPhone Safari and a real Android Chrome**. This is the one surface no automated or manual pass in this spec covers — carried over from spec 153's existing manual-pass gap, not a hole this spec introduced. The implementer's headless-Chromium pass did cover admin sheet light + dark across all three tabs at 1440×900, admin fullscreen at the 390×844 phone breakpoint (opened from the hamburger drawer), and the staff Settings card at 390×844 as `manager@local.test`, all with zero console/page errors.

## Out of scope for this review

- **Light/dark illustration-color jest test** (test-engineer's minor gap). No suite renders `InstallGuideSheet`/`InstallGuideCard` under both a light-token and a dark-token stub and diffs the resulting illustration colors. Current coverage is reasonable indirect evidence — `StepIllustration` reads color purely off the `palette` prop with no light/dark branching, and the code-reviewer manually confirmed `accentBg` / `primaryPressedLight` exist in both modes of both token files. The residual risk is a *future* token-file edit silently returning `undefined` in dark mode with no automated signal. Belongs to a theme-token-coverage spec, not this one.
- **`appName` duplication across seven places** (security Low #1). The manifest `short_name` plus six catalog copies of `"I.M.R"`. A brand-rename or single-source-of-truth spec, not a spec-154 fix.
- **Shared `confirmDialog()` helper** for `ios-add-confirm` / `android-confirm` (code-reviewer nit #2). The reviewer explicitly did not propose landing it now; revisit only if a tenth art with the same shape appears.
- **A11y-deviation documentation** (code-reviewer nit #1). The shipped `"no-hide-descendants"` is the stronger behavior and is correct; only the Implementation-notes list is incomplete. Fold into the spec text at commit time if desired — it is a prose edit, not a code change, and the spec's `Status:` and content are the developer's/PM's to change, not mine.
- **Trademark posture** on stylized OS chrome (security Low #2). Explicitly framed as a business call rather than a security one; no IP exposure identified.

## Handoff

next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/154-install-tutorial-illustrations/reviews/release-proposal.md
