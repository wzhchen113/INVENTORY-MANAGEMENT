## Code review for spec 181

Scope: the spec-181 hunks only (frontend/config). I could not run `git diff` (read-only tools), so I read the final state of each file in `## Files changed` and the new untracked files. In `src/store/useStore.ts` I read only the import at L46-47 and the `receivePurchaseOrder` mint at L4376-4378. I did not review `src/screens/s...` changes outside this spec. I did not re-run jest or `npm ci`; main Claude owns that.

### Critical
None.

- The hard-policy checks all pass:
  - `app.json` `slug`, bundle id, package, `projectId` and `owner` are unchanged (pinned by `nativeAppConfig.spec181.test.ts:97`).
  - No direct `supabase.from/rpc` was added outside `db.ts`. `authAutoRefresh.ts` and `recoveryRedirect.ts` are auth-client plumbing on the `sessionWatch`/`recoveryRedirect` carve-out footing.
  - No legacy files were touched and no json-server patterns appear.
  - No inline colour literals were added to components. The `#1A1A18` in `app.json` is the documented JSON limitation, and a jest pin ties it to `gen_logo.py` `BG`.
  - Web-only APIs in the touched code are behind `Platform.OS`. Every new native branch is gated.
  - `downloadCSV` on web is the verbatim body. It deliberately stays non-`async` so a synchronous throw still throws synchronously.
  - The B2 `cancelled` guards are correct: a cancelled first pass never consumes `restoredSlotRef`, so the restore-once guard still holds.

### Verdict on the hand-edited `package-lock.json`

Keep the lock edit for this spec. Do not add explicit dependencies now. Reasons and caveats:

- **Why the lock edit is the right call here.** A lockfile is a derived artifact, but npm accepts any valid tree, and the layout written is the layout the previous lock already had: root `expo-constants` unified to 18.0.14 (satisfies `~18.0.14` from `expo` and `expo-asset`).
  - I confirmed `node_modules/expo/node_modules/*` no longer exists in the lock.
  - `expo` (L5653), `babel-preset-expo` 54.0.12 (L4081, satisfies `~54.0.12`), `expo-asset` 12.0.14 (L5714) and `expo-constants` 18.0.14 (L5729) are all at the root with ranges matching expo's declared deps.
  - The acceptance bar the developer used (`npm ci`, then `npm ls --all` clean, then `npm install` leaving the lock byte-identical) is the right test of "this is a tree npm considers canonical". If main Claude's `npm ci` reproducibility check passes, I see no reason to churn it.
- **Why not explicit deps.** The failures were phantom dependencies relying on hoisting: `babel.config.js` resolves `babel-preset-expo` from the root, and `expo-font` imports `expo-asset`. Making them explicit would mean declaring at least `babel-preset-expo`, `expo-asset` and `expo-constants` in `package.json`.
  - That widens `package.json` beyond the design (§5.11: only version bumps plus the two installs).
  - It permanently pins four hoist-sensitive packages alongside Expo's own SDK bundle, which will drift from `expo`'s `~` ranges on the next SDK bump.
  - The Expo ecosystem generally assumes a flat `node_modules`, so declaring a few of them does not remove the underlying assumption.
- **Residual fragility, and what I would do.**
  - The nesting is a resolver outcome, not something the lock enforces. Any future event that re-resolves the `expo` subtree (an `expo install --fix` or SDK bump, deleting the lock, or a new package touching `expo-constants` ranges) can re-nest. The developer says a fresh `--package-lock-only` resolution also nests, so regeneration from scratch is not safe.
  - The failure is loud, not silent: all 267 suites failed, and `npm ci` in CI hits the same wall. So the safety net already exists. If it recurs, that is the moment to switch to explicit deps (`babel-preset-expo` first), not before.
  - One cheap check to add to the verification note: whether `npm dedupe --dry-run` reports no changes. `npm dedupe` is the supported way to produce exactly this hoisted layout, so "dedupe is a no-op on this lock" is stronger evidence than "install is a no-op", and it gives the next developer a one-command heal.
  - Record the recipe ("after an expo bump, if jest dies with `Cannot find module 'babel-preset-expo'`, run `npm dedupe`") in the verification note. It is currently only described as a one-time rewrite.

### Should-fix
- `src/lib/countDraftLocal.ts:75-77` and `:107-112` — the parse-then-validate sequence (`JSON.parse` then `isLocalCountDraft`, with `null` on any failure) is duplicated between `readLocalCountDraft` and `loadLocalCountDraft`. Extract a private `parseLocalCountDraft(raw: string | null): LocalCountDraft | null` and call it from both. A future change to the validity rule would otherwise have to be made in two places, and the native and web restore paths could diverge silently. Same-file refactor, no behaviour change.

### Nits
- `src/store/useStore.ts:770` — the doc comment still says the action "mints the `client_uuid` internally via crypto.randomUUID()". This is now wrong twice: the section mints the key (via `uuidv4()`), and `randomUUID` is the exact Hermes assumption this spec removes. The design (§5.1) listed the fix. It was left out only because of the dispatcher's "minimal hunk" instruction for this shared file. Fold it into the next touch of `useStore.ts`. The dev already noted this as a follow-up.
- `src/lib/countDraftLocal.ts:10-15` — the header edit left a long line (L14) after the re-wrap, and the paragraph now mixes the original "WEB-PRIMARY" prose with the spec-181 sentence. Re-wrap the paragraph.
- `src/utils/downloadCSV.native.spec181.test.ts:58-85` — the "DOM path is never touched on native" assertion compares `document.createElement` to its own earlier value, which would pass even if the function called it. Use `jest.spyOn(document, 'createElement')` and `expect(...).not.toHaveBeenCalled()`, or drop the assertion.
- `src/utils/downloadCSV.native.spec181.test.ts:72` and `src/utils/countExport.test.ts:264` — the expected strings contain a literal invisible U+FEFF. A reviewer cannot see the byte being pinned. Write `'﻿a,b\n1,2'`. (The `countExport.test.ts` line is pre-existing; only change it if you are touching the file anyway.)
- `src/lib/nativeAppConfig.spec181.test.ts` — AC-26 (no ATS weakening) is verified manually only. A one-line pin such as `expect(JSON.stringify(app)).not.toContain('NSAllowsArbitraryLoads')` would keep a future `infoPlist` edit from weakening ATS for `preview`/`production` without CI noticing.
- `App.tsx:158` and `:448-450` — if fonts fail to load, `fontsLoaded` stays false and the splash now stays up indefinitely instead of a blank screen. The design (§10.4) accepts this as no worse than today. If cheap, also hide the splash on `fontError` so a font failure is at least visible. Not required.
- `src/components/cmd/ExportCsvDrawer.tsx:77` and `src/screens/cmd/sections/RecipesSection.tsx:226` — these call `downloadCSV` as a floating promise now that the return type is `Promise<void>`. This is desktop-tier only and the spec explicitly leaves them unchanged. If they are ever reached on native, a share failure would be an unhandled rejection. (out-of-scope; flag for the later C2/C6 spec.)
- `src/lib/authAutoRefresh.ts:32-35` — the `typeof auth.startAutoRefresh !== 'function'` guard exists purely to tolerate test doubles. That is the design's choice and the comment says so, but it is production code bending to tests. If the shared supabase mock used by other suites ever gains these methods, the guard can go.
- `package.json:34` — `@react-native-community/netinfo` is pinned exactly at `11.4.1`, a downgrade from 11.5.2. This is the SDK-54 pinned version, as the verification note says. No action needed beyond the already recorded note.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 1 Should-fix, 9 Nit.
payload_paths:
  - specs/181-native-internal-build/reviews/code-reviewer.md
