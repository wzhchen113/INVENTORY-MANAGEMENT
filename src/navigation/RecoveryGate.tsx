// src/navigation/RecoveryGate.tsx — Spec 085.
//
// Boot-time recovery-URL gate. Wraps <RoleRouter /> in App.tsx and decides, at
// app boot, whether the launch URL is an admin-initiated password-recovery
// link. If it is (a `?code=` recovery URL, or an `error`/`otp_expired`
// fragment), it renders <RecoveryScreen /> as a SIBLING render branch —
// INSTEAD of `children` (RoleRouter) — so the recovery screen lives OUTSIDE
// RoleRouter's single <NavigationContainer> and needs no react-navigation
// `linking` config. This is the spec's hard constraint (spec 063 single-
// NavigationContainer contract + spec 085 §2/§4): do NOT enable `linking`.
//
// Web: synchronous read of window.location on first render (mirrors
//   readCachedDarkModeSync / hydrateDevSessionFromUrl) — so the recovery
//   branch is chosen BEFORE RoleRouter's cold-start effects commit. Because
//   the gate short-circuits, RoleRouter never mounts in the recovery case, so
//   there is no ordering hazard with the getSession() effect.
// Native: Linking.getInitialURL() (cold start) in an effect + addEventListener
//   ('url', …) (warm link). Until app.json gets a `scheme` (Q1, user-gated)
//   no native deep link can actually arrive — this branch is dead code on web
//   and inert on native without the scheme.

import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import {
  parseRecoveryFromWebLocation,
  parseRecoveryFromUrl,
  type RecoveryParse,
} from '../lib/recoveryUrl';
import RecoveryScreen from '../screens/RecoveryScreen';

/** Synchronous web-only read of the launch URL. Returns the parse, or `none`
 *  on native / when there is no recovery payload. Mirrors the shape of
 *  readCachedDarkModeSync (web → sync; native → handled in an effect). */
function readRecoveryFromWebSync(): RecoveryParse {
  if (Platform.OS !== 'web') return { kind: 'none' };
  try {
    return parseRecoveryFromWebLocation(window.location.search, window.location.hash);
  } catch {
    return { kind: 'none' };
  }
}

/** Scrub the one-time recovery payload from the URL so the code/error fragment
 *  is not left in history or referrer (same hygiene as hydrateDevSessionFromUrl).
 *  Web-only; no-op on native. */
function scrubRecoveryUrl(): void {
  if (Platform.OS !== 'web') return;
  try {
    window.history.replaceState({}, '', window.location.pathname);
  } catch {
    /* best-effort */
  }
}

export default function RecoveryGate({ children }: { children: React.ReactNode }) {
  // Web: decide synchronously on first render so RoleRouter never paints in the
  // recovery case. Native: starts at `none` and a getInitialURL effect updates it.
  const [parse, setParse] = useState<RecoveryParse>(() => readRecoveryFromWebSync());

  // Scrub the web URL once, right after the synchronous read picks up a
  // recovery payload — the parse is already captured in state, so removing the
  // fragment from the address bar is safe and keeps the one-time token out of
  // history/referrer.
  useEffect(() => {
    if (Platform.OS === 'web' && parse.kind !== 'none') {
      scrubRecoveryUrl();
    }
    // Run once on mount — the web parse is fixed for the gate's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native: cold-start initial URL + warm-link listener.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let active = true;
    (async () => {
      try {
        const initial = await Linking.getInitialURL();
        if (active && initial) {
          const p = parseRecoveryFromUrl(initial);
          if (p.kind !== 'none') setParse(p);
        }
      } catch {
        /* best-effort */
      }
    })();
    const sub = Linking.addEventListener('url', ({ url }) => {
      const p = parseRecoveryFromUrl(url);
      if (p.kind !== 'none') setParse(p);
    });
    return () => {
      active = false;
      sub.remove();
    };
  }, []);

  // Tear-down callback handed to the recovery screen: flip the gate back to the
  // normal shell so RoleRouter mounts and renders LoginScreen (signed-out).
  const handleExit = () => setParse({ kind: 'none' });

  if (parse.kind !== 'none') {
    return <RecoveryScreen parse={parse} onExit={handleExit} />;
  }

  return <>{children}</>;
}
