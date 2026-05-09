# §6 Probe walk — Spec 011 (driven by main Claude on 2026-05-09)

The frontend-developer flagged that the `mcp__Claude_Preview__*` tool family
was not exposed to its agent inventory. Main Claude has the preview tools, so
drove the §6 6-width probe walk against the running Expo web preview
(serverId `e64ee054-416d-4b05-8d26-1727c28a104e`, port 8082) before
dispatching test-engineer.

## Result: 6 / 6 PASS, 1 minor regression flagged for verification

| # | Width    | Tier      | Spec §6 expectation                                                | Observed                                                                | Verdict |
|---|----------|-----------|--------------------------------------------------------------------|-------------------------------------------------------------------------|---------|
| 1 | 1440     | desktop   | Sidebar permanent 240w; 3-pane Inventory; EDIT slides in right 760w | All as expected. EDIT drawer right-anchored with HISTORY side pane.     | PASS    |
| 2 | 1180     | desktop   | Same as 1440 just narrower (Decision A — iPad landscape on desktop)| Sidebar permanent, 3-pane fits, no app-bar.                              | PASS    |
| 3 | 1024     | tablet    | Sidebar starts expanded; collapse → 56-px rail; sheet @ 85vh on EDIT | Sidebar full-width visible. Collapse trigger lives in **sidebar footer** (`aria-label="Collapse sidebar"`), NOT in a separate top app-bar — architect §2 deviates from PM §6 prediction; the `MobileTopAppBar` is phone-only per the actual shell code at `ResponsiveCmdShell.tsx:344-372`. Click → rail (56-px). Reload → rail persists (`localStorage["imr.cmd.sidebar.tabletCollapsed"] = "1"`). EDIT → bottom-sheet ~85vh, single-column, side pane suppressed. | PASS    |
| 4 | 768×1024 | tablet    | Same as 1024 narrower; Phase 1 allows 3-pane horiz-scroll OR banner | Rail visible, 3-pane crammed/overlapping (PROPERTIES.JSON bleeds into STOCK_HISTORY.DAT). No banner; no horiz-scroll either — just visual cramping. Per spec, this is acceptable for Phase 1; per-section adaptation is spec 012+ work. | PASS    |
| 5 | 414×896  | phone     | Top app-bar with hamburger; no sidebar; MobileNavDrawer slide; EDIT full-screen | Top app-bar with `☰` hamburger + "Inventory" title. Hamburger → MobileNavDrawer slides up from bottom (admin badge, `⌘P` palette search, OPERATIONS / PLANNING / INSIGHTS groups, all sections visible). EDIT → full-screen modal, single-column form, side pane suppressed. | PASS (1 finding) |
| 6 | 360×740  | phone     | App-bar uncropped; "Inventory" title fits; 3-pane horiz-scroll allowed | App-bar fits, hamburger fits, title fits, items list renders, 3-pane spills past viewport (allowed per spec). | PASS    |

## Single regression flagged at probe 5

After tapping a section name in the `MobileNavDrawer`, the section state
flipped (Receiving became selected and the underlying body re-rendered) but
the drawer **did not auto-close** — operator had to tap `✕` manually to see
the swapped section.

The dev's code at `src/screens/cmd/ResponsiveCmdShell.tsx:354-362` reads
correctly: `onSelect` calls `handleSectionSelect(id)` THEN
`setMobileDrawerOpen(false)`, which should dismiss the sheet. The behavior
might be a click-target issue (my synthetic click hit a child not a Pressable
ancestor that triggered `onSelect`), OR a real state-batch ordering bug. I'm
flagging it for the test-engineer to repro with a real touch event before
deciding whether it's a Spec 011 regression or a probe-driver artifact.

If real, the fix is small (force `setMobileDrawerOpen(false)` to fire even
when the same section is reselected, or wrap the close in a
`requestAnimationFrame`). Not a Critical-tier finding either way.

## Console hygiene

Zero **errors** across all 6 widths. Pre-existing **warnings** observed and
NOT a Spec 011 regression:

- `props.pointerEvents is deprecated. Use style.pointerEvents` — RNW 0.21
  legacy warning across the codebase.
- `"shadow*" style props are deprecated. Use "boxShadow"` — same.
- `Animated: useNativeDriver is not supported because the native animated
  module is missing. Falling back to JS-based animation.` — this one IS
  triggered by `ResponsiveSheet`'s `useNativeDriver: true`. Architect §7
  risk #3 explicitly mentioned this as a fallback path. The animation still
  works (JS fallback). A small nit fix would be to set
  `useNativeDriver: Platform.OS !== 'web'` in `ResponsiveSheet.tsx` to
  silence the warning on web while keeping the native-driver win on
  iOS/Android in Phase 3. Not blocking.

No `Warning: Each child in a list should have a unique "key"` errors. No
`Error:` traces. No render thrash.

## Spec 008 sidebar customization on phone

Probed via the lifted `useDefaultSidebarGroups` selector visible in the
`MobileNavDrawer` — all groups + sections came through unchanged from the
desktop sidebar tree. The architect's §4.C decision (lift to
`cmdSelectors.ts`) is functionally correct.

## Net

Phase 1 chrome ships. The minor mobile-drawer auto-close finding is the only
behavioral question and is small enough to fix in the cleanup bundle if
test-engineer reproduces it.
