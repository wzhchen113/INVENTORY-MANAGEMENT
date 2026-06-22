-- ============================================================
-- Spec 098 — Migration B: weekly_reminder_log dedup table
--
-- Mirrors eod_reminder_log, but the de-dup key is
-- (user_id, store_id, week_start) — the weekly reminder fires at most
-- once per store per week, so there is no 60/30/10-min bucket. `week_start`
-- is the canonical window-start anchor computed by the cron (design §3):
-- the most-recent-due-day minus 6. Cron re-runs within the same week
-- collide on the unique constraint, guaranteeing at-most-once delivery.
--
-- RLS posture (design §2, deliberate narrowing — flagged to security-
-- auditor): the table is WRITTEN ONLY by the cron edge function under
-- service_role (which bypasses RLS). RLS is still ENABLED with a single
-- SELECT policy scoped via auth_can_see_store(store_id) for defense-in-
-- depth — an authenticated/anon caller cannot read another store's log.
-- There is intentionally NO insert/update/delete policy for
-- authenticated: only the cron (service_role, bypasses RLS) writes, so the
-- absence of an insert policy means a non-service caller cannot forge log
-- rows. This is 3 fewer policies than the four-policy template by design,
-- mirroring how eod_reminder_log is service-written.
--
-- Permissive-policy lint (spec 053): the single SELECT policy uses
-- auth_can_see_store(store_id), not a trivially-wide predicate, so no
-- allowlist entry is needed.
--
-- Realtime: service-role-only table, never read live by a UI; the
-- FOR ALL TABLES publication membership is irrelevant here and no realtime
-- container restart is required.
--
-- No down migration (project convention).
-- ============================================================

create table if not exists public.weekly_reminder_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  store_id    uuid not null,
  week_start  date not null,   -- canonical week-window anchor (design §3)
  sent_at     timestamptz not null default now(),
  unique (user_id, store_id, week_start)
);

create index if not exists weekly_reminder_log_store_week_idx
  on public.weekly_reminder_log (store_id, week_start);

alter table public.weekly_reminder_log enable row level security;

-- Defense-in-depth read scoping. No insert/update/delete policy — the
-- cron writes under service_role which bypasses RLS.
drop policy if exists "weekly_reminder_log_read" on public.weekly_reminder_log;
create policy "weekly_reminder_log_read"
  on public.weekly_reminder_log for select
  using (public.auth_can_see_store(store_id));

-- Grants: this table follows the RLS-locked-table pattern of
-- username_resolve_rate_limit (20260607130000) and _edge_auth — it KEEPS the
-- inherited grant for all three Supabase roles (SELECT for anon+authenticated,
-- ALL for service_role) from spec-097's `ALTER DEFAULT PRIVILEGES FOR ROLE
-- postgres` (20260618000000_public_grants_explicit.sql), and relies on RLS as
-- the row gate. RLS is enabled above with a single SELECT policy scoped via
-- auth_can_see_store(store_id) and NO insert/update/delete policy, so an
-- anon/authenticated caller cannot read another store's rows nor write any row
-- over PostgREST — the grant is present but no row is reachable (Category B in
-- public_grants_explicit.test.sql). The cron writes under service_role (bypasses
-- RLS). Deliberately NO `revoke ... from anon` and NO explicit grants: that
-- mirrors _edge_auth (20260424211733), which enables RLS and leaves the
-- spec-097 inherited grants untouched. A `revoke ... from anon` here would trip
-- the spec-097 grant lint, which requires every public base table to hold the
-- broad SELECT grant for all three roles (RLS, not the grant layer, is the gate).
