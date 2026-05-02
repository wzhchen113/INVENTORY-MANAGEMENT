import React, { useCallback, useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { useStore } from '../store/useStore';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { useCmdColors } from '../theme/colors';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import InventoryListScreen from '../screens/cmd/InventoryListScreen';
import ItemDetailScreen from '../screens/cmd/ItemDetailScreen';
import ComingSoonScreen from '../screens/cmd/ComingSoonScreen';
import NavDrawerScreen from '../screens/cmd/NavDrawerScreen';
import CmdAtomsPreview from '../screens/dev/CmdAtomsPreview';

const RootStack = createStackNavigator();
const AuthedStack = createStackNavigator();

function AuthedNavigator() {
  const C = useCmdColors();
  const storeId = useStore((s) => s.currentStore?.id);

  // Reuse the existing realtime debounce pattern from AppStackNavigator —
  // multiple back-to-back changes collapse into a single reload.
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
    <AuthedStack.Navigator
      key={storeId}
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

export default function CmdNavigator() {
  const currentUser = useStore((s) => s.currentUser);

  return (
    <NavigationContainer>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {currentUser ? (
          <RootStack.Screen name="App" component={AuthedNavigator} />
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
