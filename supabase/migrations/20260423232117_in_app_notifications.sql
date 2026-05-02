-- ============================================================
-- Server-persisted in-app notifications (Phase 4 of EOD reminder)
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS in_app_notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  message    text NOT NULL,
  created_at timestamptz DEFAULT now(),
  read_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_in_app_notifications_user_unread
  ON in_app_notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_in_app_notifications_user_all
  ON in_app_notifications (user_id, created_at DESC);

ALTER TABLE in_app_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users manage own notifications" ON in_app_notifications;

-- Authenticated users see / mark-read / delete only their own rows.
-- The edge function uses service_role and bypasses RLS.
CREATE POLICY "users manage own notifications"
ON in_app_notifications
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());
