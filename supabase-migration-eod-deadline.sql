-- ============================================================
-- EOD deadline time per store (Phase 1 of EOD reminder feature)
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run (uses IF NOT EXISTS).
-- ============================================================

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS eod_deadline_time text DEFAULT '22:00';

-- Backfill any existing NULL rows to the default so the app doesn't see nulls.
UPDATE stores SET eod_deadline_time = '22:00' WHERE eod_deadline_time IS NULL;
