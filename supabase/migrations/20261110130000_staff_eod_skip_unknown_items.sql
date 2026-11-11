-- ============================================================
-- Spec 199 - staff_submit_eod skips unknown or cross-store items instead of
-- losing the whole count.
--
-- What changes: ONLY public.staff_submit_eod (SECURITY DEFINER,
-- search_path = public, both restated), via `create or replace` on the
-- landed spec 193 body (20261109190000_staff_eod_date_bound.sql), byte-for-
-- byte the same apart from five new declare variables, ONE inserted block
-- after the date window, and the writer call's 5th argument and return.
-- Signature unchanged, so the ACL
-- (postgres + authenticated) carries over; no grant or revoke.
--
--   (R3) any p_entries element with a NULL or absent ingredient_id (or a
--        non-object element) refuses the whole call: SQLSTATE 22023,
--        'staff_submit_eod: every p_entries element needs an ingredient_id'.
--   (R2) the distinct payload ids are checked against inventory_items in ONE
--        locking statement (FOR KEY SHARE). Valid iff id = ingredient_id AND
--        store_id = p_store_id (the exact complement of
--        eod_entries_check_store's item test). Every other id is skipped:
--        never inserted, never audited, no on-hand write.
--   (R4) nothing valid left refuses the whole call: SQLSTATE 22023,
--        'staff_submit_eod: no p_entries element names an item of this store'.
--   Both messages are constant (no interpolation, DETAIL or HINT), are not
--   42501 and hold no network-ish text and no 'caller cannot see store', so
--   the staff drain keeps and retries a refused item.
--   The writer receives the FILTERED array (original elements, original
--   order; repeats of a valid id kept so 23505 still fires), so spec 193's
--   'Count cleared' audit is judged against the entries actually written.
--   The success envelope gains 'skipped_item_ids' (distinct uuids; [] when
--   none). The replay envelope (conflict = true) returns before the new block
--   and is unchanged, WITHOUT the new key.
--   Order: vendor NULL -> (1.5) store gate -> (4) replay -> O-1 (on the RAW
--   payload) -> date window -> R3 -> R2 -> R4 -> writer.
--   R13: the store gate's message prefix 'staff_submit_eod: caller cannot see
--   store' is now a client contract (useEodSubmit.ts STORE_GATE_TEXT dequeues
--   only on it); its code and prefix are pinned by arm SK9 of the new suite.
--
-- eod_write_submission, admin_submit_eod and the eod_entries_check_store
-- trigger are NOT in this migration; their bodies stay byte-identical. The
-- trigger still guards admin writes and direct inserts.
-- No table, column, index, policy or publication change, so NO
-- `docker restart supabase_realtime_imr-inventory` step.
--
-- R10 (delete race), with the lock adopted: a DELETE committed before the
-- locking SELECT's snapshot is invisible (item skipped); a DELETE holding the
-- row while we wait is re-checked after it commits (EvalPlanQual) and the
-- row drops out (item skipped); a DELETE that starts after we hold KEY SHARE
-- waits for our commit and then fails its NO ACTION RI check with 23503
-- (the item now has history). The trigger can no longer see an item vanish
-- between the check and the insert. Residuals:
--   (a) a multi-row DELETE that locks the same items in another order can
--       deadlock with the submit (40P01). deleteInventoryItem deletes one
--       row, so this needs a bulk/cascade delete. 40P01 is neither forbidden
--       nor network, so new and installed clients keep and retry the item.
--   (b) a long-running DELETE holding a row makes the submit wait, bounded by
--       PostgREST's statement timeout; the client's "other" branch keeps it.
--   (c) KEY SHARE blocks an UPDATE of a unique-indexed column on these rows
--       for the length of the submit (milliseconds). Two staff submits are
--       compatible (KEY SHARE vs KEY SHARE, and vs the writer's NO KEY
--       UPDATE of current_stock).
--
-- SPEC 185 SEQUENCING: spec 185 (area-scoped staff replace, DRAFT) also
-- rewrites this wrapper. Whichever spec lands second carries the other's
-- hunks; 185's area-scoped replace must filter its payload through this
-- same skip block.
--
-- PROD-APPLY (spec 199 §7; owner's go-ahead only, AFTER spec 193 is on prod):
-- pre-check that schema_migrations holds 20261109120000 and 20261109190000,
-- and that the NORMALIZED md5 of prod's staff_submit_eod and
-- eod_write_submission match the local spec 193 bodies (record
-- admin_submit_eod's md5). execute_sql this file's full text via the
-- Supabase MCP (a 55000 pre-flight failure means 193 is not really there:
-- stop), INSERT the exact version '20261110130000' (name
-- 'staff_eod_skip_unknown_items') into supabase_migrations.schema_migrations,
-- then VERIFY staff_submit_eod's normalized md5 against local, writer and
-- admin_submit_eod md5 unchanged, staff_submit_eod prosecdef true,
-- proconfig {search_path=public}, proacl owner + authenticated only, writer
-- proacl owner-only (not NULL), and the comment starting with 'spec 199'.
-- Not `supabase db push` (this version can sort before or after other
-- sessions' pending versions). Apply BEFORE pushing to main, then confirm
-- test.yml and db-migrations-applied.yml are green on main and check e2e.yml.
--
-- ROLLBACK (spec 199 §8): a forward migration with its own version that
-- re-creates staff_submit_eod from spec 193's body verbatim with 193's
-- comment, security definer and search_path restated; no grant change; the
-- writer and admin_submit_eod need no touching. Delete or adjust
-- staff_submit_eod_skip_unknown.test.sql and revert arm (16) of
-- admin_submit_eod.test.sql in the same PR. Keep data written under 199.
-- Prefer rolling the client back with the server: the narrowed isForbidden
-- retries a trigger 42501 forever on a rolled-back server.
-- 193-ROLLBACK INTERACTION: a 193 wrapper rollback written after this file
-- silently drops this filter. It must restore this body minus the date
-- block, or roll 199 back first.
--
-- Tests: supabase/tests/staff_submit_eod_skip_unknown.test.sql (new);
--        supabase/tests/admin_submit_eod.test.sql arm (16) (staff envelope
--        key set gains 'skipped_item_ids'); every other suite calling
--        staff_submit_eod passes untouched (staff_submit_eod_date_bound,
--        staff_submit_eod_cases_each, eod_no_need, eod_update_notifications,
--        eod_submissions_multi_vendor, staff_role_eod_rls,
--        eod_submissions_edit_flow, audit_log_rls_hardening,
--        inventory_items_identity_lock, reports_anon_revoke); jest
--        src/screens/staff/hooks/useEodSubmit.test.ts (STORE_GATE_TEXT
--        is pinned server-side by arm SK9 of the new suite).
-- ============================================================

begin;

set local lock_timeout = '5s';

-- ─── (0) Pre-flight: spec 193 must be present ───────────────────────────────
do $$
begin
  if to_regprocedure('public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)') is null
     or not exists (
       select 1
         from pg_proc p
        where p.oid = to_regprocedure('public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)')
          and p.prosrc like '%eod_write_submission(%'
          and p.prosrc like '%America/New_York%'
     )
     or not exists (
       select 1
         from pg_proc p
        where p.oid = to_regprocedure('public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)')
          and p.prosrc like '%not exists%'
     ) then
    raise exception
      'spec 199 pre-flight: spec 193 (20261109190000_staff_eod_date_bound) is not applied: eod_write_submission is missing or lacks the R9 filter, or staff_submit_eod lacks the date window. Apply spec 193 first.'
      using errcode = '55000';
  end if;
end $$;

-- ─── (1) staff_submit_eod: skip unknown / cross-store items ─────────────────
-- Body = the landed 193 wrapper with one inserted block after the date window
-- and the writer call's 5th argument and return changed. Same signature, so
-- the ACL (postgres + authenticated) carries over.
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
  v_ids            uuid[];
  v_valid_ids      uuid[];
  v_skipped        uuid[];
  v_entries        jsonb;
  v_result         jsonb;
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

  -- Spec 199 (R3). After the date window. A NULL or absent ingredient_id
  -- (or a non-object element, whose ->> is NULL too) refuses the whole call.
  -- A malformed payload, not a stale catalog: nothing to skip or report.
  if exists (select 1
               from jsonb_array_elements(p_entries) as e(elem)
              where e.elem ->> 'ingredient_id' is null) then
    raise exception 'staff_submit_eod: every p_entries element needs an ingredient_id'
      using errcode = '22023';
  end if;

  -- Spec 199 (R2). Distinct payload ids. A non-uuid string raises 22P02 here,
  -- as it did in the writer's jsonb_to_recordset before (same SQLSTATE).
  v_ids := array(select distinct (e.elem ->> 'ingredient_id')::uuid
                   from jsonb_array_elements(p_entries) as e(elem));

  -- Spec 199 (R10). ONE locking statement defines the valid set. FOR KEY
  -- SHARE blocks a concurrent DELETE (and key UPDATE) of these rows until
  -- commit, and is compatible with the writer's own current_stock UPDATE
  -- (FOR NO KEY UPDATE). In READ COMMITTED a row deleted by a transaction
  -- that commits while we wait on its lock is dropped from the result, so it
  -- is skipped, not inserted. The locking clause sits in a FROM sub-select
  -- because FOR KEY SHARE is not allowed alongside an aggregate. ORDER BY id
  -- gives a deterministic lock order. Definer context: the read bypasses RLS
  -- on purpose (a cross-store id must be seen to be classified); the
  -- response only echoes ids the caller sent.
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_valid_ids
    from (select ii.id
            from public.inventory_items ii
           where ii.id = any (v_ids)
             and ii.store_id = p_store_id
           order by ii.id
             for key share of ii) s;

  v_skipped := array(select x from unnest(v_ids) as x where x <> all (v_valid_ids));

  -- Spec 199 (R4). Nothing valid left: refuse before any write (no parent
  -- upsert, no full-replace delete, no audit, no on-hand, no notification).
  if cardinality(v_valid_ids) = 0 then
    raise exception 'staff_submit_eod: no p_entries element names an item of this store'
      using errcode = '22023';
  end if;

  -- Spec 199. Filtered payload: original elements byte-for-byte (every key
  -- kept) in original order. Duplicates of a valid id stay, so the writer
  -- still raises 23505 for them. The writer's 'Count cleared' NOT EXISTS
  -- filter reads this array, so it is judged against the entries written.
  select jsonb_agg(e.elem order by e.ord) into v_entries
    from jsonb_array_elements(p_entries) with ordinality as e(elem, ord)
   where (e.elem ->> 'ingredient_id')::uuid = any (v_valid_ids);

  -- (5)-(7) Parent upsert, full replace of the entries, on-hand, per-entry
  -- audit. p_removed_item_ids NULL = replace the whole set; the audit actor
  -- is v_actor; last_updated_by is left alone (p_on_hand_actor NULL).
  v_result := public.eod_write_submission(
    p_store_id,
    p_date,
    p_vendor_id,
    p_status,
    v_entries,
    p_client_uuid,
    null,
    v_actor,
    null
  );

  -- Spec 199: always present on a non-replay success ([] when none skipped).
  return v_result || jsonb_build_object('skipped_item_ids', to_jsonb(v_skipped));
end;
$$;

comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) is
  'spec 199: after the date window, a payload element with a NULL or absent ingredient_id refuses the call with SQLSTATE 22023 and the fixed message ''staff_submit_eod: every p_entries element needs an ingredient_id''; the distinct payload ids are then checked against inventory_items in one FOR KEY SHARE locking statement, valid iff the item exists at p_store_id, and every other id is skipped (never inserted, audited or written to on-hand); if nothing valid remains the call is refused with SQLSTATE 22023 and the fixed message ''staff_submit_eod: no p_entries element names an item of this store''; the writer receives the filtered list, so ''Count cleared'' is judged against the entries actually written; every non-replay success carries skipped_item_ids (distinct ids, [] when none), and the replay envelope is unchanged without it. spec 193: a non-privileged caller is refused when p_date is NULL, earlier than A - 35 or later than A + 1, where A = (now() at time zone ''America/New_York'')::date, with SQLSTATE 22023 and the fixed message ''staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)''; privileged callers (auth_is_privileged()) are exempt; the check runs after the store gate and the idempotency check; a per-store time zone follow-up would need to change this literal; and a full replace that drops items now leaves ''Count cleared'' audit rows (via eod_write_submission). spec 189: a wrapper over eod_write_submission (full replace of the submission''s entries). Refuses an empty, NULL or non-array p_entries with 22023 after the idempotency check (O-1). The on-hand write now also skips a non-NO-NEED entry with a null total, and stock_updates omits it. spec 172: optional per-entry no_need key in p_entries — a NO NEED entry inserts no_need = true with NULL numerics (CHECK raises 23514 if a quantity is sent), skips the on-hand write, is omitted from stock_updates, and audits value ''NO NEED''. spec 102: on-hand write is JUNCTION-MEMBERSHIP scoped (item has an item_vendors link for p_vendor_id) so a shared item counted under any of its vendors updates the single shared on-hand; off-vendor entries skip the on-hand write but still audit. spec 086: persists actual_remaining_cases / actual_remaining_each from p_entries alongside the client-computed actual_remaining total (backward-compatible — absent keys read NULL). spec 061: per-user JWT. p_submitted_by is ignored — body re-derives from auth.uid() with three-tier fallback (auth.uid → p_submitted_by → ''staff:unknown''). Store-membership gated via auth_can_see_store(). GRANTed to authenticated; REVOKE''d from service_role.';

commit;
