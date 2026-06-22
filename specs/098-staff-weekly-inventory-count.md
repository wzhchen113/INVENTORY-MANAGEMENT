# Spec 098: Staff weekly full inventory count + scheduling

Status: READY_FOR_REVIEW

> All five design forks (Q1–Q5) are resolved — the user accepted every recommended
> default. The decisions are recorded under "Open questions resolved" and the
> formerly-(fork) acceptance criteria are now concrete against the chosen options.

## User story

As a **store staff member** at a 2AM PROJECT location, I want a dedicated **weekly
full-store inventory count** in my staff app — separate from my once-a-day EOD count —
that the app schedules, reminds me about, and tracks to completion, so that every
item in the store gets a true physical count on a regular cadence without a manager
having to chase me for it.

As a **store manager / admin**, I want to configure the weekly count cadence per store
and see at a glance which stores have completed (or missed) their weekly count, so that
I can trust the weekly numbers and follow up on overdue stores.

## Background (current state — investigated, paths verified this session)

### What staff can do today
- The staff surface lives in THIS repo at `src/screens/staff/` (spec 063 folded the
  former `imr-staff` repo back in as a peer to `src/screens/cmd/`). Any reference to an
  `imr-staff/` path elsewhere is stale.
- Staff today can ONLY perform the **EOD count**:
  `src/screens/staff/screens/EODCount.tsx`. It is:
  - **Vendor-scoped** — vendors come from the `order_schedule` table filtered by
    today's weekday (`EODCount.tsx:9-11`, `todayWeekday()` at `:53-55`); the screen
    shows a vendor switcher only when today lists >1 vendor.
  - **Once-per-day** — unique on `(store_id, date)`; pre-fills from any existing
    submission for `(active_store_id, today, selected_vendor_id)`.
  - **Stock-writing** — submits via the `staff_submit_eod()` RPC, which DOES overwrite
    `inventory_items.current_stock`.
- Staff navigation: `src/screens/staff/navigation/StaffStack.tsx` (a new screen/tab
  for the weekly count would be added here).
- Staff store: `src/screens/staff/store/useStaffStore.ts`; staff-local components
  (`Button`, `Input`, `Banner`, `ListRow`, `QueueIndicator`), i18n catalog, and theme
  all under `src/screens/staff/`. Per spec 063 the staff subtree is a documented
  carve-out that calls `supabase.from/rpc` directly (NOT through `src/lib/db.ts`).
- Staff stack does **not** use realtime in v1 (per spec 062).

### What admins already have (strong prior art — likely reusable)
- An admin-only **"Inventory count"** feature exists:
  `src/screens/cmd/sections/InventoryCountSection.tsx`, backed by tables
  `inventory_counts` + `inventory_count_entries` and the `submit_inventory_count()`
  RPC (migration `supabase/migrations/20260513000000_inventory_counts.sql`, spec 019).
  Confirmed properties of that subsystem:
  - It is a **full all-items count** (not vendor-scoped).
  - `kind` is a CHECK-constrained enum: `('spot','open','mid_shift','close')`. `'eod'`
    is deliberately excluded — that path is `staff_submit_eod`.
  - It does **NOT** write `inventory_items.current_stock` — counts are advisory
    historical snapshots (migration lines 56-61 explicitly forbid any
    `UPDATE inventory_items` in the RPC).
  - The RPC is `security invoker`, `REVOKE … FROM public, anon`, `GRANT … TO
    authenticated` — so it is **already callable by staff** today, gated per-store by
    RLS via `auth_can_see_store()`.
  - Entries support dual case/each inputs (`actual_remaining_cases`,
    `actual_remaining_each`) plus a single `actual_remaining` — aligns with the spec
    086 dual case/each input pattern for items where `case_qty > 1`.
  - Idempotency via partial-unique `(store_id, client_uuid)` index; blank entries are
    skipped; `submitted_by` is server-canonical `auth.uid()`.

### What does NOT exist yet (net-new for this spec)
- **No weekly / cadence / recurring / scheduling concept** for counts anywhere in
  schema or code. `stores.eod_deadline_time` is a soft reminder time only;
  `order_schedule` scopes vendor-days for EOD, not full counts.
- **No "due this week / completed this week" tracking** for any count type.
- **No per-user/per-store "which count types can this staff do" permission layer.**
  Staff↔store assignment is the `user_stores(user_id, store_id)` junction table only.

### Reminder prior art
- `supabase/functions/eod-reminder-cron/index.ts` (+ its README) is the existing
  reminder edge function, driven by `pg_cron` and pushing via the web-push / VAPID
  infra (`src/lib/webPush.ts`). This is the reference shape for a weekly reminder.

## Acceptance criteria

### Staff weekly-count screen
- [ ] A new screen is reachable in the staff app (added to
      `src/screens/staff/navigation/StaffStack.tsx`) labeled as the weekly count,
      visually distinct from the EOD count.
- [ ] The screen lists **every** active inventory item for the active store (NOT
      vendor-scoped), each with a count input. Items where `case_qty > 1` show dual
      case/each inputs per the spec 086 pattern; other items show a single input.
- [ ] Submitting calls a single RPC that persists one parent count row + one entry per
      non-blank item, idempotently keyed on a client-minted `client_uuid` (mirrors
      `submit_inventory_count` semantics). A repeat submit with the same `client_uuid`
      returns the existing count id with `conflict: true` and inserts no duplicate.
- [ ] `submitted_by` on the persisted count is the server-canonical `auth.uid()`; the
      client cannot forge attribution.
- [ ] A staff member can only submit a weekly count for a store they are a member of
      (RLS via `auth_can_see_store()` rejects others with 42501).
- [ ] After a successful submit, the screen shows a "weekly count completed for the
      week of <date>" confirmation and the store's weekly-due banner clears.

### Scheduling / cadence (Q2-A: per-store day, any staff)
- [ ] An admin can set, per store, a single weekly **due day-of-week** on which the
      weekly count is due. There is no per-user cadence and no per-user assignment —
      **any** member of the store (per `user_stores`) can complete the store's weekly
      count, and once any member submits it the store is satisfied for that week.
- [ ] The system can determine, for a given store and "as-of" date, whether the
      weekly count is **completed for the current week** or **open/overdue**, anchored
      to the configured due day-of-week (define the week window deterministically —
      e.g. the 7-day window ending on the configured due day), following the same
      local-time convention EOD uses for `todayIso`.
- [ ] A store with no configured cadence (no due day set) is treated as "weekly count
      not scheduled" and is excluded from reminders and overdue status.

### Reminder (Q3-C: cron web push + persistent in-app banner)
- [ ] On the configured due day, if the store's weekly count is not yet completed for
      the current week, eligible staff (store members per `user_stores`) receive a
      **web-push** reminder (extending the `eod-reminder-cron` pattern) AND see a
      **persistent in-app banner** in the staff app until the count is completed for
      that week.
- [ ] The **in-app banner is the reliable floor**: it appears for the due/overdue
      store regardless of push availability, and works on **both web and native**
      (it reads on screen focus, not via a live channel — consistent with staff v1
      having no realtime).
- [ ] The reminder fires **at most once per store per week** (no spam on cron
      re-runs), de-duped server-side; mirror the eod-reminder-cron de-dup posture.
- [ ] If web push is unavailable for a user/platform, the in-app banner still appears
      (push is best-effort; banner is the floor).

### Admin visibility (Q4-A: extend InventoryCountSection)
- [ ] The existing `src/screens/cmd/sections/InventoryCountSection.tsx` gains a
      **weekly filter/tab** that shows, per store, whether the weekly count is
      **completed** or **overdue** for the current week.
- [ ] The same section is where an admin **sets the per-store weekly due day-of-week**
      (cadence config lives here — no separate Cmd UI section is added in v1).
- [ ] Admins can open a submitted weekly count and view its entries, reusing the
      existing count-detail read path.

### Stock effect (Q1-A: advisory snapshot)
- [ ] The weekly count is an **advisory historical snapshot** — it does NOT overwrite
      `inventory_items.current_stock`. Counts are persisted as records (parent +
      entries); admins reconcile inventory manually. The RPC contains no
      `UPDATE inventory_items` (mirroring the `submit_inventory_count` guarantee).

### Tests (track names per spec 022)
- [ ] **pgTAP**: the weekly-count RPC enforces the auth gate, idempotency, server-side
      `submitted_by`, and the advisory-snapshot guarantee (asserts `current_stock` is
      unchanged after a weekly submit).
- [ ] **pgTAP / DB**: the "completed vs overdue this week" determination returns the
      correct status across week boundaries for a representative store + configured
      due-day cadence.
- [ ] **jest**: the staff weekly-count screen renders all items, shows dual case/each
      inputs only where `case_qty > 1`, and gates submit on ≥1 non-blank entry.
- [ ] **shell smoke** (if a weekly-reminder edge function is added): the function
      returns a sane envelope and respects the once-per-store-per-week guard.

## In scope
- A staff-facing weekly **full all-item** inventory count screen in `src/screens/staff/`.
- A per-store weekly **cadence/schedule** model (net-new table/columns: a per-store
  weekly due day-of-week) and a deterministic "completed vs overdue this week"
  computation.
- A **weekly reminder** mechanism: web push (extend the eod-reminder-cron pattern) +
  a persistent in-app banner on both web and native.
- **Admin visibility + cadence config** inside the existing `InventoryCountSection`
  (weekly filter/tab + per-store due-day setting + completed/overdue status).
- Persisting weekly counts as advisory records (parent + entries), idempotent and
  RLS-gated, with no stock write.

## Out of scope (explicitly)
- **Daily EOD count changes.** EOD stays exactly as-is (vendor-scoped, once-per-day,
  stock-writing via `staff_submit_eod`). Rationale: the request is additive.
- **Writing live stock from the weekly count.** Q1-A chosen — advisory snapshot only;
  no `current_stock` write, no approval flow. Rationale: lowest risk, reuses existing
  staff-callable count semantics; a stock-true-up flow is a possible follow-up.
- **Per-user assignment or per-user cadence.** Q2-A chosen — one per-store due day,
  any member completes it. No assignment table, no per-user day. Rationale: simplest
  config that satisfies the request; a richer responsibility model is a follow-up.
- **Native push in v1.** Q5 chosen — web push only in v1; native push (expo-
  notifications path) is deferred to a follow-up. The in-app banner already covers
  native. Rationale: the existing reminder infra is web-centric; banner is the floor.
- **A new dedicated "Weekly counts" Cmd UI section.** Q4-A chosen — extend
  `InventoryCountSection` instead. Rationale: least build, reuses the count-detail
  read path.
- **Customer PWA / staff-app-in-other-repo work.** The PWA is a sibling app folding in
  via a future spec; this spec is admin + the in-repo staff surface only.
- **Arbitrary recurrence (bi-weekly, monthly, custom RRULE).** v1 is weekly only;
  "weekly" is the business name and the only cadence. Rationale: matches the request;
  a richer scheduler is a follow-up.
- **Migrating the staff subtree into `src/lib/db.ts`.** The staff carve-out (spec 063)
  stands; new staff data calls follow the existing direct-`supabase.rpc` pattern.
  Rationale: out of band; a future spec may consolidate.
- **Realtime for the staff stack.** Staff v1 has no realtime (spec 062); the weekly
  banner reads on screen focus, not via a live channel. Rationale: preserves the
  existing staff posture; an admin-side realtime update of weekly status, if desired,
  is a separate decision (see Risks).
- **A new permission/role taxonomy.** Eligibility for the weekly count is derived from
  existing `user_stores` membership. Rationale: avoid inventing a permission layer not
  asked for.
- **Changing the `app.json` slug.** Not touched (see CLAUDE.md "app.json slug
  mismatch — DO NOT AUTO-FIX").

## Open questions resolved
- Q (from request): Is this vendor-scoped like EOD, or a full all-item count?
  → A: **Full all-item count** (user-confirmed). It is the staff-facing equivalent of
  the admin Inventory count page, used weekly.
- Q (from request): Is "weekly" just an always-available screen, or a real schedule?
  → A: **Real scheduling subsystem** — tracked weekly due date/cadence per store with
  reminders (user-confirmed).
- Q (from request): Which app?
  → A: **This repo** — admin (config + visibility) + the in-repo staff surface
  (`src/screens/staff/`). Not the sibling PWA.
- **Q1 — Stock effect** → A (**Advisory snapshot**): reuse `inventory_counts`
  semantics; no `current_stock` write; admins reconcile manually.
- **Q2 — Assignment & cadence** → A (**Per-store day, any staff**): admin sets one
  weekly due day-of-week per store; any `user_stores` member can complete it; once
  done the store is satisfied for the week. No assignment table, no per-user cadence.
- **Q3 — Reminder channel & timing** → C (**Cron web push + persistent in-app
  banner**): banner persists until completed and is the reliable floor; push is
  best-effort.
- **Q4 — Admin visibility surface** → A (**Extend `InventoryCountSection`**): weekly
  filter/tab + per-store due-day config + completed/overdue status; reuse the existing
  count-detail read path. No new Cmd UI section.
- **Q5 — Web vs native push** → **Web push in v1, native push deferred** to a follow-up.
  The in-app banner works on both web and native now.

## Dependencies
- Existing `inventory_counts` + `inventory_count_entries` tables and
  `submit_inventory_count()` RPC (spec 019) — reused for the advisory-snapshot
  semantics (Q1-A). Architect decides whether to add a `'weekly'` value to the `kind`
  CHECK or use a dedicated flag (see Risks).
- `user_stores` junction for store membership / eligibility.
- `inventory_items` (item list, `case_qty` for dual input per spec 086).
- `eod-reminder-cron` edge function + `pg_cron` + web-push/VAPID infra
  (`src/lib/webPush.ts`) as the reminder pattern (Q3-C).
- Staff app shell: `src/screens/staff/navigation/StaffStack.tsx`, `useStaffStore`,
  staff-local components, i18n catalog, theme.
- Admin `InventoryCountSection.tsx` (Q4-A — extend in place).
- **Net-new migration(s)**: a per-store weekly-cadence model (due day-of-week) and the
  completed/overdue computation (likely an RPC). No stock-write/approval path (Q1-A).

## Project-specific notes
- **Cmd UI section / legacy:** Admin config + visibility extend
  `src/screens/cmd/sections/InventoryCountSection.tsx` (Q4-A). No new section; no
  legacy admin surface (deleted in spec 025). Staff screen lands in
  `src/screens/staff/`.
- **Per-store or admin-global:** Per-store. The weekly count, cadence, completion
  status, and reminders are all store-scoped via `auth_can_see_store()` /
  `user_stores`. Must respect the per-store RLS hardening
  (`20260504173035_per_store_rls_hardening.sql`) — new tables get the four-policy
  template; entry tables scope through the parent's `store_id` via `EXISTS` (mirror
  `inventory_count_entries`).
- **Realtime channels touched:** None for the staff stack (staff v1 has no realtime,
  spec 062); the weekly banner reads on screen focus. If admin weekly-status should
  update live, that would use the existing `store-{id}` channel — flagged as a Risk,
  not in scope by default. **Realtime publication gotcha:** any NEW table that admins
  should see live must be in the `supabase_realtime` publication; the publication is
  `FOR ALL TABLES` so new tables join automatically, but mid-session publication
  changes need `docker restart supabase_realtime_imr-inventory` to re-snapshot the slot.
- **Migrations needed:** Yes — a per-store weekly-cadence model (due day-of-week) and
  the completed/overdue computation (likely an RPC). No stock-write/approval path
  (Q1-A). If reusing `inventory_counts`, decide whether to add a `'weekly'` value to
  the `kind` CHECK or use a dedicated flag/column (architect call).
- **Edge functions touched:** A weekly-reminder function (new, or an extension of the
  `eod-reminder-cron` pattern) for the web-push leg of Q3-C. Note the edge-function
  auth split: cron-invoked reminders that read across stores need the
  service-token/`verify_jwt = false` posture used by `staff-*` / `pwa-catalog`, not the
  JWT default — surface in design. Per CLAUDE.md, any role-gating it does must mirror
  `auth_is_privileged()` via the `ADMIN_ROLES` set.
- **Web/native scope:** Staff screen + in-app banner: both web and native. Web push:
  **web-only in v1** (Q5; native push deferred). EOD reminder infra is web-centric.
- **Tests:** pgTAP (RPC auth/idempotency/attribution + advisory-snapshot guarantee +
  week-window status), jest (staff screen render + dual-input + submit gating), shell
  smoke (reminder envelope + once-per-week guard, if an edge function lands).

## Risks
- **Reusing `inventory_counts` vs. a new table.** With Q1-A (advisory snapshot), the
  existing table's semantics fit. Adding `'weekly'` to the `kind` CHECK is low-friction
  but couples the weekly flow to a shared table; a dedicated flag/column is an
  alternative. Architect to decide.
- **Week-window definition.** "Completed this week" must be deterministic across
  timezones and the configured due day-of-week. EOD captures the date at submit time in
  local time (`EODCount.tsx:13-15`, `todayIso` at `:57-63`) — the weekly window must
  follow the same local-time convention to avoid off-by-one at midnight.
- **Reminder idempotency.** The once-per-store-per-week guard must survive cron
  re-runs and multiple eligible staff. Mirror the eod-reminder-cron de-dup posture.
- **Edge-function auth posture.** A cross-store cron reader can't use the per-user JWT
  RLS path; it needs the service-token bearer posture. Getting this wrong either leaks
  cross-store data or sends no reminders.
- **Native push gap (deferred, not closed).** Q5 ships web push only; native staff on
  native devices rely on the in-app banner until the native-push follow-up lands.

## Backend design

> Authored by backend-architect (design mode). All five product forks are locked to
> the recommended defaults; this section makes the contract concrete. No implementation
> code is committed here — signatures, schemas, and pseudocode only. The developer
> authors the migrations and TS.

### 0. Decision summary (the load-bearing call: reuse vs. dedicated)

**Decision: reuse `inventory_counts` + `inventory_count_entries`; add `'weekly'` to the
`kind` CHECK; add a NEW thin RPC `submit_weekly_count`; add per-store cadence as a
column on `stores`; add a NEW status RPC `weekly_count_status`; add a NEW dedup table
`weekly_reminder_log`; add a NEW cron edge function `weekly-reminder-cron`.**

Why reuse the count tables rather than a dedicated `weekly_counts` table:

- **Q1-A makes the semantics identical.** A weekly count is, byte-for-byte, what
  `inventory_counts` already models: an advisory full-store snapshot (parent + entries,
  dual case/each, idempotent on `client_uuid`, `submitted_by = auth.uid()`, NO
  `current_stock` write). The migration `20260513000000_inventory_counts.sql` lines
  56-61 already forbid any `UPDATE inventory_items` in that path. A dedicated table
  would duplicate all four RLS policies, both indexes, the entries-through-parent EXISTS
  scoping, and the admin count-detail read path in `db.ts` (`fetchInventoryCount`) — for
  zero semantic difference.
- **Admin read path is free.** Q4-A says "reuse the existing count-detail read path."
  That only works if weekly rows live in `inventory_counts`. `fetchInventoryCount` /
  `fetchRecentInventoryCounts` already hydrate entries + submitter + catalog names; the
  weekly tab filters the SAME table on `kind = 'weekly'`.
- **The `kind` discriminator is the existing extension seam.** `kind` is already a
  CHECK-constrained enum (`'spot','open','mid_shift','close'`) explicitly designed to
  add count types without new tables; `'eod'` is the only value deliberately excluded
  (that path writes stock via `staff_submit_eod`). Adding `'weekly'` is the lowest-
  friction option the spec's own Dependencies section flagged for the architect.

**Tradeoff being accepted (flagged explicitly):** reuse couples the weekly flow to a
shared table. Three concrete consequences the developer must honor:

1. The existing `submit_inventory_count` RPC **must keep rejecting `'weekly'`** in its
   kind allowlist — `'weekly'` is a staff-cadence concept and must go through the new
   `submit_weekly_count` RPC, not the generic admin one. (Defense-in-depth: even though
   the column CHECK now permits `'weekly'`, the generic RPC's in-body allowlist at
   `20260513000000_inventory_counts.sql:262` stays `('spot','open','mid_shift','close')`.)
2. The admin "Recent counts" history list and any kind-label maps
   (`utils/enumLabels.ts`, `KIND_IDS` in `InventoryCountSection.tsx:43`) must gain
   `'weekly'` or it renders blank.
3. `InventoryCountKind` TS union in `src/types/index.ts` must add `'weekly'`.

A dedicated table was rejected; if a future spec gives weekly counts divergent
semantics (e.g. an approval/stock-true-up flow), revisit — that is the documented
exit condition.

### 1. Data model changes

**Migration A — `supabase/migrations/20260622090000_weekly_count_kind_and_cadence.sql`**
(additive; no down migration per project convention)

- `ALTER TABLE public.inventory_counts DROP CONSTRAINT <kind_check>, ADD CONSTRAINT ...
  CHECK (kind IN ('spot','open','mid_shift','close','weekly'))`. The original constraint
  is an inline unnamed CHECK at `20260513000000_inventory_counts.sql:74-75`; the
  developer must look up its generated name via `pg_constraint` (likely
  `inventory_counts_kind_check`) and drop+recreate. **Additive/safe:** widening a CHECK
  to admit a new value never invalidates existing rows.
- `ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS weekly_count_due_dow smallint
  NULL CHECK (weekly_count_due_dow BETWEEN 0 AND 6)`. `0 = Sunday … 6 = Saturday`,
  matching JS `Date.getDay()` and the `WEEKDAYS` array in `EODCount.tsx:43-51`. **NULL =
  no cadence configured = "weekly count not scheduled"** (AC: excluded from reminders
  and overdue status). Additive nullable column — safe on the 286 KB seed; no backfill.
- No new index needed on `inventory_counts` for the weekly status query — the existing
  `inventory_counts_store_kind_counted_at_idx (store_id, kind, counted_at desc)` already
  covers "latest weekly count for store X" exactly.

**Migration B — `supabase/migrations/20260622090100_weekly_reminder_log.sql`**
(additive; mirrors `eod_reminder_log`)

```
create table if not exists public.weekly_reminder_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  store_id    uuid not null,
  week_start  date not null,   -- canonical week-window anchor (see §3); NOT a free date
  sent_at     timestamptz not null default now(),
  unique (user_id, store_id, week_start)
);
create index if not exists weekly_reminder_log_store_week_idx
  on public.weekly_reminder_log (store_id, week_start);
```

Note the de-dup key differs from `eod_reminder_log`: EOD dedups on
`(user_id, store_id, local_date, bucket)` because EOD fires in 60/30/10-min buckets.
The weekly reminder fires **at most once per store per week**, so the key is
`(user_id, store_id, week_start)` with no bucket. `week_start` is the canonical Monday
(or due-day-anchored window start — see §3) so cron re-runs within the same week collide
on the unique constraint.

**Realtime publication gotcha:** `supabase_realtime` is `FOR ALL TABLES`
(`20260502190000_realtime_publication.sql`), so both `inventory_counts` (already a
member) and the new `weekly_reminder_log` join automatically — no publication-membership
DDL. BUT: `weekly_reminder_log` is a service-role-only table (no admin UI reads it), so
it need not be live; and `inventory_counts` is already published. **Net: no
`supabase_realtime` membership change in either migration → the
`docker restart supabase_realtime_imr-inventory` re-snapshot step is NOT required for
this spec.** (Documented here so the developer does not add a needless restart to the
deploy runbook.) The admin weekly tab reads `inventory_counts` which is already live;
that satisfies the optional live-status note in the spec's project notes without new
publication work.

### 2. RLS impact

**`inventory_counts` / `inventory_count_entries`:** NO policy changes. Both already
carry the four-policy `auth_can_see_store()` template (counts) and the EXISTS-through-
parent template (entries) from `20260513000000_inventory_counts.sql:139-211`. Widening
`kind` does not touch RLS — a weekly row is admitted/denied by the same per-store gate.
This is the single biggest win of the reuse decision: **zero new RLS surface for the
core write/read path**, so no new attack surface to audit.

**`stores.weekly_count_due_dow`:** column-level — covered by existing table RLS. Reads
flow through `store_member_read_stores`. Writes flow through the existing
`privileged_update_stores` policy (`auth_is_privileged() AND auth_can_see_brand`)
already used by `updateStore` (`db.ts:84-112`). **No new policy** — admin cadence config
reuses the spec-083 `updateStore` PATCH path. (Confirm: setting a column an admin can
already PATCH does not need a new policy; `privileged_update_stores` is permissive on
the whole row.)

**`weekly_reminder_log`:** **four-policy template, but the table is written ONLY by the
cron edge function under `service_role` (which bypasses RLS).** Per the per-store
hardening posture, still `ENABLE ROW LEVEL SECURITY` and add policies so no
`authenticated`/`anon` caller can read another store's reminder log:
- `weekly_reminder_log_read` — `for select using (public.auth_can_see_store(store_id))`
  (defense-in-depth; the staff banner does NOT read this table — see §6 — but an admin
  might want to in a follow-up).
- No insert/update/delete policies for `authenticated` (service_role bypasses RLS, so
  the cron writes fine; absence of an insert policy means a non-service caller cannot
  forge log rows). This is intentionally **3 fewer policies than the four-policy
  template** because only the cron writes — call this out to the security-auditor as a
  deliberate narrowing, mirroring how `eod_reminder_log` is service-written. The
  permissive-policy lint (spec 053) is satisfied: the single SELECT policy uses
  `auth_can_see_store(store_id)`, not a trivially-wide predicate, so no allowlist entry
  is needed.

### 3. Week-window definition (deterministic, local-time)

This is the correctness crux (spec Risk "Week-window definition"). Defined precisely:

- **Anchor:** the store's configured `weekly_count_due_dow` (0-6).
- **Convention:** all date math is in the SAME local-time `todayIso` convention EOD uses
  (`EODCount.tsx:57-63` — `yyyy-mm-dd` from `getFullYear/getMonth/getDate`, NO UTC). The
  status RPC takes an explicit `p_as_of_date date` from the caller (the staff app passes
  its local `todayIso()`; the cron passes the store-local business date). The RPC does
  **not** call `now()::date` for the window math — that would reintroduce the UTC
  off-by-one the spec warns about.
- **Window:** the current week is the **7-day window ENDING on the most recent
  occurrence of the due day-of-week, inclusive** (the spec's stated preferred
  definition). Formally, given `p_as_of_date` and `due_dow`:
  - `days_since_due = (extract(dow from p_as_of_date)::int - due_dow + 7) % 7`
  - `window_end = p_as_of_date - days_since_due` (the most recent due-day, or today if
    today IS the due day)
  - `window_start = window_end - 6`
  - The canonical `week_start` stored in `weekly_reminder_log` IS this `window_start`.
- **Completed-this-week test:** the store is **completed** iff there EXISTS an
  `inventory_counts` row with `kind = 'weekly'`, `store_id = p_store_id`, and
  `counted_at` whose **local date** falls within `[window_start, window_end]`. Because
  `counted_at` is `timestamptz`, the RPC compares against the window using the store's
  local convention; v1 uses the server `DEFAULT_TIMEZONE` (`America/New_York`, matching
  the cron) — documented assumption, see Risks. Practically the comparison is
  `counted_at >= window_start::timestamptz AND counted_at < (window_end + 1)::timestamptz`
  evaluated in the configured TZ.
- **Status enum returned:** `'not_scheduled'` (due_dow NULL), `'completed'` (a weekly
  count exists in-window), `'open'` (no count yet AND `p_as_of_date < window_end` …
  i.e. before/on the due day but the spec treats the whole window as "due"), `'overdue'`
  (no count AND `p_as_of_date == window_end`, i.e. it IS the due day and still not done).
  **Simplification accepted:** because the window always ends on the due day, "open" vs
  "overdue" collapses to "is today the due day and still missing?" The frontend banner
  treats both `open` and `overdue` as "show the banner"; admin tab shows `completed` vs
  `overdue` (the spec's two admin states) by mapping `open|overdue → overdue` for display
  on/after the due day, `completed → completed`, and hides `not_scheduled`. Keep the
  three machine states distinct in the RPC; let the UI collapse them.

### 4. API contract

#### 4a. RPC `submit_weekly_count` (staff write) — NEW

A thin wrapper that mirrors `submit_inventory_count` exactly but hard-codes
`kind = 'weekly'` so the client cannot smuggle a different kind through the weekly path,
and so the generic RPC's `'weekly'`-rejecting allowlist stays intact.

Signature (SECURITY INVOKER, `set search_path = public`):
```
public.submit_weekly_count(
  p_client_uuid uuid,
  p_store_id    uuid,
  p_counted_at  timestamptz,   -- staff passes local submit-time ISO; coalesce(now())
  p_entries     jsonb,         -- [{item_id, actual_remaining, actual_remaining_cases,
                               --   actual_remaining_each, unit, notes}]
  p_notes       text
) returns jsonb   -- { count_id, conflict, entry_ids }
```
Body is the SAME shape as `submit_inventory_count` (`20260513000000:243-381`):
1. Auth gate FIRST: `if not auth_can_see_store(p_store_id) then raise 42501`.
2. Validate `p_entries` non-empty array → 22023.
3. Idempotency: store-scoped `(store_id, client_uuid)` lookup → return
   `{count_id, conflict:true, entry_ids:[]}` on hit. Reuses the EXISTING partial-unique
   index `inventory_counts_store_client_uuid_uidx`.
4. Insert parent with `kind = 'weekly'`, `submitted_by = auth.uid()`,
   `status = 'submitted'`, `counted_at = coalesce(p_counted_at, now())`.
5. Walk entries; skip fully-blank; non-negative check (22023); item-in-store check
   (23503); insert kept entries.
6. Require ≥1 kept entry → 22023 (parent rolls back via implicit txn).
7. NO `UPDATE inventory_items` anywhere (advisory-snapshot guarantee — pgTAP asserts).
8. `REVOKE EXECUTE FROM public, anon; GRANT EXECUTE TO authenticated;` (the
   revoke-from-public is load-bearing — anon inherits PUBLIC).

**Why a new RPC instead of just allowing `'weekly'` through `submit_inventory_count`:**
keeps the generic admin RPC's allowlist closed (defense-in-depth, point 1 of §0), gives
the staff screen a single-purpose signature with no `kind`/`status` params to forge, and
lets pgTAP test the staff path independently. The duplication is ~40 lines and is the
accepted cost.

Error cases (PostgREST maps SQLSTATE → HTTP): `42501 → 403`, `22023 → 400`,
`23503 → 400`. Frontend surfaces via the staff `notifyBackendError`.

#### 4b. RPC `weekly_count_status` (read; SECURITY INVOKER) — NEW

Two call shapes from one function via a nullable store filter:
```
public.weekly_count_status(
  p_store_id  uuid,        -- NULL = all stores the caller can see (admin tab)
  p_as_of_date date        -- caller's local todayIso(); REQUIRED
) returns table (
  store_id      uuid,
  due_dow       smallint,
  window_start  date,
  window_end    date,
  status        text,      -- 'not_scheduled' | 'completed' | 'open' | 'overdue'
  last_count_id uuid,      -- the in-window weekly count, if completed
  last_counted_at timestamptz
)
```
- SECURITY INVOKER → rows are naturally clipped by `inventory_counts` / `stores` RLS
  (`auth_can_see_store` short-circuits to `auth_is_admin()` for admins, so the admin tab
  sees all visible stores; a staff member sees only their `user_stores` stores).
- When `p_store_id` is non-null, returns one row (the staff banner case). When NULL,
  returns one row per visible active store with a configured cadence + the unscheduled
  ones flagged `not_scheduled`.
- Pure read, no writes. `REVOKE … FROM public, anon; GRANT … TO authenticated`.
- The staff banner calls it with `p_store_id = activeStore.id`; the admin tab calls it
  with `p_store_id = null`.

**PostgREST vs RPC:** RPC, not a view. The window math depends on a caller-supplied
local `p_as_of_date` (can't be a static view column without reintroducing UTC drift),
and the `completed` test is a correlated EXISTS over `inventory_counts` with TZ-aware
date comparison. A view can't take the as-of param. RPC is the right tool.

### 5. Edge function changes

**NEW function: `supabase/functions/weekly-reminder-cron/index.ts`** — extends the
`eod-reminder-cron` pattern verbatim where possible.

- **`config.toml`: `[functions.weekly-reminder-cron]` with `verify_jwt = false`.**
  Rationale: this is a cross-store cron reader invoked by `pg_cron` via `net.http_post`
  with a shared bearer — NOT a per-user JWT. Same posture as `eod-reminder-cron` (which
  is not pinned in config.toml today but runs under the same shared-bearer model — the
  developer SHOULD also pin `[functions.eod-reminder-cron] verify_jwt = false` in the
  same PR to close the parity gap, since an un-pinned cron function is a CLI-redeploy
  footgun exactly like the staff-* note at config.toml:417-420). The function validates
  the shared bearer itself via the EXISTING `_edge_auth` / `cron_bearer` lookup
  (`eod-reminder-cron/index.ts:99-127`) — service_role reads the RLS-locked
  `_edge_auth` table and compares; anon-key callers cannot forge it. **Do NOT use the
  per-user JWT path** (spec Risk "Edge-function auth posture").
- **No `ADMIN_ROLES` set needed:** this function does NOT gate on caller *role* (it is
  not user-invoked and performs no privileged role-change/deletion). The CLAUDE.md
  `ADMIN_ROLES`/`auth_is_privileged` mirror rule applies to functions that gate on
  caller role; the shared-bearer cron gate is the correct and sufficient guard here.
  (It DOES, like the EOD cron, union store members with admins for *recipient*
  selection — but that is recipient targeting, not a role gate on the caller.)
- **escapeHtml:** if the function sends an email fallback with an HTML body (mirroring
  `eod-reminder-cron`'s Resend fallback at `:254`), every interpolated value
  (store name, due-day label) MUST go through an inline `escapeHtml()` helper per the
  CLAUDE.md HTML-email rule. The EOD cron interpolates store name into HTML without
  escaping today — that is a pre-existing gap the developer should NOT replicate; the
  new function escapes. (Subjects/recipients are not HTML and don't need it.)
- **No last-of-role / self-guard:** not a destructive role/deletion op; those rules
  don't apply.

Function logic (per store, once per cron fire):
1. Validate shared bearer (403 on mismatch).
2. Load `stores` where `status='active'` AND `weekly_count_due_dow IS NOT NULL`.
3. Compute store-local business date (reuse `businessTodayInTZ`, 3 AM rollover) and the
   week window (§3). **Only act when the local weekday == `weekly_count_due_dow`** —
   the reminder fires on the due day. (If a richer "remind N days before" is wanted,
   that's a follow-up; v1 = due-day only, matching "on the configured due day".)
4. Skip if a weekly count already exists in-window for the store (query
   `inventory_counts` `kind='weekly'` in `[window_start, window_end]`).
5. Recipients = `user_stores` members of the store ∪ admins (reuse
   `eligibleUsersForStore`), minus `notifications_enabled = false` opt-outs (reuse the
   kill-switch at `eod-reminder-cron:200-207`).
6. De-dup: skip users already in `weekly_reminder_log` for `(user_id, store_id,
   week_start)`. Send web push (reuse `sendPushAll` + VAPID), email fallback if no push
   sub (reuse `deliverReminder`), insert an `in_app_notifications` row, then insert the
   `weekly_reminder_log` row ON the same (user, store, week_start) so a re-run within the
   week is a no-op. **At-most-once-per-store-per-week** is guaranteed by the unique
   constraint + the pre-check.
7. Return `{ ok: true, summary: { weekly: [...] } }` (shell-smoke asserts this envelope
   and the dedup).

**Cron scheduling:** a `supabase/scripts/weekly-reminder-cron.sql` (in `scripts/`, NOT
`migrations/` — same as `eod-reminder-cron.sql`, applied manually to prod) scheduling
the function. Since v1 fires only on the due day at a fixed local hour, a daily
`'0 14 * * *'`-style schedule (function self-filters to the due weekday) is sufficient;
the developer picks the hour. This file is manual-prod-only by the existing convention
(`db reset` ignores `scripts/`).

### 6. `src/lib/db.ts` surface (admin side only)

The staff subtree is a documented carve-out (spec 063) and calls `supabase.rpc`
directly — staff weekly-count helpers do NOT go in `db.ts` (see §7). The ADMIN side adds:

```
// kind union widens (src/types/index.ts):
export type InventoryCountKind = 'spot'|'open'|'mid_shift'|'close'|'weekly';

// weekly status for the admin tab (p_store_id = null → all visible stores)
export async function fetchWeeklyCountStatus(asOfDate: string): Promise<WeeklyCountStatus[]>
//   calls supabase.rpc('weekly_count_status', { p_store_id: null, p_as_of_date: asOfDate })
//   maps store_id→storeId, due_dow→dueDow, window_start→windowStart,
//   window_end→windowEnd, status, last_count_id→lastCountId,
//   last_counted_at→lastCountedAt. Wrapped in useInflight.track({kind:'read'}).

// admin cadence write — EXTEND the existing updateStore Pick, no new helper:
//   updateStore(id, { weeklyCountDueDow }) → maps to weekly_count_due_dow.
//   Add weeklyCountDueDow to the Partial<Pick<Store,...>> at db.ts:91-94 and the
//   dbUpdates mapping at :96-100 (pass null through to clear a cadence).
```
- `fetchRecentInventoryCounts` / `fetchInventoryCount` are REUSED unchanged for the
  weekly detail view (they already select `kind`); the admin tab just filters the recent
  list by `kind === 'weekly'` client-side OR the developer adds an optional `kind` filter
  param to `fetchRecentInventoryCounts` (a one-line `.eq('kind', kind)` guarded by an
  optional arg — preferred, cheaper than over-fetching).
- New TS type `WeeklyCountStatus` in `src/types/index.ts` (camelCase mirror of the RPC
  return table) plus `weeklyCountDueDow?: number | null` on the `Store` type.

### 7. Frontend store impact

**Staff side (`src/screens/staff/`):**
- New screen `src/screens/staff/screens/WeeklyCount.tsx` + a third tab in
  `StaffStack.tsx`'s `StaffTabs` (Count | Reorder | **Weekly**). Mirrors `EODCount.tsx`
  but: not vendor-scoped (lists ALL active items for the active store), dual case/each
  inputs where `case_qty > 1` (spec 086 pattern), date captured at SUBMIT time via the
  existing `todayIso()` convention.
- New `useStaffStore` slice fields: `weeklyStatus` (the `weekly_count_status` result for
  the active store) loaded on screen focus (NOT realtime — staff v1 has no realtime,
  spec 062; banner reads on focus per AC). Submit calls a NEW staff-local helper that
  does `supabase.rpc('submit_weekly_count', {...})` directly (carve-out), client-mints
  `client_uuid` via the staff `lib/uuid`, and surfaces errors via the staff
  `notifyBackendError`. Optimistic-then-revert is light here: on success, set
  `weeklyStatus.status = 'completed'` locally (clears the banner) and show the
  "completed for the week of <window_start>" confirmation; on error, revert.
- The **persistent in-app banner** is a new staff-local `WeeklyDueBanner` rendered above
  the tab content (or inside both Count and Weekly screens) that shows when
  `weeklyStatus.status` ∈ {`open`,`overdue`}. It reads the staff store's `weeklyStatus`,
  which is refreshed on focus — the "reliable floor" that works on web AND native
  regardless of push. It is the SOURCE OF TRUTH for "due/overdue this week" that the
  spec asks the staff app to query: the staff app calls `weekly_count_status` with its
  own store id + local `todayIso()`, NOT `weekly_reminder_log` (which is a
  service-write dedup table, not a UI read surface).

**Admin side (`src/store/useStore.ts` + `InventoryCountSection.tsx`):**
- `InventoryCountSection.tsx` gains a weekly tab/filter in its `TabStrip` (alongside the
  existing count/history tabs) that calls `fetchWeeklyCountStatus(todayIso)` and renders
  per-store completed/overdue chips, plus a per-store due-day `<select>` (0-6) that calls
  the store action wrapping `updateStore(id, { weeklyCountDueDow })`.
- `useStore.ts`: add a thin `weeklyCountStatus` slice + a `setStoreWeeklyDueDow` action
  following the existing optimistic-then-revert + `notifyBackendError` pattern (the
  cadence write is optimistic; revert on PATCH failure). `KIND_IDS` and
  `inventoryCountKindLabel/SubLabel` (`utils/enumLabels.ts`) gain `'weekly'`.

### 8. Realtime impact

- **Staff:** none (no realtime in staff v1). Banner reads on focus. Conforming to spec.
- **Admin:** `inventory_counts` is ALREADY in the `FOR ALL TABLES` publication, so a new
  weekly submission by staff replays on the `store-{id}` channel and the admin's
  `useRealtimeSync` 400 ms debounced reload will refresh the section if the admin is
  viewing that store. No publication membership change → **no
  `docker restart supabase_realtime_imr-inventory` step** for this spec. (Explicitly
  flagging the absence so the developer doesn't add a spurious restart.)

### 9. Risks and tradeoffs (architect additions to the spec's own list)

- **Shared-table coupling (accepted).** See §0. The two enumerated must-dos (generic RPC
  keeps rejecting `'weekly'`; label maps + TS union gain `'weekly'`) are the only
  coupling cost. A drift here = the generic admin count form could mint weekly rows, or
  the weekly tab renders blank labels. pgTAP must assert `submit_inventory_count` STILL
  rejects `kind='weekly'` (22023).
- **Timezone single-source assumption.** Both the status RPC's `completed` comparison and
  the cron use the server `DEFAULT_TIMEZONE` (`America/New_York`). Stores in another TZ
  would see a window-boundary skew. Matches the EOD cron's existing single-TZ assumption
  (`eod-reminder-cron:132`); a per-store timezone column is a known follow-up, out of
  scope. Flag to reviewers as a deliberate v1 limitation.
- **`extract(dow)` vs JS `getDay()` parity.** Postgres `extract(dow from date)` returns
  0=Sunday..6=Saturday — IDENTICAL to JS `Date.getDay()` and the `WEEKDAYS` array. The
  column convention is locked to this; the developer must NOT use `isodow` (1=Mon..7=Sun)
  anywhere. pgTAP asserts the window math across a Sun/Sat boundary.
- **Cron schedule cadence.** The function self-filters to the due weekday, so a daily
  schedule is required (a weekly cron can't know each store's due day). At-most-once is
  enforced by `weekly_reminder_log`, not by the schedule. If the daily cron is missed
  (infra outage on the due day), the store gets no push that week but the in-app banner
  still shows (overdue) on subsequent focus — the floor holds.
- **Idempotency index reuse.** `submit_weekly_count` reuses
  `inventory_counts_store_client_uuid_uidx`. A staff `client_uuid` and an admin
  `client_uuid` share the same `(store_id, client_uuid)` space — collision is
  astronomically unlikely (random UUIDs) and the store-scoped match returns the existing
  row's id regardless of kind, which is correct idempotent behavior.
- **Performance on seed.** The status RPC's correlated `EXISTS` over `inventory_counts`
  is covered by `inventory_counts_store_kind_counted_at_idx`; the admin all-stores call
  is one row per visible store (small N). The staff weekly screen lists all active items
  for one store — same query shape as the existing admin count form, already proven on
  the 286 KB seed. No new index gaps.
- **Edge-function cold start.** `weekly-reminder-cron` fires daily, not per-request, so
  cold start is irrelevant to user-facing latency.

### 10. Test surface (maps the spec's Tests AC to concrete assertions)

- **pgTAP `submit_weekly_count`:** 42501 for non-member; idempotent on `client_uuid`
  (second call → `conflict:true`, no second row); `submitted_by = auth.uid()` (forgery
  attempt ignored); `current_stock` UNCHANGED after submit (advisory guarantee).
- **pgTAP `submit_inventory_count` regression:** STILL rejects `kind='weekly'` (22023).
- **pgTAP `weekly_count_status`:** correct `completed`/`open`/`overdue`/`not_scheduled`
  across a week boundary for a representative store + due-dow; window math correct when
  `as_of_date` IS the due day vs the day after vs mid-window.
- **jest staff screen:** renders all items; dual case/each only where `case_qty > 1`;
  submit gated on ≥1 non-blank; banner shows for `open`/`overdue`, hidden for
  `completed`/`not_scheduled`.
- **shell smoke `weekly-reminder-cron`:** sane envelope; once-per-store-per-week guard
  (second invocation same week sends 0).

### 11. Migration ordering

Apply in timestamp order: `20260622090000` (kind widen + cadence column) BEFORE
`20260622090100` (reminder log). The status RPC + `submit_weekly_count` RPC can live in
either migration but cleanest in `20260622090000` AFTER the CHECK widen (so the RPC body
referencing `kind='weekly'` is valid). No down migrations (project convention). The
`scripts/weekly-reminder-cron.sql` is manual-prod-only and not part of `db reset`.

## Implementation status

**Backend: COMPLETE — awaiting frontend.** `Status:` is intentionally left at
`READY_FOR_BUILD` (not `READY_FOR_REVIEW`) because the frontend-developer runs
after this backend pass; per the workflow, status flips to `READY_FOR_REVIEW`
only once BOTH backend and frontend are done. The frontend scope remaining
(design §7) is: the staff `WeeklyCount.tsx` screen + third tab + `WeeklyDueBanner`,
the `useStaffStore` weekly slice + staff-local `submit_weekly_count` helper, the
`InventoryCountSection.tsx` weekly tab + per-store due-day `<select>`, and the
`useStore.ts` `weeklyCountStatus` slice + `setStoreWeeklyDueDow` action, plus the
jest staff-screen render/dual-input/submit-gating test (design §10).

### Verification run this pass
- `npx tsc --noEmit` — clean (exit 0).
- `npx jest` — 655/655 pass (updated the existing `db.updateStore.test.ts`
  projection assertion for the new `weeklyCountDueDow` field).
- pgTAP (`npm run test:db`) and the shell smoke (`scripts/smoke-weekly-reminder.sh`)
  could NOT be executed locally this pass — Docker / the local Supabase stack was
  not running. The three new pgTAP files and the smoke are written to the existing
  conventions and should be run once the stack is up. Reviewer / CI runs them.

### Notes / deliberate calls for reviewers
- Label-map coupling (design §0): `InventoryCountKind` widened to include
  `'weekly'` forced additive edits to `src/utils/enumLabels.ts` (the `KIND_KEY`
  `Record<InventoryCountKind, string>`) and the three i18n catalogs
  (`en`/`es`/`zh-CN`) so the admin "Recent counts" list renders a label instead
  of blank. These are the §0 must-do couplings, kept minimal; the frontend dev may
  refine copy and the new `inventoryCountKind.weekly` strings.
- `weekly_count_status` collapses `open`→`overdue` in practice (window always ends
  on the most-recent due day, so uncompleted always reads `overdue` on/after the
  due day). The three machine states are kept distinct in the RPC per design §3;
  the UI collapses them.
- Single-TZ assumption (America/New_York) hardcoded in both the status RPC and the
  cron — matches the EOD cron; per-store TZ is a documented follow-up (design §9).
- `weekly_reminder_log` ships RLS-enabled with ONLY a SELECT policy (service-write
  table) — a deliberate narrowing vs the four-policy template (design §2).

## Files changed

### supabase/migrations/
- `20260622090000_weekly_count_kind_and_cadence.sql` — widen `inventory_counts.kind`
  CHECK to admit `'weekly'`; add `stores.weekly_count_due_dow smallint`;
  `submit_weekly_count` RPC; `weekly_count_status` RPC.
- `20260622090100_weekly_reminder_log.sql` — dedup table keyed
  `(user_id, store_id, week_start)` + RLS (SELECT-only) + grants.

### supabase/functions/
- `weekly-reminder-cron/index.ts` — new cron edge function (shared-bearer gate,
  per-store-per-week dedup, web push + email fallback + in-app notification,
  inline `escapeHtml` on the HTML email body).
- `weekly-reminder-cron/README.md` — deploy + secrets + schedule + smoke notes.

### supabase/scripts/
- `weekly-reminder-cron.sql` — manual-prod-only daily `pg_cron` schedule.

### supabase/config.toml
- `[functions.weekly-reminder-cron] verify_jwt = false` (new) and
  `[functions.eod-reminder-cron] verify_jwt = false` (parity pin, design §5).

### supabase/tests/ (pgTAP)
- `submit_weekly_count.test.sql` — auth (42501), idempotency, server-canonical
  `submitted_by`, advisory no-stock-write.
- `submit_inventory_count_rejects_weekly.test.sql` — generic RPC still rejects
  `kind='weekly'` (22023).
- `weekly_count_status.test.sql` — week-window math + completed/overdue/not_scheduled.

### src/lib/db.ts
- `fetchWeeklyCountStatus(asOfDate)` (new); `updateStore` extended with
  `weeklyCountDueDow`; `fetchRecentInventoryCounts` gained an optional `kind`
  filter; `fetchStores`/`fetchStoresIncludingInactive` projections carry
  `weeklyCountDueDow`.

### src/types/index.ts
- `InventoryCountKind` union gains `'weekly'`; new `WeeklyCountStatus` +
  `WeeklyCountStatusValue`; `Store.weeklyCountDueDow`.

### src/utils/ + src/i18n/ (label coupling)
- `src/utils/enumLabels.ts` — `KIND_KEY` gains `weekly`.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` —
  `inventoryCountKind.weekly` + `.sub.weekly` strings.

### scripts/
- `smoke-weekly-reminder.sh` — shell smoke (403 gate + envelope + dedup).

### tests (updated)
- `src/lib/db.updateStore.test.ts` — projection assertion updated for the new
  `weeklyCountDueDow` field.

### Frontend (this pass — frontend-developer)

#### Staff surface (src/screens/staff/)
- `screens/WeeklyCount.tsx` — NEW. Weekly full-store count screen: lists EVERY
  active inventory item for the active store (NOT vendor-scoped, alphabetized),
  dual case/each inputs where `case_qty > 1` (spec 086 pattern) and a single
  units input otherwise, submit gated on ≥1 non-blank entry, date captured at
  submit time via the local `todayIso()` convention. Refreshes `weeklyStatus`
  on focus (`useFocusEffect`); renders the `WeeklyDueBanner` + a post-submit
  "completed for the week of <date>" confirmation.
- `screens/WeeklyCount.test.tsx` — NEW jest (design §10): renders all items;
  dual case/each only where `case_qty > 1`; submit gated on ≥1 non-blank;
  banner shows for open/overdue, hidden for completed/not_scheduled.
- `components/WeeklyDueBanner.tsx` — NEW. Persistent in-app reminder (the
  "reliable floor"): reads `weeklyStatus` from the staff store and shows a
  warning/error banner for `open`/`overdue`, nothing for `completed`/
  `not_scheduled`/null. Works on web AND native (focus-read, no realtime).
- `store/useStaffStore.ts` — added the weekly slice: `weeklyStatus` state +
  `fetchWeeklyStatus` (direct `supabase.rpc('weekly_count_status', …)`) +
  `submitWeeklyCount` (direct `supabase.rpc('submit_weekly_count', …)`,
  client-mints `client_uuid` via the staff `lib/uuid`, optimistically flips
  status → `completed` and reverts on error via the staff `notifyBackendError`).
  Staff carve-out per spec 063 — does NOT route through `src/lib/db.ts`.
- `navigation/StaffStack.tsx` — added the third `WeeklyCount` tab (calendar
  icon) to `StaffTabs` alongside Count (clipboard) + Reorder (cart).
- `lib/types.ts` — added `WeeklyItem`, `WeeklyEntry`, `WeeklyStatus`/
  `WeeklyStatusValue`, `SubmitWeeklyResponse`.
- `i18n/en.json` — added the `weekly.*` catalog (tab label, title/subtitle,
  header, list, col, row, submit, banner, toast, error).
- `store/useStaffStore.test.ts`, `screens/StorePicker.test.tsx` — added a
  `../../../lib/supabase` mock (the store now imports the supabase client for
  the weekly carve-out, so `createClient` would otherwise throw at load).

#### Admin surface
- `src/store/useStore.ts` — added the `weeklyCountStatus` / `weeklyCountStatusLoading`
  read slice + `loadWeeklyCountStatus(asOfDate)` (wraps `db.fetchWeeklyCountStatus`),
  and the `setStoreWeeklyDueDow(id, dow|null)` action (optimistic-then-revert via
  `db.updateStore({ weeklyCountDueDow })` + `notifyBackendError`). Imports
  `WeeklyCountStatus`.
- `src/screens/cmd/sections/InventoryCountSection.tsx` — added a third
  `weekly.tsx` tab (reachable even with no store selected, since it is
  all-stores) rendering the new `WeeklyTab`: one row per active store with a
  per-store due-day `<select>` (0–6, web) / static label (native) wired to
  `setStoreWeeklyDueDow`, and a COMPLETED / OVERDUE / NOT SCHEDULED status chip
  (collapses the RPC's `open|overdue` → OVERDUE for display). Loads status via
  `loadWeeklyCountStatus(todayIso())` on tab open.

### Verification (this pass)
- `npx tsc --noEmit` — clean (exit 0).
- `npx jest` — 661/661 pass across 65 suites (was 655; +6 new WeeklyCount
  tests). No regressions.
- Browser preview verification was NOT performed this pass: the `preview_*`
  MCP tools were not available in the implementation environment (only
  filesystem + bash). The web/native code paths are guarded (`Platform.OS ===
  'web'` for the `<select>` and `inputMode`), tsc + jest pass, and the staff
  screen mirrors the proven EODCount layout. A reviewer should exercise the
  staff Weekly tab + admin weekly tab in the browser before ship.

---

## Enhancement pass — category grouping on the staff Weekly Count screen

User request: "show categories for the weekly inventory." The staff Weekly
Count screen (built above) rendered a flat alphabetical list of all items.
This pass groups items by category with a visible category header per group,
mirroring the admin `grouped` idiom (`InventoryCountSection.tsx`).

### What changed
- **`fetchAllItemsForStore`** now selects `category` from the catalog
  (`catalog:catalog_ingredients(name, unit, category, case_qty)`) and carries
  it onto the mapped `WeeklyItem`, collapsing null/missing to `''` (same
  convention as the admin inventory mapper at `db.ts:3498`).
- **`WeeklyItem`** gained a `category: string` field.
- **Render** switched from `FlatList` to `SectionList`. A `sections` `useMemo`
  groups items by category (Map keyed by category, items already name-sorted,
  groups sorted alphabetically). The `''` bucket renders under a localized
  "Uncategorized" header. `renderSectionHeader` draws a header row (uppercase
  title · hairline rule · "{n} items" count), styled with `useStaffColors`.
  `stickySectionHeadersEnabled={false}`.
- **Submit is unchanged and remains category-agnostic.** `onSubmit` and
  `nonBlankCount` still iterate `items` (the flat list), so every non-blank
  entry across ALL categories submits exactly as before — grouping is
  display-only.
- **i18n**: added `weekly.category.uncategorized` ("Uncategorized") and
  `weekly.category.count` ("{count} items") to the staff `en.json` `weekly.*`
  catalog.
- **Tests**: `WeeklyCount.test.tsx` now seeds `category` on the mock catalog
  rows, adds a grouping test (per-category headers + null → "Uncategorized")
  and a cross-category submit test (entries from multiple categories all
  submit), and keeps the existing all-items / dual-input-only-where-case_qty>1
  / submit-gating assertions.

### Verification (enhancement pass)
- `npx tsc --noEmit` — clean (exit 0).
- `npx jest src/screens/staff` — 130/130 pass across 13 suites (WeeklyCount
  suite: 8/8, +2 new). The `act(...)` console warnings are pre-existing
  VirtualizedList async deferred-render noise (same base class as the prior
  `FlatList`); all assertions pass.
- Browser preview NOT performed: `preview_*` MCP tools were unavailable in
  this environment. Verified via tsc + jest and by matching the proven admin
  `grouped` layout. A reviewer should exercise the staff Weekly screen in the
  browser (group headers render, light/dark palette) before ship.

### Files changed (enhancement pass)
- `src/screens/staff/screens/WeeklyCount.tsx` — `category` in select + mapper;
  `WeeklyItem.category`; `sections` grouping memo; `FlatList` → `SectionList`
  with `renderSectionHeader`; section-header styles; dropped the unused
  `FlatList`/`Pressable` imports, added `SectionList`.
- `src/screens/staff/lib/types.ts` — added `category: string` to `WeeklyItem`.
- `src/screens/staff/i18n/en.json` — added `weekly.category.uncategorized` and
  `weekly.category.count`.
- `src/screens/staff/screens/WeeklyCount.test.tsx` — seeded `category` on mocks;
  added grouping + cross-category submit tests; updated header comment.
