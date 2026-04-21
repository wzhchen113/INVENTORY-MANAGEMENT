-- ============================================================
-- Schedule the EOD-reminder edge function to fire every 5 min
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- ⚠ Before running:
--   1. Replace <project-ref>   (Project Settings → General → Reference ID)
--   2. Replace <service-role-key> (Project Settings → API → service_role)
--   3. Deploy the edge function first: see supabase/functions/eod-reminder-cron/README.md
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any previous schedule before re-creating (lets you safely re-run).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'eod-reminder-cron') THEN
    PERFORM cron.unschedule('eod-reminder-cron');
  END IF;
END $$;

SELECT cron.schedule(
  'eod-reminder-cron',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/eod-reminder-cron',
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
-- SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'eod-reminder-cron';
-- SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'eod-reminder-cron') ORDER BY start_time DESC LIMIT 10;

-- To unschedule:
-- SELECT cron.unschedule('eod-reminder-cron');
