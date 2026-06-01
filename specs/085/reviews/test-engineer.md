## Test report for spec 085

### Acceptance criteria status

- **AC1: Web (prod + local dev) — recovery email link lands on set-new-password screen, establishes recovery session, calls `updateUser({ password })`, user can sign in** → PASS
  - `src/screens/RecoveryScreen.test.tsx::RecoveryScreen — recovery parse → form::establishes the session on mount and shows the form`
  - `src/screens/RecoveryScreen.test.tsx::RecoveryScreen — recovery parse → form::calls updateUser once with a valid matching password and shows success`
  - `src/lib/recoveryRedirect.test.ts::establishRecoverySession::redeems the CHOSEN token_hash flow via verifyOtp`
  - The full end-to-end web happy path (real token → real browser → real `updateUser`) was verified MANUALLY by the developer via Playwright/chromium screenshots in `/tmp/spec085-*.png`. Automated coverage exists for the mocked `updateUser` path; the live-token loop requires a real email round-trip and is documented as manual-only (spec §11 acknowledges this). This is an acceptable gap given the constraints of a cross-device recovery flow.

- **AC2: Native (Expo iOS/Android) deep-link flow works** → NOT TESTED (dead code, by design)
  - The native branch (`Linking.getInitialURL`, `Linking.addEventListener`, `Linking.createURL`) is implemented behind `Platform.OS !== 'web'` guards in `RecoveryGate.tsx` and `recoveryRedirect.ts`, with a `// TODO(spec-085 Q1)` marker. The native branch cannot function without an `app.json` `scheme`, which requires explicit user approval (Q1, still pending). The dev intentionally left this as dead code. `parseRecoveryFromUrl` (native entry) IS unit-tested; the gate's `getInitialURL` wiring is not component-tested (it's dead until Q1).
  - **This is a documented known gap — Q1 is a prerequisite, not an oversight.**

- **AC3: `redirectTo` is passed — `sendPasswordReset` sends a per-platform non-empty `redirectTo`** → PASS
  - `src/lib/recoveryRedirect.test.ts::sendPasswordReset::passes a non-empty redirectTo matching the running platform and returns { error: null } on success`
  - `src/lib/recoveryRedirect.test.ts::resolveRecoveryRedirectUrl::returns the EXPO_PUBLIC_WEB_RECOVERY_URL env value on web when set`
  - `src/lib/recoveryRedirect.test.ts::resolveRecoveryRedirectUrl::falls back to window.location.origin + /reset-password on web dev`
  - `src/lib/recoveryRedirect.test.ts::resolveRecoveryRedirectUrl::uses Linking.createURL on native`
  - Implementation confirmed: `src/lib/auth.ts:550-551` passes `{ redirectTo: resolveRecoveryRedirectUrl() }` and the return shape is `Promise<{ error: string | null }>` (unchanged per AC8).

- **AC4: Recovery session caught without enabling RoleRouter `linking`** → PASS (structural verification)
  - `App.tsx:345-347` confirms `<RecoveryGate>` wraps `<RoleRouter />` — the recovery screen renders as a sibling branch OUTSIDE the NavigationContainer.
  - `src/navigation/RecoveryGate.tsx` confirms: web synchronous read on first render (before RoleRouter paints); native `getInitialURL` + `addEventListener`; when `parse.kind !== 'none'` renders `<RecoveryScreen>` INSTEAD of `children`.
  - `src/navigation/RoleRouter.tsx` was not changed — `linking` remains off.
  - Structural: no automated test directly asserts "linking is off," but the file is unmodified and the architectural constraint is enforced by the gate rendering strategy itself.

- **AC5: Password validation — length/confirm-match before `updateUser`, field-level errors** → PASS
  - `src/screens/RecoveryScreen.test.tsx::RecoveryScreen — recovery parse → form::rejects a too-short password and does NOT call updateUser`
  - `src/screens/RecoveryScreen.test.tsx::RecoveryScreen — recovery parse → form::rejects mismatched passwords and does NOT call updateUser`
  - Implementation: `RecoveryScreen.tsx` enforces `MIN_PASSWORD_LENGTH = 8` (client-side) and confirm-match before calling `updateUser`. Field-level `testID="recovery-field-error"` node is rendered for each validation failure.

- **AC6: Success state — clear confirmation and routed to sign-in portal** → PASS
  - `src/screens/RecoveryScreen.test.tsx::RecoveryScreen — recovery parse → form::calls updateUser once with a valid matching password and shows success`
  - `src/screens/RecoveryScreen.test.tsx::RecoveryScreen — recovery parse → form::success CTA signs out and calls onExit`
  - `testID="recovery-success"` and `testID="recovery-success-continue"` are both tested. `signOut()` is called before `onExit()`, which tears down the gate and lets `RoleRouter` render `LoginScreen`.

- **AC7: Friendly expired/invalid-link handling — `otp_expired` or any error fragment shows "This reset link is invalid or has expired" + path to request a new link** → PASS (automated) + PARTIAL (manual for live `otp_expired` URL)
  - Automated: `src/screens/RecoveryScreen.test.tsx::RecoveryScreen — error parse::renders the friendly expired state and never establishes a session or calls updateUser`
  - `RecoveryScreen.tsx:153`: renders "This reset link is invalid or has expired." with a "Back to sign-in" CTA and copy directing user to "ask your administrator to send you a new reset link."
  - `src/lib/recoveryUrl.test.ts::parseRecoveryFromWebLocation::parses an otp_expired error fragment as an error` — the parser correctly recognizes the exact URL from the bug report.
  - Developer also verified the friendly error UI boots correctly with a synthetic `#error=access_denied&error_code=otp_expired` fragment via Playwright/chromium screenshot (`/tmp/spec085-*.png`). URL scrubbing (`history.replaceState`) is in `RecoveryGate.tsx:48-53`; the raw fragment is not left in the address bar.
  - Live `otp_expired` with a real expired token is inherently manual — acceptable per spec §11 ("the jest screen test already covers the error state's logic; the e2e only adds the boot-gate integration").
  - No self-service "Forgot password" entry point is present — the screen copy instructs contacting an administrator (out-of-scope requirement preserved).

- **AC8: `sendPasswordReset` return contract preserved — `Promise<{ error: string | null }>`** → PASS
  - `src/lib/recoveryRedirect.test.ts::sendPasswordReset::passes a non-empty redirectTo...and returns { error: null } on success`
  - `src/lib/recoveryRedirect.test.ts::sendPasswordReset::surfaces the Supabase error message and preserves the { error } contract`
  - `src/lib/recoveryRedirect.test.ts::sendPasswordReset::catches a thrown error and returns a fallback message`
  - `src/lib/auth.ts:542` signature: `Promise<{ error: string | null }>` — unchanged. `UsersSection.tsx` call site is unmodified.

- **AC9: Tests (jest) — (1) recovery-URL parser (web hash + native URL → recovery/error/none), (2) set-new-password screen validation + `updateUser` call (mocked), (3) `sendPasswordReset` per-platform `redirectTo`** → PASS
  - (1) `src/lib/recoveryUrl.test.ts` — 13 cases in `parseRecoveryFromWebLocation` + 6 cases in `parseRecoveryFromUrl` (native deep link). Covers: token_hash primary flow, PKCE `?code=` fallback, implicit `#access_token` fallback, `otp_expired` hash fragment, PKCE query error shape, no params → none, error-wins-over-code, error-wins-over-token_hash, non-recovery type guarding, tolerates missing leading `?`/`#`.
  - (2) `src/screens/RecoveryScreen.test.tsx` — 8 cases: error parse → friendly state (no session/updateUser), error CTA → onExit, recovery mount → session established → form shown, exchange failure → error state, short password rejected, mismatch rejected, valid → updateUser called once → success, updateUser error → stays on form, success CTA → signOut + onExit.
  - (3) `src/lib/recoveryRedirect.test.ts` — covers `resolveRecoveryRedirectUrl` (3 cases: env var, web dev fallback, native `Linking.createURL`), `sendPasswordReset` (3 cases: success with non-empty redirectTo, Supabase error, thrown error), `establishRecoverySession` (4 cases: token_hash success, token_hash failure, `?code=` fallback, error parse → no exchange).


### Test run

**jest (full suite):**
```
npx jest --no-coverage
Test Suites: 47 passed, 47 total
Tests:       447 passed, 447 total
Snapshots:   0 total
```
No regressions. 3 new test files (37 new tests) all green.

**Targeted new files:**
```
npx jest src/lib/recoveryUrl.test.ts src/lib/recoveryRedirect.test.ts src/screens/RecoveryScreen.test.tsx --no-coverage
Test Suites: 3 passed, 3 total
Tests:       37 passed, 37 total
```

**Typechecks:**
- `npx tsc --noEmit` → exit 0 (no output)
- `npx tsc -p tsconfig.test.json --noEmit` → exit 0 (no output)

**pgTAP DB tests:**
```
npm run test:db
40/40 DB test file(s) passed
```
All 40 pgTAP test files pass. The `supabase/config.toml` changes (redirect allowlist + `[auth.email.template.recovery]` block) and the new `supabase/templates/recovery.html` did NOT break the local stack. The auth container started at 2026-06-01T02:40:52, after the template file was written (May 31 22:40), confirming the stack was booted with the new config already in place. pgTAP passes 40/40 — no regressions, no CI-breaking blocker.

**Note on `console.warn EXPO_OS` noise:** The full jest run emits `console.warn: The global process.env.EXPO_OS is not defined` from several test suites in the "unit" jest project that transitively import `auth.ts → recoveryRedirect.ts → expo-linking`. This is a known informational warning from `expo-modules-core` running in the Node test environment (not a test failure). `expo-linking` is correctly added to `jest.config.js RN_TRANSPILE_DEPS` (spec 085 §12) and all tests pass; the warning is pre-existing behavior for any Expo module used in the unit jest project.


### Notes

1. **PKCE → token_hash pivot:** The architect specified PKCE but the dev empirically verified it fails cross-device and pivoted to `verifyOtp({ token_hash })` per the architect's documented escalation path (spec §9). This is the correct behavior: the spec says "if it fails, pivot to `verifyOtp`." The tests are written for the token_hash primary path with the PKCE branch retained as a defensive fallback — matches the implementation.

2. **Native AC (AC2) is dead code until Q1 approval:** The native deep-link half is implemented behind `Platform.OS` guards but non-functional without an `app.json` `scheme`. This is NOT a test gap — it is the correct "not yet" state pending explicit user approval. The spec explicitly calls this out as a non-build-blocker. The parser's `parseRecoveryFromUrl` IS tested (6 native URL cases); only the gate's `getInitialURL` wiring is untested, and it's dead without the scheme.

3. **Cross-device token_hash behavior (live-token):** Inherently requires a real email round-trip and a live stack — cannot be automated in jest. Developer verified manually on the local stack (evidence cited in spec "Flow decision" section). This is acknowledged by the spec (§11: "the happy path needs a real email round-trip + live token; infeasible in e2e"). Correctly documented as manual-verify.

4. **No pgTAP tests needed:** Spec 085 has no SQL migration, no RLS change, no DB schema change. pgTAP is unaffected by design. The config.toml change (auth redirect allowlist + email template) is a GoTrue-config change, not a Postgres change — pgTAP correctly tests DB behavior (passes 40/40).

5. **No shell smoke tests needed:** No edge function was added or changed. Shell smokes (`scripts/smoke-edge.sh`, `scripts/smoke-rpc.sh`) are unaffected.

6. **Playwright e2e (Track 4) optional slice:** The spec recommended (but did not require) a Playwright test for the synthetic `#error=...&otp_expired` boot state. The developer verified this manually via Playwright/chromium screenshots. No automated Track-4 test was written for this specific slice. Given that `RecoveryScreen.test.tsx` covers the error state's logic end-to-end with mocks, and the spec explicitly marks this as optional ("leave to developer/test-eng discretion"), this is acceptable. No gap for release purposes.
