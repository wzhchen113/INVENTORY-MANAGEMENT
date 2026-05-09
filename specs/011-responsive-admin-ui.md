# Spec 011: Responsive multi-device support for the Cmd UI admin app

Status: READY_FOR_REVIEW

**Type:** Frontend / cross-cutting UI overhaul (no backend changes)
**Filed:** 2026-05-08
**Cross-reference:** Existing partial responsive scaffolding at [src/theme/breakpoints.ts](../src/theme/breakpoints.ts), [src/navigation/CmdNavigator.tsx](../src/navigation/CmdNavigator.tsx) (`AuthedRoot` already branches on `useBreakpoint()`), [src/screens/cmd/InventoryListScreen.tsx](../src/screens/cmd/InventoryListScreen.tsx), [src/screens/cmd/ItemDetailScreen.tsx](../src/screens/cmd/ItemDetailScreen.tsx), [src/screens/cmd/NavDrawerScreen.tsx](../src/screens/cmd/NavDrawerScreen.tsx), and [src/screens/cmd/ComingSoonScreen.tsx](../src/screens/cmd/ComingSoonScreen.tsx).

## User story

As the admin/owner of the 2AM PROJECT brand, I want every section of the Cmd UI admin app to be usable on a phone, tablet, and desktop browser at the deployed Vercel URL — so I can do real admin work (check inventory, review the audit log, run a reconciliation, look at reports) from my phone in the restaurant or from a tablet in the back office without needing to find a desktop.

## Background

Today's state (probed 2026-05-08):

- [src/theme/breakpoints.ts](../src/theme/breakpoints.ts) already exports `useBreakpoint()` returning `'desktop' | 'mobile'`, with the threshold at **1100 px** (intentionally above iPad-landscape ~1180 — comment in file says iPad landscape should get the mobile/thumb-friendly layout, so the threshold was tuned for "real desktop only").
- [src/navigation/CmdNavigator.tsx:103](../src/navigation/CmdNavigator.tsx) already branches `breakpoint === 'desktop' ? <DesktopShell /> : <MobileStack />`.
- `MobileStack` currently has only **four real screens**: `InventoryListScreen`, `ItemDetailScreen`, `ComingSoonScreen`, `NavDrawerScreen` (+ `DBInspectorScreen`, which is reused as-is). Every other section in the desktop sidebar — Dashboard, EODCount, WasteLog, Receiving, PurchaseOrders, Vendors, Recipes, PrepRecipes, Restock, Reconciliation, POSImports, AuditLog, Reports, Categories, OrderSchedule — falls through to `ComingSoonScreen` ("awaiting design handoff"). So the Cmd UI is **desktop-only in practice** today; the mobile branch is a stub.
- `DesktopShell` renders [src/screens/cmd/InventoryDesktopLayout.tsx](../src/screens/cmd/InventoryDesktopLayout.tsx), which is a single `View` containing a fixed-width left `Sidebar`, a 340 px list pane, a center detail pane, and a side properties pane (3-pane shell). Each sidebar selection swaps the right side to one of ~15 section components in [src/screens/cmd/sections/](../src/screens/cmd/sections/).
- Drawers like [src/components/cmd/IngredientFormDrawer.tsx:222](../src/components/cmd/IngredientFormDrawer.tsx) hard-code `width: 760` right-anchored and assume desktop.
- The Cmd shell uses the `⌘K` palette ([src/navigation/CmdNavigator.tsx:111 `CmdPaletteHost`](../src/navigation/CmdNavigator.tsx)) and `⌘S` / `⌘⏎` shortcuts inside drawers — none of which exist on phones.
- The legacy `AppNavigator` (bottom-tab + stack — [src/navigation/AppNavigator.tsx](../src/navigation/AppNavigator.tsx)) is the *previous-generation* mobile-style admin UI. It still ships under `EXPO_PUBLIC_NEW_UI=false`. **Per CLAUDE.md "Legacy admin screens", we are not allowed to add new functionality to it**, and it depends on `src/screens/AdminScreens.tsx` (104 KB, frozen). Therefore we cannot solve "admin on phone" by rolling back to `AppNavigator` for narrow viewports — the new-UI mobile layouts must be net-new under `src/screens/cmd/`.

The user has explicitly answered the three top-level scoping questions:

1. **Audience:** admin/owner only. `useRole.ts` placeholder stays. No staff role.
2. **Scope:** all sidebar sections must work on phone, including dense ones (DB inspector, Audit log, Reconciliation, Reports).
3. **Distribution:** web-first via Vercel. EAS / App Store / Play Store shipping is **out of scope** for this spec — separate later phase.

## User story (concrete scenarios the admin should be able to do on a phone, on cellular)

1. Open `inventory.2amproject.com` on iPhone Safari, log in, switch store, and see the items list with status pills.
2. Tap an inventory item → see its detail (cost, par, vendor, recent activity) without horizontal scrolling.
3. Tap "edit" on an item, fill the form, and save. The form must be usable with a thumb (no 760 px right-anchored drawer).
4. Open the audit log on phone and read recent activity (today / yesterday / this week).
5. Check today's EOD-count completion across stores from the dashboard on phone.
6. From a tablet (iPad portrait, 768 wide) in the back office, do anything the desktop user can do — same data, layout adapts to the narrower viewport.
7. Cellular network tolerance: realtime sync hiccups must not crash the app; the existing 400 ms debounce stays.

## Acceptance criteria

### Phase 1 — responsive plumbing & navigation chrome (this spec covers Phase 1 only; see "Phasing" below)

- [ ] `useBreakpoint()` is extended to return one of `'phone' | 'tablet' | 'desktop'` (currently returns `'desktop' | 'mobile'`). Existing call sites are updated. Thresholds: phone < 768, tablet 768–1099, desktop ≥ 1100. The 1100 threshold is preserved — the intentional comment in [src/theme/breakpoints.ts](../src/theme/breakpoints.ts) about keeping iPad landscape on the thumb-friendly layout is honored by mapping iPad landscape (~1180 px wide) to `tablet`, not `desktop`. **Architect must confirm tablet at 1024–1099 also stays in tablet — see Open question A.**
- [ ] At phone width, the left `Sidebar` from `InventoryDesktopLayout` is replaced by a **hamburger button in a top app-bar** that opens the existing `MobileNavDrawer` ([src/components/cmd/MobileNavDrawer.tsx](../src/components/cmd/MobileNavDrawer.tsx)) as a full-height left-slide-in modal. The MobileNavDrawer organism already exists; it is wired only on the four real mobile screens today. Phase 1 wires it into the new responsive shell.
- [ ] At tablet width, the sidebar is **collapsible** — visible by default, can be collapsed to an icon rail via a button in the top app-bar. State persists for the session (localStorage / AsyncStorage).
- [ ] At desktop width, behavior is unchanged from today (sidebar permanent, 3-pane Inventory layout, ⌘K palette, ⌘S shortcuts).
- [ ] The store-switcher chip, theme toggle, and sign-out controls (today rendered in the desktop sidebar footer) are reachable on phone via the hamburger drawer footer (already present in `MobileNavDrawer`).
- [ ] `IngredientFormDrawer`, `VendorFormDrawer`, and any other right-anchored 760 px drawers in [src/components/cmd/](../src/components/cmd/) become **full-screen modal sheets** at phone width and **bottom sheets covering ≥ 80 % of viewport height** at tablet portrait width. At desktop they remain the existing 760 px right-anchored drawers. Architect picks the exact transition.
- [ ] ⌘K palette host (`CmdPaletteHost`) keeps working at desktop; on phone the palette is opened from the search row inside the existing `MobileNavDrawer` (already implemented for the four real mobile screens — extend to all sections). On tablet, ⌘K stays available if a hardware keyboard is detected (web `keydown` listener is harmless even without a keyboard, so the existing handler can stay; no special tablet branch needed).
- [ ] No regression at desktop ≥ 1100 px: every existing section keeps rendering exactly as it does today. This is verified by visual smoke at desktop width before the responsive work is considered complete.
- [ ] No section that today renders on desktop returns to the "awaiting design handoff" `ComingSoonPanel` at phone or tablet width as a result of this spec — the ComingSoon stub at narrow widths is exactly the regression Phase 1 must prevent.
- [ ] `EXPO_PUBLIC_NEW_UI=true` (the active dev flag) continues to control which navigator boots. This spec does not change the legacy fork.
- [ ] Visual verification: at viewport widths 360, 414, 768, 1024, 1180, and 1440, the chrome (top app-bar, hamburger / sidebar, store switcher, drawer entry points) renders with no horizontal scroll on the body and no clipped controls. Done via the preview tooling (per memory: "Verify UI with preview tools").

### Phase 1 explicitly does NOT have to deliver per-section responsive layouts

Phase 1 ships responsive **chrome** only. Sections continue to render their existing desktop body inside the new responsive shell. On phone, sections that overflow horizontally are allowed to either (a) horizontal-scroll, or (b) inherit a "this section is best viewed on tablet or desktop" placeholder banner at the top — architect decides the default. Phases 2–N adapt each section's body. See "Phasing" for the per-section breakdown.

## In scope (Phase 1 only)

- Extending `useBreakpoint()` to a 3-tier return.
- Adding a phone/tablet-aware shell that wraps `InventoryDesktopLayout`'s sidebar + section-render area. Sidebar collapses to hamburger drawer at phone; collapsible rail at tablet; permanent at desktop.
- Wiring all 14+ sidebar entries (the full tree from `InventoryDesktopLayout` and `NavDrawerScreen`) into the same single-screen "section swap" model that desktop uses today, instead of the current `MobileStack` that routes most names to `ComingSoonScreen`.
- Adapting `IngredientFormDrawer` and `VendorFormDrawer` to the three breakpoints (full-screen modal on phone, bottom sheet on tablet portrait, right-anchored on desktop).
- Cross-platform `confirmAction` already handles web vs native; no change.
- Visual smoke verification across 6 viewport widths via preview tools.

## Out of scope (explicitly)

- **Per-section responsive bodies.** Adapting each of the 14+ sections' internals (e.g., reflowing the AuditLog tabs to a single column, turning the DB Inspector table into cards, condensing the 3-pane Inventory into drill-down navigation) is per-section follow-up work, one spec per section. Phase 1 ships only the chrome.
- **Native iOS / Android shipping via EAS.** The `eas.json` exists but has never been used. App Store / Play Store distribution is a separate later spec. Native scaffolding is allowed to be exercised incidentally (because Expo / RN renders the same components), but no EAS build, no app-store config, no native push setup is part of this spec.
- **Changing `app.json` slug.** The `slug: towson-inventory` is load-bearing (CLAUDE.md "DO NOT AUTO-FIX"). If any responsive change implies a manifest / icon / splash rev that touches `app.json`, surface as a question — do not edit the slug.
- **Legacy `AppNavigator` / `src/screens/AdminScreens.tsx`.** Per CLAUDE.md "Legacy admin screens" these stay frozen. We do not roll back to legacy at narrow widths.
- **Legacy data layer.** No changes to `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, or the `npm run db` script.
- **`useRole.ts`.** Stays as the placeholder returning `'admin'`. No staff role added.
- **New backend endpoints / migrations / edge functions.** This is a pure frontend/UI spec.
- **Realtime channel changes.** The existing 400 ms debounced sync via [src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) is untouched. No new channels, no per-network-quality logic.
- **Offline mode / PWA-install prompts.** The web app already has a manifest + SW for push (see [src/lib/webPush.ts](../src/lib/webPush.ts)); this spec doesn't expand that. Adding "install to home screen" prompts or full offline mode is a separate spec.
- **Keyboard-shortcut redesign on tablet/phone.** ⌘K and ⌘S stay as-is (web `keydown` handler harmlessly listens; phones with no keyboard simply never trigger them). No on-screen shortcut panel.
- **Tests.** No test framework is wired up in this repo (CLAUDE.md "No test framework"). Verification is manual via preview tooling at the listed viewport widths. Adding a test framework (Playwright for visual responsive smoke would be the obvious pick) is its own spec.

## Open questions resolved (with rationale)

- **Q: Audience — admin only or also staff?**
  A: Admin/owner only. `useRole.ts` placeholder behavior preserved. Staff use a separate app in a sibling repo — not this codebase's concern.

- **Q: Scope — all 14 sections on phone, or just operator subset?**
  A: All sections must eventually be usable on phone. **But** Phase 1 only delivers responsive chrome; per-section phone adaptations are follow-up specs (one per section). This is the standard "ship plumbing first, then iterate" pattern; see "Phasing".

- **Q: Distribution — web only or also App Store / Play Store?**
  A: Web first (Vercel). Native shipping via EAS is out of scope for this spec.

- **Q: Breakpoints?**
  A: `phone < 768`, `tablet 768–1099`, `desktop ≥ 1100`. The 1100 threshold is preserved from today's code so iPad landscape (~1180 px) stays on the more thumb-friendly layout per the existing comment in [src/theme/breakpoints.ts](../src/theme/breakpoints.ts) — at desktop it'd inherit the dense 3-pane shell which is too narrow for iPad landscape. **Sub-question A flagged for architect:** is iPad landscape better as `tablet` or as a fourth `desktop-narrow` tier? Default = `tablet`.

- **Q: Existing mobile-fallback pattern (InventoryListScreen / ItemDetailScreen) — extend or rebuild?**
  A: **Rebuild around the existing single-screen "section swap" model.** Today's `MobileStack` is a real-stack-of-screens with most entries pointing at `ComingSoonScreen`; the desktop shell is one screen with internal section state. Maintaining two divergent navigation models is the bug. Phase 1 makes the responsive shell render the same `InventoryDesktopLayout`-style section-swap on phone/tablet/desktop, with the sidebar's presentation as the only thing that changes per breakpoint. The existing `InventoryListScreen` and `ItemDetailScreen` mobile-stack screens become obsolete after Phase 1 and are removed at the end of Phase 1 (architect to confirm — see Open question B).

- **Q: Sidebar on phone — hamburger menu or bottom-tab bar?**
  A: Hamburger menu (left-slide-in drawer reusing the existing `MobileNavDrawer` organism). The sidebar today has 14+ items grouped Operations / Planning / Insights — too many for a 5-tab bottom bar without nesting, and the hamburger pattern matches the desktop `Sidebar` mental model 1:1 (same tree, same labels, same icons).

- **Q: Drawers (760 px right-anchored) on phone?**
  A: Full-screen modal sheets on phone, bottom sheets covering ≥ 80 % of viewport on tablet portrait, current 760 px right-anchored on desktop. Architect picks exact animation / safe-area handling.

- **Q: 3-column Inventory layout on phone?**
  A: **Out of scope for Phase 1.** The 3-pane layout adaptation is part of the Inventory section's own follow-up spec (Phase 2-Inventory). For Phase 1, on phone, the Inventory section can horizontal-scroll or render a placeholder banner — architect picks the default.

- **Q: Command palette (⌘K) on phone?**
  A: Already addressed — the existing `MobileNavDrawer` has a search input that drives the same palette index. No change in Phase 1 beyond wiring the drawer into the new responsive shell.

- **Q: ⌘S / ⌘⏎ keyboard shortcuts on phone?**
  A: Keep the `keydown` handlers as-is. They never fire without a keyboard. No on-screen substitute. (Tablet with attached keyboard: works as on desktop.)

- **Q: Dense data tables (DB inspector, Audit log, Reports) on phone?**
  A: **Out of scope for Phase 1.** Each gets its own follow-up spec (Phase 2-AuditLog, Phase 2-Reports, Phase 2-DBInspector). Phase 1 lets them horizontal-scroll or shows a "best on tablet" banner; either is acceptable for ship.

- **Q: Tablet vs phone — does tablet mirror desktop or phone?**
  A: Tablet is **its own tier**: collapsible sidebar (vs hamburger on phone, permanent on desktop), bottom-sheet drawers (vs full-screen on phone, right-anchored on desktop). Tablet portrait at 768 px is closer to phone in chrome behavior; tablet landscape at 1024 px is closer to desktop. The collapsible-rail compromise serves both.

- **Q: Realtime / cellular network considerations?**
  A: No spec change. The 400 ms debounce in [src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) and the existing optimistic-then-revert + toast pattern in [src/store/useStore.ts](../src/store/useStore.ts) handle flaky networks well enough today; cellular adds latency but no new failure mode the existing code doesn't already handle. Realtime publication gotcha (memory note) is a local-dev concern, not a phone-on-cellular concern.

- **Q: `app.json` slug?**
  A: Unchanged. Per CLAUDE.md, slug stays `towson-inventory` until explicit user approval. If responsive work requires manifest / icon / splash changes, surface as a separate question — do not auto-edit.

## Open questions for architect (not blocking spec — flagged for design phase)

- **A.** Should iPad landscape (~1180 px wide) stay in `tablet` (current proposal) or get a fourth `desktop-narrow` tier with a sidebar-rail-not-drawer compromise? Default = `tablet`.
- **B.** Are `InventoryListScreen` and `ItemDetailScreen` (today's `MobileStack` real-screen entries for Inventory) deletable at the end of Phase 1, or do they need to stay alive for the App Store / Play Store path? They're only reachable when `Platform.OS !== 'web'` OR `width < 1100`; if Phase 1 unifies the responsive shell on web, they're dead code on web. Native still routes through `MobileStack`. Architect should decide whether to delete them or fold them into the unified shell.
- **C.** Where does `MobileNavDrawer` get its sidebar tree at phone/tablet width? Currently `InventoryDesktopLayout` builds `defaultGroups` inline (around line 200) and applies the per-user `sidebarLayoutOverride` from Spec 008. The same tree should drive the mobile drawer — either (a) lift `defaultGroups` to a shared selector, or (b) `InventoryDesktopLayout` becomes the responsive shell itself and renders sidebar-as-drawer at narrow widths. Architect picks.

## Phasing recommendation

This spec (011) covers **Phase 1: responsive chrome only**. After Phase 1 ships, file follow-up specs as needed:

| Phase    | Spec                | Scope                                                                |
|----------|---------------------|----------------------------------------------------------------------|
| **1**    | **011 (this)**      | Responsive chrome: sidebar/hamburger, drawer adaptations, breakpoints. No per-section body adaptations. Ship gate: every section renders without crashing at all 6 verification widths. |
| 2-Inventory  | 012 (proposed)  | Inventory 3-pane → drill-down navigation on phone (list → detail → properties), accordion on tablet. |
| 2-EOD        | 013 (proposed)  | EODCount input flow on phone — large tap targets, single-column form. |
| 2-AuditLog   | 014 (proposed)  | Audit log: card layout on phone, table on tablet/desktop.            |
| 2-Reports    | 015 (proposed)  | Reports: chart resizing, table → cards on phone.                     |
| 2-Recipes    | 016 (proposed)  | Recipes / PrepRecipes BOM editor on tablet; phone may stay banner.   |
| 2-Reconciliation | 017 (proposed) | Reconciliation diff view on phone (likely "tablet+ recommended" with read-only summary on phone). |
| 2-DBInspector    | 018 (proposed) | DB inspector: probably "tablet+ only" banner on phone — its 8-column tables are not phone-realistic. |
| 2-Other      | 019…              | Vendors, Categories, Receiving, Restock, PurchaseOrders, OrderSchedule, WasteLog, POSImports, Dashboard — each own spec or grouped where they share a layout pattern. |
| 3-Native     | TBD               | EAS native shipping (App Store, Play Store).                         |

Rationale: shipping responsive chrome first lets the user open the admin app on a phone *today* and at minimum read every section (even if some require horizontal-scroll). It de-risks the per-section work because each follow-up spec inherits the same shell. One mega-spec covering all 14 sections would be slow to land and high-risk because each section has different density needs (a card layout that works for AuditLog won't work for Reports' charts).

## Dependencies

- **Existing code:** `useBreakpoint()`, `MobileNavDrawer`, `InventoryDesktopLayout`, `IngredientFormDrawer`, `VendorFormDrawer`, `CmdPaletteHost`, `CommandPalette`. All in this repo.
- **Existing convention:** `useColors()` / `useCmdColors()` theme hooks. New responsive components must use these, not raw color literals.
- **Existing convention:** `src/utils/confirmAction.ts` already cross-platform; no changes needed.
- **No new packages assumed.** If architect needs a bottom-sheet library (e.g., `@gorhom/bottom-sheet`) flag in design — Expo SDK 54 + RN 0.81 + react-native-web compatibility needs to be verified.
- **No backend changes.** No migrations, no edge functions, no RPCs.
- **No new env vars or feature flags.** `EXPO_PUBLIC_NEW_UI` already gates Cmd UI vs legacy.

## Project-specific notes

- **Cmd UI section / legacy:** All work lands in [src/screens/cmd/](../src/screens/cmd/), [src/components/cmd/](../src/components/cmd/), [src/navigation/CmdNavigator.tsx](../src/navigation/CmdNavigator.tsx), [src/theme/breakpoints.ts](../src/theme/breakpoints.ts). **No edits to [src/screens/AdminScreens.tsx](../src/screens/AdminScreens.tsx)** (legacy, frozen per CLAUDE.md). **No edits to [src/navigation/AppNavigator.tsx](../src/navigation/AppNavigator.tsx)** (legacy mobile-style admin UI; it ships under `EXPO_PUBLIC_NEW_UI=false` and stays as-is until that flag is removed).
- **Per-store or admin-global:** N/A — pure frontend layout work. Existing per-store RLS via `auth_can_see_store()` is untouched.
- **Realtime channels touched:** None. The 400 ms debounce in `useRealtimeSync` is unchanged.
- **Migrations needed:** No.
- **Edge functions touched:** None.
- **Web/native scope:** **Web only for shipping.** Native rendering will work as a side-effect of using the same RN components, but no EAS build is in scope. App Store / Play Store is Phase 3 in a separate spec.
- **`app.json` slug:** Unchanged. Surface as a question if any work surfaces a need to edit it.
- **Tests:** No test framework wired up. Verification via preview-tooling visual smoke at viewport widths 360, 414, 768, 1024, 1180, 1440 (per memory: "Verify UI with preview tools"). If the test-engineer reviewer wants automated visual regression here, they should flag in their findings — adding a framework is out of scope for this spec.
- **Bind-mount gotcha:** N/A — no edge function work.
- **Realtime publication gotcha:** N/A — no schema changes to publication.

## Frontend design

This is a pure frontend spec. "Backend design" is renamed to **Frontend design**
because the architect role owns the design contract regardless of layer per the
project's agent topology (CLAUDE.md → Agent workflow). No DB schema, RPCs, edge
functions, RLS, realtime channels, or `src/lib/db.ts` helpers change in Phase 1.

### §0 — Probe results (what's actually in the codebase today)

Findings from reading the live code on 2026-05-08, not just the PM background:

- **`useBreakpoint()`** ([src/theme/breakpoints.ts](../src/theme/breakpoints.ts)) returns the union `'desktop' | 'mobile'` based on `Platform.OS !== 'web'` (forces `'mobile'`) or `width >= DESKTOP_MIN_WIDTH (1100)`. The threshold comment explicitly chose 1100 — not 1024 — so iPad landscape (~1180) renders as mobile. There is no per-tier scale (no font-size or spacing token bound to it); call sites use the boolean form only.
- **Call sites of `useBreakpoint()`** are limited: [src/navigation/CmdNavigator.tsx:84,113](../src/navigation/CmdNavigator.tsx) (shell branch + palette nav target), [src/screens/cmd/InventoryListScreen.tsx:38](../src/screens/cmd/InventoryListScreen.tsx), [src/screens/cmd/ItemDetailScreen.tsx:34](../src/screens/cmd/ItemDetailScreen.tsx). All three usages currently treat it as a binary. Extending the union is a typed-API change but the actual touch surface is small.
- **`MobileStack`** ([src/navigation/CmdNavigator.tsx:27–57](../src/navigation/CmdNavigator.tsx)) is a real React Navigation stack with five entries: `Inventory`, `ItemDetail`, `ComingSoon`, `Drawer` (transparent-modal `NavDrawerScreen`), `DBInspector` (+ dev `CmdAtomsPreview`). The PM's count of "four real screens" is correct if you treat the modal Drawer as plumbing and DBInspector as legacy reuse.
- **`NavDrawerScreen`** ([src/screens/cmd/NavDrawerScreen.tsx](../src/screens/cmd/NavDrawerScreen.tsx)) holds its **own** copy of the sidebar tree (Operations / Planning / Insights), nearly identical to the one in `InventoryDesktopLayout` — but with **all non-Inventory rows wired to `nav.navigate('ComingSoon', ...)`**. This duplication is the bug. The override system from Spec 008 (`sidebarLayoutOverride` + `applySidebarOverride`) is **not applied here at all** — the mobile drawer ignores the user's customizations. Confirms Open question C: lifting `defaultGroups` is necessary, not optional.
- **`InventoryDesktopLayout`** ([src/screens/cmd/InventoryDesktopLayout.tsx:159–194](../src/screens/cmd/InventoryDesktopLayout.tsx)) builds `defaultGroups` inline with the canonical full tree (15 items including DB inspector), then runs it through `applySidebarOverride(defaultGroups, sidebarLayoutOverride, …)` to honor Spec 008 customization. Section state is local React state (`section, setSection`), not navigation routes — so the "single screen with internal swap" pattern is real.
- **`IngredientFormDrawer`** ([src/components/cmd/IngredientFormDrawer.tsx:222](../src/components/cmd/IngredientFormDrawer.tsx)) is a `Modal` + `TouchableOpacity` backdrop + hard-coded `width: 760` right-anchored panel. The `boxShadow` is web-gated. The form body is a horizontal `View` containing `IngredientForm` + side pane (`JsonPreview` or `AuditHistory`) — at phone width the side pane is non-essential and should be hidden, and the form needs to take 100% width.
- **`VendorFormDrawer`** ([src/components/cmd/VendorFormDrawer.tsx](../src/components/cmd/VendorFormDrawer.tsx)) follows the same Modal-+-right-anchored-760 pattern. Same treatment applies.
- **`MobileNavDrawer`** organism ([src/components/cmd/MobileNavDrawer.tsx](../src/components/cmd/MobileNavDrawer.tsx)) is already built and is presentationally correct: full-screen `Modal` with `animationType="slide"`, header / search / tree / footer. It accepts `groups`, `selectedId`, `onSelect`, palette query, footer slots — so it's already a parameterized organism, not a hard-coded screen. Ready for reuse from the new shell.
- **`Sidebar`** ([src/components/cmd/Sidebar.tsx](../src/components/cmd/Sidebar.tsx)) accepts `width` as a prop (defaults to 240). It already has the rendering machinery for a narrower (rail) form, but no rail mode today. Edit-mode (Spec 008) is web-gated via `React.lazy`.
- **`CmdPaletteHost`** ([src/navigation/CmdNavigator.tsx:111–166](../src/navigation/CmdNavigator.tsx)) attaches a global `keydown` listener on web for `⌘K` / `⌘P`. On phone with no hardware keyboard the handler simply never fires — no special case needed for "hide on phone." Render is web-only via `Platform.OS !== 'web'` early-return. The palette modal itself is responsive enough (it's a centered modal, not a fixed-width drawer).
- **Bottom-sheet libraries:** `@gorhom/bottom-sheet` is **not installed** (verified in [package.json](../package.json)). Its README requires `react-native-reanimated` and `react-native-gesture-handler` — both are installed (reanimated `~4.1.1`, gesture-handler `~2.28.0`). However `@gorhom/bottom-sheet` v4/v5 has **no react-native-web support** out of the box; community workarounds exist but the project's "ship to Vercel first" goal makes this a poor fit for Phase 1.
- **Theme tokens:** [src/theme/colors.ts](../src/theme/colors.ts) splits Light / Dark / Cmd palettes; there are no spacing or breakpoint tokens today. Spacing is hand-keyed in each component.

### §1 — Breakpoint contract

**Decision: 3-tier union, no `desktop-narrow`.** See §4.A for rationale.

```ts
// src/theme/breakpoints.ts (extended)
export type Breakpoint = 'phone' | 'tablet' | 'desktop';

export const BREAKPOINTS = {
  phoneMax:   767,    // < 768  → phone
  tabletMax:  1099,   // 768–1099 → tablet
  // ≥ 1100 → desktop  (preserves existing DESKTOP_MIN_WIDTH semantics)
} as const;

// Existing DESKTOP_MIN_WIDTH constant stays exported for back-compat —
// equal to BREAKPOINTS.tabletMax + 1.
export const DESKTOP_MIN_WIDTH = 1100;

export function useBreakpoint(): Breakpoint;

// Convenience boolean selectors so call sites don't proliferate string compares.
export function useIsPhone(): boolean;     // bp === 'phone'
export function useIsTablet(): boolean;    // bp === 'tablet'
export function useIsDesktop(): boolean;   // bp === 'desktop'
export function useIsCompact(): boolean;   // bp !== 'desktop' (i.e. phone OR tablet)
```

Native-platform behavior preserved: `Platform.OS !== 'web'` returns `'phone'`
(was `'mobile'`). This is a **rename**, not a behavior change — native always
gets the narrowest tier.

**Migration of existing call sites:**

| Site | Today | After |
|---|---|---|
| `CmdNavigator.tsx:84` (`AuthedRoot` shell pick) | `bp === 'desktop' ? <Desktop> : <MobileStack>` | `useIsDesktop() ? <DesktopShell> : <ResponsiveShell>` (shell rename — see §2) |
| `CmdNavigator.tsx:113,142` (`CmdPaletteHost`) | `bp === 'desktop'` | `useIsDesktop()` — same semantics |
| `InventoryListScreen.tsx:38` | unused after this spec (file removed — see §4.B) | n/a |
| `ItemDetailScreen.tsx:34` | unused after this spec | n/a |

**No new tier-bound spacing or font tokens in Phase 1.** Per-section follow-up
specs (012–019) may add scale tokens; deferring keeps the chrome-only diff
focused. Theme tokens stay where they are in `src/theme/`.

### §2 — Sidebar / hamburger chrome design

**Decision (resolves Open question C):** Lift the canonical sidebar tree builder
into `src/lib/cmdSelectors.ts` (existing file — same home as `useStockSeries`
etc.) as `useDefaultSidebarGroups()` and `useRenderedSidebarGroups()`. This is
**option (a)** from the PM's framing — extract a shared selector. Rationale in §4.C.

**Decision: introduce a new wrapper, `ResponsiveCmdShell`,** that hosts the
chrome (sidebar / app-bar / hamburger drawer) and the `section` state, then
renders `InventoryDesktopLayout` as the body **without** its own sidebar.
`InventoryDesktopLayout` becomes a body-only component; the chrome moves up.
Rationale in §4.C.

**Component boundaries:**

```
ResponsiveCmdShell                                           [NEW — src/screens/cmd/]
 ├── (phone) MobileTopAppBar                                 [NEW — src/components/cmd/]
 │     hamburger (☰) | section title | (slot for trailing actions)
 │     opens MobileNavDrawer (existing organism)
 ├── (tablet) MobileTopAppBar
 │     hamburger toggles RailSidebar visibility (collapsed by default? → no, expanded by default per spec; persisted)
 ├── (tablet, expanded) Sidebar (existing, 240w)
 ├── (tablet, collapsed) RailSidebar                          [NEW — src/components/cmd/]
 │     icon-only 56w rail; click expands to full Sidebar
 ├── (desktop) Sidebar (existing, 240w, permanent)
 │
 └── <InventoryBodyOnly section={section} … />               [REFACTORED InventoryDesktopLayout]
```

**Where the hamburger lives:** in `MobileTopAppBar`, fixed-height (44 px) bar at
the very top of the viewport (above the existing `TitleBar`). On phone the
TitleBar may be hidden (it's desktop-decorative — file-tab + path crumbs) and
replaced with a single section title in the app-bar. Architect's call: **keep
the existing `TitleBar` on tablet and desktop; on phone replace with the simpler
`MobileTopAppBar` title slot** so we don't have to redesign TitleBar contents
in Phase 1.

**How the hamburger is triggered:** tap → `setMobileDrawerOpen(true)` → renders
`MobileNavDrawer` modal. Today this is wired via React Navigation's transparent-
modal `Drawer` route in `MobileStack`. After Phase 1 there's no nav-stack to
push to, so the drawer becomes a controlled `Modal` rendered inside
`ResponsiveCmdShell`. `NavDrawerScreen` becomes obsolete (its content moves into
the shell's `MobileNavDrawer` invocation, deduped against `useDefaultSidebarGroups`).

**Per-section back buttons on phone:** N/A in Phase 1. Sections are still single-
screen swap, not stack-pushed. The hamburger always reopens the drawer for
navigation. (Per-section follow-up specs that introduce drill-down will add
back buttons there — out of scope here.)

**Tablet sidebar collapse persistence:** `localStorage` key
`imr.cmd.sidebar.tabletCollapsed` (web only — AsyncStorage on native, but native
defaults to phone tier, so this only ships on web). Stored as `'1' | '0'`. Read
on mount, written on toggle. No backend persistence (per-device session
preference, not a profile setting). Default = expanded.

**Sign-out / theme toggle / store-switcher placement:**

| Tier | Sidebar footer | App-bar | MobileNavDrawer footer |
|---|---|---|---|
| desktop | sign out + theme toggle + EOD | (no app-bar, TitleBar only) | n/a |
| tablet (expanded) | same as desktop | (TitleBar only) | n/a |
| tablet (collapsed rail) | rail icons (theme toggle, sign out) | (TitleBar only) | n/a |
| phone | n/a | section title only | sign out + theme toggle + EOD (already wired) |

### §3 — Responsive drawer pattern (Modal/Drawer/BottomSheet)

**Decision: roll a custom `ResponsiveSheet` wrapper. Do NOT add `@gorhom/bottom-sheet`.**

**Justification:**

1. **react-native-web compat is the gating risk.** `@gorhom/bottom-sheet` doesn't ship web support; community shims rely on `react-native-reanimated`'s web build, which works but is fiddly with Reanimated 4 + RN 0.81 + RNW 0.21 (unstable surface). The Vercel deploy is the primary target; risking the build is wrong.
2. **The existing pattern is already a `Modal` + slide animation.** Both `IngredientFormDrawer` and `VendorFormDrawer` use RN's built-in `Modal` with `animationType="slide"` and a `TouchableOpacity` backdrop. `MobileNavDrawer` does the same. This is the project's established idiom.
3. **Phase 1 needs a wrapper, not a new dependency.** A ~150-line wrapper that picks `right-anchored 760` vs `bottom-sheet 80%` vs `full-screen` based on breakpoint is enough.
4. **Reanimated is already installed for Spec 008's dnd-kit shim contexts; no need to depend on it again.** Using RN's built-in `Animated` for slide-from-bottom is fine.

**API:**

```ts
// src/components/cmd/ResponsiveSheet.tsx (NEW)
interface ResponsiveSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Per-tier presentation override. Defaults below. */
  presentation?: {
    desktop?: 'right-drawer' | 'center-modal';   // default: 'right-drawer'
    tablet?:  'bottom-sheet' | 'right-drawer';   // default: 'bottom-sheet'
    phone?:   'fullscreen'   | 'bottom-sheet';   // default: 'fullscreen'
  };
  /** Width when right-drawer (desktop). Defaults to 760. */
  desktopWidth?: number;
  /** Bottom-sheet height as fraction of viewport (tablet). Defaults to 0.85. */
  tabletSheetHeight?: number;
  /** Renders inside the sheet body. */
  children: React.ReactNode;
  /** Optional header; sticky at top of sheet. */
  header?: React.ReactNode;
  /** Optional footer; sticky at bottom. */
  footer?: React.ReactNode;
  /** ARIA label for screen readers. */
  accessibilityLabel?: string;
}
```

**Behavior matrix:**

| Tier | Backdrop | Animation | Container | Safe area |
|---|---|---|---|---|
| desktop | `rgba(0,0,0,0.32)`; click-outside closes | `slide` from right | `width: 760`, full height, right-anchored | n/a |
| tablet | same | `slide` from bottom | `height: 85vh`, full width, bottom-anchored, top corners radius CmdRadius.lg | bottom inset only |
| phone | none (sheet is full-screen) | `slide` from bottom | full-screen, no radius | top + bottom insets via `react-native-safe-area-context` (already a dep) |

**Drag-to-dismiss:** out of scope for Phase 1. RN's `Modal` doesn't expose pan
responder integration cleanly without Reanimated/Gesture Handler. Phase-1 sheets
close via the explicit close button or backdrop tap (desktop/tablet only); phone
uses the close button in the sticky header.

**Migration of existing drawers:**

- `IngredientFormDrawer`: wrap body in `<ResponsiveSheet>` with default presentation. The 760w hard-coded panel goes away; the 760 becomes `desktopWidth={760}`. The horizontal `View` containing form + side pane needs to flip to `flexDirection: useIsCompact() ? 'column' : 'row'` and the side pane (`JsonPreview` / `AuditHistory`) hidden on phone (it's a power-user assist). On tablet, side pane drops below the form (vertical stack).
- `VendorFormDrawer`: same treatment, simpler form.
- `MobileNavDrawer`: **stays as-is.** It's already a phone-shaped full-screen modal; it shouldn't be unified with `ResponsiveSheet` because it's the navigation drawer, not a content sheet, and its content (tree + palette + footer) is genuinely phone-shaped on every tier. The shell only renders it on phone.

### §4 — Open question decisions

**A. iPad-landscape tier — `tablet` or `desktop-narrow`?**

**Decision: keep iPad landscape (~1180) at `tablet` by default, BUT cap the desktop tier at the existing `DESKTOP_MIN_WIDTH = 1100`.**

Wait — that's contradictory. Let me restate cleanly:

The existing 1100 threshold puts iPad landscape (1180) **above** the threshold,
i.e. at `desktop` today. The PM background paragraph (line 17) confused this.
Reading the current code (`width >= 1100 ? 'desktop' : 'mobile'`), iPad landscape
**is on `desktop` today**, contrary to the comment in the file. Either the
comment or the threshold is wrong. The **comment** is the lie — iPad landscape
hits desktop with the existing threshold.

**Decision: keep desktop ≥ 1100 (preserves today's behavior), accept iPad
landscape as `desktop`.** The 3-pane Inventory layout works at 1100–1180; the
existing comment is stale and should be removed. iPad portrait (768–1024) gets
the `tablet` tier with collapsible-rail sidebar — that's the new behavior.
A new `desktop-narrow` tier is rejected: it adds complexity for one device class
that's already being served by the existing breakpoint. The collapsible sidebar
on tablet is the right compromise for portrait; landscape can use desktop.

If a follow-up section (e.g. AuditLog) decides 1180 is too narrow for its
desktop body, it can introduce its own per-section width-aware variant —
that's per-section work, not chrome work.

**B. Delete `InventoryListScreen` / `ItemDetailScreen` at end of Phase 1?**

**Decision: keep them, but stop routing to them from `MobileStack`.**

Rationale:
- Per CLAUDE.md "Distribution: web-first via Vercel", Phase 1 ships web only. But the same RN components do still bundle for native — and Phase 3 (EAS native build) is on the roadmap. Deleting the only RN-screen-stack-shaped Inventory screens now leaves the native build with nothing routable but `ResponsiveCmdShell` rendered as a single mega-screen, which is functionally fine but loses the cheap drill-down navigation that native stack-cards give for free.
- The cost of keeping them is zero — they're dead code from `CmdNavigator`'s perspective once `MobileStack` is gone.
- File-level deletion is easy in a future sweep (Phase 3 or a cleanup spec) once we know whether native shipping happens.
- **The build outcome:** `MobileStack` itself goes away (replaced by `ResponsiveCmdShell`). `InventoryListScreen.tsx` and `ItemDetailScreen.tsx` stay on disk, **unimported** — they become orphans. Add a top-of-file comment in each: `// ORPHANED post-Spec-011. Kept for potential native EAS reuse (Phase 3). Not imported anywhere as of 2026-05-08.`
- `NavDrawerScreen.tsx` is **deleted** — its logic is fully absorbed into `ResponsiveCmdShell`'s `MobileNavDrawer` invocation, and unlike the Inventory mobile screens it has no native-shipping rationale (the new shell renders its drawer the same way on native as on web).

**C. Lift `defaultGroups` to a shared selector vs. make `InventoryDesktopLayout` the responsive shell?**

**Decision: lift `defaultGroups` to a shared selector at `src/lib/cmdSelectors.ts`, AND introduce a separate `ResponsiveCmdShell` wrapper. Both halves of the question, both directions.**

Rationale:
- The duplication between `InventoryDesktopLayout`'s `defaultGroups` and `NavDrawerScreen`'s inline tree is a real bug today — `NavDrawerScreen` ignores Spec 008's `sidebarLayoutOverride`. Lifting the builder is the only fix that respects the user's customizations on phone.
- Making `InventoryDesktopLayout` itself the responsive shell would balloon a 525-line component into something much larger and tangle the chrome with the body. The inventory body (3-pane, items.tsv ↔ catalog.tsv mode switch, EDIT drawer, palette-action bridge) is already complex; the chrome (sidebar / app-bar / drawer) is its own concern. Separation of concerns wins.
- `useDefaultSidebarGroups()` becomes the single source of truth. Both `Sidebar` (via `ResponsiveCmdShell`) and `MobileNavDrawer` (also via `ResponsiveCmdShell`) consume it. `useRenderedSidebarGroups(editMode)` wraps it with `applySidebarOverride(…)` for Spec-008 customization.
- One subtlety: `defaultGroups` today closes over `nav` (for the `DBInspector` row's `onPress: () => nav.navigate('DBInspector')`). After lifting, the selector returns groups with `id: 'DBInspector'` and the **shell** attaches the `onPress` (since the shell is the one with nav context). This decouples the selector from React Navigation, which is correct.

### §5 — Files to create / modify

**New files:**

- `src/screens/cmd/ResponsiveCmdShell.tsx` — top-level shell that branches sidebar/app-bar/drawer per breakpoint, owns `section` state, renders `InventoryDesktopLayout` as the body. Replaces the role currently played by `MobileStack` + `DesktopShell` in `CmdNavigator.tsx`.
- `src/components/cmd/MobileTopAppBar.tsx` — 44-px-tall fixed bar with hamburger button, section title, optional trailing slot. Used at phone; used at tablet to host the rail-collapse toggle.
- `src/components/cmd/RailSidebar.tsx` — 56-px icon-only rail rendering of the same `groups` data; click to expand to full `Sidebar`. Tablet only.
- `src/components/cmd/ResponsiveSheet.tsx` — the canonical sheet wrapper. See §3 for API. ~150 LOC.

**Modified files:**

- `src/theme/breakpoints.ts` — extend `Breakpoint` union to 3 tiers, add `BREAKPOINTS` constant, add `useIsPhone/Tablet/Desktop/Compact()` selectors. Update or remove the stale "iPad landscape gets mobile" comment. Preserve `DESKTOP_MIN_WIDTH` export.
- `src/lib/cmdSelectors.ts` — add `useDefaultSidebarGroups()` and `useRenderedSidebarGroups(editMode)`. The latter wraps `applySidebarOverride`. Both **return groups with no `onPress` for `DBInspector`**; the shell attaches it.
- `src/navigation/CmdNavigator.tsx` — replace `MobileStack` + `DesktopShell` with a single screen rendering `ResponsiveCmdShell`. The `DBInspector` route stays as a sibling stack screen (the shell's sidebar `DBInspector` row navigates to it via React Navigation, same as today). Keep `DBInspectorScreen` route for both shells. `CmdAtomsPreview` stays as a dev-only sibling. `CmdPaletteHost` stays — its handler already works in both contexts; the `desktopActionForRoute` branch needs to be aware that `breakpoint !== 'desktop'` now means "phone or tablet" (semantically the same — palette opens an action; the shell consumes it).
- `src/screens/cmd/InventoryDesktopLayout.tsx` — extract the chrome (sidebar render + footer slots + edit-mode handlers + section state) up to `ResponsiveCmdShell`. The remaining file becomes the body — Inventory-section-specific (3-pane, EDIT drawer, items.tsv/catalog.tsv switch). Rename to `InventoryBody.tsx`? Architect leans yes — but Phase 1 can keep the file name to minimize diff. **Decision: keep filename, document at top that the file is now body-only and the chrome lives in `ResponsiveCmdShell`.**
- `src/components/cmd/IngredientFormDrawer.tsx` — wrap in `ResponsiveSheet`, remove the hard-coded `width: 760` panel `View`, conditionalize the `flexDirection: 'row'` body to vertical stack on phone, hide the side pane on phone.
- `src/components/cmd/VendorFormDrawer.tsx` — same treatment.

**Deleted files:**

- `src/screens/cmd/NavDrawerScreen.tsx` — absorbed into `ResponsiveCmdShell`. The shell renders `MobileNavDrawer` directly with the lifted selector and attaches `onSelect` to the shell's `setSection`.

**Orphaned but kept (with comment header):**

- `src/screens/cmd/InventoryListScreen.tsx`
- `src/screens/cmd/ItemDetailScreen.tsx`
- `src/screens/cmd/ComingSoonScreen.tsx` — keep; `InventoryDesktopLayout` already renders `<ComingSoonPanel>` inline for unimplemented sections. The standalone screen is unused after `MobileStack` removal.

**No changes:**

- `src/store/useStore.ts` — no state slice changes. Optimistic-then-revert pattern doesn't apply (no backend write paths affected).
- `src/hooks/useRealtimeSync.ts` — no changes. The 400 ms debounce works identically on cellular; the spec confirms no per-network logic in Phase 1.
- `src/lib/db.ts` — no helpers added or changed.
- `src/utils/confirmAction.ts` — already cross-platform.
- `app.json` — slug stays `towson-inventory` per CLAUDE.md "DO NOT AUTO-FIX". No manifest / icon / splash changes are needed for Phase 1 (the existing PWA manifest works at all viewport widths). If a follow-up phase adds an "install to home screen" prompt, surface as a question then.
- `src/screens/AdminScreens.tsx`, `src/navigation/AppNavigator.tsx`, all legacy files — frozen per CLAUDE.md.

### §6 — Verification probes

Per memory note "Verify UI with preview tools" and the spec's acceptance
criterion. The user (or test-engineer) will browser-verify by booting the local
stack and exercising six viewport widths via the preview/Chrome MCP DevTools
emulation.

**Pre-conditions:**

```
npm run dev:db        # local Supabase + admin@local.test / password
npm run web           # Expo web at http://localhost:8081 (or 19006)
EXPO_PUBLIC_NEW_UI=true  (default per .env.local)
```

**Probes (in order):**

1. **Desktop regression — 1440 px.** Open the web app at default desktop width. Sidebar permanent (240w). Inventory section 3-pane visible. Click ⌘K palette button (or press ⌘K) — palette opens. Click "EDIT" on an item — `IngredientFormDrawer` slides in from right at 760w. Press ⌘S — saves. Press Esc — closes. **Expected: identical to pre-Phase-1 behavior.** This is the no-regression gate.
2. **Desktop edge — 1180 px (iPad landscape proxy).** Resize Chrome to 1180×820. Sidebar still permanent. 3-pane Inventory still fits. **Expected: same as 1440 (just narrower).** Confirms Decision A.
3. **Tablet — 1024 px.** Resize to 1024×768. App-bar appears with hamburger that toggles sidebar collapse. Sidebar starts expanded. Click hamburger → sidebar collapses to 56-px rail. Refresh page → sidebar still collapsed (localStorage). Click "EDIT" on an item — sheet slides up from bottom at 85vh. **Expected: app-bar present, drawer-as-bottom-sheet, no horizontal scroll.**
4. **Tablet portrait — 768 px.** Resize to 768×1024. Same as 1024, narrower. Verify the 3-pane Inventory body horizontally-scrolls or shows banner (architect-deferred — Phase 1 spec allows either; **default = horizontal-scroll**, per the simpler implementation).
5. **Phone — 414 px (iPhone Pro Max).** Resize to 414×896. App-bar with hamburger; no sidebar visible. Tap hamburger → `MobileNavDrawer` slides in from left, full-screen. Search field works. Tap a section name — drawer closes, section swaps. Open Inventory → tap an item → tap EDIT — `IngredientFormDrawer` covers the full screen, side pane hidden, form is single-column.
6. **Phone narrow — 360 px (Android base).** Resize to 360×740. Same as 414, narrower. **Expected: no clipping of app-bar, no horizontal body scroll on phone-friendly sections.** Inventory 3-pane is allowed to horizontal-scroll.

**Acceptance:** all six probes pass with no console errors and no React-key warnings. The Spec 008 sidebar customization, exercised on desktop, is reflected in the phone drawer (proves the lifted selector is consumed by both).

### §7 — Risks + RN 0.81 / RN-Web compat notes

**Risks (ranked):**

1. **`InventoryDesktopLayout` refactor surface.** Extracting the chrome out of a 525-line component without breaking the EDIT drawer, palette-action bridge, Spec-008 edit-mode flows, or items.tsv ↔ catalog.tsv switch is the highest-effort piece. Mitigation: do this in two commits — first lift the chrome to `ResponsiveCmdShell` while keeping the file's body intact (just receive `section` as a prop instead of local state); second, run `useRenderedSidebarGroups()` from the shell (instead of from the body) and prove Spec 008 edit-mode still works. This isolates the regression surface.

2. **`@react-navigation/stack` losing `MobileStack` may break deep-links / palette navigation on tablet/phone.** Today `CmdPaletteHost`'s `handleNavigate` branches on `breakpoint === 'desktop'` to use `paletteAction` (the desktop in-screen state) vs `navRef.navigate(…)` (the stack). After Phase 1 there's no stack on tablet/phone — both branches go through `paletteAction`. Mitigation: simplify `CmdPaletteHost` to **always** use `paletteAction` since the shell now consumes it on all tiers. Verify `EODCount` palette focus (`eodFocusItemId`) still works — it's a section-state action, not a route, so it's unaffected.

3. **RN `Modal` + `Animated` slide-from-bottom on RNW 0.21.** RN's built-in `Modal` is fully supported on web. `Animated.View` slide is straightforward. The risk is animation jank on first open (RNW renders `Modal` as a portal-equivalent). Mitigation: precompute the off-screen position; use `useNativeDriver: true` (works for `transform` on web in RNW 0.21). If jank is observable, fall back to CSS transitions via inline style (`transform: translateY(...)` + `transition: transform 200ms ease-out`) gated on `Platform.OS === 'web'`.

4. **react-native-safe-area-context tablet bottom inset.** On phone the bottom inset is the home-indicator area; on tablet there isn't one. The existing `MobileNavDrawer` hard-codes `paddingBottom: 28`. The new `ResponsiveSheet` should consume `useSafeAreaInsets()` for the bottom inset on phone, but apply `0` on tablet. Mitigation: simple conditional `useIsPhone() ? insets.bottom : 0`.

5. **Spec 008 edit-mode + dnd-kit on tablet.** `Sidebar`'s edit-mode is web-only via `React.lazy`. On tablet the sidebar is rendered in two forms (full + rail). Edit-mode only makes sense on the full form — the rail has no labels to drag. Mitigation: hide the gear icon when the rail is showing; only the expanded `Sidebar` exposes edit-mode. (The user can expand → edit → done → collapse.) Document this in `RailSidebar`.

6. **Tablet-collapsed state outliving a real device boundary.** If a user sets the rail collapsed at tablet width, then the Vercel deploy is opened on a separate desktop, the localStorage key isn't read (no rail at desktop). That's fine. Reverse case — collapse on tablet, then resize the same browser window to desktop — the rail just stops rendering and the full sidebar appears. No bug. Document the absence of a "I want my sidebar collapsed at desktop too" feature; that's a follow-up.

7. **No automated test framework.** Per CLAUDE.md and the spec, manual probes are the only verification. The 6-width probe list in §6 is the gate. Adding Playwright is a separate spec.

**Compat notes:**

- **RN 0.81 + RNW 0.21 + React 19.1:** stable for `Modal`, `Animated`, `useWindowDimensions`. No new APIs needed.
- **`@gorhom/bottom-sheet`: REJECTED.** No web support; not worth introducing for one tier's sheet style.
- **`react-native-reanimated 4.1.1` + `react-native-gesture-handler 2.28.0`:** present but unused by the new code. Drag-to-dismiss could use them if added later, but Phase 1 doesn't.
- **`react-native-safe-area-context 5.6.0`:** already a transitive dep of React Navigation; safe to use directly. `useSafeAreaInsets()` is the entry point.
- **`expo-status-bar 3.0.9`:** the existing app already manages status bar; no changes.
- **`@dnd-kit/*`:** already gated to web via `React.lazy` in Sidebar; tablet rail has no dnd integration; no new dnd surfaces.

**Out-of-scope reminders for the implementer:**

- Don't touch `src/screens/AdminScreens.tsx` or `src/navigation/AppNavigator.tsx` (legacy / frozen).
- Don't modify `app.json` slug.
- Don't add tests (no framework wired up).
- Don't add `@gorhom/bottom-sheet` or any other bottom-sheet library.
- Don't change `useRealtimeSync.ts`, `db.ts`, `useStore.ts` slices, or any backend file.
- Don't touch `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, or the `npm run db` script.

## Files changed

### NEW
- `src/components/cmd/ResponsiveSheet.tsx` — canonical sheet wrapper. Per-tier presentation (right-drawer / bottom-sheet / fullscreen) via `useBreakpoint()`. Built on RN's `Modal` + `Animated.timing` slide; no new deps. Safe-area handling via `useSafeAreaInsets()` (phone only).
- `src/components/cmd/MobileTopAppBar.tsx` — 44 px-tall bar with hamburger button, section title, optional trailing slot. Top safe-area inset on native (web has it from the browser chrome).
- `src/components/cmd/RailSidebar.tsx` — 56 px icon-only sidebar rail rendering of the same `groups` data the full Sidebar consumes. Tablet-collapsed mode. Click the accent tile to expand. Edit-mode intentionally not surfaced (per architect §7 risk 5).
- `src/screens/cmd/ResponsiveCmdShell.tsx` — top-level shell. Owns section state, sidebar layout edit mode, mobile drawer open state, tablet rail-collapsed persistence, palette-action `section` swap. Branches sidebar presentation by breakpoint: phone → hamburger drawer; tablet → full Sidebar OR RailSidebar; desktop → permanent Sidebar.

### MODIFIED
- `src/theme/breakpoints.ts` — extended `Breakpoint` union to `'phone' | 'tablet' | 'desktop'`; added `BREAKPOINTS` constant + `useIsPhone()` / `useIsTablet()` / `useIsDesktop()` / `useIsCompact()` selectors. Native always returns `'phone'` (was `'mobile'`). Removed the stale "iPad landscape gets mobile" comment per architect §4.A. `DESKTOP_MIN_WIDTH = 1100` preserved.
- `src/lib/cmdSelectors.ts` — added `useDefaultSidebarGroups()` and `useRenderedSidebarGroups(editMode)`. Single source of truth for the sidebar tree, consumed by `Sidebar` (via shell), `RailSidebar` (via shell), and `MobileNavDrawer` (via shell). Selector returns the `DBInspector` row WITHOUT an `onPress` — the shell attaches `nav.navigate('DBInspector')`. Fixes the real bug where `NavDrawerScreen` ignored Spec 008's `sidebarLayoutOverride`.
- `src/navigation/CmdNavigator.tsx` — `MobileStack` removed; replaced with a single `ShellStack` that renders `ResponsiveCmdShell` on every breakpoint. `DBInspector` and `CmdAtomsPreview` stay as sibling stack screens. `CmdPaletteHost.handleNavigate` simplified — always uses `paletteAction` (the desktop in-screen state) instead of branching on breakpoint.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — chrome lifted to `ResponsiveCmdShell`. Now body-only: receives `section` + `setSection` as props; renders the section-dispatch tree, Inventory 3-pane (list + detail), EDIT drawer, items.tsv/catalog.tsv switch, palette-action consumption for Inventory-specific selectedName/viewMode, and the bottom CmdStatusBar. Sidebar / TitleBar / footer slots / Spec-008 edit-mode handlers all moved up.
- `src/components/cmd/IngredientFormDrawer.tsx` — wrapped in `ResponsiveSheet`. Hard-coded `width: 760` → `desktopWidth={760}`. Body flexDirection conditional on `useIsCompact()`; side pane (JsonPreview / AuditHistory) suppressed on phone. Phone shows an explicit ✕ close affordance in the header (no Esc key on phone).
- `src/components/cmd/VendorFormDrawer.tsx` — same treatment (`desktopWidth={540}`).

### DELETED
- `src/screens/cmd/NavDrawerScreen.tsx` — absorbed into `ResponsiveCmdShell`. The shell renders `MobileNavDrawer` directly with the lifted selector (so Spec 008 customization is honored on phone too) and attaches `onSelect` to its `setSection`.

### ORPHANED (kept on disk, header comment added; no longer imported)
- `src/screens/cmd/InventoryListScreen.tsx`
- `src/screens/cmd/ItemDetailScreen.tsx`
- `src/screens/cmd/ComingSoonScreen.tsx`

Per architect §4.B / §5, kept for potential native EAS reuse in Phase 3. Each file now starts with a header comment marking the orphan status and the rationale.

## Build notes

**Architect deviations:** none. Implementation follows §0–§7 as designed.

**Surprises while implementing:**

- The architect's §5 wording for `InventoryDesktopLayout` was slightly ambiguous ("becomes the body — Inventory-section-specific"). I interpreted this conservatively per §7 risk 1 (the explicit mitigation: "first lift the chrome to `ResponsiveCmdShell` while keeping the file's body intact"): the body keeps the section-dispatch tree (`section === 'Dashboard' ? ... : ...`) and the bottom `CmdStatusBar`, since both are section-aware and pulling them up to the shell would have inflated the diff. The shell still owns the section state — the body receives `section` + `setSection` as props and just renders for that selection. This minimizes regression surface.
- Two `SidebarGroup` interface declarations co-exist (one in `src/components/cmd/Sidebar.tsx`, one in `src/lib/sidebarLayout.ts`). They're structurally identical, and TypeScript's structural typing handles it. The shell mixes them (selector returns `sidebarLayout.SidebarGroup`; consumer Sidebar component expects `Sidebar.SidebarGroup`). This was already the case pre-Spec-011. Leaving as-is per "do not refactor adjacent code" — collapsing to one home is a follow-up.
- `TitleBar`'s `itemSlug` breadcrumb fragment (the "— rib_eye" tail when an Inventory item is selected on desktop) is no longer populated. The shell renders TitleBar without the fragment. Restoring it would require a body→shell signal (callback or store slice) that's out of scope for Phase 1 chrome work. Documented here as a Phase-2 follow-up — Inventory-section spec (012) is the natural place to re-publish the active item to the shell.

**Verification status:**

- `npx tsc --noEmit` — Spec 011 introduces **zero new typecheck errors**. The four errors flagged in the affected files (`IngredientFormDrawer.tsx:67`, `InventoryDesktopLayout.tsx:541/542/589`) all pre-exist on `main` (verified by stash-and-recheck). All other typecheck errors are in legacy / unrelated files (AdminScreens, AppNavigator, edge functions, etc.).
- **Bundle compilation** — exercised the Metro bundle endpoint at `http://localhost:8082/node_modules/expo/AppEntry.bundle?platform=web&dev=true`; HTTP 200 with 14 MB JS, no `BundlingError` / `UnableToResolveError` / `TransformError` strings. Confirmed: all four new files appear in the bundle (72 mentions of `ResponsiveCmdShell` / `MobileTopAppBar` / `RailSidebar` / `ResponsiveSheet` / `useIsPhone` / `useIsTablet` / `useIsDesktop` / `useIsCompact`). Confirmed: `NavDrawerScreen` and `MobileStack` are no longer in the import graph (only my own comment-string mentions remain).
- **Browser preview at 6 viewport widths (320 / 480 / 768 / 1024 / 1100 / 1280):** the `mcp__Claude_Preview__preview_*` tool family the user instructions mention is **not exposed in this agent's tool inventory** (only `Read`, `Write`, `Edit`, `Bash`, plus the `computer-use` and `claude-in-chrome` MCP families that aren't loaded into this conversation). I cannot drive the browser from here. Per the project's "verify in browser" memory note, the test-engineer reviewer should exercise the §6 probe list visually before SHIP_READY: Sidebar / RailSidebar / MobileTopAppBar swap at the 768 / 1100 boundaries; `IngredientFormDrawer` rendered as right-drawer on desktop, bottom-sheet on tablet, fullscreen on phone; `MobileNavDrawer` opens from the hamburger and consumes the lifted Spec-008 customizations. **I am explicitly flagging this verification gap rather than claiming it passed.**

**Phase-2 follow-ups (out of scope for Phase 1, surfaced for the per-section specs):**

- TitleBar `itemSlug` breadcrumb restoration (see "Surprises" above).
- The 3-pane Inventory body horizontally-scrolls on tablet portrait / phone — Phase 1 architect-approved default. The Inventory-section spec (012) is where the drill-down navigation lands.
- The tablet "collapse sidebar" toggle currently lives inside the Sidebar's `footerLeft` slot (a small `‹` button). When Spec 008's edit-mode is active, the toggle is still visible — clicking collapse mid-edit-mode discards the draft (because rail mode doesn't render edit affordances). Architect's §7 risk 5 already documented this trade-off; surfacing here as a UX rough edge for Phase-2 polish.
- `ComingSoonScreen.tsx` orphan file is a candidate for outright deletion now (its content is rendered inline by `InventoryDesktopLayout` via `<ComingSoonPanel>` for unimplemented sections). Architect chose to keep it for Phase 3 native parity; revisit after the EAS shipping decision.

## Cleanup bundle (applied 2026-05-09, pre-commit)

Applied inline after release-coordinator returned **SHIP_READY**. Bundle
synthesized 6 items from code-reviewer + test-engineer findings; ordered
by severity. All items applied + browser-verified at 1440 desktop and 360
phone widths. Zero new typecheck errors in any touched file.

- **Item 1** — `src/screens/cmd/ResponsiveCmdShell.tsx:219, :255`. Sidebar
  + rail sign-out buttons used `window.confirm` directly (silently auto-
  confirms on native — would skip the prompt entirely on iOS/Android in
  Phase 3). Replaced with `confirmAction(...)` from `src/utils/confirmAction.ts`.
- **Item 2** — `src/screens/cmd/ResponsiveCmdShell.tsx:69` and `:319-321`.
  The shell was importing `useBreakpoint()` and doing raw string
  comparison while every other touched file used the typed
  `useIsPhone/Tablet/Desktop` selectors. Internal inconsistency.
  Switched to the typed selectors at the top of the component; removed
  the redundant raw-string comparison block.
- **Item 3** — `src/lib/cmdSelectors.ts:1070-1077`. The exported
  `useRenderedSidebarGroups()` hook had zero call sites — the shell can't
  use it because it must attach the `DBInspector` `onPress` BEFORE the
  Spec 008 override merge, so the merge happens inline in the shell
  instead. Misleading export. Removed; updated the surrounding doc
  comment to explain why the merge isn't co-located. Dropped the
  now-unused `applySidebarOverride` import from `cmdSelectors.ts`.
- **Item 4** — `src/screens/cmd/ResponsiveCmdShell.tsx:111-116` (the
  `DBInspector` `onPress` attached to the lifted default groups). On
  web, `nav.navigate('DBInspector')` swaps the screen and the open
  drawer becomes invisible — unobservable issue. On native (Phase 3)
  the route push would render a one-frame flicker of the open drawer
  above the new screen. Added `setMobileDrawerOpen(false)` before
  `nav.navigate(...)` so close-then-navigate stays the contract on
  every platform.
- **Item 5** — `src/components/cmd/ResponsiveSheet.tsx:117`. The `Animated.timing`
  call passed `useNativeDriver: true` unconditionally, which logs the
  noisy "useNativeDriver is not supported because the native animated
  module is missing" warning on every sheet open under react-native-web.
  Architect §7 risk #3 explicitly covered this fallback path. Switched
  to `useNativeDriver: Platform.OS !== 'web'` so the native-driver win
  is preserved for Phase 3 (iOS/Android) without the dev-mode noise on
  web. Verified: opening + closing + re-opening EDIT drawer at phone
  width logs zero new warnings.
- **Item 6** — `src/screens/cmd/ComingSoonScreen.tsx:3`. Orphan-header
  comment cited the spec section incorrectly — `§5 (Files to create /
  modify)` is the correct location for the file lifecycle table, but
  the architect's decision to keep this file for Phase 3 native reuse
  lives at `§4.B (Open question B resolution)`. Updated the citation.

## Browser re-verification (2026-05-09, post-cleanup)

After applying the bundle, verified at desktop 1440 and phone 360 widths:

- Desktop chrome unchanged (sidebar, 3-pane Inventory, EDIT drawer
  right-anchored 760w with HISTORY side pane).
- Phone chrome unchanged (top app-bar with hamburger, items list,
  MobileNavDrawer slide-up).
- Sign-out flow now goes through `confirmAction` (verified by code
  inspection — `window.confirm` no longer present in the shell).
- `ResponsiveSheet` no longer logs `useNativeDriver` warning on open
  (verified via console-hook sentinel + open/close/re-open cycle —
  zero new warnings post-sentinel).
- The transient "An error occurred in <ResponsiveCmdShell>" warnings
  observed during the cleanup edits were HMR artifacts during file
  recompilation (React strict mode catching mid-save broken states).
  After hard reload, zero ResponsiveCmdShell errors.
- `npx tsc --noEmit` filtered to Spec-011-touched files: 0 errors.
  (One pre-existing latent TS error in `IngredientFormDrawer.tsx:67`
  is traceable to the Spec 010 cleanup — `expiryDate: v.expiryDate || null`
  produces `string | null` but `InventoryItem.expiryDate` is typed
  `string | undefined`. Runtime works. Type fix is out of scope for
  Spec 011 — surfaced separately for the user.)

## Handoff

next_agent: code-reviewer, security-auditor, test-engineer
prompt: Review the implementation of Spec 011 (responsive Cmd UI chrome,
  Phase 1). This is a pure frontend chrome/plumbing change — no backend,
  DB, edge function, RLS, or schema work was performed (and none was
  in scope). Read §5 (file lifecycle) and the implementation's `## Files
  changed` + `## Build notes` sections carefully — there's a verification
  gap flagged in build notes (the `mcp__Claude_Preview__*` tools weren't
  exposed to the implementer; test-engineer in particular should drive
  the §6 probe list at the 6 viewport widths before signing off). Each
  reviewer writes its findings to specs/011-responsive-admin-ui/reviews/
  <your-name>.md.
payload_paths:
  - specs/011-responsive-admin-ui.md
  - src/theme/breakpoints.ts
  - src/lib/cmdSelectors.ts
  - src/navigation/CmdNavigator.tsx
  - src/screens/cmd/ResponsiveCmdShell.tsx
  - src/screens/cmd/InventoryDesktopLayout.tsx
  - src/components/cmd/ResponsiveSheet.tsx
  - src/components/cmd/MobileTopAppBar.tsx
  - src/components/cmd/RailSidebar.tsx
  - src/components/cmd/IngredientFormDrawer.tsx
  - src/components/cmd/VendorFormDrawer.tsx
  - src/screens/cmd/InventoryListScreen.tsx
  - src/screens/cmd/ItemDetailScreen.tsx
  - src/screens/cmd/ComingSoonScreen.tsx
