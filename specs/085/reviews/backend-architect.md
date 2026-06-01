# Spec 085 — Backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Verdict: **MATCHES DESIGN** (with the designed-for token_hash pivot)
Findings: 0 Critical, 0 Should-fix, 2 Minor (both acceptable judgment calls), 1 architectural recommendation (the `flowType` question — answered: **KEEP**)

Scope reviewed: working-tree (`git diff HEAD`) changes for spec 085. Read every
file in `## Files changed`: `src/lib/recoveryUrl.ts`, `src/lib/recoveryRedirect.ts`,
`src/navigation/RecoveryGate.tsx`, `src/screens/RecoveryScreen.tsx`,
`src/lib/supabase.ts`, `src/lib/auth.ts` (sendPasswordReset), `App.tsx`,
`jest.config.js`, `supabase/config.toml`, `supabase/templates/recovery.html`, and
all three test files.

---

## Verdict against the 5 verification points

### 1. Flow pivot handled correctly — MATCHES DESIGN

The pivot from PKCE to `verifyOtp({ token_hash })` is **clean**, not half-wired.

- `establishRecoverySession` (`src/lib/recoveryRedirect.ts:79-106`) dispatches on
  `parse.kind` with `recovery-token-hash` (the chosen flow) as the FIRST branch,
  calling `supabase.auth.verifyOtp({ token_hash, type: 'recovery' })`. The
  `recovery` (PKCE `?code=`) branch is retained below it as the documented
  same-device defensive fallback, and `recovery-implicit` as the hash fallback.
  This is exactly the escalation my design §1/§9 specified: "pivot
  `establishRecoverySession` to `verifyOtp({ token_hash })` … The design isolates
  this to one function + one manual step." The dev changed precisely that one
  function plus the email template — nothing else in the exchange path.
- The parser (`src/lib/recoveryUrl.ts`) treats **token_hash as primary**: in
  `parseMerged` (lines 75-118) the precedence is `error` → `token_hash` (gated on
  `type === 'recovery'`) → `code` (defensive PKCE) → `access_token` (defensive
  implicit) → `none`. token_hash wins over `?code=` when both are present
  (test `recoveryUrl.test.ts:24-30`), and the `type === 'recovery'` gate prevents
  hijacking signup/email-change token_hash links (`recoveryUrl.test.ts:19-22`).
  This is a correct, more-defensive shape than my original design's
  `{ kind: 'recovery'; code }`-primary union — the dev widened the union to add
  `recovery-token-hash` and demoted `recovery` to fallback, which is the right
  call for the pivot.
- Error-wins-over-everything is preserved end-to-end, including when an error sits
  in the fragment while a token_hash/code sits in the query
  (`recoveryUrl.test.ts:65-79`). An `otp_expired` link therefore always reaches
  the friendly state, never a broken exchange attempt — matches my §3 requirement.

No PKCE residue left dangling: the `?code=` path is intentionally retained, doc-
commented as same-device-only, and covered by a test (`recoveryRedirect.test.ts:174-182`).

### 2. `flowType: 'pkce'` retention — RECOMMENDATION: **KEEP** (not drift)

This is the one genuinely-architectural open decision. My ruling as architect: **keep `flowType: 'pkce'`.** Rationale:

- **Blast radius of keeping it is zero for existing flows — and that was traced,
  not assumed.** My design §1 table enumerated every auth entry point
  (`signInWithPassword`, invited-user `signUp` with no redirect leg, `getSession`
  restore, `setSession` dev-inject, web `detectSessionInUrl`) and showed
  `flowType` only governs the OAuth/magic-link/recovery `?code=` redirect family —
  inert for password-grant and inline-session flows. The dev independently
  re-verified this on the local stack ("admin login + session-restore still work
  post-change", spec "Flow decision" + the comment block at
  `src/lib/supabase.ts:27-35`). So keeping `'pkce'` does NOT change behavior for
  anything shipping today.
- **Reverting buys nothing and costs a defensive leg.** Recovery now rides
  token_hash, which is flowType-agnostic — so reverting to implicit/default would
  not affect the primary recovery path either. The only thing reverting would do
  is disable the same-device `?code=` defensive fallback in
  `establishRecoverySession` (a prod email template that still emits the default
  `{{ .ConfirmationURL }}` would then fail with no fallback at all, instead of
  failing only cross-device). Given the manual prod template edit is the single
  most fragile user-owned step (§10 step 3), keeping the `?code=` fallback wired is
  defense-in-depth against exactly the misconfiguration most likely to happen.
- **The change is one line on a shared client, but it is a no-op net change.** The
  "unnecessary global-auth-client change" concern is real in principle, but here
  the change is provably behavior-preserving for every non-recovery path and
  strictly additive (enables a fallback) for the recovery path. The cost/benefit
  favors keeping.

This is a defensible KEEP, not drift. If a future spec adds an OAuth or magic-link
flow, `flowType: 'pkce'` becomes load-bearing for that flow and this decision
should be re-confirmed there — but for spec 085 it is correct as-is. (Documented
so the next reader doesn't mistake it for accidental drift.)

### 3. Boot-gate placement — MATCHES DESIGN

`RecoveryGate` (`src/navigation/RecoveryGate.tsx`) wraps `<RoleRouter />` in
`App.tsx:345-347`, renders `<RecoveryScreen>` as a **sibling render branch
INSTEAD of** `children` when `parse.kind !== 'none'` (`RecoveryGate.tsx:102-106`),
and is therefore OUTSIDE RoleRouter's single `<NavigationContainer>`. No
react-navigation `linking` is enabled anywhere — confirmed by grep
(`App.tsx` has no `linking` prop; the gate uses `window.location` sync read on web
and `Linking.getInitialURL`/`addEventListener` on native, not nav routing). This
is exactly the §2 contract and preserves spec 063's single-NavigationContainer
constraint. Web detection is a synchronous first-render read
(`readRecoveryFromWebSync`, lines 35-42) mirroring `readCachedDarkModeSync`, so
RoleRouter never paints in the recovery case — no ordering hazard with the
`getSession()` cold-start effect, as my §2 "Ordering" note required. URL scrubbing
via `history.replaceState` is present (`scrubRecoveryUrl`, lines 47-54), matching
the `hydrateDevSessionFromUrl` hygiene precedent.

### 4. Scope containment — MATCHES DESIGN (confirmed NONE leaked)

- **No migration.** No spec-085 SQL file exists (`supabase/migrations/` grep for
  recovery/password-reset/085 returns only coincidental keyword hits in unrelated
  specs 006 / role-guard / invitations migrations). Confirms the §7 "no
  `db-migrations-applied` drift" claim.
- **No edge function.** No new function dir; `config.toml`'s 4 `verify_jwt = false`
  entries are the pre-existing `pwa-catalog` + `staff-*` settings (lines 407-421),
  untouched.
- **No RLS.** Recovery is GoTrue-only (`resetPasswordForEmail` / `verifyOtp` /
  `updateUser`) against `auth.users`; no `public.*` policy interaction. Matches §7.
- **No `src/store/useStore.ts` change.** The recovery flow is self-contained and
  pre-auth; the screen owns its 4-state machine and does not touch the admin
  Zustand store (`RecoveryScreen.tsx` imports `supabase` + `establishRecoverySession`
  only, no `useStore`). Matches §8; optimistic-then-revert / `notifyBackendError`
  correctly does NOT apply (no app-table mutation).
- **`config.toml` + `supabase/templates/recovery.html` are LOCAL-DEV only,** clearly
  comment-flagged as the local mirror of the user-owned prod dashboard steps
  (`config.toml:156-162`, `263-265`; `recovery.html:1-18`). `site_url` is left at
  the local default `http://127.0.0.1:3000` — the prod Site URL is correctly NOT
  touched (user dashboard step). Acceptable and matches the §10 documentation
  intent.
- **Native branch is dead code, scheme NOT written.** `app.json` has no `scheme`
  (Q1 still gated); the native `Linking.createURL` branch carries a
  `TODO(spec-085 Q1)` marker (`recoveryRedirect.ts:48-52`) and is guarded behind
  `Platform.OS`. Matches the design's web-first sequencing and the Q1 gate.

### 5. `redirectTo` resolution + `sendPasswordReset` return-shape — MATCHES DESIGN

- `resolveRecoveryRedirectUrl()` (`recoveryRedirect.ts:41-54`) implements the exact
  §4 three-way branch: web+env → `EXPO_PUBLIC_WEB_RECOVERY_URL`; web-dev →
  `window.location.origin + '/reset-password'`; native → `Linking.createURL`. Path
  constant `/reset-password` matches §4. Env var name matches the `EXPO_PUBLIC_*`
  convention.
- `sendPasswordReset` (`auth.ts:542-558`) passes `{ redirectTo:
  resolveRecoveryRedirectUrl() }` and **preserves `Promise<{ error: string | null }>`
  byte-for-byte** — error→`error.message`, success→`{ error: null }`, catch→fallback
  string. The `UsersSection` call site is untouched. Matches the §4 hard constraint
  ("return contract must not change"). Import added at `auth.ts:6`.

---

## Minor findings (both acceptable — noted, not drift)

**M1 (acceptable judgment call) — `MIN_PASSWORD_LENGTH = 8` vs local stack default 6.**
`RecoveryScreen.tsx:32` enforces a client-side floor of 8, while the local
`config.toml` GoTrue `minimum_password_length` is unmodified (Supabase default 6).
This is a *stricter* client floor than the server, so it can only reject early, never
admit a password the server would reject — safe, and the dev documented the rationale
in-line (lines 30-32). My §6 said "length ≥ 8 (matches no weaker than Supabase's
default min)". Acceptable. If the prod project sets a different minimum, the screen's
floor remains a safe lower bound. No action required.

**M2 (acceptable judgment call) — `additional_redirect_urls` uses `:8081` origins;
prod allowlist is user-owned.** `config.toml:163-169` allowlists the local Expo web
origins (`localhost:8081` / `127.0.0.1:8081`, with `/**`). This is local-dev only and
correct for the running Expo web port. The prod allowlist (and the
`EXPO_PUBLIC_WEB_RECOVERY_URL` value) remain user dashboard / Vercel steps per §10 —
correctly NOT hardcoded. Acceptable. One operational note for the user (not a code
finding): the local recovery email template hard-references `{{ .RedirectTo }}` which
GoTrue only honors when the requested `redirectTo` is in this allowlist — the entries
present cover the dev origin, so the local demo path is internally consistent.

---

## Notes on design deltas the dev introduced (all improvements, not drift)

- **Parser union widened** to add `recovery-token-hash` as the primary kind and
  demote `recovery` (`?code=`) to fallback. This is a direct and correct
  consequence of the token_hash pivot my design's §9 escalation called for; the
  original union (`recovery`-as-`?code=`-primary) assumed the PKCE-v1 choice that
  the empirical test overturned. The dev's union is the right shape for the
  as-shipped flow.
- **Email template now committed** at `supabase/templates/recovery.html` (local)
  and the prod template edit promoted from "skip unless pivot" to "REQUIRED" — this
  is precisely the §10 step-3 conditional firing because the §9 PKCE check failed.
  Matches the design's structured contingency.
- **`jest.config.js`** adds `expo-linking` to `RN_TRANSPILE_DEPS` because `auth.ts`
  now transitively imports it (untranspiled ESM). Necessary and correctly scoped —
  flagged in my §9 ("`expo-linking` version pin … via `npx expo install`"). The dev
  pinned `~8.0.12` via `npx expo install`, matching SDK 54.

## Test contract — satisfied (§11)

All three required jest suites are present and assert the design's contract:
`recoveryUrl.test.ts` (table-driven parser incl. token_hash-primary +
error-wins precedence + native deep-link), `RecoveryScreen.test.tsx` (4-state
machine, validation-before-`updateUser`, success/error CTAs, sign-out on
success), and `recoveryRedirect.test.ts` (per-platform `redirectTo` +
`sendPasswordReset` non-empty redirect + return-contract + `establishRecoverySession`
token_hash-primary/PKCE-fallback). The optional Playwright synthetic-expired slice
was satisfied via the dev's real-browser chromium verification (screenshots noted
in the spec), which exceeds the e2e bar I set.

---

## Summary

The spec-085 implementation **matches the architectural design as-pivoted**, with
zero Critical and zero Should-fix findings. The one designed-for deviation — the
PKCE→`token_hash` (`verifyOtp`) pivot — is exactly the escalation my design §1/§9
specified, isolated to `establishRecoverySession` plus the email template, with the
parser correctly treating token_hash as primary and `?code=`/implicit as defensive
fallbacks. The boot gate renders the recovery screen outside the single
NavigationContainer with no `linking` (spec 063 contract intact); scope is fully
contained (no migration, edge function, RLS, or `useStore.ts` change; native branch
dead-coded behind `Platform.OS` with the scheme correctly NOT written); and
`sendPasswordReset` preserves its `{ error }` return shape while gaining the
per-platform `redirectTo`. On the single genuinely-open architectural question —
whether to keep `flowType: 'pkce'` — my ruling is **KEEP**: it is a provably
behavior-preserving no-op for every existing auth path (traced in §1, re-verified by
the dev) and strictly additive for recovery (enables the same-device `?code=`
defensive fallback against the most-likely prod template misconfiguration), so
reverting would cost a defensive leg and buy nothing. The two Minor items are
acceptable judgment calls, not drift.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete for spec 085. Verdict MATCHES DESIGN
  (with the designed-for token_hash pivot). 0 Critical, 0 Should-fix, 2 Minor
  (acceptable judgment calls). Explicit ruling on the open `flowType: 'pkce'`
  question: KEEP (behavior-preserving for existing paths, additive defensive
  fallback for recovery). Awaiting the other reviewer files before
  release-coordinator synthesis.
payload_paths:
  - specs/085/reviews/backend-architect.md
