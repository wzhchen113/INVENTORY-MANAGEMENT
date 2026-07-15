# Spec 121: Missed EOD count alerts in the admin notification bell

Status: READY_FOR_REVIEW

## User story
As a brand admin (or super_admin/master) using the admin Cmd UI, I want the
notification bell to show me when a store failed to submit a scheduled EOD count
by its deadline — visually distinguished from normal submissions with a RED dot,
and with the bell badge turning RED whenever there is any unread miss — so that a
missed count is impossible to overlook, in contrast to the routine
submission-arrived notifications from spec 120.

## Actors and scope
- **Super Admin (`super_admin`) and `master`** — see ALL brands' missed-count
  notifications in the bell and receive the push.
- **Brand admin (`admin`)** — see ONLY their own brand's missed-count
  notifications (scoped by `brand_id` / `auth_can_see_brand()`) and receive the
  push. A brand admin MUST NEVER see or be pushed another brand's misses.
- **Regular users (`user`)** — are the submitters whose *absence* of a submission
  triggers the miss. They do NOT see the bell and are NOT recipients.

This EXTENDS spec 120 (the submission bell). It adds a new notification TYPE to
the existing system — it is NOT a new bell, table, store slice, push function, or
RLS model. All of that is reused.

## Acceptance criteria
- [ ] A new notification type `missed_eod` is added to the
      `public.notifications.type` CHECK constraint (currently
      `('eod','weekly','waste','receiving','po')`), via an additive migration
      that drops and re-adds the constraint with the new value included. All
      existing rows and types remain valid.
- [ ] **Detection.** For a scheduled `(store, vendor, business_date)` — a row on
      `public.order_schedule` whose `day_of_week` matches the business date's
      TitleCase weekday — where the store's EOD deadline for that date has passed
      and NO submitted `eod_submissions` row exists for `(store_id, date,
      vendor_id)` (`status = 'submitted'`), exactly ONE `missed_eod` notification
      is emitted, deduped per `(store_id, business_date, vendor_id)` so it never
      double-fires across repeated detection runs.
- [ ] **Deterministic dedup key.** Because a miss has no submission row to point
      at, `notifications.source_id` for a `missed_eod` row is a deterministic UUID
      derived from `(store_id, business_date, vendor_id)` (architect chooses the
      derivation — e.g. `md5(...)::uuid` / uuid_v5). Combined with the existing
      `notifications_type_source_uidx` unique index on `(type, source_id)` and
      `on conflict do nothing`, re-running detection for the same day is a no-op.
- [ ] **Brand scoping is inherited, not re-implemented.** A `missed_eod` row
      carries the store's `brand_id` (via `stores.brand_id`) and is admitted or
      denied by the SAME `privileged_brand_read_notifications` RLS policy from
      spec 120 (`auth_is_privileged() AND auth_can_see_brand(brand_id)`). A
      brand-A admin gets zero brand-B misses even via a hand-crafted query;
      super_admin sees all brands; a same-brand staff `user` sees zero.
- [ ] **Bell visual — red dot on the missed row.** In
      `src/components/cmd/NotificationBell.tsx`, a `missed_eod` row renders its
      leading dot in `C.danger` (red) instead of the `C.accent` used for
      submission rows, so a miss is visually distinct from a routine submission at
      a glance. Submission rows are unchanged.
- [ ] **Bell visual — red badge on any unread miss.** The bell badge turns RED
      (`C.danger`) whenever there is ≥1 UNREAD `missed_eod` notification in the
      viewer's scope; when the unread set contains only submission types, the
      badge uses a non-danger color (`C.accent`) so that red is reserved for
      misses. (This recolors the spec-120 badge, which today is `C.danger` for all
      unread — see Open questions Q1.) Zero unread → no badge, unchanged.
- [ ] **Row label.** A `missed_eod` row reads "Missed EOD count · <store>" (new
      per-type i18n label `chrome.submissionBell.type.missed_eod` in `en`, `es`,
      `zh-CN`). The scheduled vendor name is available (denormalized at emit time)
      so the architect MAY append "· <vendor>", but the store-level label is the
      baseline requirement.
- [ ] **Push.** A `missed_eod` notification pushes to the SAME recipients as a
      submission (brand admins + all super_admin/master, via the reused
      `submission-push-fanout` edge function). The push copy must NOT read
      "... submitted" — the fan-out phrases misses distinctly (e.g. title
      "Missed EOD count", body "<store> · <vendor>"). With `actor_user_id` NULL,
      no submitter is excluded.
- [ ] **Future brands + stores work automatically.** Detection iterates
      `order_schedule` × `eod_submissions` and scopes purely by `stores.brand_id`;
      a new brand or store routes its misses to the right admins with no new code.
- [ ] **No realtime publication change.** `public.notifications` is already in the
      `supabase_realtime` publication (spec 120); adding a row *type* requires no
      publication edit and therefore NO `docker restart` ritual. New misses
      surface on the existing `notifications-{brandId}` channel. This is called out
      explicitly to prevent a spurious "add to publication" step.

## In scope
- Adding `missed_eod` to the `notifications.type` CHECK.
- A detection mechanism (RPC and/or cron; architect's call — see Detection design
  options) that emits one deduped `missed_eod` per missed `(store, date, vendor)`.
- Reusing `emit_submission_notification` (or a thin sibling) so the store→brand
  resolution, denormalized names, `(type, source_id)` dedup, and push-enqueue path
  are shared with spec 120.
- Reusing `submission-push-fanout` for the push, with a `missed_eod` branch in the
  payload copy and TYPE_LABEL map.
- Bell UI: red row dot for misses + red badge when any unread miss (else accent),
  plus the new per-type label + i18n.
- pgTAP for detection + dedup + brand scoping; jest for the badge/row color
  derivation.

## Out of scope (explicitly)
- **Weekly / spot / mid-shift / close counts.** This is EOD only. Rationale:
  owner scoped it to missed EOD counts.
- **Missed vendor ORDERS.** Spec 075 (`record_missed_orders_for_day`) already
  logs those to `audit_log`. Rationale: sibling feature, already covered; do not
  duplicate into the bell.
- **A new table, RLS model, read-state model, store slice, or push function.**
  Rationale: this is a new TYPE on the spec-120 system, per owner direction.
- **Auto-resolving a miss when a late submission arrives** (default: leave the
  miss as a historical record — see Q3). Rationale: audit trail; simplest.
- **Backfilling historical misses on deploy** (default: forward-only — see Q2).
  Rationale: avoid flooding the bell with weeks of past misses.
- **Per-admin mute/preference for miss alerts.** Rationale: owner wants misses
  loud; granular prefs are a future spec.
- **Email fallback on a miss.** Rationale: push + bell only, matching spec 120 Q4
  (default OFF; flag-gated follow-up).
- **Native/EAS push.** Web only, matching spec 120.

## Detection design options (architect decision — flagged, not owner-facing)
The owner asked for detection "after the store's EOD deadline passes." Two viable
mechanisms; the architect picks one and records the tradeoff:

- **Option A — extend `eod-reminder-cron` (runs every 5 min).** Add a per-vendor
  "EOD missed" pass that, once `minutesUntilCutoff < 0` for a scheduled
  `(store, vendor)` on the business date with no submitted `eod_submissions` row,
  calls the emitter once (deduped by `(type, source_id)`). Pro: surfaces the miss
  within ~5 min of the deadline — most responsive, best matches "impossible to
  overlook." Con: the cron's existing EOD track (Track 1) is store-level and
  reminds BEFORE the deadline; missed detection is per-vendor and fires AFTER, so
  it is a genuinely new pass, not a tweak to Track 1. Reuses the cron's
  business-day/timezone helpers.
- **Option B — dedicated daily cron + RPC, mirroring spec 075.** A SECURITY
  DEFINER `record_missed_eod_for_day(p_date date)` RPC + a daily
  `cron.schedule` at a safe global hour (e.g. 07:00 UTC). Pro: byte-for-byte the
  spec-075 pattern (deterministic, idempotent, easy pgTAP). Con: a miss isn't
  surfaced until the next daily run — hours after the deadline, weaker on the
  owner's "impossible to overlook" intent.

Recommendation: **Option A** for timeliness, using the deterministic `source_id`
+ `(type, source_id)` unique index for idempotency (so re-runs every 5 min don't
double-emit). If the architect judges the cron expansion too risky, Option B is
acceptable with the timeliness tradeoff noted. Deadline source and business-date
semantics are the same regardless (see Dependencies).

## Open questions
Resolved with recommended defaults so the architect is unblocked; the owner can
override any at architect review without reshaping the contract. Q1 is the one
that touches already-shipped spec-120 UI and is worth an explicit confirm.

- **Q1 — Badge recolor (genuine fork; touches shipped UI).** The spec-120 badge
  is ALREADY `C.danger` (red) for ANY unread submission. To make "red badge = a
  miss" meaningful, submission-only unread must move to a non-red color
  (`C.accent`), reserving red for misses. **Default: recolor submission-only
  unread to accent; red is triggered by an unread `missed_eod`.** Confirm — this
  changes how the routine spec-120 bell looks. (If the owner prefers the badge
  stay red for everything, the miss distinction lives only in the row dot + label,
  and this AC softens to "red badge when any unread miss, unchanged otherwise.")
- **Q2 — Backfill vs forward-only.** Spec 075 backfilled 28 days. **Default:
  forward-only — detect misses from deploy onward, no historical backfill** — to
  avoid dumping weeks of past misses into the bell on day one. Confirm.
- **Q3 — Late submission after a miss fired.** If a store submits the EOD count
  AFTER the `missed_eod` alert emitted, do we auto-clear/resolve it, or leave it?
  **Default: leave it as a historical record** (simplest; the miss genuinely
  happened and the audit trail matters). Confirm.
- **Q4 — Push default.** **Default: ON**, same recipients and fan-out as spec-120
  submissions (a miss is at least as important). Confirm.
- **Q5 — "Missed" definition + deadline source (confirmation, not a fork).** A
  miss = a vendor on `order_schedule` for the business date with NO submitted
  `eod_submissions` row by the deadline; only SCHEDULED vendors count (an
  unscheduled vendor is not "missed"). Deadline = `stores.eod_deadline_time`
  (default `'22:00'`), with a per-vendor `vendors.eod_deadline_time` override IF
  that column exists (architect confirms the column; the reminder cron currently
  reads `vendors.order_cutoff_time` for orders and `stores.eod_deadline_time` for
  EOD). Business date uses the same 3 AM-rollover + brand timezone approximation
  as `eod-reminder-cron`.

## Open questions resolved (from owner Q&A)
- Q: Weekly counts too? → A: No — missed EOD counts only.
- Q: Visual treatment? → A: Red dot on the missed row + red bell badge when any
  unread miss exists; submission notifications keep their normal treatment.
- Q: New system or extend spec 120? → A: Extend spec 120 — a new notification
  TYPE reusing the table, RLS, emitter, bell, and push fan-out.

## Dependencies
- **Spec 120 infra (reused wholesale):** `public.notifications` +
  `public.notification_reads` tables, `notifications_type_source_uidx`,
  `privileged_brand_read_notifications` RLS policy, `emit_submission_notification`
  + `enqueue_submission_push` helpers, the `submission-push-fanout` edge function,
  the `useSubmissionNotifications` hook + `notifications-{brandId}` realtime
  channel, the `submissionNotifications` store slice, and
  `src/components/cmd/NotificationBell.tsx`.
- **Detection source tables:** `order_schedule` (`store_id`, `day_of_week`
  TitleCase, `vendor_id`, `vendor_name`), `eod_submissions` (`store_id`, `date`,
  `vendor_id`, `status`), `stores` (`eod_deadline_time`, `brand_id`, `name`),
  `vendors` (`name`, possible `eod_deadline_time`).
- **Pattern references:** spec 075
  (`supabase/migrations/20260530000000_record_missed_orders_rpc.sql`) for the
  scheduled-vs-actual detection RPC + cron shape and `to_char(p_date,'FMDay')`
  weekday join; `eod-reminder-cron` for the business-day/timezone helpers and
  scheduled-vs-submitted computation.
- New migration for the CHECK-constraint update + detection RPC/cron. Prod apply
  via the MCP path (db push lacks the prod password); insert the exact version
  into `schema_migrations` so the `db-migrations-applied` gate stays green.

## Project-specific notes
- **Cmd UI section / staff:** admin Cmd UI only. Reuses the spec-120 bell in
  `src/components/cmd/NotificationBell.tsx` / `TitleBar.tsx`. No staff surface.
- **Per-store or admin-global:** brand-scoped, inherited from spec 120.
  Detection is per `(store, vendor)`, but visibility scopes by `brand_id`.
- **Realtime channels touched:** `notifications-{brandId}` (existing). NO
  publication change — `notifications` is already published; no `docker restart`
  ritual needed. Called out to prevent a spurious publication step.
- **Migrations needed:** yes — CHECK-constraint update + detection RPC and/or cron
  schedule. Additive; no destructive DDL. Prod apply via MCP + `schema_migrations`
  insert.
- **Edge functions touched:** `submission-push-fanout` (reused) — add a
  `missed_eod` entry to `TYPE_LABEL` and a payload branch so miss copy doesn't say
  "submitted". No new function; keep `verify_jwt = false` + shared-bearer gate; no
  `ADMIN_ROLES` gate.
- **Web/native scope:** web only (bell + web push), matching spec 120.
- **`app.json` slug:** not touched.
- **Tests (spec 022 tracks):**
  - **pgTAP** — detection emits exactly one `missed_eod` for a scheduled vendor
    past deadline with no submission; a submitted vendor emits none; an
    unscheduled vendor emits none; a second detection run for the same
    `(store,date,vendor)` is a no-op (dedup); the emitted row carries the store's
    `brand_id`; brand-A admin cannot SELECT a brand-B miss (inherited RLS).
  - **jest** — the bell derives a red row dot for `missed_eod` vs accent for
    submissions; the badge is red when unread includes a `missed_eod` and accent
    when unread is submission-only; the `missed_eod` type label renders.
  - **shell smoke (optional)** — invoke the detection RPC/cron path and assert one
    row per miss + idempotent re-run.

## Backend design

Detection mechanism: **Option A — extend `eod-reminder-cron`** (owner-confirmed).
A new per-vendor "miss" pass (Track 3) fires the deduped emitter within ~5 min of
the store's EOD deadline. Tradeoff vs Option B (daily RPC): more responsive
("impossible to overlook"), at the cost of a genuinely new post-deadline pass in
the cron rather than a tweak to the pre-deadline Track 1. Idempotency is carried
by a deterministic `source_id` + the existing `(type, source_id)` unique index +
`on conflict do nothing`, so the 5-minute re-runs across the whole 22:00→02:59
detection window are cheap no-ops after the first emit.

### 1. Data model changes

**Migration:** `supabase/migrations/20260716000000_missed_eod_notification_type.sql`
(after the spec-120 `20260715000000`). Additive, non-destructive.

- **CHECK constraint (only schema change to an existing object).** The
  `public.notifications.type` check is dropped and re-added with `'missed_eod'`
  added:
  - `alter table public.notifications drop constraint <name>;`
  - re-add `check (type in ('eod','weekly','waste','receiving','po','missed_eod'))`.
  - The constraint was created inline in the `create table` at
    `20260715000000_submission_notifications.sql:42`, so Postgres named it
    `notifications_type_check`. The migration must `drop constraint if exists
    notifications_type_check` (defensively) then add the widened check under the
    same name. All existing rows use the legacy five values and remain valid;
    additive-only.
- **New function `public.emit_missed_count(...)`** (see §4). No new table, no new
  column, no new index. The spec-120 `notifications_type_source_uidx` unique
  index and `notifications_brand_created_idx` are reused as-is.
- **NO realtime publication change.** `public.notifications` is already in the
  `supabase_realtime` publication (added at `20260715000000` Part 7). Adding a new
  row *type* does not touch publication membership, so there is **NO** `docker
  restart supabase_realtime_imr-inventory` step for this migration. (Contrast: the
  spec-120 migration DID add the table and DID require the restart. This one does
  not.) This is called out to prevent a spurious "add to publication" step.

**Confirmed: the CHECK-constraint widening + the new `emit_missed_count` function
are the ONLY DDL. No new table.**

Prod apply: via the MCP path (db push lacks the prod password) + insert the exact
version `20260716000000` into `supabase_migrations.schema_migrations` so the
`db-migrations-applied` gate stays green (MEMORY.md prod-migration note).

### 2. RLS impact

**Zero new policies. Zero policy edits.** A `missed_eod` row is just another
`public.notifications` row carrying the store's `brand_id`. It is admitted/denied
by the SAME spec-120 policy `privileged_brand_read_notifications`
(`auth_is_privileged() and auth_can_see_brand(brand_id)`,
`20260715000000_submission_notifications.sql:80`). super_admin/master → all
brands; brand admin → own brand only; same-brand staff `user` → denied by the
privileged conjunct. `notification_reads` policies unchanged. The pgTAP
"brand-A admin cannot SELECT a brand-B miss" case exercises the inherited policy,
not a new one.

`emit_missed_count` is SECURITY DEFINER (table owner) and bypasses RLS to INSERT,
exactly like `emit_submission_notification`; `EXECUTE` is revoked from
`public, anon, authenticated` so no client can forge a miss. `service_role`
retains execute (revokes do not touch it), which is what lets the cron call it.

### 3. Deadline source, business-date, deterministic source_id (pins)

- **Deadline source — CONFIRMED `stores.eod_deadline_time` (default `'22:00'`),
  NO per-vendor override.** There is no `vendors.eod_deadline_time` column
  (`vendors` only has `order_cutoff_time`, added `20260424001643`, used by the
  cron's Track 2 for ORDERS, not EOD). So Q5's "per-vendor override IF the column
  exists" resolves to: the column does not exist → all scheduled vendors of a
  store share that store's single EOD deadline. Precedence question is moot.
- **Business date / weekday — reuse the cron's existing helpers.** `localDate` and
  `weekday` come from `businessTodayInTZ(DEFAULT_TZ)` (3 AM rollover + brand-tz
  approximation, cron lines 32–39), identical to Track 1/Track 2. `order_schedule`
  is joined on `day_of_week = weekday` (TitleCase, matching Track 2 line 258).
- **Deadline-passed test needs a NEW time helper** (the trickiest pin). Track 1's
  `minutesUntilCutoff` returns a POSITIVE value after midnight (at 01:00 local with
  a 22:00 cutoff it reports "+1260 min until", not "passed"), because Track 1 only
  ever fires in the pre-cutoff buckets `[60,30,10]` and never crosses midnight. The
  miss pass DOES span 22:00 → 02:59 (same business date, past the rollover). Add a
  helper `minutesSinceDeadline(deadlineHHMM, tz)` that normalizes across the 3 AM
  rollover:
  ```
  wall = wallPartsInTZ(tz); biz = businessTodayInTZ(tz)
  nowMin = wall.hour*60 + wall.minute;      if wall.hour < 3  nowMin  += 1440
  cutMin = ch*60 + cm;                       if ch      < 3  cutMin  += 1440
  return { minutesAfter: nowMin - cutMin, localDate: biz.localDate }
  ```
  Miss window: `minutesAfter >= 0`. No upper bound is needed — once the wall clock
  passes 03:00 the business date rolls forward and the prior day is no longer
  checked (this is what enforces **forward-only**, no historical backfill, and
  stops the prior day from re-emitting daily). Re-runs inside the window are
  deduped no-ops.
- **Deterministic `source_id` — CONFIRMED md5→uuid**, computed inside
  `emit_missed_count`:
  ```
  md5(p_store_id::text || '|' || p_business_date::text || '|' || p_vendor_id::text)::uuid
  ```
  Postgres casts a 32-hex md5 straight to `uuid`; no `uuid-ossp` extension needed.
  Deterministic per `(store, date, vendor)`, so the `(type, source_id)` unique
  index collapses every re-run to one row. Collisions are impossible cross-type
  (index is on the pair; only `missed_eod` rows carry md5-derived ids).

### 4. Emitter — thin sibling `emit_missed_count` (NOT direct reuse)

`emit_submission_notification(p_type, p_store_id, p_actor, p_source_id)` cannot be
called directly for a miss: (a) it denormalizes `actor_name` from
`profiles(p_actor)` and has no slot for the vendor name we want to display, and
(b) `p_actor` is a `profiles` FK — a vendor id can't ride there. So add a thin
sibling in the same migration, modeled byte-for-byte on the spec-120 emitter's
exception-safe shape (inner `begin/exception when others → raise warning`, so a
notification failure never breaks the cron run):

```
public.emit_missed_count(
  p_store_id      uuid,
  p_vendor_id     uuid,
  p_vendor_name   text,
  p_business_date date
) returns void  -- SECURITY DEFINER, set search_path = public
```

Body:
1. `select brand_id, name into v_brand, v_store_name from stores where id = p_store_id;`
   `if v_brand is null then return; end if;` (storeless/brandless → skip).
2. `v_source := md5(p_store_id||'|'||p_business_date||'|'||p_vendor_id)::uuid`.
3. INSERT `notifications(brand_id, store_id, actor_user_id, type, source_id,
   actor_name, store_name)` = `(v_brand, p_store_id, NULL, 'missed_eod', v_source,
   p_vendor_name, v_store_name)` `on conflict (type, source_id) do nothing
   returning id into v_new_id;`
4. `if v_new_id is not null then perform enqueue_submission_push(v_new_id); end if;`
   (reuses the spec-120 pg_net push helper verbatim — internal, revoked from
   clients; the push is a best-effort side-channel).

`revoke execute on function public.emit_missed_count(uuid,uuid,text,date) from
public, anon, authenticated;`

**Actor NULL is confirmed-safe.** `actor_user_id = NULL` (no submitter). Nothing
downstream dereferences it: the fanout only uses it to *exclude* the actor, and
`if (notif.actor_user_id)` is falsy for NULL → no exclusion, correct (a miss has
no one to exclude).

**Vendor-name denormalization decision (call-out for reviewers).** The vendor name
is stored in the existing `actor_name` display slot rather than adding a
`vendor_name` column. Rationale: for a miss there is no actor, and both consumers
already read `actor_name` — the bell's secondary line renders
`actorName ?? unknownActor` and the fanout body reads `actor_name`. So a miss row
naturally displays "Coca-Cola · 5m ago" in the bell and lets the push body read
"<store> · <vendor>" with zero schema churn. This is deliberate slot reuse, not a
stray hack — documented here so post-impl review doesn't flag it as drift. (The
primary bell line stays `typeLabel · store_name`, so `store_name` is the plain
store, satisfying the baseline "Missed EOD count · <store>" label; the vendor
appears on the secondary line.)

### 5. Detection in the cron (Track 3, new pass)

New pass appended after Track 2 in `supabase/functions/eod-reminder-cron/index.ts`.
No `verify_jwt`/config change (cron function, shared-bearer gate unchanged).
Reuses the already-loaded `stores` (has `eod_deadline_time`) and the `weekday`.

```
// TRACK 3: missed EOD count per (store, vendor) — fires AFTER the deadline.
const { data: sched } = sb.from('order_schedule')
  .select('store_id, vendor_id, vendor_name').eq('day_of_week', weekday);

// One batched read of today's submitted rows → Set('store|vendor').
const { data: submitted } = sb.from('eod_submissions')
  .select('store_id, vendor_id').eq('date', localDate).eq('status', 'submitted');
const submittedSet = new Set(submitted.map(r => `${r.store_id}|${r.vendor_id}`));

for (const row of sched) {
  const store = storeById.get(row.store_id); if (!store) continue;
  const { minutesAfter } = minutesSinceDeadline(store.eod_deadline_time || '22:00', tz);
  if (minutesAfter < 0) continue;                       // deadline not passed yet
  if (submittedSet.has(`${row.store_id}|${row.vendor_id}`)) continue;  // not a miss
  await sb.rpc('emit_missed_count', {
    p_store_id: row.store_id, p_vendor_id: row.vendor_id,
    p_vendor_name: row.vendor_name, p_business_date: localDate,
  });
}
```

- Only SCHEDULED vendors (rows on `order_schedule` for the weekday) count — an
  unscheduled vendor is never "missed" (Q5).
- Miss push to admins is NOT handled in the cron loop; it rides the
  `enqueue_submission_push → submission-push-fanout` path fired inside
  `emit_missed_count` **only when a new row is inserted**, so re-runs neither
  re-insert nor re-push. No `eod_reminder_log` / `vendor_reminder_log` involvement
  (those are the staff-reminder dedup logs; the miss's dedup spine is
  `(type, source_id)`).
- `localDate` uses the cron's `businessTodayInTZ`; the batched `eod_submissions`
  read matches Track 1's `.eq('date', localDate)` semantics plus the
  `status = 'submitted'` filter (the table also holds `'draft'` rows — a draft is
  still a miss).

### 6. Push — `submission-push-fanout` `missed_eod` branch

Recipient resolution is UNCHANGED and correct as-is: supers (all brands) + brand
admins/master of `notif.brand_id`, minus `actor_user_id` (NULL → no exclusion).
Same brand-scoping. Two edits only:

- `TYPE_LABEL`: add `missed_eod: 'Missed EOD count'`.
- Payload copy branch (the current template hardcodes `"${label} submitted"`,
  which must not apply to a miss):
  ```
  const isMiss = notif.type === 'missed_eod';
  const title = isMiss ? 'Missed EOD count' : `${label} submitted`;
  const body  = isMiss
    ? `${notif.store_name ?? ''} · ${notif.actor_name ?? ''}`.trim()  // store · vendor
    : `${notif.actor_name ?? 'A user'} · ${notif.store_name ?? ''}`.trim();
  ```
  (For a miss, `actor_name` holds the vendor name per §4, so the body reads
  "<store> · <vendor>".) `tag`/`url` unchanged.

### 7. `src/lib/db.ts` surface

**No new db.ts helper.** The feed (`fetchAdminNotifications`) and badge count
(`fetchUnreadNotificationCount`) already carry any `notifications` row regardless
of `type`; `mapNotification` (db.ts:1971) passes `row.type` straight through. The
only db.ts-adjacent change is the TS union:

- `src/types/index.ts:1076` — add `'missed_eod'` to `SubmissionNotificationType`.
  `AdminNotification.type` then admits it with no mapper change. snake_case →
  camelCase mapping is untouched (the row shape is identical to a submission row;
  `actor_name` → `actorName` already maps and now carries the vendor for misses).

### 8. Realtime impact

Replayed on the existing `notifications-{brandId}` channel (the spec-120
`useSubmissionNotifications` subscription). **NO publication membership change → NO
`docker restart` ritual** (see §1). A new miss surfaces in the bell live via the
existing channel + the store's `loadSubmissionNotifications` reload path.

### 9. Frontend store impact (`src/store/useStore.ts`)

**No structural slice change.** The `submissionNotifications` / `submissionUnreadCount`
slice (useStore.ts:703–704, 2850–2895) carries `missed_eod` rows unchanged;
`loadSubmissionNotifications`, the optimistic-then-revert `markSubmissionNotificationRead`
/ `markAllSubmissionNotificationsRead` (with `notifyBackendError`) all apply as-is
— a miss is read/marked exactly like a submission. No new action, no new field.

### 10. Bell derivation (`src/components/cmd/NotificationBell.tsx`)

Two color branches; no store selector required (derive from the already-subscribed
`submissionNotifications` feed, mirroring the existing
`notifications.some(n => !n.read)` at line 139):

- **`hasUnreadMissed` (component-local memo):**
  ```
  const hasUnreadMissed = React.useMemo(
    () => notifications.some((n) => n.type === 'missed_eod' && !n.read),
    [notifications],
  );
  ```
- **Badge (recolor — Q1 resolved: reserve red for misses).** The badge still shows
  the total unread count (`submissionUnreadCount`); only its color forks. Change
  the badge `backgroundColor` from the current unconditional `C.danger`
  (line 77) to `hasUnreadMissed ? C.danger : C.accent`, and the badge text color
  from the literal `'#FFFFFF'` (line 86) to `hasUnreadMissed ? '#FFFFFF' :
  C.accentFg` (the Cmd palette's accent-foreground token — white on the light
  accent, near-black on the dark accent — so the count stays legible on the accent
  badge in both palettes). A red badge now means specifically "a count was missed."
- **Row dot (line 184).** Change `backgroundColor: n.read ? 'transparent' :
  C.accent` to `n.read ? 'transparent' : (n.type === 'missed_eod' ? C.danger :
  C.accent)`. Submission rows are visually unchanged.
- **Row label.** `typeLabel(n.type)` already resolves
  `chrome.submissionBell.type.<type>`; the new key renders "Missed EOD count", and
  the existing `n.storeName ? ' · ' + storeName : ''` appends the store → "Missed
  EOD count · Downtown". The secondary line shows the vendor (via `actorName`) +
  relative time. No JSX structural change beyond the label key.

i18n: add `chrome.submissionBell.type.missed_eod` to `src/i18n/en.json`
("Missed EOD count"), `es.json` ("Conteo EOD no realizado" — final copy at
translator's discretion), `zh-CN.json` ("未完成的 EOD 盘点").

### 11. Confirmation — nothing else disturbed

The four spec-120 submission triggers, `emit_submission_notification`, and the
single-store submission path are untouched. The only visible change to the
already-shipped spec-120 bell is the **intended** badge recolor (danger → accent
when the unread set is submission-only), owner-confirmed as Q1. Submission row
dots stay accent; the header "mark all read" accent stays; no other surface reads
the badge color.

### Risks and tradeoffs

- **Critical — the after-midnight sign bug.** Reusing Track 1's `minutesUntilCutoff`
  for the miss test would silently never fire between midnight and the 03:00
  rollover (positive "minutes until" for a past deadline). The new
  `minutesSinceDeadline` with the `+1440` rollover normalization is load-bearing;
  the pgTAP/shell smoke must include a post-midnight-same-business-date case.
- **Should-fix — badge-vs-feed window skew.** `hasUnreadMissed` derives from the
  ≤50-row, 30-day feed while `submissionUnreadCount` comes from the RPC over the
  full window. If >50 unread rows exist and every miss is pushed past row 50, the
  badge could show accent while a miss is unread. Misses are low-volume and the
  feed is newest-first, so a recent miss is in-window; acceptable for v1. If volume
  grows, add an `unread_missed_notification_count()` SECURITY INVOKER RPC (mirrors
  `unread_notification_count`) and drive the fork off it. Flagged, not blocking.
- **Minor — 5-hour no-op window cost.** Each 5-min run in the 22:00→02:59 window
  issues one `emit_missed_count` RPC per still-missed `(store, vendor)`; all but
  the first are `on conflict do nothing` no-ops. One batched `eod_submissions` read
  per run keeps it cheap on the 286 KB seed. No upper bound needed.
- **Minor — migration ordering.** `20260716000000` must sort after the spec-120
  `20260715000000` (it references `notifications`, `enqueue_submission_push`, and
  the `(type, source_id)` index from that migration). Manual verification is the
  reality (no CI migration-apply gate blocks a mis-order); the `db-migrations-applied`
  gate only checks repo-vs-prod presence, not intra-repo dependency order.
- **Minor — edge-function cold start.** The added Track 3 is O(schedule rows) with
  one extra batched read; negligible against the existing two tracks. No new cold
  path.

### Open question surfaced (non-blocking)

`app.json` slug is untouched (not implicated). No other open question; all owner
defaults (Option A, badge recolor, forward-only, no auto-resolve, push ON) are
locked per the dispatch.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Backend — author
  `supabase/migrations/20260716000000_missed_eod_notification_type.sql` (widen the
  `notifications_type_check` to include `'missed_eod'` + add the SECURITY DEFINER
  `emit_missed_count(uuid,uuid,text,date)` sibling with the md5→uuid source_id and
  revokes), add the Track 3 miss pass + the `minutesSinceDeadline` helper to
  `supabase/functions/eod-reminder-cron/index.ts`, and add the `missed_eod`
  TYPE_LABEL + payload branch to `supabase/functions/submission-push-fanout/index.ts`;
  add pgTAP per the spec's test list (incl. the post-midnight case). Frontend — add
  `'missed_eod'` to `SubmissionNotificationType` (`src/types/index.ts`), the
  red-dot/red-badge + `hasUnreadMissed` derivation to
  `src/components/cmd/NotificationBell.tsx` (badge text uses `C.accentFg` on the
  accent branch), and the `chrome.submissionBell.type.missed_eod` label in
  en/es/zh-CN; add the jest color-derivation tests. No db.ts helper and no store
  slice change are needed. After implementation, set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/121-missed-eod-count-alerts.md

## Files changed (frontend — spec 121)

Frontend scope only (the badge/row-dot recolor + type union + i18n + jest). No
`supabase/` files touched — backend (migration/cron/edge/pgTAP) built in parallel.

- `src/types/index.ts` — added `'missed_eod'` to the `SubmissionNotificationType`
  union (the only mirror; `AdminNotification.type` inherits it and
  `db.mapNotification` passes `row.type` through unchanged — no mapper change).
- `src/components/cmd/NotificationBell.tsx` — added the `hasUnreadMissed` memo and
  extracted pure, exported color-derivation helpers (`feedHasUnreadMissed`,
  `badgeBackgroundColor`, `badgeTextColor`, `rowDotColor`); badge background forks
  `C.danger`↔`C.accent` and badge text forks `#FFFFFF`↔`C.accentFg` on
  `hasUnreadMissed` (recolors the routine spec-120 submission badge off red per
  owner Q1); the row unread dot forks `C.danger` for `missed_eod` rows, `C.accent`
  otherwise. Row label reuses the existing `typeLabel(n.type)` +
  ` · storeName` path; the new i18n key renders "Missed EOD count · <store>".
- `src/i18n/en.json` / `src/i18n/es.json` / `src/i18n/zh-CN.json` — added
  `chrome.submissionBell.type.missed_eod` (parity green).
- `src/components/cmd/NotificationBell.test.tsx` (new) — jest color-derivation
  tests: badge is danger iff an unread `missed_eod` exists (else accent w/
  accentFg text); a `missed_eod` row dot is danger, a submission dot is accent,
  read rows are transparent. Closes the "no bell test" gap flagged in spec 120.
- `src/components/cmd/TitleBar.test.tsx` — completed the store fixture with
  `submissionNotifications: []` (+ unread count + mark actions) since the bell now
  derives `hasUnreadMissed` from the feed on every render (previously the `.some`
  was gated behind the opened panel).

### Verification
- `npx tsc --noEmit` — clean.
- `npx jest` — full suite green (103 suites / 1193 tests), including the new
  `NotificationBell.test.tsx` (9 tests) and the i18n parity test.
- Browser preview: NOT performed. Preview tooling is not available in this
  environment, and the red-miss state has no data to render until the parallel
  backend (migration + Track 3 cron emitting `missed_eod` rows) is deployed. Per
  the dispatch, tsc/jest are the gate in that case. The submission-badge recolor
  (danger→accent) is a pure derivation covered by the jest fork tests.
