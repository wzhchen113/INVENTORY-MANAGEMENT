-- ============================================================
-- Spec 106 — Save (draft) an unfinished count and resume later.
--
-- A manager (admin Inventory count) or a staff counter (Weekly count) can Save
-- their in-progress entries mid-count and resume later with the values
-- restored. The draft is a PRIVATE, single-author, resumable-scratch row per
-- (user_id, screen, store_id) — it is NEVER an advisory snapshot: saving a
-- draft does NOT write current_stock / inventory_items and does NOT create an
-- inventory_counts / weekly-count history row (AC-9). Only Submit mutates state
-- and produces the historical count row (unchanged from today). This migration
-- touches no count RPC.
--
-- STORAGE SHAPE (design §2): a side table, one row per (user_id, screen,
-- store_id), holding the full resumable in-progress state as an opaque JSONB
-- `payload` (per-item case/unit strings + item notes + admin-Inventory header
-- state — the shape is screen-specific and owned by the pure serializers in
-- src/lib/countDrafts.ts; the DB never introspects it). Every draft carries a
-- CLIENT-stamped `saved_at` — the whole-draft last-write-wins comparison key
-- (AC-15/16). NOT a profiles column; NOT overloading eod_submissions
-- (status='draft' is deliberately NOT repurposed — spec §"Out of scope").
--
-- ADDITIVE + NON-DESTRUCTIVE: a fresh table, no change to any existing table,
-- no backfill (drafts are user-created at runtime; the 286 KB seed adds zero
-- rows). Instant in PG 17. Reversible-by-design (repo has no down-migration
-- convention): `drop table public.user_count_drafts cascade;` fully removes it.
--
-- NO REALTIME PUBLICATION CHANGE (design §10): user_count_drafts is a private
-- single-author scratch; it is NOT added to the supabase_realtime publication
-- and no channel (store-{id} / brand-{id}) replays it (matching
-- user_count_orders, spec 103). The `docker restart
-- supabase_realtime_imr-inventory` ritual does NOT apply to this migration
-- (flagging the ABSENCE so the deploy checklist isn't padded). Cross-device
-- visibility (AC-17) comes from the server being the source of truth once
-- synced + the screen-open fetch on the other device, NOT realtime push.
--
-- PROD-APPLY (design §2 / §12; db-migrations-applied gate, spec 064): this repo
-- applies prod migrations via the Supabase MCP (project memory: "Prod migration
-- via Supabase MCP"; do not drift via dashboard SQL editor). The developer does
-- NOT `supabase db push` (no prod password) — the prod-apply is flagged to the
-- user in the handoff so db-migrations-applied.yml stays green (a repo
-- migration missing from prod's schema_migrations hard-fails that gate).
--
-- ORDERING (design §12): 20260703000000 sorts AFTER the latest on disk
-- (20260702000000_report_reorder_for_counted_onhand.sql). It references only
-- pre-existing tables (public.profiles, public.stores), so order is safe.
-- ============================================================

-- ─── Table (design §2) ───────────────────────────────────────
-- The draft slot is keyed by (user_id, screen, store_id) — store_id is part of
-- the identity so a manager's Store A draft is distinct from their Store B
-- draft (design "Per-store" note). RLS gates on the OWNING USER, not the store
-- (owner-scoped, not store-scoped): the row belongs to its author; the store is
-- a KEY FIELD, not the access axis.
--
-- screen: the two v1 non-vendor keys already defined by CountOrderScreen in
--   src/lib/countOrder.ts and the user_count_orders CHECK. The EOD follow-up
--   (out of scope here) will add 'admin-eod' / 'staff-eod' + a nullable
--   vendor_id ADDITIVELY — this CHECK lists only the two live keys so an EOD
--   draft can't be written before that table shape exists, but the key STRINGS
--   are the same stable vocabulary, so the follow-up is a CHECK-widen +
--   column-add, never a rename (design §1).
create table if not exists public.user_count_drafts (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  screen     text not null
             check (screen in ('admin-inventory','staff-weekly')),
  store_id   uuid not null references public.stores(id) on delete cascade,
  -- Full resumable in-progress state. Shape is screen-specific (design §3); the
  -- DB stores it opaquely as jsonb and never introspects it. NOT NULL, default
  -- '{}' so a row always round-trips to a valid (if empty) form. The CHECK
  -- rejects a non-object (defense-in-depth; the FE serializer always emits an
  -- object).
  payload    jsonb not null default '{}'::jsonb
             check (jsonb_typeof(payload) = 'object'),
  -- CLIENT-stamped at Save time (new Date().toISOString()). The
  -- last-write-wins comparison key (AC-15/16). Compared local-candidate vs
  -- server-candidate ONLY, NEVER against now(). See design §11 clock-skew
  -- caveat: wall-clock skew across a single user's own devices is an accepted
  -- v1 limitation for a private scratch.
  saved_at   timestamptz not null,
  -- SERVER-defaulted audit columns. NOT the reconcile key — the reconcile
  -- logic MUST NOT read updated_at (design §0.3). Present for
  -- debugging / a future TTL sweep (out of scope in v1).
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Single slot per (user, screen, store): a FULL unique constraint. All three
  -- columns are NOT NULL, so there is NO NULL-distinctness gotcha (unlike spec
  -- 103's two PARTIAL indexes, which forced a delete-then-insert because a
  -- partial index cannot be an ON CONFLICT target). This FULL constraint IS a
  -- valid ON CONFLICT target, so the persist is a plain
  -- `.upsert({ onConflict: 'user_id,screen,store_id' })` — the deliberate
  -- divergence from spec 103 (design §0.4 / §4).
  constraint user_count_drafts_slot_uq unique (user_id, screen, store_id)
);

-- ─── Indexes (design §2) ─────────────────────────────────────
-- The unique constraint's backing index (user_id, screen, store_id) fully
-- covers the only read pattern
-- (where user_id = auth.uid() and screen = $1 and store_id = $2). No separate
-- index is needed. Do NOT add a saved_at index — no query orders by it
-- (reconcile compares two single rows in the client).

-- ─── Grants (spec-097 silent-grant-revocation class, defense-in-depth) ──
-- 20260618000000_public_grants_explicit.sql set `ALTER DEFAULT PRIVILEGES FOR
-- ROLE postgres … GRANT … ON tables TO anon, authenticated` (no-TRUNCATE list)
-- + `… TO service_role` (ALL), so a postgres-owned table created by THIS
-- migration inherits those grants automatically. We re-state them explicitly
-- anyway (matching 20260630000000_item_vendors and
-- 20260630000500_user_count_orders): it is idempotent (a harmless re-grant),
-- documents the intended ACL at the table's birth, and is robust against a
-- future migration-ordering or CLI-image change that strands a newly created
-- table — the exact class spec 097 durably fixed. TRUNCATE is deliberately
-- OMITTED for anon/authenticated (the anti-escalation baseline); service_role
-- keeps ALL.
--
-- This table HOLDS the SELECT grant, so it is NOT added to the
-- public_grants_explicit pgTAP allowlist (design §11): that allowlist is ONLY
-- for tables that deliberately REVOKE a grant (Category A — the two audit
-- tables). The probe's POSITIVE arm (arm 1) asserts this new public base
-- table's grant automatically — adding an allowlist row would WRONGLY stop
-- asserting the grant.
grant select, insert, update, delete, references, trigger
  on public.user_count_drafts to anon, authenticated;
grant all on public.user_count_drafts to service_role;

-- ─── RLS — owner-scoped (design §2 / §11; AC-10) ─────────────
-- The owner predicate is `auth.uid() = user_id` — the same shape as `flags`
-- ("Read own flags"), `push_subscriptions`, and user_count_orders (spec 103).
-- It is OWNER-scoped, not store-scoped: these rows are not store-scoped, so do
-- NOT use auth_can_see_store() (wrong axis — the row belongs to the user, the
-- store is a key field); and STAFF write these too, so do NOT use
-- auth_is_admin() (wrong gate). There is intentionally NO admin / super_admin
-- bypass — a privileged user does NOT get to read, resume, overwrite, or delete
-- another user's private draft (AC-10; the pgTAP suite asserts this, including
-- a super_admin JWT).
--
-- spec-053 permissive-policy lint stays green: `auth.uid() = user_id`
-- references the owning column, so it is NOT trivially-wide (not
-- `auth.uid() IS NOT NULL` / `true` / `auth.role() = 'authenticated'`), and
-- there is no OR-tail. No allowlist entry is required or added. Each policy is a
-- SINGLE permissive policy per command with the owner predicate as the WHOLE
-- clause — no `auth.uid() IS NOT NULL` arm that would shadow the owner scope via
-- the OR-compose rule (CLAUDE.md "Permissive RLS policies … are ORed").
alter table public.user_count_drafts enable row level security;

drop policy if exists "Users read own count drafts" on public.user_count_drafts;
create policy "Users read own count drafts"
  on public.user_count_drafts for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own count drafts" on public.user_count_drafts;
create policy "Users insert own count drafts"
  on public.user_count_drafts for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own count drafts" on public.user_count_drafts;
create policy "Users update own count drafts"
  on public.user_count_drafts for update
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own count drafts" on public.user_count_drafts;
create policy "Users delete own count drafts"
  on public.user_count_drafts for delete
  using (auth.uid() = user_id);

comment on table public.user_count_drafts is
  'spec 106: per-user PRIVATE resumable draft for the two count screens (admin-inventory, staff-weekly). One row per (user_id, screen, store_id) enforced by a FULL unique constraint (valid ON CONFLICT target → plain upsert). payload is opaque JSONB (per-item case/unit strings + item notes + admin-Inventory header state, shape owned by src/lib/countDrafts.ts); saved_at is CLIENT-stamped and is the whole-draft last-write-wins key (never compared against now()); updated_at is a server-defaulted audit column the reconcile logic must not read. Resumable scratch only — never mutates current_stock and never produces a history row (AC-9). Owner-scoped RLS (auth.uid() = user_id), no admin/super_admin bypass. Not in the supabase_realtime publication.';
