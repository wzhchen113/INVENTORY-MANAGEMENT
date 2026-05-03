import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { useStore } from '../store/useStore';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { useCmdColors } from '../theme/colors';
import { useBreakpoint } from '../theme/breakpoints';
import { useRole } from '../hooks/useRole';
import { useCommandPaletteIndex, PaletteEntry } from '../lib/cmdSelectors';
import { usePaletteAction } from '../lib/paletteAction';
import { CommandPalette } from '../components/cmd/CommandPalette';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import InventoryListScreen from '../screens/cmd/InventoryListScreen';
import ItemDetailScreen from '../screens/cmd/ItemDetailScreen';
import ComingSoonScreen from '../screens/cmd/ComingSoonScreen';
import NavDrawerScreen from '../screens/cmd/NavDrawerScreen';
import InventoryDesktopLayout from '../screens/cmd/InventoryDesktopLayout';
import CmdAtomsPreview from '../screens/dev/CmdAtomsPreview';

const navRef = createNavigationContainerRef();

const RootStack = createStackNavigator();
const AuthedStack = createStackNavigator();

function MobileStack() {
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
      <AuthedStack.Screen name="Inventory" component={InventoryListScreen} />
      <AuthedStack.Screen name="ItemDetail" component={ItemDetailScreen} />
      <AuthedStack.Screen
        name="ComingSoon"
        component={ComingSoonScreen}
        initialParams={{ sectionName: 'Section' }}
      />
      <AuthedStack.Screen
        name="Drawer"
        component={NavDrawerScreen}
        options={{ presentation: 'transparentModal', cardStyle: { backgroundColor: 'transparent' } }}
      />
      {__DEV__ ? (
        <AuthedStack.Screen name="CmdAtomsPreview" component={CmdAtomsPreview} />
      ) : null}
    </AuthedStack.Navigator>
  );
}

// Single-screen stack so InventoryDesktopLayout sits inside a NavigationContainer
// child and can use any nav APIs in the future. Today it doesn't need them
// (sidebar tree clicks update local state), but keeping the wrapper avoids
// re-plumbing later.
function DesktopShell() {
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
      <AuthedStack.Screen name="DesktopLayout" component={InventoryDesktopLayout} />
    </AuthedStack.Navigator>
  );
}

function AuthedRoot() {
  const storeId = useStore((s) => s.currentStore?.id);
  const breakpoint = useBreakpoint();

  // Shared realtime debounce (mobile + desktop both consume).
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
  useRealtimeSync(storeId, handleSync);

  return (
    <>
      {breakpoint === 'desktop' ? <DesktopShell /> : <MobileStack />}
      <CmdPaletteHost />
    </>
  );
}

// Web-only ⌘K palette. Listens for keydown at the document level and
// navigates via the container ref so it can fire from any screen.
function CmdPaletteHost() {
  const role = useRole();
  const index = useCommandPaletteIndex(role);
  const breakpoint = useBreakpoint();
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

  // Map palette result → desktop section + selection. Desktop is a single
  // screen with local state, so we go through paletteAction instead of
  // react-navigation routes (which only register a top-level DesktopLayout).
  const desktopActionForRoute = useCallback((route: PaletteEntry['route']) => {
    if (route.name === 'ItemDetail') {
      const itemId = (route.params as any)?.itemId;
      const item = itemId ? useStore.getState().inventory.find((i) => i.id === itemId) : undefined;
      return { section: 'Inventory', selectedName: item ? item.name.toLowerCase() : null };
    }
    if (route.name === 'Inventory') return { section: 'Inventory', selectedName: null };
    return { section: route.name, selectedName: null };
  }, []);

  const handleNavigate = useCallback((route: PaletteEntry['route']) => {
    if (breakpoint === 'desktop') {
      usePaletteAction.getState().request(desktopActionForRoute(route));
      return;
    }
    if (!navRef.isReady()) return;
    const dispatch = (name: string, params?: Record<string, unknown>) =>
      (navRef as any).navigate(name, params);
    if (route.name === 'Inventory' || route.name === 'ItemDetail' || route.name === 'ComingSoon') {
      dispatch(route.name, route.params);
      return;
    }
    dispatch('ComingSoon', { sectionName: route.name });
  }, [breakpoint, desktopActionForRoute]);

  if (Platform.OS !== 'web') return null;
  return (
    <CommandPalette
      visible={visible}
      onClose={() => setVisible(false)}
      onNavigate={handleNavigate}
      index={index}
      scopeHint={role === 'staff' ? 'items, recipes' : 'items, recipes, vendors, screens'}
    />
  );
}

export default function CmdNavigator() {
  const currentUser = useStore((s) => s.currentUser);

  return (
    <NavigationContainer ref={navRef}>
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
    </NavigationContainer>
  );
}
