# Release proposal — spec 085 (admin-initiated password reset, recovery landing flow)

## Verdict
verdict: SHIP_READY
rationale: Zero Critical from any of the four reviewers, both code-reviewer Should-fixes already folded in and re-verified, latest `test.yml` on `main` green — the CODE is commit-able; the END-TO-END PROD FIX requires the user-owned dashboard/env steps in the checklist below.

> READ THIS FIRST — partial ship. Committing the code does NOT by itself fix prod.
> The recovery flow pivoted from PKCE to `token_hash` (`verifyOtp`) because PKCE
> provably fails cross-device (the admin triggers the reset in their browser; the
> target clicks the link in a different browser with no code-verifier). `token_hash`
> is stateless and works cross-device, but it is driven by the prod email template,
> which is a USER-OWNED dashboard edit. The local stack already demonstrates the fix
> (`supabase/config.toml` + `supabase/templates/recovery.html` are committed local
> mirrors); prod has no local equivalent and needs the manual steps below.

## Findings summary
- **code-reviewer**: 0 Critical / 2 Should-fix / 2 Nits. Both Should-fixes RESOLVED by main Claude's fix-pass (see code-reviewer.md "## Resolution"): (1) dead `exchangeError` state in `RecoveryScreen.tsx` removed (removal chosen deliberately to align with security item 7 — friendly error shows generic copy, never raw GoTrue text); (2) the two missing `recovery-implicit` branch cases added to `recoveryRedirect.test.ts`. Re-verified: `jest src/lib/recoveryRedirect src/screens/RecoveryScreen` 21/21 green, both typechecks exit 0. The 2 Nits (misleading `safeDecode` comment; hardcoded-English strings matching the `LoginScreen` idiom) are cosmetic and deferred.
- **security-auditor**: 0 Critical / 0 High / 0 Medium / 3 Low. High bar held for a credential surface and PASSED on all seven load-bearing checks: token scrubbed from URL via `history.replaceState({}, '', pathname)` before any nav (no history/referer/screenshot leak); token never logged/toasted/sent to analytics (grep: zero `console.*`/`notifyBackendError`/`analytics` in the new files); `updateUser({ password })` gated behind a real server-side `verifyOtp({ token_hash, type: 'recovery' })` session; `flowType: 'pkce'` independently re-derived as inert for every existing auth path; `config.toml`/`recovery.html` are local-stack only with no secrets and no prod weakening; friendly error leaks no token/internal-error/user-existence oracle. The lone `npm audit` high (`@xmldom/xmldom`) is a pre-existing build-time Expo-toolchain dep NOT introduced by this spec and not runtime-reachable. The 3 Lows are defense-in-depth/docs (see optional follow-ups).
- **test-engineer**: 9 PASS / 0 FAIL on acceptance criteria. AC2 (native) is documented dead-code pending Q1 (NOT a test gap — the native branch is behind `Platform.OS` with a `TODO(spec-085 Q1)` marker; the native URL parser IS unit-tested). Full jest 447/447 (47 suites), 37 new tests across 3 new files, both typechecks exit 0, pgTAP 40/40 — the `config.toml` + `recovery.html` change did NOT break the local/CI stack. Live-token happy path and synthetic-`otp_expired` boot verified manually via Playwright/chromium (screenshots `/tmp/spec085-*.png`); acceptable per spec §11 (a real email round-trip is infeasible in jest).
- **backend-architect (post-impl)**: MATCHES DESIGN, 0 Critical / 0 Should-fix / 2 Minor (both acceptable judgment calls). The PKCE→`token_hash` pivot is exactly the escalation design §1/§9 specified — isolated to `establishRecoverySession` + the email template, with the parser correctly treating `token_hash` as primary and `?code=`/implicit as defensive fallbacks. Explicit architectural ruling on the one open question: **KEEP `flowType: 'pkce'`** — behavior-preserving no-op for every existing path (traced + dev-re-verified), strictly additive (enables the same-device `?code=` fallback against the most-likely prod template misconfiguration). Boot gate renders outside the single NavigationContainer with no `linking` (spec 063 contract intact); scope fully contained (no migration / edge function / RLS / `useStore.ts` change).

## CI gate status (hard-rule check)
Latest `test.yml` run on `main` is GREEN — run 26730015457 (spec 084, head `5e1d2e1`); nothing has pushed to `main` since. The "no SHIP_READY on red main" hard rule is satisfied.

## Recommended next steps (ordered)

This is SHIP_READY but a PARTIAL ship: step 1 commits the code; steps 2–4 are the
USER-OWNED actions required for the prod fix to actually work. The single most
load-bearing step is the prod email-template edit (step 3) — without it, prod
recovery links keep failing cross-device, which is the exact bug this spec fixes.

1. **Commit the working-tree changes.** Covers the new files + the changed files:
   - New: `src/lib/recoveryUrl.ts`, `src/lib/recoveryRedirect.ts`,
     `src/navigation/RecoveryGate.tsx`, `src/screens/RecoveryScreen.tsx`,
     `src/lib/recoveryUrl.test.ts`, `src/lib/recoveryRedirect.test.ts`,
     `src/screens/RecoveryScreen.test.tsx`, `supabase/templates/recovery.html`.
   - Changed: `App.tsx`, `jest.config.js`, `src/lib/supabase.ts`, `src/lib/auth.ts`,
     `supabase/config.toml`, `package.json` + `package-lock.json`, and `specs/085/`.
   - NOT changed (correct): `app.json` (no `scheme` — Q1, user-gated).
   - This work is currently UNSTAGED/uncommitted; per project policy main Claude does
     not auto-commit — the user confirms the commit at the gate.
   - After the push to `main`, confirm the next `test.yml` run on `main` is green
     (CLAUDE.md CI-status-check rule) before any further pipeline work.

2. **[USER — Supabase dashboard, PROD] Auth → URL Configuration.**
   - Set **Site URL** to the prod web domain (currently the dev default
     `http://localhost:3000` — this is defect #1 from the spec background).
   - Add the prod recovery redirect URL(s) to the **Redirect URLs** allowlist as a
     TIGHT exact-match entry (e.g. `https://<prod-domain>/reset-password`) — NOT a
     host-level wildcard (security-auditor Low #2: a wide-open prod allowlist would
     let a recovery link be redirected to an attacker origin carrying the `token_hash`).

3. **[USER — Supabase dashboard, PROD] Auth → Email Templates → Reset Password — NOW REQUIRED (the single most load-bearing step).**
   - Because the flow is `token_hash`, the prod template MUST emit
     `?token_hash={{ .TokenHash }}&type=recovery` (mirror of the committed
     `supabase/templates/recovery.html`), e.g.:
     `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Set a new password</a>`
   - If left as the default `{{ .ConfirmationURL }}` (`?code=` PKCE), prod links will
     keep failing cross-device — the exact bug class this spec fixes. This is a
     REQUIRED step for PROD, not optional. (Local has no dashboard equivalent; it is
     driven by the committed `config.toml` + `recovery.html` mirrors.)

4. **[USER — Vercel] Q2 — set `EXPO_PUBLIC_WEB_RECOVERY_URL`.**
   - Set the env var to the prod recovery URL (`https://<prod-domain>/reset-password`,
     equal to the step-2 allowlist entry). Until set, the web path falls back to
     `window.location.origin + '/reset-password'`, which is correct for local dev only.

5. **(Optional) Local-dev mirror artifacts.** `supabase/config.toml` (localhost
   redirect entries + `[auth.email.template.recovery]` block) and
   `supabase/templates/recovery.html` are committed as clearly-commented local mirrors
   so the local stack demonstrates the flow; they require
   `npx supabase stop && npm run dev:db` to take effect and DO NOT affect prod. If you
   prefer not to carry local email-template config in the repo, they can be reverted
   without changing prod behavior (the dev flagged this for your review).

6. **(Optional) Security defense-in-depth follow-ups (NOT blockers).**
   - Low #1: confirm the prod Auth → Policies `minimum_password_length` is >= 8 so the
     server floor matches the client's length-8 UI promise.
   - Low #3: the local `:8081` path-wildcard redirect entries are fine for dev (fixed
     localhost origin); keep the PROD allowlist exact-match per step 2.

## Out of scope for this review
- **Q1 — native deep-linking.** Adding a `scheme` to `app.json` is user-approval-gated
  (CLAUDE.md). Until approved, the native branch is intentional dead code behind
  `Platform.OS` with a `TODO(spec-085 Q1)` marker; native is a FOLLOW-UP, not part of
  this increment. The web half ships independently with zero dependency on Q1.
- **Self-service "Forgot password" on the login screen.** Explicitly out of scope —
  the model stays admin-initiated; the recovery screen directs the user to ask an
  administrator for a new link.
- **`@xmldom/xmldom` high (`npm audit`).** Pre-existing build-time Expo SDK 54
  toolchain dependency, not introduced by this spec and not runtime-reachable;
  security-auditor recommends tracking the Expo-toolchain upgrade as its own
  housekeeping item.
- **Live-token / cross-device automated e2e.** Needs a real email round-trip + live
  token, infeasible in jest (spec §11); covered by the developer's manual Playwright
  verification.
