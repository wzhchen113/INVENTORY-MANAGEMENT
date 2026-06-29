-- ============================================================
-- Spec 102 — Multi-vendor ingredients: the `item_vendors` junction.
--
-- Today an inventory item links to exactly ONE vendor via the scalar
-- `inventory_items.vendor_id`. Managers want a single ingredient
-- orderable from N vendors, each with its OWN per-vendor cost, while the
-- physical on-hand stays a single shared quantity per item.
--
-- This migration is ADDITIVE and NON-DESTRUCTIVE. Per the architect's
-- OQ-2 / OQ-5 resolutions, `inventory_items.vendor_id`,
-- `inventory_items.cost_per_unit`, and `inventory_items.case_price` are
-- ALL kept:
--   • vendor_id stays the single source of truth for "which link is
--     primary" (SD-1). The junction's `is_primary` boolean is a DERIVED
--     MIRROR of the scalar, kept consistent by the db.ts create/update
--     helpers (they set exactly one is_primary=true row matching
--     vendor_id). A partial unique index enforces ≤1 primary per item
--     defensively. Reorder/EOD logic does NOT read is_primary — it
--     explodes by SCHEDULE, not by primary (OQ-1). The boolean exists for
--     the editor UI and future "primary wins" features.
--   • cost_per_unit / case_price on inventory_items stay the COGS /
--     variance fallback (OQ-5 additive). The junction's per-(item,vendor)
--     cost is what the reorder RPC reads, FALLING BACK to the item cost
--     when the junction cost is null/0.
--
-- Reversible-by-design (repo has no down-migration convention): a single
-- `drop table public.item_vendors cascade;` returns the system to exactly
-- single-vendor behavior — vendor_id was never dropped, so no data
-- reconstruction is needed.
--
-- REALTIME PUBLICATION GOTCHA (deploy/dev step, NOT runtime): this
-- migration ADDS public.item_vendors to the supabase_realtime publication
-- so item↔vendor link / per-vendor cost edits reach other admin clients
-- live (the store-{id} channel, debounced 400ms reload in
-- useRealtimeSync.ts). Per the documented project gotcha (CLAUDE.md /
-- MEMORY.md "Realtime publication gotcha"), adding a table to the
-- publication mid-session requires
--   docker restart supabase_realtime_imr-inventory
-- AFTER `npm run dev:db` locally, or the replication slot does not
-- re-snapshot its table set and item_vendors realtime events are silently
-- dropped until a full restart. Prod's managed realtime handles this
-- automatically on the next reconnect. The hook lists subscribed tables
-- EXPLICITLY (not a wildcard), so useRealtimeSync.ts also gains an
-- item_vendors subscription line (frontend wiring, same spec).
--
-- Migration ordering: this file (…000000) sorts BEFORE the three RPC
-- migrations that depend on the table existing:
--   …000100 report_reorder_list rewrite (explode by junction)
--   …000200 staff_submit_eod predicate swap (membership write)
--   …000300 report_weekly_lowstock (new advisory RPC)
-- ============================================================

-- ─── Table ───────────────────────────────────────────────────
-- Store scoping is TRANSITIVE via item_id → inventory_items.store_id.
-- No redundant store_id column: inventory_items is the existing per-store
-- anchor (already RLS-gated by store), a denormalized store_id would need
-- a trigger or app-discipline to stay consistent and is pure drift
-- surface, and the RLS policies (below) join to inventory_items exactly
-- as the existing child-table policies do for eod_entries / po_items
-- (the per-store-RLS-hardening pattern, 20260504173035).
create table if not exists public.item_vendors (
  id            uuid primary key default uuid_generate_v4(),
  item_id       uuid not null references public.inventory_items(id) on delete cascade,
  vendor_id     uuid not null references public.vendors(id)         on delete cascade,
  cost_per_unit numeric(10,2) default 0,   -- per-(item,vendor) cost (OQ-5 additive)
  case_price    numeric(10,2) default 0,   -- per-(item,vendor) case price
  is_primary    boolean not null default false,  -- SD-1: derived mirror of inventory_items.vendor_id
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Editor dup-guard backstop (AC-C "prevents attaching the same vendor
  -- twice"). Also the on-conflict target for the idempotent backfill +
  -- the db.ts upsert reconciliation.
  constraint item_vendors_item_vendor_unique unique (item_id, vendor_id)
);

-- Reorder / EOD lookup paths: "all vendors for this item" and "all items
-- for this vendor". Both are hot in the explode / fetch joins.
create index if not exists item_vendors_item_id_idx   on public.item_vendors (item_id);
create index if not exists item_vendors_vendor_id_idx on public.item_vendors (vendor_id);

-- SD-1 enforcement: at most one primary link per item. Partial unique
-- index — only rows with is_primary = true participate.
create unique index if not exists item_vendors_one_primary_per_item
  on public.item_vendors (item_id) where is_primary;

-- ─── Grants (spec-097 silent-grant-revocation class, defense-in-depth) ──
-- The 20260618000000_public_grants_explicit.sql migration set
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres … GRANT … ON tables TO
-- anon, authenticated` (no-TRUNCATE list) + `… TO service_role` (ALL), so
-- a postgres-owned table created by THIS migration inherits those grants
-- automatically. We re-state the grants explicitly anyway: it is
-- idempotent (a harmless re-grant), it documents the intended ACL at the
-- table's birth, and it is robust against a future migration-ordering or
-- CLI-image change that strands a newly created table (the exact class of
-- bug spec 097 was written to durably fix). TRUNCATE is deliberately
-- OMITTED for anon/authenticated, matching the project's net-effective
-- posture (the anti-escalation baseline); service_role keeps ALL.
grant select, insert, update, delete, references, trigger
  on public.item_vendors to anon, authenticated;
grant all on public.item_vendors to service_role;

-- ─── RLS — mirrors inventory_items, store-scoped via the parent join ──
-- item_vendors has no store_id, so each policy joins to inventory_items
-- and gates on auth_can_see_store(ii.store_id) — identical shape to the
-- eod_entries / po_items child-table policies in
-- 20260504173035_per_store_rls_hardening.sql. All four commands.
--
-- Privileged paths are covered automatically: auth_can_see_store()
-- already returns true for admins/masters via auth_is_admin() (it is
-- `auth_is_admin() OR exists(user_stores …)`). No separate admin policy is
-- needed — consistent with inventory_items itself (no standalone admin
-- policy on that table either).
--
-- spec-053 permissive-policy lint stays green (AC-B): none of these four
-- policies is trivially-wide. Each USING/WITH CHECK is an
-- `exists(… and auth_can_see_store(…))` — the helper call is the head
-- token (not auth.uid() IS NOT NULL / true / auth.role()='authenticated'),
-- and there is no OR-tail. No allowlist entry is required or added.
alter table public.item_vendors enable row level security;

create policy "store_member_read_item_vendors" on public.item_vendors for select
  using (exists (select 1 from public.inventory_items ii
                  where ii.id = item_vendors.item_id
                    and public.auth_can_see_store(ii.store_id)));

create policy "store_member_insert_item_vendors" on public.item_vendors for insert
  with check (exists (select 1 from public.inventory_items ii
                       where ii.id = item_vendors.item_id
                         and public.auth_can_see_store(ii.store_id)));

create policy "store_member_update_item_vendors" on public.item_vendors for update
  using      (exists (select 1 from public.inventory_items ii
                       where ii.id = item_vendors.item_id
                         and public.auth_can_see_store(ii.store_id)))
  with check (exists (select 1 from public.inventory_items ii
                       where ii.id = item_vendors.item_id
                         and public.auth_can_see_store(ii.store_id)));

create policy "store_member_delete_item_vendors" on public.item_vendors for delete
  using (exists (select 1 from public.inventory_items ii
                  where ii.id = item_vendors.item_id
                    and public.auth_can_see_store(ii.store_id)));

-- ─── Backfill (idempotent, reversible-by-design) ─────────────
-- Each item with a non-null vendor_id produces exactly ONE link row
-- carrying that item's CURRENT cost_per_unit + case_price as the
-- per-vendor cost, marked is_primary = true (it IS the scalar's vendor).
-- AC-A: item count + total cost unchanged immediately after migration.
--   • Items with vendor_id IS NULL produce ZERO rows (the WHERE excludes
--     them) — they stay absent from vendor tabs and reorder cards.
--   • Idempotent: `on conflict (item_id, vendor_id) do nothing` on the
--     composite unique → re-running the migration (or just this DML) does
--     NOT duplicate link rows (AC-A re-run requirement). Re-running the
--     whole file is a no-op: create table/index IF NOT EXISTS + conflict-
--     skipped insert. (The CREATE POLICY statements above are not
--     IF-NOT-EXISTS guarded — Postgres lacks that form — but `supabase db
--     push` applies each migration exactly once via schema_migrations, so
--     a second push is a no-op; a manual re-apply of just this file would
--     error on the policies, which is the intended "already applied"
--     signal, not a data-duplication risk.)
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select ii.id, ii.vendor_id,
       coalesce(ii.cost_per_unit, 0), coalesce(ii.case_price, 0), true
  from public.inventory_items ii
 where ii.vendor_id is not null
on conflict (item_id, vendor_id) do nothing;

-- ─── Realtime publication membership ─────────────────────────
-- The publication is an EXPLICIT table list (20260514140000 tightened it
-- from FOR ALL TABLES), so item_vendors must be added by name. See the
-- container-restart gotcha in the header.
alter publication supabase_realtime add table public.item_vendors;

comment on table public.item_vendors is
  'spec 102: many-to-many inventory_items↔vendors with per-(item,vendor) cost_per_unit + case_price. Shared on-hand stays on inventory_items (one physical quantity per item); only COST is per-vendor. is_primary is a derived mirror of inventory_items.vendor_id (SD-1); reorder/EOD explode by schedule, not by is_primary. Store-scoped via item_id → inventory_items.store_id; RLS mirrors inventory_items child-table policies.';
