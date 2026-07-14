// src/lib/notificationState.ts — per-device Web Push toggle state logic.
//
// Spec 118. Two clearly separated halves:
//
//   • A PURE reducer (`deriveNotificationState`) + a PURE result→message-key
//     map (`subscribeCodeToMessageKey`). These carry all the branching logic
//     (permission × subscription × iOS-standalone → view state, and the 8
//     SubscribeResult codes → 5 message suffixes) and are unit-tested WITHOUT
//     a browser. They take plain-object inputs and return plain values.
//
//   • An IMPURE collector (`probeNotificationState`) + a UA heuristic
//     (`detectIos`) that read live browser globals (Notification.permission,
//     serviceWorker registration, navigator.standalone, matchMedia). These
//     are intentionally NOT unit-tested in isolation (browser-dependent); the
//     reducer they feed is.
//
// Web-only. Off-web (native / SSR) the probe resolves to a `capable: false`
// input so the reducer renders `unsupported`, matching webPush.ts's no-op
// posture.

import { Platform } from 'react-native';
import type { SubscribeResult } from './webPush';

// ── Types ────────────────────────────────────────────────────────────
export type NotificationView =
  | 'on'
  | 'off'
  | 'needs-install'
  | 'denied'
  | 'unsupported'
  | 'error';

export interface DeriveInput {
  /** true iff this browser supports the Web Push stack (serviceWorker +
   *  PushManager + Notification). Mirrors webPush.isWebPushCapable(). */
  capable: boolean;
  permission: 'granted' | 'denied' | 'default' | 'unsupported';
  /** true iff a live PushSubscription exists for this browser. */
  hasSubscription: boolean;
  isIos: boolean;
  /** true iff running as an installed PWA (standalone display mode). */
  isStandalone: boolean;
  /** true iff the live probe threw while reading subscription state. */
  probeError?: boolean;
}

// The union of message-key suffixes the components render under
// `chrome.notifications.msg.<suffix>`. Catalog-agnostic — each surface
// prefixes with its own catalog path.
export type MessageKey =
  | 'unsupported'
  | 'misconfigured'
  | 'denied'
  | 'dismissed'
  | 'generic';

// ── Pure reducer (the jest target) ───────────────────────────────────
// Precedence is top-to-bottom and the ORDER MATTERS: the iOS-Safari-tab
// "needs-install" branch (2) MUST precede the generic "unsupported" branch
// (3). On an iOS Safari tab `PushManager` is absent, so `capable` is false;
// a naive path would render `unsupported` (a dead end) instead of the
// actionable "Add to Home Screen" hint. Pure and total.
export function deriveNotificationState(i: DeriveInput): NotificationView {
  if (i.probeError) return 'error';
  if (i.isIos && !i.isStandalone) return 'needs-install'; // iOS Safari tab
  if (!i.capable) return 'unsupported';
  if (i.permission === 'denied') return 'denied';
  if (i.permission === 'granted' && i.hasSubscription) return 'on';
  return 'off'; // covers `default`, and granted-but-no-subscription
}

// ── Pure SubscribeResult code → message-key map ──────────────────────
// Covers all 8 union codes from webPush.SubscribeResult. The component
// renders `chrome.notifications.msg.<suffix>`. The `unsupported` code can
// still be overridden at render time by the `needs-install` VIEW on an iOS
// tab — that branch is driven by the view, not this map.
export function subscribeCodeToMessageKey(
  code: Extract<SubscribeResult, { ok: false }>['code'],
): MessageKey {
  switch (code) {
    case 'unsupported':
      return 'unsupported';
    case 'no-vapid':
      return 'misconfigured';
    case 'permission-denied':
      return 'denied';
    case 'permission-default':
      return 'dismissed';
    case 'no-user':
    case 'sw-register-failed':
    case 'subscribe-failed':
    case 'subscription-incomplete':
    case 'save-failed':
      return 'generic';
    default: {
      // Exhaustiveness guard — a new SubscribeResult code surfaces here at
      // compile time.
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

// ── Impure UA heuristic (NOT unit-tested in isolation) ───────────────
// iOS detection: the UA token test plus the iPadOS-13+ masquerade (iPadOS
// reports a desktop-Safari UA but exposes touch on a Mac platform string).
// Brittle by design — it feeds the pure reducer and is swappable in one
// place.
export function detectIos(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ masquerade.
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1;
}

// ── Impure collector (NOT unit-tested in isolation) ──────────────────
// Reads the live browser state into a plain DeriveInput for the pure
// reducer. Off-web resolves to a `capable: false` snapshot.
export async function probeNotificationState(): Promise<DeriveInput> {
  const capable =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined';

  const isIos = detectIos();
  const isStandalone =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    (
      // iOS Safari exposes navigator.standalone; other browsers use the
      // display-mode media query.
      (navigator as unknown as { standalone?: boolean }).standalone === true ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches)
    );

  if (!capable) {
    return {
      capable: false,
      permission: 'unsupported',
      hasSubscription: false,
      isIos,
      isStandalone,
    };
  }

  const permission = Notification.permission as DeriveInput['permission'];

  let hasSubscription = false;
  let probeError = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    hasSubscription = !!sub;
  } catch (e: any) {
    console.warn('[notificationState] probe failed:', e?.message || e);
    probeError = true;
  }

  return { capable, permission, hasSubscription, isIos, isStandalone, probeError };
}
