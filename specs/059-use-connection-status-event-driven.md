# Spec 059: useConnectionStatus event-driven refactor (poll → push)

Status: READY_FOR_REVIEW

## User story

As a developer maintaining the Cmd UI, I want `useConnectionStatus` to be
driven by realtime client events instead of a 2-second poll, so that the
connection indicator flips within ~250 ms of an actual disconnect or
reconnect (not up to ~2 s after the fact), the `setInterval` timer-leak
surface is eliminated, and no consumer or public-signature change is
required.

## Acceptance criteria

- [ ] Hook public signature unchanged — `useConnectionStatus(): boolean`
      remains the sole export of `src/hooks/useConnectionStatus.ts`.
- [ ] No `setInterval` (and no `setTimeout`-as-poll equivalent) appears
      anywhere in the hook body. Grepping `setInterval` against
      `src/hooks/useConnectionStatus.ts` returns zero matches.
- [ ] Indicator flips within ~250 ms of an actual socket-level state
      change. Measurement: jest test asserts the hook's return value
      updates inside the same React `act()` flush when a mocked
      socket-state event fires (no `jest.advanceTimersByTime` step
      required between event dispatch and the flip).
- [ ] Optimistic default preserved — `useConnectionStatus()` returns
      `true` on initial mount, BEFORE any socket / channel event has
      fired. Jest test exercises this with a fresh `renderHook` and
      no event dispatched.
- [ ] Native-bail guard preserved — the `if (Platform.OS !== 'web') return;`
      line stays as the first statement of the `useEffect` body. The
      regression test added in spec 058 (`Platform.OS = 'ios'` → no
      side-effect, value stays `true`) continues to pass without
      modification.
- [ ] Cleanup is complete — every event listener (socket and/or channel)
      that the hook subscribes to is unsubscribed in the `useEffect`
      cleanup function. A new jest test asserts that subscribing N
      listeners and then unmounting calls each corresponding
      unsubscribe handle exactly once.
- [ ] Existing TitleBar wiring is unchanged — `src/components/cmd/TitleBar.tsx`
      consumes the hook exactly as it does today
      (`const connected = useConnectionStatus();` above the native
      early return). No edits to `TitleBar.tsx` are required for this
      spec to land.
- [ ] Existing `TitleBar.test.tsx` mock at
      `jest.mock('../../hooks/useConnectionStatus', () => ({ useConnectionStatus: () => true }))`
      continues to work unchanged.
- [ ] `src/hooks/useConnectionStatus.test.ts` is updated to mock the
      event-emitter API instead of the polled `realtime.channels` array.
      Total test count stays at 14 (spec 058 final count) or grows; no
      cases are deleted. Cases that were polling-specific (e.g.
      "channels mutate between ticks → poll picks it up on next 2 s
      boundary") are rewritten to assert event-driven equivalents
      ("event fires → indicator flips synchronously inside act()").
- [ ] `npm test` passes. `npm run typecheck` passes. `npm run typecheck:test`
      passes.

## In scope

- Replace the `setInterval(tick, 2000)` body of
  `src/hooks/useConnectionStatus.ts` with a subscription to supabase-js
  v2's realtime client state-change events.
- Update `src/hooks/useConnectionStatus.test.ts` to mock the
  event-emitter API and drive the hook with dispatched events.
- Preserve every external contract of the hook: signature, default
  value, native bail, boolean return shape.

## Out of scope (explicitly)

- Changing the indicator's UI (text "connected" / "reconnecting", dot
  color). That lives in `src/components/cmd/TitleBar.tsx` and is not
  touched.
- Adding new connection states (e.g. `'syncing'`, `'degraded'`,
  `'offline'`). Spec 057 §Out-of-scope §1 explicitly excluded this and
  spec 059 inherits the exclusion — the return shape stays a bare
  boolean.
- Moving the hook out of `src/hooks/useConnectionStatus.ts`. Same path,
  same filename.
- Modifying `src/lib/db.ts`, `src/lib/inflight.ts`, `src/lib/supabase.ts`,
  `src/hooks/useRealtimeSync.ts`, or any screen / section. The hook
  remains the single approved chokepoint outside `db.ts` /
  `useRealtimeSync.ts` for direct `lib/supabase` imports (spec 057 §11).
- Bumping the `@supabase/supabase-js` / `@supabase/realtime-js` version.
  Refactor must work against the currently-pinned `^2.101.x` line.

## Open questions (for the architect)

These are technical decisions the architect should resolve during the
design pass — they are not blocking the PM spec, but they ARE blocking
implementation. The PM is deferring them deliberately because they
require reading the live `@supabase/realtime-js` shapes the architect is
better placed to verify.

- **Q1 — Exact event API on the socket.** What is the canonical event
  surface on `supabase.realtime.socket` (or its equivalent) in
  `@supabase/realtime-js` shipped with `supabase-js ^2.101.1`? Spec
  candidates: `socket.onOpen(cb)`, `socket.onClose(cb)`,
  `socket.onError(cb)` returning unsubscribe handles; or a generic
  `socket.on('open'|'close'|'error', cb)`. The architect must read
  `node_modules/@supabase/realtime-js/dist/main/RealtimeClient.d.ts`
  (and the underlying `phoenix` socket wrapper) and pin the exact API.
- **Q2 — Per-channel state changes.** Today's poll reads channel-level
  state (`channels.some(c => c.state === 'joined' || 'subscribed')`),
  not socket-level state. If a channel disconnects WHILE the socket
  stays open (e.g. RLS revoke mid-session, or a single subscription
  errors but the underlying transport is fine), socket-level events
  won't fire. Does the hook need to subscribe per-channel via
  `channel.on('system', ...)` (or equivalent) to preserve channel-level
  granularity, or is socket-level state sufficient for the indicator's
  UX? The architect must decide and document the tradeoff. Note: if
  channel-level granularity IS preserved, the hook needs to subscribe
  to channels as they're added — see Q3.
- **Q3 — Dynamic channel set.** `useRealtimeSync` creates channels
  after the hook mounts (`store-{id}`, `brand-{id}`). If the hook
  subscribes per-channel for Q2, it needs to discover channels as
  they're added. Options: (a) listen on `socket.onMessage` for join
  events and re-subscribe on each; (b) snapshot the channel list on
  every socket event and reconcile listeners; (c) listen only at the
  socket level and accept the granularity loss. Architect picks one.
- **Q4 — Initial-state seed.** The current implementation runs `tick()`
  once synchronously after `setInterval` is scheduled, so the first
  render reflects current channel state. The event-driven version has
  no "tick" — events only fire on transitions. The architect must
  decide whether to (a) read the current state once on mount as the
  seed value (mirrors today's initial tick) or (b) trust the optimistic
  `useState(true)` default until the first event arrives. The AC
  requires optimistic `true` on initial mount — (b) satisfies it
  trivially; (a) does too as long as the initial read is `true` when
  no channels exist. PM preference: (a) for behavioral parity with
  spec 057's design §6 table.
- **Q5 — Cleanup pattern.** Saving the unsubscribe handle and calling
  it in the `useEffect` return is the standard React pattern; this
  question is just confirming the supabase API returns handles
  (vs. requiring an explicit `.off()` call by name + reference). The
  architect's Q1 investigation will surface this.
- **Q6 — Latency assertion technique.** AC3 specifies ~250 ms flip
  latency. In a jest test, this is naturally satisfied because event
  handlers fire synchronously — there's no real-world timer in the
  loop. But for the browser smoke (close + restore websocket in
  DevTools), the architect should call out the expected wall-clock
  budget for the actual supabase-js event to fire after a real
  socket-close. If supabase-js's heartbeat / reconnect logic adds
  meaningful latency (e.g. 5 s heartbeat-interval before
  `socket.onClose` fires), the AC's "~250 ms" target may need a
  qualifier and the spec's "side benefit" framing in the user story
  may need a wall-clock asterisk.

## Dependencies

- Spec 057 (useConnectionStatus hook extraction) must be merged. This
  spec edits the file spec 057 created.
- Spec 058 (platform-mock alignment) must be merged. This spec
  preserves the native-bail regression test introduced there.
- No new migrations. No edge functions. No RPCs. No realtime
  publication membership changes.
- `@supabase/supabase-js ^2.101.1` (current pin). Architect must
  verify the event-emitter API surface against the actual installed
  version.

## Project-specific notes

- Cmd UI section / legacy: Cmd UI shell chrome (TitleBar consumer
  unchanged). No section touched.
- Per-store or admin-global: N/A — pure FE refactor of a hook.
- Realtime channels touched: none added; the hook continues to OBSERVE
  the existing client's realtime state. No new subscriptions to
  postgres-changes channels, no `supabase_realtime` publication
  membership changes, no `docker restart supabase_realtime_imr-inventory`
  required.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: web-only behavior preserved (native bail unchanged).
  The hook's web event subscription has no native impact because the
  `useEffect` returns early on `Platform.OS !== 'web'`.
- Tests: jest track only. No pgTAP, no shell smokes. Existing 14-case
  test file is rewritten in place; total case count must stay at 14 or
  grow.
- Convention compliance: same as spec 057 — direct `lib/supabase`
  import remains permitted in this hook as the codified chokepoint.
  No new `lib/supabase` imports anywhere else in the codebase.
- `app.json` slug: not touched.
- Risk surface change (poll → push): a future supabase-js major bump
  that renames the event API will break this hook at runtime. Spec 057
  §14 already documents the version-pin contract in the hook's JSDoc;
  this spec extends it — the JSDoc must be updated to name the event
  methods used and the supabase-js version they were verified against.

## Handoff (PM → architect)

next_agent: backend-architect
prompt: Design the contract for spec 059. The PM has surfaced six open
  questions (Q1-Q6 in the spec) about the supabase-js v2 realtime
  event-emitter API and the channel-vs-socket granularity tradeoff.
  Read `node_modules/@supabase/realtime-js/dist/main/RealtimeClient.d.ts`
  and the channel API, pin the exact event surface the hook will use,
  decide channel-level vs socket-level granularity, document the seed
  behavior on mount, and produce a design doc that the
  frontend-developer can implement against without further investigation.
  Preserve every AC verbatim — signature, default, native bail,
  cleanup, no `setInterval`. Set Status: READY_FOR_BUILD when done.
payload_paths:
  - specs/059-use-connection-status-event-driven.md
  - specs/057-use-connection-status-hook.md
  - specs/058-use-connection-status-platform-mock-alignment.md
  - src/hooks/useConnectionStatus.ts
  - src/hooks/useConnectionStatus.test.ts

## Backend design

Pure frontend refactor. No DB, RPC, edge-function, RLS, or realtime publication impact (confirmed in §6 below). The scope is replacing the `setInterval(2000)` body of `src/hooks/useConnectionStatus.ts` with event-driven subscriptions against `supabase.realtime`'s underlying Phoenix Socket. The hook signature, default, native bail, and TitleBar wiring are preserved verbatim.

This design resolves all six open questions (Q1-Q6) by reading the live installed `@supabase/realtime-js@2.101.1` shapes — paths and line numbers cited inline.

### 0. Investigation summary (cite-the-source for every claim below)

The supabase-js `^2.101.1` pin in [package.json:35](../package.json) ships realtime-js `2.101.1` (confirmed at [node_modules/@supabase/realtime-js/package.json:3](../node_modules/@supabase/realtime-js/package.json)). The relevant API surface, traced bottom-up:

- **Phoenix `Socket`** ([node_modules/@supabase/phoenix/assets/js/phoenix/socket.js:284-324](../node_modules/@supabase/phoenix/assets/js/phoenix/socket.js)) exposes `onOpen(cb): string`, `onClose(cb): string`, `onError(cb): string`, `onMessage(cb): string`. Each method appends `[ref, callback]` to `stateChangeCallbacks.{open,close,error,message}` and **returns the ref string**. The matching `off(refs: string[])` method ([socket.js:609-615](../node_modules/@supabase/phoenix/assets/js/phoenix/socket.js)) removes registrations by ref.
- **`SocketAdapter`** ([node_modules/@supabase/realtime-js/dist/main/phoenix/socketAdapter.js:75-86](../node_modules/@supabase/realtime-js/dist/main/phoenix/socketAdapter.js)) wraps the Phoenix Socket BUT **drops the return value**: its `onOpen(cb): void` / `onClose(cb): void` / `onError(cb): void` call through to the underlying Phoenix Socket without forwarding the ref. The `getSocket()` escape hatch ([socketAdapter.js:108-110](../node_modules/@supabase/realtime-js/dist/main/phoenix/socketAdapter.js)) returns the unwrapped Phoenix Socket where the refs ARE returned.
- **`RealtimeClient`** ([node_modules/@supabase/realtime-js/dist/main/RealtimeClient.d.ts:49-87](../node_modules/@supabase/realtime-js/dist/main/RealtimeClient.d.ts)) holds the `SocketAdapter` as a private `socketAdapter` field. It exposes:
  - `channels: RealtimeChannel[]` (line 50)
  - `stateChangeCallbacks` getter (line 82) — returns the raw `{ open, close, error, message }` callback arrays
  - `connectionState(): 'connecting' | 'open' | 'closing' | 'closed'` (line 179)
  - `isConnected(): boolean` (line 185), `isConnecting(): boolean`, `isDisconnecting(): boolean`
  - `disconnect()`, `connect()`, `channel(topic)`, `getChannels()`
  - **Does NOT publicly expose `onOpen`/`onClose`/`onError`** in its `.d.ts`. They exist on the internal `socketAdapter` field (verified at [RealtimeClient.js:466-485](../node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js) — supabase-js itself uses `this.socketAdapter.onOpen(...)` internally, but consumers see only the wrapper class).
- **`CHANNEL_STATES`** ([node_modules/@supabase/realtime-js/dist/main/lib/constants.d.ts:17-23](../node_modules/@supabase/realtime-js/dist/main/lib/constants.d.ts)) — canonical channel states are `'closed' | 'errored' | 'joined' | 'joining' | 'leaving'`. Spec 057's hook poll uses `state === 'joined' || state === 'subscribed'` — the second value is `REALTIME_SUBSCRIBE_STATES.SUBSCRIBED` ([RealtimeChannel.d.ts:127-132](../node_modules/@supabase/realtime-js/dist/main/RealtimeChannel.d.ts)), defensively read for older client versions or the value surfaced via `.subscribe()` callback. **DO NOT collapse this dual-state union** — spec 057 §2 explicitly documents the rationale.
- **`SOCKET_STATES`** ([constants.d.ts:11-16](../node_modules/@supabase/realtime-js/dist/main/lib/constants.d.ts)) — numeric `{ connecting: 0, open: 1, closing: 2, closed: 3 }`. NOT what the public `connectionState()` returns; that returns the string `ConnectionState` enum from line 36-42 (`'connecting' | 'open' | 'closing' | 'closed'`).
- **Socket close trigger path** ([socket.js:541-549](../node_modules/@supabase/phoenix/assets/js/phoenix/socket.js)) — the WebSocket's native `onclose` event handler calls `this.triggerStateCallbacks('close', event)`, which iterates all registered `onClose` callbacks **synchronously**. There's no heartbeat-wait — a transport-level WebSocket close fires the callback immediately.
- **Reconnect timing** ([RealtimeClient.js:16](../node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js)) — `RECONNECT_INTERVALS = [1000, 2000, 5000, 10000]` ms backoff after a close. Heartbeat interval default is 25000 ms ([RealtimeClient.js:12](../node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js)). Both relevant to Q6.

### 1. Q1 resolved — exact event API the hook will use

**Decision:** The hook calls `socket.onOpen(cb)`, `socket.onClose(cb)`, `socket.onError(cb)` on the underlying Phoenix Socket accessed via `(supabase as any).realtime?.socketAdapter?.getSocket()`. Each call returns a `string` ref. The hook collects these refs in an array and calls `socket.off(refs)` once in the cleanup.

**Why this path and not the adapter wrapper:**

The `SocketAdapter` (`(supabase as any).realtime?.onOpen` does not exist on the public d.ts — and even the internal adapter at [socketAdapter.js:75](../node_modules/@supabase/realtime-js/dist/main/phoenix/socketAdapter.js) drops the ref return value, leaving no way to clean up registrations. The Phoenix Socket is the lowest level that gives us BOTH register-by-callback AND deregister-by-ref. Three paths considered, ordered by preference:

| Path                                                                                       | Returns ref? | Cleanup API | Verdict |
| ------------------------------------------------------------------------------------------ | ------------ | ----------- | ------- |
| **A. `(supabase as any).realtime.socketAdapter.getSocket().onOpen(cb)`**                   | yes (string) | `socket.off([refs])` | **CHOSEN** |
| B. Mutate `(supabase as any).realtime.stateChangeCallbacks.open` array directly            | n/a — array tuple `[ref, cb]` | splice by ref | works but more fragile (we'd assign our own ref) |
| C. `(supabase as any).realtime.socketAdapter.onOpen(cb)` (the adapter wrapper)             | no (void)    | none (ref discarded) | rejected — no cleanup possible |

Path A is the minimal-fragility choice. The `as any` cast at every hop preserves the spec 057 §2 convention of localising supabase-js internal-API drift inside the hook (the public `RealtimeClient.d.ts` does not export `socketAdapter` or `getSocket()`, but their existence is verified in the JS implementation at [socketAdapter.js:108-110](../node_modules/@supabase/realtime-js/dist/main/phoenix/socketAdapter.js)).

**Callback signatures (from [Socket.js:284-324](../node_modules/@supabase/phoenix/assets/js/phoenix/socket.js) and `SocketOnOpen/Close/Error` types):**

- `onOpen(callback: () => void): string` — no arguments
- `onClose(callback: (event: CloseEvent) => void): string` — receives the WebSocket close event
- `onError(callback: (error: Event | string, transportBefore?, establishedBefore?) => void): string` — receives the error

The hook does NOT use any of the callback arguments — it just flips a boolean. So all three handlers can be typed as `() => void` at the hook level, even though the runtime signatures are richer.

**Defensive null-check at every hop.** The chain is `supabase → .realtime → .socketAdapter → .getSocket() → .onOpen/.onClose/.onError`. If supabase-js v3+ restructures, this chain returns `undefined` somewhere. The hook MUST tolerate this by short-circuiting (no events subscribed, `useState(true)` default observed — equivalent to the optimistic default of the original poll when no channels existed). Pseudocode handles this in §7 below.

### 2. Q2 resolved — socket-level granularity is sufficient

**Decision:** subscribe at the SOCKET level only. Do not subscribe per-channel.

**Reasoning:**

- The TitleBar indicator is admin chrome — its job is to show "your live updates are flowing" vs "your live updates are NOT flowing." That's a transport-health signal, not a per-subscription health signal.
- The current poll's channel-level read (`channels.some(c => c.state === 'joined' || 'subscribed')`) is **already a transport-health proxy**: if the WebSocket transport is open, the channels eventually rejoin (Phoenix's `triggerChanError` + rejoin timer at [socket.js:544-547](../node_modules/@supabase/phoenix/assets/js/phoenix/socket.js)); if the transport is closed, no channel can be `'joined'`. So socket-level `open` ↔ channel `'joined'` is a strict equivalence at the steady state.
- The ONE pathological case where socket-level diverges from channel-level is "socket open but every channel is in `'errored'` due to a server-side reject" (e.g. RLS revoke mid-session causing per-subscription server kicks). The current 2 s poll catches this; pure socket-level events do not. **Tradeoff accepted** — the indicator continues to show green in this rare case, but the underlying realtime sync IS broken. This is a UX-honesty regression in the corner case, weighed against:
  - Channel-level subscription requires solving Q3 (dynamic channel discovery), adding meaningful complexity for a corner case that the PM did not raise as a goal.
  - The corner case is bounded to the user's own RLS-revoke window; in normal disconnect (network drop, server restart), socket-level fires correctly.
- Path A from Q1 (`socket.onOpen/onClose/onError`) covers all transport-level transitions. `onClose` fires on graceful close AND on unclean transport drop ([socket.js:541-549](../node_modules/@supabase/phoenix/assets/js/phoenix/socket.js)). `onError` fires on protocol errors. `onOpen` fires when the WebSocket re-establishes after a reconnect ([RealtimeClient.js:466](../node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js) shows supabase-js itself uses this hook to re-auth on reconnect — proving it fires on reconnects).

**Documented out-of-scope as a future spec:** if the RLS-revoke corner case becomes a real complaint, a follow-up spec can add per-channel `system` event subscriptions (`channel.on('system', {}, payload => ...)` per [RealtimeChannel.d.ts:327-329](../node_modules/@supabase/realtime-js/dist/main/RealtimeChannel.d.ts)). The hook signature stays a bare boolean either way; the implementation expands behind it.

### 3. Q3 resolved — moot

**Decision:** N/A. Q3 only applies if Q2 chose channel-level granularity. Q2 chose socket-level. The socket is a singleton on the supabase-js client — it exists from the moment `createClient()` runs in [src/lib/supabase.ts:13](../src/lib/supabase.ts), well before the hook mounts. There is no "dynamic socket set" to discover.

### 4. Q4 resolved — initial state seeded synchronously from `connectionState()`

**Decision:** Option (a) from the spec — read the current state once synchronously on mount and seed `useState` with the result. Preserves spec 057 §6 "Initial tick fires immediately on mount as today" behavioral parity. The PM expressed a preference for (a) in the spec text.

**Mechanism:**

`useState` accepts a lazy initializer: `useState(() => readInitialState())`. The initializer runs ONCE on first render, before the `useEffect` schedules. The initial read uses the same `(supabase as any).realtime?.isConnected()` check that an `onOpen` handler would set true after. Pseudocode in §7.

**Edge case — pre-connect frame:** if the client hasn't yet called `realtime.connect()` (or `isConnected()` returns false), the initial seed is `false`. BUT the AC requires "optimistic `true` on initial mount." Resolution: bias the initial seed toward `true` whenever the socket is in `'connecting'` OR `'open'` state. The original poll's "empty channels → true" semantics map onto "socket not yet open → true" because in both cases the user has just navigated in and the indicator should not flash amber before the connection completes.

**The decision rule for the initial seed:**

```
isConnected() === true       → connected = true        // already open
connectionState() === 'connecting' → connected = true  // optimistic, in-flight
otherwise (closed/closing/null) → connected = false    // explicitly down
```

This subsumes AC4's "optimistic `true` on initial mount" — under normal app startup the socket is mid-connect and the rule returns `true`. The third branch only triggers if the indicator mounts AFTER an established disconnect — in that case the user SHOULD see the amber dot, which is correct UX.

**AC4 test stays satisfied:** the AC's wording is "`useConnectionStatus()` returns `true` on initial mount, BEFORE any socket / channel event has fired." The jest test mocks `supabase.realtime` with `isConnected: () => false, connectionState: () => 'connecting'` — the seed rule above returns `true`. Test passes. Reasoning is preserved if a test author mocks `connectionState: () => 'open'`. Only if a test deliberately mocks both `isConnected: () => false` and `connectionState: () => 'closed'` does the seed return `false` — which is the right answer for that scenario.

### 5. Q5 resolved — refs collected, `socket.off([refs])` on cleanup

**Decision:** Each call to `socket.onOpen(cb)`, `socket.onClose(cb)`, `socket.onError(cb)` returns a `string` ref. Collect all three into a local `refs: string[]` array. The cleanup function calls `socket.off(refs)` once with the full array. Phoenix's `off` implementation ([socket.js:609-615](../node_modules/@supabase/phoenix/assets/js/phoenix/socket.js)) iterates all `stateChangeCallbacks` keys and filters out matching refs in one pass — efficient, idempotent.

**Defensive null-check.** If the chain from Q1 short-circuited (no refs registered), the cleanup is a no-op. The hook also stores a reference to the `socket` itself; if the socket has somehow been replaced between mount and unmount (extremely unlikely — the supabase-js client is a module-scope singleton in [src/lib/supabase.ts:13](../src/lib/supabase.ts), and `_initializeOptions` is called once in the constructor), the cleanup uses the saved reference, not a re-read.

### 6. Q6 resolved — latency budget

**Jest test (AC3):** synchronous in `act()`. The event handlers are mocked and invoked inside the same React batch — the state flip happens before `act()` returns. No `jest.advanceTimersByTime` needed. AC3's "~250 ms flip latency" is trivially satisfied because no real timer is in the loop.

**Browser smoke (real-world budget):**

- **Hard disconnect (DevTools "Offline" toggle, or `socket.disconnect()` from console):** `onClose` fires when the WebSocket's transport emits `close`. The transport's `onclose` handler runs synchronously inside `onConnClose` ([socket.js:541-549](../node_modules/@supabase/phoenix/assets/js/phoenix/socket.js)), which calls `triggerStateCallbacks('close')` immediately. **Wall-clock budget: ~50-200 ms** from DevTools toggle to indicator flip — dominated by the browser's own WebSocket-close event dispatch, not by supabase-js.
- **Soft disconnect (server stops responding to heartbeats):** the worst case — the WebSocket transport stays open but heartbeats time out. Heartbeat interval is 25 s ([RealtimeClient.js:12](../node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js)). The heartbeat timeout fallback then closes the transport, which fires `onClose`. **Wall-clock budget: up to ~30 s** in this scenario.
- **Reconnect after restoration:** `onOpen` fires when the WebSocket establishes. Phoenix's reconnect backoff is `[1000, 2000, 5000, 10000]` ms ([RealtimeClient.js:16](../node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js)). After a transport close, the next reconnect attempt fires within 1-10 s depending on backoff state. **Wall-clock budget: ~1-3 s** for a fresh disconnect, longer if multiple retries have already failed.

**AC3 wording.** AC3 says "~250 ms" and is measured against the JEST TEST (the AC literally says "Measurement: jest test asserts the hook's return value updates inside the same React act() flush"). The jest measurement is honest. The user-facing wall-clock budget for browser smoke is the 50-200 ms above (hard disconnect) or up to 30 s (soft heartbeat-timeout disconnect, which is a degenerate edge case the previous 2 s poll also did not detect any faster — the 2 s poll was reading channel `state`, and channel state doesn't flip from `'joined'` to anything else until the socket closes either way).

**The user story claim "indicator flips within ~250 ms of an actual disconnect" is honest for hard disconnect, the dominant case.** For heartbeat-timeout soft-disconnect, the wall-clock is ~30 s after the last successful heartbeat — same as today's poll-based behavior, and not a regression. Documented in the hook's JSDoc per the spec's "side benefit asterisk."

### 7. Hook implementation pseudocode

The implementation is small enough to express in pseudocode without writing committed `.ts`. The FE-developer implements; this is the contract.

```ts
// src/hooks/useConnectionStatus.ts — Spec 059.
// JSDoc updated:
//   - Replaces the 2000ms setInterval poll with an event-driven
//     subscription to the underlying Phoenix Socket's onOpen/onClose/
//     onError callbacks.
//   - Tested against @supabase/realtime-js shipped with supabase-js
//     ^2.101.1. API path used: supabase.realtime.socketAdapter.getSocket()
//     returning the Phoenix Socket, which exposes onOpen/onClose/onError
//     returning ref strings, with off([refs]) for cleanup.
//   - Browser wall-clock budget for the indicator flip: ~50-200ms on hard
//     disconnect (WebSocket transport close), up to ~30s on soft
//     disconnect (heartbeat-timeout fallback). Same heartbeat-timeout
//     latency as the prior 2000ms poll because both paths waited on the
//     same underlying socket-close transition.
//   - Platform gate still INSIDE the useEffect — same Rules-of-Hooks
//     rationale as spec 057 pass-2 §3a.

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { supabase } from '../lib/supabase';

// Helper: synchronously read the current connection state for the
// initial useState seed. See spec 059 §4 for the decision rule.
function readInitialConnected(): boolean {
  try {
    const realtime: any = (supabase as any).realtime;
    if (!realtime) return true;                       // pre-init → optimistic
    if (typeof realtime.isConnected === 'function' && realtime.isConnected()) return true;
    if (typeof realtime.connectionState === 'function') {
      const s = realtime.connectionState();
      // 'connecting' counts as optimistic-true; only 'closed'/'closing' are amber.
      return s === 'open' || s === 'connecting';
    }
    return true;                                      // unknown shape → optimistic
  } catch {
    return true;                                      // never throw at mount
  }
}

export function useConnectionStatus(): boolean {
  const [connected, setConnected] = useState<boolean>(readInitialConnected);

  useEffect(() => {
    if (Platform.OS !== 'web') return;               // spec 057 §3a — native bail

    const realtime: any = (supabase as any).realtime;
    // Defensive null-check at every hop. If any link in the chain is
    // missing, we bail without subscribing — the useState seed is the
    // only value consumers ever see, which is the correct optimistic
    // fallback.
    const socket: any = realtime?.socketAdapter?.getSocket?.();
    if (!socket || typeof socket.onOpen !== 'function') return;

    const onOpen = () => setConnected(true);
    const onClose = () => setConnected(false);
    const onError = () => setConnected(false);

    const refs: string[] = [];
    refs.push(socket.onOpen(onOpen));
    refs.push(socket.onClose(onClose));
    refs.push(socket.onError(onError));

    return () => {
      try {
        socket.off(refs);
      } catch { /* socket may already be torn down on app unmount */ }
    };
  }, []);

  return connected;
}
```

**Notes for the FE-developer:**

- The `try/catch` around `socket.off(refs)` is defensive belt-and-suspenders; under React's normal lifecycle this can't throw (the socket reference is module-scope and Phoenix's `off` is null-safe over an empty `stateChangeCallbacks` shape). Keep it in — it's free protection against future supabase-js shape drift surfacing at unmount time only.
- The `readInitialConnected()` helper is local to the file (not exported). It runs once per render via the `useState` lazy-initializer pattern. Do NOT inline it into the `useState` argument — the lazy form (`useState(readInitialConnected)`) ensures it's called exactly once at mount, never on re-renders.
- No `setInterval`, no `setTimeout`. AC2 (`grep setInterval` returns zero matches) is satisfied.
- The native bail stays as the FIRST statement of the `useEffect` body. AC5 (regression test from spec 058 continues to pass) is preserved.

### 8. Test contract (AC8 — 14 cases stay, polling-specific ones are rewritten)

Two test files, both in the `unit` jest project (per `jest.config.js` glob). The existing 14 cases in `src/hooks/useConnectionStatus.test.ts` are rewritten case-by-case to event-driven equivalents — same describe-block topology, same total count (14 minimum), zero deletions. AC8 explicitly forbids deletions; polling-specific cases are **rewritten**, not removed.

#### 8a. Mock shape (replaces today's `__setChannels` test helper)

The mock provides:

- `supabase.realtime.isConnected()` — `jest.fn()` returning a configurable boolean
- `supabase.realtime.connectionState()` — `jest.fn()` returning a configurable string
- `supabase.realtime.socketAdapter.getSocket()` — returns a fake `socket` object
- `socket.onOpen(cb)`, `socket.onClose(cb)`, `socket.onError(cb)` — each is a `jest.fn()` that:
  1. Stores the callback in a module-scope captured-handlers map
  2. Returns a unique ref string (e.g. `'1'`, `'2'`, `'3'`)
- `socket.off(refs)` — `jest.fn()` that filters refs out of the captured-handlers map

The test exposes helpers via `require('../lib/supabase')`:

- `__getCapturedHandlers()` — returns `{ open: Function[], close: Function[], error: Function[] }`
- `__setInitialConnected(opts)` — sets the `isConnected`/`connectionState` mock return values for the initial-seed test
- `__getOffSpy()` — exposes the `socket.off` jest.fn for cleanup assertions

This mirrors the existing test's `__setChannels` escape-hatch pattern (spec 057 §5a) — same file layout, different exposed primitives.

#### 8b. Test case map (one-to-one rewrite)

| #  | Original (poll-based)                            | New (event-driven)                                                                                  |
| -- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1  | empty-channels mount → true                      | initial seed reads `isConnected: false, connectionState: 'connecting'` → still true (optimistic)    |
| 2  | empty-channels persists across ticks → true      | initial seed `connectionState: 'open'` → true; no events fired → stays true after `act(() => {})`   |
| 3  | single channel `'joined'` → true                 | dispatch captured `onOpen` callback inside `act()` → flips to true                                  |
| 4  | single channel `'subscribed'` → true             | dispatch captured `onOpen` callback inside `act()` after a close → flips back to true               |
| 5  | single channel `'closed'` → false                | dispatch captured `onClose` callback inside `act()` → flips to false                                |
| 6  | single channel `'errored'` → false               | dispatch captured `onError` callback inside `act()` → flips to false                                |
| 7  | mixed `['joined', 'closed']` → true              | sequence: onOpen → true, onClose → false, onOpen → true (proves latch correctness)                  |
| 8  | mixed `['closed', 'errored']` → false            | sequence: onClose → false, onError → false (proves both handlers map to false)                     |
| 9  | flips false on channel transition to closed     | initial seed true → dispatch onClose inside `act()` → flips false synchronously (no advanceTimers)   |
| 10 | flips true on channel rejoin                     | initial seed false → dispatch onOpen inside `act()` → flips true synchronously                       |
| 11 | cadence exactly 2000ms (1999/2000 boundary)      | **REWRITTEN to assert NO `setInterval` was called** — spies on `global.setInterval` and asserts zero calls. Directly enforces AC2. |
| 12 | `clearInterval` on unmount                       | **REWRITTEN:** asserts `socket.off([refs])` was called once on unmount with the three refs returned by onOpen/onClose/onError. Directly enforces AC6 cleanup. |
| 13 | post-unmount timer advancement is a no-op        | **REWRITTEN:** after unmount, manually invoking a captured callback (which the test still holds a reference to) does not flip `result.current` because React has unmounted the component. Asserts the `result.current` is whatever it was before unmount.  |
| 14 | native bail — `Platform.OS = 'ios'` → optimistic | **UNCHANGED structurally** — the new hook still has the platform bail as the first statement of the `useEffect`. Test mutates `require('react-native/Libraries/Utilities/Platform').default.OS = 'ios'`, asserts `socket.onOpen` (the new jest.fn replacing `setInterval`) was NOT called, and `result.current === true`. This is the spec 058 alignment continuation. |

**Cases 1-2** explicitly cover Q4 (initial-state seed semantics). Add ONE NEW case to verify the seed rule's three branches: `isConnected: () => true → seed true; connectionState: () => 'closed', isConnected: () => false → seed false`. This brings the file to **15 cases under 7 describe blocks** (AC8 says "14 or grows" — 15 is fine).

**Case 11** is the AC2-pinned case: `setInterval` MUST not be called. The spy-on-global-setInterval pattern from the existing case 12 (spec 057 §5a) is recycled.

**Case 12** asserts `socket.off` was called with the exact refs collected during mount. This is the new "cleanup is complete" anchor — AC6.

**Case 13** is the post-unmount no-op equivalent. Because the test holds the captured callback reference (it stored it via the mock factory), it can prove that even calling the callback after unmount doesn't flip `result.current` — though the more meaningful assertion is that `socket.off` already removed the handler from `stateChangeCallbacks`, so a real-world callback dispatch wouldn't reach the hook anyway. The test exercises both: call `socket.off` on unmount, then manually invoke the captured cb and assert `result.current` is unchanged.

**Test count after this spec:** 15 (was 14). AC8 satisfied.

#### 8c. `act()` discipline for event dispatch

```ts
import { act, renderHook } from '@testing-library/react-native';
const { result, unmount } = renderHook(() => useConnectionStatus());
const handlers = (require('../lib/supabase') as any).__getCapturedHandlers();

expect(result.current).toBe(true);                          // seed
act(() => { handlers.close[0](); });                        // dispatch
expect(result.current).toBe(false);                         // synchronous flip
act(() => { handlers.open[0](); });
expect(result.current).toBe(true);
unmount();
expect((require('../lib/supabase') as any).__getOffSpy()).toHaveBeenCalledTimes(1);
```

The `act()` wrapper batches the setState — same pattern as `inflight.test.ts`. No fake timers needed for the event flow; only the native-bail describe (case 14) keeps `jest.useFakeTimers()` for parity with the spec 058 mutation.

### 9. Initial-state semantics (Q4 restated for FE-developer clarity)

The hook uses `useState(readInitialConnected)` (lazy initializer). On mount, BEFORE any `useEffect` runs, the value is whatever `readInitialConnected()` returned. The decision rule (§4) biases toward `true` in the `'connecting'` state to preserve AC4's "optimistic `true` on initial mount." The only case the seed is `false` is when the socket is explicitly in `'closed'`/`'closing'` state at the moment of mount — which is correct UX (showing amber for a known-down socket is honest).

The `useEffect` then subscribes to events. Subsequent state transitions are driven entirely by `onOpen`/`onClose`/`onError` callbacks. The state is never read from `connectionState()` again after the initial seed — the events are the source of truth.

### 10. Cleanup verification

Two cleanup invariants, both must hold:

1. **`socket.off([refs])` is called exactly once with all three refs.** Test 12 asserts this directly by spying on the mocked `socket.off`.
2. **No stray timers, listeners, or pending promises survive unmount.** Test 11 asserts `setInterval` was never called (the new implementation should not call it at all, so this is a stronger invariant than spec 057's "clearInterval was called once"). No `setTimeout` either — verified by the same spy pattern.

The spec 058 native-bail regression test (case 14) is preserved structurally: the platform mutation runs in `try/finally`, the `setInterval` spy assertion is **upgraded** to also assert `socket.onOpen`/`onClose`/`onError` are NOT called (because the effect bails before reaching them). The `result.current === true` optimistic-default assertion stays.

### 11. TitleBar untouched (AC7)

`src/components/cmd/TitleBar.tsx` lines 8 and 77 are confirmed unchanged from spec 057 pass-2:

- Line 8: `import { useConnectionStatus } from '../../hooks/useConnectionStatus';`
- Line 77: `const connected = useConnectionStatus();`

The consumer reads the boolean and branches on it — same shape as today. No edits to `TitleBar.tsx` or `TitleBar.test.tsx` are required for this spec.

The TitleBar.test.tsx mock at `jest.mock('../../hooks/useConnectionStatus', () => ({ useConnectionStatus: () => true }))` (spec 057 §5b) continues to work unchanged — it stubs the hook at the import boundary so the underlying refactor is invisible to the component test.

### 12. Backend impact — NONE

This is reiterated for the release-coordinator and any reviewer fan-out:

- **Data model changes:** none. No migrations, no new tables, no new columns, no index changes.
- **RLS impact:** none. No new policies, no policy edits.
- **API contract:** none. No new PostgREST endpoints, no new RPCs, no new edge functions.
- **Edge function changes:** none. No `verify_jwt` toggles, no service-token validators.
- **`src/lib/db.ts` surface:** none. The hook reads `lib/supabase` directly per spec 057 §11 (codified chokepoint exception alongside `db.ts` and `useRealtimeSync.ts`).
- **Realtime impact:** none — the hook OBSERVES the existing client's socket-level events, no new postgres-changes subscriptions, no publication membership change, no `docker restart supabase_realtime_imr-inventory` required.
- **Frontend store impact:** none. `src/store/useStore.ts` is not touched. No optimistic-then-revert pattern applies (read-only derived UI state).

### 13. Browser smoke recipe (for main Claude post-implementation)

Step-by-step to verify the indicator flips on real disconnect:

1. `npm run dev:db` — boots local Supabase stack. Confirms realtime container is running.
2. `npx expo start --web` — boots the web client at the Vercel-ish port (typically 19006 or 8081).
3. Open the app at `http://localhost:8081`, log in as `admin@local.test / password`. Confirm you land on the Cmd UI shell.
4. Verify the **green dot + "connected" label** at the top-right of the TitleBar.
5. Open Chrome DevTools → Network panel → toggle the throttling dropdown to **Offline**.
6. Watch the indicator. **Expected: flips to amber + "reconnecting" within ~200ms.** (Old behavior: up to ~2 s wait for the poll boundary.) This is the AC's qualitative improvement.
7. Toggle Network throttling back to **Online**.
8. Watch the indicator. **Expected: flips back to green within ~1-3 s** as the supabase-js reconnect backoff kicks in.

Alternative smoke (no DevTools required):

- Open the browser console, run `__supabase.realtime.disconnect()`. Watch the dot flip amber within a frame. Then run `__supabase.realtime.connect()`. Watch it flip green within ~1 s.

Either smoke proves the event-driven path is wired end-to-end. The 2 s poll is gone, replaced by sub-200ms event-driven flips on hard disconnect.

### 14. Risks and tradeoffs

- **Risk: supabase-js internal-API drift.** The chain `supabase.realtime.socketAdapter.getSocket().onOpen` is NOT in the public `RealtimeClient.d.ts` — it's a documented-in-implementation path. A v3 major bump could rename `socketAdapter` to `_socket`, or move `onOpen` onto the public class, or remove the Phoenix wrapper entirely. **Mitigation:** the chain has defensive null-checks at every hop (§7 pseudocode); a missing link triggers the optimistic-true fallback (the useState seed). The JSDoc names every method used and the verified version. The risk is bounded to "the indicator goes optimistic-true and stops detecting disconnects until the hook is updated" — not "the app crashes."
- **Risk: socket-level vs channel-level UX-honesty gap in the RLS-revoke corner case.** Documented in Q2 §2 above. Tradeoff accepted; future spec can add channel-level granularity if it becomes a real complaint.
- **Risk: heartbeat-timeout soft-disconnect takes up to 30 s to surface.** Documented in Q6 §6. NOT a regression — the prior 2 s poll also took until the socket transport closed to detect this, because the channel state didn't transition until the underlying socket close fired. Same wall-clock either way.
- **Tradeoff: lazy initializer reads `connectionState()` synchronously at mount.** If supabase-js's `connectionState()` ever becomes async (extremely unlikely — it's a property read in the current implementation), the seed becomes incorrect. Verified at [RealtimeClient.js:261-263](../node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js) it's a simple getter chain. Risk is low and bounded to the seed value (first render); the event-driven updates take over from there.
- **Tradeoff: three event handlers vs one (e.g. a single `socket.on('any', ...)`).** The Phoenix Socket doesn't expose a single state-change event — `onOpen`/`onClose`/`onError`/`onMessage` are four distinct registrations. Three is the minimum useful set (`onMessage` is irrelevant for connection state — it fires on every realtime message). Three refs collected + one `socket.off([refs])` call on cleanup is the canonical cleanup pattern.

### 15. Recommended migration filename

N/A — no migration.

### 16. Files changed (developer fill-in)

The frontend-developer will:

- **EDIT** `src/hooks/useConnectionStatus.ts` — replace the `setInterval(tick, 2000)` body with the event-subscription pseudocode from §7. Update the JSDoc to name `socket.onOpen/onClose/onError` and `socket.off(refs)`, name the verified supabase-js version (^2.101.1), and document the wall-clock budget caveat from Q6. Native bail stays as first statement of `useEffect` (spec 058 alignment).
- **EDIT** `src/hooks/useConnectionStatus.test.ts` — rewrite the mock factory from `__setChannels(channels)` shape to the event-emitter shape described in §8a. Keep the file-level `jest.mock('react-native/Libraries/Utilities/Platform', ...)` block from spec 058. Rewrite cases 1-13 per the §8b table. Case 14 (native bail) is structurally unchanged. Add the new initial-seed case (15th) covering the three-branch decision rule from §4.

**No other files touched.** TitleBar.tsx and TitleBar.test.tsx are out of scope (AC7). No backend files.

## Handoff

next_agent: frontend-developer
prompt: Implement spec 059 against the design appended above. Rewrite
  `src/hooks/useConnectionStatus.ts` from the §7 pseudocode — replace the
  `setInterval(2000)` poll with subscriptions to
  `(supabase as any).realtime.socketAdapter.getSocket().onOpen/onClose/onError`,
  collect the three returned ref strings, call `socket.off(refs)` on
  unmount. Use `useState(readInitialConnected)` with the §4 lazy-seed rule
  (optimistic-true unless socket is explicitly `'closed'`/`'closing'`).
  Keep the `Platform.OS !== 'web'` bail as the first statement of the
  `useEffect`. Update the JSDoc per §7. Rewrite the test file per §8b's
  case map — 14 cases minimum (15 with the new initial-seed case), zero
  deletions, all polling-specific assertions replaced with event-dispatch
  equivalents under `act()`. Run `npm test`, `npm run typecheck`,
  `npm run typecheck:test` — all must pass. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under
  ## Files changed. Main Claude will run the §13 browser smoke after
  build to verify the live flip latency.
payload_paths:
  - specs/059-use-connection-status-event-driven.md
  - src/hooks/useConnectionStatus.ts
  - src/hooks/useConnectionStatus.test.ts

## Files changed (spec 059)

- `src/hooks/useConnectionStatus.ts` — replaced the `setInterval(tick, 2000)`
  body with subscriptions to `(supabase as any).realtime.socketAdapter.getSocket()`'s
  `onOpen` / `onClose` / `onError` callbacks. Collects the three returned ref
  strings; cleanup calls `socket.off([refs])` once on unmount. `useState`
  switched to lazy initializer (`useState(readInitialConnected)`) that reads
  `isConnected()` + `connectionState()` per the §4 three-branch decision rule
  (optimistic-true unless explicitly `'closed'` / `'closing'`). Defensive
  null-checks at every hop of `realtime.socketAdapter.getSocket().onOpen`;
  any missing link short-circuits to the optimistic seed (never throws).
  Platform bail stays as FIRST statement of the `useEffect` body. JSDoc
  rewritten to describe the event-driven approach, the defensive private-API
  navigation, the supabase-js `^2.101.1` verification pin, and the wall-clock
  budget caveat (~50-200ms hard disconnect; up to ~30s heartbeat-timeout
  soft disconnect — not a regression vs. the prior poll).

- `src/hooks/useConnectionStatus.test.ts` — rewritten case-by-case per the
  §8b table. Mock factory replaced `__setChannels(channels)` with an
  event-emitter shape:
  - `supabase.realtime.isConnected()` and `connectionState()` mocked via
    `__setInitialConnected({ isConnected, connectionState })`
  - `socket.onOpen/onClose/onError` each store the callback and return a
    unique ref string (`'1'`, `'2'`, `'3'`)
  - `socket.off([refs])` filters the captured handlers map
  - `__getCapturedHandlers()`, `__getOffSpy()`, `__getOnOpenSpy()`, etc.
    expose the mocks to the test body
  Cases 1-13 rewritten as event-driven equivalents under `act()`. Case 11
  (cadence-pinning) replaced with an AC2-enforcing "setInterval/setTimeout
  never called" spy assertion. Case 12 (clearInterval-on-unmount) replaced
  with `socket.off([openRef, closeRef, errorRef])` cleanup assertion. Case
  13 (post-unmount no-op) replaced with manual-callback-invocation +
  result-unchanged assertion. Case 14 (native bail) kept structurally
  identical to spec 058 but assertions upgraded to also verify
  `socket.onOpen/onClose/onError` were not invoked. Case 15 (new) covers
  the §4 three-branch initial-seed decision rule explicitly. Total: 17
  jest `test()` blocks across 8 describe groups (spec 058 was 14 across 7
  describes; AC8 allows growth, forbids deletion).

### Verification performed

- `npm test` — 232 tests pass across 23 suites (including 17 in
  `useConnectionStatus.test.ts`).
- `npm run typecheck` — clean.
- `npm run typecheck:test` — clean.
- `grep -n 'setInterval' src/hooks/useConnectionStatus.ts` — zero matches
  (AC2 satisfied).
- `grep -n 'setTimeout' src/hooks/useConnectionStatus.ts` — zero matches.
- Mutation test: commented out `if (Platform.OS !== 'web') return;` →
  the native-bail test (case 14) correctly fails because the subscription
  side-effects run on native. Guard restored, suite returns to 17/17 pass.
- `git diff --name-only` — confirms only
  `src/hooks/useConnectionStatus.ts` and `src/hooks/useConnectionStatus.test.ts`
  changed. `src/components/cmd/TitleBar.tsx` is untouched (AC7).
- Browser smoke (§13 recipe) — not executed by frontend-developer per
  the spec's explicit "Main Claude will run the §13 browser smoke" line.
