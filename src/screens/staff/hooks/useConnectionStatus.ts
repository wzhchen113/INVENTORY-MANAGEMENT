// src/hooks/useConnectionStatus.ts — Spec 062 §5 / Q2 resolution.
//
// Single-file hook with Platform.OS branching INSIDE useEffect (not
// Platform.select on the module surface). Rules-of-Hooks invariant:
// the hook is called unconditionally on every render; the platform
// fork lives in the effect body so consumers don't see hook-order
// drift between web and native bundles.
//
// Contract: `useConnectionStatus(): boolean` (true = online).
//
// Initial state — optimistic-true seed (spec 057 / 059 precedent):
//   web    → navigator.onLine when available, else true.
//   native → true (NetInfo's first event corrects in <500ms).
//
// Subscribe step diverges:
//   web    → window.addEventListener('online'|'offline').
//   native → NetInfo.addEventListener; treat
//            `isConnected === true && isInternetReachable !== false`
//            as online.
//
// This staff app does NOT route through supabase realtime — spec 061
// §B7a / Q3 resolution mandates no realtime subscriptions in v1, so
// the imr-inventory spec-059 Phoenix Socket pattern does NOT apply
// here.

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
// NetInfo is loaded lazily inside the native branch of the effect to
// keep the web bundle smaller (it's still RN-compatible on web, just
// no-op there per the imr-inventory precedent).

function readInitial(): boolean {
  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
    return true;
  }
  // Native — optimistic. NetInfo's first event will arrive shortly.
  return true;
}

export function useConnectionStatus(): boolean {
  // Lazy initializer — runs once on first render, before useEffect.
  // Required so the seed-read happens on mount; literal useState(true)
  // would skip it.
  const [connected, setConnected] = useState<boolean>(readInitial);

  useEffect(() => {
    // Platform fork lives inside the effect so the hook is called
    // unconditionally regardless of bundle target. Spec 058 rule.
    if (Platform.OS === 'web') {
      const onOnline = () => setConnected(true);
      const onOffline = () => setConnected(false);
      if (typeof window === 'undefined') return;
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      return () => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      };
    }

    // Native — lazy-require NetInfo so a missing native module on web
    // tests doesn't blow up the bundle. Wrapped in try/catch so a
    // future NetInfo restructuring degrades to optimistic-true.
    let unsub: (() => void) | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const NetInfo = require('@react-native-community/netinfo').default;
      unsub = NetInfo.addEventListener((state: {
        isConnected: boolean | null;
        isInternetReachable: boolean | null;
      }) => {
        const online =
          state.isConnected === true && state.isInternetReachable !== false;
        setConnected(online);
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useConnectionStatus] NetInfo unavailable:', err);
      // Keep optimistic-true seed — hook still functions, just won't
      // detect transitions.
      return;
    }
    return () => {
      if (unsub) unsub();
    };
  }, []);

  return connected;
}
