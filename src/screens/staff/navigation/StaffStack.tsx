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
import { StorePicker } from '../screens/StorePicker';
import { EODCount } from '../screens/EODCount';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useStaffStore } from '../store/useStaffStore';
import { colors, spacing, typography } from '../theme';

// Re-export the cold-start helper so callers (App.tsx + StaffStack.test.tsx)
// can target one canonical implementation. Spec 063 §11.2.
export { restoreSession } from '../../../lib/sessionRestore';

const Stack = createStackNavigator();

function Splash() {
  return (
    <View style={styles.splash}>
      <Text style={styles.splashTitle}>I.M.R Staff</Text>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export function StaffStack() {
  const authState = useStaffStore((s) => s.authState);
  const activeStore = useStaffStore((s) => s.activeStore);

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
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Splash" component={Splash} />
      </Stack.Navigator>
    );
  } else if (activeStore) {
    // signed-in with an active store — EOD screen.
    content = (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="EODCount" component={EODCount} />
      </Stack.Navigator>
    );
  } else {
    // signed-in without an active store — picker.
    content = (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
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
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  splashTitle: {
    fontSize: typography.headline,
    fontWeight: typography.bold,
    color: colors.text,
  },
});
