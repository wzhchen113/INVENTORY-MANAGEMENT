# Security audit for spec 118 — PWA per-device notification toggle

Scope reviewed: `src/lib/notificationState.ts`, `src/screens/staff/components/NotificationSwitcher.tsx`,
`src/components/cmd/NotificationToggle.tsx`, the two cron edits
(`supabase/functions/eod-reminder-cron/index.ts`, `supabase/functions/weekly-reminder-cron/index.ts`),
the 6 i18n catalog additions, and the two mount points. Cross-checked
`src/lib/webPush.ts` and `push_subscriptions` RLS.

## Verdict

No Critical, no High, no Medium. One Low (informational). Spec is clean to ship
from a security standpoint.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
- `src/lib/notificationState.ts:159` — `probeNotificationState` logs
  `console.warn('[notificationState] probe failed:', e?.message || e)`. The
  caught value is a browser `getSubscription()`/registration error, not a token
  or PII, so this is acceptable. Noted only for completeness — no action
  required. (Same benign posture as the pre-existing `console.error`/`warn` in
  `webPush.ts:126,147`.)

## Focus-area findings

### 1. Cron opt-out removal — over-notification risk: CLEAR
The removed block only *subtracted* users (`&& !optedOutUserIds.has(u)`).
Removing it cannot admit any user who was not already in `storeUsers`. The
eligible set is still built exactly as before — `user_stores` members per store
(`usersByStore`) unioned with the admin/master set (`adminUserIds`) — and that
construction is untouched in both diffs. No user outside the eligible set can now
receive push OR email.
- Confirmed no-op in prod, not a policy loosening: `notifications_enabled` is
  absent in prod (added by `20260427023804`, dropped by
  `20260502071736_remote_schema.sql`). The `.eq('notifications_enabled', false)`
  query therefore errored every run, was caught non-fatally, and left
  `optedOutUserIds` empty — so the subtraction was already a no-op. Removing it
  changes nothing observable except deleting the per-run caught warning.
- Bearer-gate / `verify_jwt = false` posture intact: `config.toml:438-442`
  keeps `verify_jwt = false` for both crons; the diffs do not touch the
  shared-bearer (`_edge_auth.cron_bearer`) validation block. Auth boundary
  unchanged.
- Email fallback preserved: `deliverReminder` still emails any targeted user
  with zero working push subs — no change to that path.

### 2. Web-push subscription handling — no IDOR: CLEAR
- Staff toggle passes `currentStaffUserId(s.authState)` (`NotificationSwitcher.tsx:41`)
  and admin toggle passes `useStore((s) => s.currentUser?.id)`
  (`NotificationToggle.tsx:35`) — both the CURRENT authenticated user's own id.
- Defense in depth at the DB: even if a caller forged a different `userId`, the
  `push_subscriptions` RLS policy
  (`20260421192250_push_subscriptions_rls.sql:17-22`,
  `USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text)`,
  FOR ALL TO authenticated) rejects any insert/update whose `user_id` is not the
  caller. No subscribe-on-behalf-of-another-user path exists.
- `unsubscribeFromPush()` (`webPush.ts:136-149`) reads THIS browser's live
  `PushSubscription` and deletes only `.eq('endpoint', endpoint)` for that
  endpoint, further constrained by the same per-user RLS USING clause. It cannot
  touch another device's or another user's row. Device-A/device-B isolation is
  structural (endpoint-keyed).

### 3. XSS / injection — CLEAR
Both toggles render only static i18n catalog strings via `t()` / `T()` and the
literal `·` separator (`NotificationSwitcher.tsx:147`, `NotificationToggle.tsx:128`).
No user id, endpoint, or other untrusted/caller-controlled value is rendered.
`message`/`body` derive solely from the fixed `subscribeCodeToMessageKey` suffix
map and the view enum — no interpolation of request data. React Native `Text`
does not interpret HTML. The i18n additions are static translation strings. No
Resend/HTML-email surface is added by this spec (the crons' existing
`escapeHtml` and the eod cron's pre-existing unescaped store-name gap are
correctly left out of scope).

### 4. RLS — CLEAR
No migration in this spec (`git diff` shows no `supabase/migrations/` change).
`push_subscriptions` retains its owner-scoped policy; the service-role cron read
path bypasses RLS as designed. No new table, no policy change, correct.

## Dependencies
No `package.json` changes in the staged diff — `npm audit` skipped.

## BLOCKS?
No. No Critical findings. Spec 118 is clear to advance from a security review.
