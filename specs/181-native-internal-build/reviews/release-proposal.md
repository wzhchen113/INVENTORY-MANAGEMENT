## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical and the code/config/jest half is solid, but adding `scheme: "imr"` turns on a native recovery deep-link handler that nobody uses and that allows a session swap (security M1, confirmed against `RecoveryGate.tsx`). That and two other small new-surface or untested items should land before the commit. Separately, `npm run e2e` (AC-25) has not been run, and the Simulator gate (AC-1 to AC-9) is an owner hold.

## Findings summary

- **code-reviewer:** 0 Critical, 1 Should-fix, 9 Nits.
  - Should-fix: `src/lib/countDraftLocal.ts:75-77` and `:107-112` both do the same parse-then-validate step (`JSON.parse` then `isLocalCountDraft`). Extract a private `parseLocalCountDraft()` so the web and native restore paths can't drift apart.
  - Hand-edited `package-lock.json`: **keep it**. Don't add explicit deps for `babel-preset-expo` / `expo-asset` / `expo-constants` yet. It asks for the `npm dedupe` result and a "how to heal" recipe in the verification note.
  - Nits worth acting on now:
    - the "DOM untouched" assertion in `downloadCSV.native.spec181.test.ts:58-85` can never fail (it compares `createElement` to itself);
    - a one-line ATS pin (`NSAllowsArbitraryLoads`) for AC-26;
    - write the BOM in the new test as `'﻿'` instead of an invisible literal.
  - Nits to defer:
    - stale `useStore.ts:770` comment;
    - `countDraftLocal.ts` header re-wrap;
    - hide the splash on `fontError`;
    - floating `downloadCSV` promises in the desktop-only `ExportCsvDrawer` / `RecipesSection`;
    - the test-double guard in `authAutoRefresh.ts`;
    - netinfo 11.4.1 downgrade (expected, already recorded).
  - Policy checks all pass: slug and ids unchanged, no new `supabase.from/rpc` outside the carve-outs, every native branch is behind `Platform.OS`, web `downloadCSV` is verbatim and still synchronous.

- **security-auditor:** 0 Critical, 0 High, 2 Medium, 7 Low.
  - **M1 (confirmed by main Claude):** `RecoveryGate.tsx:73-96` parses any `Linking` URL on native. `parseRecoveryFromUrl` does not check host or path. `RecoveryScreen` calls `verifyOtp` automatically on mount and only calls `signOut()` on success.
    - With `scheme: "imr"`, and the bundle-id scheme Expo always registers, a crafted `imr://x?token_hash=…&type=recovery` link silently replaces the signed-in user's session with one for an account the attacker controls (login-CSRF).
    - The file's own header (L17-20) says this branch is "inert on native without the scheme". Spec 085 deliberately left it switched off until a scheme existed, and this spec adds the scheme without designing the handler.
    - Under C3, native recovery goes to the web URL, so the handler serves no purpose.
  - **M2:** `app.json` doesn't set `android.allowBackup`, so Expo writes `android:allowBackup="true"`. Google Auto Backup and device transfer would then copy AsyncStorage, which holds the Supabase refresh token. This exposure is new with the first native binary.
  - Lows:
    - L1: the `Math.random` UUID is fine as an idempotency key. The global dedup on `eod_submissions` is a separate follow-up.
    - L2: ATS holds. The owner should run `plutil` on the first production `.ipa`.
    - L3: the template's `SYSTEM_ALERT_WINDOW` ships in release builds.
    - L4: `.gitignore` doesn't cover `credentials.json` or a Play service-account JSON. I re-checked: no matching pattern exists.
    - L5: rotating the resolve token breaks installed builds until users update (no OTA).
    - L6: never give a `development` build to staff devices.
    - L7: CSV files stay in the app cache after sharing.
  - Dependencies are clean. All 142 changed lock entries match the registry integrity. `npm audit` findings went from 33 to 23, with none added.

- **test-engineer:**
  - **15 PASS:** AC-10 to AC-23 and AC-26.
  - **1 PARTIAL:** AC-24. The Simulator rows and the AC-9 Intl result are blank.
  - **1 NOT TESTED by agreement:** AC-25. e2e and the post-push CI gates are outstanding.
  - **9 PENDING on an owner prerequisite:** AC-1 to AC-9 (Xcode not installed). This is a hold, not a FAIL.
  - Coverage gaps:
    1. **Medium:** no component test pins the phone CSV chip call site (AC-17 / spec risk 4: success toast only after the share resolves, export-failed toast on rejection). It was checked by diff review only.
    2. **Low:** nothing pins that `App.tsx` actually mounts `installAuthAutoRefresh()`.
    3. **Low:** the AC-13 section wiring (the `if (cancelled) return` and the reconnect read moved inside the IIFE) runs only against a mocked `countDraftLocal`.
    4. **Info:** icon pixel properties (alpha, safe zone) aren't pinned by jest.

- **main verification** (main Claude, 2026-10-26, on top of `main-verification.md`):
  - Full `npx jest`: 274/274 suites, 3387/3387 tests. `npm run typecheck` and `npm run typecheck:test` are clean.
  - Clean `npm ci --ignore-scripts` from the edited lock in a scratch copy:
    - 959 packages;
    - `babel-preset-expo`, `expo-asset` and `@expo/cli` are at the top level, and there is no `node_modules/expo/node_modules`;
    - `npm ls --all` shows 0 invalid/missing;
    - a follow-up `npm install` leaves the lock byte-identical.
  - `npm dedupe --dry-run`: keeps all expo packages hoisted. It only proposes unrelated transitive patch bumps (semver, ws, brace-expansion, jest internals) and drops one duplicate `@expo/json-file`. So dedupe is **not** a strict no-op, but it is a safe way to heal this layout.
  - Web browser smoke (localhost:8081, local stack):
    - admin weekly count renders with no console errors;
    - Save draft, then full reload, gives "Draft restored" with the value intact;
    - Discard clears both localStorage and the banner.
    - This covers the B2 web path.
  - M1 confirmed at `RecoveryGate.tsx:73-96`.

- **backend-architect:** not invoked post-impl. This is a frontend/config-only spec with no migrations, RPCs, RLS or edge changes, so contract drift doesn't apply.

## Recommended next steps (ordered)

Items 1 to 5 belong **in this spec**. They are small, they touch files this spec already owns or a surface this spec newly exposes, and none of them needs new design.

1. **Security M1 (Medium; fix first because it is a live auth surface the spec itself introduces).**
   - In `src/navigation/RecoveryGate.tsx`, make the native `Linking` effect a no-op: change the L75 guard to `if (Platform.OS !== 'web') return;`, so it returns early on every platform, and remove or neutralise the `getInitialURL` / `addEventListener` body.
   - Leave the web branch byte-unchanged.
   - Update the header comment (L17-20): native deep-link recovery is off until a deep-link spec designs it.
   - Add a jest case. No `RecoveryGate` test exists today. With Platform `ios`, assert that `Linking.getInitialURL` and `Linking.addEventListener` are not called and that a recovery-shaped URL renders `children`, not `RecoveryScreen`.
   - Scope note: `RecoveryGate.tsx` is not in the design's file list, but the spec's Out-of-scope section already says "deep-link routing for the new `imr` scheme" is deferred. Switching the handler off is what that deferral needs. Please confirm this small scope extension.
   - This also settles design risk §10.6: the dev-client launch URL can no longer reach RecoveryScreen.

2. **Security M2 (Medium).**
   - Add `"allowBackup": false` to the `android` block of `app.json`.
   - Pin it in `src/lib/nativeAppConfig.spec181.test.ts`.
   - One line plus one assertion, in a file this spec owns. It closes a refresh-token exfiltration path before the first Play internal binary exists.

3. **Test gap #1: AC-17 call-site test (Medium test gap; it proves spec risk 4, which the spec explicitly calls out).**
   - Add a component test on `InventoryCountSection` (phone tier).
   - Mock `downloadCSV` so it resolves in one case and rejects in another. Assert that the success toast appears only after it resolves, and that a rejection gives the `exportFailed` toast with no unhandled rejection.

4. **Cheap test and pin tightening (Low; one pass through the spec's own test files).**
   - `nativeAppConfig.spec181.test.ts`: add `expect(appTsx).toContain('installAuthAutoRefresh()')` (test gap #2).
   - Same file: add `expect(JSON.stringify(app)).not.toContain('NSAllowsArbitraryLoads')` (code-review nit, AC-26).
   - `downloadCSV.native.spec181.test.ts:58-85`: replace the assertion that can never fail with `jest.spyOn(document, 'createElement')` plus `not.toHaveBeenCalled()`, or delete it. Also write the BOM as `'﻿'` in that new file. Leave the pre-existing `countExport.test.ts:264` alone.

5. **Code-review Should-fix: countDraftLocal parser dedupe.**
   - Extract a private `parseLocalCountDraft(raw: string | null): LocalCountDraft | null` in `src/lib/countDraftLocal.ts` and call it from both `readLocalCountDraft` and `loadLocalCountDraft`.
   - Same file, no behaviour change. `countDraftLocal.test.ts` and the draft suite already cover both paths.
   - Optionally re-wrap the header paragraph (L10-15) while you're there.

6. **Security L4: `.gitignore` for EAS credentials (Low; recommended before owner step 6, user's call whether it goes in this commit).**
   - Add `credentials.json` and a Play service-account pattern (for example `*service-account*.json` or a named key path).
   - This spec writes neither file, but its stated goal is builds the owner can upload. Step 6 is exactly when these files show up in the repo root.
   - It is a one-line hygiene change outside the design's file list, so I'm listing it rather than assuming it. If you'd rather keep the spec tight, do it as its own commit before the first `eas submit`.

7. **Re-verify after items 1 to 6.**
   - Run the full `npx jest`, `npm run typecheck` and `npm run typecheck:test`.
   - Grep for any test pinning the old native `RecoveryGate` behaviour.

8. **Run `npm run e2e` when the shared local stack is free (AC-25 hold).** It is the web-regression guard and has not run. Do this before the commit.

9. **Append to `main-verification.md`** (main Claude or the developer; I don't edit it):
   - main Claude's verification above: the `npm ci` scratch result, the `npm dedupe --dry-run` result, and the browser smoke;
   - the code-reviewer's heal recipe: "after an expo bump, if jest dies with `Cannot find module 'babel-preset-expo'`, run `npm dedupe` and check `node_modules/expo/node_modules` is absent". Don't run `npm dedupe` against the lock now; it would churn unrelated transitive deps.

10. **Commit (owner).**
    - Stage only the spec-181 files. The working tree also holds other sessions' changes (specs 176/177/179/180).
    - `src/store/useStore.ts` contains other sessions' staged edits, and spec 181 owns only the L46-47 import and the L4376-4378 mint. Stage hunks, not the whole file, if needed.
    - Rebase over spec 180's `App.tsx` changes as in design §10.2.

11. **Post-push gates.** Confirm both `test.yml` and `db-migrations-applied.yml` are green on `main` (`gh run list --branch main --workflow <file> --limit 1` for each). That is the condition to call this SHIP_READY.

12. **Owner hold, Simulator gate (AC-1 to AC-9 and the Simulator half of AC-24).**
    - Install Xcode, run `npx expo run:ios` against the local stack, and fill in the table in `main-verification.md`.
    - **AC-9 is stop-and-ask:** if Hermes `formatToParts` with `timeZone` fails, an Intl polyfill is a scope decision for you.
    - This hold doesn't block committing the code/config half (design §10.10). It does block calling the spec closed and starting TestFlight / Play uploads.

### Optional, not blocking (fold in only if you want)
- **Security L3:** add `android.permission.SYSTEM_ALERT_WINDOW` to `android.blockedPermissions` before the first Play submission. It is the same `app.json` block as M2, so it's cheap to do alongside it. I'm leaving it out of the required list because AC-18 doesn't cover it.
- **Security L7:** delete the cached CSV after `shareAsync` resolves.
- **Code-review nit:** hide the splash on `fontError` as well as on `fontsLoaded`.

## Out of scope for this review
These belong in separate specs or owner runbooks, not spec 181:
- **Web recovery-link hardening (M1 follow-up):** require the `reset-password` path, require an explicit tap before `verifyOtp`, and `signOut()` on every RecoveryScreen exit. The same login-CSRF class already exists on web via `/reset-password?token_hash=…`. A future deep-link spec should apply the same hardening before turning native recovery back on.
- **SecureStore session storage (M2 follow-up):** move the Supabase session from AsyncStorage to an `expo-secure-store` adapter (Keychain/Keystore) with value chunking.
- **EOD dedup scoping (L1 follow-up):** `eod_submissions.client_uuid` dedup is global. Scope it per store, as the `inventory_counts` H1 fix did. Unreachable in practice, but cheap.
- **`npm audit fix` hygiene spec:** 23 pre-existing findings, none introduced here. Triage `dompurify` (via `jspdf`, reaches the web bundle) first, then `shell-quote`.
- **Owner runbook notes:**
  - L5: rotating `USERNAME_RESOLVE_SERVICE_TOKEN` breaks username login on installed native builds until users update.
  - L6: never distribute `development` (dev-client) builds to staff.
  - L2: `plutil -p` the first production `.ipa` Info.plist.
  - Confirm no service-role key in any EAS env var.
- **Test gap #3:** a section-level test of the AC-13 `cancelled` guard and the reconnect-effect move against real native AsyncStorage.
- **Test gap #4:** jest pins on icon pixel properties (alpha channel, safe-zone bounding box).
- **Phone Save-draft / autosave-on-background** (design §0.1): new UX that would make the AC-13 Simulator sub-step meaningful. Needs its own spec.
- **`src/store/useStore.ts:770` stale "via crypto.randomUUID()" comment:** fold into the next spec that touches `useStore.ts`. It was held back to keep the hunk in this shared file minimal.
- **Desktop `downloadCSV` floating promises** (`ExportCsvDrawer.tsx:77`, `RecipesSection.tsx:226`): handle in the C2/C6 spec if those surfaces ever reach native.
- **Already-deferred items from the spec:** C2, C6 (including the unguarded `crypto.randomUUID()` at `db.ts:5748`), C7, expo-updates/OTA, native push (spec 182), iPad, store listing, removing `react-native-chart-kit`.
- **Proposed CLAUDE.md update at release time** (the spec defers it): a "native build" convention bullet covering:
  - EAS profile → environment mapping and `EXPO_PUBLIC_*` visibility;
  - the lockfile hoist / `npm dedupe` heal;
  - "custom-scheme inbound handlers stay off until designed".
