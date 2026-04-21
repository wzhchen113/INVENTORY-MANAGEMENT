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
 * Prompt permission and subscribe this browser to Web Push.
 * Must be called from a user gesture (button click) for the browser to show
 * the permission prompt on some platforms.
 */
export async function requestPermissionAndSubscribe(userId: string): Promise<PermissionState | 'error'> {
  if (!isWebPushCapable()) return 'unsupported';
  if (!VAPID_PUBLIC) {
    console.warn('[webPush] EXPO_PUBLIC_VAPID_PUBLIC_KEY not set');
    return 'error';
  }
  if (!userId) return 'error';

  let permission: PermissionState = Notification.permission as PermissionState;
  if (permission === 'default') {
    permission = (await Notification.requestPermission()) as PermissionState;
  }
  if (permission !== 'granted') return permission;

  try {
    const reg = (await navigator.serviceWorker.ready) || (await registerServiceWorker());
    if (!reg) return 'error';

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
      });
    }

    const json: any = sub.toJSON();
    const endpoint: string = json.endpoint || sub.endpoint;
    const p256dh: string = json.keys?.p256dh;
    const auth: string = json.keys?.auth;
    if (!endpoint || !p256dh || !auth) return 'error';

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
      console.warn('[webPush] upsert subscription failed:', error.message);
      return 'error';
    }
    return 'granted';
  } catch (e: any) {
    console.warn('[webPush] subscribe failed:', e?.message || e);
    return 'error';
  }
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

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
