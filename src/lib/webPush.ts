// src/lib/webPush.ts
// Web Push helpers. Safe to call from any platform — no-ops on native / SSR.
//
// Lifecycle:
//   1. registerServiceWorker() at app start (idempotent)
//   2. On user gesture: requestPermissionAndSubscribe(userId)
//      - prompts the OS permission dialog
//      - subscribes the browser to Web Push via VAPID
//      - upserts the subscription row in Supabase
//   3. On logout: unsubscribeFromPush() tears both down
import { Platform } from 'react-native';
import { supabase } from './supabase';

const VAPID_PUBLIC: string = (process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY as string) || '';

type PermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

function isWebPushCapable(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

export function getPushPermission(): PermissionState {
  if (!isWebPushCapable()) return 'unsupported';
  return Notification.permission as PermissionState;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isWebPushCapable()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (e: any) {
    console.warn('[webPush] SW register failed:', e?.message || e);
    return null;
  }
}

/**
 * Fine-grained result type so the UI can show the real cause instead of a
 * generic "could not enable" message.
 */
export type SubscribeResult =
  | { ok: true }
  | { ok: false; code:
      | 'unsupported'
      | 'no-vapid'
      | 'no-user'
      | 'permission-denied'
      | 'permission-default'
      | 'sw-register-failed'
      | 'subscribe-failed'
      | 'subscription-incomplete'
      | 'save-failed';
    detail?: string };

/**
 * Prompt permission and subscribe this browser to Web Push.
 * Must be called from a user gesture (button click) for the browser to show
 * the permission prompt on some platforms.
 */
export async function requestPermissionAndSubscribe(userId: string): Promise<SubscribeResult> {
  if (!isWebPushCapable()) return { ok: false, code: 'unsupported' };
  if (!VAPID_PUBLIC) {
    console.warn('[webPush] EXPO_PUBLIC_VAPID_PUBLIC_KEY not set');
    return { ok: false, code: 'no-vapid' };
  }
  if (!userId) return { ok: false, code: 'no-user' };

  let permission: PermissionState = Notification.permission as PermissionState;
  if (permission === 'default') {
    try { permission = (await Notification.requestPermission()) as PermissionState; }
    catch (e: any) { return { ok: false, code: 'permission-default', detail: e?.message || String(e) }; }
  }
  if (permission === 'denied') return { ok: false, code: 'permission-denied' };
  if (permission !== 'granted') return { ok: false, code: 'permission-default' };

  let reg: ServiceWorkerRegistration | null;
  try {
    reg = (await navigator.serviceWorker.ready) || (await registerServiceWorker());
  } catch (e: any) {
    console.error('[webPush] SW ready failed:', e);
    return { ok: false, code: 'sw-register-failed', detail: e?.message || String(e) };
  }
  if (!reg) return { ok: false, code: 'sw-register-failed' };

  let sub: PushSubscription | null = null;
  try {
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
      });
    }
  } catch (e: any) {
    console.error('[webPush] pushManager.subscribe failed:', e);
    return { ok: false, code: 'subscribe-failed', detail: e?.message || String(e) };
  }

  const json: any = sub.toJSON();
  const endpoint: string = json.endpoint || sub.endpoint;
  const p256dh: string = json.keys?.p256dh;
  const auth: string = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return { ok: false, code: 'subscription-incomplete' };
  }

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    );
  if (error) {
    console.error('[webPush] Supabase upsert failed:', error);
    return { ok: false, code: 'save-failed', detail: error.message };
  }
  return { ok: true };
}

/**
 * Remove the subscription both locally and in Supabase.
 * Call on logout.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isWebPushCapable()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    await sub.unsubscribe();
  } catch (e: any) {
    console.warn('[webPush] unsubscribe failed:', e?.message || e);
  }
}

/**
 * Inject <link rel="manifest"> into <head> so the PWA manifest is discovered.
 * Expo's generated index.html doesn't include our custom manifest link; this
 * adds it at runtime. Safe to call multiple times.
 */
export function ensureManifestLinked(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[rel="manifest"]')) return;
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = '/manifest.json';
  document.head.appendChild(link);
}

/**
 * Inject <link rel="apple-touch-icon"> so iOS Safari shows the brand logo on
 * "Add to Home Screen" rather than a screenshot. iOS Safari also auto-
 * discovers /apple-touch-icon.png at the site root, but this link tag is
 * belt-and-suspenders for crawlers / headless browsers / DOM inspectors.
 * Safe to call multiple times.
 */
export function ensureAppleTouchIconLinked(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[rel="apple-touch-icon"]')) return;
  const link = document.createElement('link');
  link.rel = 'apple-touch-icon';
  link.setAttribute('sizes', '180x180');
  link.href = '/apple-touch-icon.png';
  document.head.appendChild(link);
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
