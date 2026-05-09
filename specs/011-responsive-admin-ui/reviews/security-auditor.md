# Security auditor findings — Spec 011

Scope: pure frontend chrome/plumbing. No backend, DB, edge function, RLS, schema, or auth-flow changes were made or were in scope. `package.json` is unchanged (`git status` confirms), so `npm audit` was skipped per the spec instructions.

Files reviewed (full read):
- `src/theme/breakpoints.ts`
- `src/lib/cmdSelectors.ts` (new `useDefaultSidebarGroups` / `useRenderedSidebarGroups` selectors only — pre-existing functions out of scope)
- `src/screens/cmd/ResponsiveCmdShell.tsx`
- `src/components/cmd/ResponsiveSheet.tsx`
- `src/components/cmd/MobileTopAppBar.tsx`
- `src/components/cmd/RailSidebar.tsx`
- `src/components/cmd/IngredientFormDrawer.tsx`
- `src/components/cmd/VendorFormDrawer.tsx`
- `src/components/cmd/MobileNavDrawer.tsx` (consumer of the new shell — re-checked since the shell wires it up differently than the deleted `NavDrawerScreen` did)
- `src/screens/cmd/InventoryDesktopLayout.tsx` (the props-refactor hot path; spot-checked for prop-drilling auth bypass)
- `src/screens/cmd/InventoryListScreen.tsx`, `ItemDetailScreen.tsx`, `ComingSoonScreen.tsx` (orphans)
- `src/navigation/CmdNavigator.tsx`
- Adjacent context: `src/lib/paletteAction.ts`, `src/lib/sidebarLayout.ts`, `src/lib/auth.ts:80-101`, `src/lib/db.ts:988-1009`, `src/store/useStore.ts:1215-1245`

## Critical (BLOCKING)

(none)

## Warnings

(none)

## Notes

- **`localStorage` tablet-collapsed key is safe.** `src/screens/cmd/ResponsiveCmdShell.tsx:40` uses the namespaced key `imr.cmd.sidebar.tabletCollapsed` and stores `'1' | '0'`. The read at line 47 uses strict equality (`=== '1'`) so any tampered value falls through to `false` (expanded sidebar). Read/write are wrapped in `try/catch` for private-browsing mode and gated on `Platform.OS === 'web'`. No privilege boundary, no parsing surface — purely a UI pref. No finding.

- **`useSafeAreaInsets()` data flow is fully library-controlled.** `src/components/cmd/ResponsiveSheet.tsx:94` and `src/components/cmd/MobileTopAppBar.tsx:32` consume `useSafeAreaInsets()` from `react-native-safe-area-context`. The values are numeric paddings sourced from the platform; nothing user-controlled flows in. No finding.

- **No `dangerouslySetInnerHTML` or HTML-injection sinks in any touched file.** Grep across `src/components/cmd`, `src/screens/cmd`, `src/navigation`, `src/theme`, `src/lib` returned zero hits. RN `<Text>` is XSS-safe by default; user-supplied strings (`item.name`, `vendor.name`, `currentUser.email`, `currentStore.name`, palette query, etc.) all flow through `<Text>` only. The new `MobileTopAppBar` title comes from `section` (a known sidebar id like `'Inventory'`), the `RailSidebar` glyph is a single uppercase letter derived from the label via `replace(/[^A-Za-z]/g, '').charAt(0)` — no injection vector. No finding.

- **`useBreakpoint()` is SSR-safe enough for Vercel.** `src/theme/breakpoints.ts:27` uses `useWindowDimensions()` from RN, which on RNW reads `window.innerWidth` only after mount. Vercel deploys this as a client-side SPA via `npx expo export --platform web` (no SSR), so window-touching is fine. The `Platform.OS !== 'web'` early-return at line 29 also gates native/native-rendering paths. The two direct `window.*` usages added by Spec 011 (`ResponsiveCmdShell.tsx:47, 56`) are guarded by `Platform.OS !== 'web'` and `typeof window !== 'undefined'`. No finding.

- **`CmdPaletteHost` simplification does not expose any new admin-only navigation.** `src/navigation/CmdNavigator.tsx:92-133` always renders the palette via `Platform.OS === 'web'` early-return at line 123 (unchanged), and the `actionForRoute` mapper (line 109) only writes `paletteAction` — it can't navigate to a route the user couldn't already reach via the sidebar. The palette index itself (`useCommandPaletteIndex` in `src/lib/cmdSelectors.ts:245`) is built from store data the user already sees (`inventory`, `recipes`, `prepRecipes`, `vendors`, `auditLog`) — Supabase RLS / `auth_can_see_store()` already gates that store-side. The `useRole` placeholder is irrelevant here since this is admin-only by design (CLAUDE.md "Role hook is a placeholder"). No finding.

- **Lifted `useDefaultSidebarGroups` / `useRenderedSidebarGroups` correctly read the authenticated user's own override.** `src/lib/cmdSelectors.ts:1070-1077` consumes `useStore((s) => s.sidebarLayoutOverride)`, which is hydrated at login from `profiles.sidebar_layout` for the current `userId` (`src/lib/auth.ts:99`, `src/store/useStore.ts:231`). Mutations go through `db.saveSidebarLayout(userId, …)` (`src/lib/db.ts:1000-1009`), which writes `.eq('id', userId)` against the existing "Users can update own profile" RLS policy. There's no cross-user override read path — the lifted selector closed over no other user's id, and the shell at `ResponsiveCmdShell.tsx:78` reads from the same store slice. The selector is also defensively fed through `applySidebarOverride` which has `isValidOverride` shape-guarding upstream in auth.ts. No authorization issue.

- **Orphaned screens are dead code.** `grep -rn` for `InventoryListScreen|ItemDetailScreen|ComingSoonScreen|NavDrawerScreen|MobileStack` across `src/` returns only the orphans' own `export default function` declarations — no import, `<Component />`, or `Stack.Screen name=` reference anywhere. `NavDrawerScreen` is removed from disk. The orphans contain no top-level `useEffect`s outside of their default-exported components, and React Navigation does not mount components that aren't registered as a route. `useStockSeries` / `useRecipesUsingItem` / `useStore.subscribe` only fire when their hosting component renders; nothing renders these. No live realtime subscription, no live fetch, no live mutation can leak from these files. No finding.

- **`paletteAction` Zustand store has no auth-bound payload.** `src/lib/paletteAction.ts:10-29` carries `{ section, selectedName, eodFocusItemId? }` only — all of which are non-secret routing hints already implied by what the user can see. Consumed by the body (`InventoryDesktopLayout`) and the shell (`ResponsiveCmdShell:195-199`). No PII written, no secret. No finding.

- **No tokens, secrets, or PII in any new file's `console.*` calls.** Grep across all new/modified Spec 011 files returned zero `console.*` invocations. Existing project-wide `notifyBackendError` paths are untouched. No finding.

- **No new dependencies introduced.** `git status` shows `package.json` and `package-lock.json` unmodified — `@gorhom/bottom-sheet` was correctly rejected per architect §3 / §7. Skipped `npm audit` per the spec instructions ("no package.json changes — skipped").

- **Pre-existing `useRole.ts` admin-everyone placeholder — not introduced or touched by this spec.** Per CLAUDE.md "Role hook is a placeholder", this is intentional and out of scope. The new shell does not consult `useRole()`. No new client-side authorization-as-security boundary was introduced.
