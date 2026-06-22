-- ============================================================
-- Spec 098 — Schedule the weekly-reminder edge function (daily fire)
--
-- NOTE: This file lives in supabase/scripts/ (NOT supabase/migrations/)
-- because it contains placeholders that must be filled in per environment
-- and is intended to be applied manually to PROD only — `supabase db reset`
-- does not pick up files in supabase/scripts/.
--
-- The function self-filters to each store's configured
-- `weekly_count_due_dow`, so a DAILY schedule is correct: a weekly cron
-- can't know each store's due day. At-most-once-per-store-per-week is
-- enforced by public.weekly_reminder_log, NOT by the schedule.
--
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- ⚠ Before running:
--   1. Replace <project-ref>     (Project Settings → General → Reference ID)
--   2. Replace <service-role-key> (Project Settings → API → service_role)
--      — this is what pg_cron sends as the shared bearer; the function
--      compares it against public._edge_auth.cron_bearer.
--   3. Deploy the edge function first:
--      see supabase/functions/weekly-reminder-cron/README.md
--   4. Pick the local fire hour below (default 14:00 server time). The
--      function uses DEFAULT_TIMEZONE (America/New_York) for the store-
--      local business date; choose an hour that lands on the due day for
--      your stores' timezone.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any previous schedule before re-creating (lets you safely re-run).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-reminder-cron') THEN
    PERFORM cron.unschedule('weekly-reminder-cron');
  END IF;
END $$;

-- Daily at 14:00 (server time). Adjust to taste; the function self-filters
-- to the due weekday and dedups per week.
SELECT cron.schedule(
  'weekly-reminder-cron',
  '0 14 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/weekly-reminder-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <service-role-key>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cron$
);

-- Verify:
-- SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'weekly-reminder-cron';
-- SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'weekly-reminder-cron') ORDER BY start_time DESC LIMIT 10;

-- To unschedule:
-- SELECT cron.unschedule('weekly-reminder-cron');
