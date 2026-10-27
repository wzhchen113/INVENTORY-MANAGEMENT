# Spec 181: Native internal build (iPhone simulator, then TestFlight + Play internal)

Status: READY_FOR_REVIEW

## Owner's request (summary)
Ship I.M.R as a native iPhone/Android app through EAS, alongside the Vercel web build. This first spec covers an **internal** build only: first an iOS Simulator build, then builds the owner can upload to TestFlight and the Play internal track. Store listing and public release come in a later spec.

Source assessment (checked against the code on 2026-10-26, with file:line references): `native-app-readiness-plan.md` in the side-session notes for session `local_e14e0715-…`. The bug IDs below (B1, B2, B3, C1, C3, C4, C5, and the deferred C2, C6, C7) are the IDs that assessment uses.

## User story
As a store manager or staff member, I want I.M.R installed as a native app on my iPhone (and Android phone), so I can do the same phone-tier work as on the web (admin weekly counts, staff EOD counts) without opening a browser. My session should stay signed in between launches.

## Already true (no work needed; listed so nobody re-does it)
- Expo SDK 54 / RN 0.81 / React 19.1. `expo-doctor` passes 17 of 18 checks. The only failure is patch bumps.
- On native, nothing touches `window`/`document` at import or boot. About 140 web-only call sites are behind `Platform.OS` guards.
- [src/lib/supabase.ts](../src/lib/supabase.ts) uses AsyncStorage on native, and `detectSessionInUrl` is off on native.
- The login screen and the whole staff EOD app ([src/screens/staff/](../src/screens/staff/)) are native-clean. Admin `PhoneEodCount` is also native-clean.
- [src/theme/breakpoints.ts:29](../src/theme/breakpoints.ts) always returns `'phone'` on native, so the desktop Cmd shell can't be reached there.
- An EAS project already exists: `extra.eas.projectId` `8533e882-…`, owner `wzhchen113`, bound to slug `towson-inventory`.

## Acceptance criteria

### Gating: the simulator run (on this Mac, against the local Supabase stack from `npm run dev:db`)
- [ ] AC-1: The app builds and launches in the iOS Simulator (an iPhone device type) with `npx expo run:ios` or with an EAS build from the new `simulator` profile installed on the Simulator. It reaches the login screen with no red-box error and no crash.
- [ ] AC-2: The admin can log in as `admin@local.test` / `password` and lands on the **phone tier** of the admin Cmd UI. No desktop sidebar, TitleBar or ⌘K palette is rendered.
- [ ] AC-3: A staff user can log in, gets through the store picker if prompted, and reaches the staff EOD count screen.
- [ ] AC-4: A staff EOD count submits successfully on the Simulator. A new or updated `public.eod_submissions` row with `status='submitted'` exists in the local DB for that store, date and vendor, and its `client_uuid` is a valid UUID.
- [ ] AC-5 (proves B1): The admin phone weekly count (InventoryCountSection on the phone tier) submits successfully on the Simulator. The `submit_inventory_count` RPC returns success (not a `uuid` cast error). The new count row's `client_uuid` matches `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, and the success toast is shown.
- [ ] AC-6: The session survives an app kill and relaunch. Steps: log in as admin, swipe-kill the app in the Simulator app switcher, relaunch. The app opens on the phone tier with no login screen and no "session expired" toast. Repeat for a staff user, who lands back on the EOD flow.
- [ ] AC-7: There is **no** notification-permission dialog on a fresh install, either at boot or after login. Steps: delete the app from the Simulator, reinstall, launch, log in.
- [ ] AC-8: Splash and icon on the Simulator:
  - The home-screen icon is the I.M.R mark on a dark square, with no transparent or white corners showing through. iOS applies its own rounding mask.
  - The launch splash shows the I.M.R mark on the dark brand background, with no white flash before the first screen.
- [ ] AC-9 (Intl check): On the Simulator, `new Intl.DateTimeFormat('en-US', { timeZone: <a store's IANA zone>, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(<fixed instant>)` returns the same parts as Node/Chrome for the same input. The staff EOD screen also shows the same business date as the web app for the same store at the same moment. These helpers drive the EOD business day: `businessDay.ts`, `weekWindow.ts`, `eodStatus.ts`. The check is recorded in the verification note (AC-24).
  - If this check **fails**, stop and take it to the user. Adding an Intl/timezone polyfill is a scope decision this spec does not pre-approve.

### Per-bug fixes (jest-covered where the platform can be mocked)
- [ ] AC-10 (B1): [src/screens/cmd/sections/InventoryCountSection.tsx:1143](../src/screens/cmd/sections/InventoryCountSection.tsx) no longer falls back to a non-UUID `cu-<ts>-…` string. With `globalThis.crypto` undefined (simulating Hermes), the minted `clientUuid` matches the v4 regex in AC-5. Jest test.
- [ ] AC-11 (C4): [src/store/useStore.ts:4374](../src/store/useStore.ts) no longer falls back to `rcv-<ts>-…`. With `globalThis.crypto` undefined, the `clientUuid` passed to `db.receivePurchaseOrder` matches the v4 regex. Jest test.
- [ ] AC-12 (B1/C4, no regressions): no remaining code path in `src/` (outside test files) builds a `client_uuid` / `clientUuid` value from a non-UUID fallback. A repo grep for `` `cu-${ `` and `` `rcv-${ `` returns nothing.
- [ ] AC-13 (B2): on native, the weekly-count local draft written by `writeLocalCountDraft` (AsyncStorage) is restored by the InventoryCountSection restore path.
  - Jest: with Platform `ios`, a record seeded in mocked AsyncStorage under `imr.countDraft.admin-inventory.<storeId>.<userId>` is surfaced to the restore flow.
  - Web: the read stays synchronous `localStorage`, and the existing `InventoryCountSection.draft.test.tsx` passes unchanged in intent.
  - Simulator: type a partial weekly count, background the app, kill it, relaunch. The draft is offered or restored.
- [ ] AC-14 (B3): on native only, an `AppState` listener calls `supabase.auth.startAutoRefresh()` when the app becomes `active` and `supabase.auth.stopAutoRefresh()` when it leaves `active`.
  - The listener is not installed on web.
  - It is removed on unmount (no duplicate listeners across re-mounts).
  - Jest: AppState change events with Platform `ios` produce the start/stop calls; with Platform `web`, neither is called and no listener is added.
- [ ] AC-15 (C3): on native, `resolveRecoveryRedirectUrl()` ([src/lib/recoveryRedirect.ts:41](../src/lib/recoveryRedirect.ts)) returns `EXPO_PUBLIC_WEB_RECOVERY_URL` and **never** calls `Linking.createURL`.
  - If that env var is unset on native, `sendPasswordReset` returns a non-null `error` string and **does not** call `supabase.auth.resetPasswordForEmail`. It does not throw.
  - Web behavior is unchanged: env value if set, otherwise `window.location.origin + '/reset-password'`.
  - The existing native case in [src/lib/recoveryRedirect.test.ts:86](../src/lib/recoveryRedirect.test.ts), which pins `Linking.createURL`, is updated to the new behavior, and an "unset on native" case is added.
- [ ] AC-16 (C5): the boot-time `registerForPushNotifications()` call ([App.tsx:412-415](../App.tsx)) and the function itself ([App.tsx:458](../App.tsx)) are removed. No code path in `App.tsx` calls `Notifications.requestPermissionsAsync`.
  - The native `setNotificationHandler` ([App.tsx:143](../App.tsx)) returns `shouldShowBanner` / `shouldShowList` (plus `shouldPlaySound` / `shouldSetBadge`) and no longer returns the deprecated `shouldShowAlert`.
  - The web branch of that `useEffect` (manifest, apple-touch-icon, SW registration, install-prompt capture) is unchanged.
- [ ] AC-17 (C1): `downloadCSV` ([src/utils/index.ts:126](../src/utils/index.ts)) has a native branch that writes the CSV, keeping the UTF-8 BOM prefix, to the cache dir and opens the OS share sheet via `expo-file-system` + `expo-sharing`, mirroring [src/screens/staff/lib/shareReorder.ts](../src/screens/staff/lib/shareReorder.ts) `nativeShare`.
  - On the Simulator, tapping the phone weekly-count CSV chip opens the share sheet with a `.csv` file, and no "export failed" toast is shown.
  - If the share sheet is unavailable, the user sees the existing "export failed" toast (no unhandled rejection).
  - Web output is byte-identical to today. The existing `countExport.test.ts` BOM case passes unchanged.
  - A new jest case covers the native branch.

### Config and assets
- [ ] AC-18: `app.json` changes:
  - adds `"scheme": "imr"`;
  - sets `ios.supportsTablet` to `false`;
  - removes `ios.infoPlist.NSCameraUsageDescription`;
  - removes `CAMERA`, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` from `android.permissions`.

  `RECEIVE_BOOT_COMPLETED`, `VIBRATE`, the `expo-notifications` plugin and `ITSAppUsesNonExemptEncryption: false` stay. `npx expo config --type introspect` shows:
  - no `NSCameraUsageDescription` in the iOS Info.plist;
  - none of the three removed permissions in the Android manifest (if a plugin re-adds one, it must be explicitly blocked);
  - `UIDeviceFamily` covering iPhone only.
- [ ] AC-19: `app.json` `slug` is still `towson-inventory`, and `ios.bundleIdentifier` / `android.package` are still `com.towson.inventory`. `extra.eas.projectId` and `owner` are unchanged. The diff shows zero changes to these fields.
- [ ] AC-20: `eas.json` changes:
  - It gains a `simulator` build profile with `ios.simulator: true`.
  - The existing `development` (dev-client), `preview` (internal distribution) and `production` profiles are kept, and each declares which EAS environment it reads.
  - `expo-dev-client` is installed with the SDK-54-compatible version (via `npx expo install`).
- [ ] AC-21: `npx expo install --fix` is applied. Afterwards, `npx expo install --check` reports no out-of-range packages and `npx expo-doctor` passes all checks, or any remaining failure is written down with a reason in the verification note.
- [ ] AC-22: Icons and splash are produced by the existing generator [scripts/gen_logo.py](../scripts/gen_logo.py), extended for this spec, so they can be regenerated:
  - `assets/icon.png` is a 1024×1024, **full-bleed, opaque** square with no alpha channel. PIL mode is `RGB`, or `RGBA` with every pixel at alpha 255.
  - `assets/adaptive-icon.png` is a foreground with a **transparent** background and the mark inside the centered 66% safe zone. `android.adaptiveIcon.backgroundColor` is set to the generator's `BG` colour.
  - The splash shows the I.M.R mark on that same `BG` colour, configured through `app.json` / the `expo-splash-screen` plugin.
  - The colour source of truth is the generator's `BG` constant (`#1A1A18`). Do not introduce a second hex value.
  - **Web assets do not change.** `git diff --stat` shows no changes under `public/` and no change to `assets/favicon.png`.
- [ ] AC-23: `EXPO_PUBLIC_*` values are not read from any committed file. Builds get them from EAS environment variables, which the owner sets. The required list is written down in the spec's verification note: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN`, `EXPO_PUBLIC_WEB_RECOVERY_URL`, and optionally `EXPO_PUBLIC_GIT_SHA`.
  - No secret beyond what the web bundle already ships (never a service-role key) is added to any `EXPO_PUBLIC_*` variable.
  - `.env.local` stays gitignored.

### Web unchanged, and records
- [ ] AC-24: A verification note at `specs/181-native-internal-build/reviews/main-verification.md` records:
  - how AC-1 to AC-9 were checked (which build path, Simulator device and iOS version);
  - the Intl result for AC-9;
  - the EAS env var list from AC-23.
- [ ] AC-25: Web build behavior is unchanged:
  - full `npx jest`, `npm run typecheck`, `npm run typecheck:test` and `npm run e2e` all pass;
  - `npx expo export --platform web` succeeds;
  - after the change lands, both CI gates (`test.yml`, `db-migrations-applied.yml`) are green on `main`.
- [ ] AC-26: iOS App Transport Security is **not** weakened for `preview`/`production` builds: no `NSAllowsArbitraryLoads: true` in those builds' Info.plist. If reaching the local stack over plain `http://127.0.0.1:54321` needs an ATS exception, it is limited to local-networking or dev-client builds.

## In scope
- Code fixes B1, C4, B2, B3, C3, C5, C1 (AC-10 to AC-17).
- `app.json`: add `scheme: "imr"` and `supportsTablet: false`; drop the CAMERA / storage permissions and `NSCameraUsageDescription`; add splash/icon config.
- `eas.json`: add the `simulator` profile and map each profile to an EAS environment. Install `expo-dev-client`.
- `npx expo install --fix` patch bumps (expo, expo-file-system, expo-font, expo-notifications, jest-expo, netinfo).
- Icon, adaptive icon and splash, regenerated from the existing `scripts/gen_logo.py` artwork.
- Checking on the Simulator that `Intl.DateTimeFormat#formatToParts` with `timeZone` works (AC-9).
- jest coverage for every code fix. Manual Simulator verification recorded in the review note.
- Making sure the `preview` and `production` profiles produce builds the **owner** can upload to TestFlight and Play internal.

## Out of scope (explicitly)
- **C2:** PhoneOrdering CSV/PDF exports, which still show the "desktop only" toast. Deferred to a later spec.
- **C6:** image and CSV pickers, which are desktop-tier only. This also covers the unguarded `crypto.randomUUID()` in the image-upload path at [src/lib/db.ts:5748](../src/lib/db.ts). Deferred.
- **C7:** the reload button. Deferred, and could use expo-updates later.
- **expo-updates / OTA updates.** Deferred.
- **iPad layout and iPad support.** `supportsTablet: false` for v1.
- **Native push** (expo-notifications token registration, Expo push fan-out, APNs/FCM credentials). That is spec 182, after spec 180 lands. This spec only removes the boot prompt and fixes the handler keys.
- **Store listing / public release** (screenshots, descriptions, review submission). That is a later spec.
- **Changing the `app.json` slug or the bundle/package id.** The owner decided to keep `towson-inventory` / `com.towson.inventory`.
- **Any sign-in, purchase, enrolment or store submission by an agent.** These are owner-only (see Owner-only prerequisites).
- **Android emulator verification as a gate.** There is no Android SDK or Java on this Mac. Android config changes are in scope, but Android runtime checks are optional (see below) and not ACs.
- **Removing the dead `react-native-chart-kit` dependency.** It is unrelated cleanup; surface it to the owner as a separate hygiene item.
- **Fixing the misleading comment in [src/screens/staff/lib/uuid.ts:4](../src/screens/staff/lib/uuid.ts)**, which claims Hermes ships `crypto.randomUUID`. It is only in scope if the B1/C4 fix moves or reuses that helper. Otherwise it is a separate cleanup item.
- **Deep-link routing for the new `imr` scheme** (react-navigation `linking`, native recovery deep links). Adding the scheme only stops `Linking.createURL` from throwing and leaves room for later. Recovery on native goes to the web URL (AC-15).
- **CLAUDE.md edits.** Any "native build" convention update is proposed at release time, not done inside this spec.

## Owner-only prerequisites (not ACs; agents never do these)
1. **Install Xcode** from the Mac App Store (needs an Apple ID sign-in). Then run `sudo xcode-select -s /Applications/Xcode.app` and install an iOS Simulator runtime. Today this Mac has only CommandLineTools: no Xcode.app, no `simctl`, no CocoaPods, no Android SDK, no Java, no `eas-cli`. AC-1 to AC-9 cannot run until this is done.
2. **Optional:** install Android Studio (bundles the SDK and a JDK) to try the Android build on an emulator.
3. **`eas login`** as `wzhchen113`. Needed for EAS cloud builds, including the `simulator` profile. A local `npx expo run:ios` does not need it.
4. **Set the EAS environment variables** listed in AC-23 for each EAS environment the profiles use, in the EAS dashboard or with `eas env:create`.
5. **Enrol in the Apple Developer Program ($99/yr)** and **Google Play Console ($25 one-time).** Only needed for TestFlight and Play internal uploads, not for the Simulator.
6. **Run the TestFlight and Play internal uploads** (`eas build` + `eas submit`, or manual upload). This needs the accounts from step 5 and handling of EAS credential prompts (certificates, provisioning, push entitlement).

## Owner follow-through after merge (non-gating)
- A `preview` or `production` iOS build installs from TestFlight on a physical iPhone, and AC-2 to AC-7 hold there.
- An Android build installs from the Play internal track, and the same flows hold.
- Optional: the Android emulator, if Android Studio is installed. Note that the emulator reaches the host's local stack at `10.0.2.2`, not `127.0.0.1`.

## Open questions resolved
- Q: What is the first target? → A: Internal testing: a Simulator build now, then TestFlight + Play internal. Store listing is a later spec.
- Q: Which tiers and devices? → A: Phone tier only, iPhone only (`supportsTablet: false`). The desktop Cmd shell stays web-only; `breakpoints.ts` already forces the phone tier on native.
- Q: Native push? → A: Out of scope; it goes to spec 182 after spec 180 lands. v1 removes the useless boot-time permission prompt and fixes the deprecated handler keys.
- Q: Change the slug or bundle/package id? → A: No. Keep slug `towson-inventory` and id `com.towson.inventory`.

## Non-blocking assumptions (PM defaults; the owner may override at review)
These are not blockers. Each has a stated default so the architect can proceed.
1. **Which Supabase each build targets.**
   - The gating Simulator run (AC-1 to AC-9) uses the local stack. The simplest path is `npx expo run:ios`, which reads `.env.local`.
   - The `preview`/`production` EAS environments point at **prod** Supabase, with the same values as Vercel.
   - The `simulator` profile maps to the `development` EAS environment, whose values the owner chooses.
2. **Native password reset when `EXPO_PUBLIC_WEB_RECOVERY_URL` is unset.** Default: return an error string and send nothing (AC-15). The alternative, omitting `redirectTo`, would bring back the spec 085 "lands on the dashboard Site URL" bug.
3. **`NSPhotoLibraryUsageDescription`** is kept as is. The request only named CAMERA and the storage permissions. Removing it is a one-line follow-up if the owner wants it, since no photo-library module is installed today.
4. **Brand background colour.** The assessment says `#1c1c1a`, but `scripts/gen_logo.py` defines `BG = #1A1A18`, which matches `Colors.textPrimary`. Default: use the generator constant everywhere (AC-22).

## Dependencies
- `expo-dev-client` (new; SDK-54-pinned via `npx expo install`).
- Already installed: `expo-file-system` (v19 `File`/`Paths` API), `expo-sharing`, `expo-notifications`, `expo-linking`, `@react-native-async-storage/async-storage`.
- `expo-splash-screen` config (ships with `expo`; configured through app config).
- A UUID source that works on Hermes. Prefer reusing the existing RFC-4122 v4 helper ([src/screens/staff/lib/uuid.ts](../src/screens/staff/lib/uuid.ts) `uuidv4`) or a shared equivalent over adding `expo-crypto`. The architect decides where it lives, given the staff-subtree boundary.
- Python 3 + Pillow (already required by `scripts/gen_logo.py`) to regenerate the assets.
- The local Supabase stack (`npm run dev:db`) for the gating Simulator run.
- Owner prerequisites 1, 3 and 4 above, for AC-1 to AC-9.
- Coordination: **spec 180** (READY_FOR_BUILD, in flight) may also edit `App.tsx` and the notification UX. Expect a merge touchpoint in `App.tsx`. Spec 182 depends on this spec's C5 cleanup and on spec 180.

## Project-specific notes
- **Cmd UI section / legacy:** no new section. The changes touch the existing phone-tier InventoryCountSection (B1, B2, C1 call site), `App.tsx` (C5, likely B3), `src/lib/*` (B3, C3, B2), `src/utils/index.ts` (C1) and `src/store/useStore.ts` (C4). There is no legacy surface.
- **Per-store or admin-global:** no change to data scope. Everything still goes through existing RLS (`auth_can_see_store()`); no policy changes.
- **Realtime channels touched:** none. Existing `store-{id}` / `brand-{id}` sync runs unchanged on native. B3's auto-refresh pause and resume also keeps the JWT valid for realtime after a long background.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** the fixes target native. Every web code path must behave exactly as before (AC-25), and every new native branch is behind `Platform.OS !== 'web'`.
- **app.json slug:** untouched (`towson-inventory`), and so is the bundle/package id (AC-19).
- **Tests:**
  - **jest** for AC-10 to AC-17. Note that the existing tests pinning old behavior must be updated: `recoveryRedirect.test.ts` native case, and possibly `countExport.test.ts` / `InventoryCountSection.draft.test.tsx` if the seams change.
  - **No pgTAP, no shell smoke:** there are no DB or edge changes.
  - **e2e (Playwright)** must stay green as the web-regression guard.
  - **Manual Simulator verification** is recorded in `reviews/main-verification.md` (AC-24).
- **Risks:**
  1. Expo config plugins (notifications, document-picker) may re-add removed Android permissions, so verify with `expo config --type introspect` (AC-18).
  2. The `expo-notifications` plugin adds the push entitlement, so TestFlight provisioning needs the Push capability even though push is off. The owner handles this through EAS credentials.
  3. ATS and plain-http local stack (AC-26).
  4. The `downloadCSV` native branch is async while current call sites toast synchronously; the success toast must not fire before the share outcome is known.
  5. Patch bumps to `jest-expo` / `expo` can shift jest behavior, so run the full suite, not a subset.

## Backend design

Architect: backend-architect, 2026-10-26. I accept all four PM defaults (Supabase per build, C3 error-and-send-nothing, keep `NSPhotoLibraryUsageDescription`, brand colour `#1A1A18` from `scripts/gen_logo.py`). I found no concrete problem with any of them. Two spec corrections and one AC contradiction are listed in §0. Each has a default so the build can go ahead.

### §0. Spec corrections and AC interpretations (read first)

1. **AC-13 Simulator sub-step cannot be done on the phone tier (contradiction, PM decision needed, non-blocking).** On native, the only reachable surface is `PhoneWeeklyCount` ([InventoryCountSection.tsx:1324-1350](../src/screens/cmd/sections/InventoryCountSection.tsx)). Its `model` has **no Save-draft affordance and no autosave** (it passes no `onSaveDraft`). On native, `writeLocalCountDraft` is only ever called from `onSaveDraft` (desktop-only) and from reconcile actions that need a local copy to already exist ([countDrafts.ts:125-164](../src/lib/countDrafts.ts)). So "type a partial weekly count, background, kill, relaunch → draft restored" can't happen on native today, with or without B2. Typing alone never persists anything, on web either.
   - **Default (proceed):** implement the B2 read path plus its jest coverage exactly as specified (code is the same either way). Record the Simulator sub-step as **N/A** in `main-verification.md` with this reason.
   - **Alternative (PM/owner):** add a phone Save-draft button or autosave-on-background. That is new UX, needs its own spec, and is not designed here.
2. **`expo-splash-screen` does NOT ship with `expo`.** It is absent from `node_modules` (only `@expo/prebuild-config`'s unversioned fallback plugin exists, and that only reads the top-level `splash` key). It is required for the plugin config and for holding the splash until fonts load (AC-8 "no white flash"). **Decision: install it** via `npx expo install expo-splash-screen`. It is SDK-54-pinned and first-party, and its web shim is a no-op. This is the second new dependency alongside `expo-dev-client`.
3. **AC-17 "the existing `countExport.test.ts` BOM case passes unchanged".** jest-expo runs with `Platform.OS === 'ios'` (the draft test at [InventoryCountSection.draft.test.tsx:103](../src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx) relies on this). A `Platform.OS` branch in `downloadCSV`, which this design requires for convention, would send the unchanged case down the native path. **Interpretation:** the case's **assertions** stay byte-identical, and its setup gains a `Platform.OS = 'web'` pin/restore (the `setPlatform` idiom from [recoveryRedirect.test.ts:47](../src/lib/recoveryRedirect.test.ts)). The alternative, feature-detecting `document`, would break the "every native branch is behind `Platform.OS`" convention in Project-specific notes, so I reject it.
4. **AC-18 `UIDeviceFamily` is not visible in `npx expo config --type introspect`.** `supportsTablet: false` is applied by `withDeviceFamily` to the Xcode build setting `TARGETED_DEVICE_FAMILY` in `project.pbxproj`, not to Info.plist. Xcode writes `UIDeviceFamily` into the built `.app`'s Info.plist. **Verification method:** after `npx expo prebuild -p ios --no-install`, check that `ios/*.xcodeproj/project.pbxproj` has `TARGETED_DEVICE_FAMILY = 1` (or check the built `.app/Info.plist` with `plutil -p`).
5. **AC-22 "no second hex value".** `app.json` is JSON and can't reference a Python constant, so it has to carry the literal `#1A1A18`. The single source of truth is enforced by a jest pin (§6) that parses `BG = (26, 26, 24, 255)` out of `scripts/gen_logo.py` and asserts every brand-colour field in `app.json` equals it.
6. **AC-26.** Expo's prebuild iOS template ships `NSAppTransportSecurity { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true }` in every configuration. That is the "local-networking" exception AC-26 allows, and it is what lets the Simulator reach `http://127.0.0.1:54321`. **Add no ATS keys to `app.json`.** Verify the prebuilt Info.plist (§5.4).

### §1. Data model changes
**None.** This is a frontend/config-only spec: no migrations, no tables, columns or indexes, no seed change. No `supabase/migrations/*` file is created.

### §2. RLS impact
**None.** No policy is added or changed. Every native request goes through the same `auth_can_see_store()` / `auth_is_admin()`-gated tables and RPCs as web (`submit_inventory_count`, `receive_purchase_order`, `staff_submit_eod`, `user_count_drafts`). B1 and C4 only change the *value* of `p_client_uuid` so it becomes a real UUID, and the RPC signatures are unchanged.

### §3. API contract
**No new or changed PostgREST surface or RPC.** The existing RPC contracts are honoured:
- `submit_inventory_count(p_client_uuid uuid, …)`: the client now always sends an RFC-4122 v4 string (B1).
- `receive_purchase_order(…, p_client_uuid uuid)`: same (C4).
- `supabase.auth.resetPasswordForEmail(email, { redirectTo })`: on native, it is not called at all when the redirect URL is unconfigured (C3).

### §4. Edge function changes
**None.** No function is added or modified and `supabase/config.toml` is untouched, so no `verify_jwt` decisions are needed. Cold-start: not applicable.

### §5. Client design, decision by decision

#### §5.1 Hermes-safe UUID (B1, C4)
- **Location: new shared module `src/lib/uuid.ts`** exporting `uuidv4(): string`. Pure TS, no imports.
- **Staff file becomes a re-export.** [src/screens/staff/lib/uuid.ts](../src/screens/staff/lib/uuid.ts) becomes `export { uuidv4 } from '../../../lib/uuid';` plus a corrected header comment. This follows the established staff → shared re-export precedent ([staff/lib/eodCountMode.ts:20](../src/screens/staff/lib/eodCountMode.ts), [staff/lib/countOrder.ts:33](../src/screens/staff/lib/countOrder.ts)). Staff call sites (`useStaffStore.ts:47`, `useEodSubmit.ts:34`, `Receiving.tsx:53`) and the `Receiving.test.tsx:72` mock of `'../lib/uuid'` keep working unchanged. Staff code still never imports `useStore` (spec 063 contract intact). Because the helper moves, the misleading "Hermes ships `crypto.randomUUID`" comment is fixed in this spec (Out-of-scope carve-out condition met).
- **Algorithm, tiered:**
  1. `globalThis.crypto.randomUUID` if present (web, Node/jest).
  2. else `globalThis.crypto.getRandomValues(new Uint8Array(16))` if present, with the version nibble set to `4` and the variant set to `10xx`.
  3. else the existing `Math.random` template. **On Hermes (RN 0.81 / SDK 54) neither (1) nor (2) exists, so (3) is what runs on native.** It already runs in production for every staff EOD submit today.
- **expo-crypto: NOT adopted.**
  - The key is an idempotency/dedup key the server treats as opaque, not a secret. A collision needs two `Math.random` streams to emit the same 122 bits, which is negligible at this scale.
  - Adding expo-crypto would mean a native module, a jest mock in every suite that transitively imports the helper, and a second UUID source diverging from staff.
  - Upgrading later is a one-file change inside `src/lib/uuid.ts`.
- **Call sites:**
  - [InventoryCountSection.tsx:1143-1146](../src/screens/cmd/sections/InventoryCountSection.tsx) becomes `const clientUuid = uuidv4();`.
  - [useStore.ts:4374-4377](../src/store/useStore.ts) becomes `const clientUuid = uuidv4();`.
  - Update the stale "via crypto.randomUUID()" doc comments at [useStore.ts:768](../src/store/useStore.ts) and [db.ts:1396](../src/lib/db.ts). This is comment-only; db.ts has no code change.
  - [db.ts:5748](../src/lib/db.ts) (C6) stays out of scope and untouched.

#### §5.2 Async native read for `countDraftLocal` (B2)
- **New export in [src/lib/countDraftLocal.ts](../src/lib/countDraftLocal.ts):**
  `loadLocalCountDraft(userId: string, screen: CountOrderScreen, storeId: string): Promise<LocalCountDraft | null>`
  - web: `Promise.resolve(readLocalCountDraft(...))`. The sync localStorage read is reused verbatim.
  - native: `AsyncStorage.getItem(countDraftLocalKey(...))`, then `JSON.parse`, then `isLocalCountDraft`. A miss, malformed value, parse error or rejection resolves `null`. **Never rejects.**
  - The key builder is shared with `writeLocalCountDraft`, so a native write is readable by the native read (AC-13 jest).
- `readLocalCountDraft` stays exported and unchanged as the sync web primitive. Update its doc comment to point native callers at `loadLocalCountDraft`.
- **Call-site changes in InventoryCountSection (both reads):**
  - Draft-load effect (L780): `const local = await loadLocalCountDraft(...)`, then an added `if (cancelled) return;` immediately after. Everything else stays in order (server fetch, reconcile, sync action, guarded restore).
  - Reconnect effect (L849): move the read **inside** the async IIFE (`const local = await loadLocalCountDraft(...); if (cancelled || !local) return;`). This replaces the synchronous early return.
- Web effect: one extra microtask before reconcile, with no ordering change relative to `fetchCountDraft` (which was already awaited after the read). The SF-1 restore-once guard (`mayRestore` computed before the IIFE) is unaffected.
- **No `Platform.OS` branching in the section.** The platform split stays inside `countDraftLocal.ts`, following the `persistDarkModeLocal` precedent cited in its header.
- **Test mocks that must gain the new export:**
  - `InventoryCountSection.draft.test.tsx:76` mock: add `loadLocalCountDraft: async (u, s, st) => mockLocalStore[localKey(u, s, st)] ?? null`.
  - `InventoryCountSection.layouts.test.tsx:73` mock: add `loadLocalCountDraft: jest.fn(() => Promise.resolve(null))`.
  - Without these, both suites call `undefined` (jest runs as `ios`).

#### §5.3 AppState auto-refresh (B3)
- **New module `src/lib/authAutoRefresh.ts`** exporting `installAuthAutoRefresh(): () => void`.
  - `Platform.OS === 'web'`: return a no-op remover. **No listener is added.**
  - native: `const sub = AppState.addEventListener('change', (state) => …)`.
    - On `'active'`: `void supabase.auth.startAutoRefresh().catch(() => {})`.
    - On any other state (`'background'`, `'inactive'`): `void supabase.auth.stopAutoRefresh().catch(() => {})`.
    - Return `() => sub.remove()`.
  - Defensive: if `supabase.auth.startAutoRefresh` is not a function (test doubles), return a no-op. **Nothing is called at install time:** auth-js already starts its own ticker on non-browser init, so the listener only reacts to transitions.
  - Same carve-out footing as `sessionWatch.ts`: auth-client plumbing, not PostgREST, so not db.ts.
- **Mount point: App.tsx, as its own one-line effect** `useEffect(() => installAuthAutoRefresh(), []);`. Insert it as a pure-insertion hunk **between the restore effect (ends L339) and the spec-152 comment block (L341)**. It must not go inside the spec-152 effect or near the notification effect (L411), which spec 180 may touch.
  - One supabase client serves both admin and staff stacks, so one installer covers both surfaces.
- **Not inside `watchSessionLoss()`.** That would couple a lifecycle concern into the store-agnostic watcher. Every existing `sessionWatch` jest suite runs as `ios`, so it would start installing AppState listeners against a supabase mock with no `startAutoRefresh`.
- **Interaction with `sessionWatch.ts`:** `startAutoRefresh()` runs an immediate refresh tick on foreground.
  - Refresh succeeds: auth-js emits `TOKEN_REFRESHED` with the same user, which is a no-op in `handleAuthEvent` (not a loss, same `userId`). Realtime picks up the new JWT automatically, so the `store-{id}`/`brand-{id}` channels keep authorizing.
  - Refresh fails (revoked or expired refresh token): auth-js emits `SIGNED_OUT` with a null session. The watcher tears down and toasts "session expired" once. That is the honest spec-152 outcome, and B3 makes it happen promptly on foreground instead of after up to one 30 s ticker interval of `200 []` reads.
  - The intentional-sign-out flag is unaffected because B3 never signs out.

#### §5.4 Native `downloadCSV` contract (C1)
- **Signature change** in [src/utils/index.ts:126](../src/utils/index.ts): `downloadCSV(filename: string, csvContent: string): Promise<void>`.
  - **web:** run the existing synchronous Blob/anchor body **verbatim**, then `return Promise.resolve()`. **Do not make the function `async`.** A synchronous throw must keep throwing synchronously, so the existing non-awaiting callers' `try/catch` still catches it and web is byte- and timing-identical.
  - **native:** return a private `shareCsvNative(filename, '﻿' + csvContent)`. This mirrors [shareReorder.ts:98-113](../src/screens/staff/lib/shareReorder.ts) `nativeShare`:
    1. `await Sharing.isAvailableAsync()`. If false, throw `Error('Sharing is not available on this device')` before writing a file.
    2. `new File(Paths.cache, filename)`, `create({ overwrite: true })`, `write(content)`.
    3. `await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text', dialogTitle: filename })`.
  - It **rejects** on failure. It does not toast; the caller owns the toast.
  - Duplicate the ~8 lines rather than importing from the staff subtree. Admin code must not depend on the verbatim-port staff tree.
- **Call sites:**
  - [InventoryCountSection.tsx:400-417](../src/screens/cmd/sections/InventoryCountSection.tsx) (the phone CSV chip, the native-reachable one): make the callback `async` and `await downloadCSV(...)` inside the existing `try`. The success toast now fires only after the share sheet resolves, and a rejection lands in the existing `exportFailed` toast (risk 4 closed). `PhoneWeeklyModel.onExportCsv: () => void` accepts an async function unchanged.
  - [EODCountSection.tsx:797-814](../src/screens/cmd/sections/EODCountSection.tsx): same two-token change (`async` + `await`) for symmetry with its spec-139 sibling. Its desktop tree is unreachable on native, so this is consistency, not a fix.
  - [ExportCsvDrawer.tsx:77](../src/components/cmd/ExportCsvDrawer.tsx) and [RecipesSection.tsx:226](../src/screens/cmd/sections/RecipesSection.tsx): **unchanged.** They are desktop-tier only. On web the returned promise is already resolved and the sync-throw semantics are preserved.
- Filename safety: `countExportFilename(...)` output becomes a path segment under `Paths.cache`. The developer must confirm it can't contain `/` (it slugifies the store name). If it can, sanitize inside `shareCsvNative` only, never in the web path.

#### §5.5 C3 recovery redirect
- [recoveryRedirect.ts](../src/lib/recoveryRedirect.ts):
  - `resolveRecoveryRedirectUrl(): string | null`.
    - web: unchanged (env value if non-empty, else `window.location.origin + '/reset-password'`; always a string).
    - native: return `EXPO_PUBLIC_WEB_RECOVERY_URL` if non-empty, else `null`. **Remove the `expo-linking` import and the `Linking.createURL` call** from this file. `expo-linking` stays a dependency because `RecoveryGate.tsx` uses it.
  - Export `RECOVERY_URL_UNSET_ERROR = 'Password reset is not configured on this device (missing web recovery URL).'`. It is English, matching UsersSection's English toast `text1`.
- [auth.ts:748 `sendPasswordReset`](../src/lib/auth.ts): resolve the URL **before** calling Supabase. If it is `null`, `return { error: RECOVERY_URL_UNSET_ERROR }` without calling `resetPasswordForEmail`. Otherwise behave as today. Return shape unchanged, never throws.
- Tests: replace the native case at `recoveryRedirect.test.ts:86` with two cases:
  - native + env set returns the env value and `createURLMock` is **not** called;
  - native + env unset returns `null`.
  - Add a `sendPasswordReset` native-unset case asserting `{ error: RECOVERY_URL_UNSET_ERROR }` and `resetMock` not called.
  - Keep the `jest.mock('expo-linking')`; it is harmless and lets the "not called" assertion stand.

#### §5.6 C5 notifications (App.tsx)
- [App.tsx:143-149](../App.tsx): the handler returns `{ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }`. The module-scope `require` stays as is.
- [App.tsx:411-415](../App.tsx): the native branch becomes `if (Platform.OS !== 'web') return;`. The web body (manifest, apple-touch-icon, SW, install-prompt) is byte-unchanged.
- Delete `registerForPushNotifications` ([App.tsx:458-473](../App.tsx)).
- Spec 180 touchpoint: before editing, diff App.tsx against spec 180's in-flight changes. Edit only these hunks, do not reformat, and rebase rather than resolve by rewriting.

#### §5.7 Splash and icons (AC-8, AC-22)
- **Shape: the `expo-splash-screen` plugin, not the top-level `splash` key.** Remove top-level `splash` and add to `plugins`:
  `["expo-splash-screen", { "image": "./assets/splash-icon.png", "imageWidth": 200, "resizeMode": "contain", "backgroundColor": "#1A1A18" }]`
  - The plugin is the SDK 52+ path (Android 12+ SplashScreen API: centered icon on a colour).
  - Keeping both forms would create two drifting sources.
- **Hold the splash until fonts are ready (App.tsx, two small hunks):**
  - Module scope, next to the notification block: `if (Platform.OS !== 'web') SplashScreen.preventAutoHideAsync().catch(() => {});`
  - Inside `App()`, **before** `if (!fontsLoaded) return null;` (rules of hooks): `useEffect(() => { if (fontsLoaded && Platform.OS !== 'web') SplashScreen.hideAsync().catch(() => {}); }, [fontsLoaded]);`
  - This removes the root-view gap between splash dismissal and the first `GestureHandlerRootView` paint. On web it is gated off entirely.
- **`android.adaptiveIcon.backgroundColor` = `#1A1A18`.**
- **`scripts/gen_logo.py` changes:**
  - Add a `transparent_bg: bool = False` parameter to `render_full_imr` (skip the BG fill).
  - Add a CLI flag `--target {all,native,web}` (default `all`, preserving today's behavior). `native` writes only these:
    - `assets/icon.png` = `render_full_imr(1024, full_bleed=True).convert("RGB")`. Opaque, full-bleed, same text sizing as today; iOS applies the mask.
    - `assets/adaptive-icon.png` = `render_full_imr(1024, full_bleed=True, safe_zone_pct=0.66, transparent_bg=True)`. RGBA foreground, mark inside the 66% zone.
    - `assets/splash-icon.png` (new) = `render_full_imr(1024, transparent_bg=True)`. White mark on transparent.
  - `web` writes only the `public/*` files plus `assets/favicon.png`, with the **unchanged** recipes. The PWA maskable `public/icon-512.png` keeps BG-filled `render_full_imr(512, full_bleed=True, safe_zone_pct=0.66)`.
  - **The developer runs `python3 scripts/gen_logo.py --target native` only.** Then `git diff --stat -- public assets/favicon.png` must be empty (AC-22).
  - Update the docstring's output table.
- **Delete `assets/splash.png`** (the blank white image). Nothing references it once the top-level `splash` key is gone.
- Web is unaffected: `web.favicon` is set, so `expo export --platform web` does not derive anything from `icon`.

#### §5.8 `app.json` (AC-18, AC-19)
Changes only:
- `"scheme": "imr"`.
- `ios.supportsTablet: false`.
- Delete `ios.infoPlist.NSCameraUsageDescription`.
- `android.permissions` → `["RECEIVE_BOOT_COMPLETED", "VIBRATE"]`.
- **Add `android.blockedPermissions: ["android.permission.CAMERA", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"]`.** This is the durable guard: it emits `tools:node="remove"`, so a re-add from the prebuild template, a library manifest merged at Gradle time, or a future plugin is stripped.
- `adaptiveIcon.backgroundColor` → `#1A1A18`.
- The splash change from §5.7.

`NSPhotoLibraryUsageDescription`, `ITSAppUsesNonExemptEncryption`, the `expo-notifications` / `expo-document-picker` / `expo-font` plugins, and `slug`, `bundleIdentifier`, `package`, `extra.eas.projectId` and `owner` are **untouched** (AC-19).
- `expo-document-picker` adds no iCloud entitlements, because `ios.usesIcloudStorage` is unset ([withDocumentPickerIOS.js:14](../node_modules/expo-document-picker/plugin/build/withDocumentPickerIOS.js)), so it adds no provisioning burden.
- I checked that neither the notifications plugin nor the document-picker plugin adds any Android permission. No installed library manifest declares storage or camera permissions.

#### §5.9 `eas.json` profile → EAS environment mapping (AC-20)

| Profile | Purpose | `environment` | Shape |
|---|---|---|---|
| `development` | dev client (needs Metro) | `development` | existing + `"environment": "development"` |
| `simulator` (new) | **standalone** iOS Simulator `.app` that reaches login with no Metro (AC-1) | `development` | `{ "ios": { "simulator": true }, "environment": "development" }`. **Does not extend `development`**: a dev-client build would open the dev launcher, not the login screen. |
| `preview` | internal / ad-hoc installs (iOS needs registered devices via `eas device:create`) | `preview` | existing + `"environment": "preview"` |
| `production` | **the TestFlight and Play-internal build** (store-signed IPA / AAB, `autoIncrement` with remote versions) | `production` | existing + `"environment": "production"` |

- Ad-hoc `preview` IPAs can't go to TestFlight. The owner uploads with `eas build -p ios|android --profile production`, then `eas submit --profile production`.
- `preview` and `production` EAS environments both get the **prod** values (PM default 1).
- `development` values are the owner's choice. For an EAS-built `simulator` run against the local stack, set `EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` (the Simulator shares the host loopback).
- The gating path stays `npx expo run:ios`, which reads `.env.local`.
- EAS env vars named `EXPO_PUBLIC_*` must use `plaintext` or `sensitive` visibility, not `secret`, because they are inlined into the bundle.
- Required list (AC-23): `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN`, `EXPO_PUBLIC_WEB_RECOVERY_URL`, and optionally `EXPO_PUBLIC_GIT_SHA`. `EXPO_PUBLIC_VAPID_PUBLIC_KEY` is web-push only and not needed on native.
- Install `expo-dev-client` with `npx expo install expo-dev-client`. It is compiled only into `developmentClient: true` (Debug) builds.

#### §5.10 Verifying the removed permissions and config stay removed
1. **Durable (CI):** new jest pin `src/lib/nativeAppConfig.spec181.test.ts` (unit project). It reads `app.json`, `eas.json`, `App.tsx` and `scripts/gen_logo.py` as text/JSON and asserts:
   - `android.permissions` contains none of the three removed permissions, and `blockedPermissions` contains all three (fully qualified);
   - no `NSCameraUsageDescription`, `supportsTablet === false`, `scheme === 'imr'`;
   - **AC-19:** `slug === 'towson-inventory'`, `bundleIdentifier` and `package === 'com.towson.inventory'`, and `projectId` / `owner` equal their current values;
   - adaptive-icon and splash-plugin `backgroundColor` equal the hex parsed from `gen_logo.py`'s `BG` tuple;
   - no top-level `splash` key;
   - `eas.json` has a `simulator` profile with `ios.simulator === true`, and every build profile declares `environment`;
   - **AC-16:** `App.tsx` text contains no `requestPermissionsAsync`, `registerForPushNotifications` or `shouldShowAlert`, and does contain `shouldShowBanner` and `shouldShowList`.
2. **Generated config (manual, recorded in main-verification.md):**
   - Run `npx expo config --type introspect`. Check that Info.plist has no `NSCameraUsageDescription` and that the AndroidManifest mod result shows the three permissions only with `tools:node="remove"`.
   - Then run `npx expo prebuild --clean --no-install`. Grep `android/app/src/main/AndroidManifest.xml` for the same, check `TARGETED_DEVICE_FAMILY = 1` in the pbxproj (§0.4), and run `plutil -p ios/*/Info.plist` to confirm `NSAllowsArbitraryLoads` is false or absent (AC-26).
   - Then `rm -rf ios android`. Both are gitignored, but leftovers make expo-doctor warn about unsynced native dirs.
3. **Ground truth for Gradle merge (owner, optional, non-gating):** after the first Play AAB, run `bundletool dump manifest --bundle app.aab | grep uses-permission`.

#### §5.11 `npx expo install --fix` bumps (AC-21)
- **Take all of them.** They are the SDK-54-pinned targets Expo's compatibility table computes: `expo` 54.0.33 → latest 54.0.x, `expo-file-system`, `expo-font`, `expo-notifications`, `jest-expo`, `@react-native-community/netinfo` (minor within 11.x). No major moves.
- Do it as **step 1, isolated**: run `--fix` plus the two new installs, then full `npx jest`, `npm run typecheck`, `npm run typecheck:test` and `npm run e2e`, before any code change. That way a jest-expo behavior shift is attributable (risk 5).
- `package-lock.json` changes accordingly.
- **Leave `react-native-chart-kit` alone** (out of scope).
- `@react-native-async-storage/async-storage` stays at its exact pin unless `--check` flags it.
- **Prebuild side effect:** `npx expo run:ios` / `expo prebuild` may rewrite `package.json` `scripts.ios` / `scripts.android` (`expo start --ios` → `expo run:ios`). **Revert that.** The only intended `package.json` changes are dependency versions plus `expo-dev-client` and `expo-splash-screen`.

### §6. `src/lib/db.ts` surface
**No new or changed db.ts helper.** All PostgREST/RPC traffic is unchanged. Only the stale comment at db.ts:1396 is touched. The new modules (`src/lib/uuid.ts`, `src/lib/authAutoRefresh.ts`, `loadLocalCountDraft`) are not PostgREST and sit outside db.ts, on the same footing as `countDraftLocal.ts` / `sessionWatch.ts`. No snake_case → camelCase mapping is involved. New TS signatures:
- `uuidv4(): string` (`src/lib/uuid.ts`)
- `loadLocalCountDraft(userId: string, screen: CountOrderScreen, storeId: string): Promise<LocalCountDraft | null>` (`src/lib/countDraftLocal.ts`)
- `installAuthAutoRefresh(): () => void` (`src/lib/authAutoRefresh.ts`)
- `resolveRecoveryRedirectUrl(): string | null`, plus `RECOVERY_URL_UNSET_ERROR: string` (`src/lib/recoveryRedirect.ts`)
- `downloadCSV(filename: string, csvContent: string): Promise<void>` (`src/utils/index.ts`)

### §7. Realtime impact
**None.** No table enters or leaves the `supabase_realtime` publication, so **no `docker restart supabase_realtime_imr-inventory` step is needed**. The `store-{id}` / `brand-{id}` channels in `useRealtimeSync.ts` run unchanged on native. B3 keeps their JWT fresh across backgrounding: auth-js propagates `TOKEN_REFRESHED` to realtime.

### §8. Frontend store impact
- `useStore.ts`:
  - only `receivePurchaseOrder`'s UUID mint changes (import `uuidv4` from `../lib/uuid`);
  - no slice shape change;
  - that action is not optimistic, and its `notifyBackendError` failure path is untouched.
- `submitInventoryCount` is untouched (the section mints the key).
- No optimistic-then-revert pattern is added or altered.
- `useStaffStore` is untouched apart from the re-exported `uuidv4`, whose behavior on web and native is identical to today.

### §9. Test plan (jest; one file per fix, `spec181` suffix per house style)
- `src/lib/uuid.test.ts`:
  - `crypto` undefined → v4 regex (AC-10/11 core);
  - only `getRandomValues` → v4 regex with correct version and variant bits;
  - `randomUUID` present → delegates.
- AC-10 section test, `InventoryCountSection.clientUuid.spec181.test.tsx`: reuse the draft-test mock scaffold, delete `globalThis.crypto`, submit one count, and assert that the `clientUuid` passed to `submitInventoryCount` matches the v4 regex.
- AC-11, `src/store/useStore.receivePo.clientUuid.spec181.test.ts`: mock `db.receivePurchaseOrder`, set `crypto` undefined, and assert arg 3 matches the v4 regex.
- AC-13, `src/lib/countDraftLocal.test.ts`: on `ios`, seeded AsyncStorage (global mock in `tests/jest.setup.ts:35`) under the exact key → returned; malformed → `null`; `getItem` rejects → `null`. On `web`, it delegates to localStorage.
- AC-14, `src/lib/authAutoRefresh.test.ts`:
  - `ios`: `'active'` → start, `'background'`/`'inactive'` → stop; the remover calls `sub.remove()`; install twice + remove twice leaves zero listeners;
  - `web`: `addEventListener` is never called.
- AC-15: `recoveryRedirect.test.ts` updates per §5.5.
- AC-17, new `src/utils/downloadCSV.native.spec181.test.ts`: mock `expo-file-system` / `expo-sharing` like [shareReorder.test.ts:40-58](../src/screens/staff/lib/shareReorder.test.ts). Assert the cache file name, BOM-prefixed content, and `shareAsync` with `text/csv`; unavailable → rejects and no file is created. The `countExport.test.ts` BOM case gains a web pin (§0.3).
- AC-16/18/19/20/22: `src/lib/nativeAppConfig.spec181.test.ts` (§5.10).
- AC-12: `grep -rn '`cu-${\|`rcv-${' src --include='*.ts*' | grep -v test` returns nothing (record the result).
- No pgTAP, no shell smoke. Playwright e2e is the web-regression guard.

### §10. Risks and tradeoffs
1. **jest's default `Platform.OS` is `ios`.** Any existing suite that reaches a changed function takes the native path unless it pins `web`. Known hits are the `countExport` BOM case (§0.3) and the two InventoryCountSection mocks (§5.2). Run the full suite, and grep for other `jest.mock('…/countDraftLocal')` and `downloadCSV` users before finishing.
2. **App.tsx merge with spec 180.** The hunks are: handler keys (L143-149), splash prevent (module scope), the auto-refresh effect (after L339), the splash hide effect (before L437), the notification effect's native branch (L412-415), and deleting L458-473, plus two imports. Spec 180 most likely touches the notification effect, which is a likely conflict there. Resolve by keeping 180's additions and applying only the 4-line native-branch removal.
3. **Math.random UUIDs on Hermes.** These are non-cryptographic but are idempotency keys only. This is the status quo for staff since spec 063. Moving to a CSPRNG later is a one-file change.
4. **Splash hold.** If `useFonts` never resolves (font asset failure), the splash would stay up. Expo's `useFonts` resolves `[false, error]` on failure, but `fontsLoaded` stays false and `App` already renders `null` forever in that case today, so the hold adds no new failure mode. The developer may also hide on `fontError` if it is cheap.
5. **Push entitlement.** The `expo-notifications` plugin adds `aps-environment`, so production provisioning needs the Push capability even though push is off. EAS credentials handle this (owner step).
6. **Dev-client launch URLs and RecoveryGate.** Dev-client cold starts can pass an `exp+towson-inventory://expo-development-client/?url=…` initial URL. `parseRecoveryFromUrl` should return `'none'` for it. The developer confirms on the Simulator; this only affects `development` builds.
7. **Intl (AC-9).** Hermes `formatToParts` with `timeZone` on iOS is expected to work, but it is unverified here. A failure is a stop-and-ask, per the spec.
8. **ATS.** Relying on the template's `NSAllowsLocalNetworking` means a future Expo template change could alter it. §5.10 step 2 catches that at verification time.
9. **Migration ordering, RLS gaps, the 286 KB seed, edge cold-start:** not applicable. No DB, RLS, query-shape or edge changes.
10. **Owner gating.** AC-1 to AC-9 can't run until owner prerequisites 1, 3 and 4 are done. All code, config and jest work (AC-10 to AC-23, AC-25) can land first. The Simulator half of AC-24 follows.

### §11. Expected files (developer fills `## Files changed`)
- **New:**
  - `src/lib/uuid.ts`, `src/lib/uuid.test.ts`
  - `src/lib/authAutoRefresh.ts`, `src/lib/authAutoRefresh.test.ts`
  - `src/lib/countDraftLocal.test.ts`
  - `src/lib/nativeAppConfig.spec181.test.ts`
  - `src/utils/downloadCSV.native.spec181.test.ts`
  - `src/store/useStore.receivePo.clientUuid.spec181.test.ts`
  - `src/screens/cmd/sections/__tests__/InventoryCountSection.clientUuid.spec181.test.tsx`
  - `assets/splash-icon.png`
  - `specs/181-native-internal-build/reviews/main-verification.md`
- **Modified:**
  - `App.tsx`, `app.json`, `eas.json`, `package.json`, `package-lock.json`
  - `scripts/gen_logo.py`, `assets/icon.png`, `assets/adaptive-icon.png`
  - `src/screens/staff/lib/uuid.ts`
  - `src/screens/cmd/sections/InventoryCountSection.tsx`, `src/screens/cmd/sections/EODCountSection.tsx`
  - `src/store/useStore.ts`, `src/lib/countDraftLocal.ts`, `src/lib/recoveryRedirect.ts`, `src/lib/recoveryRedirect.test.ts`, `src/lib/auth.ts`, `src/lib/db.ts` (comment only)
  - `src/utils/index.ts`, `src/utils/countExport.test.ts`
  - `src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx`, `src/screens/cmd/sections/__tests__/InventoryCountSection.layouts.test.tsx`
- **Deleted:** `assets/splash.png`.
- **Must NOT change:** anything under `public/`, `assets/favicon.png`, `supabase/**`, `app.json` slug and ids.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec (frontend/config only, with no migrations, RPCs or edge functions). Start with §5.11 step 1 (the isolated `expo install --fix` plus the two new installs, then a full test run). Apply §0's AC interpretations, and record AC-13's Simulator sub-step as N/A unless the PM/owner decides otherwise. Keep App.tsx hunks to those listed in §10.2 and rebase over spec 180's changes. AC-1 to AC-9 need the owner's Xcode/EAS prerequisites, so land the code/config/jest work first and leave the Simulator rows of main-verification.md pending. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/181-native-internal-build.md

## Files changed

Implemented by frontend-developer, 2026-10-26. There are no migrations, RPCs or edge functions, and nothing under `supabase/**`, `public/` or `assets/favicon.png` changed.

**New**
- `src/lib/uuid.ts`: shared Hermes-safe `uuidv4()` (§5.1).
- `src/lib/uuid.test.ts`
- `src/lib/authAutoRefresh.ts`: `installAuthAutoRefresh()` (§5.3, B3).
- `src/lib/authAutoRefresh.test.ts`
- `src/lib/countDraftLocal.test.ts`: AC-13 jest.
- `src/lib/nativeAppConfig.spec181.test.ts`: §5.10 config pin (AC-16/18/19/20/22).
- `src/utils/downloadCSV.native.spec181.test.ts`: AC-17 native branch.
- `src/store/useStore.receivePo.clientUuid.spec181.test.ts`: AC-11.
- `src/screens/cmd/sections/__tests__/InventoryCountSection.clientUuid.spec181.test.tsx`: AC-10.
- `assets/splash-icon.png`: generated by `gen_logo.py --target native`.
- `specs/181-native-internal-build/reviews/main-verification.md`: AC-24. The Simulator rows AC-1 to AC-9 are PENDING; the AC-13 Simulator sub-step is N/A.

**Modified**
- `App.tsx`: only the §10.2 hunks, plus two imports:
  - handler keys → `shouldShowBanner` / `shouldShowList`;
  - module-scope `SplashScreen.preventAutoHideAsync()` (native);
  - `useEffect(() => installAuthAutoRefresh(), [])` between the restore effect and the spec-152 block;
  - notification effect native branch → `if (Platform.OS !== 'web') return;`;
  - splash-hide effect before `if (!fontsLoaded) return null;`;
  - `registerForPushNotifications` deleted.
- `app.json`:
  - `scheme: "imr"`, `ios.supportsTablet: false`;
  - `NSCameraUsageDescription` removed;
  - `android.permissions` → `RECEIVE_BOOT_COMPLETED`, `VIBRATE`, plus `android.blockedPermissions` (3 entries);
  - `adaptiveIcon.backgroundColor` `#1A1A18`;
  - top-level `splash` removed, `expo-splash-screen` plugin added.
  - slug, bundle/package id, projectId and owner are untouched.
- `eas.json`: new `simulator` profile; `environment` set on every build profile.
- `package.json`:
  - the `expo install --fix` bumps;
  - `expo-dev-client ~6.0.21`, `expo-splash-screen ~31.0.13`;
  - no script changes.
- `package-lock.json`:
  - the bumps and the two installs;
  - **expo's deps hoisted to the root** (see the main-verification note: npm nested `babel-preset-expo` / `expo-asset` / `@expo/cli` / `@expo/metro-config` / `expo-constants` under `expo/`, which broke every jest suite).
- `scripts/gen_logo.py`: `transparent_bg` parameter, `--target {all,native,web}` (default `all`), new native recipes, docstring table.
- `assets/icon.png` (opaque RGB, full-bleed) and `assets/adaptive-icon.png` (transparent foreground, 66% safe zone).
- `src/screens/staff/lib/uuid.ts`: now a re-export of `src/lib/uuid.ts`, and the comment is corrected.
- `src/screens/cmd/sections/InventoryCountSection.tsx`:
  - B1 `uuidv4()`;
  - B2 `loadLocalCountDraft` in both restore effects (`if (cancelled) return;` added; the reconnect read moved inside the IIFE);
  - C1 CSV callback `async` + `await downloadCSV`.
- `src/screens/cmd/sections/EODCountSection.tsx`: CSV callback `async` + `await downloadCSV`.
- `src/store/useStore.ts`: two hunks only, at working-tree line numbers that include other sessions' staged edits:
  - **L46-47**: the `import { uuidv4 } from '../lib/uuid';` line plus a one-line comment;
  - **L4376-4378**: the `receivePurchaseOrder` mint becomes `uuidv4()`. This replaces the 4-line `rcv-` ternary at the old L4374-4377.
  - Per the dispatcher's "only that minimal hunk" instruction, the stale doc comment at L770 ("via crypto.randomUUID()") was **not** touched. Follow-up.
- `src/lib/countDraftLocal.ts`: new `loadLocalCountDraft`; `readLocalCountDraft` doc and header comment updated.
- `src/lib/recoveryRedirect.ts`:
  - `resolveRecoveryRedirectUrl(): string | null`;
  - native returns the env value or `null`;
  - `expo-linking` import removed;
  - `RECOVERY_URL_UNSET_ERROR` added.
- `src/lib/recoveryRedirect.test.ts`: the native `createURL` case is replaced by native env-set and env-unset cases, plus two native `sendPasswordReset` cases.
- `src/lib/auth.ts`: `sendPasswordReset` resolves the URL first; `null` → `{ error: RECOVERY_URL_UNSET_ERROR }` and nothing is sent.
- `src/lib/db.ts`: comment only (L1396).
- `src/utils/index.ts`: `downloadCSV(...): Promise<void>`. The web body is verbatim; the native branch is `shareCsvNative` (`expo-file-system` + `expo-sharing`).
- `src/utils/countExport.test.ts`: the BOM case gains a `Platform.OS = 'web'` pin and restore (§0.3); its assertions are unchanged.
- `src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx` and `InventoryCountSection.layouts.test.tsx`: the mocks gain `loadLocalCountDraft`.

**Deleted**
- `assets/splash.png`

**Review fixes (release-proposal items 1-6, 2026-10-26; owner-approved, including the `RecoveryGate.tsx` scope extension and the `.gitignore` patterns)**
- New `src/screens/RecoveryGate.spec181.test.tsx`: M1 pin. Native (ios and android): Linking is never read and `children` render. The web recovery branch is unchanged.
- New `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.csvExport.spec181.test.tsx`: AC-17 call site. Success toast only after `downloadCSV` resolves; `Export failed` toast on rejection.
- `src/navigation/RecoveryGate.tsx`: the native `Linking` effect is removed (M1), along with the `expo-linking` / `parseRecoveryFromUrl` imports. The header and the `useState` comment are updated. The web branch is byte-unchanged.
- `app.json`: `android.allowBackup: false` (M2).
- `src/lib/nativeAppConfig.spec181.test.ts`: new pins for `allowBackup`, the absence of `NSAllowsArbitraryLoads`, and the `installAuthAutoRefresh()` mount in `App.tsx`.
- `src/utils/downloadCSV.native.spec181.test.ts`: the "DOM untouched" assertion now uses a `createElement` stub and a `createObjectURL` spy; the BOM is written as the `﻿` escape.
- `src/lib/countDraftLocal.ts`: private `parseLocalCountDraft()`, shared by `readLocalCountDraft` and `loadLocalCountDraft`. No behaviour change.
- `.gitignore`: `credentials.json`, `credentials/`, `*service-account*.json`, `google-services-key*.json` (L4).
- `specs/181-native-internal-build/reviews/main-verification.md`: main Claude's verification, the `npm dedupe` heal recipe, Risk §10.6 marked settled, and a "Fixes applied" note.
