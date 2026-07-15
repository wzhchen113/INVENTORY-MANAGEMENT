## Code review for spec 120

Scope reviewed: `supabase/migrations/20260715000000_submission_notifications.sql`,
`supabase/functions/submission-push-fanout/index.ts` + `supabase/config.toml`
stanza, `supabase/tests/submission_notifications.test.sql`, `src/lib/db.ts`,
`src/types/index.ts`, `src/store/useStore.ts`, `src/hooks/useSubmissionNotifications.ts`,
`src/navigation/CmdNavigator.tsx`, `src/components/cmd/NotificationBell.tsx`,
`src/components/cmd/TitleBar.tsx`, `src/i18n/{en,es,zh-CN}.json`.

Overall: clean, well-documented implementation that closely follows the
spec's corrected source map, the optimistic-then-revert convention, the
db.ts abort-signal/track() idiom, and the realtime-channel-cleanup pattern.
No direct-Supabase-outside-db.ts violations (the one direct `supabase`
import, in `useSubmissionNotifications.ts`, is a realtime channel
subscription — the same category of exception `useRealtimeSync.ts` already
uses, not a PostgREST/RPC call). No legacy-file edits, no slug change, no
`window.confirm`/`Alert.alert` misuse, no ad-hoc test files outside the
pgTAP track. No Criticals found.

### Critical
(none)

### Should-fix

- `src/components/cmd/NotificationBell.tsx:82` — the unread-badge text color
  is a hardcoded `'#FFFFFF'` literal instead of a theme token
  (`color: '#FFFFFF'` on a `C.danger` background). The Cmd palette has
  `accentFg` (readable text on `accent`) but no equivalent "text on danger"
  token, so this can't be trivially swapped for an existing token — but a
  bare hex literal in new code is exactly what the theming convention exists
  to avoid, and both light/dark `danger` values were chosen without
  guaranteeing white contrast in the future. Either add a `dangerFg` token
  alongside `accentFg` in `src/theme/colors.ts` (both `LightCmd`/`DarkCmd`
  already define `danger`/`dangerBg`, so `dangerFg` is a one-line addition
  per palette) or reuse `accentFg` if the two badge colors are meant to look
  the same. Small, but it's the one inline color literal introduced by this
  spec.

- `src/hooks/useSubmissionNotifications.ts:37` / `src/navigation/CmdNavigator.tsx:59` —
  the realtime effect's guard (`if (!brandId) return;`) means a super_admin
  in "All brands" mode (`currentBrandId === null` → `useStore.brand` is set
  to `null` by `setCurrentBrandId`, see `useStore.ts:825-840`) gets **zero**
  live channel subscriptions, not just a channel scoped to their
  "currently-selected brand" as spec §7 describes ("the brand-filtered
  channel delivers live updates for the super_admin's currently-selected
  brand only"). The written tradeoff assumes a brand is always selected;
  the actual All-brands state has no selected brand at all, so the bell is
  fully non-live (relies on the next `loadSubmissionNotifications()` call)
  for that specific super_admin view. Low-severity because the feed is
  still RLS-correct on refetch and this is an edge case (All-brands mode
  navigates the shell to the Brands section), but the hook's comment
  should say so explicitly rather than imply a merely-narrower live scope.

### Nits

- `src/store/useStore.ts:11` — `AdminNotification` is imported but never
  referenced as a type anywhere in the file (the new state fields and
  action signatures are declared without it, e.g. `useStore.ts:679-680`,
  `561-563`). Dead import; `tsc` doesn't catch it because `noUnusedLocals`
  isn't enabled, but it's clutter.
- `src/lib/db.ts:1993-1996` — `fetchAdminNotifications`'s shipped signature
  is `opts?: { limit?: number }`, dropping the `before?: string` cursor
  documented in spec §5 (`opts?: { limit?: number; before?: string }`). Not
  used anywhere yet (no "load more" in the panel), so low-impact, but it's a
  documented-contract vs. shipped-signature drift worth a one-line note at
  merge with backend-developer's parallel db.ts helpers.
- `src/components/cmd/NotificationBell.tsx:88-212` — the
  backdrop-plus-`document.body`-portal dropdown is a near-exact structural
  duplicate of `TitleBar.tsx`'s store-switcher panel (same fixed backdrop,
  `zIndex: 999/1000`, `boxShadow: '0 4px 12px rgba(0,0,0,0.18)'` shape). The
  spec explicitly asked for this mirroring ("portaled to `document.body`
  like the existing store-switcher menu"), so this isn't a defect, but a
  shared `PortaledDropdown` primitive would remove the duplication if a
  third dropdown shows up — out-of-scope for this spec, flagging only as a
  future-extraction candidate.
