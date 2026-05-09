# Code reviewer findings — Spec 011

## Critical

None.

## Should-fix

- `src/screens/cmd/ResponsiveCmdShell.tsx:221-225` and `:257-261` — `window.confirm` called
  directly in two places (the `sidebarFooterLeft` sign-out button and the `railFooter` sign-out
  button) instead of `src/utils/confirmAction.ts`. CLAUDE.md explicitly flags direct
  `window.confirm` as a project convention violation. The sign-out confirm is not a destructive
  data action (no record deletion), so the single-string variant
  `confirmAction('Sign out?', '', logout)` would work if the utility is adapted, or the existing
  two-arg `window.confirm` form should at minimum be delegated to `confirmAction` to stay
  cross-platform. On native the current code silently falls back to `true` (always-confirm)
  because the `typeof window.confirm === 'function'` guard evaluates to false — meaning
  native users are signed out immediately with no prompt.

- `src/screens/cmd/ResponsiveCmdShell.tsx:331-333` — the three breakpoint booleans
  (`isPhone`, `isTablet`, `isDesktop`) are derived by raw string comparison against `useBreakpoint()`
  return value, rather than using the `useIsPhone()` / `useIsTablet()` / `useIsDesktop()`
  convenience selectors that were introduced by this same spec (§1) for exactly this purpose.
  Using the raw selectors internally in the file that controls the breakpoint branch is an
  inconsistency: every other call site in this diff (`IngredientFormDrawer`, `VendorFormDrawer`,
  `MobileTopAppBar`) calls the typed selectors. Fix: replace `useBreakpoint()` +
  manual string comparison in `ResponsiveCmdShell` with `useIsPhone()` / `useIsTablet()` /
  `useIsDesktop()`.

- `src/lib/cmdSelectors.ts:1070-1077` — `useRenderedSidebarGroups()` is exported but never
  imported anywhere in the codebase. The shell (`ResponsiveCmdShell`) cannot use it because it
  must attach the DBInspector `onPress` before the override merge, so it reimplements the same
  `applySidebarOverride` call inline. This leaves `useRenderedSidebarGroups` as a dead export
  that misrepresents the actual usage pattern and may mislead future developers into calling it
  (skipping the nav-attachment step). Either (a) delete the hook and leave only
  `useDefaultSidebarGroups`, or (b) add a JSDoc comment to `useRenderedSidebarGroups` that
  explicitly flags "consumers that need to attach nav onPress to the DBInspector row must call
  `useDefaultSidebarGroups` + attach + then `applySidebarOverride` — see `ResponsiveCmdShell`."

## Nits

- `src/screens/cmd/ResponsiveCmdShell.tsx:68` — `nav` is typed `useNavigation<any>()`. This
  is the established pre-Spec-011 pattern in this codebase, so it is not new, but the shell is
  new code where a typed param list for `DBInspector` would be cheap to add (the route takes no
  params). Not a blocking issue; deferring to architect's preference.

- `src/screens/cmd/ResponsiveCmdShell.tsx:282-328` — the inline palette-results `JSX` block
  inside `useMemo` is 46 lines of UI that embeds font-size (`9.5`, `13`, `10`) and color
  literals (`C.fg3`, `C.fg`) already expressed via existing type tokens. Not wrong — it matches
  the existing `MobileNavDrawer` inline style density — but the font-sizes `9.5` and `10` are
  not in the `FontSize` token set and are hardcoded numbers. Consistent with surrounding code;
  flag for future token-unification pass.

- `src/screens/cmd/ResponsiveCmdShell.tsx:93-96` — `tabletCollapsed` is initialized via a
  lazy initializer function `() => readTabletCollapsed()`. The effect that writes back on every
  change fires on the very first render too (since `tabletCollapsed` just changed from
  "uninitialized" to the initial value). This causes a redundant `localStorage.setItem` on mount
  equal to the value we just read. Not a bug (idempotent), but slightly wasteful. A simple fix:
  initialize with `readTabletCollapsed()` directly in `useState` (lazy initializer is correct for
  this) and add an `isFirstRender` ref guard in the effect, or use `useLayoutEffect`'s
  skip-on-mount pattern. Low priority.

- `src/components/cmd/ResponsiveSheet.tsx:127` — `sheetStyle: any` typed as `any` to
  accommodate the conditional `boxShadow` web-only spread. The web-gated `boxShadow` cast
  (`as any`) is the established idiom in this file and matches the pre-Spec-011 drawers. The
  outer `any` on `sheetStyle` is broader than necessary — `ViewStyle` from `react-native` would
  cover the base, with just the spread needing `as any`. Minor; not a behavior risk.

- `src/screens/cmd/InventoryListScreen.tsx:45` — orphaned file still calls `useBreakpoint()`
  and compares against `'desktop'` (the pre-Spec-011 binary). Now that the union is
  `'phone' | 'tablet' | 'desktop'`, the comparison `breakpoint === 'desktop'` is still valid
  (TypeScript will accept it), but the `'mobile'` string it previously compared against is gone.
  Since the file is orphaned this is not a runtime risk, but if it is ever resurrected for Phase 3
  native work, the call at line 45 and line 91 (`breakpoint === 'desktop'`) will silently drop
  the tablet-width case. The orphan comment should note this stale breakpoint usage so Phase 3
  authors don't miss it.

- `src/screens/cmd/ComingSoonScreen.tsx:1-7` — orphan header comment references
  `specs/011-responsive-admin-ui.md §5` which is the architect's §5 (Files to create/modify),
  not a section specifically about `ComingSoonScreen`. `InventoryListScreen.tsx` and
  `ItemDetailScreen.tsx` reference `§4.B`, which is the correct architect decision section.
  Minor inconsistency; update to reference `§4.B` for consistency across orphaned files.

- `src/components/cmd/RailSidebar.tsx:6` — imports `SidebarGroup` from `./Sidebar` (the
  component-local type) while `ResponsiveCmdShell` passes groups typed against
  `sidebarLayout.SidebarGroup`. The build notes acknowledge the dual-type situation as a
  pre-Spec-011 quirk. This nit surfaces only because the new `RailSidebar` adds a third
  consumer of `SidebarGroup`. Out-of-scope to fix here, but worth a note for the type-cleanup
  spec.

- `src/lib/cmdSelectors.ts:1024` — `useDefaultSidebarGroups()` calls `useMemo` with an
  empty dependency array `[]`. This is correct (the structure is static), but the hook shape
  could be a plain module-level `const` instead of a hook if it truly has no reactive deps.
  Keeping it as a hook is fine (future deps could appear), and the name signals it is a hook,
  so this is purely a preference nit.
