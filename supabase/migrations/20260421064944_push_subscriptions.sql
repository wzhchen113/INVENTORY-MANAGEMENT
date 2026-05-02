-- ============================================================
-- Web Push subscriptions (Phase 2 of EOD reminder feature)
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run (uses IF NOT EXISTS).
-- ============================================================

-- One row per browser/device (endpoint is globally unique).
-- At cron time we join push_subscriptions → user_stores → stores
-- to decide who to notify for a given store's EOD deadline.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions (user_id);
