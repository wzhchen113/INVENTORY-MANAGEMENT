// src/screens/staff/navigation/StaffStack.tsx — staff inner stack.
//
// Spec 063 — renamed from `RootStack` to `StaffStack`. The
// `<NavigationContainer>` ownership moves up to `RoleRouter`
// ([src/navigation/RoleRouter.tsx](src/navigation/RoleRouter.tsx)),
// which mounts the single container for the merged app. StaffStack
// returns only the inner `<Stack.Navigator>` body so RoleRouter can
// render it under the shared container.
//
// Cold-start session restore was previously folded inside this
// component. Spec 063 §6 / R4 moves it to App.tsx's `getSession()`
// useEffect, branching on `profiles.role` to dispatch to either the
// admin or staff seeding path. The pure cold-start helper now lives
// at `src/lib/sessionRestore.ts` so the StaffStack tests can continue
// to import and exercise it.
//
// Spec 062 §6 render-branch contract — unchanged:
//
//   authState.kind === 'restoring' / 'idle' / 'signing-in' / 'gating'
//     → minimal splash loader.
//   authState.kind === 'signed-in' AND activeStore is null AND stores.length > 1
//     → StorePicker.
//   authState.kind === 'signed-in' AND activeStore is set
//     → EODCount.
//   authState.kind === 'signed-in' AND activeStore is null AND stores.length === 1
//     → auto-select sole store (handled inside SignIn / restore flow).
//
// The `signed-out` branch is owned by RoleRouter (shared sign-in
// portal at `src/screens/LoginScreen.tsx`); StaffStack only mounts
// when a staff user is already past the gate. Defensive Splash is
// retained for the transient `restoring` / `signing-in` / `gating`
// states.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { StorePicker } from '../screens/StorePicker';
import { EODCount } from '../screens/EODCount';
import { Reorder } from '../screens/Reorder';
import { WeeklyCount } from '../screens/WeeklyCount';
import { Receiving } from '../screens/Receiving';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useStaffStore } from '../store/useStaffStore';
import { useI18n } from '../i18n';
import { spacing, typography, useStaffColors } from '../theme';

// Re-export the cold-start helper so callers (App.tsx + StaffStack.test.tsx)
// can target one canonical implementation. Spec 063 §11.2.
export { restoreSession } from '../../../lib/sessionRestore';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

function Splash() {
  const c = useStaffColors();
  return (
    <View style={[styles.splash, { backgroundColor: c.bg }]}>
      <Text style={[styles.splashTitle, { color: c.text }]}>I.M.R Staff</Text>
      <ActivityIndicator color={c.primary} />
    </View>
  );
}

// Spec 089 (E) — the staff app's first multi-destination navigation: a
// bottom tab bar (Count | Reorder) for the signed-in + active-store branch.
// Themed via `useStaffColors()` (active = primary, inactive =
// textSecondary, bar bg = surface, top border = border) so it matches the
// OS-light/dark staff theme — a default RN tab bar would flash white in
// dark mode (same concern the `cardStyle` comment below documents). Both
// screens own their own header (store name + sign-out + switch-store), so
// sign-out is NOT lifted into the tab bar.
function StaffTabs() {
  const c = useStaffColors();
  // Subscribe to the locale so React Navigation recomputes the tab
  // `tabBarLabel`/accessibility options when the language changes (spec
  // 099 — the bare `t()` is a snapshot and would leave stale labels).
  const { t } = useI18n();
  return (
    <Tab.Navigator
      // sceneContainerStyle is a Navigator-level prop in bottom-tabs v6 — it
      // keeps the tab scene background on the staff `c.bg` so it doesn't
      // flash white in dark mode (mirrors the stack `cardStyle` below).
      sceneContainerStyle={{ backgroundColor: c.bg }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textSecondary,
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopColor: c.border,
        },
      }}
    >
      <Tab.Screen
        name="EODCount"
        component={EODCount}
        options={{
          tabBarLabel: t('eodTab.label'),
          tabBarAccessibilityLabel: t('eodTab.label'),
          tabBarTestID: 'staff-tab-eod',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="clipboard-outline" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Reorder"
        component={Reorder}
        options={{
          tabBarLabel: t('reorder.tabLabel'),
          tabBarAccessibilityLabel: t('reorder.tabLabel'),
          tabBarTestID: 'staff-tab-reorder',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="cart-outline" size={size} color={color} />
          ),
        }}
      />
      {/* Spec 098 — the weekly full-store count tab. Visually distinct via
          the calendar icon (vs the EOD clipboard / Reorder cart). */}
      <Tab.Screen
        name="WeeklyCount"
        component={WeeklyCount}
        options={{
          tabBarLabel: t('weekly.tabLabel'),
          tabBarAccessibilityLabel: t('weekly.tabLabel'),
          tabBarTestID: 'staff-tab-weekly',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" size={size} color={color} />
          ),
        }}
      />
      {/* Spec 113 — the staff receiving tab (receive deliveries against open
          POs). Visually distinct via the cube "receipt/delivery" icon (vs the
          EOD clipboard / Reorder cart / Weekly calendar). */}
      <Tab.Screen
        name="Receiving"
        component={Receiving}
        options={{
          tabBarLabel: t('receiving.tabLabel'),
          tabBarAccessibilityLabel: t('receiving.tabLabel'),
          tabBarTestID: 'staff-tab-receiving',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="cube-outline" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

export function StaffStack() {
  const c = useStaffColors();
  const authState = useStaffStore((s) => s.authState);
  const activeStore = useStaffStore((s) => s.activeStore);

  // Scene background scoped to the staff navigator ONLY (spec 070 §7) —
  // NOT a NavigationContainer `theme` prop. The container lives in
  // RoleRouter and is shared with the admin stack; theming it there
  // would bleed into AdminStack. Setting `cardStyle` here keeps React
  // Navigation's default white scene from flashing behind a dark-mode
  // screen during transitions.
  const screenOptions = {
    headerShown: false,
    cardStyle: { backgroundColor: c.bg },
  } as const;

  // ─── Render branch ──────────────────────────────────────────────
  // Spec 063: RoleRouter only mounts StaffStack when the staff user
  // is signed in; the 'signed-out' case never reaches here. Splash
  // covers the transient transition states.
  let content: React.ReactElement;
  if (
    authState.kind === 'idle' ||
    authState.kind === 'restoring' ||
    authState.kind === 'signing-in' ||
    authState.kind === 'gating' ||
    authState.kind === 'signed-out'
  ) {
    content = (
      <Stack.Navigator screenOptions={screenOptions}>
        <Stack.Screen name="Splash" component={Splash} />
      </Stack.Navigator>
    );
  } else if (activeStore) {
    // signed-in with an active store — the Count | Reorder tab bar (spec
    // 089 (E); was a single EODCount screen). The StorePicker gate is
    // upstream of the tab bar, so both tabs are guaranteed an active store.
    content = (
      <Stack.Navigator screenOptions={screenOptions}>
        <Stack.Screen name="StaffTabs" component={StaffTabs} />
      </Stack.Navigator>
    );
  } else {
    // signed-in without an active store — picker.
    content = (
      <Stack.Navigator screenOptions={screenOptions}>
        <Stack.Screen name="StorePicker" component={StorePicker} />
      </Stack.Navigator>
    );
  }

  // Spec 063 §6 — staff-only ErrorBoundary so the staff-specific
  // "Your counts are saved" fallback copy does not leak into admin
  // surfaces (which have no error boundary today).
  return <ErrorBoundary>{content}</ErrorBoundary>;
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  splashTitle: {
    fontSize: typography.headline,
    fontWeight: typography.bold,
  },
});
