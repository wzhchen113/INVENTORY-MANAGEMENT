// src/screens/staff/lib/notificationLevel.ts — spec 126 follow-up.
//
// ONE shared 3-level derivation over the per-device Web Push `view` state
// (from useNotificationToggle / notificationState). Every surface that
// wants a red/green signal — the SettingsGear dot, the in-store reminder
// banner, the Settings NotificationSwitcher pill — funnels the raw 6-value
// `NotificationView` through this pure map so they never drift:
//
//   'on'  → view === 'on'                            → GREEN, no banner
//   'off' → view ∈ {'off','needs-install','denied'}  → RED, show banner
//   'na'  → view ∈ {'unsupported','error'}           → neutral, no dot,
//                                                       no banner
//
// The `na` bucket is the deliberate one: on `unsupported` (no Web Push
// stack) or `error` (probe threw) a nudge can't lead to a fix, so we show
// no colored dot and no banner rather than nag with a dead end. `denied`
// and `needs-install` DO get the red treatment because Settings has an
// actionable next step for each (unblock in OS settings / Add to Home
// Screen). Pure and total — the unit test pins all six views.

import type { NotificationView } from '../../../lib/notificationState';

export type NotificationLevel = 'on' | 'off' | 'na';

export function notificationLevel(view: NotificationView): NotificationLevel {
  switch (view) {
    case 'on':
      return 'on';
    case 'off':
    case 'needs-install':
    case 'denied':
      return 'off';
    case 'unsupported':
    case 'error':
      return 'na';
    default: {
      // Exhaustiveness guard — a new NotificationView surfaces here at
      // compile time.
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
