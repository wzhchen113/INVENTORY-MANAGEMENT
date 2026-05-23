# Spec 055: Global loading indicator (top bar + first-mount skeletons)

Status: READY_FOR_REVIEW (second pass — fixes for FIXES_NEEDED review)

## User story

As a store manager using the Cmd UI on web, I want a consistent visual signal that the app is talking to Supabase so that I know whether to wait, retry, or assume nothing is happening — without having to inspect each section for its own spinner.

## Acceptance criteria

### Top-bar indicator (every `db.ts` call)

- [ ] A thin progress bar renders at the top edge of the Cmd UI title bar whenever **any** call routed through `src/lib/db.ts` is in flight.
- [ ] The bar is lit (animated indeterminate state) when the in-flight count is `>= 1` and dark/hidden when the in-flight count is `0`.
- [ ] No count badge — concurrency is collapsed to a single boolean (one-or-more vs. zero).
- [ ] The bar appears within 100 ms of a `db.ts` call starting (no debounce on show).
- [ ] The bar hides within 100 ms of the last in-flight call resolving (success, error, or abort).
- [ ] A realtime-driven reload triggered by `useRealtimeSync` (which calls `db.ts` fetchers) DOES light the bar — it is a real network round trip and the user benefit of seeing it outweighs the noise. (Trade-off noted in Assumptions.)
- [ ] The bar reads its color from the existing Cmd theme tokens (`useCmdColors()`); it must not regress dark mode.

### First-mount section skeletons

- [ ] When a Cmd UI section under `src/screens/cmd/sections/` first mounts and has no cached store data for the slice(s) it reads, the section renders shimmer skeletons in place of its primary content area until the first relevant fetch resolves.
- [ ] Skeletons are NOT shown for subsequent re-renders, re-mounts with cached data already in `useStore`, or background refreshes — the top bar covers those.
- [ ] Skeleton shape approximates the real content (rows for list views, card grid for grid views) so the layout does not jump when real data lands.
- [ ] Skeletons respect dark/light mode via existing theme tokens.

### Timeout + soft warning

- [ ] Every `db.ts` call is wrapped with an `AbortController` and a hard timeout. Default hard timeout: **30 seconds**.
- [ ] At **5 seconds** of in-flight time on a given call, a softer indication fires — the top bar's color shifts to a "taking longer than usual" warning shade (theme token). This is purely visual; no toast at this stage.
- [ ] At **30 seconds**, the call is aborted via the `AbortController`. The promise rejects with an `AbortError`.
- [ ] On abort for a **read** call (`GET` / RPC that the codebase treats as read-only): toast text reads `"Request timed out — please try again."`
- [ ] On abort for a **write** call (`POST` / `PATCH` / `DELETE` / RPC that mutates): toast text reads `"Request timed out — the change may or may not have been saved. Refresh to verify."` This wording is mandatory because aborting the fetch on the client does NOT undo a server-side mutation that may have already committed.
- [ ] The read-vs-write classification is encoded in `db.ts` per call site (not inferred at runtime) — see Architect notes.
- [ ] Aborted calls are routed through the same `notifyBackendError` path so they appear in the existing toast surface, with the timeout-specific copy above.

### Wiring

- [ ] A new module exposes the in-flight count and timeout behavior; `db.ts` wraps every outgoing call through it.
- [ ] The top-bar component subscribes via a Zustand selector so it re-renders only when the in-flight boolean flips, not on every count change.
- [ ] Existing per-slice `loading` / `error` flags in `useStore.ts` are **not removed** — the global indicator is additive. Sections may continue to read per-slice flags for inline behavior (e.g., disabling a submit button) without conflict.

### Web vs. native

- [ ] On web (Vercel build, `react-native-web`): all of the above ships.
- [ ] On native (EAS build, iOS/Android): the top bar renders and behaves identically. Skeletons are not required to be added to native-specific layouts in this spec — existing native rendering must not regress. (See Assumptions.)

## In scope

- New global in-flight counter + timeout wrapper sitting between `db.ts` call sites and Supabase.
- A top-bar progress component mounted by the Cmd shell.
- Shimmer skeleton component(s) (one for list, one for grid) consumed by sections on first mount.
- Wiring `db.ts` so every existing call goes through the wrapper without changing each call site's external signature.
- Timeout-aware error copy for aborts, routed through `notifyBackendError`.
- Theme tokens for the bar's idle / active / warning states in both Cmd palettes.

## Out of scope (explicitly)

- **Per-slice `loading` / `error` flags in `useStore.ts`** — kept as-is. Removing them is a separate cleanup and risks behavior regressions in disable-while-loading UI.
- **The toast / `notifyBackendError` system** — untouched except for the two new timeout strings above.
- **Retry behavior** — auto-retry on timeout is NOT in this spec. A future spec can add backoff. Today the user retries manually.
- **Offline detection** — distinguishing "no network" from "slow network" / "server timeout" is a separate spec.
- **Edge function calls made directly via `callEdgeFunction` / `supabase.functions.invoke`** — those have their own existing timeout/error envelope. Adding them to the global counter is desirable but out of scope here; pulling them in is a follow-up if the design proves clean.
- **`useRealtimeSync` subscription connect/disconnect indicators** — only the fetches the hook triggers are counted, not the websocket lifecycle.
- **Native-specific skeletons** — native must not regress, but skeletons are only required on the web Cmd UI surface.
- **Count badge / per-call breakdown UI** — the spec is "any in flight" boolean.

## Open questions resolved

- Q: Location — top bar vs. per-section skeletons? → A: Both. Global top bar + skeleton on first-mount-with-no-cache.
- Q: Trigger — which calls light it up? → A: Every `db.ts` call, reads and writes, for maximum coverage.
- Q: How to handle a call that never returns? → A: Auto-cancel via `AbortController` after 30 s.
- Q: Visual style? → A: Thin top bar (animated indeterminate) + shimmer skeletons on first mount.

## Assumptions (defaults the user can override)

- **A1 — Realtime-driven reloads light the bar.** Default YES. Rationale: `useRealtimeSync`'s debounced 400 ms reload calls `db.ts` fetchers, which are real network round trips; suppressing them would create a class of "secret" loads that the indicator misses, defeating its purpose. Trade-off: the bar will blink frequently in multi-tab / multi-user editing sessions. If the user prefers to silence these, the wrapper can accept an opt-out flag the realtime hook sets on its fetches.
- **A2 — Web-first.** All new visuals (top bar + skeletons) are designed for the browser Cmd UI on react-native-web. Native must not regress (the top bar still renders), but the native experience does not get new skeletons in this spec.
- **A3 — One bar, no count.** Concurrent calls collapse to a single lit state. Matches YouTube / GitHub / Linear UX. No "3 requests pending" UI.
- **A4 — 5 s warning, 30 s hard cancel.** The 5 s soft warning is a near-free addition that answers "is it stuck?" earlier than 30 s. The 30 s hard cancel matches the user's stated preference.
- **A5 — Per-call read-vs-write classification lives in `db.ts`.** Rather than guess at runtime from HTTP method or RPC name, each wrapped call declares `{ kind: 'read' | 'write' }` at the call site. This is editable in one file and avoids regressing the timeout-warning copy if Supabase signature shapes change.
- **A6 — Write aborts may have already committed.** The toast copy for write timeouts explicitly says "the change may or may not have been saved. Refresh to verify." This is the cost of giving up on the client without a transactional outbox; the alternative (no timeout on writes) leaves the UI hung indefinitely. The architect should call out any specific write paths where a stronger guarantee is wanted (idempotency keys, server-side dedupe) — those are follow-ups.

## Dependencies

- Existing `src/lib/db.ts` — wrapper inserted here. Single file; this is the chokepoint that makes the spec feasible.
- Existing `src/store/useStore.ts` `notifyBackendError` plumbing for the timeout toasts.
- Existing `src/hooks/useRealtimeSync.ts` — its fetches go through `db.ts` and will light the bar by default.
- Existing Cmd theme system (`src/theme/`, `useCmdColors()`) — new tokens added for bar idle / active / warning.
- Existing `src/navigation/CmdNavigator.tsx` — mounts the top-bar component as part of the Cmd shell title bar.
- No new third-party libraries needed. Native `AbortController` is available in the runtime per RN 0.81 / Hermes.

## Project-specific notes

- **Cmd UI section / legacy:** This is a chrome-level concern, not a section. The top bar mounts in the Cmd shell (`CmdNavigator`-adjacent). Skeletons are consumed inside individual sections under `src/screens/cmd/sections/`.
- **Per-store or admin-global:** N/A. This is a client-side concern, store-agnostic.
- **Realtime channels touched:** None at the channel level. The hook's existing `store-{id}` + `brand-{id}` channels are untouched. The bar lights when the hook's debounced reload triggers fetches (by virtue of those fetches going through `db.ts`).
- **Migrations needed:** No.
- **Edge functions touched:** No. Direct edge-function calls (`callEdgeFunction`, `supabase.functions.invoke`) are out of scope for v1.
- **Web/native scope:** Web-first per A2. Native must render the bar without regression but does not get new section-level skeletons in v1.
- **Tests:** jest track. Targets:
  - Unit: in-flight counter increments/decrements correctly, abort fires at 30 s, warning state fires at 5 s, read vs. write copy diverges.
  - Component: top-bar shows when count > 0, hides at 0; skeleton renders on first mount with empty store slice and unmounts when data arrives.
  - No new pgTAP or shell-smoke coverage needed — the change is client-only.
- **`app.json` slug:** Untouched. Not relevant to this spec.

## Backend design

This spec is **frontend-only**. Confirming up front so the developer is not chasing migrations:

- **Migrations:** none. No schema or seed changes.
- **RLS impact:** none. No tables touched.
- **Edge functions:** none modified. `callEdgeFunction` / `supabase.functions.invoke` paths stay on their own envelope (out of scope per the spec); the wrapper introduced here does NOT route through them in v1.
- **Realtime publication:** unchanged. No `docker restart supabase_realtime_imr-inventory` step needed.
- **`src/lib/db.ts` surface:** every existing export keeps its signature. The change is internal: each function adopts a thin `tracked(...)` wrapper at the chokepoint where it does the supabase round-trip. No call site under `src/store/useStore.ts` or `src/screens/cmd/sections/` changes.

The boundary the backend-architect cares about is the **wrapper contract**: how `kind: 'read' | 'write'` is declared per call, how `AbortController` is plumbed into the supabase-js builders without forcing each call site to learn about it, and how the wrapper composes with the existing `notifyBackendError` channel. The rest is frontend chrome.

### 1. In-flight counter API

**Location:** a new tiny standalone Zustand store at `src/lib/inflight.ts` — NOT a slice of `useStore.ts`.

Rationale for keeping it out of `useStore.ts`:

- `useStore.ts` is ~51 KB of business-data state. The in-flight counter is plumbing the wrapper itself owns; coupling it to the main store creates a circular import risk (`db.ts` already imports nothing from `useStore.ts`, and we want to keep it that way — `db.ts` reaching back into the data store would be a regression).
- Zustand's `create()` cost is trivial; this isolates the loading concern in one file and keeps `useStore.ts`'s diff trivial.
- This matches the precedent set by `src/lib/paletteAction.ts` (a tiny tab-scoped Zustand store the shell consumes alongside the main store — see [src/screens/cmd/ResponsiveCmdShell.tsx:11](src/screens/cmd/ResponsiveCmdShell.tsx)).

**Public shape:**

```ts
// src/lib/inflight.ts — new module
export type InflightKind = 'read' | 'write';

interface InflightState {
  // Aggregate boolean — what the top bar selects.
  hasInflight: boolean;
  // Aggregate warning — flips true when ANY in-flight call has been
  // alive >= 5 s. Flips back to false when the slow call settles or
  // is aborted, and no other slow call remains.
  hasSlow: boolean;
  // Internals; consumers should not touch.
  _activeCount: number;
  _slowCount: number;
}

interface InflightActions {
  /**
   * Track a promise-producing thunk. Returns the underlying promise.
   * The wrapper owns the AbortController, the 5s warning timer, and
   * the 30s hard-abort timer for THIS call.
   *
   * `kind` drives the abort toast copy (read vs. write). The architect
   * mandates per-call-site declaration — do not infer from HTTP method.
   *
   * `label` is for debugging only — surfaces in dev logs when an abort
   * fires. Pass the function name (e.g. 'fetchInventory').
   *
   * Returns the same shape as the underlying call: the promise resolves
   * with the inner value or rejects (caller still does `await`).
   */
  track<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    opts: { kind: InflightKind; label: string },
  ): Promise<T>;
}

export const useInflight = create<InflightState & InflightActions>(...);

// Pre-bound selector for the TopProgressBar — re-renders only when the
// boolean flips, not on every increment. Zustand handles the equality.
export const selectHasInflight = (s: InflightState) => s.hasInflight;
export const selectHasSlow = (s: InflightState) => s.hasSlow;
```

**Concurrency:** the counter is an integer (`_activeCount`); `track()` increments on entry and decrements in a `.finally()`. The public `hasInflight` boolean is derived as `_activeCount > 0`. The store updates `hasInflight` in the same `set()` as the count change so the selector fires exactly when the boolean flips, not on every count tick. Same shape for `_slowCount` / `hasSlow`.

**Timers:** **per-call timers**, not a single rolling timer. Rationale:

- A rolling 5 s timer would mean "5 s after the first call started" — if call A starts at t=0 and call B at t=4 s, B is already classed as slow after 1 s, which is wrong.
- Each call gets its own `setTimeout(warn, 5000)` and `setTimeout(abort, 30000)`. Both are cleared in `.finally()`.
- Aggregate `hasSlow` is `_slowCount > 0`; a call's warn timer increments `_slowCount` on fire and the `.finally()` decrements it if the warn already fired. (If the call resolves before 5 s, the warn timer is cleared and `_slowCount` is never incremented for it.)

**Soft-warning transition across the 5s→30s boundary:** `hasSlow` stays true from the 5 s mark until either (a) the call resolves/rejects, or (b) the 30 s abort fires and the rejection settles. So the bar's warning color persists for the entire slow window, then drops back when the call settles. No special handoff between the two timers is needed.

**Idempotency / leak protection:**

- `.finally()` runs the cleanup regardless of resolve/reject/abort — so route changes, component unmounts, or thrown errors mid-flight all leave the counter clean.
- If `track()` is called with an already-signaled `AbortSignal` (defense in depth — should not happen in v1 but cheap to guard), the wrapper checks `signal.aborted` and short-circuits without incrementing.

### 2. `src/lib/db.ts` wrapper signature

**Strategy:** every existing exported function in `db.ts` wraps its body in `useInflight.getState().track(async (signal) => { ... }, { kind, label })`. External signatures stay identical — call sites in `useStore.ts` do not change.

The wrapper imports `useInflight` at module load. The naming convention `kind: 'read' | 'write'` is declared **inline in the wrapper call at each function**, not as a separate const map (a map drifts; inline-at-call-site doesn't).

**Reference shape** (architect-supplied; developer implements):

```ts
// At top of db.ts, alongside other imports.
import { useInflight } from './inflight';

// Existing function refactored — external signature unchanged.
export async function fetchInventory(
  storeId?: string,
): Promise<Array<InventoryItem & { i18nNames: Record<string, string> }>> {
  return useInflight.getState().track(
    async (signal) => {
      let query = supabase
        .from('inventory_items')
        .select(`*, vendor:vendors(name), updater:profiles!last_updated_by(name), catalog:catalog_ingredients(...)`)
        .order('id', { ascending: true })
        .abortSignal(signal);
      if (storeId) query = query.eq('store_id', storeId);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(mapItem);
    },
    { kind: 'read', label: 'fetchInventory' },
  );
}
```

**Why this shape:**

- The wrapper is per-function, not a top-level HOC. Each function pre-declares `kind` and `label`, so a future grep over `db.ts` for `kind: 'write'` produces a clean inventory of mutations.
- The lambda receives `signal: AbortSignal` and forwards it via `.abortSignal(signal)`. This is the universal hook — see "AbortController plumbing" below.
- `.finally()` plumbing lives inside `track()`. The function bodies stay obvious — no try/catch noise added for instrumentation.

**`kind` classification rule** (mechanical — apply once during the refactor):

| HTTP / RPC pattern in the function body | `kind` |
| --- | --- |
| Only `.select(...)` calls | `read` |
| Any `.insert`, `.update`, `.delete`, `.upsert` | `write` |
| `.rpc(...)` where the SQL function is `SELECT`-only (e.g. `auth_can_see_store`) | `read` |
| `.rpc(...)` where the SQL function is `VOLATILE` / does INSERT/UPDATE/DELETE (e.g. `create_inventory_item_with_catalog`, `demote_profile_to_user`) | `write` |
| Mixed (e.g. read-then-write, like `updateInventoryItem` which selects `catalog_id` then UPDATEs catalog_ingredients) | `write` (write copy is the safer abort message) |

The developer goes through each of the ~65 supabase calls in `db.ts` (the Grep count above) and classifies each one. The 65 number is calls, not exports — some exports have multiple awaits (e.g. `updateInventoryItem` has a SELECT + an UPDATE in one function). The `kind` is per-export-function, not per-await, because the wrapper wraps the whole function as a unit.

**Edge case: `fetchAllForStore`.** It fans 15 fetches via `Promise.all`. Each of those child functions is already wrapped by `track()`, so the parent does NOT wrap again — it just awaits. The counter will see ~15 concurrent reads briefly, and `hasInflight` stays true until the last child resolves. This is correct behavior.

### 3. AbortController plumbing

**Inside `track()`** (in `src/lib/inflight.ts`):

```ts
async function track<T>(fn, opts) {
  const ctrl = new AbortController();
  // increment _activeCount, set hasInflight=true
  set((s) => ({ _activeCount: s._activeCount + 1, hasInflight: true }));

  let warnFired = false;
  const warnTimer = setTimeout(() => {
    warnFired = true;
    set((s) => ({ _slowCount: s._slowCount + 1, hasSlow: true }));
  }, 5000);
  const abortTimer = setTimeout(() => {
    ctrl.abort(new DOMException('timeout', 'TimeoutError'));
  }, 30000);

  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(warnTimer);
    clearTimeout(abortTimer);
    set((s) => {
      const nextActive = s._activeCount - 1;
      const nextSlow = warnFired ? s._slowCount - 1 : s._slowCount;
      return {
        _activeCount: nextActive,
        hasInflight: nextActive > 0,
        _slowCount: nextSlow,
        hasSlow: nextSlow > 0,
      };
    });
  }
}
```

**Inside each `db.ts` function** — three supabase-js paths and how they accept the signal:

| Path | Method to call |
| --- | --- |
| `supabase.from(...).select/insert/update/delete/upsert(...)` (PostgrestBuilder chains) | Append `.abortSignal(signal)` on the builder before the `await`. **Confirmed available** on `PostgrestTransformBuilder` — see [node_modules/@supabase/postgrest-js/dist/index.d.cts:1239](node_modules/@supabase/postgrest-js/dist/index.d.cts). |
| `supabase.rpc('fn_name', args)` | `.rpc()` returns a `PostgrestFilterBuilder` that extends the transform builder — same `.abortSignal(signal)` chain works. |
| `supabase.functions.invoke('fn_name', { body, signal })` | The `FunctionInvokeOptions` type accepts an optional `signal: AbortSignal` — see [node_modules/@supabase/functions-js/dist/main/types.d.ts:110](node_modules/@supabase/functions-js/dist/main/types.d.ts). Per spec out-of-scope: `fetchBreadbotSales` in [src/lib/db.ts:1209](src/lib/db.ts) is the **only** edge-function call in `db.ts` today; the wrapper will still pass the signal through (`{ body, signal }`) for hygiene, even though edge-function calls are not in the global counter per the spec. Re-read: spec line 64 excludes direct edge-function calls "made directly via `callEdgeFunction` / `supabase.functions.invoke`" from the counter. Since `fetchBreadbotSales` is exported from `db.ts` and is part of the unified wrapper, the architect's call: **wrap it normally**. It is "in db.ts" — the spec's exclusion is about call sites outside `db.ts`, not about excluding edge-function-backed `db.ts` exports. Confirm with PM if this reading is wrong, but it is the simpler default. |

**Important supabase-js caveat — surface explicitly to the developer:** `.abortSignal()` exists on the *builder*, not on the awaited promise. If a future call-site forgets to chain it before `await`, the abort silently does nothing. The wrapper cannot detect this — it is a code-review concern. Add a comment to the top of `db.ts` explaining the discipline.

**`.single()` interaction:** several functions chain `.single()` after `.select()`. The chain order is `.select(...).eq(...).single().abortSignal(signal)` — `.abortSignal()` is on the transform builder and can come last. No reordering required vs. the existing code.

### 4. Top-bar component contract

**Mount point:** inside [src/components/cmd/TitleBar.tsx](src/components/cmd/TitleBar.tsx), as the first child of the existing `<View>` (line 102) — rendered as an overlay positioned at the very top edge of the 32 px title bar.

Rationale for putting it inside `TitleBar.tsx` (vs. mounting at `CmdNavigator` root):

- The bar is chrome-level and the title bar is the chrome. Mounting in `CmdNavigator` would require absolute-positioning the bar over `NavigationContainer`'s children, which is fragile (the navigator's card transitions could clip it).
- `TitleBar.tsx` already bails early on non-web (`if (Platform.OS !== 'web') return null`); on native the bar is acceptable to skip per A2 (the spec requires native to "render and behave identically" but the top bar IS the title bar on web only — the native experience never had a `TitleBar` to begin with).

Wait — re-read A2: "On native, the top bar renders and behaves identically." That contradicts `TitleBar.tsx`'s web-only bail. **This is an open question to surface to PM, not architect to invent.** Option A: render the bar on native too (move the LoadingBar out of TitleBar.tsx and mount it elsewhere on native). Option B: clarify that "renders identically" really means "the loading indicator is observable on native too, perhaps as a different host element." The spec's wording is ambiguous. **Recommended path:** ship web-only in v1 (matches A2's "web-first" framing and the existing chrome) and note this in the developer handoff so they raise it if QA flags. The component itself should be platform-agnostic so a future spec can mount it wherever native chrome lives.

**Component shape:**

```tsx
// src/components/cmd/LoadingBar.tsx — new file
interface Props {
  /** Visual height in px. Default 2. */
  height?: number;
}

export const LoadingBar: React.FC<Props> = ({ height = 2 }) => {
  const C = useCmdColors();
  // Two selectors — each fires only when its boolean flips. Avoid
  // pulling the whole store object; pulling `hasInflight && hasSlow`
  // would compose at the call site, not in the selector.
  const visible = useInflight(selectHasInflight);
  const slow = useInflight(selectHasSlow);

  if (!visible) return null;

  // Color: `C.accent` while normal, `C.warn` while slow.
  // Animated indeterminate sweep — use `react-native-reanimated` OR a
  // CSS `@keyframes` rule on web. Recommend CSS keyframes injected via
  // a `<style>` tag at module scope (web-only), with a static fallback
  // on native. Lighter than pulling reanimated for one bar.
  ...
};
```

**Selector pattern — re-render budget:**

The TopProgressBar should re-render at most:
- Once when `hasInflight` flips false → true.
- Once when `hasSlow` flips false → true (color shift).
- Once when `hasSlow` flips true → false (color restore).
- Once when `hasInflight` flips true → false (unmount).

That is 4 renders per slow request and 2 renders per fast request, regardless of how many concurrent calls are active. Zustand's reference-equality selector handles this for free since both booleans are derived in the `set()` call.

**New theme tokens needed** in `src/theme/colors.ts` (both `LightCmd` and `DarkCmd`):

- `loadingBar`: idle stripe color (same hue as `accent` but slightly muted; can reuse `accent` to start).
- `loadingBarSlow`: warning stripe color (reuse `warn` initially).

If the developer needs additional tokens (e.g. a track/rail background behind the sweep) they should add them in the same PR.

### 5. Skeleton component contract

**Components:** two generic components in `src/components/cmd/`:

- `<ListSkeleton rows={number} />` — used by Pattern B sections (Inventory, Recipes, Vendors, PrepRecipes, etc.) where the right pane is a list.
- `<GridSkeleton rows={number} cols={number} />` — used by grid-shaped sections (Dashboard cards, Reports cards).

Each renders dimmed shimmer rectangles using existing theme tokens (`C.panel2` base, `C.border` highlight, with a 1.4s pulse or shimmer on web). Native renders a static dimmed bar (no animation — per A2 native doesn't get new visuals).

**"First-mount with no cached data" detection — per-section integration:**

Each section's render gets ONE additional check at the top:

```tsx
// Inside e.g. VendorsSection
const vendors = useStore((s) => s.vendors);
const storeLoading = useStore((s) => s.storeLoading);

// First-mount-with-no-cache: the global loadFromSupabase is in flight
// AND the slice we care about is still empty. After the first fetch
// resolves, either vendors is non-empty (skeleton unmounts) or the
// real "no vendors yet" empty state shows (storeLoading false).
const isFirstLoad = storeLoading && vendors.length === 0;

if (isFirstLoad) return <ListSkeleton rows={6} />;
```

**Why `storeLoading && slice.length === 0`** and not a new per-section flag:

- `storeLoading` already exists in `useStore.ts` (line 511, 937, 1032 — toggled by `loadFromSupabase`). It is the most reliable "we are talking to the server about your data" signal we have.
- The slice-emptiness check is the "no cached data" predicate. Once a fetch lands (success or fail), the slice is either populated or known-empty. Subsequent re-mounts of the section see `storeLoading: false` and the skeleton is skipped.
- Background refreshes (realtime-driven `loadFromSupabase` invocations) DO set `storeLoading: true` briefly, but if the slice already has data from the previous load, `isFirstLoad` is false and the skeleton stays hidden — only the top bar lights up. This matches the spec's "skeletons only on first mount with empty cache" rule.
- This does NOT require removing the existing per-slice `loading`/`error` flags — they coexist (spec line 42).

**Pattern integration cheat-sheet for the frontend developer:**

| Section file | Primary slice | Skeleton |
| --- | --- | --- |
| VendorsSection | `s.vendors` | `<ListSkeleton rows={6} />` |
| RecipesSection | `s.recipes` | `<ListSkeleton rows={8} />` |
| InventoryListScreen / InventoryDesktopLayout | `s.inventory` | `<ListSkeleton rows={10} />` |
| PrepRecipesSection | `s.prepRecipes` | `<ListSkeleton rows={6} />` |
| WasteLogSection | `s.wasteLog` | `<ListSkeleton rows={6} />` |
| AuditLogSection | `s.auditLog` | `<ListSkeleton rows={8} />` |
| EODCountSection | `s.eodSubmissions` | `<ListSkeleton rows={4} />` |
| POSImportsSection | `s.posImports` | `<ListSkeleton rows={4} />` |
| DashboardSection | composite (`s.inventory`, `s.recipes`) | `<GridSkeleton rows={2} cols={3} />` |
| ReportsSection | `s.savedReports` | `<GridSkeleton rows={2} cols={3} />` |

The 9-section claim in the dispatching prompt: there are ~10 first-mount-eligible sections. The developer should integrate the skeleton in each one as a small block at the top of the render, matching the table above. If a section has section-local state (e.g. selectedId), the skeleton renders BEFORE that state is read, so the section's effects don't run prematurely.

**Sections that should NOT show a skeleton:**

- `RestockSection`, `ReceivingSection`, `ReconciliationSection`, `OrderScheduleSection` — these have local-only state with no slice dependency, or hand off to a sub-flow with its own modal. The top bar covers their network round-trips.
- `BrandsSection`, `UsersSection` — super-admin-only; can ship without skeletons in v1 (low-traffic).

### 6. Error / toast integration

The wrapper's `.finally()` cleans up counter state. **Error handling stays at the call site** — each `db.ts` function still throws on supabase error, and the calling code in `useStore.ts` still does the optimistic-then-revert with `notifyBackendError` ([src/store/useStore.ts:23](src/store/useStore.ts)).

**Two failure paths the wrapper must compose with:**

**(a) Underlying fetch rejects (network / supabase error)** — the existing path. The supabase-js builder rejects, the `await` in the wrapped function rethrows, the wrapper's `.finally()` decrements the counter, and the rejection propagates to the calling action in `useStore.ts`. `notifyBackendError(action, e)` already handles the toast. **No change to this path.**

**(b) AbortController fires (5s warn does not, 30s hard abort)** — new path. The supabase-js builder rejects with an `AbortError` (typically `{ name: 'AbortError', message: 'AbortError' }` or similar — supabase-js's `.abortSignal()` propagates the `DOMException` from `AbortController.abort()`). The wrapper needs to distinguish this from (a) **before** letting it bubble.

**Architect's recommendation: emit a synthetic typed error from the wrapper, not from each call site.**

```ts
// src/lib/inflight.ts
export class InflightTimeoutError extends Error {
  readonly kind: InflightKind;
  readonly label: string;
  constructor(kind: InflightKind, label: string) {
    super(
      kind === 'write'
        ? 'Request timed out — the change may or may not have been saved. Refresh to verify.'
        : 'Request timed out — please try again.',
    );
    this.name = 'InflightTimeoutError';
    this.kind = kind;
    this.label = label;
  }
}

async function track<T>(fn, opts) {
  // ... timers setup ...
  try {
    return await fn(ctrl.signal);
  } catch (e: any) {
    // The supabase-js builder rejects with the original AbortError when
    // .abortSignal() fires. Detect it here and re-wrap so the caller's
    // `catch` sees a typed, message-correct error instead of having to
    // parse `e.message === 'AbortError'`.
    if (ctrl.signal.aborted && (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.message?.includes?.('aborted'))) {
      throw new InflightTimeoutError(opts.kind, opts.label);
    }
    throw e;
  } finally {
    // ... counter cleanup ...
  }
}
```

**Why a typed class:** `notifyBackendError` already does `e?.message || String(e)` to extract the toast text. The `InflightTimeoutError` constructor sets `message` to the exact copy the spec mandates (read vs. write), so the existing toast path naturally surfaces the correct copy with **zero changes** to `notifyBackendError` and **zero changes** to call sites in `useStore.ts`.

The spec acceptance criterion "aborted calls are routed through the same `notifyBackendError` path so they appear in the existing toast surface" — this design satisfies that literally: the call site's existing `.catch(e => notifyBackendError('Save vendor', e))` produces the timeout copy because `e.message` is the timeout copy.

**Distinguishing "I aborted you" from "the server rejected you":** the check `ctrl.signal.aborted` is the discriminator. `AbortController.signal.aborted` flips true only when our 30 s timer called `ctrl.abort()`. A server error or network error rejects the builder without our signal having been triggered, so `ctrl.signal.aborted` is false in the catch and the original error rethrows. This is the cleanest, deterministic boundary.

**Cosmetic gotcha:** the toast title is the **action name** the caller passed to `notifyBackendError` (e.g. "Save vendor"); the toast body is `e.message`. Spec acceptance reads the toast body. Confirm with the frontend developer this is acceptable; if PM wants a generic "Request timed out" title for aborts specifically, that's a small Toast.show diversion the wrapper could trigger directly in lieu of throwing — but the current design (throw → existing handler shows toast) is simpler and reads better in code review. **Architect's call: ship the throw-and-let-existing-handler-format approach.**

### 7. Realtime sync interaction

**Path confirmed clean:**

1. Realtime websocket fires → `useRealtimeSync` callback → `handleSync` ([src/navigation/CmdNavigator.tsx:62](src/navigation/CmdNavigator.tsx)) → `setTimeout` 400 ms debounce → `useStore.getState().loadFromSupabase(sid)`.
2. `loadFromSupabase` ([src/store/useStore.ts:934](src/store/useStore.ts)) calls `db.fetchStores()`, `db.fetchAllForStore(sid)`, etc.
3. Every one of those `db.*` calls is wrapped by `track()` → the bar lights up.

**No leakage** — realtime-driven reloads land in `db.ts` like every other fetch. The A1 default ("YES — light the bar") is satisfied for free.

**A1 opt-out flag (optional, future-proofing):** the spec mentions an opt-out for realtime-induced reloads. The cleanest place for this in v1 is **not the wrapper** — adding a `silent` flag to every `track()` call would require threading the opt-out from `useRealtimeSync` → `handleSync` → `loadFromSupabase` → every fan-out child → `track()`. That's noisy.

**Recommendation:** ship A1 as-is (always-on), and revisit only if user feedback complains about visual noise. If the opt-out becomes necessary, the right shape is an optional second argument on the action (`loadFromSupabase(sid, { silent: true })`) which threads a per-call-frame `silent` boolean to the wrapper — but that is a follow-up spec, not v1.

### 8. Edge cases the developer must handle

**Route change while a call is in flight:** the wrapper's `.finally()` decrements regardless of whether the React tree is still mounted. No counter leak — the cleanup is in vanilla JS promise chain, not in a React effect. **No special action needed.**

**Timers cleared on abort:** `track()` does `clearTimeout(warnTimer); clearTimeout(abortTimer);` in `.finally()`. If the hard-abort fires first, the warn timer was already fired (warnFired === true) and the slow-count decrement runs. If the user navigates away and the fetch is left in flight, the timers continue counting until they fire or the call resolves — they are leaked in the sense of "still scheduled" but harmless because the final cleanup happens in `.finally()`. **No special action needed.**

**Component unmount while skeleton is showing:** the section's `isFirstLoad` recomputes from store state. If the section unmounts, the skeleton unmounts with it. If `loadFromSupabase` resolves while the section is unmounted, the next mount of that section sees `storeLoading: false` and `slice.length > 0` (or > 0 if the fetch returned rows) and renders real content directly — no skeleton flash. **No special action needed.**

**Soft-warning state across the 5s→30s boundary:** addressed in §1. `hasSlow` stays true for the duration of the slow window; no special handoff between the timers.

**Concurrent slow calls:** if call A goes slow at t=5s and call B goes slow at t=8s, `_slowCount` is 2 and `hasSlow` is true. When A resolves at t=12s, `_slowCount` drops to 1 and `hasSlow` stays true. When B resolves at t=15s, `_slowCount` drops to 0 and `hasSlow` flips false. Correct.

**Edge function calls in `db.ts` (`fetchBreadbotSales`):** wrap normally per §3. The spec's "edge functions out of scope" line refers to *call sites outside `db.ts`* (e.g. direct `callEdgeFunction(...)` calls in `src/lib/posBreadbot.ts` or component code). `fetchBreadbotSales` is an export of `db.ts` and goes through the wrapper.

**`hasPOSImportForDate` — a `count`/`head: true` query** ([src/lib/db.ts:1175](src/lib/db.ts)): wraps normally, `kind: 'read'`. The `count` builder is a `PostgrestFilterBuilder` and accepts `.abortSignal()`.

### 9. Risks and tradeoffs

- **Risk: missed `.abortSignal()` chains.** A developer adding a new function in `db.ts` could forget to chain `.abortSignal(signal)` before `await`. The function would still work but be un-abortable. Mitigation: add a paragraph at the top of `db.ts` documenting the discipline (architect-supplied comment text follows in the developer's task). A future test could grep for `await supabase\.` without `.abortSignal` in the same statement, but that's outside this spec.
- **Risk: `track()` adds one allocation + two timers per call.** ~65 calls in `db.ts`, typical fetch latency 50-200 ms. Two `setTimeout` allocations per call × peak ~20 concurrent fetches = ~40 active timers, all `clearTimeout`'d in `.finally()`. **Performance impact is negligible.**
- **Risk: `hasSlow` blink on concurrent fast-then-slow calls.** If call A starts and finishes in 100 ms, then call B starts and takes 6 s, the bar lights at t=0, dims at t=100ms (A done), lights again at t=100ms+ε (B starts), and shifts to warn at t=100ms+5s. The 100ms gap is invisible to humans. Not a real concern.
- **Risk: A2 ambiguity for native.** Surfaced above in §4. Architect's recommendation: ship web-only and surface the question. The frontend developer should not invent a native top bar without PM input.
- **Risk: write timeout copy is scary.** The "may or may not have been saved" copy is intentional per A6, but it may confuse users in normal operation. Mitigation: the 30 s threshold is well above typical write latency (~200-500 ms), so users only see this when something is actually wrong. The frontend developer should resist the temptation to soften the copy — A6 explicitly mandates it.
- **No migration / RLS / publication risk.** This is a client-only change.

### 10. Files the frontend developer will touch

Architect's expectation (developer may diverge if a cleaner factoring presents itself):

- **NEW**: `src/lib/inflight.ts` — the counter store + `track()` + `InflightTimeoutError`.
- **NEW**: `src/components/cmd/LoadingBar.tsx` — the top-bar component.
- **NEW**: `src/components/cmd/ListSkeleton.tsx` — skeleton primitive.
- **NEW**: `src/components/cmd/GridSkeleton.tsx` — skeleton primitive.
- **MODIFIED**: `src/lib/db.ts` — every supabase-touching export wrapped via `track()`. Signatures unchanged.
- **MODIFIED**: `src/components/cmd/TitleBar.tsx` — mount `<LoadingBar />` at the top edge.
- **MODIFIED**: `src/theme/colors.ts` — add `loadingBar` / `loadingBarSlow` tokens to `LightCmd` and `DarkCmd`.
- **MODIFIED**: ~10 section files in `src/screens/cmd/sections/` per the cheat-sheet in §5.
- **NEW**: jest unit tests per spec line 103 (`__tests__/inflight.test.ts` or co-located).

No migrations. No edge functions. No RLS. No `useStore.ts` action signature changes.

## Handoff

next_agent: frontend-developer
prompt: Implement against the design in this spec. Read the Backend
  design section end-to-end before coding — §2 (db.ts wrapper signature),
  §3 (AbortController plumbing through supabase-js's `.abortSignal()`),
  and §6 (InflightTimeoutError composing with the existing notifyBackendError
  toast) are the load-bearing contracts. Note §4's A2-ambiguity callout
  about native — ship web-only and flag it in the PR description; do
  not invent a native top bar without PM input. After implementation,
  set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/055-global-loading-indicator.md

## Implementation notes (frontend-developer)

Web-only scope confirmed per spec §4 / A2. The `LoadingBar` component bails
on `Platform.OS !== 'web'`, matching the existing `TitleBar.tsx` posture.
**Native does NOT render the top progress bar in v1** — the native chrome
has no `TitleBar` host today, and the architect flagged inventing one as
out of scope. A future spec can mount the `LoadingBar` inside a native
chrome host once one exists; the component is platform-agnostic.

A1 (realtime opt-out) is NOT implemented — the bar lights up on
`useRealtimeSync`-driven reloads too. Per the architect's recommendation,
that opt-out is a follow-up if user feedback complains about visual
noise.

`.abortSignal()` ordering: supabase-js exposes `.abortSignal()` on
`PostgrestTransformBuilder`, but `.single()` / `.maybeSingle()` returns
the terminal `PostgrestBuilder` which no longer has the method. Every
chain in `db.ts` puts `.abortSignal(signal)` BEFORE `.single()` /
`.maybeSingle()`. A discipline comment at the top of `db.ts` documents
this for future maintainers.

`translateOnSave` is intentionally NOT wrapped in `track()`. It's an
edge-function call that already threads a caller-provided `signal` into
fetch (Spec 040 P3b debounce-cancel contract). Wrapping it would either
need to fork the signal or use a Promise.race shim, both of which break
the verbatim-pass test contract. The form's 600ms debounce already
protects against runaway translate calls. This decision matches spec line
64 (edge-function calls excluded from the global counter in v1).

`fetchBreadbotSales` IS wrapped (per architect §3) — it's also an
edge-function call, but it has no caller-provided signal contract and
the wrapper's signal threads cleanly through `FunctionInvokeOptions`.

Browser verification limitation: the available tool surface in this run
did not include the `preview_*` tools. Verification was done via
`npx expo export --platform web` (web build succeeds) and a live dev
server boot check (HTTP 200, 11.8MB bundle compiled cleanly, all five
new identifiers present in the bundle). The user / a reviewer with
`preview_*` access should still exercise the bar in the browser per
Spec 055's "verify in browser" rule — manual repro steps:

  1. `npm run dev:db` to ensure local Supabase is up.
  2. `npx expo start --web` and open http://localhost:8081.
  3. Log in (admin@local.test / password).
  4. Watch the top edge of the title bar — a thin green stripe should
     light up briefly during the initial load + on every section switch
     that triggers a fresh fetch.
  5. To exercise the 5s soft-warning, throttle the network in DevTools
     to "Slow 3G" and reload; the stripe should shift to amber after
     5 seconds.
  6. To exercise the 30s hard-abort, set the throttle to "Offline" or
     temporarily lower `HARD_ABORT_MS` to 3000ms in `src/lib/inflight.ts`
     and trigger any fetch — a toast should fire with the read-vs-write
     copy depending on the action.

## Files changed

### First pass (initial implementation)

New files:

- `src/lib/inflight.ts` — standalone Zustand counter store, `track()`
  wrapper, `InflightTimeoutError`, `selectHasInflight` / `selectHasSlow`.
- `src/lib/inflight.test.ts` — 13 jest tests covering counter math,
  timer lifecycle, abort copy, and the typed error.
- `src/components/cmd/LoadingBar.tsx` — web-only animated indeterminate
  stripe component (subscribes to the inflight store via two selectors).
- `src/components/cmd/LoadingBar.test.tsx` — smoke test for the
  visible/hidden boolean flip.
- `src/components/cmd/ListSkeleton.tsx` — first-mount placeholder for
  Pattern B list sections.
- `src/components/cmd/GridSkeleton.tsx` — first-mount placeholder for
  Dashboard / Reports tile grids.

Modified files:

- `src/lib/db.ts` — every supabase-touching export wrapped via
  `useInflight.getState().track(async (signal) => { ... }, { kind, label })`.
  `translateOnSave` intentionally kept unwrapped (see implementation
  notes above).
- `src/components/cmd/TitleBar.tsx` — mounts `<LoadingBar />` as an
  absolute-positioned overlay at the top edge.
- `src/theme/colors.ts` — added `loadingBar` / `loadingBarSlow` tokens
  to both `LightCmd` and `DarkCmd`.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — Inventory per-store
  branch renders `<ListSkeleton rows={10} />` on first mount when the
  slice is empty.
- `src/screens/cmd/sections/VendorsSection.tsx` — list skeleton (6 rows).
- `src/screens/cmd/sections/RecipesSection.tsx` — list skeleton (8 rows).
- `src/screens/cmd/sections/PrepRecipesSection.tsx` — list skeleton (6 rows).
- `src/screens/cmd/sections/WasteLogSection.tsx` — list skeleton (6 rows).
- `src/screens/cmd/sections/AuditLogSection.tsx` — list skeleton (8 rows).
- `src/screens/cmd/sections/EODCountSection.tsx` — list skeleton (4 rows).
- `src/screens/cmd/sections/POSImportsSection.tsx` — list skeleton (4 rows).
- `src/screens/cmd/sections/DashboardSection.tsx` — grid skeleton (2x3).
- `src/screens/cmd/sections/ReportsSection.tsx` — grid skeleton (2x3).

### Second pass (FIXES_NEEDED → READY_FOR_REVIEW)

Addresses the three Criticals + two Should-fix + selected Nits from the
release-coordinator proposal at `specs/055/reviews/release-proposal.md`.

New files:

- `src/components/cmd/skeletonUtils.ts` — shared `ensureSkeletonShimmer()`
  helper + `SKELETON_KEYFRAME` constant. Extracts the duplicated keyframes
  injection from ListSkeleton + GridSkeleton into a single DOM `<style>`
  tag (CR Should-fix; removes ~200 bytes of duplicate DOM).
- `src/components/cmd/TitleBar.test.tsx` — TitleBar integration smoke
  asserting `<LoadingBar />` mounts inside the chrome under the three
  inflight states (idle / inflight / slow). Closes TE SF-2.

Modified files:

- `src/components/cmd/LoadingBar.test.tsx` — Critical 2 fix. Replaced
  the `jest.mock('../../lib/supabase', ...)` block (which the project's
  `tests/README.md` Hybrid mocking strategy explicitly forbids) with a
  `jest.mock('../../theme/colors', ...)` block per the StatusPill.test.tsx
  reference example. Added two new color-shift assertions for the
  `hasSlow: true` warn-token branch (TE SF-1, AC7/AC13 functional half).
- `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx` —
  Critical 1 fix. Added `storeLoading: false` to the mocked store
  snapshot, then added a new `describe` block with three tests:
  AC8 positive (skeleton renders when storeLoading=true + empty slice),
  AC9 negative (skeleton suppressed on background refresh when slice
  has rows), and a sanity check (skeleton suppressed when
  storeLoading=false even on empty slice).
- `src/lib/inflight.ts` — CR Should-fix: removed the dead
  `ctrl.signal.aborted` guard (signal is freshly constructed on the line
  above; the guard was unreachable). Removed two redundant
  `(ctrl as AbortController)` casts (ctrl is already typed). Removed the
  trailing comma in the `<T,>` generic (CR Nit — `.ts` file, not `.tsx`,
  so JSX-disambiguation comma is unnecessary).
- `src/lib/inflight.test.ts` — TE N-1: silenced the dev-only
  `console.warn` from the abort tests via `jest.spyOn(console, 'warn')`
  in the hard-abort describe block. Also added the CR Nit comment
  clarifying that `signal` is intentionally ignored in the counter
  lifecycle test.
- `src/lib/db.ts` — CR Nit: fixed the misleading top-of-file comment
  about `.abortSignal()` chain ordering. Was "can come last in the chain,
  even after `.single()`"; now correctly says "must come BEFORE
  `.single()` / `.maybeSingle()`" — matches the spec implementation note
  and the actual code in every wrapped function.
- `src/components/cmd/ListSkeleton.tsx` — switched to the shared
  `ensureSkeletonShimmer()` helper + `SKELETON_KEYFRAME` constant from
  `skeletonUtils.ts`. Removed the duplicate module-scoped
  `ensureShimmer()` + `SHIMMER_KEYFRAME` definitions.
- `src/components/cmd/GridSkeleton.tsx` — same switch to the shared
  helper. Both skeletons now produce a single DOM `<style>` tag with the
  same keyframe name (`imrSkeletonPulse`).

### Second-pass verification

- `npm test` → 21 suites, 212 tests passing (was 204 → 212, +8 new tests).
- `npm run typecheck` → clean.
- `npm run typecheck:test` → clean.
- Local dev server (`npx expo start --web --port 8081`) returns HTTP 200,
  bundle compiles cleanly at 11.8 MB, and a grep for the new identifiers
  (`ensureSkeletonShimmer`, `imrSkeletonPulse`, `InflightTimeoutError`,
  `loadingBarSlow`, `accessibilityLabel: "Loading"`) confirms they are
  bundled.
- **Browser verification limitation (carried forward from the first
  pass).** The `preview_*` MCP toolkit the spec dispatch referenced is
  not available in this run's tool surface (only `Read`, `Write`, `Edit`,
  `Bash` are exposed). I cannot interactively force a >100ms inflight
  window via `preview_inspect` on `[aria-label="Loading"]`. The bundle
  contains the component, the typed error, the color tokens, and the
  shared shimmer helper; the jest suite asserts the visibility flip,
  color-shift flip, integration into TitleBar, and the first-mount
  skeleton predicate. The bar's *animated motion* (CSS keyframes sweep)
  and dark/light visual fidelity remain a manual browser-verify gap —
  same gap the first pass documented, not a new regression. A reviewer
  with `preview_*` access can exercise the bar via the repro steps the
  first-pass developer noted (lines 572-587 above).
