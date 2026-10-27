## Security audit for spec 181

Scope: only the unstaged spec-181 hunks and the untracked spec-181 files (App.tsx, app.json, eas.json, package.json, package-lock.json, src/lib/uuid.ts, src/lib/authAutoRefresh.ts, src/lib/recoveryRedirect.ts, src/lib/auth.ts, src/lib/countDraftLocal.ts, src/utils/index.ts, src/store/useStore.ts L46-47 and L4376-4378, src/screens/cmd/sections/InventoryCountSection.tsx, src/screens/cmd/sections/EODCountSection.tsx, src/screens/staff/lib/uuid.ts, src/lib/db.ts comment, and the new tests). Other sessions' staged work (specs 176/177/179/180, migrations) is out of scope.

No migrations, RLS, RPCs or edge functions changed. The edge-function, RLS, last-of-role and self-guard checks don't apply. `supabase/config.toml` is unchanged.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium

- **M1. The native build turns on the inbound recovery deep-link handler. A crafted link can swap the signed-in session for an attacker-controlled account.** Locations: `app.json:5`, `src/navigation/RecoveryGate.tsx:73-96`, `src/lib/recoveryUrl.ts:75-157`, `src/screens/RecoveryScreen.tsx:60-85`.
  - **What's wrong.** RecoveryGate's native effect handles `Linking.getInitialURL()` and warm `url` events. Its header (`RecoveryGate.tsx:20`) calls this "inert on native without the scheme". That is no longer true:
    - this spec adds `scheme: "imr"`;
    - Expo prebuild also always registers the iOS bundle id as a URL scheme (`node_modules/@expo/config-plugins/build/ios/Scheme.js:35-37`), so `com.towson.inventory://` works too;
    - `parseRecoveryFromUrl` never checks the host or path. Any `imr://<anything>?token_hash=X&type=recovery` is treated as a recovery link.
  - **How it's exploited.** RecoveryScreen calls `verifyOtp` automatically on mount, with no user action. That overwrites the stored AsyncStorage session (the real user is signed out) with the link's recovery session.
    - The form state has no exit. `signOut()` runs only on the success path (`RecoveryScreen.tsx:120-127`).
    - So a victim who kills the app and relaunches comes back signed in as the link's account.
    - The bar is low. Any account in the shared Supabase project can mint a valid recovery `token_hash` for itself through the anon `resetPasswordForEmail`. Customer-PWA users qualify, per the threat model.
    - Delivery is any link the victim taps: SMS, a web page redirecting to `imr://`, or a QR code.
  - **Impact.** Login-CSRF / session swap. The admin or staff user is silently logged out of their own account. Work done afterwards (counts, receives) is attributed to the attacker's account or fails confusingly. This is not a privilege escalation, because the attacker only gets a session for an account they already control.
  - **Why Medium, and why fix it here.** The same class already exists on web: a link to `/reset-password?token_hash=…` does the same thing. That is pre-existing and can be a follow-up. But spec 181's own C3 decision sends native recovery emails to the **web** URL, so the native handler has no product purpose. The spec's Out-of-scope section also defers deep-link routing. This spec should not ship a live inbound auth surface that nothing uses.
  - **Fix (minimal).** In `RecoveryGate.tsx`, make the native effect a no-op (`if (Platform.OS !== 'web') return;` with the web branch unchanged) until a deep-link spec designs it. Update the header comment.
  - **Hardening for that later spec, or for web now:**
    - require the path to be `reset-password`;
    - require an explicit user tap before `verifyOtp`;
    - `signOut()` on every exit from RecoveryScreen.

- **M2. Android Auto Backup is on by default, so the persisted Supabase session (including the refresh token) is included in device and cloud backups.** Locations: `app.json:18-33`, `src/lib/supabase.ts:11-16`, `node_modules/@expo/config-plugins/build/android/AllowBackup.js:26`.
  - **What's wrong.** On native, `supabase.ts` persists the session to AsyncStorage. The same storage holds the staff EOD queue and count drafts. Expo writes `android:allowBackup="true"` unless `android.allowBackup` is set, and `app.json` doesn't set it.
  - **Impact.** Google Auto Backup and device-to-device transfer copy the AsyncStorage database. Restoring onto another device then carries a valid refresh token, so the session moves to hardware the store never issued.
    - On iOS, AsyncStorage files live in Application Support, which is included in iCloud and Finder backups. Those backups are encrypted, but the data is not Keychain-protected.
    - Before this spec, no native binary existed, so this surface is new.
  - **Fix.** Add `"allowBackup": false` to the `android` block of `app.json` and pin it in `src/lib/nativeAppConfig.spec181.test.ts`.
  - **Follow-up spec (not required here).** Move the auth session to an `expo-secure-store`-backed storage adapter (Keychain / Keystore). This needs value chunking, because SecureStore has a ~2 KB limit.

### Low

- **L1. The UUID `Math.random` fallback is fine as an idempotency key: no realistic collision or replay risk.** Locations: `src/lib/uuid.ts:53-58`, `src/screens/cmd/sections/InventoryCountSection.tsx:1153`, `src/store/useStore.ts:4378`.
  - **Generator quality.** I checked the Hermes source at the commit RN 0.81.5 bundles (`node_modules/react-native/sdks/.hermesversion` → `e0fc671…`). `Math.random` is `std::mt19937_64`, seeded once per runtime with 64 bits from `std::random_device` (`hermes lib/VM/JSLib/Math.cpp:210-231`).
    - It is not a CSPRNG, but each runtime gets 64 bits of real seed entropy and the period is huge.
    - A cross-fleet collision needs two runtimes to land on the same seed and stream position. That is negligible at this scale.
    - Replay or pre-squatting would require predicting another device's PRNG output, which an attacker can't observe.
  - **Server-side dedup scoping, checked for what a collision would do:**
    - `inventory_counts`: dedup is `(store_id, client_uuid)` (`20260513000000_inventory_counts.sql:102`). A collision is confined to one store.
    - `purchase_orders.receive_client_uuid`: the unique index is global, but the dedup lookup filters on `p_po_id` (`20260707000000_staff_receiving_price_gate.sql:165-168`). A cross-PO collision raises `23505` (a visible error that a retry clears with a new key), not a replay.
    - `eod_submissions.client_uuid` (pre-existing, reached by the same helper): the dedup is global (`20260504000000_staff_api_idempotency.sql:26`). `staff_submit_eod` returns `conflict: true` with another store's `submission_id` on any match (`20261024000000_eod_entries_no_need.sql:169-179`). The client then dequeues and shows "already submitted" (`src/screens/staff/hooks/useEodSubmit.ts:163-173, 284-288`). A collision would therefore silently drop an EOD count. That is unreachable in practice at 64-bit seeding, but a store-scoped dedup (matching the `inventory_counts` H1 fix) is a cheap follow-up spec.
  - **Rule going forward.** `uuidv4()` must never be used for secrets, nonces or tokens. The header says the value is "not a secret"; consider stating that rule explicitly. If a CSPRNG is ever needed, `expo-crypto` is a one-file change, as the design notes.

- **L2. ATS: production builds keep `NSAllowsLocalNetworking: true`.** Location: the prebuild Info.plist, recorded in `main-verification.md`.
  - AC-26 holds: `NSAllowsArbitraryLoads` is false and the prod Supabase URL is https.
  - The note's `expo config --type introspect` output showed `NSAllowsArbitraryLoads: true`. The developer attributes that to introspect's fallback template, and the prebuild output contradicts it, which is the right ground truth.
  - The owner should still run `plutil -p` on the Info.plist inside the first production `.ipa` to confirm.
  - Keep `http://127.0.0.1:54321` confined to the EAS `development` environment. Never set an `http://` Supabase URL in `preview` or `production`.

- **L3. The template-declared Android `SYSTEM_ALERT_WINDOW` permission ships in release builds.** Location: `main-verification.md` (prebuild AndroidManifest observation). The dev menu overlay only needs it in debug. Consider adding `android.permission.SYSTEM_ALERT_WINDOW` to `android.blockedPermissions` (`app.json:28`) before Play submission. `RECEIVE_BOOT_COMPLETED` and `VIBRATE` stay per the spec, even though native push is deferred.

- **L4. `.gitignore` doesn't cover EAS local credentials or a Play service-account key.**
  - `*.p8`, `*.p12`, `*.jks`, `*.key` and `*.mobileprovision` are already ignored.
  - `credentials.json` (EAS `credentialsSource: local`) and a Google Play service-account JSON (`eas submit` `serviceAccountKeyPath`) are not.
  - Owner step 6 (TestFlight / Play uploads) is when these files tend to show up in the repo root. Add `credentials.json` and a service-account pattern before then. This is a hygiene item; this spec writes neither file.

- **L5. `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN` will be baked into distributed binaries.**
  - The exposure is the same as the web bundle, and it is public by design per spec 095. AC-23 is satisfied: values come from EAS env vars, and nothing is in `app.json` / `eas.json` (both checked; no secrets, no keys).
  - New consequence: without OTA updates (expo-updates is out of scope), rotating `USERNAME_RESOLVE_SERVICE_TOKEN` breaks username login on installed native builds until users update. Note this in the rotation runbook.
  - Confirm the EAS dashboard values never include a service-role key.

- **L6. Dev-client builds can load arbitrary JS bundles.** Location: `eas.json` `development` profile. `expo-dev-launcher` is compiled only into `developmentClient: true` (Debug) builds. `preview`, `production` and `simulator` are Release builds without it. Never hand a `development` build to staff devices.

- **L7. CSV exports stay in the app cache after sharing.** Location: `src/utils/index.ts:157-173`.
  - Inventory counts are written to `Paths.cache` and not deleted after `shareAsync`. The cache is app-private and the OS can evict it.
  - Path traversal is handled: `/` and `\` are replaced, and `countExportFilename` always appends an extension, so a bare `..` can't occur.
  - Optional: delete the file after the share resolves.

### Verified OK (focus areas)

- **Auth auto-refresh** (`src/lib/authAutoRefresh.ts`, `App.tsx:351`):
  - Native only; no listener on web; removed on unmount; nothing called at install time.
  - Errors are swallowed and no token, session or PII is logged.
  - auth-js removes the session only on a non-retryable refresh error (`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:3892-3893`). Offline foregrounding therefore doesn't sign out staff with a queued EOD.
  - A revoked or expired refresh token produces `SIGNED_OUT`, which spec-152 `sessionWatch` already handles honestly.
  - Native auth-js starts its own ticker on init (`GoTrueClient.js:4195-4198`), so the cold start is covered.
  - The listener never signs out, so the intentional-sign-out flag is untouched.
  - It is not coupled into `watchSessionLoss()`.
- **Password-recovery redirect** (`src/lib/recoveryRedirect.ts:50-58`, `src/lib/auth.ts:759-760`): no open redirect.
  - `redirectTo` is either a build-time constant (`EXPO_PUBLIC_WEB_RECOVERY_URL`) or, on web, `window.location.origin`, and GoTrue still enforces the allow-list.
  - If the variable is unset on native, the request is refused before any network call, so a reset link is never sent to a bad or Site-URL target.
  - Native no longer mints `imr://` recovery links. That is the safer choice: a custom scheme can be claimed by another app on the device, and recovery tokens now never travel over one.
  - The email argument and caller are unchanged.
- **Notifications** (`App.tsx` hunks): the boot-time `requestPermissionsAsync` is removed. The handler keys are cosmetic. The web branch is byte-unchanged.
- **Config:**
  - Android `permissions` / `blockedPermissions` are as specified, and the removed three appear only as `tools:node="remove"`.
  - `NSCameraUsageDescription` is removed.
  - Slug, bundle/package id, projectId and owner are unchanged.
  - `.env.local` is gitignored, and there is no `.easignore`, so EAS archives respect `.gitignore`.
  - `.env.example` contains placeholders only.
  - Scanning the spec-181 files for JWTs, `service_role` keys, Resend keys and `sk_live` found nothing.
- **Local draft read** (`src/lib/countDraftLocal.ts`): the key is namespaced by user id and store id, malformed values resolve `null`, and it never rejects.
- **Client role boundary:** no new code uses `useRole()` as a security boundary.

### Dependencies

- **Hand-edited `package-lock.json`:**
  - Every `resolved` URL in the diff (151) points at `https://registry.npmjs.org`.
  - No entry is missing `integrity`.
  - No name@version changed integrity relative to HEAD.
  - All **142** new or changed name@version entries match the registry's `dist.integrity` (`npm view`). The rewrite introduced no tampered or substituted package.
  - New package names: `expo-dev-client`, `expo-dev-launcher`, `expo-dev-menu`, `expo-dev-menu-interface`, `expo-json-utils`, `expo-manifests`, `expo-updates-interface`, `expo-splash-screen`, `ajv` / `fast-uri` / `json-schema-traverse` (via `expo-dev-launcher`), and `agent-cli-detector` (via `@expo/cli`; published by the Expo org from `github.com/expo/agent-cli-detector`).
- **`npm audit --omit=dev`, HEAD lock vs. spec lock:** 33 → **23** findings (critical 2 → 1, high 16 → 11).
  - **Added: none.**
  - Removed: `tar` (critical), `undici`, `@xmldom/xmldom`, `browserslist`, `compression`, `source-map-js` (high), and 4 moderates.
  - The full `npm audit --audit-level=high` shows the same delta (34 → 24).
- **Remaining findings are all pre-existing and not introduced by this spec:**
  - `shell-quote` (critical, transitive dev/CLI tooling, `npm audit fix` available);
  - `ws`, `postcss` (via `@expo/metro-config`), `node-forge` / `@expo/code-signing-certificates`, `nanoid`, `image-size`, `js-yaml`, `brace-expansion`, `dompurify` (high).
  - Most are build-time tooling. `dompurify` (via `jspdf`) is the one that can reach the runtime web bundle.
  - Recommend a separate `npm audit fix` hygiene spec that triages `dompurify` first. This does not block spec 181.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 2 Medium, 7 Low.
payload_paths:
  - specs/181-native-internal-build/reviews/security-auditor.md
