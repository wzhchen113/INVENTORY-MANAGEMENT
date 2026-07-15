## Code review for spec 121

Scope reviewed: `supabase/migrations/20260716000000_missed_eod_notification_type.sql`,
`supabase/functions/eod-reminder-cron/index.ts` (Track 3 + `minutesSinceDeadline`),
`supabase/functions/submission-push-fanout/index.ts`,
`supabase/tests/missed_eod_notifications.test.sql`,
`src/types/index.ts`, `src/components/cmd/NotificationBell.tsx`,
`src/components/cmd/NotificationBell.test.tsx`, `src/components/cmd/TitleBar.test.tsx`,
`src/i18n/{en,es,zh-CN}.json`.

**Rollover trace (verified correct):** `minutesSinceDeadline` in
`supabase/functions/eod-reminder-cron/index.ts:65-74` — traced the three spec
example points by hand against the code: 22:00 deadline read at 21:00 →
`nowMin=1260, cutMin=1320` → `minutesAfter=-60` (not passed, correct); at 23:00 →
`nowMin=1380` → `minutesAfter=60` (passed 60m, correct); at 00:30 next day →
`wall.hour=0 < 3` so `nowMin=30+1440=1470`, `cutMin` unshifted at 1320 (deadline
hour 22 is not `< 3`) → `minutesAfter=150` (correct — NOT 1290-in-the-future).
The `+1440` shift is applied independently to `nowMin` and `cutMin` based on each
one's own hour being `< 3`, which is the right asymmetric normalization for a
deadline that never itself falls in the 00:00–02:59 band. No off-by-one at the
boundary hour (`hour === 3` triggers no shift on either side, consistent with
`businessTodayInTZ`'s own 3 AM rollover cut). Track 3 only fires when
`minutesAfter >= 0` (index.ts:366), and re-runs are collapsed to a no-op via the
deterministic `md5(store|date|vendor)::uuid` `source_id` + the existing
`(type, source_id)` unique index + `on conflict do nothing` — confirmed idempotent
by pgTAP arm (3). Tracks 1 and 2 are untouched — Track 3 is appended as a new,
independently-scoped block; no shared variable is mutated by it besides the
already-computed `weekday` (read-only) and `stores`/`sb` (read-only).

### Critical
(none)

### Should-fix
- `supabase/functions/eod-reminder-cron/index.ts:276-277` and `:347-348` — Track 2
  and Track 3 issue two separate, near-identical queries against
  `order_schedule` filtered on the same `day_of_week = weekday` (the only
  difference is Track 3 additionally selects `vendor_name`). This is a real
  duplicated round-trip per 5-minute cron tick. Extend Track 2's `schedRows`
  select to include `vendor_name` once and reuse the same array for Track 3
  instead of re-querying.
- `supabase/tests/missed_eod_notifications.test.sql:20-26` /
  `supabase/functions/eod-reminder-cron/index.ts:57-64` — the spec's own risk
  log calls the after-midnight rollover "Critical — the after-midnight sign
  bug," and the pgTAP file explicitly documents that it cannot exercise
  `minutesSinceDeadline` because it's a TS-only helper with no SQL surface. No
  jest-only mirror was added to close that gap, even though CLAUDE.md
  documents the exact precedent for this situation (`src/utils/escapeHtml.ts`
  — "exists exclusively for jest coverage… identity to the Deno copies is
  enforced at code-review time"). As shipped, the single most load-bearing
  piece of new logic in this spec has zero automated regression coverage in
  either track (pgTAP can't reach it; jest was never pointed at it). I traced
  it by hand above and it is correct today, but a future edit to this function
  has nothing to catch a regression. Recommend a `src/utils/` mirror of
  `minutesSinceDeadline` (or wherever `businessTodayInTZ`/`wallPartsInTZ` would
  need to move) purely for jest, with a comment pinning it to the edge-function
  copy the way `escapeHtml.ts` does. (Overlaps with test-engineer's beat —
  flagging because the spec explicitly asked this reviewer to assess it.)

### Nits
- `supabase/functions/eod-reminder-cron/index.ts:234` and `:365` — the
  `'22:00'` default-deadline fallback literal is duplicated verbatim between
  Track 1 and Track 3. A shared `const DEFAULT_EOD_DEADLINE = '22:00'` would
  prevent the two from drifting if the default is ever changed in only one
  place.
- `src/components/cmd/NotificationBell.tsx:56` — `badgeTextColor`'s danger
  branch returns the literal `'#FFFFFF'` rather than a theme token (there is
  no `dangerFg`/`onDanger` token in `src/theme/colors.ts` to reach for). This
  literal predates spec 121 (it was already inline at the old fixed line 86
  per the spec's own diff description) and is in the same family as the
  already-deferred "`#000`-on-accent sweep" cleanup item in MEMORY.md — not a
  new violation introduced by this diff, just flagging for awareness since the
  line was touched.
