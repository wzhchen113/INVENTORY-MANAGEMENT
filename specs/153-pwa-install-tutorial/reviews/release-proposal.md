# Release proposal — Spec 153: Add-to-Home-Screen (PWA install) tutorial

## Verdict

verdict: SHIP_READY
rationale: Zero Critical, High, Medium or Should-fix findings across all three reviewers; 15/15 acceptance criteria (11 AC + 4 AC-REG) PASS with gates reproduced independently (tsc clean, `typecheck:test` clean, jest 195 suites / 2033 tests green), and the UA-dependent ACs now have live-browser evidence from the dispatcher's 375px pass.

## Findings summary

- **code-reviewer**: 0 Critical / 0 Should-fix / 3 Nits.
  - Nit 1 — `installGuide.test.ts` glyph pin spot-checks one glyph per platform (ios ships 4 distinct glyphs, only 1 pinned); coverage-completeness, not correctness.
  - Nit 2 — install entry hand-duplicated between `sidebarFooterLeft` (text chip) and `railFooter` (glyph twin) rather than one `compact`-parameterized component; the `showInstallEntry` gate itself is computed once and reused correctly.
  - Nit 3 — sheet title uses the `Type.caption` token where the reference `PhoneNotifications.tsx` uses an inline `fontSize: 11` literal; the diff is the better of the two, noted only to pre-empt a diff-against-reference question.
  - All three implementer-flagged deviations explicitly **approved**: the extra `ResponsiveCmdShell.spec153.test.tsx` (follows the 19-precedent `specNNN` sibling convention, strict improvement over §7's "read the branches" fallback), the widened test-only `_resetInstallPrompt()`, and `promptInstall()` mapping a throwing `prompt()` to `'dismissed'`.
  - Verified clean on the five design risks that could have been Criticals: no module cycle (`installGuide → notificationState`, one-directional), `sw.js` no-op only, i18n parity across all six catalogs with no glyphs leaked, drawer-closes-before-sheet ordering present and pinned, `app.json` untouched.

- **security-auditor**: 0 Critical / 0 High / 0 Medium / 3 Low. Explicit "nothing blocks on security grounds."
  - Low 1 — `public/sw.js` no-op invariant is enforced only by a comment + spec prose (`public/` is unlinted and untested); suggests a one-assertion jest pin failing on `/respondWith|caches\./`. Drift prevention, **not required for this deploy**.
  - Low 2 — `notificationclick` passes `data.url` into `client.navigate` with no same-origin allowlist. **Pre-existing, not introduced here**; all three senders hard-code `url: '/'` and payloads are VAPID-signed. Explicitly out of scope for 153.
  - Low 3 — `_resetInstallPrompt()` is a test-only export present in the web bundle; matches the `sessionWatch._resetSessionWatch` precedent, holds no auth/data/privilege. Informational, no action requested.
  - Character-level diff confirms `sw.js` is exactly `self.addEventListener('fetch', () => {})` — zero `respondWith`, zero `caches.*`, zero precache, existing handlers byte-unchanged. The design's §6 hard prohibition (a `respondWith` here would MITM `/auth/v1` refreshes and PostgREST reads) is **not** violated. Manifest diff is exactly the one `"purpose"` token. AC-REG4 confirmed by grep: no `fetch`, no supabase client, no store import, nothing staged under `supabase/`.

- **test-engineer**: 15/15 PASS (AC-1…AC-11 + AC-REG1…AC-REG4). Gates reproduced independently and match the implementer's claim exactly: `npx tsc --noEmit` clean, `npm run typecheck:test` clean (confirms AC-3's `@ts-expect-error` `never` guard is live rather than dormant), `npx jest` 195/195 suites, 2033/2033 tests, 2 snapshots. AC-REG1 verified literally — `git diff --quiet HEAD -- src/lib/notificationState.test.ts` exits 0.
  - Coverage gaps, both explicitly ruled non-blocking: (a) `Settings.test.tsx` has no explicit off-web case for `InstallGuideCard`, relying on the structurally identical guard already pinned twice elsewhere in the diff; (b) the ios glyph pin from code-reviewer's Nit 1.
  - UA / `beforeinstallprompt`-dependent ACs (AC-9's live firing, the UA-detection portions of AC-1/AC-2/AC-4) were automated-verified-only at report time and deferred to the dispatcher's manual pass. **That evidence has since landed**: a live browser pass at 375px confirmed the drawer footer "install app" chip opens the sheet, the platform tab auto-detects (Desktop for the pane's UA), and the iPhone tab renders the correct Safari steps; the staff card is covered by jest. This closes the one open dependency in the test report.

- **backend-architect (post-impl)**: not invoked. Correct — the backend design section states the frontend-only verdict up front, AC-REG4 is binding, and all three reviewers independently confirmed a zero-hit grep across `supabase/**`, `src/lib/db.ts`, both Zustand stores, `cmdSelectors.ts`, `sidebarLayout.ts`, `vercel.json` and `app.json`. No contract exists to drift against.

## Recommended next steps (ordered)

1. **Commit and deploy.** Frontend-only; deploy is the Vercel build on push to `main`. No `supabase db push`, no migration, so the `db-migrations-applied.yml` gate has nothing new to check for this spec. Latest runs of both active gates on `main` are green as of the spec-152 state (`17e5fc6`); per CLAUDE.md, confirm both gates are green again on the post-push run before starting the next spec.

2. **Post-deploy operator note (surface to the owner, not a fix).** Chrome's one-tap install button may only appear from the **second** page load — a page is only *controlled* by a service worker after it activates and claims, so Chrome's installability heuristic may not see a controlled navigation with a fetch handler until the next load. Documented in the spec at §6.3. Reload once before concluding the button is dead. The manual steps are the actual deliverable and work regardless (§8.1: "the manual steps are the contract; the button is a bonus").

3. *(Optional, non-blocking follow-up)* Add security-auditor's one-assertion jest pin reading `public/sw.js` and failing on `/respondWith|caches\./`. Cheap, durable, and makes the "no interception" invariant survive the next person who wants offline support. Not required for this deploy.

4. *(Optional, non-blocking follow-up)* Extend `installGuide.test.ts`'s glyph pin to all four ios glyphs (code-reviewer Nit 1 / test-engineer's echo of it), and optionally add the explicit off-web `InstallGuideCard` case to `Settings.test.tsx`. Both are completeness, not correctness.

## Out of scope for this review

- **`notificationclick` same-origin guard on `public/sw.js`** (security-auditor Low 2). Pre-existing, VAPID-signed, all senders hard-code `url: '/'`. Belongs in whichever spec next touches `sw.js` — add `new URL(target, self.location.origin).origin === self.location.origin` then.
- **Q2 — "Show me how" link from the existing `needs-install` notification hint.** Left at its documented default (no). Trivially additive later; deliberately not opportunistically implemented.
- **Q5 — first-run install nudge.** Left at its default (no). Would need a `profiles`-level per-user dismissed flag and its own design.
- **Q7 — literal OS screenshots.** Rejected in this spec for i18n/theming/staleness/asset-weight reasons. If the owner overrules, it is a separate spec with its own asset pipeline and an accepted loss of i18n inside the images.
- **A real admin Settings section.** This spec adds one footer entry, not a settings home — deliberately avoiding the spec-008 sidebar-override machinery. Its own spec if wanted.
- **Cmd rail/footer chip factoring** (code-reviewer Nit 2) and the general `'#000'`-on-accent / section file-split items already tracked in the cleanup backlog.

## Handoff

next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/153-pwa-install-tutorial/reviews/release-proposal.md
