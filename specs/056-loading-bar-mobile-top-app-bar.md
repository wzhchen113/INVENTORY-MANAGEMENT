# Spec 056: LoadingBar in MobileTopAppBar (phone-tier shell)

Status: READY_FOR_REVIEW

## User story

As an admin using the Cmd UI on a phone-shaped browser window (e.g. a tablet
held vertically or a phone in landscape), I want to see the same in-flight
indicator that desktop users see, so I can tell loading apart from stuck.

## Acceptance criteria

- [ ] When `useInflight.hasInflight` is `true`, a 2px `<LoadingBar />`
      renders at the top edge of `MobileTopAppBar` on web, anchored to the
      bar's outer wrapper.
- [ ] When `hasInflight` is `false`, no bar element is in the DOM (matches
      spec 055 unmount behavior).
- [ ] Color shifts from green to amber at the 5-second `hasSlow` threshold,
      identical to the TitleBar implementation (default — see open question).
- [ ] On native (`Platform.OS !== 'web'`), the bar does not render —
      `LoadingBar` already bails on non-web platforms per spec 055 A2.
- [ ] No visible layout shift in the existing 44px MobileTopAppBar row —
      the bar overlays via `position: 'absolute'` and does not push the
      hamburger/title/trailing slot.
- [ ] Existing TitleBar (tablet/desktop tier) behavior is unchanged — no
      regression in `LoadingBar.test.tsx` or `TitleBar.test.tsx`.
- [ ] Jest renders `MobileTopAppBar` with `useInflight.setState({ hasInflight: true })`
      and asserts the `[aria-label="Loading"]` / `role="progressbar"` element
      is present.

## In scope

- One `<LoadingBar />` mount inside `src/components/cmd/MobileTopAppBar.tsx`.
- A `position: 'relative'` on the outer wrapper of `MobileTopAppBar` if
  not already present (current outer `View` has `paddingTop` + background +
  border but no `position` — confirm during build).
- One jest smoke test asserting the indicator renders when inflight is
  active.

## Out of scope (explicitly)

- Native chrome — spec 055 A2 exclusion still holds; `LoadingBar` itself
  bails on non-web, so no behavior change on native.
- Tablet-tier `RailSidebar` — that tier uses `TitleBar`, which already
  mounts `LoadingBar` per spec 055.
- Skeleton mounting on phone-tier sections — sections share their skeleton
  code across tiers; only the top bar differs.
- Changes to `src/lib/inflight.ts` or `src/lib/db.ts` — the inflight store
  and counter behavior are unchanged.
- Connection-status indicator on phone tier — `MobileTopAppBar` does not
  render one today, and this spec does not add one.

## Open questions resolved

- Q: Does the phone-tier shell ALSO want the soft-warning color shift
  (amber at 5s), or just the green bar? → A: Default yes, identical
  behavior to desktop. Surfaced in the spec as a build-time question
  for the architect to confirm before READY_FOR_BUILD.

## Dependencies

- Spec 055 (global loading indicator) must be merged — this spec consumes
  the existing `<LoadingBar />` component and `useInflight` store unchanged.
- No new migrations, no edge functions, no RPCs.

## Project-specific notes

- Cmd UI section / legacy: Cmd UI shell chrome. No section.
- Per-store or admin-global: N/A — pure FE indicator.
- Realtime channels touched: none.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: Web-only (native bail inherited from `LoadingBar`).
- Tests: jest track — one render assertion in a new
  `src/components/cmd/MobileTopAppBar.test.tsx` (or extend coverage if
  the architect prefers a different file).

## Backend design

This is a pure frontend mount-site change. No SQL, no RLS, no edge functions,
no realtime channels, no `src/lib/db.ts` surface change. The architect's
deliverable is the mount-site contract inside `MobileTopAppBar.tsx`, plus
the test skeleton.

### Data model changes

None. No tables, columns, indexes, migrations, RLS, or RPCs.

### RLS impact

None.

### API contract

None. `useInflight` selectors (`selectHasInflight`, `selectHasSlow`) and the
`<LoadingBar />` component itself remain byte-for-byte unchanged. No new
public surface.

### Edge function changes

None.

### `src/lib/db.ts` surface

Unchanged. The inflight wrapper introduced by spec 055 already increments
`useInflight._activeCount` around every call; the phone-tier subscriber
gets the same broadcast for free.

### Realtime impact

None. Inflight state is process-local; it does not flow through
`store-{id}` or `brand-{id}` channels. No publication membership change,
so the realtime restart gotcha does not apply to this spec.

### Frontend store impact

None on `src/store/useStore.ts` — `useInflight` is a sibling Zustand store
at `src/lib/inflight.ts` and the new mount subscribes to it via the same
two selectors `TitleBar` uses (`selectHasInflight`, `selectHasSlow`). The
optimistic-then-revert pattern is not involved here.

### Mount-site contract (the only deliverable)

**File:** `src/components/cmd/MobileTopAppBar.tsx`.

**Current outer wrapper shape** (lines 38–45, read end-to-end at design
time):

```
<View style={{
  paddingTop: topPad,            // 0 on web, insets.top on native
  backgroundColor: C.panel,
  borderBottomWidth: 1,
  borderBottomColor: C.border,
}}>
  <View style={{ height: 44, ... }}> ...row content... </View>
</View>
```

**Confirmed gap:** the outer wrapper does NOT have `position: 'relative'`.
Without a positioned ancestor, `<LoadingBar />`'s `position: 'absolute';
top: 0; left: 0; right: 0` climbs to the document body and renders at the
viewport top edge instead of the bar's top edge. This is the same anchor
that TitleBar.tsx:116 sets explicitly.

**Required change:** add `position: 'relative'` to the outer wrapper's
style object and mount `<LoadingBar />` as the FIRST child of that outer
View (before the inner 44px row). Mirror the comment placement from
TitleBar.tsx:113–122.

**Skeleton** (illustrative, NOT the implementation):

```
<View style={{
  paddingTop: topPad,
  backgroundColor: C.panel,
  borderBottomWidth: 1,
  borderBottomColor: C.border,
  position: 'relative',   // ← new — anchor for LoadingBar overlay
}}>
  <LoadingBar />           // ← new — first child, web-only via internal bail
  <View style={{ height: 44, ... }}> ...existing row... </View>
</View>
```

Web-only check is handled inside `LoadingBar` itself (it returns `null` on
`Platform.OS !== 'web'`) — no platform branching needed at this mount
site. Spec 055 A2 exclusion still holds for native.

### Visual / layout interaction

- **Status bar / safe-area clipping:** on web, `topPad` is hard-coded to
  `0` (MobileTopAppBar.tsx:35: `const topPad = Platform.OS === 'web' ? 0
  : insets.top;`). The outer wrapper's top edge therefore coincides with
  the visible bar's top edge, and the 2px LoadingBar overlay sits flush
  on the chrome. No browser status bar exists to clip it.
- **Native safe area is moot** because the LoadingBar component itself
  bails on non-web — even if the outer wrapper pads down by `insets.top`,
  the bar component returns `null` and nothing renders inside the inset
  zone. The wrapper's `paddingTop` is unaffected by adding
  `position: 'relative'`.
- **Z-order:** LoadingBar uses `zIndex: 50` and `pointerEvents: 'none'`,
  which is well below any popover the mobile shell renders (the
  `MobileNavDrawer` is a sibling further down in `ResponsiveCmdShell.tsx`
  and renders on top via React tree order). No new stacking concerns.
- **No layout shift:** `position: 'absolute'` removes the bar from flow,
  so the 44px row keeps its height. The hamburger / title / trailing
  slot positions are byte-identical to current.
- **Color contrast on mobile:** `C.loadingBar` (green) and
  `C.loadingBarSlow` (amber) read against `C.panel` — same chrome
  background as TitleBar uses. No new theme tokens needed.

### Test contract

**File:** `src/components/cmd/MobileTopAppBar.test.tsx` (new). Mirror the
shape of `src/components/cmd/TitleBar.test.tsx` (which exists and ships
with spec 055). The mock shape there is the canonical recipe:

- Force `Platform.OS = 'web'` via `jest.mock` of
  `react-native/Libraries/Utilities/Platform` (TitleBar.test.tsx:20–24).
- Mock `useCmdColors` to return the same color palette stub that
  TitleBar.test.tsx uses (lines 27–52). Critically include `loadingBar`
  and `loadingBarSlow` keys so LoadingBar resolves a real color string.
- Mock `react-native-safe-area-context`'s `useSafeAreaInsets` to return
  `{ top: 0, left: 0, right: 0, bottom: 0 }` so the wrapper's `paddingTop`
  resolves cleanly. `MobileTopAppBar` reads `insets.top` (line 32), so
  this stub is required even though web sets `topPad = 0`.
- Three tests, mirroring TitleBar.test.tsx:
  1. `hasInflight=false` → `screen.queryByLabelText('Loading')` is `null`.
  2. `hasInflight=true` → `screen.getByLabelText('Loading')` is truthy.
  3. `hasInflight=true, hasSlow=true` → still labeled `'Loading'`
     (color shift is verified inside LoadingBar.test.tsx — this test
     only proves the integration survives the slow flip).
- `beforeEach` resets `useInflight` to a clean state, same as
  TitleBar.test.tsx:107–114.
- The `MobileTopAppBar` props are simple — pass a no-op `onHamburgerPress`
  and a `title` string. No store/router mocks needed because
  MobileTopAppBar doesn't read from `useStore` or react-navigation.

### Open question A1 — amber soft-warning on phone tier

Spec 056 §"Open questions resolved" defaults to YES: phone-tier
LoadingBar follows the same green → amber transition as desktop.
Architect concurs — the slow flag is a property of the global inflight
store, not the mount site, and a divergent behavior would require either
(a) a new `LoadingBar` prop to suppress the slow color, or (b) a second
component variant. Neither is justified for a 2px chrome stripe. **No
opt-out is being added.** If the user wants phone tier to stay green,
they should override before build starts.

### Risks and tradeoffs

- **Risk: forgetting `position: 'relative'`.** The bar would render at
  the viewport top, looking correct on the homepage but drifting on
  scroll, with `MobileNavDrawer` open, or in nested layouts. The test
  contract above does NOT catch this — jsdom doesn't compute layout, so
  the `position: 'absolute'` element passes through. Mitigation: the
  build-time PR review should eyeball the wrapper style block and
  confirm the `position: 'relative'` key landed. Manual smoke in the
  preview tool at phone width (≤768px) is also worth doing.
- **Risk: native silently divergent.** LoadingBar's web-only bail means
  native phone-tier shells show nothing during inflight, identical to
  the current state. This is the documented spec 055 A2 exclusion;
  not a regression.
- **Performance:** trivial. One additional `useInflight` subscriber on
  the phone-tier render path — same two selectors that already power
  TitleBar on tablet/desktop. No new global listeners, no new effects.
- **Migration ordering:** none — pure FE, no DB.
- **Edge function cold-start:** N/A.
- **No rollback risk:** the change is additive in a single file. Reverting
  is a one-file diff.

### Frontend file list (for developer reference)

- `src/components/cmd/MobileTopAppBar.tsx` — add `position: 'relative'`
  to outer wrapper style, add `<LoadingBar />` import + first-child mount.
- `src/components/cmd/MobileTopAppBar.test.tsx` — new file, jest contract
  per "Test contract" above.

## Handoff

next_agent: frontend-developer
prompt: Implement against the design in this spec. Add LoadingBar to
  MobileTopAppBar.tsx (add `position: 'relative'` to the outer wrapper,
  mount `<LoadingBar />` as the first child), and create
  src/components/cmd/MobileTopAppBar.test.tsx mirroring TitleBar.test.tsx.
  After implementation, set Status: READY_FOR_REVIEW and list files changed
  under ## Files changed.
payload_paths:
  - specs/056-loading-bar-mobile-top-app-bar.md

## Files changed

- `src/components/cmd/MobileTopAppBar.tsx` — added `LoadingBar` import,
  added `position: 'relative'` to the outer wrapper style (with the same
  anchor-comment shape as `TitleBar.tsx:113-116`), and mounted
  `<LoadingBar />` as the first child of the outer `View` before the inner
  44px row (mirroring `TitleBar.tsx:119-122`).
- `src/components/cmd/MobileTopAppBar.test.tsx` (new) — jest smoke test
  with three cases mirroring `TitleBar.test.tsx`:
    1. `hasInflight=false` → `queryByLabelText('Loading')` is null.
    2. `hasInflight=true` → `getByLabelText('Loading')` is truthy.
    3. `hasInflight=true, hasSlow=true` → label is still present (slow
       state is a color shift only).
  Mock surface is smaller than `TitleBar.test.tsx` because
  `MobileTopAppBar` has no `useStore` / `supabase` / `useT` / `react-dom`
  deps; only `Platform`, `useCmdColors`, and `useSafeAreaInsets` are stubbed.

### Verification performed

- `npm test` — all 22 suites pass, 215 tests (3 new + 212 baseline). No
  regressions in `LoadingBar.test.tsx` or `TitleBar.test.tsx`.
- `npm run typecheck` — clean.
- `npm run typecheck:test` — clean.
- Browser preview tools (`preview_*`) are NOT available in this
  frontend-developer agent's environment (only `Bash`, `Read`, `Write`,
  `Edit` are exposed). Per the spec's `### Risks and tradeoffs` callout,
  the `position: 'relative'` key cannot be asserted in jsdom because it
  doesn't compute layout — the diff above includes the explicit
  `position: 'relative'` line on the outer wrapper (line 48), with an
  anchor comment, for eyeball verification at code review. Manual smoke
  at phone width (≤768px viewport) is recommended before ship.

### Non-changes (confirmed byte-for-byte)

Per the spec's `### API contract` and `### src/lib/db.ts surface`
sections, the following stayed untouched:

- `src/lib/inflight.ts`
- `src/lib/db.ts`
- `src/components/cmd/LoadingBar.tsx`
- `src/store/useStore.ts`
