-- ============================================================
-- Spec 179 — lock an inventory item's identity (id and store_id) so existing
-- purchase-order lines and approval snapshots can't be re-homed.
--
-- Closes the three vectors spec 177 left open (spec 177 §11.3 + security L1):
-- PATCH inventory_items.store_id, PATCH inventory_items.id, and DELETE-then-
-- INSERT of the same id under another store. Three guards on
-- public.inventory_items, all enforced BENEATH the unchanged
-- store_member_*_inventory_items RLS policies and for EVERY caller (a trigger
-- is not RLS — postgres and service_role included):
--
--   (R-1)  public.inventory_items_lock_identity()    — inventory_items_identity_lock_trg
--          BEFORE UPDATE OF id, store_id, FOR EACH ROW. id and store_id are
--          ALWAYS immutable on UPDATE (value comparison, so a pass-through
--          resend passes). Covers the conflict arm of INSERT … ON CONFLICT …
--          DO UPDATE. 42501 'inventory_items: id and store_id are immutable'.
--   (R-2b) public.inventory_items_record_tombstone() — inventory_items_tombstone_record_trg
--          AFTER DELETE, FOR EACH ROW. Records (old.id, old.store_id) in
--          public.inventory_item_tombstones for every deleted row, including
--          rows removed by a store-delete cascade. (A brand delete would reach
--          items only through that same stores→inventory_items cascade; today
--          a brand whose stores own items cannot be deleted at all — a
--          pre-existing 23503 on inventory_items_catalog_id_fkey, spec 179
--          §2.5 correction.) Idempotent (on conflict do nothing). Storeless
--          items record nothing (design D-4).
--   (R-2c) public.inventory_items_check_tombstone()  — inventory_items_tombstone_check_trg
--          AFTER INSERT, FOR EACH ROW (fix round 1). Refuses an id that has a
--          tombstone under a DIFFERENT (or NULL) store_id. Same-store reuse is
--          allowed. 42501 'inventory_items: id was previously used by another
--          store'. Running AFTER INSERT means (a) a single-statement delete +
--          reinsert (`with d as (delete … returning …) insert … select … from
--          d`) is refused too, because the DELETE's tombstone event is queued
--          before the INSERT's check event; and (b) the check runs after RLS
--          WITH CHECK, so a caller who may not insert into the named store
--          only ever sees the RLS message (no deleted-id oracle).
--
-- STRICTLY ADDITIVE: one table (public.inventory_item_tombstones, RLS on,
-- NO policies, no FK by design), three functions, three triggers, comments,
-- three function revokes, one TRUNCATE revoke on the new table (owner
-- decision D-1 = Option A). No existing table, column, policy, publication
-- or function is modified. No backfill. No publication change, therefore NO
-- `docker restart supabase_realtime_imr-inventory` step.
--
-- Invoker / definer (design D-6): the R-1 lock reads nothing and is
-- SECURITY INVOKER with `set search_path = public` (spec 177
-- purchase_orders_lock_store_id shape). The tombstone writer and check read
-- and write a table anon/authenticated cannot reach, so they are SECURITY
-- DEFINER with `set search_path = ''` and every relation schema-qualified;
-- they rely on the table OWNER bypassing RLS, so FORCE ROW LEVEL SECURITY
-- must NOT be set on the tombstone table. Execute is revoked from public,
-- anon, authenticated on all three; Postgres does not check EXECUTE when a
-- trigger fires.
--
-- Trigger order (design D-8): BEFORE UPDATE triggers fire in name order —
-- inventory_items_identity_lock_trg < inventory_items_updated_at <
-- trg_item_vendor_changed_at — so the lock fires first. Neither existing
-- trigger writes id or store_id (timestamps only). inventory_items has no
-- other non-internal AFTER INSERT or AFTER DELETE trigger, and no
-- non-internal BEFORE INSERT trigger at all. On INSERT the FK-check RI
-- triggers (RI_ConstraintTrigger_c_*) sort before inventory_items_…, so a
-- bad store_id / catalog_id / vendor_id reports 23503 before the R-2 check.
--
-- Concurrency (design D-7, fix rounds 1/1b): the check first takes FOR KEY
-- SHARE on any OTHER-store row with the same id.
--   * READ COMMITTED (PostgREST and every app path): fails closed. The PK
--     check already waited out an in-flight deleter and each statement
--     re-snapshots, so the committed tombstone is visible.
--   * REPEATABLE READ / SERIALIZABLE: fails closed (40001) ONLY when the
--     other-store row existed in the inserting transaction's snapshot — the
--     probe sees it, and locking a row whose delete committed after the
--     snapshot raises 40001.
--   * Residual (security L4, accepted): a row created AND deleted entirely
--     after that snapshot is invisible to both the probe and the tombstone
--     read, so it is missed. Only a raw postgres / service_role session
--     holding an RR/SERIALIZABLE transaction open can reach this; PostgREST
--     runs READ COMMITTED and no RPC sets a higher isolation level.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): ONLY on the owner's explicit
-- go-ahead and BEFORE the push. execute_sql THIS FILE VERBATIM (line 1 to the
-- final `commit;`) via the Supabase MCP, INSERT the exact version
-- '20261026100000' into supabase_migrations.schema_migrations, VERIFY the
-- three functions by NORMALIZED-MD5, the three triggers by PRESENCE
-- (pg_trigger, tgenabled = 'O'), and the tombstone table's RLS / grant /
-- publication posture. Full runbook: specs/179-inventory-item-identity-lock.md §10.
--
-- Design authority: specs/179-inventory-item-identity-lock.md "## Backend design".
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ─── (R-1) inventory_items.id and store_id are always immutable ──────────
-- Design D-6 / D-10: no legitimate writer changes either column, and no
-- referential action on this schema writes either one (the store cascade is
-- a DELETE; the last_updated_by SET NULL targets only that column). A
-- mis-filed item is deleted and re-created, never moved.
create or replace function public.inventory_items_lock_identity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.store_id is distinct from old.store_id then
    raise exception 'inventory_items: id and store_id are immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.inventory_items_lock_identity() is
  'spec 179 (R-1): BEFORE UPDATE OF id, store_id on public.inventory_items. '
  'id and store_id are always immutable on UPDATE (value comparison, so a '
  'pass-through resend is allowed); a change raises 42501 '
  '''inventory_items: id and store_id are immutable''. SECURITY INVOKER. '
  'A mis-filed item is deleted and re-created, never moved.';

revoke execute on function public.inventory_items_lock_identity()
  from public, anon, authenticated;

drop trigger if exists inventory_items_identity_lock_trg on public.inventory_items;
create trigger inventory_items_identity_lock_trg
  before update of id, store_id on public.inventory_items
  for each row
  execute function public.inventory_items_lock_identity();


-- ─── (R-2a) tombstone table ───────────────────────────────────────────────
-- Composite PK (id, store_id), append semantics (design D-2). No FK to
-- inventory_items or stores (N2): the rows describe things that are gone, and
-- an FK to stores would fight the cascade it records. RLS on with NO
-- policies: anon/authenticated reach no row (SELECT/UPDATE/DELETE see 0
-- rows, INSERT raises 42501). Category B grant posture (inherited default
-- ACL keeps SELECT, so public_grants_explicit arm (1) stays green), minus
-- TRUNCATE (D-1 Option A): TRUNCATE ignores RLS and fires no row trigger, so
-- a role holding it could wipe every tombstone and reopen vector 3.
-- Not added to supabase_realtime (explicit-allowlist publication).
create table if not exists public.inventory_item_tombstones (
  id          uuid        not null,
  store_id    uuid        not null,
  deleted_at  timestamptz not null default now(),
  constraint inventory_item_tombstones_pkey primary key (id, store_id)
);

alter table public.inventory_item_tombstones enable row level security;

revoke truncate on public.inventory_item_tombstones from anon, authenticated;

comment on table public.inventory_item_tombstones is
  'spec 179 (R-2): one row per (deleted inventory_items.id, its store_id). '
  'Written only by inventory_items_record_tombstone() (AFTER DELETE, SECURITY '
  'DEFINER), for every deleted row including store-delete cascades. Read only '
  'by inventory_items_check_tombstone() (AFTER INSERT) to refuse re-inserting a '
  'deleted id under a different store. RLS on with NO policies '
  '(anon/authenticated reach no '
  'row); not published; no FK by design. No backfill: deletes before '
  '20261026100000 left no tombstone.';

comment on column public.inventory_item_tombstones.id is
  'spec 179: the deleted inventory_items.id.';
comment on column public.inventory_item_tombstones.store_id is
  'spec 179: the store_id the deleted item belonged to. Storeless items record no tombstone (D-4).';
comment on column public.inventory_item_tombstones.deleted_at is
  'spec 179: first deletion of this id in this store (later same-store deletes are no-ops).';


-- ─── (R-2b) tombstone writer ──────────────────────────────────────────────
-- AFTER DELETE (design D-3): fires only for rows actually deleted, inside the
-- deleting statement, so any abort (an FK NO ACTION/RESTRICT violation, here
-- or anywhere down a delete cascade) rolls the tombstone back with it. Within
-- one statement its event is queued before any later re-INSERT of the same id
-- (which can only pass the PK check after this delete ran), so the AFTER
-- INSERT check below always sees the tombstone (design D-3, fix round 1).
create or replace function public.inventory_items_record_tombstone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- D-4: a storeless item can never be named by a store's lines.
  if old.store_id is null then
    return null;
  end if;

  -- D-2: idempotent for the delete -> same-store reinsert -> delete cycle.
  insert into public.inventory_item_tombstones (id, store_id)
  values (old.id, old.store_id)
  on conflict (id, store_id) do nothing;

  return null;
end;
$$;

comment on function public.inventory_items_record_tombstone() is
  'spec 179 (R-2): AFTER DELETE on public.inventory_items, FOR EACH ROW. '
  'Records (old.id, old.store_id) in public.inventory_item_tombstones, '
  'including store-delete cascades; on conflict do nothing (append, '
  'idempotent). Storeless items record nothing. SECURITY DEFINER, '
  'search_path ''''.';

revoke execute on function public.inventory_items_record_tombstone()
  from public, anon, authenticated;

drop trigger if exists inventory_items_tombstone_record_trg on public.inventory_items;
create trigger inventory_items_tombstone_record_trg
  after delete on public.inventory_items
  for each row
  execute function public.inventory_items_record_tombstone();


-- ─── (R-2c) tombstone reuse check ─────────────────────────────────────────
-- AFTER INSERT (fix round 1, security M1 + L1). Within one INSERT the order is:
-- RLS WITH CHECK; heap + index insert with the PK unique check (23505 for a
-- live id; waits on an in-flight deleter); then, at the end of the query, the
-- AFTER row events in queue order — the RI FK checks, then this check. A raise
-- aborts the statement, so the row and any tombstone queued earlier in the
-- same statement roll back. On INSERT … ON CONFLICT it fires only when a row
-- is actually inserted (a live id takes the conflict arm, governed by R-1).
-- The FOR KEY SHARE probe is the REPEATABLE READ / SERIALIZABLE guard (design
-- D-7): the store predicate keeps it off this statement's own new row, and it
-- finds nothing under READ COMMITTED. Under a transaction snapshot it raises
-- 40001 only when the other-store row with this id EXISTED IN THE SNAPSHOT
-- and its delete committed after it. Residual (security L4, accepted): a row
-- created and deleted entirely after the snapshot is seen by neither the probe
-- nor the tombstone read, so the reinsert passes. Reachable only from a raw
-- postgres / service_role session holding an RR/SERIALIZABLE transaction open,
-- never from PostgREST (READ COMMITTED; no RPC raises the isolation level).
create or replace function public.inventory_items_check_tombstone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
     from public.inventory_items ii
    where ii.id = new.id
      and ii.store_id is distinct from new.store_id
      for key share;

  if exists (select 1
               from public.inventory_item_tombstones t
              where t.id = new.id
                and t.store_id is distinct from new.store_id) then
    raise exception 'inventory_items: id was previously used by another store'
      using errcode = '42501';
  end if;

  return null;
end;
$$;

comment on function public.inventory_items_check_tombstone() is
  'spec 179 (R-2): AFTER INSERT on public.inventory_items, FOR EACH ROW. '
  'Refuses an id that has a tombstone under a different (or NULL) store_id '
  'with 42501 ''inventory_items: id was previously used by another store''. '
  'Same-store reuse is allowed. Covers every caller (postgres and service_role '
  'included), including a single-statement delete + reinsert (writable CTE), '
  'and runs after RLS WITH CHECK. Under REPEATABLE READ / SERIALIZABLE a FOR '
  'KEY SHARE probe on other-store rows with the same id fails closed (40001) '
  'only when that row existed in the transaction snapshot; a row created and '
  'deleted entirely after the snapshot is missed (residual reachable only from '
  'a raw postgres/service_role RR session, not PostgREST). '
  'SECURITY DEFINER, search_path ''''.';

revoke execute on function public.inventory_items_check_tombstone()
  from public, anon, authenticated;

drop trigger if exists inventory_items_tombstone_check_trg on public.inventory_items;
create trigger inventory_items_tombstone_check_trg
  after insert on public.inventory_items
  for each row
  execute function public.inventory_items_check_tombstone();

commit;
