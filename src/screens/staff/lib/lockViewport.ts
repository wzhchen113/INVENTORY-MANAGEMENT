// src/screens/staff/lib/lockViewport.ts — disable browser zoom on the staff
// web surface.
//
// Why: the staff density scale (spec 2026-07) puts every input's font-size
// well below 16px. iOS Safari (including standalone/PWA mode) auto-zooms INTO
// any focused input under 16px and does not cleanly zoom back out — so tapping
// a Cases / Loose Units box blows the whole page up. A viewport with
// `maximum-scale=1, user-scalable=no` suppresses that focus auto-zoom (and
// pinch / double-tap zoom) — the fixed-layout behaviour the owner asked for.
//
// Expo's generated index.html ships a `width=device-width, initial-scale=1`
// viewport WITHOUT the scale locks, so we patch the existing tag at runtime
// (or create one) — the same head-injection posture as ensureManifestLinked()
// in src/lib/webPush.ts. Web-only + idempotent; a no-op on native, where there
// is no viewport to zoom.
//
// Scoped to the staff surface (called from StaffStack) so the admin Cmd
// desktop UI keeps normal browser zoom. Desktop Ctrl +/- zoom is unaffected by
// these tokens regardless — they only govern touch pinch + iOS focus zoom.

import { Platform } from 'react-native';

const LOCKED_VIEWPORT =
  'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';

export function lockStaffViewport(): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  let meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    document.head.appendChild(meta);
  }
  if (meta.getAttribute('content') === LOCKED_VIEWPORT) return;
  meta.setAttribute('content', LOCKED_VIEWPORT);
}
