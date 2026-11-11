-- ============================================================
-- Spec 193 - bound p_date on staff_submit_eod, and audit staff-side erases.
--
-- The file is named for the date bound; it also carries the R9 erase audit
-- (owner Q7, spec 189 security-audit M1 fix 1). Both functions are replaced
-- with `create or replace` on the landed spec 189 bodies
-- (20261109120000_admin_eod_replace.sql), each byte-for-byte the same apart
-- from ONE inserted/changed hunk. Signatures unchanged.
--
-- (0) Pre-flight: refuse (55000) unless spec 189's eod_write_submission
--     exists and the live staff_submit_eod already calls it. On a database
--     without 189, `create or replace` of the writer would CREATE it with the
--     20260618000000 default grants and point staff writes at it without the
--     189 unique index. Migration order makes that unreachable on a fresh or
--     CI database; this turns an out-of-order hand apply into a clean failure.
-- (1) public.eod_write_submission (SECURITY INVOKER, search_path = public,
--     both restated). R9: in the p_removed_item_ids NULL branch (whole-set
--     replace, staff), the bare delete becomes a `delete ... returning` CTE
--     feeding one audit_log insert, so every deleted row whose item_id is
--     NOT an ingredient_id in p_entries gets one server 'Count cleared' row
--     (same six values as the targeted admin branch, copied from 189).
--     The delete stays unconditional; the NOT EXISTS filter sits on the
--     audit insert only (a filter in the delete would leave re-sent rows and
--     raise 23505 on every re-submit; NOT IN would audit nothing when one
--     payload element has a NULL id). Re-sent items are replaced, not
--     cleared, and keep only their per-entry row. Same statement as the
--     delete, so any later raise rolls the rows back.
--     Comment re-issued (spec 193 sentence + 189 text verbatim). 189's
--     revoke re-issued verbatim: a no-op on a 189 database (create or replace
--     keeps proacl); it makes this file fail closed if it ever creates the
--     function.
-- (2) public.staff_submit_eod (SECURITY DEFINER, search_path = public, both
--     restated). One inserted block after the O-1 check and before the
--     writer call: a non-privileged caller is refused when p_date is NULL,
--     earlier than A - 35 or later than A + 1, where
--     A = (now() at time zone 'America/New_York')::date (session TimeZone and
--     PostgREST's Prefer: timezone cannot move it). Privileged callers
--     (auth_is_privileged()) are exempt. SQLSTATE 22023 (PostgREST: HTTP 400)
--     with a constant message: not 42501 and no network-ish text, so the
--     shipped staff drain (useEodSubmit isForbidden / isNetworkError) bumps
--     attempts and keeps the item instead of dequeuing it or breaking the
--     loop. After the store gate (an outsider still gets 42501) and the
--     idempotency check (a processed uuid still replays as conflict = true).
--     No grant or revoke: same signature, so the ACL (postgres +
--     authenticated) carries over. Comment re-issued (spec 193 sentence + 189
--     text verbatim).
--
-- admin_submit_eod is NOT in this migration. No table, column, index, policy
-- or publication change, so NO `docker restart supabase_realtime_imr-inventory`
-- step (audit_log is not in supabase_realtime).
--
-- PROD-APPLY (spec 193 §9; owner's go-ahead, only after 189 is on prod and
-- verified): pre-check that the NORMALIZED md5 of prod's staff_submit_eod AND
-- eod_write_submission match the landed 189 bodies, and record
-- admin_submit_eod's md5. execute_sql this body via the Supabase MCP, INSERT
-- the exact version '20261109190000' into
-- supabase_migrations.schema_migrations, then VERIFY both functions by
-- normalized md5 against local, plus prosecdef (wrapper true, writer false),
-- proconfig {search_path=public}, proacl (wrapper owner + authenticated;
-- writer owner only, not NULL), and admin_submit_eod's md5 unchanged.
-- ORDER: apply on prod via the Supabase MCP (execute_sql + the explicit
-- schema_migrations version insert above), NOT `supabase db push`: this
-- version sorts before other sessions' pending migrations, so it is an
-- out-of-order version by design. Do it BEFORE pushing this commit to main
-- (or hold the push until the owner applies it): pushing first turns
-- db-migrations-applied.yml red on 20261109190000 missing from prod.
--
-- ROLLBACK (spec 193 §10): a forward migration with its own version. Full:
-- restore BOTH landed 189 bodies verbatim with their 189 comments (writer:
-- security invoker, search_path, re-issue 189's revoke; wrapper: security
-- definer, search_path). Partial is possible: the 189 wrapper alone drops the
-- date bound and keeps R9; the 189 writer alone drops R9 and keeps the bound.
-- Keep any 'Count cleared' rows already written. Adjust
-- staff_submit_eod_date_bound.test.sql in the same PR.
-- 189-ROLLBACK INTERACTION (spec 193 §11): 189 §13 restores the pre-189
-- wrapper from 20261024000000 and DROPS eod_write_submission. That body has
-- its own inline bare delete with no audit, so a 189 rollback written after
-- this file silently drops R9 even if it folds the date check. It must either
-- fold R9 too (the same delete ... returning -> audit_log CTE with the NOT
-- EXISTS filter on the insert) or roll 193 back first (owner decision).
--
-- Tests: supabase/tests/staff_submit_eod_date_bound.test.sql (date bound +
--        R9 arms); anchor-relative fixture dates in staff_submit_eod_cases_each,
--        eod_no_need, eod_update_notifications, audit_log_rls_hardening,
--        inventory_items_identity_lock, eod_submissions_multi_vendor,
--        staff_role_eod_rls and admin_submit_eod; jest
--        src/screens/staff/hooks/useEodSubmit.test.ts (AC-9, AC-10);
--        smoke scripts/smoke-staff-eod.sh (AC-11, local-only).
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ─── (0) Pre-flight: spec 189 must be present ───────────────────────────────
do $$
begin
  if to_regprocedure('public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)') is null
     or not exists (
       select 1
         from pg_proc p
        where p.oid = to_regprocedure('public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)')
          and p.prosrc like '%eod_write_submission(%'
     ) then
    raise exception
      'spec 193 pre-flight: spec 189 (20261109120000_admin_eod_replace) is not applied: public.eod_write_submission is missing or staff_submit_eod does not call it. Apply spec 189 first.'
      using errcode = '55000';
  end if;
end $$;

-- ─── (1) eod_write_submission: R9 erase audit in the NULL branch ────────────
-- Body = the landed 189 writer with one hunk in step (2)'s NULL arm. Order,
-- invoker posture and every other behaviour are unchanged; see 189's notes.
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
    -- Spec 193 (R9; 189 security M1): every deleted row whose item is not
    -- re-sent in p_entries gets one server audit row, same shape as the
    -- targeted branch below, inside this transaction. The delete stays
    -- unconditional (a data-modifying CTE always runs to completion); the
    -- filter applies to the audit insert only. NOT EXISTS, never NOT IN: a
    -- NULL ingredient_id in the payload must match nothing, not suppress
    -- every row. Re-sent items are replaced, not cleared, and keep only their
    -- per-entry row from the loop below.
    with cleared as (
      delete from public.eod_entries e
       where e.submission_id = v_submission_id
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
    left join public.catalog_ingredients ci on ci.id = ii.catalog_id
    where not exists (
      select 1
        from jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb)) as x(ingredient_id uuid)
       where x.ingredient_id = c.item_id
    );
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
  'spec 193: the p_removed_item_ids NULL branch (whole-set replace, staff) now writes one server ''Count cleared'' audit row, same shape as the targeted branch, for each deleted row whose item_id is not an ingredient_id in p_entries, in the same statement as the delete; re-sent items are replaced, not cleared, and get only their per-entry row. spec 189: the one internal EOD writer behind staff_submit_eod and admin_submit_eod. Upserts the parent on (store_id, date, vendor_id) first, then removes rows (p_removed_item_ids NULL = whole set; an array = only the named rows, one server ''Count cleared'' audit row each, then the rows named in p_entries), then inserts p_entries with the spec 102 junction-membership on-hand write gated on not no_need AND actual_remaining is not null. p_audit_actor NULL = no per-entry audit row; p_on_hand_actor NULL = last_updated_by untouched. SECURITY INVOKER with no gate of its own: EXECUTE is revoked from public, anon, authenticated and service_role, and it must stay that way.';

-- No-op on a 189 database (create or replace keeps proacl). Re-issued so this
-- file fails closed if it ever creates the function.
revoke all on function public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)
  from public, anon, authenticated, service_role;

-- ─── (2) staff_submit_eod: the date window ──────────────────────────────────
-- Body = the landed 189 wrapper with one inserted block after O-1. Same
-- signature, so the ACL (postgres + authenticated) carries over.
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

  -- Spec 193: staff date window. Queued offline items replay late (queue GC
  -- 30 days, plus yesterday and zone slack), so the window is 35 days back to
  -- 1 day ahead. SQLSTATE 22023 maps to HTTP 400 and the message is constant,
  -- so the shipped drain keeps and retries a refused item instead of
  -- dequeuing it (forbidden) or breaking the loop (network). The anchor is
  -- the America/New_York brand calendar taken from now(), so neither the
  -- session TimeZone nor a Prefer: timezone header moves it. Privileged
  -- callers are exempt (admins correct past days). After (1.5) so an
  -- outsider still gets the store gate's code; after (4) so a processed uuid
  -- still replays as conflict = true; before the writer so a refusal writes
  -- nothing.
  if (p_date is null
      or p_date < (now() at time zone 'America/New_York')::date - 35
      or p_date > (now() at time zone 'America/New_York')::date + 1)
     and not public.auth_is_privileged() then
    raise exception 'staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)'
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
  'spec 193: a non-privileged caller is refused when p_date is NULL, earlier than A - 35 or later than A + 1, where A = (now() at time zone ''America/New_York'')::date, with SQLSTATE 22023 and the fixed message ''staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)''; privileged callers (auth_is_privileged()) are exempt; the check runs after the store gate and the idempotency check; a per-store time zone follow-up would need to change this literal; and a full replace that drops items now leaves ''Count cleared'' audit rows (via eod_write_submission). spec 189: a wrapper over eod_write_submission (full replace of the submission''s entries). Refuses an empty, NULL or non-array p_entries with 22023 after the idempotency check (O-1). The on-hand write now also skips a non-NO-NEED entry with a null total, and stock_updates omits it. spec 172: optional per-entry no_need key in p_entries — a NO NEED entry inserts no_need = true with NULL numerics (CHECK raises 23514 if a quantity is sent), skips the on-hand write, is omitted from stock_updates, and audits value ''NO NEED''. spec 102: on-hand write is JUNCTION-MEMBERSHIP scoped (item has an item_vendors link for p_vendor_id) so a shared item counted under any of its vendors updates the single shared on-hand; off-vendor entries skip the on-hand write but still audit. spec 086: persists actual_remaining_cases / actual_remaining_each from p_entries alongside the client-computed actual_remaining total (backward-compatible — absent keys read NULL). spec 061: per-user JWT. p_submitted_by is ignored — body re-derives from auth.uid() with three-tier fallback (auth.uid → p_submitted_by → ''staff:unknown''). Store-membership gated via auth_can_see_store(). GRANTed to authenticated; REVOKE''d from service_role.';

commit;
