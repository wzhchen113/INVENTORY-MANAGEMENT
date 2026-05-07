-- ============================================================
-- Spec 004 — Add ingredient_conversions to the realtime publication
-- so the new conversions write UI shows live cross-client updates.
--
-- Idempotent: guarded by `if not exists` against pg_publication_tables.
-- Probe-confirmed on local DB 2026-05-07: the table is ALREADY a member
-- (legacy migration likely added it). The guard turns this into a no-op
-- there; on a fresh DB it adds the membership. Either way the runtime
-- result is the same.
--
-- Realtime publication-membership gotcha (CLAUDE.md):
--   After applying this migration to a running local stack, you MUST
--   `docker restart supabase_realtime_imr-inventory` for the realtime
--   slot to re-snapshot. Skipping that means realtime events for the
--   newly-added table are silently dropped until the next full restart.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'ingredient_conversions'
  ) then
    alter publication supabase_realtime add table public.ingredient_conversions;
    raise notice 'spec004: added ingredient_conversions to supabase_realtime';
  else
    raise notice 'spec004: ingredient_conversions already in supabase_realtime, skipping';
  end if;
end $$;
