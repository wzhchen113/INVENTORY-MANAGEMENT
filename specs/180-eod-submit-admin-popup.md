# Spec 180: Pop-up for admins when a store they run submits (or updates) an EOD count

Status: READY_FOR_REVIEW

## Owner's request (verbatim)
> "i want to have notification popup for admins users whenever a user submit an EOD counts correspoding to the store that the admin is resposible for"

## User story
As an admin who runs a store, I want a pop-up to appear when someone submits or updates that store's end-of-day count, so that I can see the count is in (and approve the order) without opening the bell to check.

## Actors
- **Submitter / editor:** a staff user on the staff EOD app (`staff_submit_eod` RPC), or an admin using the Cmd EOD count section ([src/lib/db.ts](../src/lib/db.ts) `submitEODCount`, a direct PostgREST upsert).
- **Recipient:**
  - `admin` / `master`: only for stores where they have a `public.user_stores` row.
  - `super_admin`: every store in the brand(s) currently in view.
  - Never the person who submitted or edited the count.

## Existing plumbing (verified 2026-10-26 against code and prod; summary only)
- **The bell already exists (spec 120).** Notifications are stored in `public.notifications`, and each viewer's read state is in `public.notification_reads`. Both come from [supabase/migrations/20260715000000_submission_notifications.sql](../supabase/migrations/20260715000000_submission_notifications.sql). Each row carries `brand_id`, `store_id`, `actor_user_id`, `type`, `source_id`, `actor_name` and `store_name`, and `(type, source_id)` is unique. Rows are written by `emit_submission_notification(...)` with `on conflict (type, source_id) do nothing`.
  - Desktop bell: [src/components/cmd/NotificationBell.tsx](../src/components/cmd/NotificationBell.tsx), mounted in the Cmd TitleBar, which is web-only.
  - Phone bell sheet: [src/screens/cmd/sections/phone/PhoneNotifications.tsx](../src/screens/cmd/sections/phone/PhoneNotifications.tsx) (spec 148).
- **Every fresh EOD submit already creates a notification.** The trigger `notify_eod_submission` runs AFTER INSERT on `eod_submissions` WHEN `status='submitted'`.
  - Spec 149 ([supabase/migrations/20260801000200_order_ready_notification_type.sql](../supabase/migrations/20260801000200_order_ready_notification_type.sql)) split it in two. If the vendor has items below par, the type is `order_ready`. Otherwise it is `eod`. Each submission produces exactly one notification.
  - Prod, last 14 days: 30 EOD submits produced 29 `order_ready` and 1 `eod`.
- **The UPDATE path never notifies today.** Every EOD write goes through an upsert on `(store_id, date, vendor_id)`:
  - Staff RPC: `staff_submit_eod` in [supabase/migrations/20261024000000_eod_entries_no_need.sql](../supabase/migrations/20261024000000_eod_entries_no_need.sql) L192-198. The `do update` sets `status`, `submitted_at` and `client_uuid` only, and does **not** change `submitted_by`. After an edit, the row still names the original submitter.
  - Admin Cmd path: [src/lib/db.ts](../src/lib/db.ts) `submitEODCount` L991-1007. The upsert **does** overwrite `submitted_by` with the editor. The entries are then replaced in later, separate requests (delete, then insert). This was already true for fresh submits before this spec.
  - The AFTER INSERT trigger does not fire on the UPDATE branch, and the `(type, source_id)` unique index would drop a second row for the same submission anyway.
  - Consequence 1: edits of an already-submitted count never notify.
  - Consequence 2: a **draft promoted to submitted** (draft row, then a submit for the same store/date/vendor) also goes through the UPDATE branch and does not notify today.
- **Push already exists.** Web push goes through `enqueue_submission_push`, which uses pg_net to call [supabase/functions/submission-push-fanout/](../supabase/functions/submission-push-fanout/). Recipients: every super_admin, plus admin/master users whose `profiles.brand_id` equals the notification's brand, minus the actor.
- **No in-app pop-up exists.** [src/hooks/useSubmissionNotifications.ts](../src/hooks/useSubmissionNotifications.ts) is mounted from [src/navigation/CmdNavigator.tsx:78](../src/navigation/CmdNavigator.tsx) on every Cmd tier. It subscribes to `notifications-{brandId}` realtime INSERTs (one channel per visible brand for super_admin/master), but on an INSERT it only refetches the feed and unread count. `react-native-toast-message` is mounted in [App.tsx](../App.tsx).
- **Recipients are brand-wide today.** The notifications RLS is `auth_is_privileged() AND auth_can_see_brand(brand_id)`. `auth_can_see_store()` gives admins every store in their brand. `public.user_stores (user_id, store_id)` is the only model of "responsible for a store"; on prod, the admin and the super_admin each have 1 row.
- **Submits come in bursts.** EOD submits are split per (store, date, vendor), so one store's evening produces 2–6 submits a few minutes apart (prod).

## Acceptance criteria

### Pop-up (frontend)
- [ ] AC-1: An admin has the Cmd UI open (desktop web or phone tier). Another user makes a qualifying EOD event (AC-7/AC-8) for a store the admin is a recipient for (AC-2). An in-app toast then appears within the existing realtime latency, with no reload. It shows the store name, the submitter/editor name, and whether this is a new submit or an update. For `order_ready`, the wording follows the existing "Order ready to approve" copy.
- [ ] AC-2: Recipient filter (client-side, applied only to the pop-up):
  - An `admin` / `master` viewer gets a pop-up only when the notification's `store_id` is one of their `user_stores` rows. With no `user_stores` rows, they get no EOD pop-ups at all.
  - A `super_admin` viewer gets a pop-up for every store whose `brand_id` is among the brands their notification channels are subscribed to (the existing all-brands / selected-brand logic in `useSubmissionNotifications`).
- [ ] AC-3: When `actor_user_id` is the viewer's own `auth.uid()`, no pop-up appears.
- [ ] AC-4: Grouping. Qualifying events for the **same store** that arrive within 60 s of the previous one in the group become **one** pop-up showing the count and submitter, e.g. "Towson: 4 vendor counts submitted by X". If the group mixes new submits and updates, the copy still says it contains updates. Events for different stores make separate pop-ups. Each event is still its own row in the bell feed.
- [ ] AC-5: Clicking or tapping the pop-up opens the same target as clicking that notification's bell row (the existing deep-link map in `NotificationBell.tsx` / `PhoneNotifications.tsx`). It marks every notification in the group read through the existing `notification_reads` path.
- [ ] AC-6: Rows already in the feed on mount (the initial `loadSubmissionNotifications`), and rows refetched after a brand switch or re-subscribe, never pop up. Only realtime INSERTs that arrive after the channel is subscribed do.
- [ ] AC-6b: Only EOD notification types pop up: `eod`, `order_ready`, and whatever type(s) or marker the architect picks for updates. `weekly`, `waste`, `po`, `receiving`, `missed_eod` and `issue` never pop up.
- [ ] AC-6c: Pop-up text is translated in `en`, `es` and `zh-CN` (`src/i18n/*.json`).

### Notification events (backend, requires a migration)
- [ ] AC-7: **Fresh submit.** No change from today: inserting an `eod_submissions` row with `status='submitted'` creates exactly one `eod` / `order_ready` notification row.
- [ ] AC-8: **Edit of a submitted count.** Re-submitting an `eod_submissions` row whose status was already `'submitted'` before the write (`ON CONFLICT DO UPDATE` with the old status `submitted` and the new status `submitted`) creates **one new** notification row **per edit**. The row:
  - is visible in the bell feed and on the desktop and phone tiers, under the same brand RLS as today;
  - goes out on the `notifications-{brandId}` realtime INSERT (so it drives the pop-up);
  - can be recognised in the bell and the pop-up as an update (e.g. "updated").

  This must hold on **both** write paths: `staff_submit_eod` and the `db.ts submitEODCount` PostgREST upsert. N rapid re-saves give N rows, and the pop-up grouping in AC-4 collapses them.
- [ ] AC-9: **Actor on an edit.** The update notification's `actor_user_id` / `actor_name` is the user who made **that edit** (`auth.uid()` at write time), not the original submitter. This matters because `staff_submit_eod`'s UPDATE branch leaves `eod_submissions.submitted_by` unchanged (see plumbing).
- [ ] AC-10: **Drafts.**
  - Draft writes never notify, whether they are a new draft or a re-save of a draft (draft→draft).
  - A submitted→draft transition, if any path allows it, never notifies.
  - A **draft→submitted** promotion counts as a **fresh submit**: one `eod` / `order_ready` notification that is **not** marked as an update. (PM-derived default; see the resolved questions.)
- [ ] AC-11: Fresh-submit notifications (AC-7) keep their exactly-once guarantee per submission. The new edit rows must not let a duplicate *fresh-submit* row through.
- [ ] AC-12: Bell feed RLS, the bell badge and the recipient set for fresh-submit web push are unchanged. Push scope stays brand-wide.

### Tests
- [ ] AC-13 (jest): Unit tests for the pop-up decision. Given an incoming notification row, the viewer id and role, the viewer's `user_stores` store ids and the subscribed brand ids, the decision is show / suppress / group. The tests cover AC-2, 3, 4, 6, 6b and the update marker.
- [ ] AC-14 (pgTAP): DB tests covering the following.
  - Fresh insert with `submitted` gives 1 row (unchanged).
  - Submitted→submitted edit via `staff_submit_eod` gives +1 update row whose actor is the editing caller.
  - Submitted→submitted edit through a plain `INSERT ... ON CONFLICT DO UPDATE` as an admin JWT (the same SQL shape PostgREST produces for the `db.ts` path) gives +1 update row.
  - Two consecutive edits give 2 update rows.
  - Draft insert and draft→draft give 0 rows.
  - Draft→submitted gives 1 non-update row.
  - Existing notification-related pgTAP tests still pass.

## In scope
- An in-app toast pop-up on every Cmd tier (desktop web and phone tier) for EOD submits and EOD updates.
- A client-side recipient filter for the pop-up: `user_stores` for admin/master, the brands in view for super_admin, and never the actor.
- Grouping a store's events within 60 s into one pop-up.
- A **migration** so that edits of a submitted EOD count (and draft→submitted promotions) create notification rows. The mechanism (UPDATE trigger, new type vs. marker column, changing the `(type, source_id)` dedupe) is the architect's decision.
- Rendering the update marker in the bell feed rows (desktop and phone), so the new rows don't show up as indistinguishable duplicates.
- Translation keys for the new copy.

## Out of scope (explicitly)
- **Email notifications.** Resend has no verified domain.
- **Narrowing bell RLS or push fan-out to `user_stores`.** The owner chose to keep bell and push brand-wide.
- **Pop-ups for non-EOD types.** Not requested.
- **Pop-ups in the staff app (`src/screens/staff/`).** The request is about admins.
- **Native (EAS) push or expo-notifications changes.** Not requested.
- **Changing `user_stores` assignment UI or adding a new "responsible for" model.** v1 reuses the existing table.
- **Per-user mute/snooze for the pop-up.** Not requested; a possible follow-up.
- **Fixing `staff_submit_eod` leaving `submitted_by` unchanged on edit.** Out of scope beyond what AC-9 needs: the notification's actor must be correct, but whether `eod_submissions.submitted_by` itself is rewritten is the architect's call, and it must not change audit-log behaviour.
- **Any change to the `app.json` slug.** Not touched.

## Open questions resolved (from owner Q&A)
- Q1 Pop-up form → A: an **in-app toast on every Cmd tier** (desktop and phone). The existing web push is unchanged, including its scoping. *(Owner-answered.)*
- Q2 Who is "responsible for the store" → A: **admin/master get a pop-up only for stores where they have a `user_stores` row; super_admin gets it for every store in the brand(s) in view.** The bell feed and push stay brand-wide. *(Owner-answered; matches the PM default.)*
- Q3 Do edit re-submits notify → A: **Yes.** Re-submitting an already-submitted (store, date, vendor) must give a pop-up marked as an update. Each edit creates a new notification row that shows in the bell feed and drives the pop-up, and rapid re-saves collapse through the per-store pop-up grouping. Drafts never notify. The mechanism is the architect's call. *(Owner-answered.)*
  - PM-derived consequence (flagged for the owner): a draft→submitted promotion currently notifies **nobody**, because it goes through the same UPDATE branch. The spec treats it as a fresh, non-update submit (AC-10). That is the most literal reading of "whenever a user submits". The owner should push back if they disagree.
- Q4 Is the admin's own submit excluded → A: **No pop-up when the viewer made the submit or edit.** The bell is unchanged. *(Defaulted, not owner-answered.)*
- Q5 Batching → A: **Group a store's events within ~60 s into one pop-up** (e.g. "Towson: 4 vendor counts submitted by X"). Each submit still gets its own bell row. *(Owner-answered.)*
- Q6 Do `order_ready` and `eod` both pop up → A: **Both.** *(Defaulted, not owner-answered.)*

## Architect decisions requested (not owner questions)
- **Mechanism for edit notifications.** For example: an AFTER UPDATE trigger WHEN old.status='submitted' AND new.status='submitted', plus a new `eod_update` type (or an `is_update` column) with a per-edit unique `source_id`. Alternatively, relax `(type, source_id)` for the edit type only. Whatever is chosen must keep AC-11 exactly-once for fresh submits. If a new type is added, also update the TS union `SubmissionNotificationType`, the bell row rendering, and both deep-link maps.
- **Type on an edit row.** Should an edit be re-classified as `order_ready` vs `eod` against the new entries? On the `db.ts` path the parent upsert lands **before** the entries are replaced (separate requests), so a trigger on the parent row would see the old entries. The same ordering already affects fresh submits on that path today. Decide whether this matters for edit rows and document it. Confirm that inserting an `order_ready`-typed edit row has no side effects in the spec 149 approve-order pipeline (no duplicate draft POs or approval state).
- **Actor resolution on edits (AC-9).** `staff_submit_eod` does not update `submitted_by`. Decide where the editor's identity comes from (`auth.uid()` in the trigger, or a column the RPC sets).
- **Should edits send web push?** **PM recommendation: yes,** to the same brand-wide recipients minus the actor, for consistency with fresh submits. This is flagged for the owner to see at review, because it increases push volume during an editing burst. If yes, `submission-push-fanout` may need update-aware copy. If no, document why. Push has no 60 s grouping, so N re-saves would mean N pushes. Consider whether the architect wants a throttle; it is not required by this spec.

## Dependencies
- Spec 120: notifications table, bell, `useSubmissionNotifications`, `submission-push-fanout`, `enqueue_submission_push`.
- Spec 148: phone-tier `PhoneNotifications` sheet and its deep-link map.
- Spec 149: the `order_ready` branch of `notify_eod_submission`, and the approve-order pipeline.
- Spec 172 migration [20261024000000_eod_entries_no_need.sql](../supabase/migrations/20261024000000_eod_entries_no_need.sql): the latest owner of `staff_submit_eod` (if the RPC body must change, copy it verbatim from there).
- `public.user_stores`: the client needs the current admin's assigned store ids. Check whether `useStore` already loads them.
- `react-native-toast-message`: already mounted in `App.tsx`.
- Supabase Realtime on `public.notifications`: already in the publication. If the migration touches the publication, the local realtime-slot gotcha applies (`docker restart supabase_realtime_imr-inventory`).

## Risks
- **Prod migration.** This spec needs a migration on prod. It **must not be applied without the owner's explicit approval** (prod applies go via Supabase MCP plus a `schema_migrations` insert, per project practice). After the push, both CI gates (`test.yml`, `db-migrations-applied.yml`) must be green.
- **Noise.** Edit rows add bell entries, and push entries if push is enabled for edits. Grouping only applies to the pop-up.
- **Path asymmetry.** Two write paths (the RPC and the PostgREST upsert) with different `submitted_by` behaviour on edit. Tests must cover both (AC-14).

## Project-specific notes
- Cmd UI section: none new. The pop-up hangs off the Cmd shell (`CmdNavigator` → `useSubmissionNotifications` or a sibling hook), so it shows on every section and tier. The bell components get only the update-marker rendering.
- Scope: per store for the pop-up (`user_stores` for admin/master); brand-wide for super_admin, the bell and push (unchanged).
- Realtime channels touched: `notifications-{brandId}`, already subscribed. No new channel; `store-{id}` and `brand-{id}` are untouched.
- Migrations needed: **yes.** Edit and draft→submitted notification emission, plus whatever dedupe/type change the architect picks. **Needs explicit owner approval before the prod apply.**
- Edge functions touched: `submission-push-fanout` only if the architect sends edits through push with update-aware copy. Otherwise none.
- Web/native scope: the Cmd UI on web, desktop and phone tier. Native admin is not a target; the pop-up must not crash there, but it does not need to appear.
- Tests: jest (pop-up decision logic, bell update marker) and pgTAP (edit/draft notification emission on both write paths).

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria
  and any project-specific notes, then produce the design doc and set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/180-eod-submit-admin-popup.md

## Backend design

### 0. Ground truth checked before designing (read this first)

**Newest definitions** (grepped across `supabase/migrations/`; the uncommitted `20261025000000` and `20261026100000` touch none of these objects):

| Object | Newest owner | Notes |
|---|---|---|
| `tg_notify_eod_submission()` | `20260801000200_order_ready_notification_type.sql` Part 4 | spec 149 eod / order_ready exclusive branch, whole body wrapped in an exception envelope |
| trigger `notify_eod_submission` | `20260715000000_submission_notifications.sql` L207-211 | `after insert ... when (new.status = 'submitted')`; never redefined since |
| `emit_submission_notification(text,uuid,uuid,uuid)` | `20260715000000` Part 4 | `on conflict (type, source_id) do nothing` |
| `emit_order_ready(uuid,uuid,text,uuid,uuid)` | `20260801000200` Part 3 | `body` = vendor name |
| `eod_vendor_has_below_par(uuid,uuid,uuid)` | `20260801000200` Part 2 | reads pre-count `inventory_items.current_stock` |
| `notifications_type_check` | `20260829000000_auto_place_order_attempts.sql` Part 3 | **9 values:** `eod, weekly, waste, receiving, po, missed_eod, issue, order_ready, order_failed` |
| `staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)` | `20261024000000_eod_entries_no_need.sql` | **Not modified by this spec** |
| `eod_submissions_set_submitted_by()` + `eod_submissions_set_submitted_by_trg` | `20260514120030_eod_submissions_consistency.sql` L78-94 | `BEFORE INSERT OR UPDATE`, sets `new.submitted_by := auth.uid()` unconditionally; never dropped by a later migration |

**Correction to the plumbing section (PM item 2, "submitted_by on the staff-RPC edit path").** The RPC's `do update set` list does not name `submitted_by`. But the `BEFORE INSERT OR UPDATE` trigger `eod_submissions_set_submitted_by_trg` also fires on the `ON CONFLICT DO UPDATE` branch and overwrites `new.submitted_by := auth.uid()`. So on **both** write paths, after an edit the row's `submitted_by` already names the **editor**, not the original submitter. (The RPC's own comment at `20261024000000` L186-191 says the same.) The "row still names the original submitter" claim matches the RPC text but not the effective behaviour, unless prod is missing that trigger.
- The design does not depend on which is true: the edit actor is taken from `auth.uid()` (§1.6), which is correct either way.
- **Pre-flight for the prod apply (required):** run `select tgname, tgenabled from pg_trigger where tgrelid = 'public.eod_submissions'::regclass and not tgisinternal;` and record the result in `reviews/prod-apply.md`, so the spec's record is accurate.
- No change to `eod_submissions.submitted_by` semantics and no change to `audit_log` behaviour. `staff_submit_eod` is not touched.

**PM item 3 (order_ready timing on the db.ts path) is not specific to db.ts.**
- On **both** paths the row trigger fires at the end of the parent upsert statement, before any `eod_entries` are written and before `current_stock` is bumped.
  - On the RPC path, the entries loop runs later in the same function.
  - On db.ts, it runs in later HTTP requests.
- `eod_vendor_has_below_par` reads `inventory_items.current_stock` (the pre-count on-hand) on both paths. That approximation is already documented in spec 149.
- The design does not change it for fresh submits, and avoids it for edits (§1.3).

### 1. Data model changes

**Migration:** `supabase/migrations/20261027000000_eod_update_notifications.sql`
- Sorts after the uncommitted `20261025000000` and `20261026100000`, which are independent of it.
- Wrapped in `begin; ... commit;`.
- `set local lock_timeout = '5s'`, the same as spec 172.
- **Additive and non-destructive.** No policy change and no publication change.

#### 1.1 Mechanism chosen: a new type `eod_update`, a per-edit `source_id`, and a nullable `submission_id` column

Rejected alternatives:
- **Make `notifications_type_source_uidx` partial** (e.g. `where type <> 'eod_update'`), or **widen it to `(type, source_id, revision)`**.
  - Postgres only infers a partial or wider unique index for `ON CONFLICT (type, source_id)` if every emitter adds a matching `WHERE` / column.
  - The five live emitters (`emit_submission_notification`, `emit_order_ready`, `emit_missed_count`, the spec-126 issue emitter, `emit_order_failed`) would all raise "no unique or exclusion constraint matching the ON CONFLICT specification".
  - Redefining all five to fix that is too much blast radius for this feature.
- **Reuse `eod` / `order_ready` with an `is_update` flag.** Edit rows still need a unique `source_id`, so the submission id has to live somewhere else anyway.
  - Worse, an edit row typed `order_ready` would collide with spec 149's lookup `PhoneApproveOrder.tsx:199` (`n.type === 'order_ready' && n.sourceId === request.submissionId`).
  - It would also re-trigger the Approve Order deep link for an event that is not an order ask.

Chosen:
- **Fresh submits are unchanged.**
  - `type ∈ {eod, order_ready}` and `source_id = eod_submissions.id`.
  - Exactly-once through the existing full unique index (AC-7, AC-11).
- **Edits** are `type = 'eod_update'`, with:
  - `source_id = gen_random_uuid()`: a per-edit event id, so N edits give N rows, and the unique index is never hit (AC-8);
  - `submission_id = eod_submissions.id`: new column, the durable link back to the submission;
  - `body = vendor name`: reuses the spec-126 free-text slot, as `order_ready` already does;
  - `actor_user_id = auth.uid()`, the editor (AC-9).

#### 1.2 DDL (described; the developer authors it)

- `alter table public.notifications add column if not exists submission_id uuid null;`
  - Comment: "spec 180: set ONLY on `eod_update` rows = the `eod_submissions.id` the edit applied to. For `eod`/`order_ready` rows the submission id is `source_id`. NULL on every other type."
  - **No FK**, matching `source_id`'s no-FK convention. It also avoids taking a lock on `eod_submissions` during the ALTER.
  - **No index.** Nothing filters on it except pgTAP.
  - Nullable with no default, so on PG 17 the add is metadata-only.
- Widen the CHECK: `drop constraint if exists notifications_type_check` and re-add it with the 9 current values plus `'eod_update'` (10 values).
  - Same drop/re-add pattern as specs 121, 126, 149 and 162.
  - **Pre-flight on prod:** `select pg_get_constraintdef(oid) from pg_constraint where conname = 'notifications_type_check'` must show exactly the 9 values above. If it shows more (dashboard drift), stop and reconcile before applying.

#### 1.3 Type on an edit row: one type, never re-classified (PM decision 2)

An edit is **always** `eod_update`. It is never re-classified as `order_ready`. Reasons:
1. At AFTER UPDATE time the predicate can only see the **previous** count's on-hand (`current_stock` from the prior submit). Re-classifying would label the edit by the count it replaces, which is wrong in both directions.
2. Keeping edits out of the `order_ready` type keeps the spec 149 pipeline structurally untouched (§1.8).
3. The spec 149 screen already has the right signal for "the count changed after the ping". `approveOrderState` returns `countChanged` when `eodSubmittedAt > notificationCreatedAt` (`PhoneApproveOrder.tsx:59-76`). After an edit, tapping the original `order_ready` row shows that state, and the new `eod_update` row in the feed explains why.

#### 1.4 Functions

All of them are `language plpgsql` (or `sql`) with `set search_path = public`, and `revoke execute ... from public, anon, authenticated`. That is the same internal-only posture as every spec 120/149/162 emitter.

| Function | Kind | Purpose |
|---|---|---|
| `emit_eod_submit_notification(p_submission_id uuid, p_store_id uuid, p_vendor_id uuid, p_actor uuid) returns void` | SECURITY DEFINER | **Extracted, verbatim:** the branch body of `tg_notify_eod_submission` from `20260801000200` Part 4, including its `begin ... exception when others then raise warning` envelope. `vendor_order_channel` + `eod_vendor_has_below_par`, then `emit_order_ready(...)`, else `emit_submission_notification('eod', ...)`. It is the single source of truth for "fresh EOD notification", used by both the INSERT trigger and the promotion branch. |
| `tg_notify_eod_submission()` | SECURITY DEFINER trigger fn, **redefined** | The body becomes `perform public.emit_eod_submit_notification(new.id, new.store_id, new.vendor_id, new.submitted_by); return null;`. **Behaviour-identical** to today: same actor (`new.submitted_by`) and same branch. Keep the comment, extended with "spec 180: body extracted into emit_eod_submit_notification". The `notify_eod_submission` trigger itself is **not** touched. |
| `emit_eod_update(p_submission_id uuid, p_store_id uuid, p_vendor_id uuid, p_actor uuid) returns void` | SECURITY DEFINER | Same envelope and store→brand / actor-name resolution as `emit_order_ready`. Inserts `(brand_id, store_id, actor_user_id, type, source_id, submission_id, actor_name, store_name, body) = (v_brand, p_store_id, p_actor, 'eod_update', gen_random_uuid(), p_submission_id, v_actor_name, v_store_name, <vendor name or NULL>)` with `on conflict (type, source_id) do nothing returning id`. This never conflicts; the clause is kept for uniformity. Then `if v_new_id is not null and not public.eod_update_push_suppressed(v_brand, p_store_id, v_new_id) then perform public.enqueue_submission_push(v_new_id); end if;` |
| `eod_update_push_suppressed(p_brand_id uuid, p_store_id uuid, p_notification_id uuid) returns boolean` | `language sql stable`, SECURITY INVOKER (always called from a definer context) | `select exists (select 1 from notifications where brand_id = p_brand_id and store_id = p_store_id and type in ('eod','order_ready','eod_update') and created_at >= now() - interval '60 seconds' and id <> p_notification_id)`. Rides `notifications_brand_created_idx`. It is a separate function so pgTAP can test the throttle without pg_net. |
| `tg_notify_eod_resubmission()` | SECURITY DEFINER trigger fn | See §1.5. |

#### 1.5 New trigger and branch logic

```
create trigger notify_eod_resubmission
  after update of status, submitted_at on public.eod_submissions
  for each row when (new.status = 'submitted')
  execute function public.tg_notify_eod_resubmission();
```

*Review fix (architect M-2 / security Low 1):* the trigger is column-scoped. Both real write paths name `status` and `submitted_at` as SET targets:
- the RPC's `do update set status, submitted_at, client_uuid`;
- the db.ts merge-duplicates upsert, which sets every supplied column.

The FK `on delete set null` action on `submitted_by` sets only `submitted_by`, so a JWT-bearing profile delete can no longer fan out one `eod_update` per submitted row. pgTAP G2 pins this.

Pseudocode for `tg_notify_eod_resubmission()`. The whole body sits inside the same `begin ... exception when others then raise warning ... end` envelope, so a notification failure can never roll back a submit:

```
if auth.uid() is null then return null; end if;           -- (G) non-user writes never notify
if old.status = 'submitted' then                            -- (E) edit of a submitted count
  perform emit_eod_update(new.id, new.store_id, new.vendor_id, auth.uid());
elsif exists (select 1 from notifications
               where source_id = new.id and type in ('eod','order_ready')) then
  -- (R) re-promotion after a submitted→draft demotion: the fresh row already
  --     exists, so exactly-once (AC-11) forbids a second one. Treat it as an edit.
  perform emit_eod_update(new.id, new.store_id, new.vendor_id, auth.uid());
else                                                        -- (P) draft/NULL → submitted
  perform emit_eod_submit_notification(new.id, new.store_id, new.vendor_id, auth.uid());
end if;
return null;
```

How each case maps to the ACs:
- **AC-7:** the INSERT path is unchanged. On the conflict branch of an upsert, Postgres fires only UPDATE row triggers, never the INSERT trigger, so the two triggers can never both fire for one row.
- **AC-8:** each edit on either path, the RPC or the PostgREST upsert, gives +1 `eod_update`.
- **AC-9:** the actor is `auth.uid()`. Inside a SECURITY DEFINER trigger, `auth.uid()` still reads the caller's JWT claims (`request.jwt.claims` is a session GUC and is not affected by the definer switch). For the RPC path, that is the staff or admin caller's JWT.
- **AC-10:**
  - A draft insert does not match the INSERT trigger's WHEN clause.
  - Draft→draft and submitted→draft do not match `when (new.status = 'submitted')`.
  - Draft→submitted is case (P): a fresh, non-update `eod` / `order_ready` row with `source_id = submission id`.
- **AC-11:** fresh rows are only ever produced by `emit_eod_submit_notification`, keyed on the submission id under the full unique index. The (R) `exists` check closes the one gap the index does not: `eod` on the first promotion and `order_ready` on a re-promotion are different `type`s, so the index would let both through.
- **(G) Why `auth.uid() is null` instead of a `submitted_at`-changed predicate:**
  - Every real write is user-JWT driven:
    - `staff_submit_eod` refuses any caller without `auth_can_see_store`;
    - service_role is revoked from it;
    - the db.ts path uses the admin JWT;
    - the old service-role staff edge functions are HTTP 410 stubs.
  - Maintenance UPDATEs (an MCP `execute_sql`, a future backfill migration) run with no claims, so they will never spam the bell.
  - A `submitted_at is distinct from` predicate would be **test-hostile**: `now()` is constant inside a pgTAP transaction, so the RPC-path edit arms could never fire.
- **Replays (corrected after review, architect M-1).** A replay of the first submit's `client_uuid` does not notify. A replay of an *edit's* `client_uuid` (a lost-response retry) re-runs the edit and emits one extra `eod_update`.
  - This is a pre-existing RPC idempotency gap: the same replay also duplicates `audit_log` rows.
  - Cause: `staff_submit_eod` keeps the first submit's uuid (`coalesce(...)`), so step (4) only matches that one.
  - pgTAP S3 pins the first-uuid case. S4 pins the edit-uuid re-notify as **known, not endorsed** behaviour.
  - Follow-up: a "staff_submit_eod edit-path idempotency (client_uuid ledger)" spec.

#### 1.6 Actor resolution (PM decision 3)

The actor is `auth.uid()`, read in the trigger. No new column on `eod_submissions` and no RPC change.
- It is correct whether or not `eod_submissions_set_submitted_by_trg` exists on prod (§0).
- When that trigger exists (expected), `auth.uid()` equals `new.submitted_by`, so the two sources agree.

#### 1.7 Rollout safety and rollback

- **Additive:**
  - a nullable column;
  - a widened CHECK (all existing rows stay valid);
  - three new functions, one refactored trigger function, one new trigger.
- **Lock profile:** `ADD COLUMN` (metadata-only) plus `ADD CONSTRAINT CHECK` (a validation scan of `notifications`, which is small: 30-day working set, hundreds of rows) take a brief AccessExclusive lock on `notifications`. `CREATE TRIGGER` takes a ShareRowExclusive lock on `eod_submissions`. With `lock_timeout = 5s`, the migration fails fast rather than stalling staff submits. Apply off-peak (not 21:00-23:00 local, when the EOD bursts happen).
- **Rollback is roll-forward by preference.** A deliberate rollback is, in order:
  1. `drop trigger notify_eod_resubmission`;
  2. restore `tg_notify_eod_submission` verbatim from `20260801000200`;
  3. drop the three new functions;
  4. `delete from notifications where type = 'eod_update'`;
  5. re-add the 9-value CHECK;
  6. drop the column.

#### 1.8 Spec 149 approve-order pipeline: unaffected, and why

- **No edit row is ever `order_ready`.**
  - `PhoneApproveOrder`'s `notificationCreatedAt` lookup (type plus `sourceId`) still resolves to the single fresh row.
  - `PhoneNotifications.onRowPress` attaches an `orderApproval` payload only for `type === 'order_ready'`, so edit rows never open Approve Order.
- **No server-side reader.** `order_approvals` / `create_order_approval` / `report_last_order_context` never read `notifications` (grepped `20260801000100`, `20260803000000`). There are no notification-driven draft POs or approval state to duplicate.
- **The fresh branch is byte-for-byte the same logic** (an extraction, not a rewrite). Pinned by:
  - `submission_notifications.test.sql` arms (5a) and (5b);
  - `order_ready_notifications.test.sql` (E1-E6, D1).
  Both must stay green unchanged.
- **The one behaviour change is the draft→submitted promotion**, which can now emit a fresh `order_ready` that it did not emit before (AC-10, intended). That row is identical in shape to an INSERT-path `order_ready`.

### 2. RLS impact

- **No new table and no policy change.** `eod_update` rows are read through the existing `privileged_brand_read_notifications` (`auth_is_privileged() and auth_can_see_brand(brand_id)`). Bell RLS is unchanged (AC-12).
- **`notification_reads` is unchanged.** Bulk mark-read inserts go through the existing `own_reads_insert` (`user_id = auth.uid()`).
- **`eod_submissions` policies are unchanged.** The db.ts edit path still needs `admin_update_eod_submissions` (`auth_is_privileged() and auth_can_see_store(store_id)`), as it does today. The RPC path is SECURITY DEFINER, as today.
- **The permissive-policy lint (`supabase/tests/permissive_policy_lint.test.sql`) is unaffected:** no policy is added.
- **Spec 097 grants posture:** the new column rides the table-level grants from `20260618000000_public_grants_explicit.sql`, with no column grant and no revoke on the table. The new functions revoke EXECUTE from `public, anon, authenticated`, the same as the existing internal emitters. `postgres` (owner) keeps EXECUTE, which is what the definer trigger path uses.
- **Realtime RLS:** `postgres_changes` on `notifications` is evaluated against the subscriber's JWT, so an admin receives only their own brand's `eod_update` INSERTs. The pop-up's `user_stores` narrowing is a **client-side display filter**, not an authorization boundary, as AC-2 states. A brand admin can already read every one of these rows in the bell.

### 3. API contract

**No new RPC and no new PostgREST resource.**
- **Write paths:** no change to `staff_submit_eod` or to the `submitEODCount` request shape. Notifications are a trigger side effect.
- **Feed read:** `fetchAdminNotifications` already selects `*`, so `submission_id` arrives automatically.
- **Realtime INSERT payload** on `notifications-{brandId}`: `payload.new` carries the full row in snake_case:
  - `id, brand_id, store_id, actor_user_id, actor_name, store_name, type, source_id, submission_id, body, category, created_at`.
  - This is everything the pop-up needs, so **no refetch is needed for the pop-up** (§7).
- **Bulk mark-read:** PostgREST `POST /notification_reads` with `Prefer: resolution=ignore-duplicates`.
  - Body: `[{notification_id}, ...]`; `user_id` defaults to `auth.uid()`.
  - Errors: an RLS violation (403/42501) can only happen if a client sends someone else's `user_id`, which the helper never does. A network error is thrown.

### 4. Edge function changes: `submission-push-fanout` (redeploy required)

**Decision: edits DO push (PM recommendation),** with a server-side throttle. The edge function needs a small change and a redeploy.
- **Why the redeploy cannot be avoided.** With no code change, an `eod_update` row falls into `derivePushCopy`'s default branch: `TYPE_LABEL['eod_update']` is undefined, so the label becomes `'Submission'`. The push would read **"Submission submitted"**, which mislabels the event. That is not reasonable copy.
- **Change** (in `supabase/functions/submission-push-fanout/index.ts` and its jest mirror `src/utils/pushNotificationCopy.ts`, in the same commit, per that file's header contract):
  - Add `eod_update: 'EOD count updated'` to `TYPE_LABEL`.
  - Add a dedicated branch **before** the default: `if (notif.type === 'eod_update') return { title: 'EOD count updated', body: [notif.actor_name ?? 'A user', notif.store_name ?? '', notif.body ?? ''].filter(Boolean).join(' · ') };`
  - The body reads `<editor> · <store> · <vendor>`.
- **Nothing else changes:**
  - `verify_jwt = false` stays (`config.toml` L484-485).
  - The shared-bearer validation (`expectedBearer`) is unchanged.
  - Recipients are unchanged: every super_admin, plus same-brand admin/master, minus `actor_user_id`. So the editor is never pushed about their own edit (AC-12).
  - The `.select(...)` column list is unchanged; `submission_id` is not needed for the copy.
- **Throttle (SQL side, §1.4):** an edit push is suppressed when any `eod` / `order_ready` / `eod_update` row for the same store was created in the previous 60 s.
  - This mirrors the pop-up's 60 s grouping and bounds an editing burst to about 1 push per minute per store.
  - **Fresh-submit pushes are never throttled** (AC-12).
- **Switch-off if the owner says "no push for edits" at review:** delete the `perform enqueue_submission_push` arm in `emit_eod_update`. That is a one-line migration change. The edge-function branch is then dead but harmless.
- **Deploy order (prod, owner-approved):**
  1. Deploy the function **before** applying the migration. The new branch is backward-compatible.
  2. Confirm the function still reports `verify_jwt = false` after the deploy. If it flips to true, every pg_net call returns 401 and **all** submission push breaks, not just edits.
- **Cold start:** fan-out is async through pg_net after commit, so there is no user-facing latency. Extra invocations come only from throttled edits.

### 5. `src/lib/db.ts` surface

| Helper | Signature | Notes |
|---|---|---|
| `mapNotificationRow` (export; rename of the private `mapNotification`, `db.ts:2424`) | `export function mapNotificationRow(row: any): AdminNotification` | Adds `submissionId: row.submission_id ?? null`. `fetchAdminNotifications` switches to it. The realtime pop-up uses it too, so snake→camel mapping stays in one place in db.ts. With no `reads` embed, `read` correctly maps to `false`. |
| `markNotificationsRead` (new) | `export async function markNotificationsRead(ids: string[]): Promise<void>` | `ids.length === 0` → resolves immediately. Otherwise `supabase.from('notification_reads').upsert(ids.map((id) => ({ notification_id: id })), { onConflict: 'notification_id,user_id', ignoreDuplicates: true })` inside `useInflight.getState().track(..., { kind: 'write', label: 'markNotificationsRead' })`. Logs `console.warn` and **throws** on error, the same as `markNotificationRead` (`db.ts:2494`). |

`submitEODCount` is **unchanged**. Its write ordering does not matter for edit rows (§1.3), and its fresh-submit behaviour is pre-existing.

### 6. Realtime impact

- **Channel:** the existing `notifications-{brandId}` channel, INSERT-only, `filter: brand_id=eq.<id>` (`useSubmissionNotifications.ts:60-69`). No new channel. `store-{id}` and `brand-{id}` are untouched.
- **Publication:** **no change.** `public.notifications` has been in `supabase_realtime` since spec 120 Part 7. Adding a column to a table already in the publication is not a membership change.
  - **So the `docker restart supabase_realtime_imr-inventory` step is NOT required for this migration.**
  - Fallback for local dev only: if `payload.new` is missing `submission_id` after `npm run dev:db`, restart the realtime container. The pop-up does not read `submission_id`, so this is cosmetic.
- **`eod_submissions` is already in the publication** (spec 020 tighten). Edits already replay on `store-{id}` and drive the debounced reload, as today.

### 7. Frontend design

#### 7.1 Types (`src/types/index.ts`)

- `SubmissionNotificationType`: add `| 'eod_update'`, with a doc comment covering:
  - `source_id` = a per-edit event id;
  - `submissionId` = the `eod_submissions.id`;
  - `body` = the vendor name;
  - `actor` = the editor;
  - accent colour (not urgent).
- `AdminNotification`: add `submissionId?: string | null`, with the comment "spec 180: set only on eod_update".
- Run `npm run typecheck` and `typecheck:test` to catch any exhaustive `Record<SubmissionNotificationType, ...>`.

#### 7.2 Pure decision module: new file `src/lib/eodPopup.ts`

No React, no store, no supabase; same posture as `storeVisibility.ts`.

```ts
export const EOD_POPUP_TYPES: ReadonlySet<SubmissionNotificationType>; // eod, order_ready, eod_update
export const EOD_POPUP_WINDOW_MS = 60_000;

export type PopupViewer = {
  userId: string;
  role: User['role'];
  assignedStoreIds: readonly string[];   // currentUser.stores (user_stores, loaded at login by auth.ts fetchProfile L209-214)
  subscribedBrandIds: readonly string[]; // the hook's brandIds set
};

export type PopupGroup = {
  storeId: string; storeName: string | null; brandId: string;
  ids: string[];                 // every notification id in the group (arrival order)
  actorNames: string[];          // distinct, arrival order
  submitCount: number;           // eod + order_ready
  updateCount: number;           // eod_update
  orderReady: AdminNotification[]; // order_ready rows, for copy + deep link
  latest: AdminNotification;
  lastAt: number;                // client receipt ms (sliding window anchor)
};

export type PopupDecision =
  | { kind: 'suppress'; reason: 'type' | 'self' | 'notAssigned' | 'brandOutOfScope' | 'role' | 'duplicate' }
  | { kind: 'show';  group: PopupGroup }   // new group → new pop-up
  | { kind: 'group'; group: PopupGroup };  // merged into an open group → update that pop-up

export function decideEodPopup(
  n: AdminNotification, viewer: PopupViewer,
  groups: Readonly<Record<string, PopupGroup>>, seenIds: ReadonlySet<string>, nowMs: number,
): { decision: PopupDecision; groups: Record<string, PopupGroup> };

export function eodPopupCopy(g: PopupGroup, tr: (key: string, vars?: Record<string, string | number>) => string):
  { text1: string; text2: string };

export function eodPopupTarget(g: PopupGroup, sectionFor: (t: SubmissionNotificationType) => string | null):
  { section: string | null; orderApproval?: { submissionId: string; storeId: string } };
```

Rules, applied in this order:
1. **`duplicate`:** the id is already in `seenIds`. This guards against a StrictMode double-subscribe and overlapping re-subscribes.
2. **`type` (AC-6b):** the type is not in `EOD_POPUP_TYPES`.
3. **`self` (AC-3):** `n.actorUserId === viewer.userId`.
4. **Role (AC-2):**
   - `super_admin`: `n.brandId` must be in `subscribedBrandIds`, else `brandOutOfScope`.
   - `admin` / `master`: `n.storeId` must be in `assignedStoreIds`, else `notAssigned`. With zero `user_stores` rows, the result is always `notAssigned`.
   - Any other role: `role`.
5. **Grouping (AC-4):** key = `storeId`.
   - If `groups[storeId]` exists and `nowMs - lastAt <= 60_000`, merge and return `group`.
   - Otherwise start a fresh group (replacing any expired one) and return `show`.
   - The window **slides**: it is anchored on the previous event in the group, per AC-4's "within 60 s of the previous one".
   - The anchor is the client receipt time, not `created_at`, so client/server clock skew cannot split or merge groups wrongly.

`eodPopupCopy` and the i18n keys (`chrome.eodPopup.*`):
- `n = ids.length`, `u = updateCount`.
- **text1**, when `n === 1`, by type:
  - `title.single.eod` → "{store}: EOD count submitted"
  - `title.single.order_ready` → "{store}: Order ready to approve" (the existing order_ready wording, AC-1)
  - `title.single.eod_update` → "{store}: EOD count updated"
- **text1**, when `n > 1`:
  - `title.group.submitted` (u = 0) → "{store}: {n} vendor counts submitted"
  - `title.group.updated` (u = n) → "{store}: {n} vendor counts updated"
  - `title.group.mixed` (0 < u < n) → "{store}: {n} vendor counts submitted ({u} updated)". This satisfies AC-4's "still says it contains updates".
- **text2:**
  - `body.by` → "by {actor}". When `actorNames.length > 1`, use `body.byMany` → "by {actor} and {k} more".
  - When n = 1 and the row has a `body` (vendor), prefix it: `body.vendorBy` → "{vendor} · by {actor}".
  - When `orderReady.length > 0` and n > 1, append `body.readySuffix` → " · {k} ready to approve".
- **Fallbacks:** reuse `chrome.submissionBell.unknownActor` for a null actor. Add `chrome.eodPopup.unknownStore` ("A store") for a null `storeName`.

`eodPopupTarget` (AC-5):
- If the group has an `order_ready` row, the target is the **latest** one: `{ section: sectionFor('order_ready'), orderApproval: { submissionId: row.sourceId, storeId: row.storeId } }`. This is identical to the phone bell's `onRowPress`.
- Otherwise, `{ section: sectionFor(latest.type) }`.

#### 7.3 Hook: new file `src/hooks/useEodSubmitPopup.ts`, composed inside `useSubmissionNotifications`

- **`useSubmissionNotifications` keeps its signature and its single set of channels.** Opening a second set of per-brand channels would double the subscriptions.
  - It calls `const popup = useEodSubmitPopup(brandKey)`.
  - The INSERT handler becomes `(payload) => { useStore.getState().loadSubmissionNotifications(); popup.onInsert(payload.new); }`.
  - `popup.onInsert` must be **referentially stable** (ref-backed), so the channel effect's deps stay `[brandKey]`.
- **`useEodSubmitPopup(brandKey)`:**
  - **State lives in `useRef`:** groups, the `seenIds` Set, the toast display queue and `visibleKey`. It is ephemeral UI state and deliberately **not** put in Zustand.
  - **Reset the groups and the queue when `brandKey` changes.** A super_admin brand switch must not merge into stale groups.
  - **`onInsert(raw)`:**
    1. `const n = mapNotificationRow(raw)`.
    2. Build the viewer at event time from `useStore.getState()`: `currentUser.id`, `currentUser.role`, `currentUser.stores ?? []`, and `brandKey.split(',')`. Reading at event time avoids stale closures.
    3. Call `decideEodPopup`.
    4. On `show` / `group`, render with `Toast.show({ type: 'eodPopup', text1, text2, visibilityTime: 8000, onPress, onHide })`.
       - *Design amendment (architect S-1):* `eodPopup` is a custom toast type registered in `App.tsx`'s `<Toast config={...}>` (`toastConfig`).
       - It spreads the library's default config, so `success` / `error` / `info` render unchanged.
       - It wraps `BaseToast` with `text1NumberOfLines={2}`, `text2NumberOfLines={2}` and no fixed height (`height: undefined, minHeight: 60`).
       - Why: the default one-line `info` toast cut off AC-4's "(N updated)" marker, and in `es` dropped it entirely.
    5. Text comes from `t(useStore.getState().locale, key, vars)` (`src/i18n/index.ts:60`). This runs outside render, so use `t`, not `useT`.
  - **Single toast slot.** `react-native-toast-message` shows one toast at a time, and `Toast.show` replaces the current one. To keep different stores as **separate** pop-ups (AC-4):
    - If the decided group is the one currently visible (`visibleKey`), call `Toast.show` again; it replaces in place with the updated count.
    - Else, if a toast is visible, enqueue the group key (dedupe; a later merge updates the queued group's data).
    - Else, show it now.
    - `onHide` shifts the queue and shows the next group.
    - *Design amendment (approved deviation (a)):* `Toast.show` replaces the current toast **without** calling its `onHide`. A fallback timer (`visibilityTime` + 1 s) therefore frees the slot when a foreign toast has replaced ours.
      - Without it, `visibleKey` would stay set and every later pop-up for another store would queue forever.
      - The timer acts only if `visibleKey` still names the same group. Every re-present, `onHide → showNext` and unmount clears it.
    - `notifyBackendError` toasts share the slot and may pre-empt a pop-up; that is acceptable, see Risks.
  - **`onPress` (AC-5):**
    1. Call `useStore.getState().markSubmissionNotificationsRead(group.ids)`.
    2. If `isPhoneRef.current` (from `useIsPhone()`, `src/theme/breakpoints.ts:36`, the same predicate `ResponsiveCmdShell.tsx:95` uses to mount `PhoneNotifications`), compute `eodPopupTarget(group, sectionForNotification)` (imported from `PhoneNotifications.tsx`) and, when `section` is non-null, call `usePaletteAction.getState().request({ section, selectedName: null, ...(orderApproval ? { orderApproval } : {}) })`.
    3. On desktop and tablet, the bell row only marks read (`NotificationBell.tsx:222`), so the pop-up does the same.
    4. Finally, `Toast.hide()`.
  - **AC-6 (structural).** The pop-up is reachable **only** from the realtime INSERT handler. `loadSubmissionNotifications` (initial load, brand switch, re-subscribe) never calls into it, and realtime does not replay pre-subscribe events.
  - **Native:** `Toast` works on native and nothing here is web-only, so the pop-up does not crash there. It is not required to show, per the spec.

#### 7.4 Store (`src/store/useStore.ts`, spec 120 notification slice near L4577)

- **New action `markSubmissionNotificationsRead: (ids: string[]) => void`.** It uses the optimistic-then-revert pattern with `notifyBackendError`:
  1. Optimistically flip `read: true` for the ids present in `submissionNotifications`, and decrement `submissionUnreadCount` by the number that were unread.
  2. `db.markNotificationsRead(ids)`.
  3. **On success:** if any id was **absent** from the feed (realtime raced the refetch, or the row fell outside the 50-row cap), call `get().loadSubmissionNotifications()` to reconcile the badge.
  4. **On failure:** restore exactly the rows that were flipped, plus the count, then `notifyBackendError('Mark notifications read', e)`.
- **Why the existing single-id action cannot be reused in a loop:** it returns early when the id is not yet in the feed (`if (!target || target.read) return;`, L4590). A pop-up click that beats the refetch would then silently not mark read.
- Add it to the store type next to L1117.
- No other slice changes. The pop-up state is hook-local (§7.3).

#### 7.5 Bell update marker (desktop + phone)

- **Label.** Add `chrome.submissionBell.type.eod_update` = "EOD count updated" (es, zh-CN). Both bells already render `typeLabel(n.type)`, so the row headline reads "EOD count updated · Towson" with no structural change.
- **Secondary line** for `eod_update`: `[n.body, n.actorName ?? unknownActor].filter(Boolean).join(' · ')` + relative time. That is vendor plus editor, so N edit rows for different vendors stay distinguishable.
  - Desktop: `NotificationBell.tsx` L336-343, in the non-issue branch.
  - Phone: `PhoneNotifications.tsx` L329-331.
- **Colour:** dot and badge stay accent. `URGENT_TYPES` is unchanged.
- **Phone deep-link map:** add `case 'eod_update':` next to `'eod'`, returning `'EODCount'`. No `orderApproval` payload (the `onRowPress` ternary is keyed on `order_ready` only, so it is unchanged).

#### 7.6 i18n (`src/i18n/en.json`, `es.json`, `zh-CN.json`)

- New keys:
  - `chrome.submissionBell.type.eod_update`
  - `chrome.eodPopup.title.single.{eod,order_ready,eod_update}`
  - `chrome.eodPopup.title.group.{submitted,updated,mixed}`
  - `chrome.eodPopup.body.{by,byMany,vendorBy,readySuffix}`
  - `chrome.eodPopup.unknownStore`
- Placeholders use the catalog's existing `{name}` interpolation (e.g. `{n}`, as in `chrome.submissionBell.time.minutes`).
- All three locales get identical key sets; the existing `src/i18n/i18n.test.ts` parity check enforces this.
- The `order_ready` single title must reuse the existing "Order ready to approve" wording in every locale (AC-1). Copy it from `chrome.submissionBell.type.order_ready`.
- Suggested `type.eod_update` translations: es "Conteo EOD actualizado", zh-CN "EOD 盘点已更新" (translator's call).

### 8. Test coverage

#### 8.1 pgTAP: new file `supabase/tests/eod_update_notifications.test.sql`

The file is hermetic (`begin; ... rollback;`) and builds its own vendor/item fixtures, following the `submission_notifications.test.sql` pattern, so it is green on seed and on CI-fresh databases. It uses JWT impersonation with `set local role authenticated` plus `request.jwt.claims`.

| Arm | Covers | Assertion |
|---|---|---|
| C1 | CHECK | `'eod_update'` is accepted; all 9 legacy values are still accepted; an unknown value still raises 23514 |
| F1 | AC-7 | A plain INSERT `status='submitted'` → exactly 1 `eod` or `order_ready` with `source_id = submission id`, and 0 `eod_update` |
| S1 | AC-8, AC-9, AC-11 | `staff_submit_eod` first submit as staff user U, then a second call (new `client_uuid`, same triple) as admin A. Result: +1 `eod_update`, with `actor_user_id = A` (**not** U), `submission_id = submission id`, `body = vendor name`, and `source_id <> submission id`. Fresh rows for that submission still = 1. |
| S2 | AC-8 | A third RPC edit → `eod_update` count = 2 |
| S3 | idempotency | An RPC replay with an already-used `client_uuid` → no new rows |
| P1 | AC-8 db.ts shape | As admin JWT: `insert into eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at) values (...) on conflict (store_id, date, vendor_id) do update set store_id = excluded.store_id, date = excluded.date, vendor_id = excluded.vendor_id, submitted_by = excluded.submitted_by, status = excluded.status, submitted_at = excluded.submitted_at`. This is the PostgREST merge-duplicates shape, which sets every supplied column. Result: +1 `eod_update` with actor = admin. |
| D1 | AC-10 | A draft INSERT → 0 rows; draft→draft upsert → 0 rows |
| D2 | AC-10 | Draft→submitted (upsert) → exactly 1 fresh (`eod` or `order_ready`) row and 0 `eod_update` |
| D3 | AC-10, AC-11 | submitted→draft → 0 new rows; then draft→submitted again → +1 `eod_update`, fresh count still 1 |
| G1 | guard | As postgres with null claims, `update eod_submissions set submitted_at = submitted_at where id = ...` on a submitted row → 0 new rows |
| R1 | AC-8 RLS | A brand-A admin SELECTs the `eod_update` row; a foreign-brand admin gets 0; a same-brand `user` gets 0 |
| T1 | push throttle | `eod_update_push_suppressed`: true with a same-store EOD-family row inside 60 s; false when the only other row is backdated `created_at = now() - interval '2 minutes'`; false for a different store |
| A1 | ACL | `has_function_privilege('authenticated', ..., 'EXECUTE')` is false for `emit_eod_submit_notification`, `emit_eod_update`, `eod_update_push_suppressed`, `tg_notify_eod_resubmission` |
| A2 | trigger shape | `pg_get_triggerdef` of `notify_eod_resubmission` contains `AFTER UPDATE OF status, submitted_at` and `(new.status = 'submitted'::text)`; `notify_eod_submission` is still `AFTER INSERT` |
| S4 | M-1 (known) | Replaying an **edit's** `client_uuid` re-runs the edit → +1 `eod_update`. This pins a pre-existing RPC idempotency gap as known behaviour; the follow-up spec flips it |
| G2 | M-2 | An UPDATE that sets only `submitted_by` (the shape of the FK SET NULL action) under a user JWT → 0 new rows |
| V1 | security Low 3 | `emit_eod_update` with a vendor from another brand → `body` is NULL (no cross-brand name leak) |

These existing files must stay green **unchanged**. Any edit to them is a review flag.
- `submission_notifications.test.sql` (5a/5b pin the extracted fresh branch)
- `order_ready_notifications.test.sql`
- `missed_eod_notifications.test.sql`
- `staff_reports_issue.test.sql`
- `auto_place_order_attempts.test.sql` (its CHECK `LIKE` probes still match)
- `staff_role_eod_rls.test.sql`
- `eod_no_need.test.sql`
- `permissive_policy_lint.test.sql`
- the spec-097 grants lint

#### 8.2 jest

- **`src/lib/eodPopup.test.ts`** (AC-13): table-driven over `decideEodPopup`.
  - admin assigned / unassigned / zero `user_stores`;
  - master behaves like admin;
  - super_admin with brand in and out of scope;
  - self-actor suppressed;
  - each of the 7 non-EOD types suppressed;
  - duplicate id suppressed;
  - same store at +59 s → `group`, at +61 s → `show`; the window slides (0, 50, 100 s → one group);
  - two stores → two `show`s;
  - mixed group → `title.group.mixed`;
  - all-updates → `title.group.updated`;
  - multi-actor → `body.byMany`;
  - single `order_ready` → the order-ready title;
  - `eodPopupTarget`: `order_ready` in the group → `orderApproval` from the latest `order_ready`, otherwise the latest type's section.
- **`src/hooks/useEodSubmitPopup.test.ts`** (or extend the existing hook test):
  - AC-6: mounting plus `loadSubmissionNotifications` resolving never calls `Toast.show`;
  - a simulated channel INSERT payload calls `Toast.show` once with the mapped copy;
  - a second same-store payload re-shows (replace);
  - a different store while visible queues, then shows on `onHide`;
  - `brandKey` change resets the groups;
  - `onPress` calls `markSubmissionNotificationsRead(ids)`, plus a palette `request` only when `useIsPhone()` is true.
- **Store** (`src/store/useStore.markNotificationsRead.spec180.test.ts`):
  - optimistic flip plus count decrement;
  - an absent id triggers a reload on success;
  - failure reverts and calls `notifyBackendError`.
  - Per the project memory, also grep for and run any test pinning the old notification-slice behaviour, and run the **full** `npx jest`.
- **db.ts:**
  - `mapNotificationRow` maps `submission_id` → `submissionId` and sets `read: false` without the embed;
  - `markNotificationsRead([])` makes no network call; otherwise it sends the upsert shape with `ignoreDuplicates`.
- **`src/utils/pushNotificationCopy.test.ts`:** the `eod_update` branch gives title "EOD count updated" and body "actor · store · vendor", and it does **not** produce "Submission submitted".
- **`PhoneNotifications.test.tsx` and `NotificationBell` tests:**
  - `sectionForNotification('eod_update') === 'EODCount'`;
  - an `eod_update` row renders the "EOD count updated" label plus vendor · editor, and its tap carries no `orderApproval`.
- **Typecheck:** `npm run typecheck` and `typecheck:test`. The latter is a CI gate that jest alone misses.

### 9. Prod apply runbook (needs explicit owner approval; do not run without it)

*Amended after review (architect S-2).*

0. **Ordering and drift guard.**
   - Run on prod: `select version from supabase_migrations.schema_migrations where version in ('20261025000000','20261026100000','20261027000000') order by 1`.
   - Expect `20261025000000` (spec 177, already applied).
   - If `20261026100000` (spec 179) is **absent**, **either** apply spec 179 first (under its own owner go-ahead and runbook), **or** make sure spec 180's push does not include the spec 179 migration file. Otherwise `db-migrations-applied.yml` hard-fails on the push. **This is a stop condition.**
   - `20261027000000` must be absent.
1. **Pre-flight on prod** (read-only, via MCP):
   - `pg_get_constraintdef` of `notifications_type_check` = exactly the 9 values. If there are more, that is dashboard drift: stop.
   - List the `eod_submissions` triggers and record whether `eod_submissions_set_submitted_by_trg` exists (§0).
   - Normalized-md5 of `tg_notify_eod_submission` matches the `20260801000200` body (the spec 149 original, **not** this file's wrapper).
   - Drift checks, each of which must return nothing (if anything is found: stop):
     - `select count(*) from information_schema.columns where table_schema='public' and table_name='notifications' and column_name='submission_id'` = 0;
     - `select proname from pg_proc where pronamespace='public'::regnamespace and proname in ('emit_eod_submit_notification','emit_eod_update','eod_update_push_suppressed','tg_notify_eod_resubmission')` returns no rows.
   - Confirm `notifications_type_source_uidx` exists (every emitter's `ON CONFLICT (type, source_id)` depends on it).
   - Record `select proowner::regrole from pg_proc where proname='tg_notify_eod_submission'` for the step 4 owner check.
2. **Deploy `submission-push-fanout`.** The change is backward-compatible.
   - **Before deploying,** diff the currently deployed version (MCP `get_edge_function`) against the last committed `index.ts`. The deploy ships the whole working-tree file, so it must not carry unrelated undeployed edits.
   - Deploy with `--no-verify-jwt` explicitly, as a belt over `config.toml`.
   - Afterwards, confirm the deployed function still reports `verify_jwt = false`. If it is true, every pg_net call returns 401 and **all** submission push breaks.
3. **Apply the migration body** exactly as committed (including `begin; … commit;`, `set local lock_timeout` and the review fixes) with `execute_sql`.
   - Then run `insert into supabase_migrations.schema_migrations (version, name) values ('20261027000000', 'eod_update_notifications')`.
   - Apply off-peak (not 21:00-23:00 local).
4. **Verify:**
   - the CHECK definition (10 values);
   - the column exists;
   - `pg_get_triggerdef(notify_eod_resubmission)` shows `AFTER UPDATE OF status, submitted_at ON public.eod_submissions … WHEN ((new.status = 'submitted'::text))`;
   - **owner check:** `proowner::regrole` of all five functions (`emit_eod_submit_notification`, `tg_notify_eod_submission`, `emit_eod_update`, `eod_update_push_suppressed`, `tg_notify_eod_resubmission`) equals the step 1 owner;
   - **ACL check:** `has_function_privilege('authenticated', <fn>, 'EXECUTE')` is false for the four new functions;
   - **normalized-md5 targets** against **this** file, for all five functions. `tg_notify_eod_submission` must now match this file's wrapper body, not the spec 149 body.
5. **Push to `main`,** then confirm both CI gates are green: `test.yml` **and** `db-migrations-applied.yml` (CLAUDE.md rule). Also check `e2e.yml` manually, since its promotion to the gate list is pending.
6. **Smoke test:**
   - Edit a submitted count from the admin Cmd UI as admin A while admin B (with a `user_stores` row for that store) has the Cmd UI open. Expect an "EOD count updated" toast for B and none for A, and one `eod_update` row in the bell.
   - **Promotion check:** save a count as draft, then submit it. Expect exactly one fresh `eod` / `order_ready` row and no `eod_update`.
   - **Push and throttle check:** confirm one edit push arrives for a recipient with a push subscription, and that a second edit to the same store within 60 s does **not** push.

Record all of the above in `specs/180-eod-submit-admin-popup/reviews/prod-apply.md`.

### 10. Risks and tradeoffs

- **The fresh-path refactor is a touch on a frozen surface.**
  - `tg_notify_eod_submission` is redefined. The extraction is verbatim and pinned by the existing pgTAP arms.
  - The alternative, duplicating the branch inside the new trigger function, would give two copies of the spec 149 predicate wiring, which is the drift this project keeps paying for. The extraction is the lesser risk.
- **Push volume.** Edits now push, bounded by the per-store 60 s throttle. The owner should confirm at review (PM flag); switching it off is one line (§4).
  - The throttle also suppresses an edit push that lands within 60 s of a **fresh** push for the same store. This is intentional: "submitted then immediately corrected" gives one ping.
- **Feed crowding.** Edit rows count toward the 50-row / 30-day feed cap and the unread badge. A heavy editing day can push older rows out of the visible head. The badge RPC still counts correctly because it is not capped. This is acceptable for v1; a follow-up could collapse `eod_update` rows in the feed.
- **Toast slot contention.** `notifyBackendError` toasts and pop-ups share one slot. An error toast can pre-empt a pop-up, so the pop-up is lost while the bell row remains. This is accepted because the bell is the durable record.
- **The pop-up can replace other toasts (architect M-3, accepted).** The reverse of the above also happens.
  - When no pop-up is visible but a foreign toast is (a `notifyBackendError`, or one of the roughly 30 other `Toast.show` success/info call sites), a new EOD event calls `Toast.show` and replaces it.
  - The §7.3 fallback timer can do the same when it surfaces the next queued group.
  - During the evening EOD burst, an admin working elsewhere can therefore lose an error or success toast. The optimistic revert still shows in the UI and the error is still `console.warn`'d, so this is accepted for v1.
  - A possible follow-up is an app-wide toast-slot coordinator (one wrapper around `Toast.show`).
- **FK SET NULL fan-out (architect M-2): fixed.** The update trigger is column-scoped (`AFTER UPDATE OF status, submitted_at`, §1.5), so a profile delete's `submitted_by` SET NULL never fires it, even under a user JWT.
- **Edit-uuid replays re-notify (architect M-1): known and pre-existing.** See §1.5. A follow-up spec adds a `client_uuid` ledger to `staff_submit_eod`.
- **Membership freshness.** `currentUser.stores` is loaded at login, so a `user_stores` change made mid-session only applies to the pop-up filter after a reload or re-login. Acceptable: assignments change rarely.
- **The `master` asymmetry is intentional.** The existing hook subscribes masters to all brands, as for super_admin, but AC-2 filters masters by `user_stores`. The decision function, not the channel set, is the authority.
- **The guard (G) assumes every legitimate EOD write carries a user JWT.** That is true today (§1.5). If a future service-role EOD writer appears, its edits will not notify; that spec must revisit (G).
- **Cold start / performance.**
  - Per EOD edit, the trigger adds one indexed `exists` probe on `notifications_type_source_uidx` and one INSERT.
  - Per edit push, it adds one indexed throttle probe.
  - This is negligible against the seed dataset and the prod volume (2-6 submits per store per night).
  - Edge cold-start only affects async push delivery.
- **Path asymmetry (PM risk) is closed.** Both write paths converge on the same AFTER UPDATE trigger and the same `auth.uid()` actor. pgTAP arms S1 and P1 cover each path.
- **No `app.json` slug involvement.** No CI assumption beyond the two gates on disk.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the "## Backend design" in this spec.
  - backend-developer:
    - migration 20261027000000_eod_update_notifications.sql (§1);
    - the submission-push-fanout eod_update copy branch plus its src/utils/pushNotificationCopy.ts mirror (§4);
    - the db.ts helpers mapNotificationRow and markNotificationsRead (§5);
    - pgTAP file eod_update_notifications.test.sql (§8.1).
    - Do NOT apply to prod or deploy the function without the owner's explicit approval (§9).
  - frontend-developer:
    - types (§7.1), src/lib/eodPopup.ts (§7.2), useEodSubmitPopup wired inside useSubmissionNotifications (§7.3);
    - the store action markSubmissionNotificationsRead (§7.4);
    - bell update-marker rendering plus the phone deep-link case (§7.5);
    - i18n in en/es/zh-CN (§7.6);
    - jest (§8.2).
    - The frontend consumes db.ts mapNotificationRow/markNotificationsRead; coordinate the signatures in §5 verbatim.
  After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/180-eod-submit-admin-popup.md

## Files changed (backend — spec 180)

**Migrations**
- `supabase/migrations/20261027000000_eod_update_notifications.sql` (new). Covers §1:
  - the `notifications.submission_id` column;
  - the 10-value `notifications_type_check`;
  - `emit_eod_submit_notification`, extracted verbatim from the spec 149 branch;
  - `tg_notify_eod_submission`, now a thin wrapper;
  - `eod_update_push_suppressed`;
  - `emit_eod_update`;
  - `tg_notify_eod_resubmission` and the `notify_eod_resubmission` `AFTER UPDATE OF status, submitted_at` trigger (column list added by the review fixes);
  - the brand-checked vendor-name lookup in `emit_eod_update` (review fix).
  - Applied locally and recorded in local `schema_migrations`; re-applied after the review fixes. **Not applied to prod.**

**Edge functions**
- `supabase/functions/submission-push-fanout/index.ts`: adds `TYPE_LABEL.eod_update` and an `eod_update` branch in `derivePushCopy` ("EOD count updated" / "<editor> · <store> · <vendor>"), plus a branch-contract comment. **Not deployed.**

**src/utils**
- `src/utils/pushNotificationCopy.ts`: the jest mirror of the same change. `derivePushCopy` is byte-identical to the Deno copy (checked with `diff`).

**src/lib/db.ts**
- `mapNotification` is renamed to the exported `mapNotificationRow`, which adds `submissionId: row.submission_id ?? null`. `fetchAdminNotifications` now uses it.
- New `markNotificationsRead(ids: string[]): Promise<void>`, per §5.

**src/types**
- No edit by the backend developer. `AdminNotification.submissionId` and the `'eod_update'` union member were already present (frontend developer's change).

**Tests**
- `supabase/tests/eod_update_notifications.test.sql` (new, 33 assertions). Arms C1, F1, S1-S3, P1, D1-D3 (D3 also pins the cross-type `eod`→`order_ready` gap that only the (R) branch closes), G1, R1, T1, A1 and A2, plus the review-fix arms S4, G2 and V1.
- `src/lib/db.notifications.spec180.test.ts` (new, 7 tests): `mapNotificationRow` and `markNotificationsRead`.
- `src/utils/pushNotificationCopy.test.ts`: adds an `eod_update` describe block with 3 tests.

**Verification (local, 2026-10-26)**
- `bash scripts/test-db.sh`: 93/94 files pass, including the new file (33/33 after the review fixes).
  - These files are green and unchanged: `submission_notifications`, `order_ready_notifications`, `missed_eod_notifications`, `staff_reports_issue`, `auto_place_order_attempts`, `staff_role_eod_rls`, `eod_no_need`, `permissive_policy_lint` and `public_grants_explicit`.
  - The one failure is `supabase/tests/order_approvals_fk_set_null.test.sql`. It is an **untracked file from another in-flight session**, and its migration is not on disk. It dies on `tg_order_approvals_guard` ("order approval is immutable") during FK SET NULL, which has nothing to do with notifications or this migration.
- `npx jest` (full): 280 suites / 3470 tests pass.
- `npm run typecheck` and `npm run typecheck:test`: clean.
- End to end against the local stack (supabase-js, real JWTs):
  - A manager's `staff_submit_eod` produced 1 fresh `order_ready`.
  - An admin's RPC edit and an admin's PostgREST `submitEODCount`-shaped upsert produced 2 `eod_update` rows (actor = admin, body = vendor, `submission_id` = the submission).
  - All 3 arrived as realtime INSERTs on `notifications-{brand}` with `submission_id` in `payload.new`, and no realtime restart was needed.
  - The bulk `notification_reads` upsert returned 201 twice (idempotent) and wrote 3 rows owned by the caller.
  - A `user`-role caller saw 0 of the rows.
  - The test rows were deleted afterwards.
- `submission-push-fanout` boots locally: a wrong bearer gets 403. Push copy cannot be exercised end to end locally because VAPID keys are not set (500 "Missing: VAPID_PUBLIC/VAPID_PRIVATE", which is pre-existing). The jest mirror covers the copy.

## Files changed (frontend — spec 180)

**New**
- `src/lib/eodPopup.ts`: the pure decision module (§7.2). Exports `EOD_POPUP_TYPES`, `EOD_POPUP_WINDOW_MS`, `decideEodPopup`, `eodPopupCopy` and `eodPopupTarget`.
- `src/hooks/useEodSubmitPopup.ts`: the pop-up hook (§7.3). State lives in refs. It uses a single toast slot with a per-store queue, and a fallback timer frees the slot if a foreign toast (for example `notifyBackendError`) replaced the pop-up and its `onHide` never fired.
- `src/lib/eodPopup.test.ts`: AC-13, table-driven. Covers AC-2, AC-3, AC-4, AC-6b, the duplicate guard, the copy keys and `eodPopupTarget`.
- `src/hooks/useEodSubmitPopup.test.ts`: drives the pop-up through the real `useSubmissionNotifications` wiring. Covers:
  - AC-6: no toast on mount or on the initial load.
  - Show, replace in place, duplicate delivery ignored.
  - Queue, then show on `onHide`; the fallback slot release.
  - Groups reset when `brandKey` changes.
  - `onPress` marks read; it deep-links only on phone.
- `src/store/useStore.markNotificationsRead.spec180.test.ts`: the store action. Covers the optimistic flip and decrement, the reload when an id is absent, revert plus toast on failure, and the empty-list no-op.
- `src/components/cmd/EodPopupToast.tsx` (review fix S-1): the custom `eodPopup` toast type. It wraps `BaseToast` with a 2-line title and body and an auto height, and uses `useCmdColors()` tokens. `eodPopupToastConfig` adds only the `eodPopup` key, so the library's defaults are unchanged.
- `src/components/cmd/EodPopupToast.test.tsx` (review fix S-1): renders the longest en and es mixed titles, and pins the 2-line props, the auto height, tap handling, and that the config adds only one key.

**Modified in the review-fix round**
- `App.tsx`: one import line, and `<Toast config={eodPopupToastConfig} />`.
- `src/lib/eodPopup.ts` / `src/hooks/useEodSubmitPopup.ts` (+ tests): `EOD_POPUP_TOAST_TYPE`. The hook shows `type: 'eodPopup'`. The `!raw` guard replaces the dead `!n` guard. A `brandKey` change also clears the visible toast and its fallback timer.
- `src/i18n/es.json`: number-neutral plurals, `(actualizados: {u})` and ` · listos para aprobar: {k}` (M-5).
- Re-verified 2026-10-26: full `npx jest` 281 suites / 3478 tests, both typechecks clean. In the browser, the en and es mixed-group titles wrap to 2 lines at desktop and 390 px with nothing clipped.

**Modified (additive hunks only; other sessions' staged hunks untouched)**
- `src/types/index.ts`: adds `'eod_update'` to `SubmissionNotificationType` and `submissionId?: string | null` to `AdminNotification` (§7.1).
- `src/hooks/useSubmissionNotifications.ts`: composes `useEodSubmitPopup(brandKey)`. The INSERT handler now also calls `onPopupInsert(payload.new)`. Still one set of channels.
- `src/store/useStore.ts`: adds the `markSubmissionNotificationsRead(ids)` type and action (§7.4).
- `src/components/cmd/NotificationBell.tsx`: new exported helper `updateSecondaryLine`. An `eod_update` row's secondary line reads "<vendor> · <editor>" (§7.5).
- `src/screens/cmd/sections/phone/PhoneNotifications.tsx`: adds `case 'eod_update'` → `'EODCount'`, and the same secondary line through the shared helper.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`: add `chrome.submissionBell.type.eod_update` and `chrome.eodPopup.*` (§7.6). The single `order_ready` title reuses each locale's existing "Order ready to approve" wording.
- `src/components/cmd/NotificationBell.test.tsx`: adds an `eod_update` describe block (secondary line, fallbacks, not urgent).
- `src/screens/cmd/sections/phone/__tests__/PhoneNotifications.test.tsx`: adds an `eod_update` describe block (deep-link map, label plus vendor · editor, no `orderApproval`).

**Verification (local, 2026-10-26)**
- `npx jest` (full, including every new and extended frontend test file above): 280 suites / 3470 tests pass.
- `npm run typecheck` and `npm run typecheck:test`: clean.
- Browser: a headless Chromium run (the repo's Playwright install, driven by an ad-hoc script outside the repo, not a new test file) against a dedicated `expo start --web --port 8084` and the local stack. Migration `20261027000000` was applied locally. admin@local.test was logged in on the Cmd UI, and manager@local.test submitted through `staff_submit_eod` with a real JWT. Results:
  - On mount, with unread rows already in the feed: 0 toasts (AC-6).
  - Fresh Towson submit: "Towson: Order ready to approve" (AC-1).
  - A second vendor: "Towson: 2 vendor counts submitted", "by Tara Manager · 2 ready to approve" (AC-4).
  - An edit of the first vendor: "Towson: 3 vendor counts submitted (1 updated)" (AC-4, AC-8 update marker).
  - A Frederick submit while the Towson toast was up was queued, not shown, then shown once Towson hid (AC-4, separate pop-ups per store).
  - The admin's own submit for Charles: no toast, but the row still landed in the bell (AC-3).
  - The desktop bell shows the row "EOD count updated · Towson / US FOOD · Tara Manager · just now" (§7.5).
  - Clicking the grouped Frederick toast wrote `notification_reads` for both Frederick rows (AC-5). Tapping the Towson toast at 390 px wrote reads for all 4 Towson rows and deep-linked to Approve order for the latest `order_ready` (SYSCO), which showed the expected spec 149 "count was re-submitted" state (§1.3).
  - A lone edit in a fresh session: "Towson: EOD count updated" / "US FOOD · by Tara Manager".
  - No console errors.
  - The test rows for 2026-10-19 were deleted afterwards.
- Not exercised in the browser:
  - The `notAssigned` filter (AC-2), because every seeded admin/master is assigned to all 4 stores, and the local `user_stores` was not mutated because other sessions share the stack.
  - The super_admin path, because no super_admin is seeded locally.
  - Native (EAS).
  - The es and zh-CN rendering.

  All of these are covered by jest.
- Follow-up (not fixed, design-scoped): the library's default `info` toast is fixed at 340 × 60 with `numberOfLines=1`. A long grouped title truncates, e.g. "Towson: 3 vendor counts submitted (1 updat…". The update marker is still partly visible. A custom toast type in `App.tsx` would fix it, but that is outside §7.3.

## Review fixes applied

These were approved by the owner from `reviews/release-proposal.md`. Items 1-6 are the backend and spec-text items. The frontend items (the `eodPopup` toast type, the `es` plural) are listed in the frontend developer's Files changed section.

1. **The trigger is column-scoped** (architect M-2 / security Low 1). In `20261027000000_eod_update_notifications.sql`, `notify_eod_resubmission` is now `after update of status, submitted_at … when (new.status = 'submitted')`, with a comment explaining why.
   - pgTAP A2 now matches `AFTER UPDATE OF status, submitted_at ON public.eod_submissions`.
   - New arm G2: a `submitted_by`-only UPDATE (the FK SET NULL shape) under a user JWT gives 0 rows.
   - S1, S2, P1, D2, D3 and G1 are unchanged and still green, which proves both real write paths still fire the trigger.
2. **The vendor-name lookup is brand-checked** (security Low 3). `emit_eod_update` now reads `vendors … where v.id = p_vendor_id and v.brand_id = v_brand`. `vendors.brand_id` is `uuid NOT NULL`; I checked the local schema. New arm V1: a foreign-brand vendor gives `body` NULL.
3. **Wrapper comment** (code-reviewer nit). `tg_notify_eod_submission` now says "The exception envelope lives in the callee; keep this body argument-passing only."
4. **New pgTAP arm S4** (architect M-1). It pins the known edit-uuid replay → +1 `eod_update` as documented behaviour. It is not fixed here; the follow-up spec makes it a red→green target. The plan grew from 30 to 33.
5. **Spec text changes:**
   - §1.5: the trigger DDL is column-scoped, and the replay bullet is replaced with the M-1 wording.
   - §7.3: adds the custom `eodPopup` toast type (S-1) and the fallback slot-release timer (deviation (a)).
   - §8.1: adds the S4, G2 and V1 rows and updates A2.
   - §9: rewritten with Step 0 (the ordering of spec 179's `20261026100000` against the db-migrations gate), pre-flight drift checks (column, functions, unique index, owner capture), a deployed-vs-repo diff plus `--no-verify-jwt`, owner and ACL checks, the new md5 targets (the wrapper against this file), the column-scoped triggerdef check, `e2e.yml`, and the promotion and throttle smoke checks.
   - §10: adds M-3 (the pop-up can replace other toasts, accepted), records M-2 as fixed and M-1 as known.
6. **Local re-apply and re-test.**
   - The migration file was re-run as-is on the shared local stack. Its DDL is idempotent (`add column if not exists`, drop and re-add of the CHECK, `create or replace`, `drop trigger if exists`). No `db reset` was run, so other sessions' local migrations are untouched.
   - `pg_get_triggerdef` now shows `AFTER UPDATE OF status, submitted_at`. All five functions are owned by `postgres`.
   - `bash scripts/test-db.sh`: 93/94 pass, with the new file at 33/33. The only failure is the unrelated, untracked `order_approvals_fk_set_null.test.sql` from another session.
   - Local supabase-js e2e re-run: the RPC edit and the PostgREST upsert edit each still produce an `eod_update` under the column-scoped trigger, and realtime delivers all three rows. The test rows were deleted afterwards.
   - **Not applied to prod, not deployed, nothing staged.**

Follow-ups to file (not done here):
- `staff_submit_eod` edit-path idempotency (`client_uuid` ledger), from M-1 / security Low 2;
- an `eod_submissions` vendor/store brand-consistency constraint (security Low 3, pre-existing);
- an app-wide toast-slot coordinator (M-3);
- constant-time bearer compare in `submission-push-fanout` (pre-existing).
