-- Per-user notifications kill switch.
-- When false, the eod-reminder-cron edge function skips this user for BOTH
-- web push AND email fallback (single toggle, both channels). Users can flip
-- it from the Profile sidebar in the app. Default true so existing accounts
-- keep their current behavior on rollout.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;
