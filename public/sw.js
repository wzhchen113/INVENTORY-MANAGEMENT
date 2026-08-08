// I.M.R — service worker
// Receives Web Push messages from the eod-reminder-cron edge function and
// surfaces them as OS notifications, then routes clicks into the app.

// Activate immediately so pushes can arrive after first load.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Installability SIGNAL ONLY (spec 153). Chrome has historically gated
// `beforeinstallprompt` on a service worker that registers a fetch handler.
// This listener deliberately never calls event.respondWith(), so every request
// takes the browser's default network path, byte-for-byte unchanged.
//
// DO NOT add caching here. This worker sits in front of EVERY request the app
// makes — Supabase PostgREST reads, /auth/v1 token refreshes, edge-function
// calls. A cache-first strategy would serve stale inventory data and break
// authentication in ways that are near-impossible to diagnose from the client.
// Offline behavior is an explicit non-goal.
self.addEventListener('fetch', () => {
  // Intentionally empty: no respondWith, no caches.
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }

  const title = payload.title || 'EOD count reminder';
  const options = {
    body: payload.body || 'Submit your end-of-day count.',
    // 192×192 is the standard notification-icon size; /favicon.png is 32×32
    // and was rendering as a tiny dot (often appearing blank) on macOS / iOS.
    icon: '/icon-192.png',
    // Badge stays small — macOS ignores badge entirely; on Android the
    // status-bar dot reads fine at 32×32 even though the spec calls for
    // 96×96 monochrome.
    badge: '/favicon.png',
    tag: payload.tag || 'eod-reminder',
    renotify: true,
    requireInteraction: false,
    data: { url: payload.url || '/', ts: Date.now() },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an existing tab if any; otherwise open a new one.
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        if ('navigate' in c) { try { await c.navigate(target); } catch (_) {} }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
