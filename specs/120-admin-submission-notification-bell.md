# Spec 120: Brand-scoped submission notification bell (admin Cmd UI)

Status: READY_FOR_REVIEW

## User story
As a brand admin (or super_admin/master) using the admin Cmd UI, I want a
notification bell in the TitleBar top-right that shows me when a user submits an
EOD count, weekly count, waste log, receiving record, or purchase order — scoped
to the brand(s) I'm allowed to see — so that I know work is coming in without
polling each section, and (if I've enabled device notifications) I get pushed
even when I'm not in the app.

## Actors and scope
- **Super Admin (`super_admin`) and `master`** — see ALL brands' submission
  notifications in the bell and receive the push.
- **Brand admin (`admin`)** — see ONLY their own brand's submission notifications
  (scoped by `profiles.brand_id`) in the bell and receive the push. A brand admin
  MUST NEVER see or be pushed another brand's notifications.
- **Regular users (`user`)** — are the SUBMITTERS. Their submissions GENERATE
  notifications. They do NOT see the bell (the Cmd shell is admin-only; the bell
  is a Cmd-shell surface) and are NOT recipients of the push.

## Acceptance criteria
- [ ] A **bell icon** renders in `src/components/cmd/TitleBar.tsx` top-right
      cluster, adjacent to the brand picker / `ThemeToggle` / connection
      indicator. Web-only (the TitleBar already `return null`s on native).
- [ ] The bell shows an **unread-count badge** reflecting the number of
      notifications the viewer has not yet read (capped display e.g. `9+`).
      Zero unread → no badge (or a neutral bell).
- [ ] Clicking the bell opens a **dropdown/panel** (portaled to `document.body`
      like the existing store-switcher menu) listing recent notifications
      **newest first**, each row showing: actor (submitter display name/username),
      submission type (EOD / Weekly / Waste / Receiving / PO), store name, and a
      relative timestamp. Clicking outside closes it.
- [ ] **Brand scoping enforced at the DB via RLS**, not just in the client:
      a `super_admin`/`master` session's SELECT returns notifications for all
      brands; an `admin` session's SELECT returns ONLY rows whose `brand_id`
      matches a brand the caller can see (`auth_can_see_brand(brand_id)`). A test
      admin scoped to brand A gets zero rows for a brand-B submission even if they
      craft the query directly (RLS denies, not client filter).
- [ ] **All 5 submission types generate exactly one notification per final
      submit**: a user submitting an EOD count, a weekly count, a waste log, a
      receiving record, or a purchase order each creates one notification row
      carrying `{ brand_id, store_id, actor_user_id, submission_type, source_id,
      created_at }`. `submission_type` is one of `eod | weekly | waste |
      receiving | po`.
- [ ] **Per-viewer read state.** Each admin/super_admin tracks their own
      unread/read state independently of every other viewer. Opening the panel or
      a "mark all read" action marks the currently-visible notifications read for
      THAT viewer only; another admin who can see the same notification still sees
      it unread until they read it themselves. Re-reading is idempotent.
- [ ] A **"mark all read"** control in the panel sets every currently-scoped
      unread notification to read for the viewer and drops the badge to zero.
- [ ] **Web push on submission.** On each qualifying submission, a push is sent to
      the push_subscriptions of the brand's `admin`s PLUS all `super_admin`/`master`
      users (NOT the submitting user, NOT other `user`s), reusing the spec-118
      VAPID send path (`sendPushAll`-style loop, `public/sw.js` push handler,
      404/410 subscription cleanup). Push payload names the submission type +
      store; clicking opens the app.
- [ ] **Realtime.** The bell updates live when a new notification lands for the
      viewer's brand scope, without a manual refresh, following the project's
      `useRealtimeSync` pattern on a `brand-{id}` channel. The spec-required
      realtime-publication gotcha (adding the new table to `supabase_realtime`
      requires `docker restart supabase_realtime_imr-inventory` locally, and a
      prod publication update) is called out as a build risk.
- [ ] **Future brands need zero code change.** Scoping is purely `brand_id` +
      `auth_can_see_brand()`; adding a third brand automatically routes its
      submissions to that brand's admins with no new code.

## In scope
- One new notifications data model (table[s]) carrying brand/store/actor/type/
  source, with per-viewer read state.
- RLS policies enforcing the role→brand scoping above.
- Notification generation on all 5 submission events (mechanism = architect's
  call; see Open questions Q5 — trigger strongly preferred).
- Web-push fan-out to brand admins + super_admin on each submission, reusing the
  spec-118 VAPID infra (`push_subscriptions`, `public/sw.js`, VAPID env keys).
- The bell UI in the Cmd TitleBar: badge, dropdown panel, mark-all-read.
- Realtime live update on the `brand-{id}` channel.
- db.ts helpers for: list scoped notifications, unread count, mark read / mark all
  read (all admin-facing reads/writes flow through `src/lib/db.ts`).

## Out of scope (explicitly)
- **Staff / customer surfaces.** The bell is admin Cmd UI only. Staff submitters
  do not get a bell. Rationale: owner scoped it to admins; the Cmd shell is
  already admin-only.
- **Rebuilding push infra.** No new VAPID keypair, no `sw.js` rewrite, no new
  `push_subscriptions` schema. Rationale: reuse spec-118.
- **Conflating with the spec-118 per-device push toggle.** That toggle (enable
  push on THIS device) is a distinct surface; this bell is a notification FEED.
  Rationale: different concerns; do not merge components or state.
- **Notifying on non-submission events** (edits after submit, deletes, login,
  catalog changes, cost changes). Rationale: owner scoped to the 5 user
  submissions; draft/edit/re-submit handling is Q3 (default: final submit only).
- **Changing the submission flows themselves** beyond emitting the notification.
  Rationale: don't perturb EOD/weekly/waste/receiving/PO logic.
- **A per-admin notification-type preference** (mute waste, keep EOD). Rationale:
  owner asked for all 5; granular prefs are a future spec if wanted.
- **Deriving the feed purely from `audit_log`.** `audit_log` has no per-viewer
  read state and logs many action types; a dedicated notifications model is
  cleaner (see Q5). Rationale: read-state + typed scoping needs its own table.

## Open questions
The two big forks (which events; delivery = bell + web push) are already decided
by the owner. The items below are resolved with a recommended default so the
architect is unblocked; the owner can override any of them in architect review
without reshaping the contract.

- **Q1 — Read-state model.** Per-viewer read receipts (separate `notification_reads`
  row per `(notification_id, viewer_user_id)`) vs a single read flag on the
  notification. **Default: per-viewer.** Multiple admins + super_admin can each
  see the same notification and must track read independently.
- **Q2 — Retention / volume.** Keep all rows forever vs cap the feed. **Default:
  keep rows, but the panel displays the last 30 days / most-recent N (e.g. 50);
  an optional prune job is a follow-up, not part of v1.**
- **Q3 — What counts as a "submission".** Only final submits, or also drafts /
  edits / re-submits. **Default: final submit only** (the row that represents a
  completed submission), deduped so a re-submit of the same source does not fire a
  second notification. Genuine owner decision — confirm.
- **Q4 — Push audience + email fallback.** Audience = brand `admin`s + all
  `super_admin`/`master`, excluding the submitter and other `user`s. **Default:
  confirmed as stated.** Email fallback (Resend, like the reminder cron) is
  **default OFF for v1 (push + in-app bell only)**, behind a flag the owner can flip
  on later. Genuine owner decision — confirm whether an on-submission email is
  wanted now.
- **Q5 — Generation mechanism (architect decision, flagged not owner-facing).**
  DB trigger on each of the 5 submission tables inserting a notification row (+
  enqueuing the push) is **strongly preferred**: one source of truth that cannot
  be forgotten at a call site, and it fires regardless of which client (admin,
  staff PWA, direct RPC) created the submission. Alternatives (app-layer writes at
  each submit site; deriving from existing tables with a read overlay) are weaker.
  The architect confirms the exact submission tables/columns (`eod_submissions`,
  `waste_log`, `purchase_orders`, plus the weekly-count table from spec 098 and
  the receiving table from spec 113) and the push-enqueue path (trigger → `pg_net`
  / queue → edge function that fans out to subscriptions).

## Open questions resolved (from owner Q&A)
- Q: Which events fire a notification? → A: ALL 5 user submissions — EOD, weekly
  count, waste log, receiving, purchase order.
- Q: Delivery channel? → A: BOTH the in-app bell AND a web push (reuse spec-118
  web-push infra), so an admin with device notifications enabled is pinged when
  not in the app.
- Q: Who receives? → A: brand `admin` (own brand only) + `super_admin`/`master`
  (all brands). Regular `user`s are submitters, not recipients.

## Dependencies
- Role/brand helpers: `auth_is_super_admin()`, `auth_is_admin()`,
  `auth_can_see_brand(brand_id)`, `profiles.brand_id` — multi-brand tenancy
  (spec 012 / 012a RLS).
- Submission source tables: `eod_submissions`, `waste_log`, `purchase_orders`,
  the weekly-count table (spec 098), the receiving table (spec 113). Architect
  confirms exact names/columns and the store→brand join (`stores.brand_id`).
- Spec-118 push infra: `push_subscriptions` table, VAPID env keys
  (`VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT`), `public/sw.js` push
  handler, `sendPushAll` pattern in `supabase/functions/eod-reminder-cron`.
- `src/lib/db.ts` for the admin-facing list / unread-count / mark-read helpers.
- `src/hooks/useRealtimeSync.ts` + the `brand-{id}` channel wiring in
  `src/navigation/CmdNavigator.tsx`.
- New migration(s) for the notifications table(s), RLS, and the generation
  trigger(s). New edge function (or pg_cron-invoked function) for the push
  fan-out, following the edge-function conventions (shared-bearer or service-token
  gate; `ADMIN_ROLES` gate not applicable — this is event-driven, not a
  user-invoked privileged op).

## Project-specific notes
- **Cmd UI section / staff:** admin Cmd UI only. Bell mounts in
  `src/components/cmd/TitleBar.tsx`; panel portaled to `document.body` like the
  existing store-switcher menu. No staff surface.
- **Per-store or admin-global:** brand-scoped (per-brand), not per-store and not
  admin-global. `super_admin`/`master` = all brands; `admin` = own brand via
  `auth_can_see_brand()`. Notifications carry `store_id` for display but scope by
  `brand_id`.
- **Realtime channels touched:** `brand-{id}` (new notification → live badge/panel
  update). New table must be added to the `supabase_realtime` publication —
  triggers the publication gotcha (`docker restart supabase_realtime_imr-inventory`
  locally; prod publication update). Call out as a risk.
- **Migrations needed:** yes — notifications table(s) + RLS + generation
  trigger(s) + publication membership. Apply to prod via the MCP path (db push
  lacks the prod password) and insert the exact version into `schema_migrations`
  so the db-migrations-applied gate stays green.
- **Edge functions touched:** one new function for the on-submission push fan-out
  (reuse VAPID/`sendPushAll`). Not user-invoked; keep `verify_jwt = false` +
  shared-bearer/service-token gate; no `ADMIN_ROLES` gate.
- **Web/native scope:** web only (the bell + web push). Native/EAS push out of
  scope (no native app yet, consistent with spec 118).
- **`app.json` slug:** not touched.
- **Tests (spec 022 tracks):** pgTAP for the RLS brand-scoping (admin-A cannot
  select brand-B; super_admin sees all) and per-viewer read-state idempotency;
  jest for the bell badge/unread derivation and panel rendering; shell smoke
  optional for the push fan-out function.

## Backend design

### 0. Key findings that reshape the spec's premise (read first)

Two of the spec's stated assumptions are wrong against the actual schema — the
design below corrects them. Neither changes the contract, but the developer must
build to the corrected shape.

1. **There is no "receiving table."** Spec 113's receiving is a *state
   transition* on `public.purchase_orders`, applied by the
   `receive_purchase_order(uuid, jsonb, uuid)` RPC
   ([supabase/migrations/20260707000000_staff_receiving_price_gate.sql](supabase/migrations/20260707000000_staff_receiving_price_gate.sql)),
   which UPDATEs `status → 'partial' | 'received'` and stamps `received_at` /
   `received_by`. So the `receiving` notification fires on an **AFTER UPDATE** of
   `purchase_orders`, not an AFTER INSERT of some receiving table.
2. **`po` and `receiving` share one source table.** The `po` submission is a PO
   reaching `status = 'sent'` (spec 107 vocabulary `draft|sent|partial|received|
   cancelled`); `receiving` is the same PO reaching `partial|received`. Both
   derive from `purchase_orders` via status transitions. So the 5 notification
   **types** come from **4 source tables**, and `purchase_orders` drives two of
   them off UPDATE, not INSERT.

Corrected source map (actor columns verified against init schema +
consistency migrations):

| type        | source table                       | fires on                                                        | actor column   | store column |
|-------------|------------------------------------|-----------------------------------------------------------------|----------------|--------------|
| `eod`       | `eod_submissions`                  | AFTER INSERT WHEN `status='submitted'`                           | `submitted_by` | `store_id`   |
| `weekly`    | `inventory_counts`                 | AFTER INSERT WHEN `kind='weekly'`                               | `submitted_by` | `store_id`   |
| `waste`     | `waste_log`                        | AFTER INSERT                                                     | `logged_by`    | `store_id`   |
| `po`        | `purchase_orders`                  | AFTER INSERT/UPDATE, transition INTO `status='sent'`            | `created_by`   | `store_id`   |
| `receiving` | `purchase_orders`                  | AFTER INSERT/UPDATE, transition INTO `status IN('partial','received')` | `received_by`  | `store_id`   |

Note `inventory_counts` is shared with spot/open/mid_shift/close counts (spec
019/098) — the trigger MUST filter `kind='weekly'` or every spot count would
notify.

### 1. Data model changes

Proposed migration: `supabase/migrations/20260715000000_submission_notifications.sql`
(latest on disk is `20260714000000`; this is the next non-colliding slot).
**Additive** — two new tables, one publication add, one pg_net helper, five
trigger functions. No destructive DDL. Do NOT reuse the existing
`in_app_notifications` table ([supabase/migrations/20260423232117_in_app_notifications.sql](supabase/migrations/20260423232117_in_app_notifications.sql)) —
that is a per-`user_id` reminder inbox written by the cron with a single
`read_at` flag and no brand/type/actor scoping. This feature needs brand-scoped
rows with per-viewer read state; it gets its own tables (spec Out-of-scope
"Deriving the feed purely from `audit_log`" reasoning applies here too).

```
create table public.notifications (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references public.brands(id)   on delete cascade,
  store_id       uuid not null references public.stores(id)   on delete cascade,
  actor_user_id  uuid          references public.profiles(id) on delete set null,
  type           text not null check (type in ('eod','weekly','waste','receiving','po')),
  source_id      uuid not null,                 -- the submission/PO row id
  actor_name     text,                          -- DENORMALIZED at insert (see rationale)
  store_name     text,                          -- DENORMALIZED at insert
  created_at     timestamptz not null default now()
);

-- dedup: one notification per (type, source row). See §3 dedup.
create unique index notifications_type_source_uidx
  on public.notifications (type, source_id);

-- feed: newest-first, brand-scoped window scan.
create index notifications_brand_created_idx
  on public.notifications (brand_id, created_at desc);

create table public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id         uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);
```

**Denormalization rationale (`actor_name`, `store_name`).** The panel row shows
the submitter name + store name. Resolving those at read time would force a
join to `profiles`/`stores` under the caller's RLS, which is fragile
(profiles-read policies differ by role). Denormalizing at trigger time (the
trigger runs SECURITY DEFINER and can read freely) makes the feed a single-table
RLS scan and keeps the read path trivial. Cost: an actor rename won't
retro-update old rows — acceptable for an audit-style feed.

**Read-state model (Q1 — per-viewer, confirmed default).** A `notification_reads`
join row per `(notification_id, user_id)`, NOT a flag on `notifications`.
Multiple admins + super_admin each read independently; the anti-join
(`notification NOT IN my reads`) yields per-viewer unread. `user_id` DEFAULTs to
`auth.uid()` so the client inserts only `notification_id`. PK doubles as the
read-join index; no extra index needed.

**Prune / cap policy (Q2 — confirmed default).** Rows are kept (no delete in v1).
The feed query caps at the last 30 days AND `limit 50` (server-enforced in the
db.ts helper + the count RPC). An optional `pg_cron` prune of rows older than 90
days is a follow-up, explicitly not in v1.

### 2. RLS impact

Both tables get RLS enabled. New policies only; no existing policy changes.

**`public.notifications`** — SELECT only for clients; all writes come from the
SECURITY DEFINER trigger (table owner, bypasses RLS) and the service_role edge
function, so no client INSERT/UPDATE/DELETE policy exists (RLS-enabled +
no permissive write policy = default deny). One policy:

```
create policy "privileged_brand_read_notifications"
  on public.notifications for select
  using (public.auth_is_privileged() and public.auth_can_see_brand(brand_id));
```

- `auth_is_privileged()` = `auth_is_admin()` (JWT role in admin/master) OR
  `auth_is_super_admin()` (profiles.role) — mirrors
  [20260509000000_multi_brand_schema_rls.sql:235](supabase/migrations/20260509000000_multi_brand_schema_rls.sql).
- **Why `auth_is_privileged()` AND, not `auth_can_see_brand()` alone:** a staff
  `user` row is backfilled with a real `brand_id` (012a §3), so
  `auth_can_see_brand(brand_id)` returns TRUE for a same-brand staff user. The
  spec requires `user`s be submitters-not-recipients; the privileged conjunct
  denies them at the DB, not just by the Cmd shell being admin-only.
- super_admin: `auth_can_see_brand` short-circuits TRUE for all brands →
  cross-brand visibility. admin/master: only rows whose `brand_id` matches their
  `profiles.brand_id`. A brand-A admin gets zero brand-B rows even via a
  hand-crafted PostgREST query (this is the AC's "RLS denies, not client
  filter"). This is the exact pattern from every brand-scoped table
  (`brand_member_read_*`), tightened by the privileged conjunct.

**`public.notification_reads`** — per-viewer ownership, mirrors the
`in_app_notifications` "users manage own" shape but split per command:

```
create policy "own_reads_select" on public.notification_reads
  for select using (user_id = auth.uid());
create policy "own_reads_insert" on public.notification_reads
  for insert with check (user_id = auth.uid());
create policy "own_reads_delete" on public.notification_reads
  for delete using (user_id = auth.uid());
```

No UPDATE policy (a read is insert-once; re-read is idempotent via
`on conflict do nothing`). Because the SELECT policy clips to `auth.uid()`, a
PostgREST *embed* of `notification_reads` from `notifications` returns ONLY the
caller's own read rows — this is what makes the per-viewer `read` flag a single
round-trip (see §5 db.ts).

**Permissive-policy lint (CLAUDE.md rule + [supabase/tests/permissive_policy_lint.test.sql](supabase/tests/permissive_policy_lint.test.sql)).**
Neither new policy is trivially-wide: the notifications SELECT is
`auth_is_privileged() AND auth_can_see_brand(...)`; the reads policies are
`user_id = auth.uid()`. None uses `auth.uid() IS NOT NULL` / `true` /
`auth.role() = 'authenticated'`. No allowlist entry needed. Confirm no
pre-existing permissive policy exists on these brand-new tables (there can't be —
they're new).

**Grants (spec-097 posture, [20260618000000_public_grants_explicit.sql](supabase/migrations/20260618000000_public_grants_explicit.sql)).**
Both tables inherit the spec-097 `ALTER DEFAULT PRIVILEGES` grants
(SELECT+INSERT+… to anon/authenticated, ALL to service_role); RLS is the gate,
not the grant layer. Do NOT `revoke ... from anon` (would trip the spec-097
grant lint). Leave inherited grants untouched, exactly as
`weekly_reminder_log` / `_edge_auth` do.

### 3. Generation mechanism (Q5 — DB triggers, confirmed strongly-preferred)

One shared SECURITY DEFINER helper + small per-table trigger functions. The
helper is the single source of truth; a new client (admin, staff PWA, direct
RPC) that writes a submission cannot forget to notify.

```
-- Shared emitter. SECURITY DEFINER so it can read stores/profiles + insert
-- notifications regardless of the submitter's RLS. Exception-safe: a
-- notification failure MUST NOT roll back the user's submission.
create function public.emit_submission_notification(
  p_type text, p_store_id uuid, p_actor uuid, p_source_id uuid
) returns void language plpgsql security definer set search_path = public as $$
declare v_brand uuid; v_store_name text; v_actor_name text; v_new_id uuid;
begin
  begin
    select s.brand_id, s.name into v_brand, v_store_name
      from public.stores s where s.id = p_store_id;
    if v_brand is null then return; end if;          -- storeless → skip
    select coalesce(p.username, p.name) into v_actor_name
      from public.profiles p where p.id = p_actor;
    insert into public.notifications
      (brand_id, store_id, actor_user_id, type, source_id, actor_name, store_name)
    values (v_brand, p_store_id, p_actor, p_type, p_source_id, v_actor_name, v_store_name)
    on conflict (type, source_id) do nothing
    returning id into v_new_id;
    if v_new_id is not null then
      perform public.enqueue_submission_push(v_new_id);   -- §4, pg_net, best-effort
    end if;
  exception when others then
    raise warning 'emit_submission_notification failed (%/%): %', p_type, p_source_id, sqlerrm;
  end;
end $$;
```

Trigger functions (AFTER, `for each row`), each a one-liner calling the emitter:

- `eod_submissions` — `after insert when (new.status = 'submitted')` →
  `emit('eod', new.store_id, new.submitted_by, new.id)`.
- `inventory_counts` — `after insert when (new.kind = 'weekly')` →
  `emit('weekly', new.store_id, new.submitted_by, new.id)`.
- `waste_log` — `after insert` → `emit('waste', new.store_id, new.logged_by, new.id)`.
- `purchase_orders` — `after insert or update` on ONE function handling both
  transitions:
  - INTO `sent`: `(tg_op='INSERT' and new.status='sent') or (tg_op='UPDATE' and new.status='sent' and old.status is distinct from 'sent')`
    → `emit('po', new.store_id, new.created_by, new.id)`.
  - INTO `partial|received`: same-shape transition test on `status in ('partial','received')`
    → `emit('receiving', new.store_id, new.received_by, new.id)`.

**Dedup (Q3 — final-submit-only + dedup, confirmed default).** The
`(type, source_id)` unique index + `on conflict do nothing` is the dedup spine:

- **EOD re-submit:** `eod_submissions` is `(store_id, date, vendor_id)`-unique
  post-spec-020, and the staff RPC upserts that row — a re-submit is an UPDATE of
  the SAME row, so AFTER INSERT does not fire twice. Even a delete+reinsert
  (new `source_id`) is caught only if `source_id` is stable; here it is stable
  because the row persists. The `(type, source_id)` guard is the belt over that
  suspenders.
- **Receiving partial → received:** the first receive (`→ partial`) inserts the
  `receiving` row; the second (`→ received`) hits the unique conflict and
  no-ops. One `receiving` notification per PO — the desired behavior.
- `po` and `receiving` coexist for the same PO id because `type` differs (one
  when sent, one when received) — the composite unique permits it.

**Trigger placement risk.** `emit` is exception-safe (inner BEGIN/EXCEPTION), so
a notifications-table or push-enqueue failure logs a WARNING and the submission
still commits. This is the correct posture: notifications are a side-channel, not
part of the submission's durability contract.

### 4. On-submission push fan-out (edge function + pg_net)

**New edge function `submission-push-fanout`.** `verify_jwt = false` in
[supabase/config.toml](supabase/config.toml); it validates the shared bearer
itself (same posture as `eod-reminder-cron` /`weekly-reminder-cron`). It is
event-driven, not a user-invoked privileged op, so NO `ADMIN_ROLES` gate applies
(consistent with the spec's Dependencies note).

**Trigger → function path (reuse the `_edge_auth` shared-bearer infra,
[20260424211733_security_fixes.sql:139](supabase/migrations/20260424211733_security_fixes.sql)).**
`enqueue_submission_push(p_notification_id uuid)` (SECURITY DEFINER, called by
`emit`) does a `net.http_post` (pg_net — already in use for the crons) to the
function URL with `Authorization: Bearer <cron_bearer>` and body
`{ "notification_id": "<id>" }`. It reads the URL from a new
`_edge_auth` row `submission_push_url` and the bearer from the existing
`cron_bearer` row. Local dev (no `submission_push_url` seeded) skips the POST
with a NOTICE — exactly the cron's local-skip pattern, so the local stack never
pings prod. pg_net enqueues and sends AFTER commit via its background worker →
never blocks the submission.

**Recipient resolution (in the function, service_role client, bypasses RLS).**
Given the notification's `brand_id` and `actor_user_id`:

```
recipients = profiles where role = 'super_admin'                         -- all brands
          OR (role in ('admin','master') and brand_id = notif.brand_id)  -- own brand
          MINUS the actor_user_id                                        -- never the submitter
```

Then join `push_subscriptions` on `user_id` (NOTE: `push_subscriptions.user_id`
is **text**, `profiles.id` is uuid — cast, as the cron already does implicitly),
and `sendPushAll(sb, webpush, subs, payload)` — copy the helper VERBATIM from
[eod-reminder-cron/index.ts:57](supabase/functions/eod-reminder-cron/index.ts)
(404/410 → `push_subscriptions.delete().eq('endpoint', …)` cleanup). VAPID env
(`VAPID_PUBLIC`/`VAPID_PRIVATE`/`VAPID_SUBJECT`) reused unchanged. Payload:

```
{ title: "<Type> submitted", body: "<Actor> · <store_name>", tag: "notif-<id>", url: "/" }
```

where `<Type>` maps eod→"EOD count", weekly→"Weekly count", waste→"Waste log",
receiving→"Delivery received", po→"Purchase order". The `public/sw.js` push
handler is reused as-is (spec 118 / spec-out-of-scope "no sw.js rewrite").

**Q4 — email fallback: OFF for v1 (confirmed default).** The function does push
+ bell only. Do NOT wire Resend here. Leave a clearly-commented seam
(`// email fallback intentionally omitted per spec 120 Q4; flag-gated follow-up`)
so a later spec can add it behind a flag without reshaping the fan-out. **Confirm
with owner** whether an on-submission email is wanted now — not a blocker.

### 5. `src/lib/db.ts` surface

All admin-facing reads/writes go through db.ts (staff subtree is untouched — no
staff bell). New helpers + a `mapNotification` (snake→camel):

```ts
export type AdminNotification = {
  id: string; brandId: string; storeId: string;
  actorUserId: string | null; actorName: string | null; storeName: string | null;
  type: 'eod' | 'weekly' | 'waste' | 'receiving' | 'po';
  sourceId: string; createdAt: string; read: boolean;
};

// Feed — RLS-scoped (super_admin = all brands, admin = own brand), newest-first,
// last-30-days + limit 50. `read` derives from the RLS-clipped embed of the
// caller's own notification_reads rows.
//   supabase.from('notifications')
//     .select('*, reads:notification_reads(read_at)')
//     .gte('created_at', <now-30d ISO>).order('created_at',{ascending:false}).limit(50)
// mapNotification: read = (row.reads?.length ?? 0) > 0
export async function fetchAdminNotifications(
  opts?: { limit?: number; before?: string }
): Promise<AdminNotification[]>;

// Badge count — RPC (SECURITY INVOKER so RLS applies) counting visible
// notifications in the window with no read row for auth.uid().
export async function fetchUnreadNotificationCount(): Promise<number>;   // rpc unread_notification_count()

// Mark one read — insert (notification_id) [user_id defaults to auth.uid()],
// on conflict do nothing. Idempotent.
export async function markNotificationRead(id: string): Promise<void>;

// Mark all currently-scoped unread read — RPC (SECURITY INVOKER): inserts
// (id, auth.uid()) select id from notifications [RLS-visible] where not exists
// (read row) and created_at > now()-30d. Returns rows marked.
export async function markAllNotificationsRead(): Promise<number>;       // rpc mark_all_notifications_read()
```

Two small RPCs (`unread_notification_count()`, `mark_all_notifications_read()`)
land in the same migration, SECURITY INVOKER so the notifications SELECT policy
does the brand/privilege clipping inside the function (no service-role bypass).
`revoke execute … from public, anon; grant execute … to authenticated;` per the
project idiom.

### 6. Frontend store impact (`src/store/useStore.ts`)

New notifications slice (admin store only — staff store untouched):

- state: `notifications: AdminNotification[]`, `unreadNotificationCount: number`.
- actions: `loadNotifications()` (calls both db.ts reads), `markNotificationRead(id)`,
  `markAllNotificationsRead()`.
- selectors: the badge count reads `unreadNotificationCount`; the panel maps
  `notifications`.

**Optimistic-then-revert applies to the mark-read writes** (the standard pattern,
[useStore.ts:23 notifyBackendError](src/store/useStore.ts)): flip `read=true`
locally + decrement the badge immediately; on RPC/insert failure, revert the flag
+ restore the count and call `notifyBackendError`. The feed *read* itself is not
optimistic (it's a fetch). The bell UI (TitleBar badge + portaled panel +
mark-all control) is frontend-developer's build against these selectors.

### 7. Realtime impact

Add `public.notifications` to the `supabase_realtime` publication in the
migration:
`alter publication supabase_realtime add table public.notifications;`
(`notification_reads` does NOT need realtime — a viewer's own read writes are
already reflected optimistically; adding it would just replay the viewer's own
mark-reads back to them.)

The bell subscribes on the **`brand-{brandId}`** channel with
`filter: brand_id=eq.${brandId}` — mirrors the brand-channel wiring in
[useRealtimeSync.ts:62](src/hooks/useRealtimeSync.ts). **Do NOT route it through
the existing `onSync` full-reload** (that would trigger a heavy
`loadFromSupabase` on every submission). Instead the notifications slice owns a
lightweight callback that refetches only the feed head + unread count — the same
"section owns its own subscription" precedent as
[InventoryCountSection](src/screens/cmd/sections/InventoryCountSection.tsx).
Recommended: a dedicated `notifications-{brandId}` channel from the bell
component so the 400ms full-reload debounce and the badge refresh stay decoupled;
this still satisfies the AC's "brand-{id} channel pattern."

**super_admin cross-brand-live tradeoff (call out).** The brand-filtered channel
delivers live updates for the super_admin's *currently-selected* brand only; a
submission in another brand won't live-bump their badge until they switch brands
or the feed refetches. The feed itself is always RLS-correct (all brands) on the
next fetch. Full cross-brand live for super_admin (an unfiltered `notifications`
listen relying on RLS to clip) is a reasonable follow-up but adds a second
subscription shape; v1 ships the brand-filtered channel. Acceptable because the
overwhelming majority of recipients are single-brand admins.

**Publication gotcha (build/deploy step, not runtime).** Adding `notifications`
to `supabase_realtime` requires
`docker restart supabase_realtime_imr-inventory` after `npm run dev:db` locally
to re-snapshot the replication slot (CLAUDE.md / MEMORY.md realtime gotcha).
Prod's managed realtime re-snapshots on publication change automatically;
clients reconnect. Flag this in the build handoff.

### 8. Migration + prod apply

Single migration `20260715000000_submission_notifications.sql`:
1. `create extension if not exists pg_net;` (used by the push helper — already
   present on Supabase prod and in the local image via the crons; assert, don't
   assume).
2. Two tables + indexes (§1), RLS enable + 4 policies (§2).
3. `emit_submission_notification` + `enqueue_submission_push` + 4 trigger
   functions + their triggers (§3/§4).
4. Two read RPCs (§5) with revoke/grant.
5. `alter publication supabase_realtime add table public.notifications;` (§7).
6. New `_edge_auth` row `submission_push_url` — seed on prod only (local skips).

**Prod apply via MCP** (db push lacks the prod password — project MEMORY): apply
SQL via `execute_sql` against `ebwnovzzkwhsdxkpyjka`, insert the exact version
`20260715000000` into `supabase_migrations.schema_migrations`, and verify the
functions/policies with a normalized-md5 check so the `db-migrations-applied`
gate stays green. Deploy `submission-push-fanout` via `supabase functions
deploy`. Seed `_edge_auth.submission_push_url` to the deployed function URL on
prod. **No CI gate assumption** — manual verification is the reality
(CLAUDE.md); after any push to `main`, confirm both active gates are green.

### 9. Test coverage (spec 022 tracks)

- **pgTAP** (`supabase/tests/`):
  - RLS scoping: brand-A admin SELECT of a brand-B notification returns 0 rows;
    brand-A admin sees brand-A; super_admin sees both brands; a same-brand staff
    `user` sees 0 (the privileged conjunct). Mirror the 012a probe harness.
  - Per-viewer read idempotency: two admins on the same notification track read
    independently; a second `markNotificationRead` is a no-op (on conflict).
  - Trigger generation: an INSERT into each source (eod submitted / weekly count /
    waste / PO→sent / PO→received) creates exactly one notification with the
    right `type`, `brand_id` (via store→brand), `actor_*`, `store_name`.
  - Dedup: a receiving partial→received transition yields ONE `receiving` row;
    a PO that goes sent then received yields one `po` + one `receiving`.
- **jest**: badge unread derivation (`read` flag → count, `9+` cap, zero→no
  badge), panel newest-first rendering + mark-all clearing the badge, the
  `mapNotification` snake→camel mapping.
- **shell smoke (optional)**: POST the fan-out function with a fabricated
  `notification_id` + valid bearer → asserts recipient resolution excludes the
  actor and 404/410 cleanup fires.

### 10. Risks / tradeoffs (explicit)

- **pg_net availability.** The push path depends on pg_net + a seeded
  `submission_push_url`. If either is absent the notification row still lands and
  the bell works (realtime) — only the push is skipped, and `emit` is
  exception-safe so the submission never breaks. Push is best-effort by design.
- **Migration ordering.** Tables → policies → helper functions → triggers →
  publication add, in that order, in one transaction. The publication add must
  follow the table create. The `pg_net` extension create must precede the push
  helper.
- **super_admin live gap** (§7) — feed is correct; live badge tracks active brand
  only in v1.
- **Denormalized actor/store names** don't retro-update on rename (§1) —
  acceptable for an audit feed.
- **Seed dataset (286 KB).** The feed is a `(brand_id, created_at desc)` index
  scan capped at 50 / 30 days — trivial at any realistic volume. The count RPC's
  anti-join rides the `notification_reads` PK. No full-table scans.
- **Edge cold-start.** The fan-out is fire-and-forget from pg_net; a cold start
  adds latency to the push, not to the submission. Acceptable.
- **Confirm-items (do not block):** Q3 dedup shape (final-submit-only) and Q4
  email-off are designed as the confirmed defaults; surface both to the owner at
  review but proceed.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Backend: author
  supabase/migrations/20260715000000_submission_notifications.sql (two tables +
  indexes + RLS per §2, the emit/enqueue helpers + 5 triggers per §3/§4, two read
  RPCs per §5, publication add per §7), the new `submission-push-fanout` edge
  function (verify_jwt=false + shared-bearer gate, reuse eod-reminder-cron's
  sendPushAll VERBATIM, recipients = brand admins + all super_admin minus the
  actor, email fallback OFF), the db.ts helpers + mapNotification, and pgTAP per
  §9. Heed the §0 corrections (receiving = purchase_orders UPDATE, not a table;
  weekly = inventory_counts filtered kind='weekly'). Frontend: the notifications
  slice in useStore.ts (§6, optimistic-then-revert on mark-read), the TitleBar
  bell + portaled panel + mark-all, and the notifications-{brandId} realtime
  subscription (§7 — do NOT route through onSync). Flag the realtime publication
  `docker restart` step and the prod MCP apply. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/120-admin-submission-notification-bell.md

## Files changed (frontend — spec 120)

Implemented the frontend slice of §5 (db.ts helpers), §6 (store slice), and the
TitleBar bell + §7 realtime. Backend (migration, RPCs, edge function, pgTAP) is
built in parallel and NOT touched here (`supabase/` untouched).

- `src/types/index.ts` — added `AdminNotification` + `SubmissionNotificationType`
  types; added `submissionNotifications` / `submissionUnreadCount` to `AppState`.
- `src/lib/db.ts` — added `mapNotification` + helpers `fetchAdminNotifications`,
  `fetchUnreadNotificationCount`, `markNotificationRead`,
  `markAllNotificationsRead` (spec §5 signatures/query shapes); imported
  `AdminNotification`.
- `src/store/useStore.ts` — added the submission-notification slice: state
  `submissionNotifications` / `submissionUnreadCount`; actions
  `loadSubmissionNotifications`, `markSubmissionNotificationRead` (optimistic +
  revert + `notifyBackendError`), `markAllSubmissionNotificationsRead`
  (optimistic + revert).
- `src/hooks/useSubmissionNotifications.ts` — NEW. Initial feed/count load +
  dedicated `notifications-{brandId}` realtime channel (INSERT → refetch head +
  count; NOT routed through the heavy `onSync` full-reload, per §7). Keeps the
  `lib/supabase` import out of the bell component (spec-057 convention).
- `src/navigation/CmdNavigator.tsx` — wired `useSubmissionNotifications(brandId)`
  in `AuthedRoot` alongside `useRealtimeSync`.
- `src/components/cmd/NotificationBell.tsx` — NEW. Bell + unread badge (`9+`
  cap, zero → no badge) + `document.body`-portaled panel (newest-first rows with
  type label · store · actor · relative time, unread highlight, per-row
  mark-read, mark-all-read, empty state). Mirrors the store-switcher portal.
- `src/components/cmd/TitleBar.tsx` — render `<NotificationBell />` in the
  top-right cluster (between the brand picker and `ThemeToggle`).
- `src/i18n/{en,es,zh-CN}.json` — added `chrome.submissionBell.*` (aria, title,
  markAll, empty, unknownActor, per-type labels, relative-time buckets). Parity
  test green.

### Deviations / coordination notes for reviewers

1. **Naming: avoided clobbering the pre-existing `notifications` slice.** The
   store ALREADY has a `notifications: AppNotification[]` slice (the EOD-reminder
   inbox) with actions `addNotification` / `markNotificationRead` /
   `clearNotifications`. Spec §6's proposed identifiers (`notifications`,
   `markNotificationRead`) collide with that. To avoid breaking the reminder
   inbox I named the new slice distinctly: state `submissionNotifications` /
   `submissionUnreadCount`; actions `loadSubmissionNotifications` /
   `markSubmissionNotificationRead` / `markAllSubmissionNotificationsRead`. This
   is a mechanical rename only — the design/behavior is unchanged. The db.ts
   helpers keep the spec §5 names (`fetchAdminNotifications` etc.), which do NOT
   collide (db.ts's existing helper is `markNotificationReadDb`).
2. **db.ts helpers authored here (parallel build).** Spec §5 lists the db.ts
   helpers under backend-developer, but they live in `src/lib/db.ts` (not
   `supabase/`) and the store needs them to typecheck. I implemented them to the
   §5 signatures + query shapes (embed `reads:notification_reads(read_at)`; RPCs
   `unread_notification_count` / `mark_all_notifications_read`). If backend also
   lands db.ts helpers, reconcile at merge — shapes are identical.
3. **Verification.** `npx tsc --noEmit` clean; `npx jest` 1184/1184 green
   (parity included); `npx expo export --platform web` bundles cleanly (proves
   the react-dom `createPortal` bell + hook build for web). The `preview_*`
   browser tools are not available in this environment, and the backend tables
   (`notifications`, `notification_reads`) + RPCs are built in parallel and are
   absent from the local DB, so a live feed cannot be exercised yet — the helpers
   fail soft (console.warn → `[]` / `0`) so the bell renders an empty state
   until the migration lands.
4. **Realtime publication gotcha (build/deploy step).** Adding
   `public.notifications` to `supabase_realtime` (backend's migration) requires
   `docker restart supabase_realtime_imr-inventory` locally after `npm run
   dev:db`; prod re-snapshots automatically. Flagged per §7.
5. **super_admin cross-brand live (review should-fix, RESOLVED).** The hook now
   opens one `notifications-{brandId}` channel PER visible brand for
   super_admin/master (iterating `brandsList`), so "All brands" mode gets live
   updates across every brand — not just the selected one. Brand admins still
   get their single channel. All channels are torn down on unmount / scope
   change (no leaks); the listen stays off the heavy `onSync` reload. This
   closes the §7 tradeoff for the primary (super_admin) audience.

### Review follow-ups applied (code-reviewer.md — 2 should-fixes)

- **super_admin "All brands" realtime gap** — `useSubmissionNotifications.ts`
  now subscribes per visible brand (see note 5 above).
- **Hardcoded `#FFFFFF` badge text** — kept the literal with a justifying
  comment: the badge background is `C.danger` and the Cmd palette has no
  on-danger token (`accentFg` is accent-specific); white reads cleanly on both
  the light (`#791F1F`) and dark (`#D84B4B`) danger shades.

Re-verified: `npx tsc --noEmit` clean; `npx jest i18n.test` green;
`npx jest` 1184/1184 green.
