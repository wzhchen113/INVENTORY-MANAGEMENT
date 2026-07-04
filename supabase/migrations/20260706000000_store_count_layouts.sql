-- ============================================================
-- Spec 110 — Named, store-SHARED weekly-count layouts.
--
-- Replaces the spec-103 per-user, private, auto-saved custom order on the two
-- WEEKLY count surfaces ONLY (admin "Weekly count" section = 'admin-inventory';
-- staff Weekly = 'staff-weekly') with up to THREE named, store-SHARED layouts.
-- The two EOD surfaces ('admin-eod', 'staff-eod') keep their spec-103 per-user
-- per-vendor auto-saved order UNCHANGED (R-1) — this migration does NOT touch
-- their rows.
--
-- OWNER RULINGS threaded through the design (§0–§4):
--   • R-2 / AC-3  — layouts are SHARED per STORE: any member who can see the
--                   store (auth_can_see_store) — staff OR admin — may READ/PICK.
--   • OQ-1 / AC-3b — only privileged callers (auth_is_privileged = admin OR
--                   super_admin OR master) may CREATE / RENAME / DELETE. The
--                   write gate is SERVER-SIDE (RLS + the SECURITY DEFINER RPCs),
--                   NOT UI hiding — a direct PostgREST/RPC write from a staff
--                   session is refused.
--   • AC-2 / OQ-6 — at most 3 layouts per store, enforced atomically server-side
--                   (advisory-locked count+insert in the create RPC) AND
--                   structurally (unique (store_id, position) + position 1..3).
--   • OQ-3 / AC-7 — concurrency is whole-row LAST-WRITE-WINS by updated_at (no
--                   field merge, no conflict UI, no optimistic version check).
--   • OQ-4 / AC-13 — the migration DELETEs the stale Weekly user_count_orders
--                   rows (start fresh); the EOD rows are left intact.
--   • OQ-5 / §7   — the table is NOT added to the supabase_realtime publication.
--
-- MECHANISM (design §0, resolving OQ-6): READS go through PostgREST on the table
-- (RLS SELECT gate = auth_can_see_store). WRITES go through three SECURITY
-- DEFINER RPCs (save / rename / delete) that co-locate the role gate, the store
-- gate, and the atomic 3-cap. The table ALSO carries privileged-gated RLS write
-- policies as defense-in-depth (AC-3b requires a direct PostgREST write to fail)
-- — the RPCs are the authoritative path; the RLS write policies are belt-and-
-- braces. Same "RPC gate + parallel RLS gate" shape as staff_submit_eod
-- (spec 061) and demote_profile_to_user (spec 050).
--
-- ADDITIVE except for one hunk: the table + indexes + 4 policies + 3 functions +
-- grants are purely additive (fresh table). The ONLY non-additive statement is
-- the bounded AC-13 cleanup DELETE on public.user_count_orders (§3), scoped
-- `WHERE screen IN ('admin-inventory','staff-weekly')` — it cannot touch the two
-- EOD families or any other table. Instant in PG 17 (no backfill; layouts are
-- authored at runtime, the 286 KB seed adds zero layout rows).
-- Reversible-by-design (repo has no down-migration convention):
--   drop table public.store_count_layouts cascade;
--   drop function public.save_store_count_layout(uuid, text, jsonb, uuid);
--   drop function public.rename_store_count_layout(uuid, text);
--   drop function public.delete_store_count_layout(uuid);
--
-- NO REALTIME PUBLICATION CHANGE (§7): this migration makes ZERO
-- `alter publication supabase_realtime add table ...` change, so the mid-session
-- `docker restart supabase_realtime_imr-inventory` ritual does NOT apply here —
-- there is nothing to re-snapshot. Flagged as an ABSENCE so the deploy checklist
-- is not padded. Other clients pick up a new/renamed/deleted layout on their next
-- screen open / fetch (same posture as user_count_orders, spec 103).
--
-- PROD-APPLY (§12; db-migrations-applied gate, spec 064): this repo applies prod
-- migrations via the Supabase MCP (project memory "Prod migration via Supabase
-- MCP" — `supabase db push` lacks the prod password). This migration is NOT
-- body-only (table + indexes + 4 policies + 3 functions + grants + a DELETE), so
-- the post-apply verification is broader than the normalized-md5 check (see §12).
-- The developer does NOT push to prod — the prod-apply is flagged to the user in
-- the handoff so db-migrations-applied.yml stays green.
--
-- ORDERING: 20260706000000 sorts AFTER the latest on disk
-- (20260705000000_cost_on_receipt.sql). References only pre-existing
-- public.stores + public.profiles + public.user_count_orders, so ordering is
-- safe. (VERSION NOTE: the design draft named 20260704000000, but that version
-- is TAKEN by po_loop and 20260705000000 by cost_on_receipt — both already in
-- prod — so this migration uses 20260706000000.)
-- ============================================================

-- ─── Table ───────────────────────────────────────────────────
-- Store-SCOPED and SHARED (design §1): store_id is the access axis (SELECT RLS +
-- write gate). created_by records attribution only — it does NOT gate access
-- (any privileged member edits any of the store's layouts). There is
-- deliberately NO vendor_id column: Weekly is vendor-less (R-1), and ONE shared
-- set serves both Weekly surfaces (AC-2). Do NOT use auth.uid() = user_id — these
-- are shared, not owner-private (that was the spec-103 model, deliberately
-- diverged from here).
create table if not exists public.store_count_layouts (
  -- surface identity for rename/delete/overwrite targeting.
  id         uuid primary key default gen_random_uuid(),
  -- the access axis (SELECT RLS + write gate). Cascade so deleting a store
  -- cleans its layouts.
  store_id   uuid not null references public.stores(id) on delete cascade,
  -- display label. Trimmed length 1..60 rejects empty/whitespace-only and
  -- overlong (AC name validation); the save/rename RPCs also btrim + re-check.
  name       text not null
             check (length(btrim(name)) between 1 and 60),
  -- spec-103 shape: ordered array of inventory_items.id (as text). Applied
  -- client-side by the pure applyCountOrder (deleted-id tolerant).
  item_ids   jsonb not null default '[]'::jsonb
             check (jsonb_typeof(item_ids) = 'array'),
  -- slot 1..3: the deterministic pill order (order by position) + the
  -- uniqueness lever for the structural cap ceiling. Internal ordering key, NOT
  -- user-facing slot naming — `name` carries the label. The create RPC picks the
  -- lowest free slot inside the advisory-locked section.
  position   smallint not null
             check (position between 1 and 3),
  -- attribution only — does NOT gate access. set null so deleting the author
  -- profile does not delete the shared layout.
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  -- last-write-wins key (OQ-3 / AC-7). The RPCs set it explicitly on every
  -- overwrite / rename.
  updated_at timestamptz not null default now()
);

-- ─── Uniqueness / structural cap ceiling (design §1.1) ───────
-- One layout per (store, slot). With the `position between 1 and 3` CHECK this
-- caps a store at 3 rows STRUCTURALLY (belt-and-braces to the RPC's atomic
-- count): a 4th DISTINCT slot violates the CHECK, a duplicate slot violates this
-- index. The leading store_id column also fully covers the read path
-- (`where store_id = $1 order by position`), so NO separate read index is needed
-- (same reasoning as spec 103 §1.3).
--
-- Deliberately NO unique on (store_id, name) — per-store name uniqueness is NOT
-- enforced at the DB level (design §1 / OQ-A default): two layouts may share a
-- name (picked by id, ordered by position); a hard name-unique constraint would
-- turn the overwrite-vs-new affordance into an opaque 23505 instead of the
-- intended last-write-wins.
create unique index if not exists store_count_layouts_store_position_uq
  on public.store_count_layouts (store_id, position);

-- ─── Grants (spec-097 explicit-grant posture, defense-in-depth) ──
-- 20260618000000_public_grants_explicit.sql set ALTER DEFAULT PRIVILEGES FOR
-- ROLE postgres … GRANT … ON tables TO anon, authenticated (no-TRUNCATE list) +
-- … TO service_role (ALL), so a postgres-owned table created here inherits those
-- grants automatically. Re-state them explicitly anyway (matching
-- user_count_orders / item_vendors): idempotent, documents the intended ACL at
-- the table's birth, and is robust against a future migration-ordering or
-- CLI-image change that strands a newly created table (the exact class spec 097
-- durably fixed). The direct INSERT/UPDATE/DELETE grants to authenticated are
-- harmless — RLS still gates them to privileged callers (grants are
-- necessary-not-sufficient). TRUNCATE is deliberately OMITTED for
-- anon/authenticated; service_role keeps ALL.
grant select, insert, update, delete, references, trigger
  on public.store_count_layouts to anon, authenticated;
grant all on public.store_count_layouts to service_role;

-- ─── RLS (design §2) ─────────────────────────────────────────
-- Four policies, each a SINGLE permissive policy per command with NO
-- `auth.uid() IS NOT NULL` OR-arm (the CLAUDE.md OR-compose / permissive-shadow
-- discipline — a trivially-wide arm would shadow the scoped predicate). The
-- SELECT gate is auth_can_see_store() ONLY (staff members read/pick, AC-3); the
-- write gates AND auth_is_privileged() on top of the store gate (OQ-1 / AC-3b).
--
-- spec-053 permissive-policy lint stays green with NO allowlist edit: every
-- predicate references auth_can_see_store(store_id) / auth_is_privileged(),
-- neither of which is trivially-wide (auth.uid() IS NOT NULL / true /
-- auth.role() = 'authenticated'), and there is no OR-tail. The SELECT policy is
-- the identical shape to the inventory_items SELECT policy the probe already
-- tolerates. No pre-existing permissive policy on this brand-new table → no
-- OR-shadow risk from a legacy wide policy on the same (table, cmd) pair.
alter table public.store_count_layouts enable row level security;

drop policy if exists store_member_read_count_layouts on public.store_count_layouts;
create policy store_member_read_count_layouts
  on public.store_count_layouts for select
  using (public.auth_can_see_store(store_id));

drop policy if exists privileged_insert_count_layouts on public.store_count_layouts;
create policy privileged_insert_count_layouts
  on public.store_count_layouts for insert
  with check (public.auth_is_privileged() and public.auth_can_see_store(store_id));

drop policy if exists privileged_update_count_layouts on public.store_count_layouts;
create policy privileged_update_count_layouts
  on public.store_count_layouts for update
  using      (public.auth_is_privileged() and public.auth_can_see_store(store_id))
  with check (public.auth_is_privileged() and public.auth_can_see_store(store_id));

drop policy if exists privileged_delete_count_layouts on public.store_count_layouts;
create policy privileged_delete_count_layouts
  on public.store_count_layouts for delete
  using (public.auth_is_privileged() and public.auth_can_see_store(store_id));

comment on table public.store_count_layouts is
  'spec 110: named, store-SHARED weekly-count layouts (<=3 per store, one shared set for both Weekly surfaces). store_id is the access axis; SELECT via auth_can_see_store() (any member reads/picks), INSERT/UPDATE/DELETE additionally gated on auth_is_privileged() (OQ-1). item_ids is a JSONB ordered array of inventory_items.id; position is the 1..3 pill slot. Writes go through the save/rename/delete SECURITY DEFINER RPCs (atomic 3-cap); the RLS write policies are defense-in-depth. Last-write-wins by updated_at. Not in the supabase_realtime publication.';

-- ═══════════════════════════════════════════════════════════════
-- RPCs (design §4). Error mapping follows the codebase convention (matching
-- demote_profile_to_user, spec 050):
--   P0001 — plpgsql `raise exception`; PostgREST maps to HTTP 400. Used for
--           name validation, bad item_ids, and the 4th-create refusal.
--   42501 — insufficient_privilege; PostgREST maps to HTTP 403. Used for the
--           null-caller / role / store gates.
--   P0002 — no_data_found; PostgREST maps to HTTP 404. Used for a
--           missing/overwrite/rename/delete target id.
-- All three are `security definer set search_path = public, auth` so they bypass
-- RLS and the inline auth_is_privileged() / auth_can_see_store() checks are the
-- authorization source of truth (same shape as demote_profile_to_user). EXECUTE
-- is revoked from public/anon and granted to authenticated only (no
-- service_role; auth.uid() is null for it and step 1 fail-closes).
-- ═══════════════════════════════════════════════════════════════

-- ─── save_store_count_layout — create OR overwrite (AC-4 / AC-5 / OQ-6 cap) ──
-- p_layout_id null → CREATE (server assigns the lowest free slot, atomic 3-cap);
-- non-null → OVERWRITE that row's name + item_ids (keeps its slot; last-write-
-- wins). Returns the created/overwritten layout id.
create or replace function public.save_store_count_layout(
  p_store_id  uuid,
  p_name      text,
  p_item_ids  jsonb,
  p_layout_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_caller_id uuid := auth.uid();
  v_name      text;
  v_slot      smallint;
  v_id        uuid;
begin
  -- (1) Defense-in-depth: refuse a null caller (service_role bearer / unset JWT
  -- claims both yield auth.uid() = null). Fail-closed.
  if v_caller_id is null then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  -- (2) Role gate (OQ-1). SECURITY DEFINER bypasses RLS, so this inline
  -- auth_is_privileged() check is the authorization source of truth.
  if not public.auth_is_privileged() then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  -- (3) Store gate. The caller must be able to SEE the target store.
  if not public.auth_can_see_store(p_store_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  -- (4) Normalize + validate the name and item_ids.
  v_name := btrim(coalesce(p_name, ''));
  if length(v_name) < 1 then
    raise exception using errcode = 'P0001', message = 'layout name required';
  end if;
  if length(v_name) > 60 then
    raise exception using errcode = 'P0001', message = 'layout name too long';
  end if;
  if jsonb_typeof(coalesce(p_item_ids, 'null'::jsonb)) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'item_ids must be an array';
  end if;

  -- (5) OVERWRITE branch (AC-5). Keeps name-slot; last-write-wins (AC-7) — no
  -- field merge, no optimistic version check. position is NOT touched.
  if p_layout_id is not null then
    update public.store_count_layouts
       set name       = v_name,
           item_ids   = p_item_ids,
           updated_at = now()
     where id = p_layout_id
       and store_id = p_store_id
    returning id into v_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'layout not found';
    end if;
    return v_id;
  end if;

  -- (6) CREATE branch (AC-4 / AC-2 / OQ-6). Serialize the count+insert per store
  -- with a transaction advisory lock so concurrent creates cannot both see
  -- count < 3 and both commit (the classic count-then-insert race — Postgres
  -- takes no predicate lock on not-yet-inserted rows). The lock releases at
  -- transaction end. Then take the LOWEST free slot in 1..3; if none is free the
  -- store already has 3 → refuse (the atomic 4th-create backstop; the FE also
  -- pre-blocks per AC-9).
  perform pg_advisory_xact_lock(hashtext('store_count_layouts:' || p_store_id::text));

  select min(s) into v_slot
    from generate_series(1, 3) as s
   where s not in (
     select position from public.store_count_layouts where store_id = p_store_id
   );

  if v_slot is null then
    raise exception using errcode = 'P0001', message = 'layout limit reached';
  end if;

  insert into public.store_count_layouts (store_id, name, item_ids, position, created_by)
  values (p_store_id, v_name, p_item_ids, v_slot, v_caller_id)
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.save_store_count_layout(uuid, text, jsonb, uuid) from public, anon;
grant  execute on function public.save_store_count_layout(uuid, text, jsonb, uuid) to authenticated;

-- ─── rename_store_count_layout — rename (AC-6) ───────────────
-- Resolves the store_id FROM the row first, then applies the role+store gate to
-- it. Updates name only; item_ids + position unchanged. Returns the id.
create or replace function public.rename_store_count_layout(
  p_layout_id uuid,
  p_name      text
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_caller_id uuid := auth.uid();
  v_store     uuid;
  v_name      text;
  v_id        uuid;
begin
  -- (1) Null-caller fail-closed + ROLE gate BEFORE the row-resolve (spec 110
  -- security-review SF-1): the role check needs no row, so running it first
  -- means a non-privileged caller gets the SAME 42501 'forbidden' whether the
  -- layout id is real or fake — no existence oracle. Mirrors the
  -- demote_profile_to_user reference shape (role gate ahead of not-found).
  if v_caller_id is null then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not public.auth_is_privileged() then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  -- (2) Resolve the target row's store (also the not-found check — reached
  -- only by privileged callers).
  select store_id into v_store
    from public.store_count_layouts
   where id = p_layout_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'layout not found';
  end if;

  -- (3) Store gate against the resolved store.
  if not public.auth_can_see_store(v_store) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  -- (4) Normalize + validate the name (item_ids unchanged — AC-6).
  v_name := btrim(coalesce(p_name, ''));
  if length(v_name) < 1 then
    raise exception using errcode = 'P0001', message = 'layout name required';
  end if;
  if length(v_name) > 60 then
    raise exception using errcode = 'P0001', message = 'layout name too long';
  end if;

  update public.store_count_layouts
     set name = v_name, updated_at = now()
   where id = p_layout_id
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.rename_store_count_layout(uuid, text) from public, anon;
grant  execute on function public.rename_store_count_layout(uuid, text) to authenticated;

-- ─── delete_store_count_layout — delete (AC-6) ───────────────
-- Resolves the store from the row, applies the role+store gate, deletes. Returns
-- the deleted id (so the FE knows which pill to drop). A staff screen that had
-- this layout selected falls back to Default on its next fetch because the row —
-- and its pill — is gone; that fallback is a client render concern, no server
-- action needed.
create or replace function public.delete_store_count_layout(
  p_layout_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_caller_id uuid := auth.uid();
  v_store     uuid;
  v_id        uuid;
begin
  -- Role gate BEFORE the row-resolve (spec 110 security-review SF-1): same
  -- rationale as rename_store_count_layout — a non-privileged caller gets the
  -- SAME 42501 for real and fake ids, closing the existence oracle.
  if v_caller_id is null then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not public.auth_is_privileged() then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  select store_id into v_store
    from public.store_count_layouts
   where id = p_layout_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'layout not found';
  end if;

  if not public.auth_can_see_store(v_store) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  delete from public.store_count_layouts
   where id = p_layout_id
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.delete_store_count_layout(uuid) from public, anon;
grant  execute on function public.delete_store_count_layout(uuid) to authenticated;

-- ─── AC-13 cleanup DELETE (the one non-additive hunk; design §3) ──
-- Removes the two Weekly `screen` families' rows so a stale auto-restore cannot
-- leak (OQ-4 / AC-13) now that the Weekly screens no longer call
-- fetchCountOrder/saveCountOrder. Bounded `WHERE screen IN (...)` — CANNOT touch
-- the two EOD families ('admin-eod', 'staff-eod'), which stay completely intact
-- (R-1). Idempotent: a re-run deletes zero further rows once the Weekly screens
-- stop writing them (which they do after the FE change lands).
delete from public.user_count_orders
 where screen in ('admin-inventory', 'staff-weekly');
