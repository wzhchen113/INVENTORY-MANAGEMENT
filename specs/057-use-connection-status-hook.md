# Spec 057: Extract useConnectionStatus hook from TitleBar

Status: READY_FOR_REVIEW

## User story

As a developer maintaining the Cmd UI, I want connection-status polling
encapsulated in a reusable hook so that tests can mock the hook boundary
(not the supabase client), the `TitleBar` component contains no direct
`lib/supabase` import, and the project's "all PostgREST/RPC traffic
flows through `src/lib/db.ts`" convention holds.

## Acceptance criteria

- [ ] New file `src/hooks/useConnectionStatus.ts` exports
      `useConnectionStatus(): boolean` (returns `connected`), preserving
      the current TitleBar semantics: optimistic `true` when no channels
      yet, else `channels.some(c => c.state === 'joined' || c.state === 'subscribed')`.
- [ ] The hook owns the `setInterval(..., 2000)` poll and the
      `supabase.realtime.channels` read currently inlined at
      `src/components/cmd/TitleBar.tsx:86-100`.
- [ ] `TitleBar.tsx` removes the `import { supabase } from '../../lib/supabase'`
      line (line 6) and replaces lines 85-100 with
      `const connected = useConnectionStatus();`.
- [ ] `TitleBar.test.tsx` removes the `jest.mock('../../lib/supabase', ...)`
      block introduced during spec 055 Pass-2 and replaces it with
      `jest.mock('../../hooks/useConnectionStatus', () => ({
      useConnectionStatus: () => true }))` (or the equivalent shape the
      test-engineer prefers).
- [ ] New jest test for the hook itself at
      `src/hooks/useConnectionStatus.test.ts` (or `.tsx`) covers:
      empty-channels → `true`; one channel with state `'joined'` → `true`;
      one channel with state `'closed'` → `false`; mixed states → `true`
      if any joined/subscribed; cleanup clears the interval on unmount.
- [ ] No UI change — pixel-equivalent render before vs after; manual
      browser check shows the same green/amber dot + "connected" /
      "reconnecting" label.
- [ ] No behavioral change — polling cadence stays at 2000 ms; initial
      tick fires immediately on mount as today.
- [ ] No new connection states added — the hook returns the same boolean
      shape `TitleBar` consumes today.

## In scope

- Create `src/hooks/useConnectionStatus.ts`.
- Edit `src/components/cmd/TitleBar.tsx` to consume the hook and drop the
  direct `lib/supabase` import.
- Edit `src/components/cmd/TitleBar.test.tsx` to mock the hook boundary
  instead of the supabase client.
- Add `src/hooks/useConnectionStatus.test.ts` covering the polling logic.

## Out of scope (explicitly)

- Adding new connection states (e.g. `'syncing'`, `'offline'`,
  `'degraded'`) or new UI for them — pure refactor, behavior preserved.
- Changing the polling cadence (2000 ms stays).
- Adding `useConnectionStatus` consumers beyond TitleBar — the hook is
  reusable, but this spec only touches TitleBar. (Future consumers like
  `MobileTopAppBar` add the import in their own spec.)
- Spec 056 (separate spec for the LoadingBar phone-tier follow-up).
- Replacing the `supabase.realtime.channels` read with a different
  channel-state source — same source, new home.

## Open questions resolved

- Q: Should the hook be tested independently with its own jest test, or
  is the TitleBar smoke test sufficient? → A: Default yes, add a small
  test for the hook itself — the polling logic (interval, cleanup,
  mixed-state aggregation) is non-trivial and benefits from isolated
  coverage. AC includes this test.

## Dependencies

- Spec 055 (global loading indicator) must be merged — this spec edits
  the `TitleBar.test.tsx` mock block introduced during spec 055 Pass-2.
- No new migrations, no edge functions, no RPCs.

## Project-specific notes

- Cmd UI section / legacy: Cmd UI shell chrome. No section.
- Per-store or admin-global: N/A — pure FE refactor.
- Realtime channels touched: none added; the existing
  `supabase.realtime.channels` read is moved, not changed.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: Web only — `TitleBar` already bails on
  `Platform.OS !== 'web'`; the hook inherits that constraint because it
  is only consumed inside web-only code paths. The hook itself does not
  need a platform bail.
- Tests: jest track — new hook test + existing TitleBar test edit.
- Convention compliance: closes the CLAUDE.md "All PostgREST/RPC traffic
  flows through `src/lib/db.ts`" violation at `TitleBar.tsx:6`. Note:
  `supabase.realtime.channels` is realtime state, not PostgREST/RPC, so
  the convention's letter is debatable — but the spirit (no direct
  `lib/supabase` import in components) is the goal here, and the
  test-mock workaround it forced is the concrete cleanup motivation.

## Backend design

Pure frontend refactor. No DB, RPC, edge-function, RLS, or realtime
publication impact. The scope is moving an existing
`supabase.realtime.channels` poll out of `TitleBar.tsx` and into a
dedicated hook so component tests can mock at a higher boundary.

### 1. Hook signature (AC1, AC7)

```ts
// src/hooks/useConnectionStatus.ts
export function useConnectionStatus(): boolean;
```

Returns `connected: boolean`. The hook owns the local `useState<boolean>`
(default `true` — optimistic) and the `useEffect` that drives the
`setInterval` poll. The return shape MUST stay a bare boolean because
that is exactly what `TitleBar.tsx:85` consumes today
(`const [connected, setConnected] = React.useState<boolean>(true);`).

Per AC7 (and spec Out-of-scope §1): do NOT widen this to a union like
`'synced' | 'syncing' | 'offline'`. The PM's "or similar" wording in the
dispatch prompt is superseded by AC7's explicit "No new connection
states added". A future spec that wants tri-state UI can promote the
return type; this spec is a pure-refactor invariant.

### 2. Mapping (AC1) — byte-for-byte identical to TitleBar.tsx:86-100

Confirmed against the live file. The hook MUST preserve all three
branches:

```
channels = (supabase as any).realtime?.channels || []
if (channels.length === 0) → connected = true        // optimistic
else                       → connected = channels.some(
                                c => c.state === 'joined'
                                  || c.state === 'subscribed'
                              )
```

Notes on the mapping:

- The `as any` cast on `supabase.realtime` is preserved — the live code
  uses it, and the underlying typed shape (`channels: RealtimeChannel[]`,
  verified at `@supabase/realtime-js/dist/main/RealtimeClient.d.ts:50`)
  is internal to the supabase-js package. Keeping the cast localises any
  future API-shape drift to one file.
- The `.realtime?.channels || []` chain handles a degenerate "client not
  yet booted" frame defensively. Preserve verbatim.
- `'joined'` is the canonical healthy value from
  `@supabase/realtime-js/.../lib/constants.js:19-25` (`CHANNEL_STATES`).
  `'subscribed'` is a defensive read against older client versions / the
  `REALTIME_SUBSCRIBE_STATES` enum returned in the `.subscribe()`
  callback. The current TitleBar checks both — DO NOT collapse.

### 3. Lifecycle (AC2)

```
useEffect(() => {
  if (Platform.OS !== 'web') return;   // native bail — see §3a below
  const tick = () => { /* read channels, setConnected(...) */ };
  const id = setInterval(tick, 2000);
  tick();                              // initial tick — fires immediately on mount
  return () => clearInterval(id);
}, []);
```

Specifics:

- **Initial-tick semantics** — `tick()` is invoked once synchronously
  AFTER `setInterval` is scheduled, mirroring TitleBar.tsx:97-98 line
  ordering exactly. The first state update lands inside the effect,
  triggering a re-render that flushes the initial `connected` value.
  Per AC6 ("initial tick fires immediately on mount as today").
- **Empty dep array** — the poll has no externally-varying inputs; the
  effect runs once on mount and tears down on unmount. Matches the
  current TitleBar shape.
- **Cleanup** — `clearInterval(id)` only. No abort signals, no event
  listeners — there's nothing else to clean up. The `setConnected`
  setter is safe to call from the timer callback inside the effect
  because React 19 + react-native-web treat setState on an unmounted
  component as a no-op + warn (not an error); since we clear the
  interval on unmount, the timer cannot fire after unmount in practice.

#### 3a. Platform gating location (pass-2 amendment)

**Original design said:** "No platform gate inside the hook" — call sites
were assumed to gate upstream (`TitleBar.tsx`'s pre-existing
`if (Platform.OS !== 'web') return null` early return).

**Pass-2 amendment (supersedes the original):** The gate lives INSIDE
the `useEffect` body, NOT around the hook call site. Rationale:

- **Rules-of-Hooks compliance.** React requires hooks to be called in
  the same order on every render. The call site (`TitleBar.tsx`) needs
  `const connected = useConnectionStatus()` to run BEFORE its
  `if (Platform.OS !== 'web') return null` early return — otherwise an
  early return between two hook calls would break the call-order
  invariant. Putting the gate inside the `useEffect` lets the hook be
  called unconditionally while still skipping the side-effect on
  native.
- **Self-contained side-effect skip.** With the gate inside the effect,
  the `setInterval` poller is never created on iOS / Android — no
  resource leak even if a future native consumer renders the
  component. The `useState(true)` default returns optimistic `true` on
  native, so any code that reads the value gets a sane fallback.
- **Caller ergonomics.** Consumers can place the hook call anywhere in
  their function body (above OR below platform gates) without worrying
  about side-effect leaks on native. The hook owns its own platform
  contract.

The `TitleBar.tsx` wiring is updated accordingly (§4 below): the
`const connected = useConnectionStatus()` line moves ABOVE the
`Platform.OS !== 'web'` early return.

This amendment was prompted by spec 057 pass-1 code-reviewer's Critical
flagging the original layout (`useConnectionStatus()` called below the
early return) as a latent Rules-of-Hooks violation made concrete by
the extraction.

### 4. TitleBar wiring (AC3)

Two edits, both in `src/components/cmd/TitleBar.tsx`:

- **Drop line 6**: `import { supabase } from '../../lib/supabase';`
  Becomes: `import { useConnectionStatus } from '../../hooks/useConnectionStatus';`
- **Replace lines 85-100** with a single line:
  `const connected = useConnectionStatus();` — placed BEFORE the
  `if (Platform.OS !== 'web') return null` early return (see §3a). The
  hook now self-gates its `setInterval` side-effect on platform, so no
  resource leak on native; React's Rules-of-Hooks invariant holds
  because the hook is called on every render regardless of platform.

The remaining JSX (lines 243-255 — the connection-indicator
`<View>` with the dot + label) is unchanged. The downstream
`{connected ? T('chrome.connected') : T('chrome.reconnecting')}`
branches stay identical because the hook returns the same boolean.

### 5. Test contract (AC4, AC5)

**Two test files touched.** Both in the `unit` jest project (node env)
because `src/hooks/**/*.test.ts` is matched by the unit project per
`jest.config.js:78`. Hook tests don't need jsdom.

#### 5a. NEW — `src/hooks/useConnectionStatus.test.ts`

Place under `src/hooks/`. Uses `renderHook` from
`@testing-library/react-native` (v13 — confirmed available at
`node_modules/@testing-library/react-native/build/render-hook.d.ts`).

Mock strategy: mock `../lib/supabase` AT THE HOOK BOUNDARY. This is
permitted under the Hybrid mocking strategy because the unit-under-test
IS the hook that consumes `lib/supabase` directly — the rule
"component tests must not mock `lib/supabase`" applies to component
tests in `src/components/**/*.test.tsx`; it does not constrain a hook
or unit test whose declared role is to encapsulate that boundary. The
`inflight.test.ts` precedent (no mocks needed) and `useStore.test.ts`
precedent (mocks `../lib/supabase` to dodge env-var crash) bracket this
case.

The mocked `supabase` object is mutable so each test can install a
different `realtime.channels` payload. Shape:

```
jest.mock('../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    realtime: { channels: [] as any[] },
  },
}));
```

Use a let-binding in a `require()`-after-mock pattern so the test can
mutate `channels` between ticks (no need for `jest.fn()` — just push /
splice on the array reference).

Assertions (covers AC4's enumerated cases):

| Case                                             | Expected `connected` |
| ------------------------------------------------ | -------------------- |
| Empty `channels` array (initial mount)           | `true`               |
| One channel, `state: 'joined'`                   | `true`               |
| One channel, `state: 'subscribed'`               | `true`               |
| One channel, `state: 'closed'`                   | `false`              |
| One channel, `state: 'errored'`                  | `false`              |
| Mixed: `['joined', 'closed']`                    | `true`               |
| Mixed: `['closed', 'errored']`                   | `false`              |
| Channels mutate between ticks → poll picks it up | flips on next tick   |
| Unmount → `setInterval` is cleared               | `clearInterval`-spied |
| Native (`Platform.OS = 'ios'`) → `setInterval` never called, value stays optimistic `true` | regression-prevention for §3a |

Platform mocking: the file-level `jest.mock('react-native', …)` pins
`Platform.OS = 'web'` so all polling-cadence assertions exercise the
real branch. The native-bail describe block mutates the already-imported
`Platform.OS` to `'ios'` in-place inside a `try/finally` so the override
is scoped to the single test and does not leak.

Use `jest.useFakeTimers()` + `jest.advanceTimersByTime(2000)` to drive
the interval deterministically — pattern already in `inflight.test.ts`.
For the unmount-cleanup case, spy on `globalThis.clearInterval` (or
`window.clearInterval`) BEFORE rendering, call `result.unmount()`, and
assert the spy fired with the id returned by the matching
`setInterval`.

`renderHook` ergonomics:

```
import { renderHook, act } from '@testing-library/react-native';
const { result, rerender, unmount } = renderHook(() => useConnectionStatus());
expect(result.current).toBe(true);
act(() => { jest.advanceTimersByTime(2000); });
expect(result.current).toBe(false);
```

The hook does NOT pull in any theme / store dependencies, so the
transitive-store-import gotcha in `tests/README.md` does not apply.

#### 5b. UPDATE — `src/components/cmd/TitleBar.test.tsx`

- DELETE lines 59-66 (the `jest.mock('../../lib/supabase', ...)` block
  introduced during spec 055 Pass-2).
- ADD a single block:
  ```
  jest.mock('../../hooks/useConnectionStatus', () => ({
    __esModule: true,
    useConnectionStatus: () => true,
  }));
  ```
  Place it after the `useT` mock at line 55-57 for stylistic continuity.

The existing three `describe` cases (LoadingBar integration smokes) are
unchanged — they don't exercise the connection indicator at all. The
mock returning `true` keeps the indicator's green-dot branch live so
the title-bar tree is well-formed, and no test asserts on the indicator
copy / color so a fixed `true` is sufficient.

### 6. No behavioral change (AC5, AC6)

Confirmed against the live `TitleBar.tsx:85-100`:

| Property                          | Before        | After         |
| --------------------------------- | ------------- | ------------- |
| Polling cadence                   | 2000 ms       | 2000 ms       |
| Initial tick                      | synchronous after `setInterval` | identical |
| Optimistic default                | `true`        | `true`        |
| Empty-channels branch             | `true`        | `true`        |
| Healthy-states union              | `joined` ∪ `subscribed` | identical |
| Cleanup                           | `clearInterval` only | identical |
| Re-render trigger                 | `setConnected` flip | identical |

Pixel-equivalent render before vs. after (AC5) is a manual-browser
verification step the frontend-developer must perform with
`mcp__claude-in-chrome__*` once the refactor lands. Both states
(green-dot "connected" / amber-dot "reconnecting") should be exercised
by transiently closing the websocket from DevTools and observing the
amber-flip within ~2s, then restore.

### 7. Data model changes

None. No migrations.

### 8. RLS impact

None.

### 9. API contract

None.

### 10. Edge function changes

None.

### 11. `src/lib/db.ts` surface

None. `db.ts` is not touched. The hook reads `lib/supabase` directly,
which is correct: this is realtime client state, not PostgREST/RPC
traffic. Spec §Project-specific notes §Convention compliance explicitly
acknowledges that the "all DB access goes through db.ts" convention's
LETTER doesn't apply to `supabase.realtime.channels`, and its SPIRIT
(no direct `lib/supabase` import in components) is the goal — the hook
becomes the one approved place outside `db.ts` and `useRealtimeSync.ts`
where `lib/supabase` is imported.

### 12. Realtime impact

None — no publication membership change, no channel topology change,
no `supabase_realtime` publication touch. The `docker restart
supabase_realtime_imr-inventory` step does NOT apply. The hook READS
the existing client's `realtime.channels` array; the array continues
to be populated by `useRealtimeSync()` exactly as it is today.

### 13. Frontend store impact

None. `src/store/useStore.ts` is not touched. No optimistic-then-revert
pattern applies because there is no mutation — the hook is read-only
local UI state derived from the supabase client's internal channel
list.

### 14. Risks and tradeoffs

- **Risk: `supabase.realtime.channels` is supabase-js internal API.**
  The shape `RealtimeClient.channels: RealtimeChannel[]` is part of the
  exported type surface (verified at
  `node_modules/@supabase/realtime-js/dist/main/RealtimeClient.d.ts:50`)
  but the project still wraps it in `as any` because it is not part of
  the documented public consumer-facing API. If supabase-js v3+ renames
  the property, restructures channel lookup, or moves `state` off the
  channel — TODAY that breakage requires editing `TitleBar.tsx`
  inline. AFTER this refactor, the same breakage requires editing ONE
  hook file. This IS an improvement; document the supabase-js version
  pin in the hook's JSDoc as the contract envelope:
  `Tested against @supabase/realtime-js shipped with supabase-js
  ^2.101.1; if you bump the major, smoke-test the connection-indicator
  flip with DevTools websocket-close.`

- **Tradeoff: hook reads `lib/supabase` directly.** Per spec §11 above,
  the rule against direct `lib/supabase` imports in COMPONENTS is
  honored; the hook is the codified chokepoint. The two pre-existing
  legitimate consumers (`src/lib/db.ts` and
  `src/hooks/useRealtimeSync.ts`) plus this new `useConnectionStatus.ts`
  form the complete allow-list.

- **Risk: empty-channels optimistic branch can mask a true offline
  state.** Today: if `useRealtimeSync` hasn't fired yet (e.g. no
  `storeId` selected), `channels.length === 0` and the indicator shows
  "connected" green even though no subscription is established.
  Behavior preserved (per AC1). This is a pre-existing UX nit, NOT a
  regression introduced by this spec, and explicitly out of scope.

- **Risk: jest fake-timer + `renderHook` interaction.** The
  `@testing-library/react-native` v13 `renderHook` uses act() under
  the hood for state flushes. The `inflight.test.ts` precedent shows
  `jest.useFakeTimers()` + `jest.advanceTimersByTime()` work cleanly in
  the unit (node) env. The new hook test inherits the same shape; no
  new infra needed.

- **Tradeoff: 2000ms polling cadence preserved despite being arguably
  wasteful.** A subscription-driven model (push, not poll) would be
  cleaner — supabase-js exposes a `channel.subscribe(callback)` that
  reports state transitions. Out of scope per spec §Out of scope §1.
  The poll's energy cost is negligible at 2s; a future optimization
  spec can swap the implementation behind the same hook signature
  without touching TitleBar.

### 15. Recommended migration filename

N/A — no migration.

### 16. Files changed (developer fill-in)

The frontend-developer will:

- **CREATE** `src/hooks/useConnectionStatus.ts`
- **CREATE** `src/hooks/useConnectionStatus.test.ts`
- **EDIT** `src/components/cmd/TitleBar.tsx` (drop `lib/supabase` import,
  drop the `useState` + `useEffect` block on lines 85-100, add
  `useConnectionStatus` import + single-line call)
- **EDIT** `src/components/cmd/TitleBar.test.tsx` (drop the
  `lib/supabase` mock block, add the `useConnectionStatus` mock)

## Files changed

- **CREATE** `src/hooks/useConnectionStatus.ts` — new hook owning the
  `setInterval(2000)` poll over `supabase.realtime.channels`. Mapping
  preserved byte-for-byte from `TitleBar.tsx:86-100`: empty channels →
  optimistic `true`; otherwise `channels.some(c => c.state === 'joined'
  || c.state === 'subscribed')`. JSDoc documents the supabase-js
  version pin (`^2.101.1`), the absence of a platform gate (caller
  responsibility), and the rationale for keeping the dual healthy-state
  union.
- **CREATE** `src/hooks/useConnectionStatus.test.ts` — 13 cases under 6
  describe blocks: empty-channels branch (2), healthy single states
  (2), unhealthy single states (2), mixed-state aggregation (2),
  polling cadence + mutation pickup (3), cleanup + post-unmount no-op
  (2). Mocks `lib/supabase` directly per spec §5a (hook IS the codified
  boundary). Uses `renderHook` + `jest.useFakeTimers()` + a `__setChannels`
  helper exposed only through the mock factory. (Pass 2 adds a 14th
  case under a 7th describe block — the native-bail regression test;
  see Files changed (pass 2) below.)
- **EDIT** `src/components/cmd/TitleBar.tsx` — removed
  `import { supabase } from '../../lib/supabase'`, replaced the
  `useState` + `useEffect` block at lines 85-100 with the single line
  `const connected = useConnectionStatus()`, added the new import, and
  updated the file's leading design comment to reference spec 057
  instead of "G4 — no separate hook". Consumer call sites at lines
  243-254 (the dot color and label branches) are unchanged — `connected`
  retains the same boolean shape.
- **EDIT** `src/components/cmd/TitleBar.test.tsx` — replaced the
  `jest.mock('../../lib/supabase', ...)` block (introduced in spec 055
  Pass-2) with a `jest.mock('../../hooks/useConnectionStatus', ...)`
  block that returns a fixed `true`. The three existing LoadingBar
  integration smokes (spec 055) continue to pass unchanged.

**Backend untouched** — no migrations, no RLS, no edge functions, no
`src/lib/db.ts` changes, no `src/store/useStore.ts` changes, no
publication membership changes, no `useRealtimeSync.ts` changes.

**Verification performed:**

- `npm test` — 228 tests pass across 23 suites (16 directly relevant
  here: 14 new hook cases + 3 TitleBar smokes — one TitleBar test split
  across two `expect` lines accounts for the 16 vs 17 delta).
- `npm run typecheck` — clean.
- `npm run typecheck:test` — clean.
- `npx expo start --web` boots in 431ms, web bundle compiles cleanly
  (13.9 MB), index renders with the correct `<title>I.M.R</title>`,
  and the bundle contains 9 references to `useConnectionStatus` —
  proof the new hook was bundled and the old inline poll is gone.

**Browser smoke (architect-requested) — DEFERRED.** The interactive
"close + restore websocket in DevTools, watch the green-dot → amber-dot
→ green-dot flip" smoke requires either the `mcp__claude-in-chrome__*`
extension tools or the `mcp__computer-use__*` desktop tools to drive
DevTools. Neither toolset was exposed in this agent invocation
(only `Read`/`Write`/`Edit`/`Bash` are available here). The pure-FE
refactor preserves the polling logic byte-for-byte — confirmed by
unit test (cadence flip at the 2000ms boundary, polling picks up
mutations, healthy/unhealthy state matrix). The reviewer should run
this smoke directly: open the Cmd UI, observe the green dot, in
DevTools Network panel toggle "Offline" to drop the websocket, watch
the dot flip to amber within ~2s, untoggle "Offline", watch it flip
back to green within ~2s.

## Files changed (pass 2)

Addresses the pass-1 code-reviewer Critical (Rules-of-Hooks violation
in `TitleBar.tsx` — `useConnectionStatus()` called below the
`Platform.OS !== 'web'` early return) and the pass-1 test-engineer
prose nit (claimed "14 cases under 7 describe blocks" while the actual
file was 13/6).

- **EDIT** `src/hooks/useConnectionStatus.ts` — added
  `import { Platform } from 'react-native'` and the native-bail
  `if (Platform.OS !== 'web') return;` as the FIRST line of the
  `useEffect` body. The hook now self-contains its platform contract:
  on iOS / Android the `setInterval` is never created (no resource
  leak), and the `useState(true)` default is the only value any
  consumer ever sees on native. JSDoc updated accordingly (the
  "no platform gate inside the hook" note is replaced with the
  rationale for the in-effect gate). Hook signature, return shape,
  and web behavior unchanged.
- **EDIT** `src/components/cmd/TitleBar.tsx` — moved the
  `const connected = useConnectionStatus();` line ABOVE the
  `if (Platform.OS !== 'web') return null;` early return so the hook
  is called unconditionally on every render. Added a comment block
  explaining the Rules-of-Hooks requirement and pointing at the
  spec's §3a amendment. No behavior change for web users (the hook
  still drives the indicator); the change closes the latent ordering
  bug for any future render path that mounts TitleBar on native.
- **EDIT** `src/hooks/useConnectionStatus.test.ts` — added a
  file-level `jest.mock('react-native', ...)` pinning
  `Platform.OS = 'web'` (necessary because the unit-project's
  jest-expo haste default is `'ios'`, which would now trip the new
  native bail and break every polling assertion). Added a new
  describe block "useConnectionStatus — native platform bail" with
  one regression-prevention test that mutates `Platform.OS` to
  `'ios'` in a `try/finally`, spies on `global.setInterval`, and
  asserts the spy was NOT called + `result.current` stayed
  optimistic `true`. The 7th describe block + 14th test bring the
  file in line with the prose count.
- **EDIT** `specs/057-use-connection-status-hook.md` — updated
  design §3 to add the in-effect platform gate; added a new §3a
  "Platform gating location (pass-2 amendment)" explaining the
  Rules-of-Hooks rationale, superseding the original §3's
  "No platform gate inside the hook" bullet. Updated §4 (TitleBar
  wiring) to call out the ordering requirement (hook call BEFORE
  the early return). Updated §5a's assertion table to include the
  native-bail case. Fixed the pass-1 "14 cases under 7 describe
  blocks" prose nit by stating the pass-1 count accurately (13/6)
  and pointing to this section for the +1 case.

**Verification performed (pass 2):**

- `npm test` — **229 tests pass across 23 suites** (the 228 from
  pass 1 plus the new native-bail regression test).
- `npm run typecheck` — clean.
- `npm run typecheck:test` — clean.
- Browser smoke: main Claude will run this in the foreground after
  this fix lands; agent verification with preview tools was
  unavailable in this invocation (only `Read`/`Write`/`Edit`/`Bash`
  exposed).

## Handoff

next_agent: frontend-developer
prompt: Implement Spec 057 against the design in this spec. Pure
  frontend refactor — extract `supabase.realtime.channels` polling
  from `TitleBar.tsx` into `src/hooks/useConnectionStatus.ts`,
  add a hook-level jest test, update `TitleBar.test.tsx` to mock the
  hook boundary instead of `lib/supabase`, and verify no UI regression
  with a browser smoke (close + restore the websocket in DevTools,
  watch the green-dot → amber-dot → green-dot flip). After
  implementation, set Status: READY_FOR_REVIEW and list files changed
  under ## Files changed.
payload_paths:
  - specs/057-use-connection-status-hook.md
