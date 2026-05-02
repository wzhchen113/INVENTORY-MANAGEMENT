import React, { useCallback, useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { useStore } from '../store/useStore';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { useCmdColors } from '../theme/colors';
import { useBreakpoint } from '../theme/breakpoints';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import InventoryListScreen from '../screens/cmd/InventoryListScreen';
import ItemDetailScreen from '../screens/cmd/ItemDetailScreen';
import ComingSoonScreen from '../screens/cmd/ComingSoonScreen';
import NavDrawerScreen from '../screens/cmd/NavDrawerScreen';
import InventoryDesktopLayout from '../screens/cmd/InventoryDesktopLayout';
import CmdAtomsPreview from '../screens/dev/CmdAtomsPreview';

const RootStack = createStackNavigator();
const AuthedStack = createStackNavigator();

function MobileStack() {
  const C = useCmdColors();
  return (
    <AuthedStack.Navigator
      screenOptions={{
        headerShown: false,
        cardStyle: { backgroundColor: C.bg },
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
        cardStyle: { backgroundColor: C.bg },
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

  return breakpoint === 'desktop' ? <DesktopShell /> : <MobileStack />;
}

export default function CmdNavigator() {
  const currentUser = useStore((s) => s.currentUser);

  return (
    <NavigationContainer>
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
