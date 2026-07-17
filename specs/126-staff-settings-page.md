# Spec 126: Staff Settings page (consolidated) + Report-an-issue

Status: READY_FOR_REVIEW

## User story
As a staff user working inside a store on the staff PWA (EODCount / Reorder /
WeeklyCount / Receiving), I want a single Settings page reachable from a gear
icon in the header of every in-store screen — so that I can toggle
notifications, change language and zoom, sign out, and report a problem without
having to back out to the Store Picker.

As a store manager / admin (and every super-admin), I want a staff-reported
problem to arrive in my notification bell with the message and category
readable — so that I learn about equipment / inventory / app issues without a
separate inbox.

## Background / problem
The per-device notification toggle (`NotificationSwitcher`, spec 118) is mounted
ONLY on `StorePicker.tsx` (the switcher row at
`src/screens/staff/screens/StorePicker.tsx:56-60`). Once a staff member selects
a store, they land in the `StaffTabs` bottom-tab surface (EODCount / Reorder /
WeeklyCount / Receiving — `StaffStack.tsx:99-151`) and can no longer reach the
notification toggle. The in-store screens surface Locale + Scale switchers in
their own headers but not the notification toggle. There is no single, obvious
"settings" destination for staff.

## Acceptance criteria

### Entry point & navigation
- [ ] A gear (⚙) button renders in the shared in-store header on all four
      in-store screens (EODCount, Reorder, WeeklyCount, Receiving) and is
      reachable without returning to StorePicker.
- [ ] Tapping the gear navigates to a new `Settings` screen registered as a
      `Stack.Screen` in `src/screens/staff/navigation/StaffStack.tsx` (alongside
      the existing StaffTabs / StorePicker / Splash branches), and the Settings
      screen has a way back to the in-store surface (back affordance / header).
- [ ] The gear button has an accessibilityLabel and a stable testID
      (e.g. `staff-settings-gear`).

### Settings screen contents
- [ ] Settings renders, each clearly labeled: the notification toggle
      (reuse `NotificationSwitcher`), language switcher (reuse `LocaleSwitcher`
      — EN/ES/中文), zoom/scale switcher (reuse `ScaleSwitcher` — x1/x1.2/x1.5),
      a Sign out action (reuse the existing staff sign-out), and a Report an
      issue form.
- [ ] Changing language on Settings updates staff UI copy live (same behavior as
      the inline switcher today).
- [ ] Sign out from Settings performs the identical action as the existing
      in-store sign-out (routes back through RoleRouter to the sign-in portal).

### Report an issue
- [ ] The report form has a category picker with exactly these options:
      Equipment, Inventory, App/Tech, Other — and a free-text message field.
- [ ] Submitting with a non-empty message persists a durable record carrying:
      category, message text, reporting `user_id`, `store_id`, `brand_id`, and a
      server timestamp. Store, reporter, and brand are derived from the staff
      session / active store — never chosen/forgeable by the reporter.
- [ ] Submitting emits a notification of a new `'issue'` type to the exact
      spec-120 recipient model: the brand's admin + master users AND all
      super-admins (all brands) — bell + web-push.
- [ ] The reported **message and category are readable by the recipient in the
      notification bell** (not just a "new issue" placeholder).
- [ ] A staff user can only file a report for their own store/brand; the
      admin-facing notification cannot be forged for a brand the staff user
      cannot see (enforced server-side, not client-trust).
- [ ] Submit gives success feedback and clears / disables the form; a failed
      submit surfaces an error and does not silently claim success.
- [ ] The category labels and the report form copy are translated in the staff
      catalog (en / es / zh); the admin bell label for the `issue` type is
      translated in the admin surface.

## In scope
- New staff `Settings` screen under `src/screens/staff/screens/`.
- Gear entry point in the shared in-store staff header, added to all four
  in-store screens.
- Reuse of `NotificationSwitcher`, `LocaleSwitcher`, `ScaleSwitcher`, and the
  existing staff sign-out inside Settings.
- Report-an-issue form (category picker + message) with a durable, RLS-gated
  write path.
- A new `'issue'` notification type wired end-to-end through the spec-120 /
  spec-121 pattern: widen `notifications_type_check`, add a server-side emit
  path, add a `submission-push-fanout` TYPE_LABEL + title/body branch, add the
  bell rendering — with the message + category surfaced to the recipient.
- Staff i18n (en/es/zh) for category labels + report form; admin i18n for the
  bell label.

## Out of scope (explicitly)
- A dedicated admin "Issues inbox" screen, list, or filter view — v1 delivers
  the bell + push only (user chose the minimal path; the storage decision below
  should keep a future inbox cheap).
- Any resolve / acknowledge / close / assign workflow on reported issues.
- Any reply-to-staff or two-way messaging on a report.
- Realtime for the staff stack (staff v1 is non-realtime per spec 062); the
  admin bell already receives realtime via the existing `store-{id}`/`brand-{id}`
  channels the admin shell subscribes to — no new channel is introduced.
- Changing the admin notification bell beyond adding the `issue` type rendering.
- Adding new switcher capabilities (notification/locale/scale behavior is reused
  as-is, not re-designed).

## Open questions resolved (baked in — do not re-open)
- Q: Where does Settings live in nav? → A: A new `Stack.Screen` in
  `StaffStack.tsx`, reached via a gear icon in the shared in-store header.
- Q: How are issues delivered to admins? → A: Reuse the spec-120 notification
  system (bell + web-push) with a NEW `'issue'` type; recipients are the brand's
  admin/master users + ALL super-admins (the exact spec-120 recipient model).
  No dedicated admin inbox in v1.
- Q: What does the recipient see? → A: The message text + category must be
  readable in the bell (stored durably and surfaced), not a bare placeholder.
- Q: What does the reporter fill in? → A: category (Equipment / Inventory /
  App/Tech / Other) + free-text message. Store, reporting user, brand, and
  timestamp are attached automatically from the session / active store.

## Open questions for the architect (genuinely unresolved — decide in design)
1. **Report storage & bell read-path.** The spec-120 `notifications` table has
   NO free-text body column today (columns: brand_id, store_id, actor_user_id,
   type, source_id, actor_name, store_name). Decide:
   (a) a new `staff_reports` table (durable, future-inbox-ready) that the emit
   path reads from, vs (b) adding a nullable `body`/`message` (+ category)
   column to `notifications`. And decide how the bell surfaces the text +
   category — denormalize onto the notification row (mirrors spec-121's reuse of
   the `actor_name` display slot) vs join back to a `staff_reports` row. The
   recommendation-leaning shape: a dedicated `staff_reports` table keeps a
   future inbox cheap and avoids overloading the notification schema, with the
   message/category denormalized onto the notification for a zero-join bell —
   but the architect owns this call.
2. **Staff write path + RLS + server-side emit.** Define how staff INSERT a
   report scoped to their own store/brand (staff subtree is a documented
   supabase-direct carve-out, but this write should be RLS-gated), and make the
   admin-facing notification emit server-side / `SECURITY DEFINER` (mirroring
   `emit_missed_count` / `emit_submission_notification`, which revoke EXECUTE
   from public/anon/authenticated) so staff cannot forge a cross-brand
   notification. Decide whether staff INSERT directly into `staff_reports` under
   an RLS policy that pins `store_id`/`brand_id` to the caller's own stores, or
   go through a `SECURITY DEFINER` RPC that both writes the report and emits —
   the latter closes the forgery surface in one place.
3. **`source_id` / dedup semantics for the `issue` type.** spec-120 uses a
   unique `(type, source_id)` with `on conflict do nothing`. A report is a
   distinct event each time (unlike an idempotent submission), so decide the
   `source_id` (e.g. the `staff_reports` row id) so two legitimate reports don't
   collapse.
4. **Inline switcher placement.** Decide whether the inline `LocaleSwitcher` /
   `ScaleSwitcher` (and the StorePicker `NotificationSwitcher`) stay on the
   in-store screens once Settings exists, or move solely into Settings. Default
   lean: keep the inline language/scale switchers to avoid regressing quick
   access, and centralize the notification toggle into Settings (its only
   current home is StorePicker, which is unreachable in-store) — architect
   confirms.

## Dependencies
- Spec 120 notification system —
  `supabase/migrations/20260715000000_submission_notifications.sql`
  (`notifications` table, `emit_submission_notification`,
  `enqueue_submission_push`, RLS `auth_is_privileged() AND
  auth_can_see_brand(brand_id)`, `submission-push-fanout` edge function,
  `NotificationBell.tsx`).
- Spec 121 —
  `supabase/migrations/20260716000000_missed_eod_notification_type.sql`
  (reference pattern for ADDING a notification type: widen the CHECK, add a
  sibling emit path, add a fanout TYPE_LABEL + title/body branch, add bell
  rendering).
- Spec 118 `NotificationSwitcher`, plus `LocaleSwitcher` / `ScaleSwitcher` under
  `src/screens/staff/components/`.
- Staff nav `src/screens/staff/navigation/StaffStack.tsx`; staff i18n under
  `src/screens/staff/i18n/`; staff-local theme/components.
- `submission-push-fanout` edge function (recipient fan-out).

## Project-specific notes
- Cmd UI section / legacy: N/A for the primary surface — this is the STAFF app
  (`src/screens/staff/`), a peer to the admin Cmd UI. The admin-facing change is
  limited to the existing `NotificationBell` gaining an `issue` type rendering.
- Per-store or admin-global: per-store / per-brand. Reports are scoped to the
  reporter's own store/brand; admin recipients follow the spec-120 model
  (brand admins/masters + all super-admins).
- Realtime channels touched: none new. Staff stack stays non-realtime (spec
  062). Admin bell rides the existing `store-{id}`/`brand-{id}` channels; the
  `public.notifications` table is already in the `supabase_realtime`
  publication (spec 120 Part 7), so adding the `issue` type needs NO publication
  edit and NO `docker restart supabase_realtime_imr-inventory` ritual.
- Migrations needed: yes — additive. At minimum widen
  `notifications_type_check` to include `'issue'` and add the report storage +
  server-side emit path (table/column + RPC or emitter per the architect's Q1/Q2
  decision).
- Edge functions touched: `submission-push-fanout` (add an `issue` TYPE_LABEL +
  title/body branch; the body must carry the report message + category so the
  push is readable).
- Web/native scope: staff surface is the mobile PWA (web). Reuse existing staff
  components as-is. Flag any native-specific concern (web-push is web-only, but
  that is already encapsulated in `NotificationSwitcher`).
- Tests (spec 022 tracks): pgTAP for the new emit path + RLS scoping (staff can
  only report for own store/brand; emit reaches brand admins + super-admins;
  cross-brand forge is refused); jest for the Settings screen render + gear
  navigation + report form submit/validation. No shell smoke anticipated.
- Do NOT touch the `app.json` slug.

---

## Backend design

### Open-question resolutions (baked)

- **Q1 (storage + bell read-path):** NEW durable `staff_reports` table (keeps a
  future inbox cheap; does not overload `notifications`). The bell reads a
  ZERO-JOIN denormalized notification row. `source_id` = the `staff_reports.id`
  (unique per report ⇒ the `(type, source_id)` dedup spine is satisfied for free;
  each report is a distinct event, no idempotency concern). To carry the free
  text + category onto the notification without a join, add **two** nullable
  columns to `public.notifications`: `body text` (the message) and
  `category text` (the enum token, for the bell's category badge). Reuse the
  existing `actor_name` slot for the reporter and `store_name` for the store.
  See the "two-columns" note under Risks for why this deviates from spec-121's
  single-slot reuse.
- **Q2 (write path + anti-forgery):** a single `SECURITY DEFINER` RPC
  `submit_staff_report(...)`. Staff never INSERT `staff_reports` or
  `notifications` directly — the RPC derives brand/store/reporter server-side
  from trusted rows and gates on `auth_can_see_store(p_store_id)`.
- **Q3 (source_id / dedup):** `source_id = staff_reports.id`. Distinct per
  report; two legitimate reports never collapse.
- **Q4 (inline switchers):** KEEP the inline `LocaleSwitcher` / `ScaleSwitcher`
  on the four in-store screens (removing them regresses quick access). Settings
  is the consolidated home that ADDS the notification toggle (its only current
  home, `StorePicker`, is unreachable in-store) + report-issue + sign-out.

### Data model changes

Migration: `supabase/migrations/20260720000000_staff_reports_issue_notifications.sql`
(additive; latest on disk is `20260719000000` — no collision). Non-destructive.

New table `public.staff_reports`:

| column            | type          | notes                                                        |
|-------------------|---------------|--------------------------------------------------------------|
| `id`              | uuid PK       | `default gen_random_uuid()` — also the notification source_id |
| `brand_id`        | uuid NOT NULL | FK `brands(id) on delete cascade`; derived server-side       |
| `store_id`        | uuid NOT NULL | FK `stores(id) on delete cascade`; from active store         |
| `reporter_user_id`| uuid          | FK `profiles(id) on delete set null` = `auth.uid()`          |
| `reporter_name`   | text          | DENORMALIZED (`coalesce(username, name)`), like the emitter  |
| `store_name`      | text          | DENORMALIZED                                                 |
| `category`        | text NOT NULL | `check (category in ('equipment','inventory','app_tech','other'))` |
| `message`         | text NOT NULL | `check (char_length(message) between 1 and 2000)`            |
| `status`          | text NOT NULL | `default 'open'` (future inbox; no workflow in v1)          |
| `created_at`      | timestamptz   | `default now()`                                              |

Index: `staff_reports_brand_created_idx on (brand_id, created_at desc)` (future
inbox feed scan; mirrors `notifications_brand_created_idx`).

Additive columns on `public.notifications` (both nullable, general-purpose):
- `body text` — free-text message (first free-text notification type; reusable).
- `category text` — bounded token for the bell badge (nullable; only set for
  `'issue'`; no CHECK on `notifications` — the source-of-truth CHECK lives on
  `staff_reports`).

Widen the type CHECK (same drop/re-add-under-same-name pattern spec 121 used):
`notifications_type_check` → `check (type in ('eod','weekly','waste','receiving','po','missed_eod','issue'))`.

Rollout safety: fully additive. Existing `notifications` rows keep NULL
`body`/`category` and remain valid; no backfill. Adding nullable columns to an
already-published table does NOT change publication membership (see Realtime).

### RLS impact

`staff_reports` — `enable row level security`. Client writes go ONLY through the
`SECURITY DEFINER` RPC (table owner, bypasses RLS), so there is NO client
INSERT/UPDATE/DELETE policy (default-deny). One SELECT policy for the future
inbox + admin reachability, mirroring the `notifications` read policy exactly:

- `privileged_brand_read_staff_reports` — `for select using
  (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))`.

Rationale: `auth_is_privileged()` denies same-brand staff `user` rows (they are
reporters, not readers — same load-bearing conjunct as spec 120's
`privileged_brand_read_notifications`); super_admin short-circuits to all brands.
This is a single permissive SELECT policy on `(staff_reports, select)`; no
trivially-wide predicate ⇒ passes the spec-053 permissive-policy lint with no
allowlist entry.

Grants: inherit the spec-097 explicit default grants (do NOT revoke from
anon/authenticated — would trip the spec-097 grant lint). RLS is the gate.

`notifications` — no policy change (new columns ride the existing
`privileged_brand_read_notifications` SELECT policy; writes still come only from
the definer emitter).

### API contract — RPC (not PostgREST)

RPC, because the write must (a) derive brand/store/reporter server-side,
(b) gate on `auth_can_see_store`, and (c) emit the admin notification in one
forgery-proof place. A PostgREST INSERT with an RLS check on `store_id` cannot
also emit the notification without a trigger, and would let the client supply
`brand_id`/`reporter_name` — rejected.

```
public.submit_staff_report(
  p_store_id uuid,
  p_category text,
  p_message  text
) returns uuid            -- the new staff_reports.id
language plpgsql
security definer
set search_path = public
```

Behavior, in order:
1. `if not public.auth_can_see_store(p_store_id) then raise exception ... using
   errcode = '42501';` (PostgREST → HTTP 403). Fires FIRST, before any write —
   same top-of-function gate discipline as the receiving RPCs
   (`20260705000000_cost_on_receipt.sql:85`).
2. Validate `p_category in ('equipment','inventory','app_tech','other')` and
   `char_length(trim(p_message)) between 1 and 2000`, else `raise exception ...
   using errcode = '22023'` (invalid parameter → HTTP 400).
3. Resolve `v_brand, v_store_name` from `stores`; `v_reporter_name` from
   `profiles` (`coalesce(username, name)`). Guard `v_brand is null → raise` (store
   must belong to a brand).
4. `insert into staff_reports (...) returning id into v_report_id;` — this is the
   durable, atomic part of the RPC.
5. Best-effort notification, wrapped in an inner `begin ... exception when others
   then raise warning ... end` (notifications are a side-channel; a notification
   failure MUST NOT roll back the report — same principle as
   `emit_submission_notification`): `insert into notifications (brand_id,
   store_id, actor_user_id, type, source_id, actor_name, store_name, category,
   body) values (v_brand, p_store_id, auth.uid(), 'issue', v_report_id,
   v_reporter_name, v_store_name, p_category, trim(p_message)) on conflict (type,
   source_id) do nothing returning id into v_new_id;` then
   `if v_new_id is not null then perform public.enqueue_submission_push(v_new_id);`
6. `return v_report_id;`

Grants: `revoke execute ... from public, anon;` `grant execute ... to
authenticated;` (staff sign in as `authenticated`). Note this differs from the
`emit_*` helpers which revoke from authenticated too — `submit_staff_report` is a
legitimate user-invoked op (the caller is the reporter), whereas `emit_*` /
`enqueue_submission_push` stay internal-only.

Response shape (PostgREST RPC): the bare uuid on success; on failure a PostgREST
error envelope with the SQLSTATE-mapped HTTP status. Error cases: 403 (store not
visible / cross-brand forge attempt), 400 (bad category / empty or >2000 char
message), 500 (unexpected). The report row is the source of truth; the caller
does not need the notification id back.

### Edge function changes — `submission-push-fanout`

No new function, no `verify_jwt` change (stays `false` + shared-`cron_bearer`
gate). Modifications:
- Add `issue: 'Issue reported'` to `TYPE_LABEL`.
- Widen the notification `select` to include the new columns:
  `'id, brand_id, type, actor_user_id, actor_name, store_name, category, body'`.
- Add an `issue` branch to the payload builder (peer to the existing `isMiss`
  fork): `title: 'Issue reported'`, `body: [store_name, category, message
  preview].filter(Boolean).join(' · ')` truncating `body` to ~100 chars. Use the
  raw category token (the fanout has no i18n bundle; a short map
  `{equipment,inventory,app_tech,other} → label` is acceptable, or pass the token
  through — decide in build, keep it minimal).
- Recipients UNCHANGED: super_admins (all brands) + admin/master of the notif
  brand, minus `actor_user_id`. The reporter is a staff `user`, never in that
  set, so the self-exclude is a harmless no-op.

Deploy note (for main Claude / release): `submission-push-fanout` must be
redeployed (`supabase functions deploy submission-push-fanout`). Behind the same
`_edge_auth 'submission_push_url'` config as spec 120 — local dev skips the POST
with a NOTICE.

### `src/lib/db.ts` surface (admin side)

No new admin helper. `AdminNotification` (`src/types/index.ts`) gains two optional
fields: `body: string | null` and `category: string | null`. `mapNotification`
(`db.ts:2021`) maps `body: row.body ?? null`, `category: row.category ?? null`.
`fetchAdminNotifications` already `select('*')` so the columns arrive with no
query change. `SubmissionNotificationType` union gains `'issue'`.

### `src/screens/staff/lib` surface (staff carve-out — supabase-direct)

Staff subtree is a documented supabase-direct carve-out (CLAUDE.md), so this does
NOT go through `db.ts`. New `src/screens/staff/lib/reports.ts`:

```
export async function submitStaffReport(
  storeId: string,
  category: StaffReportCategory,   // 'equipment' | 'inventory' | 'app_tech' | 'other'
  message: string,
): Promise<string>                 // resolves to the report id; throws on error
```

Calls `supabase.rpc('submit_staff_report', { p_store_id, p_category, p_message })`;
on `error` throw (the Settings form maps it to `notifyStaffBackendError` +
inline error copy — no silent success). No snake→camel mapping needed (returns a
scalar uuid).

### Realtime impact

The admin bell rides the EXISTING channels; `public.notifications` is already in
the `supabase_realtime` publication (spec 120 Part 7). Adding a new row `type`
AND new nullable columns to an already-published table changes NO publication
membership, so **there is NO `docker restart supabase_realtime_imr-inventory`
step** for this migration (unlike a publication `add table`). Staff stack stays
non-realtime (spec 062). No new channel.

### Frontend store impact

- **Admin `useStore.ts`:** no slice change. New `'issue'` rows flow through the
  existing `submissionNotifications` load + realtime path; only the
  `AdminNotification` type + `mapNotification` widen (above). The
  `NotificationBell` renders an `issue` row: a category badge
  (`t('chrome.submissionBell.issueCategory.<category>')`) + the `body` message on
  the primary line, `store_name` + reporter (`actor_name`) + relative time on the
  secondary line. Optimistic-then-revert does not apply (read-only feed).
- **Staff `useStaffStore.ts`:** no slice change. The report form uses local
  component state; submit is a one-shot RPC via `submitStaffReport`. Not an
  optimistic mutation — success clears/disables the form, failure surfaces an
  inline error via `notifyStaffBackendError`.

### Frontend surface (for the frontend-developer)

- **New `src/screens/staff/screens/Settings.tsx`** — a `SafeAreaView` with a
  header (title + back affordance), mounting in order: `NotificationSwitcher`,
  `LocaleSwitcher`, `ScaleSwitcher`, the ReportIssue form (category segmented
  picker — reuse the LocaleSwitcher three-pill shape — + message `Input` +
  submit `Button`), and a Sign out action. Reuse the existing per-screen
  sign-out logic verbatim (`unsubscribeFromPush()` → `supabase.auth.signOut()` →
  `setActiveStore(null)` → toast → `setAuthState({kind:'signed-out'})`,
  `Reorder.tsx:485`). NOTE: that sign-out block is duplicated across the four
  in-store screens; extracting a shared `useStaffSignOut()` hook is a reasonable
  cleanup but is OUT OF SCOPE here — replicate, do not refactor, unless the
  developer wants to raise it.
- **`StaffStack.tsx`** — in the `activeStore` branch, add a sibling
  `<Stack.Screen name="Settings" component={Settings} />` next to
  `StaffTabs`. Tab screens navigate via `navigation.navigate('Settings')` (the
  call bubbles from the nested tab navigator to the parent stack). Settings gets
  a back affordance (header back or an explicit button → `navigation.goBack()`).
- **Gear entry point** — the four in-store screens (EODCount, Reorder,
  WeeklyCount, Receiving) each own their header markup; there is NO shared header
  component. Add a gear `Pressable` to each header row (next to the existing
  sign-out button), `testID="staff-settings-gear"`, `accessibilityLabel`
  (`t('chrome.settings.gearAria')`), `onPress={() => navigation.navigate('Settings')}`.
  Keep the inline `LocaleSwitcher` / `ScaleSwitcher` rows as-is (Q4). Extracting
  a shared staff header is out of scope — note it as backlog.

### i18n keys

Staff catalog (`src/screens/staff/i18n/{en,es,zh-CN}.json`), under `chrome`:
- `chrome.settings.title`, `chrome.settings.gearAria`, `chrome.settings.back`.
- `chrome.reportIssue.title`, `.categoryLabel`, `.messageLabel`,
  `.messagePlaceholder`, `.submit`, `.submitting`, `.success`, `.error`,
  `.category.{equipment,inventory,app_tech,other}`.

Admin catalog (`src/i18n/{en,es,zh-CN}.json`), under `chrome.submissionBell`:
- `type.issue` (e.g. "Issue").
- `issueCategory.{equipment,inventory,app_tech,other}` (badge labels).

### Tests

- **pgTAP** (`supabase/tests/`): `submit_staff_report` happy path (report row
  persisted with derived brand/store/reporter; `notifications` row emitted with
  `type='issue'`, `category`, `body`, `actor_name`=reporter, `source_id`=report
  id); cross-store/other-brand call refused (`auth_can_see_store` false → 42501);
  invalid category and empty / >2000-char message refused (22023); `staff_reports`
  RLS — privileged same-brand admin + super_admin SELECT visible, non-privileged
  `user` denied; `execute` on `submit_staff_report` revoked from anon, granted to
  authenticated; `notifications_type_check` accepts `'issue'`.
- **jest**: Settings screen renders all controls (switchers + form + sign-out);
  gear navigates to Settings (`navigation.navigate('Settings')`); report submit
  with non-empty message calls `submitStaffReport` and clears/disables the form;
  empty message is blocked; a rejected submit surfaces the error and does NOT
  claim success; `NotificationBell` renders an `issue` row with the category badge
  + message (extend `NotificationBell.test.tsx`).

### Risks & tradeoffs

- **Two new columns on `notifications` vs spec-121's zero.** spec 121 reused the
  `actor_name` slot to avoid a `vendor_name` column. `issue` introduces TWO
  genuinely new display concepts (a free-text message AND a badge token) after
  `actor_name` is already spent on the reporter, so there is no reusable slot
  left. Packing category+message into one free-text field would force fragile
  string-parsing in the bell for the badge. Both columns are nullable and
  general (`body` = any future free-text type; `category` = any future
  sub-typed notification), so the churn is bounded. Accepted.
- **Migration ordering.** `20260720000000` is strictly after the latest
  (`20260719000000`); the type-CHECK widen is idempotent (drop-if-exists +
  re-add). Must be `supabase db push`ed to prod AND its version inserted into
  `schema_migrations`, or the `db-migrations-applied.yml` gate turns red
  (MEMORY: prod migration via MCP; the gate is an independent signal from
  `test.yml`).
- **RLS gap check.** Single permissive SELECT policy per new
  `(staff_reports, select)`; predicate is not trivially-wide ⇒ spec-053 lint
  passes with no allowlist edit. No client write policy ⇒ the only write path is
  the definer RPC; forgery surface collapses to the `auth_can_see_store` gate.
- **Performance on the 286 KB seed.** `staff_reports` starts empty; the future
  inbox scan is index-backed. The emit adds one INSERT + one best-effort pg_net
  enqueue per report (rare, human-paced) — negligible.
- **Edge cold-start.** `submission-push-fanout` is already warm from spec-120/121
  traffic; the `issue` branch adds no new dependency. Redeploy required (deploy
  note above).
- **Deploy checklist (main Claude):** (1) apply `20260720000000` to prod + record
  in `schema_migrations`; (2) `supabase functions deploy submission-push-fanout`;
  (3) NO realtime container restart needed; (4) confirm both CI gates green after
  push.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the "## Backend design" in this spec. Backend:
  author migration `20260720000000_staff_reports_issue_notifications.sql`
  (staff_reports table + RLS + notifications body/category columns + type-CHECK
  widen + `submit_staff_report` SECURITY DEFINER RPC), update
  `submission-push-fanout` (issue TYPE_LABEL + select + payload branch), widen
  `AdminNotification` + `mapNotification` + `SubmissionNotificationType`, add
  pgTAP. Frontend: build `Settings.tsx`, register the `Settings` Stack.Screen +
  gear entry point on the four in-store screens, add `src/screens/staff/lib/
  reports.ts#submitStaffReport`, wire the ReportIssue form, add staff + admin
  i18n keys, render the `issue` bell row, add jest. After implementation set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/126-staff-settings-page.md

## Files changed

Frontend implementation (spec 126). Backend files (`supabase/`,
`src/lib/db.ts`, `src/types/index.ts`, `submission-push-fanout`) were authored
in parallel by the backend-developer and are NOT listed here.

New files:
- `src/screens/staff/screens/Settings.tsx` — consolidated staff Settings
  screen (notification/locale/scale switchers + report-issue form + sign-out).
- `src/screens/staff/components/SettingsGear.tsx` — gear (⚙) header control that
  navigates to `Settings`.
- `src/screens/staff/lib/reports.ts` — `submitStaffReport()` staff carve-out
  helper (`supabase.rpc('submit_staff_report', ...)`) + `StaffReportCategory`.
- `src/screens/staff/screens/Settings.test.tsx` — layout + report-form
  submit/validation/success/error coverage.
- `src/screens/staff/components/SettingsGear.test.tsx` — gear → navigate.
- `src/components/cmd/NotificationBell.issue.test.tsx` — full-render test that
  the `issue` bell row shows the message + category badge.

Modified files:
- `src/screens/staff/navigation/StaffStack.tsx` — registered the `Settings`
  Stack.Screen as a sibling of `StaffTabs`.
- `src/screens/staff/screens/EODCount.tsx` — `<SettingsGear />` in the header row.
- `src/screens/staff/screens/Reorder.tsx` — `<SettingsGear />` in the header row.
- `src/screens/staff/screens/Receiving.tsx` — `<SettingsGear />` in the header row.
- `src/screens/staff/screens/WeeklyCount.tsx` — `<SettingsGear />` in a new title
  row (this header has no store/sign-out row) + `titleRow` style.
- `src/components/cmd/NotificationBell.tsx` — `type==='issue'` row rendering
  (category badge + `body` message on the primary line; store + reporter + time
  on the secondary line).
- `src/screens/staff/i18n/{en,es,zh-CN}.json` — `chrome.settings.*` +
  `chrome.reportIssue.*` (incl. `category.*`) keys.
- `src/i18n/{en,es,zh-CN}.json` — `chrome.submissionBell.type.issue` +
  `chrome.submissionBell.issueCategory.*` keys.
- `src/screens/staff/screens/{Reorder,WeeklyCount,Receiving}.test.tsx` — added
  `useNavigation` to the `@react-navigation/native` mock (the header now renders
  `<SettingsGear />`, which calls `useNavigation`).

Verification:
- `npx tsc --noEmit` — clean.
- `npm run typecheck:test` — clean.
- `npx jest` — 112 suites / 1229 tests pass (incl. the new coverage above).
- Browser preview: the `preview_*` tools are not available in this session, and
  the staff Settings surface is only reachable behind a staff-role
  (`profiles.role`) session via `RoleRouter` (the local `admin@local.test` login
  routes to the admin stack, not the staff stack). Verification therefore rests
  on the typecheck + full jest coverage rather than a live browser smoke; a
  reviewer with a staff-role local account can exercise the gear → Settings →
  report flow end-to-end.
