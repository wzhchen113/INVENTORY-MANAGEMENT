import React from 'react';
import { useNavigation } from '@react-navigation/native';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { Type } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useIsPhone, useIsTablet, useIsDesktop } from '../../theme/breakpoints';
import { useCommandPaletteIndex, useDefaultSidebarGroups } from '../../lib/cmdSelectors';
import { applySidebarOverride, produceOverride } from '../../lib/sidebarLayout';
import type { SidebarGroup } from '../../lib/sidebarLayout';
import { usePaletteAction } from '../../lib/paletteAction';
import { Sidebar } from '../../components/cmd/Sidebar';
import { RailSidebar } from '../../components/cmd/RailSidebar';
import { MobileTopAppBar } from '../../components/cmd/MobileTopAppBar';
import { MobileNavDrawer } from '../../components/cmd/MobileNavDrawer';
import { TitleBar } from '../../components/cmd/TitleBar';
import { StoreSwitchOverlay } from '../../components/cmd/StoreSwitchOverlay';
import { ThemeToggle } from '../../components/cmd/ThemeToggle';
import { LocaleSwitcher } from '../../components/cmd/LocaleSwitcher';
import { NotificationToggle } from '../../components/cmd/NotificationToggle';
import { BrandPicker } from '../../components/cmd/BrandPicker';
import { useIsSuperAdmin } from '../../hooks/useRole';
import { useT } from '../../hooks/useT';
import { confirmAction } from '../../utils/confirmAction';
import { APP_VERSION } from '../../utils/version';
import InventoryDesktopLayout from './InventoryDesktopLayout';

// Spec 011 §2 — top-level chrome wrapper. Owns:
//   - the section state (which sidebar entry is active)
//   - the sidebar layout edit-mode (Spec 008)
//   - the rendered group structure (default + per-user override)
//   - the breakpoint branch (Sidebar / RailSidebar / MobileNavDrawer)
//   - the mobile drawer open state
//   - the tablet rail-collapsed persistence
//   - the palette-action `section` swap (selectedName / viewMode stay
//     inside the body, since they're Inventory-section-specific)
//
// `InventoryDesktopLayout` is the body — it now receives the active
// section as a prop and renders the section-dispatch tree (it owns the
// Inventory 3-pane, EDIT drawer, items.tsv/catalog.tsv switch, and the
// per-section `selectedName`).
//
// `DBInspector` is a sibling stack screen (kept by `CmdNavigator.tsx`);
// the shell attaches `nav.navigate('DBInspector')` to that sidebar item
// since the lifted selector is decoupled from React Navigation.

const TABLET_COLLAPSED_KEY = 'imr.cmd.sidebar.tabletCollapsed';

/** Read tablet sidebar collapsed pref from localStorage. Web only;
 *  native always returns false (rail mode never reaches native). */
function readTabletCollapsed(): boolean {
  if (Platform.OS !== 'web') return false;
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem(TABLET_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeTabletCollapsed(v: boolean) {
  if (Platform.OS !== 'web') return;
  try {
    window.localStorage?.setItem(TABLET_COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    // localStorage unavailable (e.g. private mode) — fail silently.
  }
}

interface Props {
  onPaletteOpen?: () => void;
}

export default function ResponsiveCmdShell({ onPaletteOpen }: Props) {
  const C = useCmdColors();
  const T = useT();
  const nav = useNavigation<any>();
  const isPhone = useIsPhone();
  const isTablet = useIsTablet();
  const isDesktop = useIsDesktop();

  const currentUser = useStore((s) => s.currentUser);
  const logout = useStore((s) => s.logout);
  const currentStore = useStore((s) => s.currentStore);
  // Spec 111 — full-screen switch takeover. Single-field gate: the overlay
  // renders iff `switching !== null` (a background realtime reload toggles
  // storeLoading but never switching, so it never paints here). Cleared in
  // loadFromSupabase's finally on both success and error.
  const switching = useStore((s) => s.switching);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const stores = useStore((s) => s.stores);
  // Spec 012b — super-admin gate for the header brand picker.
  const isSuperAdmin = useIsSuperAdmin();
  const brandPickerSlot = isSuperAdmin ? <BrandPicker /> : null;
  const brandPickerCompact = isSuperAdmin ? <BrandPicker compact /> : null;

  // Spec 008 — per-user sidebar layout override.
  const sidebarLayoutOverride = useStore((s) => s.sidebarLayoutOverride);
  const setSidebarLayoutOverride = useStore((s) => s.setSidebarLayoutOverride);

  // Section state — owned by the shell.
  const [section, setSection] = React.useState('Inventory');

  // Spec 008 — sidebar edit mode (gear → DONE).
  const [sidebarEditMode, setSidebarEditMode] = React.useState(false);
  const [draftGroups, setDraftGroups] = React.useState<SidebarGroup[] | null>(null);

  // Mobile drawer (phone hamburger).
  const [mobileDrawerOpen, setMobileDrawerOpen] = React.useState(false);
  const [paletteQuery, setPaletteQuery] = React.useState('');

  // Tablet sidebar collapsed pref (rail vs full Sidebar).
  const [tabletCollapsed, setTabletCollapsed] = React.useState<boolean>(() => readTabletCollapsed());
  React.useEffect(() => {
    writeTabletCollapsed(tabletCollapsed);
  }, [tabletCollapsed]);

  // Palette command index (used by the mobile drawer search field).
  const paletteIndex = useCommandPaletteIndex();

  // ─── Lifted default groups (Spec 011 §4.C) ───────────────────────
  // The selector returns groups WITHOUT an onPress for `DBInspector` —
  // we attach navigation here so the selector stays decoupled from
  // React Navigation. Close the mobile drawer before pushing the route
  // so native (Phase 3) doesn't render a one-frame flicker of the open
  // drawer above the new screen.
  const defaultGroupsRaw = useDefaultSidebarGroups();
  const defaultGroups = React.useMemo<SidebarGroup[]>(
    () =>
      defaultGroupsRaw.map((g) => ({
        label: g.label,
        items: g.items.map((it) =>
          it.id === 'DBInspector'
            ? {
                ...it,
                onPress: () => {
                  setMobileDrawerOpen(false);
                  nav.navigate('DBInspector');
                },
              }
            : it,
        ),
      })),
    [defaultGroupsRaw, nav],
  );

  // Merge with the Spec 008 override. In edit mode, hidden items are kept
  // visible (with `hiddenByUser` flag) so the edit UI can unhide them.
  const renderedGroups = React.useMemo(
    () =>
      applySidebarOverride(defaultGroups, sidebarLayoutOverride ?? null, {
        editMode: sidebarEditMode,
      }),
    [defaultGroups, sidebarLayoutOverride, sidebarEditMode],
  );

  // Working copy for edit-mode drag/eye-toggle mutations.
  const groupsForSidebar = sidebarEditMode ? (draftGroups ?? renderedGroups) : renderedGroups;

  const handleToggleEditMode = React.useCallback(() => {
    setSidebarEditMode((prev) => {
      if (!prev) {
        // Entering — seed the draft from the edit-mode merged view.
        const editView = applySidebarOverride(
          defaultGroups,
          sidebarLayoutOverride ?? null,
          { editMode: true },
        );
        setDraftGroups(editView);
        return true;
      }
      // Exiting (DONE) — diff and save.
      if (draftGroups) {
        const next = produceOverride(draftGroups, defaultGroups);
        setSidebarLayoutOverride(next);
      }
      setDraftGroups(null);
      return false;
    });
  }, [defaultGroups, sidebarLayoutOverride, draftGroups, setSidebarLayoutOverride]);

  const handleGroupsChange = React.useCallback((next: SidebarGroup[]) => {
    setDraftGroups(next);
  }, []);

  const handleToggleHide = React.useCallback(
    (id: string) => {
      setDraftGroups((prev) => {
        const base =
          prev ??
          applySidebarOverride(defaultGroups, sidebarLayoutOverride ?? null, {
            editMode: true,
          });
        return base.map((g) => ({
          label: g.label,
          items: g.items.map((it) =>
            it.id === id
              ? { ...it, hiddenByUser: !(it as any).hiddenByUser }
              : it,
          ),
        }));
      });
    },
    [defaultGroups, sidebarLayoutOverride],
  );

  const handleReset = React.useCallback(() => {
    confirmAction(
      T('sidebar.actions.resetConfirmTitle'),
      T('sidebar.actions.resetConfirmBody'),
      () => {
        setSidebarLayoutOverride(null);
        setDraftGroups(null);
        setSidebarEditMode(false);
      },
    );
  }, [setSidebarLayoutOverride, T]);

  // ─── Palette-action bridge (shell-level: section swap only) ──────
  // The body handles selectedName + viewMode + eodFocusItemId. We only
  // own the section here; consume() is left to the body when an
  // EOD-focus action is in flight.
  const pendingPaletteAction = usePaletteAction((s) => s.pending);
  React.useEffect(() => {
    if (!pendingPaletteAction) return;
    setSection(pendingPaletteAction.section);
  }, [pendingPaletteAction]);

  // Section selection: when the user picks something from the sidebar /
  // drawer, switch sections. (selectedName reset on section change is
  // owned by the body — it's an Inventory-section concern.)
  const handleSectionSelect = React.useCallback((id: string) => {
    setSection(id);
  }, []);

  // ─── Footer slots (sign out + theme + EOD count) ─────────────────
  const todayStr = new Date().toISOString().slice(0, 10);
  const submittedToday = new Set(
    eodSubmissions.filter((s) => s.date === todayStr).map((s) => s.storeId),
  ).size;

  const sidebarFooterLeft = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <Text
        style={[Type.statusBar, { color: C.fg3, flexShrink: 1, minWidth: 0 }]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        ● {currentUser?.name || T('chrome.guest')}
      </Text>
      <TouchableOpacity
        onPress={() => confirmAction(T('chrome.signOutConfirm'), T('chrome.signOutBody'), logout)}
        accessibilityRole="button"
        accessibilityLabel={T('chrome.signOutAria')}
        style={{
          paddingHorizontal: 6,
          paddingVertical: 1,
          borderRadius: CmdRadius.xs,
          borderWidth: 1,
          borderColor: C.border,
          flexShrink: 0,
        }}
      >
        <Text style={[Type.statusBar, { color: C.fg3 }]}>{T('chrome.signOut')}</Text>
      </TouchableOpacity>
    </View>
  );

  const sidebarFooterRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={[Type.statusBar, { color: C.fg3 }]}>
        {T('chrome.eodFooter', { submittedCount: submittedToday, totalCount: stores.length })}
      </Text>
    </View>
  );

  // Rail footer: per-device notification toggle + locale switcher + sign-out.
  // Theme toggle lives in the TitleBar's top-right cluster (next to the brand
  // picker), not duplicated here.
  const railFooter = (
    <View style={{ alignItems: 'center', gap: 6 }}>
      <NotificationToggle />
      <LocaleSwitcher />
      <TouchableOpacity
        onPress={() => confirmAction(T('chrome.signOutConfirm'), T('chrome.signOutBody'), logout)}
        accessibilityRole="button"
        accessibilityLabel={T('chrome.signOutAria')}
        hitSlop={6}
      >
        <Text style={[Type.statusBar, { color: C.fg3 }]}>↩</Text>
      </TouchableOpacity>
    </View>
  );

  // ─── Mobile drawer palette results (lifted from NavDrawerScreen) ─
  const paletteMatches = React.useMemo(() => {
    if (!paletteQuery.trim()) return [];
    const q = paletteQuery.toLowerCase();
    return paletteIndex
      .filter((e) => e.label.toLowerCase().includes(q))
      .slice(0, 5);
  }, [paletteQuery, paletteIndex]);

  const paletteResults = paletteMatches.length > 0 ? (
    <View style={{ gap: 4 }}>
      {paletteMatches.map((m) => (
        <TouchableOpacity
          key={`${m.type}:${m.id}`}
          activeOpacity={0.85}
          onPress={() => {
            // Phone palette → write the same paletteAction the desktop
            // uses, then close the drawer. The body picks up
            // selectedName / EOD-focus from paletteAction; the shell
            // picks up section.
            const route = m.route;
            if (route.name === 'ItemDetail') {
              const itemId = (route.params as any)?.itemId;
              const itemName = m.label.toLowerCase();
              usePaletteAction.getState().request({
                section: 'Inventory',
                selectedName: itemId ? itemName : null,
              });
            } else if (route.name === 'Inventory') {
              usePaletteAction.getState().request({
                section: 'Inventory',
                selectedName: null,
              });
            } else {
              usePaletteAction.getState().request({
                section: route.name,
                selectedName: null,
              });
            }
            setMobileDrawerOpen(false);
            setPaletteQuery('');
          }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}
        >
          <Text style={{ fontSize: 9.5, color: C.fg3, width: 56, textTransform: 'uppercase' }}>
            {m.type}
          </Text>
          <Text style={{ fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
            {m.label}
          </Text>
          <Text style={{ fontSize: 10, color: C.fg3 }}>
            {m.id.slice(0, 8)}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  ) : null;

  // ─── Tier rendering ──────────────────────────────────────────────
  // (isPhone / isTablet / isDesktop are derived from the typed selectors
  // declared at the top of this component, per Spec 011 cleanup.)

  // The body — InventoryDesktopLayout now takes section + setSection.
  const Body = (
    <InventoryDesktopLayout
      section={section}
      setSection={setSection}
      onPaletteOpen={onPaletteOpen}
    />
  );

  // Spec 111 — full-screen switch takeover. Mounted as the LAST child of
  // each of the three cmd-shell-root Views below (RN has no shared parent
  // across the three `return`s, so this element is inserted per branch).
  // Covers TitleBar/MobileTopAppBar + sidebar + body via absolute fill.
  // Gated on `switching !== null`; passes the narrowed value as `mode`.
  const switchOverlay = switching !== null ? <StoreSwitchOverlay mode={switching} /> : null;

  if (isPhone) {
    // Phone: top app-bar + body. Sidebar is the hamburger-driven
    // MobileNavDrawer. TitleBar is replaced with MobileTopAppBar (per §2).
    return (
      <View testID="cmd-shell-root" style={{ flex: 1, backgroundColor: C.bg, overflow: 'hidden' }}>
        <MobileTopAppBar
          onHamburgerPress={() => setMobileDrawerOpen(true)}
          title={section}
          trailing={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {brandPickerCompact}
              <NotificationToggle />
              <ThemeToggle />
            </View>
          }
        />
        <View style={{ flex: 1, minHeight: 0 }}>{Body}</View>
        <MobileNavDrawer
          visible={mobileDrawerOpen}
          onClose={() => setMobileDrawerOpen(false)}
          groups={groupsForSidebar}
          selectedId={section}
          onSelect={(id) => {
            handleSectionSelect(id);
            setMobileDrawerOpen(false);
          }}
          paletteQuery={paletteQuery}
          onPaletteChange={setPaletteQuery}
          paletteResults={paletteResults}
          subtitle={`${currentUser?.email || T('chrome.guest')} · ${APP_VERSION}`}
          footerLeft={sidebarFooterLeft}
          footerRight={sidebarFooterRight}
        />
        {switchOverlay}
      </View>
    );
  }

  if (isTablet) {
    // Tablet: TitleBar + (Sidebar OR RailSidebar) + body. Hamburger in
    // the TitleBar slot is implicit via a small toggle button at the top
    // of the sidebar/rail (we put a collapse toggle in the rail header
    // and a collapse toggle in the Sidebar header). For Phase 1, we add
    // a small inline toggle button just above the body.
    return (
      <View testID="cmd-shell-root" style={{ flex: 1, backgroundColor: C.bg, overflow: 'hidden' }}>
        <TitleBar
          storeName={currentStore?.name || T('chrome.store')}
          section={section}
          brandPicker={brandPickerSlot}
        />
        <View style={{ flex: 1, flexDirection: 'row', overflow: 'hidden', minHeight: 0 }}>
          {tabletCollapsed ? (
            <RailSidebar
              groups={groupsForSidebar}
              selectedId={section}
              onSelect={handleSectionSelect}
              onExpand={() => setTabletCollapsed(false)}
              footerSlot={railFooter}
            />
          ) : (
            <Sidebar
              groups={groupsForSidebar}
              selectedId={section}
              onSelect={handleSectionSelect}
              onPaletteOpen={onPaletteOpen}
              editMode={sidebarEditMode}
              onToggleEditMode={handleToggleEditMode}
              onGroupsChange={handleGroupsChange}
              onToggleHide={handleToggleHide}
              onReset={handleReset}
              footerLeft={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {sidebarFooterLeft}
                  <TouchableOpacity
                    onPress={() => setTabletCollapsed(true)}
                    accessibilityRole="button"
                    accessibilityLabel={T('sidebar.actions.collapseAria')}
                    hitSlop={4}
                    style={{
                      paddingHorizontal: 4,
                      paddingVertical: 1,
                      borderRadius: CmdRadius.xs,
                      borderWidth: 1,
                      borderColor: C.border,
                    }}
                  >
                    <Text style={[Type.statusBar, { color: C.fg3 }]}>‹</Text>
                  </TouchableOpacity>
                </View>
              }
              footerRight={sidebarFooterRight}
            />
          )}
          <View style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{Body}</View>
        </View>
        {switchOverlay}
      </View>
    );
  }

  // Desktop — TitleBar + permanent Sidebar + body. Mirrors pre-Spec-011
  // chrome 1:1.
  return (
    <View testID="cmd-shell-root" style={{ flex: 1, backgroundColor: C.bg, overflow: 'hidden' }}>
      <TitleBar
        storeName={currentStore?.name || 'store'}
        section={section}
        brandPicker={brandPickerSlot}
      />
      <View style={{ flex: 1, flexDirection: 'row', overflow: 'hidden', minHeight: 0 }}>
        <Sidebar
          groups={groupsForSidebar}
          selectedId={section}
          onSelect={handleSectionSelect}
          onPaletteOpen={onPaletteOpen}
          editMode={sidebarEditMode}
          onToggleEditMode={handleToggleEditMode}
          onGroupsChange={handleGroupsChange}
          onToggleHide={handleToggleHide}
          onReset={handleReset}
          footerLeft={sidebarFooterLeft}
          footerRight={sidebarFooterRight}
        />
        <View style={{ flex: 1, minHeight: 0 }}>{Body}</View>
      </View>
      {switchOverlay}
    </View>
  );
}
