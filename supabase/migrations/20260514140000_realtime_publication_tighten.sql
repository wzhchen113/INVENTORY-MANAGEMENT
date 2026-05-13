-- ============================================================
-- Tighten the realtime publication from FOR ALL TABLES to an explicit
-- table list.
--
-- Background: the original local-dev publication setup
-- (20260502190000_realtime_publication.sql) used `for all tables`
-- because it was mirroring whatever prod had been bootstrapped into via
-- the Supabase Studio UI. That posture means every new table auto-joins
-- the publication whether it should or not — every spec since 016 has
-- carried this forward as a "deferred architectural cleanup" item.
--
-- This migration drops the broad publication and recreates it with the
-- explicit set of tables actually subscribed to today by
-- `src/hooks/useRealtimeSync.ts` and
-- `src/screens/cmd/sections/InventoryCountSection.tsx`. After this
-- migration, future tables that need realtime must be added explicitly
-- via `alter publication supabase_realtime add table public.<x>;` —
-- opt-in, not opt-out.
--
-- Subscribers today (audited 2026-05-13):
--   useRealtimeSync.ts → store-{id} channel:
--     • inventory_items     (filter store_id=eq.<id>)
--     • waste_log           (filter store_id=eq.<id>)
--     • eod_submissions     (filter store_id=eq.<id>)
--     • purchase_orders     (filter store_id=eq.<id>)
--   useRealtimeSync.ts → brand-{id} channel:
--     • recipes             (filter brand_id=eq.<id>)
--     • prep_recipes        (filter brand_id=eq.<id>)
--     • catalog_ingredients (filter brand_id=eq.<id>)
--     • vendors             (filter brand_id=eq.<id>)
--     • ingredient_conversions (global, no filter)
--   InventoryCountSection.tsx → store-{id}-inv-counts channel:
--     • inventory_counts    (filter store_id=eq.<id>)
--
-- Per the project's realtime publication gotcha (CLAUDE.md / MEMORY.md):
-- mid-session publication changes need
-- `docker restart supabase_realtime_imr-inventory` locally to
-- re-snapshot the replication slot. Prod's managed realtime handles
-- this automatically; clients reconnect their WebSocket and resume.
-- ============================================================

drop publication if exists supabase_realtime;
create publication supabase_realtime for table
  public.inventory_items,
  public.waste_log,
  public.eod_submissions,
  public.purchase_orders,
  public.inventory_counts,
  public.recipes,
  public.prep_recipes,
  public.catalog_ingredients,
  public.vendors,
  public.ingredient_conversions;
