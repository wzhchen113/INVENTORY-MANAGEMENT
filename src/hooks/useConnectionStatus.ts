// src/hooks/useConnectionStatus.ts — Spec 057.
//
// Extracted from `TitleBar.tsx` to honor the spirit of the "all
// supabase access goes through `src/lib/db.ts`" convention: components
// should not import `lib/supabase` directly. The hook is now the single
// approved chokepoint for the realtime-channel-state read that drives
// the connection indicator — alongside the two other legitimate
// `lib/supabase` consumers (`src/lib/db.ts`, `src/hooks/useRealtimeSync.ts`).
//
// Behavior is byte-for-byte identical to the pre-extraction TitleBar
// poll (see spec 057 §2-3):
//
//   • Polls `supabase.realtime.channels` every 2000 ms.
//   • Initial tick fires synchronously after the interval is scheduled,
//     so the first render reflects current channel state without a 2s
//     gap.
//   • Optimistic default: returns `true` when no channels exist yet
//     (e.g. before `useRealtimeSync` has fired or no `storeId` is set).
//     This preserves the pre-existing UX nit where the indicator is
//     green during the brief window before subscriptions establish —
//     called out as out-of-scope in spec 057 §14.
//   • Healthy-state union: `state === 'joined' || state === 'subscribed'`.
//     `'joined'` is the canonical value from `CHANNEL_STATES` in
//     `@supabase/realtime-js`; `'subscribed'` is a defensive read for
//     older clients / the `REALTIME_SUBSCRIBE_STATES` enum surfaced via
//     `.subscribe()` callbacks. The current TitleBar checks both — do
//     not collapse.
//
// Tested against `@supabase/realtime-js` shipped with `supabase-js`
// ^2.101.1; if you bump the major, smoke-test the connection-indicator
// flip by closing + restoring the websocket in DevTools.
//
// Platform gate lives INSIDE the `useEffect`, NOT around the hook body.
// Rationale (spec 057 pass-2 code-reviewer Critical): the hook MUST be
// called unconditionally on every render (Rules of Hooks). Gating happens
// at the side-effect boundary — the `setInterval` is skipped entirely on
// native, so the optimistic `useState(true)` default is the only value
// downstream consumers ever observe on a non-web platform. This lets
// callers place the hook above their own `Platform.OS !== 'web'` early
// return without inverting hook order; and it self-contains the cost of
// the poll so a future native consumer doesn't need to remember to gate
// at the call site.

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { supabase } from '../lib/supabase';

export function useConnectionStatus(): boolean {
  const [connected, setConnected] = useState<boolean>(true);

  useEffect(() => {
    // Native bail — the realtime connection indicator is web-only chrome.
    // Returning here skips the `setInterval` entirely so no poller runs
    // on iOS / Android. `useState(true)` keeps the optimistic default for
    // any code path that happens to read the value on native.
    if (Platform.OS !== 'web') return;

    const tick = () => {
      const channels: any[] = (supabase as any).realtime?.channels || [];
      // 'joined' or 'subscribed' are healthy states; default optimistic if no
      // channels yet (e.g. before any subscription is created).
      if (channels.length === 0) {
        setConnected(true);
        return;
      }
      setConnected(channels.some((c) => c.state === 'joined' || c.state === 'subscribed'));
    };
    const id = setInterval(tick, 2000);
    tick();
    return () => clearInterval(id);
  }, []);

  return connected;
}
