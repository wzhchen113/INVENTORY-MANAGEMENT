## Code review for spec 085

Reviewer: code-reviewer
Scope: working-tree (UNSTAGED) changes — every file listed under `## Files changed` in the spec.

---

### Critical

None.

---

### Should-fix

- `src/screens/RecoveryScreen.tsx:52-54,76` — `exchangeError` state is declared, initialized, and written via `setExchangeError(result.error)` in the exchange effect, but the variable itself is never read anywhere in the JSX. The error state (lines 147-171) always renders the hardcoded string "This reset link is invalid or has expired." regardless of what the exchange returned. This is dead state: the actual Supabase message from a `verifyOtp` failure (e.g. "Token has expired or is invalid") is silently discarded. Either remove `exchangeError` and `setExchangeError` entirely (if the intent is always to show the generic copy, which is defensible), or render the value as a secondary detail beneath the generic message so the developer can distinguish a genuinely expired token from an unexpected GoTrue error. As-is, TypeScript strict mode will not flag this (state writes are legal), and the linter won't catch it, so it requires manual attention.

- `src/lib/recoveryRedirect.test.ts` — the `recovery-implicit` branch of `establishRecoverySession` (lines 95-102 of `recoveryRedirect.ts`) is not covered. The mock stubs `supabase.auth.getSession` but no test exercises `{ kind: 'recovery-implicit', accessToken: 'tok' }` → `getSession` → `{ ok: true }` or `{ ok: false, error: 'recovery session missing' }`. This is a defensive fallback path, but the test suite covers every other branch (token_hash success, token_hash failure, `?code=` PKCE fallback, error-kind → no exchange). The gap means a regression in the implicit-branch dispatch would be invisible. Add two cases: one where `getSession` returns a session (`ok: true`) and one where it returns null (`ok: false`).

---

### Nits

- `src/lib/recoveryUrl.ts:120-130` — the `safeDecode` function's comment says "for callers that pass a raw value," but it is only ever called with the result of `URLSearchParams.get('error_description')`, which is already percent-decoded AND has `+` converted to spaces per WHATWG spec. The subsequent `decodeURIComponent(value.replace(/\+/g, ' '))` is a no-op in the happy path (both transforms are already done) and only triggers on a double-encoded `%25` edge case (which is caught and returns the original). The try/catch makes it safe, but the comment is misleading about when the extra decode step matters. Consider trimming it to: `// Belt-and-suspenders: URLSearchParams.get already decodes %xx and replaces +; this is only a safeguard against double-encoded values.`

- `src/screens/RecoveryScreen.tsx` — all user-visible strings are hardcoded English (`"Set a new password"`, `"Reset link expired"`, `"This reset link is invalid or has expired."`, `"Please enter a new password"`, `"Passwords do not match"`, etc.). This is consistent with `LoginScreen.tsx` (which likewise uses hardcoded strings for its form labels), so it is not a convention violation, but it is worth noting: if the codebase ever adds an i18n catalog entry for the admin surface, the recovery screen will need retrofitting. The pre-auth context (no store, no session) makes it genuinely awkward to use the existing locale machinery here, so the tradeoff is acceptable — just documenting for future reference.

---

### Summary

The implementation is well-structured. The pure parser (`recoveryUrl.ts`) is genuinely dependency-free, fully table-driven, and correctly handles the token_hash primary flow, the defensive PKCE and implicit fallbacks, and the error-wins-over-everything invariant. The gate (`RecoveryGate.tsx`) correctly renders outside RoleRouter's NavigationContainer with no `linking` config change, using the same synchronous-read-on-web + effect-on-native pattern as the existing dark-mode and locale hydration. Theme tokens are used consistently (no inline hex literals); `Colors` static tokens in `StyleSheet.create` + `useColors()` dynamic overrides in JSX mirrors the `LoginScreen` idiom exactly. The `window.*` accesses are properly guarded behind `Platform.OS === 'web'` checks. The native dead-code branch carries a clear `TODO(spec-085 Q1)` marker and is genuinely inert on web. The `app.json` slug and scheme are correctly untouched. The two Should-fix items are straightforward: remove or render the dead `exchangeError` state, and add the two missing `recovery-implicit` cases to `recoveryRedirect.test.ts`.

---

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 2 Should-fix, 2 Nits.
payload_paths:
  - specs/085/reviews/code-reviewer.md

---

## Resolution (post-review fix-pass — main Claude)

Both Should-fixes folded in; both Nits deferred (cosmetic).

- **Should-fix #1 (dead `exchangeError` state, `RecoveryScreen.tsx`)** — **fixed by removal.** Removed the `exchangeError`/`setExchangeError` state and the `setExchangeError(result.error)` write. Chose removal over rendering the raw value deliberately: the security-auditor (Low item / item 7) wants the friendly error to show generic copy and NOT surface raw Supabase error text (avoids an internal-error / user-existence info leak). Added an inline comment noting `result.error` is intentionally dropped. The error screen keeps its generic "This reset link is invalid or has expired." copy.
- **Should-fix #2 (untested `recovery-implicit` branch, `recoveryRedirect.test.ts`)** — **fixed.** Added a `getSessionMock` reference and two cases: `recovery-implicit` + session present → `{ ok: true }` (and asserts neither verifyOtp nor exchange is called); `recovery-implicit` + session absent → `{ ok: false, error: 'recovery session missing' }`.
- **Nits (2)** — deferred: the `safeDecode` comment wording (`recoveryUrl.ts`), and the hardcoded-English strings on the pre-auth recovery screen (matches the `LoginScreen` idiom; genuinely awkward to use the locale machinery pre-store — the reviewer agreed it's acceptable).

Re-verified post-fix-pass: `npx jest src/lib/recoveryRedirect src/screens/RecoveryScreen` → 21/21 green (incl. the 2 new implicit cases); `npx tsc --noEmit` (base) and `npx tsc -p tsconfig.test.json --noEmit` (test graph) both exit 0.
