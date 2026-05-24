import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { useStore } from '../store/useStore';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { useCmdColors } from '../theme/colors';
import { useCommandPaletteIndex, PaletteEntry } from '../lib/cmdSelectors';
import { usePaletteAction } from '../lib/paletteAction';
import { CommandPalette } from '../components/cmd/CommandPalette';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import ResponsiveCmdShell from '../screens/cmd/ResponsiveCmdShell';
import CmdAtomsPreview from '../screens/dev/CmdAtomsPreview';
import DBInspectorScreen from '../screens/DBInspectorScreen';

const navRef = createNavigationContainerRef();

const RootStack = createStackNavigator();
const AuthedStack = createStackNavigator();

// Spec 011 — single navigator stack across all breakpoints. The
// `ResponsiveCmdShell` owns the breakpoint branch (sidebar / rail /
// hamburger drawer) and the section state. `MobileStack` (the legacy
// real-stack navigation for narrow widths) is retired — it routed most
// sidebar items to `ComingSoonScreen` and ignored Spec 008's per-user
// sidebar override. The shell consumes the same lifted selector
// (`useDefaultSidebarGroups`) on every tier, so the override is
// honored on phone too.
//
// `DBInspector` stays as a sibling stack route — the lifted selector
// returns the row without an `onPress`, the shell attaches
// `nav.navigate('DBInspector')`. `CmdAtomsPreview` stays as a dev-only
// sibling.
function ShellStack() {
  const C = useCmdColors();
  return (
    <AuthedStack.Navigator
      screenOptions={{
        headerShown: false,
        // flex:1 + minHeight:0 so the screen card is bounded by the
        // navigator's available height instead of auto-sizing to content
        // (which broke list-pane scrolling at sections with long lists).
        cardStyle: { backgroundColor: C.bg, flex: 1, minHeight: 0 },
      }}
    >
      <AuthedStack.Screen name="Shell" component={ResponsiveCmdShell} />
      <AuthedStack.Screen name="DBInspector" component={DBInspectorScreen} />
      {__DEV__ ? (
        <AuthedStack.Screen name="CmdAtomsPreview" component={CmdAtomsPreview} />
      ) : null}
    </AuthedStack.Navigator>
  );
}

function AuthedRoot() {
  const storeId = useStore((s) => s.currentStore?.id);
  const brandId = useStore((s) => s.brand?.id);

  // Shared realtime debounce.
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSync = useCallback(() => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      const sid = useStore.getState().currentStore?.id;
      if (sid) useStore.getState().loadFromSupabase(sid);
    }, 400);
  }, []);
  useEffect(() => () => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
  }, []);
  useRealtimeSync(storeId, handleSync, brandId);

  return (
    <>
      <ShellStack />
      <CmdPaletteHost />
    </>
  );
}

// Web-only ⌘K palette. Listens for keydown at the document level. Phone
// users (no hardware keyboard) never trigger it; the MobileNavDrawer's
// search field is the phone palette entry.
//
// Spec 011 — the desktop "in-screen state" (paletteAction) is now the
// single delivery channel on every tier; ResponsiveCmdShell consumes
// it for the section swap, and InventoryDesktopLayout consumes the
// Inventory-specific selectedName/viewMode bits. The pre-Spec-011
// branch on breakpoint is gone.
function CmdPaletteHost() {
  const index = useCommandPaletteIndex();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'p' || e.key === 'K' || e.key === 'P')) {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Map palette result → shell section + selection.
  const actionForRoute = useCallback((route: PaletteEntry['route']) => {
    if (route.name === 'ItemDetail') {
      const itemId = (route.params as any)?.itemId;
      const item = itemId ? useStore.getState().inventory.find((i) => i.id === itemId) : undefined;
      return { section: 'Inventory', selectedName: item ? item.name.toLowerCase() : null };
    }
    if (route.name === 'Inventory') return { section: 'Inventory', selectedName: null };
    return { section: route.name, selectedName: null };
  }, []);

  const handleNavigate = useCallback((route: PaletteEntry['route']) => {
    usePaletteAction.getState().request(actionForRoute(route));
  }, [actionForRoute]);

  if (Platform.OS !== 'web') return null;
  return (
    <CommandPalette
      visible={visible}
      onClose={() => setVisible(false)}
      onNavigate={handleNavigate}
      index={index}
      scopeHint="items, recipes, vendors, screens"
    />
  );
}

/**
 * Spec 063 — the inner navigator body, exported separately from the
 * standalone default export. `RoleRouter` mounts the SINGLE
 * `<NavigationContainer>` for the merged admin+staff app and renders
 * `AdminStack` inside that container when an admin session is active.
 *
 * The render tree is identical to the pre-merge default export — only
 * the container ownership moves up one level. `currentUser` still
 * gates the Login/Register vs. AuthedRoot fork; RoleRouter only mounts
 * this component when an admin/master/super_admin session exists, so
 * in practice the `currentUser` truthy branch is what renders.
 * The Login/Register branch is preserved for the standalone default
 * export (rollback safety) and for the unlikely race where
 * `currentUser` transiently flips back to null while AdminStack is
 * mounted.
 */
export function AdminStack() {
  const currentUser = useStore((s) => s.currentUser);
  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      {currentUser ? (
        <RootStack.Screen name="App" component={AuthedRoot} />
      ) : (
        <>
          <RootStack.Screen name="Login" component={LoginScreen} />
          <RootStack.Screen name="Register" component={RegisterScreen} />
        </>
      )}
    </RootStack.Navigator>
  );
}

/**
 * Standalone-mounted CmdNavigator — wraps `AdminStack` in its own
 * `<NavigationContainer>` for back-compat. Spec 063 introduces
 * `RoleRouter` as the new App.tsx mount point; this default export is
 * preserved so a future rollback (or a dev tool that imports
 * `CmdNavigator` directly) keeps working without code changes.
 */
export default function CmdNavigator() {
  return (
    <NavigationContainer ref={navRef}>
      <AdminStack />
    </NavigationContainer>
  );
}
