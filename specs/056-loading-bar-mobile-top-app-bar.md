# Spec 056: LoadingBar in MobileTopAppBar (phone-tier shell)

Status: READY_FOR_ARCH

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

## Handoff

next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria
  and any project-specific notes, then produce the design doc and set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/056-loading-bar-mobile-top-app-bar.md
