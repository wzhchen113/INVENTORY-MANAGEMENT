-- ============================================================
-- Per-vendor order cutoff + dedup log (Phase 5 — vendor reminders)
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run.
-- ============================================================

-- Admin-settable order cutoff on the vendor (HH:MM, store local time).
-- NULL = no reminder for this vendor.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS order_cutoff_time text;

-- Dedup log for the vendor-reminder cron path.
-- Kept separate from eod_reminder_log so uniqueness constraints stay simple.
CREATE TABLE IF NOT EXISTS vendor_reminder_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  store_id   uuid NOT NULL,
  vendor_id  uuid NOT NULL,
  local_date text NOT NULL,
  bucket     integer NOT NULL,
  sent_at    timestamptz DEFAULT now(),
  UNIQUE (user_id, store_id, vendor_id, local_date, bucket)
);

CREATE INDEX IF NOT EXISTS idx_vendor_reminder_log_store_vendor_date
  ON vendor_reminder_log (store_id, vendor_id, local_date);
