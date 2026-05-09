# Release proposal — Spec 011

## Verdict

SHIP_READY (after applying the cleanup bundle below pre-commit, per the
established Specs 003 / 006 / 007 / 008 / 009 / 010 session pattern of
"apply small Should-fix bundle inline, then commit + push").

## Reviewer roll-up

| Reviewer            | Critical | Should-fix | Notes / Nits | Output file                                                  |
|---------------------|----------|------------|--------------|--------------------------------------------------------------|
| code-reviewer       | 0        | 3          | 7            | `specs/011-responsive-admin-ui/reviews/code-reviewer.md`     |
| security-auditor    | 0        | 0          | 11           | `specs/011-responsive-admin-ui/reviews/security-auditor.md`  |
| test-engineer       | 0        | 0 (BLOCK)  | 2 cleanup    | `specs/011-responsive-admin-ui/reviews/test-engineer.md`     |
| probe-walk (§6)     | 0        | 0          | 1 (resolved) | `specs/011-responsive-admin-ui/reviews/probe-walk.md`        |
| backend-architect   | n/a      | n/a        | n/a          | (intentionally absent — see Justification)                   |

Acceptance criteria: **11 PASS / 0 FAIL / 0 NOT TESTED**. All 6 probe widths
PASS. Zero Critical findings across all reviewers. The probe-walk's
mobile-drawer auto-close concern was resolved by test-engineer as a
synthetic-click artifact, not a real regression.

## Cleanup bundle (apply pre-commit; ordered by severity, highest first)

These are all Should-fix or behavioral-correctness items the user typically
folds into the commit before pushing.

1. **`src/screens/cmd/ResponsiveCmdShell.tsx:221-225` and `:257-261`** —
   Replace direct `window.confirm(...)` calls in the two sign-out buttons
   (`sidebarFooterLeft` and `railFooter`) with a `confirmAction(...)`
   delegation. CLAUDE.md flags direct `window.confirm` as a convention
   violation, and the current `typeof window.confirm === 'function'` guard
   silently falls back to "always confirm" on native (signing the user out
   with no prompt). Highest severity in this bundle because it changes user
   behavior on a destructive (auth-state) action on native.

2. **`src/screens/cmd/ResponsiveCmdShell.tsx:331-333`** — Replace the
   `useBreakpoint()` + raw string-equality derivation of `isPhone` /
   `isTablet` / `isDesktop` with the `useIsPhone()` / `useIsTablet()` /
   `useIsDesktop()` selectors that this same spec just introduced in
   §1. Every other call site in the diff already uses the typed selectors;
   the shell should not be the lone exception that introduced them.

3. **`src/lib/cmdSelectors.ts:1070-1077`** — Either delete the unused
   `useRenderedSidebarGroups()` export (preferred — the shell can't use it
   because it must attach the DBInspector `onPress` before the override
   merge) OR add a JSDoc warning that future callers must use
   `useDefaultSidebarGroups` + manual `applySidebarOverride` per the shell
   pattern. Dead-export trap, will mislead future devs.

4. **`src/screens/cmd/ResponsiveCmdShell.tsx:111-116`** — Add
   `setMobileDrawerOpen(false);` before `nav.navigate('DBInspector')` in
   the DBInspector item's custom `onPress`. Not observable on web (the nav
   push unmounts the shell), but pre-emptively fixes a one-frame flicker
   for Phase 3 native. Cheap to fix while the code is fresh.

5. **`src/components/cmd/ResponsiveSheet.tsx:117`** — Change
   `useNativeDriver: true` to `useNativeDriver: Platform.OS !== 'web'` to
   silence the runtime warning observed in every probe ("Animated:
   useNativeDriver is not supported because the native animated module is
   missing"). Keeps the native-driver win for Phase 3 iOS/Android.
   Architect §7 risk #3 explicitly anticipated this.

6. **`src/screens/cmd/ComingSoonScreen.tsx:1-7`** — Update the orphan
   header reference from `§5` to `§4.B` for consistency with the other two
   orphan files (`InventoryListScreen.tsx` / `ItemDetailScreen.tsx`).
   Trivial doc-only fix.

(Remaining 5 nits in code-reviewer — `useNavigation<any>`, inline-JSX font
size literals, `tabletCollapsed` mount-effect double-write, `sheetStyle:
any` widening, `RailSidebar` SidebarGroup duplicate-type import — are
non-blocking and consistent with surrounding pre-Spec-011 code; carry
forward as part of a future type-cleanup spec.)

## Justification

Zero reviewers flagged a Critical, all 11 Phase 1 acceptance criteria PASS,
and the only behavioral question raised by the probe walk
(mobile-drawer auto-close) was resolved by test-engineer through static
analysis of the call chain as a probe-driver artifact, not a code defect.
The absence of a `backend-architect` post-impl review is correct: this
spec is pure frontend chrome with no backend / DB / edge / RLS / schema /
RPC changes (security-auditor explicitly confirmed `package.json` is
unmodified and no new endpoints were touched), so the architect-drift gate
does not apply. The cleanup bundle is small enough (2 sign-out call sites,
1 selector swap, 1 dead export, 1 pre-emptive close, 1 platform flag, 1
doc fix) to fold into the same commit per the established Specs 003 / 006
/ 007 / 008 / 009 / 010 session pattern.

## Out-of-scope follow-ups

These were surfaced by reviewers and explicitly belong in a separate spec,
not this commit:

- **Per-section responsive bodies** for the 14+ sections (Phase 2+ work
  per spec §"Phasing"). Probe 4 at 768 px observed `PROPERTIES.JSON`
  bleeding into `STOCK_HISTORY.DAT` in the 3-pane Inventory body — this
  is allowed by Phase 1 spec language and is the next phase's work.
- **Test framework adoption.** Third consecutive spec (009 / 010 / 011)
  flagging the same gap: no jest / vitest / Playwright config exists.
  User has consistently chosen to defer; Playwright visual-regression
  for responsive widths is the obvious pick when prioritized.
- **Type-cleanup pass on `SidebarGroup` duplicate-type imports**
  (`RailSidebar.tsx:6` vs `sidebarLayout.SidebarGroup`) and the broader
  `useNavigation<any>` migration to typed param lists. Pre-Spec-011 quirk
  with three consumers now; worth a dedicated cleanup spec.
- **Token-unification pass** for stray font-size literals (`9.5`, `10`,
  `13`) in inline palette-results JSX — they don't exist in the
  `FontSize` token set yet.
- **`InventoryListScreen.tsx` / `ItemDetailScreen.tsx` orphan revival
  hazard** for Phase 3 native — the orphans still compare against
  `'desktop'` and would silently drop the new `'tablet'` width if
  resurrected. The orphan header comments should note this if/when Phase
  3 EAS shipping picks them back up.
