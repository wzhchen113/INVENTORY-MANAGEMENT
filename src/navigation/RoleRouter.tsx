// src/navigation/RoleRouter.tsx — top-level role-routed shell.
//
// Spec 063 §7 — App.tsx now mounts `<RoleRouter />` instead of
// `<CmdNavigator />`. RoleRouter owns the single `<NavigationContainer>`
// for the merged admin+staff app and dispatches the active branch
// based on auth state:
//
//   - Admin session present  → AdminStack (CmdNavigator's inner stack)
//   - Staff session present  → StaffStack
//   - Neither                → AdminStack (renders LoginScreen)
//
// The shared sign-in portal lives at `src/screens/LoginScreen.tsx` —
// it lives inside the admin Login/Register stack today, and that's
// the screen that staff users sign in through too. After `signIn()`
// resolves, the LoginScreen branches on `profiles.role`: admin path
// calls `useStore.login()`; staff path calls `checkAuthGate` and
// seeds `useStaffStore`. Either path causes RoleRouter to re-render
// with the appropriate branch.
//
// The `linking` config is intentionally left off the
// `NavigationContainer` for v1 — the pre-merge admin app shipped
// without `linking` and relies on the Vercel SPA rewrite for
// client-side routing. Adding `linking` for the first time
// introduces a new "URL is meaningful" contract that's out of scope
// for this merge. Spec 063 §3 / Q3: ship without `linking` if it
// flickers — the role gate still functions.

import React from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { useStore } from '../store/useStore';
import { useStaffStore } from '../screens/staff/store/useStaffStore';
import { AdminStack } from './CmdNavigator';
import { StaffStack } from '../screens/staff/navigation/StaffStack';

// Module-level nav ref so screens that want to navigate imperatively
// can use it (matches the pre-merge CmdNavigator ref).
export const roleRouterNavRef = createNavigationContainerRef();

export default function RoleRouter() {
  const currentUser = useStore((s) => s.currentUser);
  const staffAuthState = useStaffStore((s) => s.authState);
  const staffSignedIn = staffAuthState.kind === 'signed-in';

  // Decide which inner stack to mount.
  // Priority: admin session > staff session > shared sign-in (handled
  // by AdminStack's Login/Register branch). The shared LoginScreen
  // dispatches to either path after `signIn()` resolves.
  let inner: React.ReactElement;
  if (currentUser) {
    inner = <AdminStack />;
  } else if (staffSignedIn) {
    inner = <StaffStack />;
  } else {
    // No session — AdminStack's `currentUser` ternary renders
    // LoginScreen + RegisterScreen. The LoginScreen owns the
    // role-branching logic post-sign-in (spec 063 §8).
    inner = <AdminStack />;
  }

  return (
    <NavigationContainer ref={roleRouterNavRef}>
      {inner}
    </NavigationContainer>
  );
}
