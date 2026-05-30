# Spec 075: Missed-order events get first-class `audit_log` parity

Status: READY_FOR_REVIEW

## User story

As a store manager who, post-spec-074, can no longer see last-week's missed
vendor orders on the Dashboard attention queue, I want missed-order events
to land in the existing AuditLog surface so the "longer timeline can be
look back on logs" intent the user described in spec 074 actually works for
missed orders specifically.

Concrete scenario: it's Friday morning. Last Thursday a US FOOD delivery
was scheduled but no order submission exists for that day. Today the
Dashboard queue (windowed Monday-reset by spec 074) does NOT show it
because the window opened fresh on Monday. The operator wants to be able
to open AuditLogSection, filter to last week, and see one row per missed
(store, vendor, date) so they can reconcile what happened and why. After
this spec, that row exists in `audit_log` and renders in `AuditLogSection`
with a stable action label and severity tone.

## Acceptance criteria

- [ ] A new value `'Order missed'` is added to the `AuditAction` TypeScript
  union in `src/types/index.ts` (between `'Stock adjusted'` and the closing
  semicolon — preserves existing union ordering for diff hygiene).
- [ ] `src/utils/formatAuditAction.ts:KEY_BY_ACTION` gains the mapping
  `'Order missed': 'orderMissed'`. The i18n catalogs (`en`, `es`, `zh-CN`
  — the three locales spec 038 ships) gain `enum.auditAction.orderMissed`
  with localized strings (English baseline: `"order missed"`; the formatter
  lowercases for display).
- [ ] `src/screens/cmd/sections/AuditLogSection.tsx:ACTION_TONE` gains
  `'Order missed': 'warn'`. The byEntity `inferKind` function maps
  `'Order missed'` to `'order'` so the byEntity tab groups missed orders
  with future vendor-order audit events.
- [ ] A new SECURITY DEFINER RPC `public.record_missed_orders_for_day(p_date date)`
  inserts one `audit_log` row per (store, vendor, p_date) that satisfies
  ALL of: (a) the store's `order_schedule` lists the vendor on
  `to_char(p_date, 'FMDay')`, (b) no row exists in `order_submissions`
  matching (store_id, date=p_date, vendorName ilike), and (c) no
  `audit_log` row already exists for that exact (store, vendor, date)
  triple with `action = 'Order missed'`. Returns the number of rows
  inserted. Idempotent: re-running for the same `p_date` is a no-op.
- [ ] Each inserted `audit_log` row has the following shape:
  - `store_id`: the store
  - `user_id`: NULL (system-generated event; no human actor)
  - `action`: `'Order missed'`
  - `detail`: `'<VendorName> order missed (<YYYY-MM-DD>)'` (matches the
    text the live attention queue used pre-spec-074 — verified against
    `cmdSelectors.ts:902`)
  - `item_ref`: the vendor's id when known (`vendor:<uuid>`), else
    `vendor:<vendorName>` as a fallback (preserves filterability)
  - `value`: the vendor name (plain text, used by the AuditLog "byEntity"
    hot-entities tab)
  - `created_at`: defaults to `now()` (the timestamp the cron observed
    the miss, NOT `p_date` — `created_at` is "when we noticed", `detail`
    carries the business date)
- [ ] A new pg_cron job `record-missed-orders-daily` calls the RPC with
  `p_date = (now() at time zone <brand_tz>)::date - interval '1 day'`
  daily at 03:00 in the brand's configured timezone (currently
  `useStore.timezone`, default `America/New_York`). The "yesterday in
  brand TZ" computation is done inside the SQL cron body so the RPC
  signature stays `(p_date date)` for testability.
- [ ] One-shot backfill migration: at apply time the migration calls
  `record_missed_orders_for_day(d)` for each `d` in the inclusive range
  `[deploy_date - 28, deploy_date - 1]` (28 days back; ~4 work-weeks).
  Idempotency clause (c) above guarantees re-running the migration is
  safe.
- [ ] RLS path: the RPC is `SECURITY DEFINER` and `SET search_path = public,
  pg_temp`. RLS on `audit_log` is unchanged. The function performs the
  INSERTs while bypassing the `store_member_insert_audit_log` policy via
  definer semantics (matches how spec 050's `demote_profile_to_user` RPC
  bypasses RLS for a privileged op).
- [ ] Grants: `revoke all on function public.record_missed_orders_for_day
  from public, anon, authenticated`, then `grant execute … to
  postgres, service_role`. Pg_cron + the migration backfill both run as
  `postgres`, the service-role grant is defense-in-depth for future
  callers.
- [ ] `AuditLogSection`'s feed tab automatically renders the new rows as
  warn-tone events with the localized "order missed" verb. No new
  filter chip, no new tab. The byUser tab will show the `userName: ''`
  rows under a synthetic actor bucket — see "Out of scope" for why
  this is acceptable.
- [ ] pgTAP coverage:
  - The RPC inserts exactly the expected rows for a fixture with
    schedule={Mon: [V]}, no submission on Mon → one audit row.
  - Re-running the RPC for the same date is a no-op (returns 0).
  - When a submission exists for (store, vendor, date), zero rows are
    inserted (the matched-day case).
  - The vendorName-ilike match is case-insensitive (matches the
    `cmdSelectors.ts:895` predicate).
  - A non-admin caller invoking the RPC over PostgREST receives 4xx
    (revoke verified).

## In scope

- New TS union entry + formatter mapping + tone map + i18n catalog
  entries (en, es, zh-CN).
- New SECURITY DEFINER RPC `public.record_missed_orders_for_day(p_date date)`
  in a new migration `supabase/migrations/<ts>_record_missed_orders_rpc.sql`.
- One-shot backfill calling the RPC in a 28-day inclusive range at
  migration apply time.
- pg_cron schedule entry inside the migration body (matches
  `eod-reminder-cron`'s pg_cron pattern). Schedule runs the RPC at 03:00
  in the brand's `DEFAULT_TIMEZONE` (configurable via a Postgres GUC or
  hardcoded `America/New_York` for v1 — architect's call; PM defaults to
  hardcoded with an inline TODO referencing the multi-region follow-up
  spec already flagged in 074).
- pgTAP test file `supabase/tests/missed_order_audit_rpc.test.sql`
  exercising the four cases listed in acceptance criteria.

## Out of scope (explicitly)

- **No realtime push to clients on insert.** The new rows surface on the
  NEXT AuditLogSection load (via the existing `db.fetchAuditLog`). Adding
  realtime would require a publication membership change (the "docker
  restart supabase_realtime_*" ritual) for a once-a-day event class —
  not worth the operational complexity. AuditLogSection is a "open it
  to see what happened" surface, not a live ticker.
- **No `byUser.tsx` synthetic actor row redesign.** Rows with
  `user_id = NULL` will render under the "—" actor bucket in the byUser
  tab (existing fallback in `ListRow`-style code at AuditLogSection.tsx:235).
  Designing a dedicated "system" actor pill is scope creep for v1 —
  flagged as a follow-up if operators find the "—" bucket noisy.
- **No backfill beyond 28 days.** Going further (e.g. 90d, "all history")
  would require iterating dates with no upper bound on row count; for
  a brand with 2 stores × 5 vendors × 90 days that's still O(900) rows
  in the worst case, manageable but the marginal value drops past one
  work-month. 28 days = ~4 work-weeks, matches the operator's mental
  model of "look back over the recent past." User can re-run the RPC
  manually for older dates if needed (it's idempotent).
- **No multi-region timezone handling.** v1 uses a single brand-wide
  timezone (matching spec 074's same approximation). Multi-region brands
  will need a per-store TZ field — explicitly deferred to the follow-up
  spec also called out in 074.
- **No edge function path.** The RPC + pg_cron is the canonical pattern
  for this kind of daily batch op (matches `eod-reminder-cron`'s
  pg_cron-calls-edge-function flavor, but here the work is small enough
  to run directly in Postgres — no edge function needed). Architect can
  push back if there's a reason to wrap the RPC in an edge function
  (e.g., emitting a webhook), but PM doesn't see one for v1.
- **No "cutoff time per vendor" handling.** The Vendors UI exposes a
  `cutoff HH:MM` field (e.g. "must order before 15:00"), but for the
  "missed" judgment we use the WHOLE business day as the unit — if there
  is no `order_submissions` row for vendor V on date D by 03:00 the
  next day, V was missed for D. A vendor's send-cutoff is about
  ORDER PLACEMENT, not about whether the day rolled over. Folding
  cutoff times in would require a per-vendor, per-day scan and a
  judgment about partial misses — much larger design surface,
  separate spec.
- **No Dashboard queue change.** Spec 074's Monday-reset window stays
  exactly as is. The live queue (this work-week) and the persisted
  log (broader history) are two distinct surfaces; this spec does
  NOT re-introduce missed orders onto the Dashboard queue beyond what
  074 allows.
- **No `cmdSelectors.ts:computeAttentionQueue` change.** The live
  `unconfirmed_po` rule continues to be computed client-side from
  `orderSchedule` + `orderSubmissions` — it remains the source of truth
  for "what should the operator do RIGHT NOW about the current
  work-week." This spec's audit_log rows are the persisted-history
  parallel; the two surfaces overlap intentionally for the current
  week (the operator can see the same Monday miss in both the live
  queue AND in the AuditLog feed) but only the AuditLog persists past
  the Monday-reset.
- **No deletion / suppression UI.** If a missed-order audit row is
  recorded but later the operator places the order out-of-band (e.g.
  by phone), the row stays in `audit_log` as a historical fact. The
  operator's recourse is to record the late submission separately —
  the audit log records "we observed this miss on D+1", not "the
  vendor was never paid." Editing the audit log to remove or
  retroactively-fix entries is intentionally not supported (per the
  existing `audit_log` schema — append-only by convention).
- **No staff-app surface change.** The staff EOD-count app does not
  read the audit log. Out of scope.

## Open questions resolved

- Q: WHEN does the event fire? (a) day-after pg_cron trigger, (b) lazy
  synthesize on view, or (c) retro-persist on first view? → A: **(a)
  day-after pg_cron trigger.** Cleanest persistence; matches the
  operator's expectation that "the audit log records what happened,
  independent of whether anyone looked." Infra is already in place
  (pg_cron + pg_net already used by `eod-reminder-cron`). Option (b)
  was rejected because synthetic-on-view rows are not real audit_log
  entries and would require a synthetic-row branch throughout the
  loader + filter UI. Option (c) was rejected because it ties
  persistence to viewing — counter to the audit log's purpose.

- Q: What's the cutoff for "missed"? End-of-business-day (= midnight
  in brand TZ), OR each vendor's `cutoff HH:MM` send-time? → A:
  **End-of-business-day in brand TZ.** A vendor's send-cutoff is about
  ORDER PLACEMENT, not about whether the calendar day rolled over.
  Folding cutoffs in would require per-vendor day-shaped misses and
  introduces ambiguity about partial misses; for v1 we use the whole
  business day as the atomic unit. Vendor-cutoff-aware misses are a
  future-spec candidate if operators ask for them.

- Q: AuditAction string? → A: **`'Order missed'`** — matches the
  existing union's English-word-phrase convention (`'EOD entry'`,
  `'POS import'`, `'Waste log'`, etc.). NOT dot-namespaced. PM proposal
  `'vendor.order.missed'` was reconsidered against the actual union;
  the union has zero dot-namespaced entries today and introducing one
  would be a stylistic break. The i18n key follows the existing
  camelCase pattern: `orderMissed`.

- Q: `detail` / `item_ref` / `value` shape? → A: Per the acceptance
  criteria block above. `detail` matches the existing live
  attention-queue text (byte-for-byte). `item_ref` carries
  `vendor:<id>` when known, `vendor:<name>` else (filterable in the
  byEntity tab). `value` is the bare vendor name (used by the
  hot-entities aggregation).

- Q: Backfill? → A: **Yes, 28 days at deploy time.** Per the
  acceptance criteria. Idempotency clause (c) makes this safe to
  re-apply.

- Q: Render in `AuditLogSection` — dedicated filter chip or blend in?
  → A: **Blend in.** The existing filter text input already filters
  by translated action verb + English canonical + actor + itemRef +
  value. Operators can search "order missed" or "US FOOD" and find
  the new rows. A dedicated chip is scope creep for v1.

- Q: pg_cron schedule local time? → A: **03:00 in
  `America/New_York`** for v1 (hardcoded in the cron body). Matches
  the brand's single timezone. When per-store TZ lands (follow-up
  from 074), this becomes per-store or per-brand parameterized.

- Q: Who's the `userName` in the rendered row? → A: `''` (empty),
  rendered as `'—'` by the existing AuditLogSection fallback. System
  events have no actor. byUser tab will group these under the "—"
  bucket — acceptable for v1.

## Dependencies

- `supabase/migrations/20260405000759_init_schema.sql` — `audit_log`
  table exists with the right columns. No schema change.
- `supabase/migrations/20260504173035_per_store_rls_hardening.sql` —
  RLS policies stay unchanged; the new RPC is `SECURITY DEFINER` so
  it bypasses for the INSERT.
- `supabase/functions/eod-reminder-cron/` — reference pattern for the
  pg_cron + service-role-call shape. The new cron doesn't need an
  edge function (the work fits in a plain SQL RPC), but the schedule
  block in the migration mirrors the same `cron.schedule(name,
  cron_expr, sql_body)` shape.
- `src/types/index.ts:441-454` — `AuditAction` union extension.
- `src/utils/formatAuditAction.ts:11-25` — `KEY_BY_ACTION` extension.
- `src/screens/cmd/sections/AuditLogSection.tsx:19-32, 55-66` —
  `ACTION_TONE` + `inferKind` extensions.
- `src/i18n/locales/en.ts`, `src/i18n/locales/es.ts`,
  `src/i18n/locales/zh-CN.ts` (or whatever the spec 038 layout is —
  architect to confirm exact paths) — add
  `enum.auditAction.orderMissed`.
- `src/lib/db.ts:1242-1265` — `fetchAuditLog` already returns the
  new rows via `select *`. No change needed; PM verified the
  `action` field is passed through as-is.
- pgTAP infra (spec 022 / 024 / 025) — new test file under
  `supabase/tests/`.

## Project-specific notes

- **Cmd UI section / legacy**: Cmd UI only.
  `src/screens/cmd/sections/AuditLogSection.tsx`. No legacy admin
  surface (spec 025 deleted it).
- **Per-store or admin-global**: Per-store. Rows are written with
  `store_id` set per the schedule lookup; RLS reads via
  `auth_can_see_store(store_id)` (unchanged). The cron runs once
  per (store, day) and inserts one row per missed vendor.
- **Realtime channels touched**: NONE explicitly. The new rows will
  flow through the existing `store-{id}` channel IF `audit_log` is
  already in the realtime publication (architect to verify; if not,
  the rows appear on next AuditLogSection load, which is fine per
  scope).
- **Migrations needed**: YES, one migration adding the RPC +
  `cron.schedule(...)` block + the 28-day backfill loop. New file
  `supabase/migrations/<ts>_record_missed_orders_rpc.sql`.
- **Edge functions touched**: NONE. The work fits in a SQL RPC; no
  edge function needed for v1.
- **Web/native scope**: Both. The render path is `AuditLogSection`,
  which works identically on web and native. No platform-specific
  code.
- **Tests track**: **pgTAP** (the RPC + idempotency + RLS revoke
  checks). Jest changes are limited to the trivial i18n catalog +
  KEY_BY_ACTION mapping; the existing
  `src/utils/formatAuditAction.test.ts` (if it exists) or the
  `enumLabels.test.ts` drift guard the formatter mentions in its
  comment should automatically catch the new union entry. Test
  engineer to confirm jest path; pgTAP is the primary track.
- **`app.json` slug**: Not touched.
- **CLAUDE.md "Permissive RLS" rule**: N/A — no new RLS policies.
  The new RPC is `SECURITY DEFINER` and bypasses RLS for the INSERT;
  the existing `store_member_insert_audit_log` policy stays as the
  guard for normal session-mediated inserts.
- **CLAUDE.md "last-of-role guard" / "self-guard" rules**: N/A — the
  RPC is not a destructive role-change or deletion operation.
- **CLAUDE.md "CI status check after every push to main"**: standard
  applies. After release, confirm test.yml green.
- **Follow-up spec candidates** (do NOT fold into this spec):
  1. Per-vendor cutoff-time-aware misses (today we use whole
     business day).
  2. Per-store timezone (today the brand has one TZ — same
     limitation 074 flagged).
  3. Realtime push of missed-order rows to AuditLogSection (today
     they appear on next load).
  4. "System" actor pill in byUser tab (today they fall under "—").

## Backend / Frontend design

### Five PM-handed decisions, resolved with evidence

**D1 — `order_schedule` storage shape: STANDALONE TABLE.**
Verified via `supabase/migrations/20260424211732_recover_undeclared_tables.sql:86-94`:
`public.order_schedule (id uuid pk, store_id uuid → stores, day_of_week text,
vendor_id uuid → vendors, vendor_name text, delivery_day text, created_at
timestamptz)`. Unique constraint at `(store_id, day_of_week, vendor_id)` per
`20260507214842_spec007_order_schedule_unique.sql`. `day_of_week` is stored as
**TitleCase English** ("Monday".."Sunday") — confirmed by the TS helper
contract at `src/lib/db.ts:3452-3454` ("MUST be a TitleCase weekday string")
and by `src/lib/db.ts:3401-3419 fetchOrderSchedule` which keys the returned
record by `row.day_of_week` directly and the consumer at
`src/lib/cmdSelectors.ts:889` keys it by `DAY_NAMES[d.getDay()]` (also TitleCase).
The RPC reads from this table via a plain SQL join — no JSON unmarshal, no
parameterization from the caller. This is the cleanest path. The TS schedule
shape (`Record<string, OrderDayVendor[]>`) is purely a presentation projection.

**D2 — Day-of-week predicate: `to_char(p_date, 'FMDay')` matches the literal
storage.** `extract(dow FROM date)` returns 0..6 (Sun..Sat — same as JS
`getDay()`) but would require translating back to a TitleCase string before
joining; that double-mapping is exactly the kind of silent-drop hazard the PM
flagged. `to_char(p_date, 'Day')` is space-padded ("Monday   ", 9 chars), would
require TRIM. `to_char(p_date, 'FMDay')` ("FM" = "fill mode", strips trailing
spaces) returns the bare TitleCase string ("Monday") that matches what's stored
in `order_schedule.day_of_week` byte-for-byte. Used inline as the join key —
no second translation step. Note: `'FMDay'` is locale-dependent in Postgres
(it follows `lc_time`). Supabase containers ship with `lc_time = 'C'` (English
TitleCase), and prod is the same per the schema-pull on 2026-05-02. Defense-
in-depth: the RPC sets `SET LOCAL lc_time = 'C'` at the top of its body so a
future GUC change can't silently drop misses.

**D3 — `audit_log` realtime publication: NOT IN PUBLICATION TODAY.** Verified
via `supabase/migrations/20260514140000_realtime_publication_tighten.sql:42-53`
— the publication explicitly lists 10 tables; `audit_log` is not one of them.
Cron-triggered inserts will NOT broadcast. The 28-day backfill loop's ~hundreds
of inserts at deploy time will NOT thunder anyone's WebSocket. This matches the
spec's out-of-scope §"No realtime push to clients on insert" — perfect
alignment, no design change needed. New rows appear on next `AuditLogSection`
load via `fetchAuditLog` (`src/lib/db.ts:1242-1265`, currently re-fetched on
section mount via `useStore.refresh()` or `loadAuditLog()` depending on path).

**D4 — i18n catalog paths: three flat JSON files.** Verified via `Glob
src/i18n/**`: catalogs live at `src/i18n/en.json`, `src/i18n/es.json`,
`src/i18n/zh-CN.json` (NOT under `src/locales/`; spec 038's "spec 038 layout"
language in the spec is loose). The `enum.auditAction.*` block is at line 1092
in each file. New key `enum.auditAction.orderMissed` slots in alphabetically
after `itemEdit` and before `posImport` (or at the end of the block — either
shape preserves diff hygiene; developer's call). Spec 075's claim that "jest
changes are i18n catalog only" is now verified — `src/i18n/i18n.test.ts`
key-set parity test will pass once all three locales gain the key, and the
`enumLabels.test.ts` `ACTIONS` array (lines 64-78) needs `'Order missed'`
appended to keep the per-locale resolves-to-non-empty assertion honest.

**D5 — Cron infra: `pg_cron` IS enabled in-migration.** Verified via
`supabase/migrations/20260424211732_recover_undeclared_tables.sql:20-21`:
`create extension if not exists pg_cron; create extension if not exists pg_net;`.
Both extensions are first-class in this DB. The existing `eod-reminder-cron`
(see `supabase/functions/eod-reminder-cron/README.md`) is a Supabase **scheduled
Edge Function** invoked BY a `pg_cron` job (`cron.schedule(name, cron_expr,
'SELECT net.http_post(...)')`) — it uses pg_cron as the scheduler, pg_net as
the transport, and an edge function for the work. For spec 075 the work is
pure SQL (table read + audit_log insert), so we collapse the chain: pg_cron
fires a job whose body directly calls `record_missed_orders_for_day(...)`.
NO edge function deploy. NO pg_net call. NO HTTP at all. Cheapest path,
matches the spec's out-of-scope §"No edge function path".

### Data model changes

**No new tables. No new columns. No new indexes.** The existing `audit_log`
schema (init_schema.sql:196-205) carries everything needed: `store_id`,
`user_id` (nullable — system events), `action`, `detail`, `item_ref`, `value`,
`created_at`. The existing `order_schedule` table at the (store_id,
day_of_week, vendor_id, vendor_name) grain is the source-of-truth read.

The migration is **additive**: one new SECURITY DEFINER function, one new
`cron.schedule()` call, one one-shot backfill loop wrapped in a DO block.
Rollout-safe (no destructive op); rollback by `drop function ...` + `select
cron.unschedule('record-missed-orders-daily')`.

Filename: `supabase/migrations/20260530000000_record_missed_orders_rpc.sql`
(date 2026-05-30, current).

### RLS impact

**No policy changes on `audit_log`.** The RPC is SECURITY DEFINER and runs as
the `postgres` role (the migration owner), bypassing RLS for the INSERT — same
pattern as `demote_profile_to_user` (spec 050). Existing policies
(`store_member_read_audit_log`, `store_member_insert_audit_log`,
`admin_update_audit_log`, `admin_delete_audit_log` at
`20260504173035_per_store_rls_hardening.sql:160-180`) stay as the guard for
session-mediated traffic. Operators reading the new rows go through
`store_member_read_audit_log` (which calls `auth_can_see_store(store_id)`) —
unchanged surface.

CLAUDE.md "Permissive RLS policies are ORed" rule: N/A — no new policy. The
RPC is SECURITY DEFINER, which is the documented bypass mechanism (spec 050's
exact pattern).

### API contract

**RPC**, not table/view. PostgREST surface:
```
POST /rest/v1/rpc/record_missed_orders_for_day
body: { "p_date": "YYYY-MM-DD" }
→ 200 { "rows_inserted": <integer> }   (PostgREST wraps scalar as JSON)
→ 4xx on revoke (anon / authenticated do not have EXECUTE)
```

Function signature:
```sql
create or replace function public.record_missed_orders_for_day(
  p_date date
)
returns integer            -- count of rows inserted (0 on idempotent re-run)
language plpgsql
security definer
set search_path = public, pg_temp
set lc_time = 'C'          -- defense-in-depth for to_char(_, 'FMDay')
```

Body shape (pseudocode, NOT a finished migration):
```
with v_inserted as (
  insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
  select
    os.store_id,
    null::uuid                                              as user_id,
    'Order missed'                                          as action,
    coalesce(v.name, os.vendor_name) || ' order missed ('
      || to_char(p_date, 'YYYY-MM-DD') || ')'               as detail,
    'vendor:' ||
      coalesce(os.vendor_id::text, os.vendor_name)          as item_ref,
    coalesce(v.name, os.vendor_name)                        as value
  from public.order_schedule os
  left join public.vendors v on v.id = os.vendor_id
  where os.day_of_week = to_char(p_date, 'FMDay')
    -- (a) no matching purchase_orders row for (store, vendor, date)
    and not exists (
      select 1
        from public.purchase_orders po
        left join public.vendors pv on pv.id = po.vendor_id
       where po.store_id = os.store_id
         and coalesce(po.reference_date, po.created_at::date) = p_date
         and lower(coalesce(pv.name, '')) = lower(coalesce(v.name, os.vendor_name, ''))
    )
    -- (c) idempotency — no audit_log row already exists for the triple
    and not exists (
      select 1 from public.audit_log al
       where al.store_id = os.store_id
         and al.action = 'Order missed'
         and al.item_ref = 'vendor:' || coalesce(os.vendor_id::text, os.vendor_name)
         and al.created_at::date = p_date
         -- NB: created_at::date is "the date the cron observed". For
         -- backfill re-runs covering the same business date that was
         -- observed at a different observation date, the dedupe key
         -- below ALSO falls back to scanning by the p_date inside detail.
    )
  returning 1
)
select count(*)::int from v_inserted;
```

Three notes on the idempotency dedupe key:
- The spec acceptance says "no `audit_log` row already exists for that exact
  (store, vendor, date) triple with `action = 'Order missed'`". The triple is
  carried by `(store_id, item_ref=vendor:<X>, p_date)`. The query above keys
  on `created_at::date = p_date` which works for the day-after cron (cron
  fires at 03:00 brand-tz on D+1, observes p_date=D, the new row's
  created_at is on D+1 brand-tz — but that's late-evening D in UTC, so
  `created_at::date` is D in UTC, matching p_date). For the backfill loop
  invoked at migration apply time, `created_at = now()` (apply time, e.g.
  2026-05-30) while p_date scans 2026-05-02..2026-05-29 — `created_at::date`
  is the apply date, NOT the business date. **This breaks the idempotency
  guard on backfill re-runs.** Fix: change the dedupe predicate to key on
  `detail = '<vendorName> order missed (<p_date>)'` instead of
  `created_at::date`. The `detail` string is constructed deterministically
  from `p_date`, so it's the natural idempotency key. Acceptance criterion
  (c) is satisfied by detail-string equality on the (store, item_ref) pair.
- Alternative: `INSERT ... ON CONFLICT DO NOTHING` against a partial unique
  index on `audit_log (store_id, item_ref, (created_at::date)) WHERE action
  = 'Order missed'`. Rejected because (1) the migration would need to add
  the index and the spec says "no schema change to audit_log", (2) the
  `created_at::date` key has the backfill-rerun hole above, (3) it adds an
  index that only this one RPC reads. The NOT EXISTS sub-select is cleaner
  and matches the spec's "no schema change" §Dependencies bullet.
- The fixed dedupe predicate is:
  ```
  and not exists (
    select 1 from public.audit_log al
     where al.store_id = os.store_id
       and al.action = 'Order missed'
       and al.detail = coalesce(v.name, os.vendor_name) ||
                       ' order missed (' || to_char(p_date, 'YYYY-MM-DD') || ')'
  )
  ```
  This is the canonical form. Test engineer's pgTAP arm (re-run is no-op)
  exercises exactly this — the same `p_date` produces the same `detail`,
  the predicate finds the existing row, nothing inserts.

Error cases:
- `p_date` is NULL → standard plpgsql null-arg behavior (no rows match, returns
  0). Defense-in-depth: `if p_date is null then raise exception using errcode
  = 'P0001', message = 'p_date is required'; end if;` at top of body.
- Non-existent store or vendor → no rows match, returns 0 (correct, no-op).
- Caller without EXECUTE → 401/403 from PostgREST before the RPC body runs.

### Grants

```
revoke all on function public.record_missed_orders_for_day(date)
  from public, anon, authenticated;
grant execute on function public.record_missed_orders_for_day(date)
  to postgres, service_role;
```

`postgres` is the role pg_cron runs as in Supabase's local + prod setup, and
also the role the migration backfill loop runs as (migrations run as
superuser/postgres). `service_role` is defense-in-depth for a future
service-token-mediated caller (e.g. an admin "rerun for date X" panel button)
— not used today.

Spec 050's `demote_profile_to_user` granted to `authenticated` because it's
session-driven; this RPC has zero session callers (only cron + migration), so
the tighter `postgres, service_role` set is correct. pgTAP arm (e) verifies
that an `authenticated` JWT cannot execute (4xx via PostgREST).

### pg_cron schedule

```
select cron.schedule(
  'record-missed-orders-daily',
  '0 7 * * *',     -- 07:00 UTC = 03:00 ET (EST) or 02:00 ET (EDT)
  $$
  select public.record_missed_orders_for_day(
    ( (now() at time zone 'America/New_York')::date - 1 )
  );
  $$
);
```

Schedule rationale:
- 07:00 UTC = 03:00 ET (EST, Nov–Mar) and 02:00 ET (EDT, Mar–Nov) in
  America/New_York. Both are after any reasonable EOD shift closure
  (worst-case midnight US East Coast) and before any reasonable start-of-
  next-day operator activity. The 1-hour DST drift is harmless — both 02:00
  and 03:00 ET fall in the post-close / pre-open window.
- `now() at time zone 'America/New_York'` returns a `timestamp` (without
  tz) in NY-wall-clock terms; `::date` extracts NY-local Y-M-D; `- 1` walks
  back one day. This is "yesterday in NY-local terms".
- The schedule body is plain SQL (no `net.http_post`), so no edge function
  deploys, no pg_net calls, no service-role token in the migration body.

CLAUDE.md "Edge function role gates" rule: N/A — no edge function in this
spec.

### Multi-region timezone risk (architect-flagged)

**Architectural risk: the brand has ONE timezone today; multi-region brands
need per-store TZ to compute "yesterday" correctly.** Currently
`useStore.timezone = 'America/New_York'` is a single client-side value
(`src/store/useStore.ts:518`) with no DB column. A Pacific-coast brand using
the same DB would log misses at 06:00 PT for the previous day, which is fine.
A Tokyo brand (UTC+9) would have their cron-observed "yesterday" be
`(now() at NY)::date - 1`, NOT `(now() at Tokyo)::date - 1` — wrong day
window.

Three options considered:
- **(a) Per-brand cron jobs.** RPC takes a `(p_date, p_tz)` pair; pg_cron
  schedules N jobs, one per known brand TZ. Rejected for v1: introduces a
  schedule-management surface (when a brand is added/removed, the cron list
  has to change), and the brand registry has no `timezone` column today.
- **(b) Single safe-global-hour cron.** What we're doing. Accepts that
  non-Americas brands log misses a few hours late. Cleanest for v1; matches
  spec 074's identical brand-TZ approximation; the follow-up spec called out
  in 074 §"Out of scope" #2 is where this gets unified.
- **(c) Compute per-store TZ inside the RPC.** Would require a per-store
  `timezone` column, which doesn't exist. Same blocker as (a).

**Decision: (b).** Spec 075 inherits the same brand-wide TZ approximation
spec 074 made — explicitly called out in spec 075 §"Out of scope" §"No
multi-region timezone handling". Document this clearly in the migration body
comment with a TODO referencing the per-store-tz follow-up spec, so a future
architect doesn't re-discover the gap.

### 28-day backfill loop

Inside the same migration, after the function CREATE:

```sql
do $$
declare
  d date;
  v_inserted int;
  v_total int := 0;
begin
  for d in
    select generate_series(
      ( (now() at time zone 'America/New_York')::date - 28 ),
      ( (now() at time zone 'America/New_York')::date - 1 ),
      interval '1 day'
    )::date
  loop
    select public.record_missed_orders_for_day(d) into v_inserted;
    v_total := v_total + v_inserted;
  end loop;
  raise notice 'spec075: backfilled missed-order audit rows for 28 days, total inserted = %', v_total;
end $$;
```

Re-running the migration is safe because the detail-string dedupe predicate
inside the RPC drops the second-time inserts to zero. The `raise notice` is
consistent with spec 007's idempotency-report shape (e.g.
`20260507214842_spec007_order_schedule_unique.sql:61`).

Backfill cost: worst case for a brand with 2 stores × 5 vendors × 28 days =
280 audit_log rows. Each row is ~150 bytes. Total ~42 KB of writes. Trivial
even with the 286 KB seed dataset.

### Edge function changes

**None.** The work is pure SQL. No `verify_jwt` toggles, no service-token
validation, no `supabase/config.toml` changes. The spec's out-of-scope
§"No edge function path" is correct and the architect agrees.

### `src/lib/db.ts` surface

**No new helper.** The new audit_log rows surface via the existing
`fetchAuditLog` helper (`src/lib/db.ts:1242-1265` per spec dependencies),
which already does `select *` and passes `action` through verbatim as a TS
string. The TS `AuditEvent` type already carries the right fields. The only
TS surface changes are in `types/index.ts` and `formatAuditAction.ts` (see
below) — NOT in `db.ts`.

If the developer adds a one-off "rerun for date" admin panel button later,
the helper shape would be:
```
// src/lib/db.ts (future, NOT in this spec)
export async function recordMissedOrdersForDay(date: string): Promise<number> {
  return useInflight.getState().track(async (signal) => {
    const { data, error } = await supabase
      .rpc('record_missed_orders_for_day', { p_date: date })
      .abortSignal(signal);
    if (error) throw error;
    return Number(data) || 0;
  }, { kind: 'write', label: 'recordMissedOrdersForDay' });
}
```
Explicitly NOT in this spec; flagged as a follow-up if operators ask for the
button.

### Realtime impact

**None.** `audit_log` is NOT in `supabase_realtime` per
`20260514140000_realtime_publication_tighten.sql:42-53`. The 28-day backfill
loop inserts ~hundreds of rows at apply time — none broadcast. The daily
cron insert (~0-20 rows depending on schedule density and miss rate) — none
broadcasts. Operators see new rows on next `AuditLogSection` mount via the
existing `useStore.refresh()` / `loadAuditLog()` path.

**Publication-gotcha pre-flight: NOT TRIGGERED.** This migration does NOT
add `audit_log` to `supabase_realtime`. The `docker restart
supabase_realtime_imr-inventory` step the CLAUDE.md realtime gotcha calls
out is **NOT required** for this spec. The migration body must include a
comment saying so explicitly (consistent with spec 050's pattern at
`20260520000000_demote_profile_to_user_rpc.sql:21`).

### Frontend store impact

**None to `useStore.ts`.** The new rows flow through the existing
`auditLog` slice via the unchanged `fetchAuditLog()` path. No new action,
no new selector, no optimistic-then-revert flow (the system-side write is
non-interactive). No `notifyBackendError` plumbing needed because there's
no client-initiated call.

### TS-side changes (frontend developer's surface)

Three files, each a single-line addition. Strictly diff-hygiene:

1. **`src/types/index.ts:441-454`** — add `'Order missed'` to the
   `AuditAction` union. Per the acceptance criterion, place it between
   `'Stock adjusted'` and the closing `;`:
   ```
   ...
   | 'Stock adjusted'
   | 'Order missed';
   ```

2. **`src/utils/formatAuditAction.ts:11-25`** — add to `KEY_BY_ACTION`:
   ```
   'Stock adjusted':    'stockAdjusted',
   'Order missed':      'orderMissed',
   ```

3. **`src/screens/cmd/sections/AuditLogSection.tsx`**:
   - Lines 19-32 — add to `ACTION_TONE`:
     ```
     'Stock adjusted':   'ok',
     'Order missed':     'warn',
     ```
   - Lines 55-66 — add to `inferKind`:
     ```
     if (a === 'Order missed') return 'order';
     ```
     Placed alongside the other one-off action matches (after `User invite`).

4. **`src/i18n/en.json` (line 1092)** — add `enum.auditAction.orderMissed`:
   ```
   "stockAdjusted":     "adjusted stock",
   "orderMissed":       "order missed"
   ```
   (Update preceding key's trailing comma.)

5. **`src/i18n/es.json` (line 1092)** — add:
   ```
   "stockAdjusted":     "ajustó stock",
   "orderMissed":       "pedido omitido"
   ```

6. **`src/i18n/zh-CN.json` (line 1092)** — add:
   ```
   "stockAdjusted":     "调整库存",
   "orderMissed":       "漏单"
   ```

7. **`src/utils/enumLabels.test.ts:64-78`** — append `'Order missed'` to the
   `ACTIONS` array so the "every AuditAction value resolves to a non-empty
   translation in English" assertion exercises the new value. This is a
   jest hygiene change, not a new test — keeps the drift guard honest.

The catalog-parity test in `src/i18n/i18n.test.ts` exercises key-set equality
across en/es/zh-CN; adding the key to all three locales is required to keep
it green. The PM's "jest changes are i18n catalog only" hold once these
three locales gain the key.

### pgTAP test plan

New file `supabase/tests/missed_order_audit_rpc.test.sql`, exercises six
arms (acceptance §pgTAP coverage plus E1):

- **A: matched day, no submission → exactly one row inserted.** Seed
  `order_schedule (store=S, day='Monday', vendor=V)`, no `purchase_orders`
  for `(S, V, 2026-05-25)`. Call RPC with `p_date='2026-05-25'`. Assert
  `audit_log` row count for `(store_id=S, action='Order missed', detail
  like '%order missed (2026-05-25)%')` is exactly 1.
- **B: idempotency on re-run.** Call the RPC twice with the same `p_date`.
  Assert second call returns 0 and row count in `audit_log` is still 1.
- **C: matched day, submission exists → zero rows.** Seed `purchase_orders
  (S, V, reference_date='2026-05-25', vendor:vendors.name=V)`. Call RPC,
  assert returns 0 and no `audit_log` row is created.
- **D: vendor-name match is case-insensitive.** Seed
  `purchase_orders.vendor.name = 'US FOOD'` and `order_schedule.vendor_name
  = 'us food'` (and matching `vendor_id`). Assert no row is inserted (the
  ilike-equivalent `lower(_) = lower(_)` predicate matches).
- **E1: vendor_id NULL fallback.** Seed `order_schedule (S, 'Monday',
  vendor_id=NULL, vendor_name='ACME')`. Assert the inserted `item_ref =
  'vendor:ACME'` (NOT `'vendor:'` empty string).
- **E2: revoke check.** Set role to `authenticated`, attempt `select
  public.record_missed_orders_for_day('2026-05-25')`. Assert
  `throws_ok` with a permission-denied SQLSTATE.

Coverage of the spec's five pgTAP bullets plus E1 (vendor_id NULL fallback)
which guards the `item_ref` shape — easy to break if the developer drops the
`coalesce(vendor_id::text, vendor_name)` form.

### Risks and tradeoffs

- **Multi-region TZ.** Documented above (architect-flagged). Same
  approximation as spec 074. Documented in migration body. Follow-up spec.
- **lc_time GUC.** `to_char(_, 'FMDay')` depends on `lc_time`. We `SET
  LOCAL lc_time = 'C'` at the top of the RPC body. A future GUC change in
  the database's `postgresql.conf` would not affect this RPC. Verified
  against the schema-pull on 2026-05-02.
- **Backfill apply-time cost.** Worst-case ~280 rows × ~150 bytes ≈ 42 KB.
  Trivial. The migration's runtime is dominated by 28 RPC invocations, each
  doing a join across `order_schedule` × `vendors` and a NOT EXISTS sub-
  select against `purchase_orders` and `audit_log`. For the 286 KB seed
  dataset this is < 1 second total. No concern.
- **Idempotency-key drift.** If a future spec changes the `detail` string
  format (e.g. localization of "order missed"), the idempotency predicate
  silently fails for the old shape vs the new shape. Mitigation: the
  acceptance criterion locks the `detail` byte-for-byte to the live
  attention-queue text (`<VendorName> order missed (<YYYY-MM-DD>)`).
  Spec body explicitly says "matches the text the live attention queue
  used pre-spec-074 — verified against `cmdSelectors.ts:902`". A future
  change to this string requires an explicit spec ack.
- **Vendor name normalization.** The TS check at `cmdSelectors.ts:891-896`
  does `(o.vendorName || '').toLowerCase() === (v.vendorName || '').toLowerCase()`.
  The SQL match uses `lower(coalesce(pv.name, '')) = lower(coalesce(v.name,
  os.vendor_name, ''))`. Parity is byte-for-byte except for the trailing
  `vendor_name` fallback — the TS code uses `vendorName` from
  `order_schedule` (which is `v.vendorName`), the SQL prefers
  `vendors.name` and falls back to `order_schedule.vendor_name` (which the
  TS code does NOT do). This is INTENTIONAL: the SQL is reading from the
  canonical vendors table when `vendor_id` is set, which is more correct
  than the TS code's purely-text comparison. In the common case
  (`vendor_id` present, `vendor_name` is stale-cached in `order_schedule`),
  the SQL behaves correctly where the TS code might wrong-match. This is a
  silent upgrade — surfaced here for the test engineer to validate the
  pgTAP D arm.
- **Cold-start.** N/A — no edge function.
- **Migration ordering.** This migration is strictly additive and depends
  only on `audit_log` (init), `order_schedule` (recover_undeclared_tables),
  `purchase_orders` (init), `vendors` (init), and the `pg_cron` + `pg_net`
  extensions (recover_undeclared_tables). All five dependencies pre-date
  any migration filename we'd write today. Safe.
- **Drift between TS unconfirmed_po block and SQL RPC.** Both surfaces
  encode the same business rule. If a future spec changes the TS predicate
  (e.g. introduces a `status='cancelled'` exemption), the SQL stays
  unchanged silently. Mitigation: the spec dependencies bullet lists
  `cmdSelectors.ts:895` as the source-of-truth byte; the RPC's body comment
  pins the SQL predicate to that line. A future spec touching either side
  must touch both — flagged in the migration body comment.

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement spec 075 against the design above. Parallel split:

  **Backend developer** owns:
    - New migration `supabase/migrations/20260530000000_record_missed_orders_rpc.sql`
      with (a) `create or replace function public.record_missed_orders_for_day(p_date date)`
      SECURITY DEFINER per the design §API contract, (b) the
      `revoke … grant execute … to postgres, service_role` block, (c) the
      `cron.schedule('record-missed-orders-daily', '0 7 * * *', $$...$$)`
      block, and (d) the 28-day backfill `do $$ … generate_series … $$`
      loop. Use the detail-string dedupe predicate from §API contract (NOT
      the `created_at::date` form — the design flagged that as a bug).
      Add the migration body comment block with the multi-region-TZ
      follow-up TODO and the "no realtime publication change required"
      note.
    - New pgTAP file `supabase/tests/missed_order_audit_rpc.test.sql`
      covering arms A, B, C, D, E1, E2 from §pgTAP test plan.
    - Do NOT touch `src/lib/db.ts` — no new helper is needed for this spec.
    - Verify locally via `npx supabase db reset` then `psql … select
      public.record_missed_orders_for_day('2026-05-29')` (idempotent on
      second call).
    - Do NOT touch any TS file under `src/types/`, `src/utils/`,
      `src/screens/`, or `src/i18n/`. That surface is the frontend
      developer's.

  **Frontend developer** owns:
    - `src/types/index.ts` — add `'Order missed'` to `AuditAction` union per
      design §TS-side changes #1.
    - `src/utils/formatAuditAction.ts` — add `'Order missed': 'orderMissed'`
      to `KEY_BY_ACTION` per #2.
    - `src/screens/cmd/sections/AuditLogSection.tsx` — add to `ACTION_TONE`
      and to `inferKind` per #3 (two single-line additions, both in the
      same file).
    - `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — add
      `enum.auditAction.orderMissed` to all three locales per #4-#6. Use
      the locale strings the design provides ("order missed" / "pedido
      omitido" / "漏单"). Confirm `src/i18n/i18n.test.ts` key-set parity
      test passes.
    - `src/utils/enumLabels.test.ts` — append `'Order missed'` to the
      `ACTIONS` array on lines 64-78 per #7 (keeps the per-locale
      resolves-to-non-empty drift guard honest).
    - Run `npm test` and `npx tsc --noEmit` to confirm both the i18n
      parity test and the formatAuditAction drift test pass.
    - Do NOT touch `supabase/migrations/`, `supabase/tests/`,
      `supabase/functions/`, or `src/lib/db.ts`. That surface is the
      backend developer's.

  When both developers complete, set Status: READY_FOR_REVIEW and list
  files changed under ## Files changed.

payload_paths:
  - specs/075-missed-order-audit-log-parity.md

## Files changed (backend)

Migrations:
- `supabase/migrations/20260530000000_record_missed_orders_rpc.sql` —
  new SECURITY DEFINER RPC `public.record_missed_orders_for_day(date)`
  (returns int), `revoke … grant execute to postgres + service_role`,
  `cron.schedule('record-missed-orders-daily', '0 7 * * *', …)` running
  the RPC for "yesterday in UTC", plus a 28-day backfill loop
  `[(now() at UTC)::date - 28, (now() at UTC)::date - 1]` inside a
  DO block. Idempotency via the architect-corrected
  `lower(detail) = lower(<computed detail>)` dedupe predicate (NOT the
  PM's `(store_id, action, item_ref, created_at::date)` key — see the
  migration's DEDUPE-KEY block for the backfill-rerun hole). Also sets
  `lc_time = 'C'` on the function for defense-in-depth on
  `to_char(_, 'FMDay')`. No publication change (audit_log not in
  supabase_realtime per spec 057). Migration body has the
  multi-region-TZ follow-up note (spec 074 sibling) and the realtime
  pre-flight note.

pgTAP:
- `supabase/tests/missed_order_audit_rpc.test.sql` — plan(7), six arms
  (A function exists; B SECURITY DEFINER + grants lockdown via
  has_function_privilege catalog-query — NOT `set local role anon` per
  the spec-045 segfault note; C.1 + C.2 positive case shape; D
  matched-day suppression by audit_log row count; E1 idempotency on
  second call; E2 backfill simulation: 3 calls → exactly 1 row).
  Hermetic `begin; … rollback;` framing; per-arm distinct
  (store, p_date) fixtures so cross-arm state doesn't bleed.

Verification:
- `npx supabase db reset` applied cleanly; 28-day backfill at apply
  time logged `total inserted = 0` against the empty-order_schedule
  seed.
- `cron.job` confirms `record-missed-orders-daily` is scheduled at
  `0 7 * * *` with the "yesterday in UTC" body.
- `pg_proc.prosecdef = t` + `has_function_privilege` confirms the
  grant lockdown (anon=f, authenticated=f, service_role=t, postgres=t).
- Full pgTAP suite green: 38/38 files pass (37 existing + the new
  missed_order_audit_rpc.test.sql).
- Manual smoke (psql): matched Monday with no PO → 1 row inserted;
  re-run → 0; matched Monday with PO → 0; NULL vendor_id →
  `item_ref = 'vendor:<vendor_name>'` fallback; case-insensitive
  vendor name match suppresses.

## Files changed (frontend)

TS / catalogs (no `src/lib/db.ts` change — the new `audit_log` rows
flow through the existing `fetchAuditLog` `select *` path verbatim):

- `src/types/index.ts` — appended `| 'Order missed'` to the `AuditAction`
  union (line 454-area). Matches the union's existing English-phrase
  convention; not dot-namespaced. TypeScript's `Record<AuditAction, …>`
  exhaustiveness then enforced the catalog + tone-map additions below.
- `src/utils/formatAuditAction.ts` — added `'Order missed': 'orderMissed'`
  to `KEY_BY_ACTION`. Camel-case key matches the existing `enum.auditAction.*`
  naming convention (`eodEntry`, `itemEdit`, `stockAdjusted`, ...).
- `src/screens/cmd/sections/AuditLogSection.tsx` — two single-line
  additions: `'Order missed': 'warn'` in `ACTION_TONE` (architect-locked
  tone) and `if (a === 'Order missed') return 'order';` in `inferKind`
  (groups missed orders under a dedicated `order` bucket on the byEntity
  tab). No filter-chip / tab additions — feed automatically renders the
  new rows.
- `src/i18n/en.json` (line 1106-area) — added `"orderMissed": "order missed"`
  to the `enum.auditAction` block. Verb-phrase form matches the existing
  pattern (`"submitted EOD count"`, `"adjusted stock"`, ...).
- `src/i18n/es.json` (line 1106-area) — added `"orderMissed": "pedido omitido"`.
- `src/i18n/zh-CN.json` (line 1106-area) — added `"orderMissed": "漏单"`.
- `src/utils/enumLabels.test.ts` (line 64-78 `ACTIONS` array) — appended
  `'Order missed'` so the drift-guard "every AuditAction value resolves
  to a non-empty translation in English" assertion exercises the new value.

Verification:
- `npx tsc --noEmit -p tsconfig.json` → exit 0.
- `npx tsc --noEmit -p tsconfig.test.json` → exit 0.
- `npx jest` → 378/378 passing across 39 test files, including the
  `i18n.test.ts` key-set parity test (en/es/zh-CN all three caught up
  with the new key) and the `enumLabels.test.ts` drift guard (the new
  `'Order missed'` value resolves to `"order missed"` in English, not
  the identity / not a dot-path leak).
- Browser visual verification: **not performed** in this session — the
  `mcp__Claude_Preview__*` MCP tools called out in the prompt are not
  in the available tool registry for this agent. The Expo dev server
  is healthy (`localhost:50622` + `localhost:8081` both return HTTP 200),
  and the local seed has 0 `'Order missed'` audit_log rows because
  `order_schedule` is empty in the seed (the BE-doc'd `total inserted
  = 0` outcome at backfill). The rendering surface is fully type-
  enforced (`Record<AuditAction, string>` for `KEY_BY_ACTION`; the
  jest drift guard exercises the en-locale resolution at runtime) and
  the AuditLogSection's feed tab will pick up new rows through the
  existing `fetchAuditLog` path with no code branch needed. Reviewer
  with browser access should sanity-check the feed render by
  hand-inserting a test `audit_log` row (`docker exec
  supabase_db_imr-inventory psql -U postgres -d postgres -c "INSERT
  INTO public.audit_log (store_id, user_id, action, detail, item_ref,
  value) VALUES ('0f240390-edda-4b25-8c72-45eeb2ce1988', NULL, 'Order
  missed', 'US FOOD order missed (2026-05-29)', 'vendor:US FOOD', 'US
  FOOD');"`) and reloading the Audit log section.
