# Spec 181 — verification note (AC-24)

Status of this note: **code/config/jest half DONE (2026-10-26, frontend-developer); Simulator half PENDING** on the owner's Xcode / EAS prerequisites (spec "Owner-only prerequisites" 1, 3, 4).

## Environment at implementation time

- macOS, Node v24.14.1 / npm 11.11.0.
- `xcode-select` points at CommandLineTools. No Xcode.app, no `simctl`, no CocoaPods, no Android SDK/Java, no `eas login`. So **no Simulator run was possible**. `npx expo run:ios` / EAS `simulator` builds are blocked until the owner installs Xcode.
- Local Supabase stack (`npm run dev:db`) was up. It was not exercised from a native client, for the reason above.

## Simulator acceptance criteria (AC-1 to AC-9): PENDING (owner Xcode prerequisite)

When run, record for each row: the build path (`npx expo run:ios` vs EAS `simulator` profile), the Simulator device type, and the iOS version.

| AC | What | Result | Build path / device / iOS |
|---|---|---|---|
| AC-1 | Builds + launches to login, no red box | PENDING | |
| AC-2 | Admin login lands on the phone tier (no sidebar / TitleBar / ⌘K) | PENDING | |
| AC-3 | Staff login → store picker → EOD count screen | PENDING | |
| AC-4 | Staff EOD submit → `eod_submissions` row `status='submitted'`, valid UUID `client_uuid` | PENDING | |
| AC-5 | Admin phone weekly count submit → `submit_inventory_count` success, v4 `client_uuid`, success toast (proves B1) | PENDING | |
| AC-6 | Session survives swipe-kill + relaunch (admin and staff) | PENDING | |
| AC-7 | No notification-permission dialog on a fresh install (boot or post-login) | PENDING | |
| AC-8 | Icon (opaque dark square, no transparent corners) + splash (mark on `#1A1A18`, no white flash) | PENDING | |
| AC-9 | Intl `formatToParts` with `timeZone` matches Node/Chrome; EOD business date matches web | PENDING. **If this fails, stop and take it to the user** (polyfill = scope decision). | |

AC-9 reference to compare against (Node, same input). Fill in the Simulator column when run:

```
new Intl.DateTimeFormat('en-US', { timeZone: '<store IANA zone>', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date('2026-10-26T03:30:00Z'))
```

### AC-13 Simulator sub-step: N/A (design §0.1)

On native the only reachable weekly-count surface is `PhoneWeeklyCount`. It has **no Save-draft affordance and no autosave** (it passes no `onSaveDraft`). On native, `writeLocalCountDraft` only runs from the desktop-only `onSaveDraft` and from reconcile actions that need a local copy to exist already. So "type a partial count, background, kill, relaunch → draft restored" can't happen on native, with or without B2. Typing alone persists nothing on web either. The B2 read path is implemented and jest-covered (`src/lib/countDraftLocal.test.ts`). A phone Save-draft / autosave-on-background would be new UX for a separate spec (PM/owner decision).

### Risk §10.6 (dev-client launch URL vs RecoveryGate): SETTLED by the M1 fix

The security M1 fix (see "Fixes applied" below) removed RecoveryGate's native `Linking` effect, so no native launch URL (dev-client `exp+towson-inventory://expo-development-client/?url=…`, `imr://…` or the bundle-id scheme) is ever parsed. The gate always renders RoleRouter on native. This is pinned by `src/screens/RecoveryGate.spec181.test.tsx`, so no Simulator check is needed. A first dev-client run that lands on login is consistent with this.

## Done here (code / config / jest)

### Step 1: `npx expo install --fix` + new installs (§5.11, AC-21)

- Bumps taken: `expo` → `~54.0.37` (resolved 54.0.38), `expo-file-system ~19.0.24`, `expo-font ~14.0.12`, `expo-notifications ~0.32.17`, `jest-expo ~54.0.18`, `@react-native-community/netinfo` → `11.4.1`. That last one is Expo's pinned SDK-54 version; it **downgrades** from the previously installed 11.5.2, within 11.x.
- New: `expo-dev-client ~6.0.21`, `expo-splash-screen ~31.0.13`.
- **Install-layout issue found and fixed (lockfile only, no extra dependency).** After the in-place `expo` bump, npm (both 10 and 11; it reproduces on a fresh `--package-lock-only` resolution too) nested `babel-preset-expo`, `expo-asset`, `@expo/cli`, `@expo/metro-config` and a second `expo-constants` under `node_modules/expo/node_modules/`. The root `expo-constants@18.0.13` (pulled by `expo-linking` / `expo-notifications`) conflicted with expo's `~18.0.14`, and every package with a `peer expo` was then placed under its parent. Result: **all 267 jest suites failed** (`Cannot find module 'babel-preset-expo'`, since `babel.config.js` resolves it from the root), and root `expo-font` could not resolve `expo-asset`. `npm ci` in CI would have reproduced this, and so would Vercel's export.
  - Fix: rewrite `package-lock.json` to hoist those entries to the root. `expo-constants` is unified at 18.0.14, which satisfies every dependent's range. `semver@7.8.5` / `minimatch@9.0.9` / `brace-expansion@2.1.7` stay nested under `@expo/cli`, which needs them.
  - Verified: `npm ci` from the rewritten lock, then `npm ls --all` shows no invalid or missing entries. A follow-up `npm install` leaves the lock **byte-identical** (stable). `npx expo install --check` reports "Dependencies are up to date".
  - Alternative not taken: adding `babel-preset-expo` (and `expo-asset` / `expo-constants`) as direct dependencies. That widens `package.json` beyond the design's intended changes.
- Baseline after step 1 (before any code change): `npx jest` **267/267 suites, 3340/3340 tests**; `npm run typecheck` and `npm run typecheck:test` clean. Nothing pre-existing was red.

### After implementation

- `npx jest`: **274/274 suites, 3387/3387 tests** (7 new suites).
- `npm run typecheck` / `npm run typecheck:test`: clean.
- `npx expo export --platform web` (to a scratch dir): succeeds.
- `npx expo-doctor`: **18/18 checks passed**.
- `npx expo install --check`: up to date.
- `npm run e2e`: **NOT run by the frontend-developer.** The local Supabase stack and the 8081 web server are shared with other in-flight sessions, and the e2e suite mutates the shared stack (invite/EOD specs + the order_schedule fixture). Main Claude should run it when the stack is free (AC-25).
- Browser smoke via preview tools: not available to this subagent. Web behaviour is covered by the unchanged-assertion web tests (countExport BOM case pinned to `web`, recoveryRedirect web cases, InventoryCountSection draft suite), plus a successful web export.

### AC-12 grep

`grep -rnF -e '`cu-${' -e '`rcv-${' src --include='*.ts' --include='*.tsx'` → **no matches** (exit 1). (The design's BRE form misbehaves on BSD grep, so the fixed-string form is used.)

### AC-18 / AC-26: generated config

- `npx expo config --type introspect`:
  - `scheme: imr`, `ios.supportsTablet: false`;
  - Info.plist has **no `NSCameraUsageDescription`** (`NSPhotoLibraryUsageDescription` and `ITSAppUsesNonExemptEncryption: false` kept);
  - the Android manifest mod result lists CAMERA / READ_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE **only** with `tools:node="remove"`;
  - plugins: `expo-notifications`, `expo-document-picker`, `expo-font`, `expo-splash-screen`.
  - Caveat: introspect's synthetic Info.plist shows `NSAllowsArbitraryLoads: true` + a localhost exception. That is introspect's built-in fallback template, not what prebuild writes; the prebuild check below is the ground truth.
- `npx expo prebuild --clean --no-install`, run in a **scratch copy** of the repo (deleted afterwards; no `ios/` / `android/` in the repo, no `package.json` script rewrite in the repo):
  - `ios/IMR.xcodeproj/project.pbxproj`: `TARGETED_DEVICE_FAMILY = "1"` in both build configurations (iPhone only, §0.4).
  - `ios/IMR/Info.plist` `NSAppTransportSecurity` = `{ NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true }`. This is one plist shared by all configurations, so it holds for `preview`/`production` as well (**AC-26 holds**). `CFBundleURLSchemes` include `imr`.
  - `android/app/src/main/AndroidManifest.xml`: the three permissions appear only as `tools:node="remove"`; `INTERNET`, `RECEIVE_BOOT_COMPLETED`, `VIBRATE` remain. Observation, out of scope: the Expo template also declares `SYSTEM_ALERT_WINDOW`, as it always has.
  - Splash background colour is `#1A1A18` on both platforms (`colors.xml`, `SplashScreen.storyboard`).
  - The iOS entitlements include `aps-environment` (from the expo-notifications plugin). TestFlight provisioning therefore needs the Push capability even though push is off (risk §10.5, owner via EAS credentials).

### AC-22: assets

- `python3 scripts/gen_logo.py --target native` regenerated `assets/icon.png` (1024², mode **RGB**, corners = BG), `assets/adaptive-icon.png` (1024² RGBA, transparent corners, mark bbox (267,445)-(772,579), inside the 66% safe zone (174-850)) and the new `assets/splash-icon.png`. `assets/splash.png` was deleted.
- `git diff --stat -- public assets/favicon.png` → **empty**. A `--target web` run was also confirmed to reproduce the committed web assets byte-for-byte (then restored).

## EAS environment variables (AC-23): the owner sets these

Set them per EAS environment (`development`, `preview`, `production`) in the EAS dashboard or with `eas env:create`. Use **`plaintext` or `sensitive` visibility, not `secret`**: `EXPO_PUBLIC_*` values are inlined into the bundle.

| Variable | Required | `preview` / `production` value | `development` value |
|---|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | yes | prod Supabase URL (same as Vercel) | owner's choice; for an EAS `simulator` build against the local stack: `http://127.0.0.1:54321` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | yes | prod anon key (same as Vercel) | matching anon key |
| `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN` | yes | same as Vercel | matching value |
| `EXPO_PUBLIC_WEB_RECOVERY_URL` | yes (native password reset refuses to send without it) | prod web `/reset-password` URL (same as Vercel) | owner's choice |
| `EXPO_PUBLIC_GIT_SHA` | optional | build SHA | optional |

- Not needed on native: `EXPO_PUBLIC_VAPID_PUBLIC_KEY` (web-push only).
- Never put a service-role key in any `EXPO_PUBLIC_*` variable.
- `.env.local` stays gitignored. The gating local path `npx expo run:ios` reads it.
- Build profiles map to environments as `development` → development, `simulator` → development, `preview` → preview, `production` → production.

## Main Claude verification (2026-10-26)

Run by main Claude after the review fan-out, on top of the developer's results above.

- Full `npx jest`: **274/274 suites, 3387/3387 tests**. `npm run typecheck` and `npm run typecheck:test` are clean.
- Clean `npm ci --ignore-scripts` from the edited `package-lock.json`, in a scratch copy of the repo:
  - 959 packages installed;
  - `babel-preset-expo`, `expo-asset` and `@expo/cli` are at the top level of `node_modules`;
  - there is no `node_modules/expo/node_modules`;
  - `npm ls --all` reports 0 invalid / 0 missing;
  - a follow-up `npm install` leaves the lock byte-identical.
- `npm dedupe --dry-run`: keeps every expo package hoisted. It only proposes unrelated transitive patch bumps (semver, ws, brace-expansion, jest internals) and drops one duplicate `@expo/json-file`. So dedupe is **not** a strict no-op on this lock, but it is a safe way to heal the layout. It was not run against the lock.
- Web browser smoke on localhost:8081 (local stack):
  - the admin weekly count renders with no console errors;
  - Save draft, then a full reload, shows "Draft restored" with the value intact;
  - Discard clears both the localStorage entry and the banner.
  - This covers the B2 web restore path.

### Heal recipe: expo packages nested under `expo/`

If, after an expo bump (`npx expo install --fix`, an SDK upgrade, or a lock regeneration), jest fails across the board with `Cannot find module 'babel-preset-expo'`, or `expo-font` can't resolve `expo-asset`, npm has nested expo's dependencies under `node_modules/expo/node_modules/`. To heal it:

1. Run `npm dedupe`.
2. Check that `node_modules/expo/node_modules` no longer exists and that `npm ls --all` is clean.
3. Re-run `npx jest`.

If dedupe can't hoist them, make the phantom dependencies explicit (`babel-preset-expo` first), as the code-reviewer suggested.

## Fixes applied (release-proposal items 1-6, 2026-10-26)

Applied by frontend-developer with owner approval, including the `RecoveryGate.tsx` scope extension and the `.gitignore` patterns.

1. **Security M1: applied.** `src/navigation/RecoveryGate.tsx` no longer has a native `Linking` effect. The `getInitialURL` / `addEventListener('url')` body was removed, along with the now-unused `expo-linking` and `parseRecoveryFromUrl` imports. On native the gate always renders `children`. The web branch (`readRecoveryFromWebSync`, `scrubRecoveryUrl`, the scrub effect, the render branch) is byte-unchanged. The header comment now explains why native is off: spec 181 C3 sends native recovery to the web URL, and native deep-link recovery needs its own spec. New `src/screens/RecoveryGate.spec181.test.tsx` (9 tests):
   - On ios and android, with a recovery `imr://` URL from `getInitialURL` and a url-event listener armed, Linking is never called and `children` render, not RecoveryScreen.
   - On web, a `token_hash` URL renders RecoveryScreen and scrubs the URL, an `otp_expired` fragment renders the error parse, and a plain URL renders `children`.
   - The 6 native cases were confirmed to **fail** against the pre-fix gate.
2. **Security M2: applied.** `app.json` `android.allowBackup: false`, pinned in `src/lib/nativeAppConfig.spec181.test.ts`.
3. **AC-17 call-site test: applied.** New `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.csvExport.spec181.test.tsx` renders the real `InventoryCountSection` on the phone tier with `downloadCSV` controlled:
   - the success toast fires only after `downloadCSV` resolves;
   - a rejection gives the `Export failed` toast, no success toast, and no unhandled rejection.
   - Both tests were confirmed to **fail** with `await` removed from the call site (mutation reverted, file hash identical).
4. **Low test fixes: applied.**
   - `nativeAppConfig.spec181.test.ts` now pins that `App.tsx` imports and calls `installAuthAutoRefresh()`, and that app.json never contains `NSAllowsArbitraryLoads`.
   - In `downloadCSV.native.spec181.test.ts`, the "DOM untouched" check that could never fail is replaced. A stub `document.createElement` and a `URL.createObjectURL` spy are both asserted `not.toHaveBeenCalled()`; the suite runs in the node env, which has no `document`, so the stub is installed and removed per test.
   - The BOM in that test is now written as the `\uFEFF` escape. `countExport.test.ts` was left alone.
5. **Code-review should-fix: applied.** `src/lib/countDraftLocal.ts` has a private `parseLocalCountDraft(raw)`, which both `readLocalCountDraft` and `loadLocalCountDraft` call. There is no behaviour change: the existing `countDraftLocal.test.ts` and draft suites pass unchanged. The optional header re-wrap was not done.
6. **Security L4: applied.** `.gitignore` now ignores `credentials.json`, `credentials/`, `*service-account*.json` and `google-services-key*.json`. `git ls-files -i -c --exclude-standard` is empty after the edit (no tracked file matches), and no untracked file is newly ignored. `google-services.json` (the Firebase client config) is intentionally not matched.

**Re-verification after the fixes:**
- Full `npx jest` on the working tree: **276/276 suites, 3401/3401 tests**. That is +2 suites and +14 tests (RecoveryGate 9, CSV call site 2, config pins 3).
- In the shared working tree, `npm run typecheck` and `npm run typecheck:test` currently report errors, but only in another session's in-flight spec-180 work: `src/hooks/useEodSubmitPopup.ts` (untracked) imports `mapNotificationRow`, and an unstaged `src/store/useStore.ts` hunk calls `markNotificationsRead`. Neither is exported by `db.ts` yet. None of these errors are in spec-181 files.
- To isolate them, a scratch tree was built from the git index (staged content, without spec 180's unstaged edits) plus the eight files touched here. In that tree, `npm run typecheck` and `npm run typecheck:test` both exit 0, and full jest is 276/276 suites, 3401/3401 tests.
- There is no test or e2e reference to the old native RecoveryGate behaviour; the only grep hits are the gate, its new test and RecoveryScreen.
- The browser was not re-smoked by the developer (no preview tools in this subagent). The web paths these fixes touch are the countDraftLocal web read (now through `parseLocalCountDraft`) and the RecoveryGate web branch (unchanged). Both are covered by jest. Main Claude should re-run the weekly-count Save draft → reload → "Draft restored" smoke before the commit.
- `npm run e2e` (AC-25) is still outstanding.
