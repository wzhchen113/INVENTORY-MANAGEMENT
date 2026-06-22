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

-- Grants: service_role bypasses RLS for the cron writes; authenticated
-- gets SELECT (scoped by the policy above). anon gets nothing.
grant select on public.weekly_reminder_log to authenticated;
revoke all on public.weekly_reminder_log from anon;
