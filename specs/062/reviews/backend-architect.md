# Spec 062 — post-implementation drift review (backend-architect)

**Mode:** Post-implementation review (frontend architecture, no backend touched).
**Scope:** Verify landed code matches the design contract appended to
`~/Documents/GitHub/imr-staff/specs/062-staff-app-eod-screen.md`.
**Reviewer perspective:** I authored the §0–§12 design. Findings are framed as
matches / justified deviations / contract breaks.

---

## Particular drift points (the 5 Q resolutions)

### Q1 — Queue state: Zustand mirror + AsyncStorage write-through

**✅ matches design.**

- `src/store/useStore.ts` writes through to AsyncStorage on every queue mutation
  via `persistQueue(updated)` inside `enqueueEod`, `dequeueEod`, `bumpEodAttempts`,
  and `replaceQueue` (lines 84–125). Errors caught and routed to
  `notifyBackendError` per design.
- `src/lib/eodQueue.ts` is the AsyncStorage layer with all the helpers I
  specified: `hydrateQueue`, `persistQueue`, `pushQueueItem`, `peekQueue`,
  `drainQueue`, `clearQueue`, `readActiveStoreId`, `writeActiveStoreId`.
- `App.tsx:21-35` does the initial hydration on mount via `migrateQueueIfNeeded()`
  → `hydrateQueue()` → `hydrateQueueFromStorage(items)`. Cancellation flag
  prevents setState-after-unmount.

One nuance the FE-dev added that I did not specify but is correct: the store
exposes `replaceQueue` in addition to the three mutators I named. It's used by
the drain orchestrator for batch writes and is consistent with the design's
intent (write-through on every mutation).

### Q2 — `useConnectionStatus`: single-file Platform.OS branch in useEffect

**✅ matches design.**

`src/hooks/useConnectionStatus.ts` has:
- Lazy initializer `readInitial()` honoring web `navigator.onLine` and native
  optimistic-true (lines 32–41).
- `useEffect` body opens with `if (Platform.OS === 'web')` — platform fork
  inside the effect per the spec 058 rule I cited (line 52).
- Web branch: `window.addEventListener('online' / 'offline')` + cleanup
  unsubscribes (lines 53–61).
- Native branch: lazy `require('@react-native-community/netinfo').default` with
  try/catch graceful degradation, `state.isConnected === true &&
  state.isInternetReachable !== false` (lines 67–85).
- Cleanup returns `() => { if (unsub) unsub(); }` (lines 86–88).

The try/catch around the NetInfo require is a slight expansion of my design (I
just said "lazy-require") but it's a defensive improvement — if NetInfo is ever
unavailable, the hook degrades to optimistic-true rather than crashing.
**Justified addition.**

### Q3 — Error boundary: whole-stack with queue-preserving fallback

**✅ matches design.**

- `App.tsx:39-41` wraps `<RootStack />` in `<ErrorBoundary>`.
- `src/components/ErrorBoundary.tsx` is a class component implementing
  `getDerivedStateFromError` + `componentDidCatch` with a log-only fallback
  (`console.warn`) and a minimal `<View accessibilityRole="alert">` with
  `t('chrome.errorBoundary.title' / '.message')`.
- The fallback intentionally does NOT touch the queue — the queue is in
  AsyncStorage and survives any render error. The invariant I called out
  ("queue is the source of truth even if a screen crashes") holds.

### Q4 — AsyncStorage key migration: corrupt-payload backup

**✅ matches design.**

`src/lib/eodQueue.ts:50-91` (`hydrateQueue`) implements every clause:
1. `null` → `[]`.
2. `JSON.parse` failure → `backupCorrupt(raw, 'parse-error')` → return `[]`.
3. Not an array → `backupCorrupt(raw, 'not-an-array')` → return `[]`.
4. Per-item shape validation via `isValidQueuedSubmission` — malformed items
   filtered out, valid ones kept, warning logged.
5. 30d GC purges items older than `now - GC_MAX_AGE_MS` and persists the
   GC'd state.

Backup key shape: `${QUEUE_KEY}-corrupted:${new Date().toISOString()}` →
matches my spec's `:v1-corrupted:<ts>` shape (lines 210-216).

The future v1→v2 migration contract is documented in a comment block at the
bottom of the file (lines 225-242) — exactly as I asked.

### Q5 — Test mocking boundary

**✅ matches design.**

- Screen tests mock the hook boundary:
  - `EODCount.test.tsx:11-18` mocks `useEodSubmit`.
  - `EODCount.test.tsx:40-45` mocks `supabase.from()` and `supabase.auth.signOut`
    at the lib boundary (the screen needs supabase for data fetches that are NOT
    in `useEodSubmit`'s domain — vendors / items / existing submission — which
    is correct per design §4 note that the hook only owns submit + drain).
  - `SignIn.test.tsx:12-20` mocks `supabase.auth` + `supabase.from` at the lib
    boundary.
- Hook tests mock the lower layers:
  - `useEodSubmit.test.ts:11-22` mocks `useConnectionStatus` + `supabase.rpc`.
  - `useConnectionStatus.test.ts:15-28` mocks `@react-native-community/netinfo`
    and reassigns `global.window` for the web branch.
- The manual mock at `src/__mocks__/useEodSubmit.ts` exists and matches the
  shape I specified (`submit: jest.fn(), pending: 0, draining: false`).

---

## Additional architect calls

### Date captured at SUBMIT time, not MOUNT time

**✅ matches design (§11 risk c).**

`src/screens/EODCount.tsx:308` — `const dateIso = todayIso();` is read INSIDE
`onSubmit` (after the `if (entries.length === 0)` early return), NOT at module
top-level or in a useMemo. The mount-time `todayLabel` (line 202) only drives
the banner display, which I explicitly accepted as stale-by-one-day risk in
the spec.

### `intent_user_id` documented as soft boundary; queue items tagged + drain skips other users

**✅ matches design (§3).**

- `useEodSubmit.ts:254` — `intent_user_id: me` set at enqueue time (where `me`
  is `currentUserId(authState)` at submit press).
- `useEodSubmit.ts:131-134` — drain loop skips items whose `intent_user_id !== me`.
- `useStore.ts:130-133` — `pendingCountForUser` filters by `intent_user_id` so
  the UI only shows the current user's items.
- The soft-boundary nature is documented in code comments and the spec's
  §11 risk (d).

### 30-day GC for orphaned queue items

**✅ matches design.**

`src/lib/eodQueue.ts:26` — `GC_MAX_AGE_MS = 30 * 24 * 3600 * 1000`. Applied in
`hydrateQueue` (lines 75-89). Items with unparseable `queued_at` are kept (not
silently purged) and surface as needs-attention later — this is a safer choice
than my spec implied. **Justified deviation, captures a defensive edge.**

### Drain debounce of 400ms

**✅ matches design (§11 risk h).**

`src/hooks/useEodSubmit.ts:41` — `const DRAIN_TOAST_DEBOUNCE_MS = 400;`. Used
in lines 195-203 to schedule the "All counts synced" toast inside
`setTimeout(400)` cleared on overlapping drain cycles. Implementation matches
the imr-inventory `useRealtimeSync.ts:400ms` precedent I cited.

### `react-native-toast-message` added to deps

**✅ matches design (§11 risk f).**

`package.json:28` — `"react-native-toast-message": "^2.2.0"`. Toast root mounted
in `App.tsx:42` (`<Toast />`).

### `.claude/launch.json` at port 8083

**✅ matches design (§10).**

`/Users/will/Documents/GitHub/imr-staff/.claude/launch.json` has port 8083 +
runtime args `["expo", "start", "--web", "--port", "8083"]`. The `name` field is
`expo-web` instead of my suggested `expo-web-staff` — minor cosmetic deviation,
not load-bearing.

---

## Spec compliance checks (revisited from design)

### §1 File structure

**✅ matches design.**

Every file I named in §1 exists at the expected path:
- `src/lib/{supabase,eodQueue,types,uuid,notifyBackendError,confirmAction}.ts` ✓
- `src/hooks/{useConnectionStatus,useEodSubmit}.ts` ✓
- `src/store/useStore.ts` ✓
- `src/screens/{SignIn,StorePicker,EODCount}.tsx` ✓
- `src/navigation/RootStack.tsx` ✓
- `src/components/{Button,Input,ListRow,Banner,ErrorBoundary,QueueIndicator}.tsx` ✓
- `src/i18n/{en.json,index.ts}` ✓
- `src/__mocks__/useEodSubmit.ts` ✓

One missing: I named `src/hooks/useI18n.ts` as a separate file; the FE-dev put
`useI18n` inline at the bottom of `src/i18n/index.ts:60-62`.
**Justified deviation** — it's a 3-line wrapper, a separate file would be
overkill, and the call-site contract (`const {t} = useI18n()`) is preserved.

One added: `src/theme.ts` exists for colors/spacing/typography/radius/touchTarget
tokens. Not in my §1 file structure but a reasonable extraction.
**Justified addition.**

### §2 Auth gate state machine

**✅ matches design.**

States in `src/lib/types.ts:55-61` match my spec exactly:
`idle | restoring | signing-in | gating | signed-out{toast?} | signed-in{userId,stores}`.

The cold-start sequence in `RootStack.tsx:98-142` follows §2 steps 1-6:
- `setAuthState({kind: 'restoring'})` on mount.
- `restoreSession()` calls `supabase.auth.getSession()` then `profiles.role` then
  `user_stores`.
- Role !== 'user' → signOut + `{kind: 'signed-out', toast: 'auth.error.notStaff'}`.
- 0 stores → signOut + `{kind: 'signed-out', toast: 'auth.error.noStores'}`.
- Active store restored from `imr-staff:active-store:v1` and validated against
  `result.stores`.

The post-sign-in gate in `SignIn.tsx:24-60` (`runGate`) duplicates the logic
that's in `RootStack.tsx`'s `restoreSession`. Acceptable — my design implied
this would happen ("repeat steps 4–6 above"). Both implementations are
shape-identical, but if either drifts in cycle-2 it should be extracted.
**⚠ deviation justified, with a follow-up flag** — see Risks section below.

### §3 Offline queue state machine

**✅ matches design.**

`useEodSubmit.ts` traces every transition I drew:
- `idle → submitting`: `submit()` called.
- `submitting → success`: lines 267-272 (HTTP 200, conflict=false).
- `submitting → success-replay`: lines 266-271 (HTTP 200, conflict=true).
- `submitting → forbidden`: lines 273-279 (`isForbidden(err)` check matches
  `code === '42501'` OR `status === 403` OR message contains '42501').
- `submitting → queued (network)`: lines 280-283 + 259-262.
- `submitting → failed (5xx)`: lines 284-288.

Drain transitions match too (lines 130-188):
- Success → `dequeueEod` (line 146).
- Replay → `dequeueEod` + quieter toast (line 146-156).
- Forbidden → `dequeueEod` + persistent error toast (lines 158-170).
- Network error → `bumpEodAttempts` + `break` (lines 171-178). Matches my "leave
  in queue, retry next flip" — though the implementation also stops the rest of
  the drain on the first network error to avoid hammering a likely-offline
  connection. **Justified deviation** that I should have specified.

FIFO ordering enforced at line 127-129: `[...queue].sort((a,b) =>
a.queued_at.localeCompare(b.queued_at))`. Defensive against in-memory order
drift — exactly as I said.

### §4 `useEodSubmit` contract

**✅ matches design.**

- Signature at line 94-98: `{ submit, pending, draining }` — exact match.
- `submit()` generates client_uuid via `uuidv4()` (line 235).
- Connectivity snapshot via `isOnline = useConnectionStatus()` (line 99).
- RPC mapping at line 81-92 — `p_client_uuid`, `p_store_id`, `p_date`,
  `p_submitted_by: null`, `p_status: 'submitted'`, `p_entries` mapped from
  `EodEntry` to `{ingredient_id, actual_remaining}` via `entriesForRpc`,
  `p_vendor_id`. Order of named params matches the RPC migration.
- Entry shape mapping at line 67-75 — UI uses `item_id`/`count`, RPC boundary
  remaps to `ingredient_id`/`actual_remaining`. Matches §4 "Note on entry shape".
- Network error detection (`isNetworkError`, lines 43-56) checks for
  `'network request failed'`, `'failed to fetch'`, `'aborted'`, `'timeout'`,
  `name === 'aborterror'`, `name === 'typeerror' && msg.includes('network')`.
  Belt-and-suspenders — matches the spec's "match by name/message substring".

### §6 Navigation shape

**✅ matches design.**

`RootStack.tsx:144-177` renders a conditional stack:
- `idle | restoring | signing-in | gating` → Splash screen-only stack.
- `signed-out` → SignIn-only stack.
- `signed-in + activeStore` → EODCount-only stack.
- `signed-in + no activeStore` → StorePicker-only stack.

This is the "swap the stack itself" pattern I specified — no nav-stack-pop on
sign-out.

One deviation: my spec said `EODCount`'s header has "Switch store" as a LEFT
button and "Sign out" as RIGHT. The implementation puts the store name (tap
to switch when applicable) as the left side and "Sign out" as right
(`EODCount.tsx:381-410`). **Justified deviation** — using the store name itself
as the "switch store" affordance matches Bucket 2's spec language ("Tapping the
store name in the header navigates back to the picker"). Functionally
equivalent.

### §7 i18n shape

**✅ matches design.**

- Hand-rolled `t(key, vars)` over a typed message catalog with dot-path lookup,
  `{var}` substitution, missing-key warn-once. Matches my §7 pseudocode.
- `useI18n()` returns `{ t }` (inline at the bottom of index.ts, not a separate
  file — see §1 note above).
- `_resetWarnCache()` test helper exists per my test plan.
- Catalog at `src/i18n/en.json` has all the keys I named (auth, store.picker,
  eod, chrome). The `i18n.test.ts:35-83` `requiredKeys` array exhaustively
  enumerates every key referenced in code, asserting they all resolve.

---

## FE-dev deviation flags (for my judgment)

### 1. devDeps added (babel-preset-expo, RNTL 13.3.3, react-test-renderer 19.1.0)

**⚠ deviation justified.**

My spec §11(f) explicitly said "react-native-toast-message" is the only new dep
called out, but the §Dependencies block claimed "NO new deps for v1." That was
my framing error — the dep list was the existing app's `package.json` baseline,
and the staff app had no jest scaffolding yet, so test infrastructure deps were
implicit.

Concretely:
- `@testing-library/react-native@13.3.3` — required to run the tests I wrote
  into the §8 test plan.
- `react-test-renderer@19.1.0` — peer of `@testing-library/react-native` at
  this version, must match React 19.1.
- `babel-preset-expo` — required by jest-expo preset for transform.

All three are devDependencies only. Bundle size unaffected.
**Acceptable. Not a contract break.**

### 2. `jest.setup.js` patches for RN 0.81 `mockComponent.js:42` crash

**⚠ deviation justified — should have surfaced back to me.**

I did not anticipate this. RN 0.81 ships function-component Text/View via the
new `component(...)` declaration, and the upstream
`node_modules/react-native/jest/mockComponent.js:42` dereferences
`RealComponent.prototype.constructor` which is undefined on function components.

The FE-dev's workaround at `jest.setup.js:68-143` replaces the affected RN
component mocks with light fragment wrappers. This is the correct
pragmatic fix — the alternative (waiting for RN to ship a fix) blocks the spec.

The flag I would have wanted: this is a brittle workaround that will break on
any RN upgrade. It should be tracked as a follow-up — a "remove jest.setup.js
RN-0.81 patches when RN ships the mockComponent fix" note in the spec's
post-impl notes.

**Acceptable in v1, but flag for follow-up.** See Risks section.

### 3. `chrome.signOut` restructured from string to `{label, confirmTitle, confirmMessage}`

**✅ deviation justified — matches imr-inventory's nested-object i18n shape.**

My spec §7 catalog draft had:
```
"signOut": "Sign out",
"signOut.confirm": "Sign out? Queued counts will sync next time you sign in."
```

Which is shape-ambiguous — dot in the JSON key would have collided with my
nested-lookup algorithm. The FE-dev restructured to:
```
"signOut": {
  "label": "Sign out",
  "confirmTitle": "Sign out?",
  "confirmMessage": "Queued counts will sync next time you sign in."
}
```

This:
1. Resolves the key-collision ambiguity my draft had.
2. Matches imr-inventory's `src/i18n/en.json` which uses nested objects
   throughout (verified — `sidebar.items.eodCount`, `sidebar.groups.operations`,
   etc.).
3. The `confirmAction` API needs both title and message anyway (`confirmAction(
   title, message, onConfirm, confirmLabel)` per `confirmAction.ts:8-13`).

**Justified deviation, improves the design.**

---

## Risks (new findings not in original §11)

### (j) Auth-gate logic duplicated between SignIn.tsx and RootStack.tsx

**Severity:** Should-fix in cycle-2 (not a v1 blocker).

The role+stores fetch logic exists in two places:
- `SignIn.tsx:24-60` (`runGate`)
- `RootStack.tsx:36-80` (`restoreSession`)

Both are shape-identical. The §2 design implied "every cold start re-runs steps
4-6" without specifying whether the logic is shared. If either path's gate
semantics change (e.g. a new role check, a different store validation), both
must be updated in lockstep.

**Mitigation:** Cycle-2 extract a shared `runAuthGate(userId)` helper.
**Not a v1 blocker** — both paths work and are tested independently.

### (k) jest.setup.js RN 0.81 patches are upgrade-fragile

**Severity:** Minor follow-up.

The RN component-mock patches at `jest.setup.js:68-143` are tied to RN 0.81's
internal layout. An RN minor-version bump may break the import paths
(`react-native/Libraries/Text/Text` etc.) or change the function-component
shape. Tests would fail loudly so the regression is detectable, but
remediation requires patch updates.

**Mitigation:** Track as a known-fragile area; flag any RN upgrade as
"verify jest patches" in the cycle-N release notes.

### (l) Connectivity drop mid-drain stops the loop entirely

**Severity:** Minor; documented behavior.

`useEodSubmit.ts:177-178` does `break` on the first network error. My design
said "leave the item in the queue, retry on the next connectivity flip" but
did not specify whether the drain CONTINUES to the next item or stops. The
FE-dev's choice to stop is defensible (no point hammering an offline
connection) and even more conservative than my spec — but it means a single
intermittent failure halts processing of later items until the next
connectivity flip.

This is acceptable per spec — the next flip triggers another drain, and FIFO
is preserved. Just worth noting that "stop on first network error" is now the
de facto contract.

### (m) Queue is enqueued AFTER role-gate fails on drain — minor edge case

**Severity:** Minor.

The drain loop at `useEodSubmit.ts:131-134` skips items whose `intent_user_id !==
me`. But if a user signs out and a different user signs in, the new user's
drain pass will SKIP the old user's items — those items stay in storage
forever (unless the 30d GC sweeps them, which it does).

This is the soft-boundary I documented in §11 risk (d). Acceptable.

### (n) `crypto.randomUUID` jest mock uses sequential counter

**Severity:** Minor — test-only.

`jest.setup.js:52-56` makes `crypto.randomUUID` deterministic for test
snapshots. The production path in `src/lib/uuid.ts:13-27` works correctly with
the real `crypto.randomUUID`. **No production impact.**

---

## Test coverage assessment

**Test count: 8 suites, 54 tests passing** (per the spec's verification
section). I reviewed each test file:

- `eodQueue.test.ts` — covers hydrate / push / drain / corrupt / GC / active
  store. Solid.
- `useStore.test.ts` — covers auth transitions + queue mutations + selectors.
  Solid.
- `useConnectionStatus.test.ts` — covers both web (navigator.onLine seed +
  event flip) and native (NetInfo seed + flip + `isInternetReachable` edge
  cases) branches. Solid.
- `useEodSubmit.test.ts` — covers all 4 RPC outcomes + offline-queue +
  reactive pending count. Missing: drain-trigger-on-connectivity-flip
  integration test (I would have wanted one explicit assertion that flipping
  `mockOnline = false → true` fires a drain). **Should-fix.**
- `SignIn.test.tsx` — covers bad creds / wrong role / no stores / happy path.
  Solid.
- `StorePicker.test.tsx` — covers render + select + count subtitle. Solid.
- `EODCount.test.tsx` — covers render + pre-fill banner + submit mapping + 4
  outcome UX + vendor switcher. Solid.
- `i18n.test.ts` — exhaustively enumerates all keys referenced in code. Solid.

**Missing test:** end-to-end drain flow (false → true connectivity flip fires
drain → items drained from queue). Not in my §8 test plan explicitly but it's
the highest-risk untested path. Add to cycle-2.

---

## Summary

| Category | Count |
|----------|-------|
| ✅ Matches design | 21 |
| ⚠ Deviation justified | 7 |
| ❌ Contract break | 0 |

**No contract breaks.** Every architect-prescribed invariant landed correctly:
- Queue is Zustand+AsyncStorage write-through.
- Connectivity is single-file Platform.OS branched in useEffect.
- ErrorBoundary is whole-stack with queue-preserving fallback.
- Corrupt-payload backup pattern lands at `:v1-corrupted:<ts>`.
- Tests mock at the hook boundary in screens, lower layers in hook tests.
- Date captured at submit time.
- intent_user_id soft boundary enforced at enqueue + drain + selector.
- 30d GC on hydrate.
- 400ms drain-toast debounce.
- react-native-toast-message added; mounted in App.tsx.
- .claude/launch.json at port 8083.

**Follow-up items** (not v1 blockers):
1. Extract `runAuthGate` to share between SignIn.tsx and RootStack.tsx.
2. Track jest.setup.js RN 0.81 patches as upgrade-fragile.
3. Add drain-trigger integration test (connectivity flip → drain fires).
4. Document the "drain stops on first network error" choice in §3.

**Verdict:** Architecturally clean. Approve for ship.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 contract breaks, 7 justified
  deviations, 21 matches. 4 minor follow-up items flagged for cycle-2.
payload_paths:
  - ~/Documents/GitHub/imr-staff/specs/062/reviews/backend-architect.md
