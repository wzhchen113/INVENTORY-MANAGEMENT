# Code review for spec 126

Scope: staff Settings page + report-an-issue, per `specs/126-staff-settings-page.md`
"## Backend design" + "## Files changed". Read-only review; craftsmanship only
(architecture/security/coverage deferred to the other reviewers).

## Critical

None. The RPC gate-then-write-then-best-effort-notify order, the RLS posture
(no client write policy → definer RPC is the only path), the carve-out
`supabase.rpc` usage inside `src/screens/staff/lib/reports.ts`, the
`confirmAction` cross-platform sign-out, the theming (`useStaffColors()` /
`useCmdColors()` tokens, no inline hex literals in any new code), the i18n
parity across en/es/zh-CN (both staff and admin catalogs), and the gear/testID
contract are all followed correctly and consistently with the spec and
CLAUDE.md conventions.

## Should-fix

- `src/lib/db.ts:2036-2037` and `src/types/index.ts:1112-1114` — `mapNotification`
  maps the two new spec-126 fields with `?? undefined` (`body: row.body ??
  undefined`, `category: row.category ?? undefined`), while every other
  nullable field in the same function (`actorUserId`, `actorName`, `storeName`,
  lines 2026-2028) uses `?? null`. The spec's own "Backend design" contract
  explicitly specifies `body: string | null` / `category: string | null` and
  `?? null` mapping. This is an internal inconsistency within one function (not
  just a spec deviation) — a future contributor scanning `mapNotification` for
  the null-handling convention will see two different patterns four lines
  apart. Functionally harmless today (both branches read `n.body ?? …` /
  `n.category ?…` in `NotificationBell.tsx`), but fix the two fields to `?? null`
  and the `AdminNotification` interface to `body: string | null` / `category:
  string | null` to match the rest of the interface's nullable fields and the
  spec text.

- `src/screens/staff/screens/Settings.tsx:206-219` — the report message `Input`
  has no `maxLength` matching the server-side `staff_reports.message` CHECK
  (`char_length(message) between 1 and 2000`, enforced again in
  `submit_staff_report`'s validation step). A staffer who pastes or dictates a
  long message only discovers the 2000-char ceiling after tapping Submit, via
  the generic `chrome.reportIssue.error` banner (the specific "must be between
  1 and 2000 characters" text only reaches the toast via
  `notifyBackendError`'s truncated `err.message`, not the inline banner). Add
  `maxLength={2000}` to the `Input` so the constraint is visible up front
  instead of discovered via a failed round-trip.

## Nits

- `src/screens/staff/screens/Settings.tsx:76-98` — the sign-out block is now
  duplicated a fifth time (EODCount, Reorder, Receiving, and now Settings; four
  in-store screens already had their own copy). This is an explicit,
  documented spec decision ("replicate, do not refactor... unless the
  developer wants to raise it") and the implementation followed it faithfully
  (the five copies are byte-identical modulo comments) — not a code-craft
  defect, but the drift risk is now one step wider (a future change to the
  sign-out sequence needs five synchronized edits). Worth keeping the
  `useStaffSignOut()` extraction on the backlog the spec already flagged.
- (out-of-scope) `src/screens/staff/screens/{EODCount,Reorder,Receiving,WeeklyCount}.tsx`
  — no shared in-store header component exists, so `<SettingsGear />` had to be
  hand-placed in four different header markups (three inside an existing
  `headerRow`, one inside a newly-added `titleRow` for WeeklyCount, which has
  no sign-out row). The placements are consistent with each screen's existing
  header shape and match the spec's explicit "extracting a shared staff header
  is out of scope — note it as backlog" instruction. Flagging only to echo
  that backlog note per the review brief, not proposing a redesign here.
- `supabase/tests/staff_reports_issue.test.sql` — solid 12-arm coverage of the
  RPC happy path, gates, and RLS scoping (including the cross-brand and
  same-brand-non-privileged-user denials). The spec's own "Tests" section also
  calls out asserting `execute` on `submit_staff_report` is revoked from
  `anon`/granted to `authenticated`, and that `notifications_type_check`
  accepts `'issue'` as standalone arms — neither is asserted directly here
  (the CHECK acceptance is exercised implicitly by the happy-path insert
  succeeding, but the grant posture isn't asserted at all). Not blocking —
  flagging for test-engineer to confirm whether this is an intentional gap or
  worth a follow-up arm.
- `supabase/functions/submission-push-fanout/index.ts:172-176` — the `isIssue`
  branch hardcodes `title = 'Issue reported'` rather than reusing the `label`
  variable already computed from `TYPE_LABEL[notif.type]` (which holds the
  identical string, `TYPE_LABEL.issue = 'Issue reported'` at line 29). This
  mirrors the pre-existing `isMiss` branch's same hardcode-over-`label` pattern
  from spec 121, so it's consistent house style rather than a new defect —
  noting only because a future third free-text-body type will make the
  duplication three-wide.
