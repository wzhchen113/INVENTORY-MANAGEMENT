-- ============================================================
-- Spec 103 — Per-user custom drag-to-reorder for the four count screens.
--
-- A manager or staff counter can hand-build the row order on a count screen
-- so it matches the path they physically walk their storeroom. The order is
-- PRIVATE per user (US-2), INDEPENDENT per screen (US-3), and per-vendor on
-- the two EOD surfaces (OQ-1). It is a VIEW concern only — it never changes
-- what a count submits (AC-9). No count RPC is touched by this migration.
--
-- STORAGE SHAPE (design §1): a side table, one row per
-- (user_id, screen, vendor_id), holding the order as a JSONB ordered array of
-- inventory_items.id strings (`item_ids`). NOT a profiles column (the staff
-- subtree never loads profiles, and a per-drop write would rewrite all four
-- screens' orders); NOT a row-per-item sort_index table (a drop would
-- renumber N rows). The array shape makes a drop a single-row UPSERT and makes
-- "apply the order" a pure client-side function (src/lib/countOrder.ts):
--   • ranked items (present in item_ids) render first, in item_ids order;
--   • unranked items (new / never-placed) append in the screen's default order
--     (OQ-3);
--   • item_ids referencing now-deleted items are ignored on apply.
--
-- ADDITIVE + NON-DESTRUCTIVE: a fresh table, no change to any existing table,
-- no backfill (orders are user-created at runtime; the 286 KB seed adds zero
-- rows). Instant in PG 17. Reversible-by-design (repo has no down-migration
-- convention): `drop table public.user_count_orders cascade;` fully removes it.
--
-- NO REALTIME PUBLICATION CHANGE (design §11): user_count_orders is a private
-- per-user view pref; it is NOT added to the supabase_realtime publication and
-- no channel (store-{id} / brand-{id}) replays it. The
-- `docker restart supabase_realtime_imr-inventory` ritual does NOT apply to
-- this migration (flagging the ABSENCE so the deploy checklist isn't padded).
--
-- PROD-APPLY (design §12; db-migrations-applied gate, spec 064): this repo
-- applies prod migrations via the Supabase MCP (project memory: "Prod schema
-- mirrored locally"; do not drift via dashboard SQL editor). The developer does
-- NOT push to prod — the prod-apply is flagged to the user in the handoff so
-- db-migrations-applied.yml stays green (a repo migration missing from prod's
-- schema_migrations hard-fails that gate).
--
-- ORDERING: 20260630000500 sorts AFTER the latest on disk
-- (20260630000400_drop_stale_staff_submit_eod_6arg.sql). It references only
-- pre-existing tables (public.profiles, public.vendors), so order is safe.
-- ============================================================

-- ─── Table ───────────────────────────────────────────────────
-- The order is owner-scoped, NOT store-scoped (design §2 / Project-specific
-- notes): a user's storeroom-walk order is theirs across the app, so there is
-- deliberately NO store_id column. RLS gates on the owning user, not the store.
--
-- screen: one of exactly four stable identifiers (OQ-7), CHECK-constrained.
--   admin-eod / staff-eod  → per-vendor (vendor_id NOT NULL).
--   admin-inventory / staff-weekly → per-surface (vendor_id NULL).
-- vendor_id is nullable precisely to carry that split in one table.
create table if not exists public.user_count_orders (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  screen     text not null
             check (screen in ('admin-eod','admin-inventory','staff-eod','staff-weekly')),
  -- NULL for admin-inventory / staff-weekly (per-surface).
  -- Non-null for admin-eod / staff-eod (per-vendor, OQ-1).
  vendor_id  uuid null references public.vendors(id) on delete cascade,
  -- Ordered, possibly-sparse list of inventory_items.id (as text). Apply is
  -- client-side (src/lib/countOrder.ts): rank by index here, append unranked in
  -- default order, ignore ids of now-deleted items.
  item_ids   jsonb not null default '[]'::jsonb
             check (jsonb_typeof(item_ids) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── Uniqueness (design §1.2 — the NULL-vendor gotcha) ────────
-- A composite PK (user_id, screen, vendor_id) would NOT enforce "one row per
-- (user, 'admin-inventory')": Postgres treats NULL as DISTINCT in unique
-- constraints, so two (uA, 'admin-inventory', NULL) rows would both be admitted
-- and `ON CONFLICT (user_id, screen, vendor_id)` would never fire for the
-- NULL-vendor branch (silently duplicating Inventory/Weekly orders). Resolve
-- with TWO PARTIAL UNIQUE INDEXES — one for the vendor branch, one for the
-- no-vendor branch (the latter treats the absent vendor as the uniqueness key):
--   • vendor branch → conflict target (user_id, screen, vendor_id);
--   • no-vendor branch → conflict target (user_id, screen).
-- The two db.ts write helpers branch their upsert onConflict on vendor presence
-- to match these targets (design §5.2). There is intentionally NO PK — the two
-- partial indexes ARE the uniqueness contract, and a PK cannot treat NULLs as
-- equal.
create unique index if not exists user_count_orders_vendor_uq
  on public.user_count_orders (user_id, screen, vendor_id)
  where vendor_id is not null;

create unique index if not exists user_count_orders_novendor_uq
  on public.user_count_orders (user_id, screen)
  where vendor_id is null;

-- The two partial unique indexes fully cover the only read pattern
-- (where user_id = auth.uid() and screen = $1 [and vendor_id = $2 / is null]).
-- No separate index needed (design §1.3).

-- ─── Grants (spec-097 silent-grant-revocation class, defense-in-depth) ──
-- 20260618000000_public_grants_explicit.sql set `ALTER DEFAULT PRIVILEGES FOR
-- ROLE postgres … GRANT … ON tables TO anon, authenticated` (no-TRUNCATE list)
-- + `… TO service_role` (ALL), so a postgres-owned table created by THIS
-- migration inherits those grants automatically. We re-state them explicitly
-- anyway (matching 20260630000000_item_vendors): it is idempotent (a harmless
-- re-grant), documents the intended ACL at the table's birth, and is robust
-- against a future migration-ordering or CLI-image change that strands a newly
-- created table — the exact class spec 097 durably fixed. TRUNCATE is
-- deliberately OMITTED for anon/authenticated (the anti-escalation baseline);
-- service_role keeps ALL.
grant select, insert, update, delete, references, trigger
  on public.user_count_orders to anon, authenticated;
grant all on public.user_count_orders to service_role;

-- ─── RLS — owner-scoped (design §2; AC-1) ────────────────────
-- The owner predicate is `auth.uid() = user_id` — the same shape as `flags`
-- ("Read own flags") and `push_subscriptions` ("users manage own push
-- subscriptions"). It is OWNER-scoped, not store-scoped: these rows are not
-- store-scoped, so do NOT use auth_can_see_store() (wrong axis); and staff write
-- them too, so do NOT use auth_is_admin() (wrong gate). There is intentionally
-- NO admin / super_admin bypass — a privileged user does NOT get to read
-- another user's private order (US-2; the pgTAP suite asserts this).
--
-- spec-053 permissive-policy lint stays green: `auth.uid() = user_id`
-- references the owning column, so it is NOT trivially-wide (it is not
-- `auth.uid() IS NOT NULL` / `true` / `auth.role() = 'authenticated'`), and
-- there is no OR-tail. No allowlist entry is required or added. Each policy is a
-- SINGLE permissive policy per command with the owner predicate as the WHOLE
-- clause — no `auth.uid() IS NOT NULL` arm that would shadow the owner scope via
-- the OR-compose rule (CLAUDE.md "Permissive RLS policies … are ORed").
alter table public.user_count_orders enable row level security;

drop policy if exists "Users read own count orders" on public.user_count_orders;
create policy "Users read own count orders"
  on public.user_count_orders for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own count orders" on public.user_count_orders;
create policy "Users insert own count orders"
  on public.user_count_orders for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own count orders" on public.user_count_orders;
create policy "Users update own count orders"
  on public.user_count_orders for update
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own count orders" on public.user_count_orders;
create policy "Users delete own count orders"
  on public.user_count_orders for delete
  using (auth.uid() = user_id);

comment on table public.user_count_orders is
  'spec 103: per-user PRIVATE custom row order for the four count screens (admin-eod, admin-inventory, staff-eod, staff-weekly). One row per (user_id, screen, vendor_id); item_ids is a JSONB ordered array of inventory_items.id. EOD surfaces are per-vendor (vendor_id non-null); Inventory/Weekly are per-surface (vendor_id NULL). VIEW concern only — never changes submission scope. Owner-scoped RLS (auth.uid() = user_id), no admin/super_admin bypass. Not in the supabase_realtime publication.';
