-- ============================================================
-- Local-dev realtime publication setup.
-- Prod adds tables to supabase_realtime via the Supabase Studio UI;
-- that step never made it into a migration, so a fresh `supabase db
-- reset` locally produced an empty publication and useRealtimeSync
-- saw zero events. This migration mirrors the prod state by adding
-- every public table to the publication.
--
-- Safe to re-run: drops + recreates the publication. Edge functions
-- using service_role aren't subscribers, so dropping is harmless.
-- ============================================================

drop publication if exists supabase_realtime;
create publication supabase_realtime for all tables;
