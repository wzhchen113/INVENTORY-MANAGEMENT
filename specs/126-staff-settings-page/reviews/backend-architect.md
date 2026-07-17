# Backend-architect drift review — spec 126 (staff Settings + Report-an-issue)

Reviewed the STAGED implementation against the `## Backend design` I authored in
`specs/126-staff-settings-page.md`. Verdict: **no contract drift.** Every design
decision landed as specified. One Minor cosmetic deviation (null vs undefined),
no Critical, no Should-fix.

## Confirmations against the design contract

### (1) Migration `20260720000000_staff_reports_issue_notifications.sql`
- **type CHECK widen** — drop-if-exists + re-add under the same name with the
  full set `('eod','weekly','waste','receiving','po','missed_eod','issue')`.
  Idempotent, additive. Matches (lines 34-39). ✔
- **Two-column decision (my Q1 call, vs spec-121's single-slot reuse)** — both
  `body text` and `category text` added `if not exists`, nullable, no CHECK on
  `notifications` (source-of-truth CHECK lives on `staff_reports.category`).
  Matches exactly (lines 48-51). ✔
- **`staff_reports` table** — columns, types, FKs (`brands`/`stores` on delete
  cascade, `profiles` on delete set null), category CHECK
  `('equipment','inventory','app_tech','other')`, message CHECK
  `char_length between 1 and 2000`, `status default 'open'`, `created_at default
  now()`, and the `staff_reports_brand_created_idx (brand_id, created_at desc)`
  index — all present as designed (lines 59-75). ✔
- **RLS** — `enable row level security`; single permissive SELECT policy
  `privileged_brand_read_staff_reports` using
  `auth_is_privileged() AND auth_can_see_brand(brand_id)`; NO client
  INSERT/UPDATE/DELETE policy (default-deny writes → definer RPC is the only
  write path). Predicate is not trivially-wide → spec-053 lint passes with no
  allowlist edit. Grants left to spec-097 default posture (no revoke from
  anon/authenticated). Matches (lines 90-98). ✔
- **`submit_staff_report` RPC** — `security definer`, `set search_path = public`,
  and the exact ordered behavior: (1) top `auth_can_see_store` gate → `42501`
  BEFORE any write; (2) category + trimmed-length validation → `22023`;
  (3) server-derive `brand_id`/`store_name` from `stores` (+ brandless guard) and
  `reporter_name = coalesce(username, name)` from `profiles(auth.uid())`;
  (4) durable `staff_reports` INSERT; (5) exception-safe inner `begin/exception`
  notification emit with `on conflict (type, source_id) do nothing` + best-effort
  `enqueue_submission_push` only when a row was inserted; (6) `return v_report_id`.
  Matches the contract line-for-line (lines 119-192). ✔
- **Grants** — `revoke execute ... from public, anon` + `grant execute ... to
  authenticated` (the deliberate divergence from the internal `emit_*` helpers,
  since the reporter is the legitimate caller). Matches (lines 197-198). ✔
- **Version collision** — `20260720000000` is strictly after the prior latest
  `20260719000000`. No collision. ✔

### (2) `source_id = report.id` dedup semantics
The RPC passes `v_report_id` (the freshly-inserted `staff_reports.id`) as
`source_id` into the notification insert. Each report is a distinct row → a
distinct `source_id`, so the spec-120 `(type, source_id)` unique index
(`notifications_type_source_uidx`, confirmed present in
`20260715000000_submission_notifications.sql:51`) is satisfied for free and two
legitimate reports never collapse. The non-idempotent nature is handled exactly
as designed. ✔

### (3) `submission-push-fanout` issue branch + select widen
- `TYPE_LABEL` gains `issue: 'Issue reported'` (line 29). ✔
- The notification `select` is widened to include `category, body`
  (line 122). ✔
- New `isIssue` branch (peer to `isMiss`): `title: 'Issue reported'`,
  body = `[store_name, categoryLabel, preview].filter(Boolean).join(' · ')` with
  the message preview truncated at 100 chars, category rendered via a minimal
  local `ISSUE_CATEGORY_LABEL` map (my "acceptable, keep minimal" allowance)
  (lines 35-40, 168-178). ✔
- Recipients logic UNCHANGED (super_admins all-brands + admin/master of notif
  brand, minus actor). `verify_jwt` stays `false` behind the shared `cron_bearer`
  gate — untouched. ✔

### (4) `db.ts` + types
- `mapNotification` maps the two new fields (db.ts:2036-2037);
  `fetchAdminNotifications` still `select('*', ...)` so no query change. ✔
- `SubmissionNotificationType` union gains `'issue'` (types/index.ts:1099);
  `AdminNotification` gains optional `body?`/`category?` (1113-1114). ✔

### (5) Frontend
- `Settings.tsx` mounts NotificationSwitcher → LocaleSwitcher → ScaleSwitcher →
  Report-issue form (4-category radiogroup + multiline message + submit) →
  Sign out (sign-out block replicated verbatim, not refactored, as instructed).
  Success/error surfaced via `Banner` + `notifyBackendError`; form clears on
  success; submit disabled while empty/submitting. ✔
- Gear (`SettingsGear.tsx`) present in all four in-store screens (EODCount,
  Reorder, WeeklyCount, Receiving), `testID="staff-settings-gear"` default +
  `accessibilityLabel` from `chrome.settings.gearAria`, self-owned
  `useNavigation().navigate('Settings')`. ✔
- `Settings` registered as a sibling `Stack.Screen` of `StaffTabs` in the
  `activeStore` branch of `StaffStack.tsx:209`. ✔
- Inline Locale/Scale switchers KEPT on the in-store screens (my Q4 call).
  Settings is the additive consolidated home. ✔
- `submitStaffReport` carve-out lives in `src/screens/staff/lib/reports.ts`
  (supabase-direct, not through `db.ts` — correct per the CLAUDE.md staff-subtree
  carve-out), throws on error (no silent success). ✔
- Bell issue row (`NotificationBell.tsx:236-294`): category badge
  (`chrome.submissionBell.issueCategory.<category>`) + `body` message on the
  primary line, store + reporter + relative time on the secondary line, falls
  back to `typeLabel('issue')` if `body` is null. Message + category readable —
  satisfies AC lines 61-62. ✔
- i18n: staff `chrome.settings.*` + `chrome.reportIssue.*` (incl. `category.*`)
  present in en/es/zh-CN; admin `chrome.submissionBell.type.issue` +
  `issueCategory.*` present in en/es/zh-CN. ✔

### (6) No realtime publication change
`public.notifications` is already in `supabase_realtime` (spec 120 Part 7).
Adding a row `type` and nullable columns to an already-published table changes
no publication membership. No `add table`, no
`docker restart supabase_realtime_imr-inventory` step. The migration header
documents this explicitly. ✔

### Tests
pgTAP landed at `supabase/tests/staff_reports_issue.test.sql`. jest coverage for
Settings render/submit/validation, gear→navigate, and the bell issue row is
listed in the spec's Files-changed and referenced by the developer's full-suite
pass (112 suites / 1229 tests). ✔

## Findings

### Critical
None.

### Should-fix
None.

### Minor
1. **`AdminNotification.body`/`category` typed as `string | undefined`, not
   `string | null`.** The design text said `body: string | null` /
   `mapNotification → row.body ?? null`. The implementation chose optional fields
   (`body?: string`) with `?? undefined` (types/index.ts:1113-1114,
   db.ts:2036-2037). Functionally equivalent and arguably cleaner for an optional
   display field; the bell reads `n.body ?? typeLabel('issue')` which handles
   both. No action required — noting only for the record that the mapper returns
   `undefined` rather than the literal `null` the prose specified.

## Deploy state (pending — main Claude / release-coordinator, NOT runtime)
Backend changes are STAGED but require post-merge prod steps, per the design's
deploy checklist and MEMORY (prod migration via Supabase MCP — `db push` lacks
the prod password):
1. Apply `20260720000000_staff_reports_issue_notifications.sql` to prod via MCP
   `execute_sql`, then insert the exact version `20260720000000` into
   `supabase_migrations.schema_migrations` (else `db-migrations-applied.yml`
   turns red — independent signal from `test.yml`).
2. `supabase functions deploy submission-push-fanout` (the `issue` branch +
   widened select ship with the redeploy; local dev skips the POST with a
   NOTICE).
3. NO realtime container restart (see confirmation 6).
4. Confirm BOTH CI gates green on `main` after push.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 1 Minor
  (AdminNotification body/category typed `undefined` vs the prose's `null` —
  functionally equivalent, no action needed). No contract drift; every design
  decision (two-column notifications, definer RPC + auth_can_see_store gate,
  source_id=report.id dedup, RLS admin-read-only, fanout issue branch, staff
  carve-out submitStaffReport, kept inline switchers, no publication change)
  landed as specified. Prod-apply via MCP + schema_migrations insert +
  submission-push-fanout redeploy remain pending for main Claude / release.
payload_paths:
  - specs/126-staff-settings-page/reviews/backend-architect.md
