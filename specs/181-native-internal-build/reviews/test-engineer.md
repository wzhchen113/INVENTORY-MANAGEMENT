## Test report for spec 181

Scope: spec-181 changes only (frontend/config; no DB, RPC or edge changes, so no pgTAP or shell smoke is required). Other sessions' staged work in the checkout was ignored.

### Acceptance criteria status

Simulator gate (AC-1 to AC-9). These are PENDING on an owner prerequisite (Xcode is not installed on this Mac, so there is no `simctl`, no `expo run:ios`, and no EAS login). That is not a coverage gap. It is a hold on the Simulator half of AC-24. No jest test can stand in for these.
- AC-1: builds and launches in the iOS Simulator, reaches login → PENDING (owner prerequisite: Xcode)
- AC-2: admin login lands on the phone tier → PENDING (owner prerequisite)
- AC-3: staff login → store picker → EOD screen → PENDING (owner prerequisite)
- AC-4: staff EOD submit writes `eod_submissions` with a valid `client_uuid` → PENDING (owner prerequisite). The mint is jest-covered at the helper level by `src/lib/uuid.test.ts`.
- AC-5: admin phone weekly-count submit with a v4 `client_uuid` (proves B1) → PENDING on the Simulator. The code-level proof is AC-10 (PASS).
- AC-6: session survives kill and relaunch → PENDING (owner prerequisite)
- AC-7: no notification-permission dialog on a fresh install → PENDING on the Simulator. The code-level proof is the AC-16 pin (PASS).
- AC-8: icon and splash → PENDING on the Simulator. The asset facts are checked under AC-22.
- AC-9: Intl `formatToParts` with `timeZone` matches Node → PENDING. The stop-and-ask rule applies if it fails. The Simulator column in `main-verification.md` is still blank.

Per-bug fixes
- AC-10 (B1): section mints a v4 UUID with `crypto` undefined → PASS. `src/screens/cmd/sections/__tests__/InventoryCountSection.clientUuid.spec181.test.tsx` deletes `globalThis.crypto`, presses SUBMIT COUNT, and asserts the `clientUuid` passed to `submitInventoryCount` matches the v4 regex and does not start with `cu-`. It is backed by `src/lib/uuid.test.ts`, which covers three tiers: no crypto, `getRandomValues` only (version and variant bits forced), and `randomUUID` delegation. It also asserts the staff re-export is identical.
- AC-11 (C4): `receivePurchaseOrder` passes a v4 UUID with `crypto` undefined → PASS. `src/store/useStore.receivePo.clientUuid.spec181.test.ts` checks arg 3 against the v4 regex, checks it does not start with `rcv-`, and checks a fresh key per call. It runs against the real store with `db` mocked at the module boundary. This is a unit-level stub of `db`, which fits because the RPC contract is unchanged. The server-side `uuid` cast itself is not exercised until the Simulator run (AC-5).
- AC-12: no `cu-${` or `rcv-${` fallbacks left in `src/` → PASS. I re-ran `grep -rnF -e '`cu-${' -e '`rcv-${' src --include='*.ts' --include='*.tsx'`. It returned no matches (exit 1). I also grepped for other `randomUUID` or `clientUuid =` mints. The only remaining ones are the staff `uuidv4()` call sites, and the C6 `db.ts` image-upload path is out of scope.
- AC-13 (B2): native draft restore → PASS (jest) with the Simulator sub-step N/A.
  - `src/lib/countDraftLocal.test.ts` covers the native seeded-AsyncStorage case under the exact key `imr.countDraft.admin-inventory.store-1.user-1`, the write-then-read round trip (shared key builder), a miss, malformed JSON, wrong shape, `getItem` rejecting, and `getItem` throwing synchronously. On web it delegates to `localStorage` and never touches AsyncStorage.
  - `InventoryCountSection.draft.test.tsx` and `.layouts.test.tsx` gained `loadLocalCountDraft` in their mocks, and the draft suite passes. The assertions are unchanged.
  - The Simulator sub-step is N/A per design §0.1 (the phone tier has no save-draft affordance). It is recorded as N/A in the verification note.
  - Gap (low): the section-level wiring of `loadLocalCountDraft` is only exercised through mocks of `countDraftLocal`. Nothing runs the section against real native AsyncStorage. The two behaviors added here, `if (cancelled) return` after the await and the reconnect read moved inside the IIFE, are not pinned by a dedicated test. The existing draft suite exercises both effects on the happy path.
- AC-14 (B3): AppState auto-refresh, native only → PASS. `src/lib/authAutoRefresh.test.ts` covers:
  - nothing is called at install;
  - `active` calls start, and `background` / `inactive` call stop;
  - the remover unsubscribes;
  - install-then-remove-then-install leaves one listener, and the last remove leaves zero;
  - rejections are swallowed;
  - android behaves like ios;
  - web adds no listener, never calls start or stop, and the remover is a safe no-op.
  - Gap (low): nothing asserts that `App.tsx` actually mounts the installer. I confirmed by diff that `useEffect(() => installAuthAutoRefresh(), [])` is at `App.tsx:351`, between the restore effect and the spec-152 block. The nativeAppConfig pin does not cover it. If someone drops the line, no test goes red.
- AC-15 (C3): native recovery redirect → PASS. `src/lib/recoveryRedirect.test.ts` is updated:
  - native with the env var set returns the env value and `Linking.createURL` is not called;
  - native with it unset returns `null`;
  - `sendPasswordReset` on native with it unset returns `{ error: RECOVERY_URL_UNSET_ERROR }` (a string, no throw) and `resetPasswordForEmail` is not called;
  - `sendPasswordReset` on native with it set sends with that `redirectTo`;
  - the web cases are unchanged.
  - I also checked the source: the `expo-linking` import is gone from `recoveryRedirect.ts`.
- AC-16 (C5): boot notification prompt removed → PASS. The `nativeAppConfig.spec181.test.ts` text pin on `App.tsx` asserts there is no `requestPermissionsAsync`, no `registerForPushNotifications` and no `shouldShowAlert`, and that both `shouldShowBanner` and `shouldShowList` are present. I reviewed the `App.tsx` diff. The handler keys are `shouldShowBanner`, `shouldShowList`, `shouldPlaySound`, `shouldSetBadge`. The web branch of the effect (manifest, apple-touch-icon, SW, install prompt) is untouched, and only the native branch became `if (Platform.OS !== 'web') return;`. Gap (info): the pin is a text pin, so it won't catch a prompt reintroduced via a different API name.
- AC-17 (C1): `downloadCSV` native branch → PASS (jest) with the Simulator share-sheet step PENDING.
  - `src/utils/downloadCSV.native.spec181.test.ts` covers:
    - cache file written with a BOM-prefixed body, `create({overwrite:true})`;
    - `shareAsync` with `text/csv` and the CSV UTI;
    - availability is checked before the write;
    - unavailable sharing rejects with no file created;
    - a `shareAsync` failure rejects;
    - a `/` or `\` in the filename is sanitized to `_` (native only);
    - android takes the same path;
    - the DOM is untouched.
  - The `countExport.test.ts` BOM case has its assertions unchanged and gained a web pin and restore (the §0.3 interpretation, as designed).
  - The `InventoryCountSection` and `EODCountSection` callbacks are `async` with `await downloadCSV`, so the success toast now fires after the share outcome and a rejection hits the existing `exportFailed` catch.
  - Gap (low-medium): there is no component-level test for the phone CSV chip. The call-site ordering ("success toast only after the share resolves; rejection gives the export-failed toast") is verified by diff review only. `PhoneWeeklyCount.test.tsx` references `onExportCsv` through a model stub, not the section's real callback. The Simulator share-sheet tap also remains PENDING.

Config and assets
- AC-18: `app.json` permissions, scheme and device family → PASS. `src/lib/nativeAppConfig.spec181.test.ts` covers:
  - no removed permissions, short or qualified, and `RECEIVE_BOOT_COMPLETED` and `VIBRATE` kept;
  - all three fully-qualified entries in `blockedPermissions`;
  - no `NSCameraUsageDescription`;
  - `ITSAppUsesNonExemptEncryption` false;
  - `supportsTablet` false;
  - scheme `imr`;
  - the `expo-notifications` plugin still present.
  - The `expo config --type introspect` and prebuild evidence (`TARGETED_DEVICE_FAMILY = "1"`, the three permissions only as `tools:node="remove"`) is recorded in `main-verification.md`. I did not re-run prebuild. The `UIDeviceFamily`-in-plist wording is covered by the design §0.4 interpretation.
- AC-19: identity unchanged → PASS. The jest pin asserts slug `towson-inventory`, `com.towson.inventory` for both ids, the `projectId` and the `owner`. A diff scan of `app.json` shows no added or removed lines touching `slug`, `bundleIdentifier`, `package`, `projectId` or `owner`.
- AC-20: `eas.json` and `expo-dev-client` → PASS. The jest pin asserts a standalone `simulator` profile (`ios.simulator` true, no `developmentClient`), `development` / `preview` / `production` kept, and every profile declaring an `environment` of the expected value. `package.json` has `expo-dev-client ~6.0.21`. That install is verified by diff and `expo install --check`, not by a jest pin.
- AC-21: `expo install --fix` applied → PASS. I ran `npx expo install --check` and it reported "Dependencies are up to date". The 18/18 `expo-doctor` result is recorded by the developer. I did not re-run it, because it needs the network. The lockfile hoist workaround is documented in the verification note.
- AC-22: assets → PASS, with a limitation on my side.
  - `assets/icon.png` is 1024×1024, 8-bit RGB with no alpha (`file` and `sips` agree).
  - `assets/adaptive-icon.png` is 1024×1024 RGBA.
  - `assets/splash-icon.png` is 1024×1024 RGBA.
  - `git diff --stat -- public assets/favicon.png` is empty.
  - `assets/splash.png` is deleted, with no remaining references.
  - The jest pin enforces that the `gen_logo.py` `BG` tuple (`#1A1A18`) equals the adaptive-icon `backgroundColor` and the splash-plugin `backgroundColor`, with no top-level `splash` key and the splash image file present.
  - Limitation: Pillow is not installed for the system Python here, so I could not re-measure the adaptive-icon transparent corners or the 66% safe-zone bounding box. The developer recorded the bbox (267,445)-(772,579) against the 174-850 safe zone. Nothing in jest pins pixel properties of the PNGs, so a regenerated icon with an alpha channel would not fail any test. That is a low-risk gap, because the generator is the source of truth.
- AC-23: `EXPO_PUBLIC_*` not committed, with the list recorded → PASS. `app.json` and `eas.json` contain no `EXPO_PUBLIC` strings. `.env.local` is gitignored (`.gitignore:25`). The only tracked env file is the pre-existing `.env.example` template. The required variable list and the "no service-role key, plaintext or sensitive visibility" rules are in `main-verification.md`.

Records and web-unchanged
- AC-24: verification note → PARTIAL. `specs/181-native-internal-build/reviews/main-verification.md` exists and records the EAS env list and the code/config evidence. The Simulator rows (build path, device, iOS version) and the AC-9 Intl result are blank, so this closes only when AC-1 to AC-9 are run.
- AC-25: web unchanged → NOT TESTED in full, by agreement.
  - Verified here: the targeted run below (13 suites, 114 tests) passes, and `git diff` shows `public/` and `assets/favicon.png` untouched.
  - Recorded by the developer: the full jest run (274/274 suites, 3387/3387 tests), both typechecks, and `expo export --platform web`.
  - Not run: `npm run e2e`. It is deliberately skipped because it mutates the shared stack. Main Claude should run it when the stack is free.
  - Not run: the post-push `test.yml` and `db-migrations-applied.yml` checks.
- AC-26: ATS not weakened → PASS, from recorded evidence only. There are no ATS keys in `app.json` (diff reviewed). The developer's prebuild in a scratch copy shows `NSAllowsArbitraryLoads: false` and `NSAllowsLocalNetworking: true` in the single shared Info.plist. No jest pin covers ATS, and I did not re-run prebuild. The introspect caveat (the synthetic template shows `NSAllowsArbitraryLoads: true`) is documented in the note. This is acceptable as a recorded manual check.

Tally: 15 PASS (AC-10 to AC-23 and AC-26), 1 PARTIAL (AC-24), 1 NOT TESTED by agreement (AC-25: e2e plus the CI gates pending), 9 PENDING on an owner prerequisite (AC-1 to AC-9).

### Test run
- Command: `npx jest src/lib/uuid.test.ts src/lib/authAutoRefresh.test.ts src/lib/countDraftLocal.test.ts src/lib/nativeAppConfig.spec181.test.ts src/lib/recoveryRedirect.test.ts src/utils/downloadCSV.native.spec181.test.ts src/utils/countExport.test.ts src/store/useStore.receivePo.clientUuid.spec181.test.ts src/screens/cmd/sections/__tests__/InventoryCountSection`
- Result: **13 suites passed, 114 tests passed, 2 snapshots passed, 0 failures** (2 projects). The console output was only pre-existing warnings: `process.env.EXPO_OS` from jest-expo and an expected `saveCountDraft failed` warn in the draft suite.
- `npx expo install --check` → "Dependencies are up to date".
- AC-12 grep → no matches.
- Not run, per instructions: `npm run e2e`, `npm run test:db`, the full jest and the typechecks (main Claude owns these).

### Notes
Findings to route (none blocks the code/config half):
1. **Medium: no test pins the phone CSV chip call-site (AC-17).** The "toast only after the share resolves, rejection gives the export-failed toast" behavior is covered by design and diff review only. A small component test on `InventoryCountSection` (mock `downloadCSV` to resolve and to reject, then assert the toasts) would close it. This is a missing test, not a failing one.
2. **Low: `App.tsx` mount of `installAuthAutoRefresh` is not pinned.** The unit tests prove the module works, but nothing proves it is wired in. The existing `nativeAppConfig.spec181.test.ts` text pin could cheaply add `expect(appTsx).toContain('installAuthAutoRefresh()')`.
3. **Low: AC-13 section wiring runs only against mocked `countDraftLocal`.** The new `cancelled` guard and the reconnect-effect move are not asserted directly.
4. **Info: icon pixel properties aren't pinned by jest** (alpha, safe zone). I verified the format and size with `sips` and `file`.
5. **Info: the stale doc comment at `useStore.ts` ~L770 ("via crypto.randomUUID()")** was intentionally left. The design §5.1 listed it, but the dispatcher limited the `useStore.ts` hunks. It is comment-only.
6. **Info: the `package.json` netinfo change is a downgrade** (11.5.2 → the pinned 11.4.1). This is expected from `expo install --fix` and is documented.
7. **Release gating: AC-1 to AC-9 and the Simulator half of AC-24 stay open until the owner installs Xcode.** AC-9 is a stop-and-ask if Intl fails. The release-coordinator should treat these as an owner hold, not as FAIL.
8. **Infra gap (no new framework introduced):** there is no native UI test track, so the Simulator checks stay manual. This is already the project's stated gap.

## Handoff
next_agent: NONE
prompt: Test report complete. 15 PASS, 0 FAIL, and 9 PENDING on an owner prerequisite (AC-1 to AC-9, Simulator; Xcode not installed) across the acceptance criteria. AC-24 is PARTIAL (the Simulator rows and AC-9 Intl result are blank). AC-25 is not fully tested (e2e and the post-push CI gates are outstanding). The targeted run passed, 13 suites and 114 tests. Three non-blocking test-gap findings are listed in the Notes.
payload_paths:
  - specs/181-native-internal-build/reviews/test-engineer.md
