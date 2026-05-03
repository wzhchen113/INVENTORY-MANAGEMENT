-- Phase 13a — staff-app integration via REST.
-- Adds client_uuid columns to eod_submissions + waste_log so staff-app
-- offline retries can be deduplicated at the DB level instead of by app
-- code. Each staff-side submission attempt generates a UUID locally; if
-- the request times out and retries, the same UUID arrives and the unique
-- index rejects the duplicate insert (the Edge Function returns 409 with
-- the existing row's id).
--
-- Backfill is unnecessary because:
--  - existing eod_submissions rows came from the admin app (no offline
--    retry path) and the (store_id, date) unique constraint already covers
--    their idempotency
--  - existing waste_log rows came from the admin app where the client
--    awaits the response before retrying — no duplicates expected
-- Future writes from the staff app populate client_uuid; admin writes
-- continue to leave it NULL.

ALTER TABLE public.eod_submissions
  ADD COLUMN IF NOT EXISTS client_uuid UUID;

ALTER TABLE public.waste_log
  ADD COLUMN IF NOT EXISTS client_uuid UUID;

-- Partial unique indexes — only enforce uniqueness when the column is set,
-- so legacy admin-side rows (NULL) coexist with staff-side rows.
CREATE UNIQUE INDEX IF NOT EXISTS eod_submissions_client_uuid_idx
  ON public.eod_submissions (client_uuid)
  WHERE client_uuid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS waste_log_client_uuid_idx
  ON public.waste_log (client_uuid)
  WHERE client_uuid IS NOT NULL;
