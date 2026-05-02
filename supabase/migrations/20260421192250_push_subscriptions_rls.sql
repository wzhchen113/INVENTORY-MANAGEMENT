-- ============================================================
-- Fix: allow authenticated users to manage their own push_subscriptions
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run.
-- ============================================================

-- Make sure RLS is on (Supabase's default for new tables).
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Drop any pre-existing version of the policy so this is idempotent.
DROP POLICY IF EXISTS "users manage own push subscriptions" ON push_subscriptions;

-- Allow an authenticated user to INSERT / UPDATE / DELETE / SELECT
-- their own subscription rows (matched by user_id = auth.uid()).
-- The edge function uses the service_role key which bypasses RLS entirely,
-- so the cron's read-all + delete-stale path is unaffected.
CREATE POLICY "users manage own push subscriptions"
ON push_subscriptions
FOR ALL
TO authenticated
USING (user_id = auth.uid()::text)
WITH CHECK (user_id = auth.uid()::text);

-- Sanity check: returns the policy so you can confirm it's in place.
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'push_subscriptions';
