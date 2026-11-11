-- ============================================================
-- Spec 189 - an admin EOD re-submit replaces the old entries.
--
-- The bug: db.ts submitEODCount deleted a submission's eod_entries, then
-- inserted the new set. eod_entries has no DELETE policy, so under RLS the
-- delete removed 0 rows with a 204, the insert stacked on the old rows, and
-- the user saw a success toast. This migration moves the admin write into one
-- SECURITY DEFINER transaction and makes stacking fail loudly.
--
-- (1) Pre-flight: refuse to run while any (submission_id, item_id) pair
--     repeats, naming the runbook step instead of a bare 23505.
-- (2) eod_entries_submission_item_uidx: UNIQUE (submission_id, item_id)
--     (owner decision D-1). idx_eod_entries_submission_id becomes redundant;
--     dropping it is out of scope.
-- (3) public.eod_write_submission: the ONE internal writer for parent, entries,
--     on-hand and audit. SECURITY INVOKER, EXECUTE revoked from every client
--     role; only the two definer wrappers below reach it, as the owner.
--       p_removed_item_ids NULL  -> replace the whole set (staff)
--       p_removed_item_ids array -> targeted: delete the named rows (one
--                                   server 'Count cleared' audit row each),
--                                   then the rows named in p_entries (admin)
--       p_audit_actor NULL       -> no per-entry audit row (admin; the client
--                                   writes 'Count updated' / 'Remaining count
--                                   submitted')
--       p_on_hand_actor NULL     -> last_updated_by left alone (staff)
--     The on-hand predicate is now ONE copy: not no_need AND actual_remaining
--     is not null, gating stock_updates too. That adds the null-total guard to
--     the staff path (a direct API call could previously set current_stock to
--     NULL; no staff client builds that payload).
-- (4) create or replace public.staff_submit_eod, same signature, so its ACL
--     carries over. Keeps steps 1, 1.5, 3 and 4 (vendor check, store gate,
--     actor, idempotency) verbatim from 20261024000000, then:
--       Spec 189 O-1 (owner approved 2026-11-09): an empty, NULL or
--       non-array p_entries raises 22023, AFTER the idempotency check so a
--       replay of a processed uuid still returns conflict = true.
--     and returns the writer's envelope, byte-identical to before.
-- (5) public.admin_submit_eod: the admin entry point. SECURITY DEFINER, gated
--     on auth_is_privileged() AND auth_can_see_store(), EXECUTE for
--     authenticated only. Set-plus-removal-list contract: a row the call
--     doesn't name is left exactly as it is. Refuses an empty call (rule A,
--     including a NULL removal and a removal-only call that names no row in
--     the submission) and any call that would leave the submission with no
--     entries (rule B).
-- (6) Forward comment corrections (spec 189 AC-29): eod_entries table comment
--     (corrects 20260514120030 "the frontend never DELETEs") and
--     report_last_order_context (supersedes its body's "legal duplicates" /
--     "matches the EOD screen" / "dedupe pass" notes). Applied migrations are
--     left as history, and the function body is not re-created, so its
--     normalized md5 is unchanged.
--
-- No table, column or policy changes. No DELETE or ALL policy on eod_entries
-- or eod_submissions (R4, spec 186 AC-8). No publication change, so NO
-- `docker restart supabase_realtime_imr-inventory` step.
--
-- LOCAL NOTE: applying this over a non-reset stack that holds stacked rows
-- (any EDIT through the pre-189 client creates them) hits the pre-flight.
-- Clear the duplicates, or run `npx supabase db reset`.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): follow spec 189 §14. Re-run the
-- AC-32 duplicate query and the role-drift query first and STOP on any row.
-- execute_sql this body via the Supabase MCP BEFORE pushing, INSERT the exact
-- version '20261109120000' into supabase_migrations.schema_migrations, and
-- VERIFY the three functions by NORMALIZED-MD5 against local, plus prosecdef,
-- proconfig and proacl.
--
-- ROLLBACK (spec 189 §13): web first. Then a forward migration restoring
-- staff_submit_eod verbatim from 20261024000000 (plus its comment) and
-- dropping admin_submit_eod and eod_write_submission. Keep the index.
--
-- Tests: supabase/tests/admin_submit_eod.test.sql,
--        supabase/tests/report_last_order_context.test.sql (D1-D3),
--        supabase/tests/eod_update_notifications.test.sql (O-1 payloads)
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ─── (1) Pre-flight ─────────────────────────────────────────────────────────
-- Same grouping the unique index enforces (NULLs stay distinct there, so they
-- are excluded here).
do $$
declare
  v_pairs int;
begin
  select count(*) into v_pairs
    from (
      select 1
        from public.eod_entries
       where submission_id is not null
         and item_id is not null
       group by submission_id, item_id
      having count(*) > 1
    ) d;
  if v_pairs > 0 then
    raise exception
      'spec 189 pre-flight: % duplicate (submission_id, item_id) pair(s) in public.eod_entries. On prod: STOP and ask the owner (spec 189 AC-32 / §14 step 1). On a local stack: clear the duplicates or run supabase db reset.',
      v_pairs
      using errcode = '23505';
  end if;
end $$;

-- ─── (2) Unique index (D-1) ─────────────────────────────────────────────────
create unique index if not exists eod_entries_submission_item_uidx
  on public.eod_entries (submission_id, item_id);

comment on index public.eod_entries_submission_item_uidx is
  'spec 189 (D-1): one entry per item per submission. A stacked insert (an old client''s delete-then-insert, or a payload repeating an item) raises 23505 instead of silently duplicating a count.';

-- ─── (3) eod_write_submission: the one internal writer ──────────────────────
-- Order is load-bearing:
--   1. Parent upsert first. Its row lock serializes every writer on one
--      submission, and the notification triggers read current_stock BEFORE
--      the on-hand writes below (eod_vendor_has_below_par wants pre-count).
--      The DO UPDATE must keep naming status and submitted_at, because
--      notify_eod_resubmission is `after update of status, submitted_at`.
--   2. Remove rows.
--   3. Insert entries, on-hand, optional audit, stock_updates.
-- Delete-then-insert stays (not on conflict do update) so a payload repeating
-- an item raises 23505 rather than silently taking the last one.
--
-- SECURITY INVOKER: called only from the two SECURITY DEFINER wrappers, so it
-- runs as the owner there. If its revoke ever regressed, a direct caller would
-- run under its own RLS (the delete removes 0 rows, the insert hits the
-- unique index) instead of getting a gateless store-wide write.
create or replace function public.eod_write_submission(
  p_store_id         uuid,
  p_date             date,
  p_vendor_id        uuid,
  p_status           text,
  p_entries          jsonb,
  p_client_uuid      uuid,
  p_removed_item_ids uuid[],
  p_audit_actor      text,
  p_on_hand_actor    uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_submission_id  uuid;
  v_vendor_name    text;
  v_entry          record;
  v_entry_ids      uuid[] := array[]::uuid[];
  v_stock_updates  jsonb := '[]'::jsonb;
  v_entry_id       uuid;
  v_numeric        boolean;
begin
  -- Vendor name for audit detail. NULL falls back to 'unknown' below.
  select v.name into v_vendor_name
    from public.vendors v
   where v.id = p_vendor_id;

  -- (1) Upsert the parent on (store_id, date, vendor_id). The EDIT path hits
  -- DO UPDATE, which preserves the row id, so eod_entries.submission_id and
  -- order_approvals.source_submission_id stay valid. submitted_by is NULL on
  -- the explicit write; eod_submissions_set_submitted_by_trg overrides it to
  -- auth.uid() on both the INSERT and the conflict UPDATE.
  insert into public.eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at, client_uuid)
  values (p_store_id, p_date, p_vendor_id, null, p_status, now(), p_client_uuid)
  on conflict (store_id, date, vendor_id) do update
    set status = excluded.status,
        submitted_at = excluded.submitted_at,
        client_uuid = coalesce(public.eod_submissions.client_uuid, excluded.client_uuid)
  returning id into v_submission_id;

  -- (2) Remove rows.
  if p_removed_item_ids is null then
    -- Staff: replace the whole set.
    delete from public.eod_entries where submission_id = v_submission_id;
  else
    -- Admin: only rows named by the call. A cleared row gets one server audit
    -- row (the delete's only trace), inside this transaction. The value is
    -- what was removed. The ' · vendor: ' suffix keeps existing parsers
    -- working. A named item with no row here is a no-op.
    with cleared as (
      delete from public.eod_entries e
       where e.submission_id = v_submission_id
         and e.item_id = any (p_removed_item_ids)
      returning e.item_id, e.actual_remaining, e.no_need
    )
    insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
    select
      p_store_id,
      auth.uid(),
      'EOD entry',
      'Count cleared · vendor: ' || coalesce(v_vendor_name, 'unknown'),
      ci.name,
      case when c.no_need then 'NO NEED'
           when c.actual_remaining is null then ''
           else trim_scale(c.actual_remaining)::text || ' ' || coalesce(ci.unit, '') end
    from cleared c
    left join public.inventory_items ii on ii.id = c.item_id
    left join public.catalog_ingredients ci on ci.id = ii.catalog_id;

    -- Rows being re-written. Not audited here: the shipped entry is audited
    -- by the client (admin) or the loop below (staff never takes this branch).
    delete from public.eod_entries e
     where e.submission_id = v_submission_id
       and e.item_id in (
         select x.ingredient_id
           from jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb)) as x(ingredient_id uuid)
       );
  end if;

  -- (3) Insert entries + capture ids + on-hand (junction membership, spec 102)
  -- + optional audit per row. Element keys are the staff p_entries shape
  -- (spec 086 splits, spec 172 no_need); absent keys read NULL.
  for v_entry in
    select * from jsonb_to_recordset(p_entries) as x(
      ingredient_id uuid,
      actual_remaining numeric,
      actual_remaining_cases numeric,
      actual_remaining_each numeric,
      unit text,
      notes text,
      no_need boolean
    )
  loop
    -- A NO NEED element carrying a quantity fails
    -- eod_entries_no_need_no_quantity_check (23514); a cross-store or missing
    -- item fails eod_entries_check_store_trg (42501); a repeated item fails
    -- eod_entries_submission_item_uidx (23505). Each rolls back the whole call.
    insert into public.eod_entries
      (submission_id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes, no_need)
    values
      (v_submission_id, v_entry.ingredient_id, v_entry.actual_remaining,
       v_entry.actual_remaining_cases, v_entry.actual_remaining_each,
       coalesce(v_entry.notes, ''), coalesce(v_entry.no_need, false))
    returning id into v_entry_id;
    v_entry_ids := array_append(v_entry_ids, v_entry_id);

    -- The single on-hand predicate (spec 172 S3 + spec 189): a NO NEED entry,
    -- or any entry with a null total, writes no on-hand and is omitted from
    -- stock_updates. Never current_stock = NULL.
    v_numeric := not coalesce(v_entry.no_need, false)
                 and v_entry.actual_remaining is not null;

    -- Spec 102: on-hand is keyed by ITEM. Written whenever the item has an
    -- item_vendors link for the submitting vendor, primary or not. Off-vendor
    -- entries (the escape hatch) store the entry and leave on-hand alone.
    -- last_updated_by: admin passes auth.uid(); staff passes NULL, leaving the
    -- column as it was.
    if v_numeric then
      update public.inventory_items ii
        set current_stock   = v_entry.actual_remaining,
            eod_remaining   = v_entry.actual_remaining,
            last_updated_by = coalesce(p_on_hand_actor, ii.last_updated_by),
            updated_at      = now()
        where ii.id = v_entry.ingredient_id
          and exists (select 1 from public.item_vendors iv
                       where iv.item_id = ii.id
                         and iv.vendor_id = p_vendor_id);
    end if;

    -- Staff per-entry audit row (spec 020 / 061 / 172 S4 shape, verbatim).
    -- Admin passes NULL: its client already writes one row per shipped entry.
    if p_audit_actor is not null then
      insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
      select
        p_store_id,
        null,
        'EOD entry',
        p_audit_actor || ' · vendor: ' || coalesce(v_vendor_name, 'unknown'),
        ci.name,
        case when coalesce(v_entry.no_need, false) then 'NO NEED'
             else v_entry.actual_remaining::text || ' ' || coalesce(v_entry.unit, ci.unit, '') end
      from public.inventory_items ii
      left join public.catalog_ingredients ci on ci.id = ii.catalog_id
      where ii.id = v_entry.ingredient_id;
    end if;

    if v_numeric then
      v_stock_updates := v_stock_updates || jsonb_build_object(
        'ingredient_id', v_entry.ingredient_id,
        'new_stock', v_entry.actual_remaining
      );
    end if;
  end loop;

  return jsonb_build_object(
    'submission_id', v_submission_id,
    'conflict', false,
    'entry_ids', to_jsonb(v_entry_ids),
    'stock_updates', v_stock_updates
  );
end;
$$;

comment on function public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid) is
  'spec 189: the one internal EOD writer behind staff_submit_eod and admin_submit_eod. Upserts the parent on (store_id, date, vendor_id) first, then removes rows (p_removed_item_ids NULL = whole set; an array = only the named rows, one server ''Count cleared'' audit row each, then the rows named in p_entries), then inserts p_entries with the spec 102 junction-membership on-hand write gated on not no_need AND actual_remaining is not null. p_audit_actor NULL = no per-entry audit row; p_on_hand_actor NULL = last_updated_by untouched. SECURITY INVOKER with no gate of its own: EXECUTE is revoked from public, anon, authenticated and service_role, and it must stay that way.';

-- Required, not a belt: 20260618000000 grants ALL on future functions to anon,
-- authenticated and service_role by default.
revoke all on function public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)
  from public, anon, authenticated, service_role;

-- ─── (4) staff_submit_eod: wrapper over the writer ──────────────────────────
-- Same signature, so the ACL (postgres + authenticated) carries over. Steps
-- 1, 1.5, 3 and 4 are verbatim from 20261024000000. Step 2 (vendor name) and
-- steps 5-7 moved into eod_write_submission.
create or replace function public.staff_submit_eod(
  p_client_uuid uuid,
  p_store_id uuid,
  p_date date,
  p_submitted_by text,
  p_status text,
  p_entries jsonb,
  p_vendor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_id    uuid;
  v_actor          text;
begin
  -- (1) Vendor presence check. Q1 — strict NOT NULL on the parameter.
  if p_vendor_id is null then
    raise exception
      'staff_submit_eod: vendor_id is required as of spec 020'
      using errcode = '22023';
  end if;

  -- (1.5) Per-spec-061 store-membership gate. The RPC runs security
  -- definer so RLS doesn't auto-enforce on its INSERTs; we explicitly
  -- check the caller has membership for the target store. Same shape
  -- as report_run's caller-can-see-store guard
  -- (20260510120000_report_runs.sql:35).
  --
  -- For service_role callers, auth.uid() is NULL and so is
  -- auth_can_see_store; service_role is REVOKE'd from EXECUTE on this
  -- function in the GRANT block at the bottom anyway, so a service_role
  -- caller cannot get past the GRANT check to reach this line. This
  -- gate fires for authenticated callers only.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'staff_submit_eod: caller cannot see store %', p_store_id
      using errcode = '42501';
  end if;

  -- (3) Resolve the audit-log actor string. Three-tier fallback per
  -- spec 061 §2: auth.uid() (the per-user JWT path) wins when present
  -- so the staff caller cannot spoof; p_submitted_by is the legacy
  -- compat path for non-JWT callers (now removed via the edge-function
  -- deprecation, but the fallback stays for defense in depth); the
  -- 'staff:unknown' literal is the v1 fallback shape.
  v_actor := coalesce(auth.uid()::text, p_submitted_by, 'staff:unknown');

  -- (4) Idempotency check on p_client_uuid (per-attempt). If a row
  -- with this client_uuid already exists — even under a different
  -- (store_id, date, vendor_id) triple — return its id with
  -- conflict=true. Same behavior as v1.
  if p_client_uuid is not null then
    select id into v_existing_id
      from public.eod_submissions
      where client_uuid = p_client_uuid;
    if v_existing_id is not null then
      return jsonb_build_object(
        'submission_id', v_existing_id,
        'conflict', true,
        'reason', 'client_uuid already processed'
      );
    end if;
  end if;

  -- Spec 189 — O-1 (owner approved 2026-11-09): refuse an empty payload.
  -- With the full-replace contract below, '[]' or NULL would clear every
  -- entry with no audit row. After step (4), so a replay of a processed uuid
  -- still returns conflict = true; before any write.
  if p_entries is null
     or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) = 0 then
    raise exception 'staff_submit_eod: p_entries must be a non-empty array'
      using errcode = '22023';
  end if;

  -- (5)-(7) Parent upsert, full replace of the entries, on-hand, per-entry
  -- audit. p_removed_item_ids NULL = replace the whole set; the audit actor
  -- is v_actor; last_updated_by is left alone (p_on_hand_actor NULL).
  return public.eod_write_submission(
    p_store_id,
    p_date,
    p_vendor_id,
    p_status,
    p_entries,
    p_client_uuid,
    null,
    v_actor,
    null
  );
end;
$$;

comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) is
  'spec 189: a wrapper over eod_write_submission (full replace of the submission''s entries). Refuses an empty, NULL or non-array p_entries with 22023 after the idempotency check (O-1). The on-hand write now also skips a non-NO-NEED entry with a null total, and stock_updates omits it. spec 172: optional per-entry no_need key in p_entries — a NO NEED entry inserts no_need = true with NULL numerics (CHECK raises 23514 if a quantity is sent), skips the on-hand write, is omitted from stock_updates, and audits value ''NO NEED''. spec 102: on-hand write is JUNCTION-MEMBERSHIP scoped (item has an item_vendors link for p_vendor_id) so a shared item counted under any of its vendors updates the single shared on-hand; off-vendor entries skip the on-hand write but still audit. spec 086: persists actual_remaining_cases / actual_remaining_each from p_entries alongside the client-computed actual_remaining total (backward-compatible — absent keys read NULL). spec 061: per-user JWT. p_submitted_by is ignored — body re-derives from auth.uid() with three-tier fallback (auth.uid → p_submitted_by → ''staff:unknown''). Store-membership gated via auth_can_see_store(). GRANTed to authenticated; REVOKE''d from service_role.';

-- ─── (5) admin_submit_eod: the admin entry point ────────────────────────────
-- Contract: p_entries is the set of CHANGED rows; p_removed_item_ids names the
-- rows the manager cleared. A row the call doesn't name stays exactly as it
-- is, so a client with stale state can only fail to touch rows, never delete
-- them. Every refusal fires before any write. The whole call is one
-- transaction: any raise undoes the parent, entries, on-hand, audit,
-- notification rows and the queued push.
--
-- The gate matches today's admin re-submit posture (admin_update_eod_*).
-- auth_is_admin() reads the JWT for admin/master, so a drifted token loses
-- first-submit access; the §14 runbook checks for that.
create or replace function public.admin_submit_eod(
  p_store_id         uuid,
  p_date             date,
  p_vendor_id        uuid,
  p_status           text,
  p_entries          jsonb,
  p_removed_item_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entries  jsonb  := coalesce(p_entries, '[]'::jsonb);
  v_removed  uuid[] := coalesce(p_removed_item_ids, array[]::uuid[]);
  v_result   jsonb;
  v_count    int;
  v_existing uuid;
begin
  -- (1) Gate.
  if not (public.auth_is_privileged() and public.auth_can_see_store(p_store_id)) then
    raise exception 'admin_submit_eod: caller cannot write EOD counts for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) Parameters.
  if p_vendor_id is null then
    raise exception 'admin_submit_eod: vendor_id is required'
      using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('draft', 'submitted') then
    raise exception 'admin_submit_eod: status must be draft or submitted'
      using errcode = '22023';
  end if;

  -- (3) The vendor must belong to the store's brand. The direct path had the
  -- FK only.
  if not exists (
    select 1
      from public.vendors v
      join public.stores s on s.brand_id = v.brand_id
     where v.id = p_vendor_id
       and s.id = p_store_id
  ) then
    raise exception 'admin_submit_eod: vendor % is not in the brand of store %', p_vendor_id, p_store_id
      using errcode = '42501';
  end if;

  -- (4) Rule A: no empty call. A blank-only correction (no entries, one or
  -- more removals that name a row in this submission) is legal. A non-array
  -- p_entries is malformed either way.
  if jsonb_typeof(v_entries) <> 'array' then
    raise exception 'admin_submit_eod: p_entries must be a JSON array'
      using errcode = '22023';
  end if;
  if jsonb_array_length(v_entries) = 0 and cardinality(v_removed) = 0 then
    raise exception 'admin_submit_eod: nothing to write (no entries and no removals)'
      using errcode = '22023';
  end if;
  -- A NULL removal names no row, so it can't count toward rule A.
  if array_position(v_removed, null) is not null then
    raise exception 'admin_submit_eod: p_removed_item_ids must not contain NULL'
      using errcode = '22023';
  end if;
  -- A blank-only call must remove at least one row that is in THIS
  -- submission; otherwise it would only bump submitted_at, maybe flip status
  -- and fire an eod_update (security L1 / architect N3). Checked before the
  -- parent upsert. FOR UPDATE takes the same parent row lock the writer's
  -- upsert takes, so a concurrent removal of the same row can't slip in
  -- between this check and the delete. No parent yet = nothing to remove.
  if jsonb_array_length(v_entries) = 0 then
    select s.id into v_existing
      from public.eod_submissions s
     where s.store_id = p_store_id
       and s.date = p_date
       and s.vendor_id = p_vendor_id
       for update;
    if v_existing is null or not exists (
      select 1
        from public.eod_entries e
       where e.submission_id = v_existing
         and e.item_id = any (v_removed)
    ) then
      raise exception 'admin_submit_eod: nothing to write (no entries, and no removal names a row in this submission)'
        using errcode = '22023';
    end if;
  end if;

  -- (5) An item can't be both written and cleared.
  if exists (
    select 1
      from jsonb_to_recordset(v_entries) as x(ingredient_id uuid)
     where x.ingredient_id = any (v_removed)
  ) then
    raise exception 'admin_submit_eod: an item is in both p_entries and p_removed_item_ids'
      using errcode = '22023';
  end if;

  -- Targeted branch (never NULL here), no client_uuid (no idempotency check;
  -- a retry re-applies the same changes), no per-entry server audit (the
  -- client writes it), last_updated_by = the caller.
  v_result := public.eod_write_submission(
    p_store_id,
    p_date,
    p_vendor_id,
    p_status,
    v_entries,
    null,
    v_removed,
    null,
    auth.uid()
  );

  -- Rule B: never leave a submission with no entries. Raising here rolls the
  -- whole call back.
  select count(*) into v_count
    from public.eod_entries e
   where e.submission_id = (v_result ->> 'submission_id')::uuid;
  if v_count = 0 then
    raise exception 'admin_submit_eod: a submission cannot be left with no entries'
      using errcode = '22023';
  end if;

  -- entry_count: the entries the submission holds after this call.
  return v_result || jsonb_build_object('entry_count', v_count);
end;
$$;

comment on function public.admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[]) is
  'spec 189: the admin EOD write (SUBMIT, UPDATE COUNT, SAVE DRAFT; desktop and phone). One transaction for parent, entries and on-hand via eod_write_submission. p_entries = the CHANGED rows (staff element keys, unit ignored); p_removed_item_ids = the rows the manager cleared, each audited server-side as ''Count cleared''. Rows the call does not name are left untouched. Refusals, all before any write: not (auth_is_privileged() and auth_can_see_store()) 42501; NULL vendor or status not draft/submitted 22023; vendor outside the store''s brand 42501; empty call 22023; a NULL in p_removed_item_ids 22023; no entries and no removal naming a row in this submission 22023 (the parent is locked FOR UPDATE for that check); an item in both lists 22023. After the write, a submission left with no entries raises 22023 and rolls back. last_updated_by = auth.uid(); submitted_by forced by eod_submissions_set_submitted_by_trg; submitted_at = now(). Returns the writer envelope plus entry_count (entries held after the call). SECURITY DEFINER; EXECUTE for authenticated only.';

revoke all on function public.admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[])
  from public, anon, service_role;
grant execute on function public.admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[])
  to authenticated;

-- ─── (6) Forward comment corrections (AC-29) ────────────────────────────────
comment on table public.eod_entries is
  'One row per counted item per eod_submissions row (spec 189 unique index eod_entries_submission_item_uidx). No DELETE or ALL policy (append-only posture, 20260514120030; spec 186 AC-8; spec 178). Correction to 20260514120030''s "the frontend never DELETEs": before spec 189, db.ts submitEODCount did issue a delete of a submission''s entries before re-inserting; RLS silently denied it (0 rows, HTTP 204), so re-submits stacked. Writes now go through the SECURITY DEFINER writers staff_submit_eod and admin_submit_eod, which delete inside one transaction.';

comment on function public.report_last_order_context(uuid, uuid[], date) is
  'spec 151 (§2, AC-18/AC-19/AC-20/AC-22/AC-23): the last-order context read '
  'behind the "LAST {date} · COUNTED {n} · ORDERED {n}" annotation on the '
  'ordering surfaces. SECURITY INVOKER with an explicit '
  'auth_can_see_store(p_store_id) top gate raising 42501 before any read, and '
  'NO top-level auth_is_privileged() gate (R-B): order_approvals'' privilege '
  'conjunct is a row filter, so a non-privileged store member simply resolves '
  'anchors from the purchase_orders tiers instead (R-5). Picks ONE anchor per '
  'vendor by the AC-2 precedence — sent/partial/received PO (1) > ordered '
  'approval (2) > approved approval (3) > draft PO (4), ties by anchor date '
  'then created_at — with ''cancelled'' POs and ''pending'' approvals excluded '
  'from every tier, strictly BEFORE p_as_of_date. Returns quantities in BASE / '
  'COUNTED units, UNCONVERTED (no case_qty arithmetic in SQL); items[] is the '
  'UNION of the anchor order''s lines and the anchoring eod_submissions row''s '
  'entries, so a JSON-null ordered_qty_base means "not on that order" (AC-8) '
  'and a JSON-null counted_qty_base means "no count entry" (AC-7) — neither is '
  'ever coerced to 0. Bounds: > 100 vendor ids raises 22023; per-vendor items '
  'are capped at 500 with items_truncated flagged. A vendor with no anchor is '
  'OMITTED from vendors[] entirely (R-D). Reads only existing tables; creates '
  'no table, no policy and no publication change. '
  'Spec 189 correction to the counted_lines comment in the body: duplicates '
  'are no longer legal (unique index eod_entries_submission_item_uidx), so '
  'DISTINCT ON is now harmless defence; the locked EOD screen showed the FIRST '
  'row, not the last-written; and no prod dedupe pass was needed (0 duplicate '
  'groups on 2026-11-08).';

commit;
