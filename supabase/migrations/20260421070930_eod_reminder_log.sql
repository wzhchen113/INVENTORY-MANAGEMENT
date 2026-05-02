-- ============================================================
-- EOD reminder dedup log (Phase 3 of EOD reminder feature)
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run (uses IF NOT EXISTS).
-- ============================================================

-- Records which (user, store, local-date, bucket) have already been pushed,
-- so the cron doesn't resend the same reminder across multiple 5-min fires
-- that overlap the tolerance window.
CREATE TABLE IF NOT EXISTS eod_reminder_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  store_id   uuid NOT NULL,
  local_date text NOT NULL,           -- YYYY-MM-DD in the store's local timezone
  bucket     integer NOT NULL,        -- one of 60, 30, 10 (minutes before cutoff)
  sent_at    timestamptz DEFAULT now(),
  UNIQUE (user_id, store_id, local_date, bucket)
);

CREATE INDEX IF NOT EXISTS idx_eod_reminder_log_store_date
  ON eod_reminder_log (store_id, local_date);

-- Optional: TTL-style cleanup. Uncomment to auto-prune rows older than 14 days
-- via pg_cron once that extension is enabled.
-- SELECT cron.schedule('eod-reminder-log-prune', '15 3 * * *',
--   $$ DELETE FROM eod_reminder_log WHERE sent_at < now() - interval '14 days' $$);
