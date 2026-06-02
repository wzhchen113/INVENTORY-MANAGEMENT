-- ============================================================
-- Spec 086 — staff_submit_eod persists Cases + Units splits.
--
-- The staff EOD count screen is gaining two number inputs per item
-- (Cases + Units) that convert to a single total — bringing staff to
-- parity with the admin EOD worksheet. The two target columns,
-- public.eod_entries.actual_remaining_cases and .actual_remaining_each
-- (both numeric, nullable), ALREADY exist — added additively in
-- 20260502071736_remote_schema.sql:55,57. No new column, no new table,
-- no DDL. This migration is a purely BEHAVIORAL change to the RPC body.
--
-- Exactly TWO body changes versus the current version
-- (20260525000000_staff_submit_eod_per_user_jwt.sql) — everything else
-- is copied byte-for-byte (the spec 061 per-user-JWT logic, the
-- auth_can_see_store gate, the idempotency check, the vendor presence
-- check, the on-conflict upsert, the vendor-scoped current_stock write,
-- and the audit-log row):
--
--   Hunk A — the jsonb_to_recordset column list gains
--     `actual_remaining_cases numeric` and `actual_remaining_each numeric`
--     so the two split values ride INSIDE the existing p_entries jsonb.
--
--   Hunk B — the eod_entries INSERT writes those two columns alongside
--     the existing actual_remaining (the client-computed total). The RPC
--     does NOT recompute the total — it stores the single number it
--     receives (the same number every report reads). caseQty is never
--     sent to or known by the RPC.
--
-- Backward-compatible (load-bearing). A p_entries element WITHOUT the two
-- new keys still inserts: jsonb_to_recordset yields NULL for absent
-- columns and the eod_entries columns are nullable. So the admin
-- direct-PostgREST path (db.ts submitEODCount, which upserts eod_entries
-- directly and does NOT go through this RPC) is unaffected, and any older
-- staff client mid-rollout still succeeds with _cases/_each = NULL.
--
-- Signature UNCHANGED → no GRANT change. The new fields ride inside the
-- existing p_entries jsonb, so the 7-arg signature
-- (uuid, uuid, date, text, text, jsonb, uuid) is byte-identical to the
-- current version. We use `create or replace` (NOT drop+recreate) so the
-- existing GRANT EXECUTE ... TO authenticated and the
-- REVOKE ... FROM public, anon, service_role from
-- 20260525000000_...:221-222 are PRESERVED with zero churn. No anon
-- lockdown re-affirmation is emitted (re-emitting would be allowed but
-- unnecessary — the SECURITY DEFINER + auth_can_see_store gate is the
-- real boundary). Trade-off versus the prior migration's drop+recreate:
-- `create or replace` will not surface accidental signature drift — but
-- the signature here is intentionally identical, and the pgTAP
-- has_function_privilege assertion pins the GRANT survived.
--
-- No RLS change. No new policy is added, dropped, or rewritten. The RPC
-- stays security definer with its in-body auth_can_see_store(p_store_id)
-- gate verbatim, and the two eod_entries consistency triggers
-- (eod_entries_check_store_trg, eod_submissions_set_submitted_by_trg from
-- 20260514120030_eod_submissions_consistency.sql) are agnostic to which
-- columns the INSERT lists, so they continue to fire on the new INSERT.
--
-- No realtime publication membership change → the
-- "docker restart supabase_realtime_imr-inventory" ritual does NOT apply.
-- eod_entries is NOT in the supabase_realtime publication — the explicit
-- table list in 20260514140000_realtime_publication_tighten.sql:43-53
-- includes eod_submissions but NOT eod_entries. Even though the RPC now
-- writes two more columns to eod_entries, there is no publication to
-- touch and no replication slot to re-snapshot.
-- ============================================================

-- create or replace (NOT drop+recreate) preserves the signature + GRANTs
-- with zero churn — the signature is intentionally byte-identical to the
-- current version, so the lower-risk verb is correct here (spec 086
-- design §"RPC body change").
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
  v_submission_id  uuid;
  v_vendor_name    text;
  v_entry          record;
  v_entry_ids      uuid[] := array[]::uuid[];
  v_stock_updates  jsonb := '[]'::jsonb;
  v_entry_id       uuid;
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

  -- (2) Hydrate the vendor name once for audit-log detail. NULL is
  -- tolerated (audit row falls back to 'unknown' to mirror v1's
  -- 'staff:unknown' fallback shape). vendors is brand-shared and
  -- visible to service_role.
  select v.name into v_vendor_name
    from public.vendors v
   where v.id = p_vendor_id;

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

  -- (5) Upsert parent submission on (store_id, date, vendor_id). The
  -- EDIT path (same triple, new client_uuid) hits DO UPDATE which
  -- preserves the row id; eod_entries.submission_id FKs stay valid.
  --
  -- submitted_by stays NULL on the explicit write; the BEFORE INSERT
  -- trigger eod_submissions_set_submitted_by_trg overrides it to
  -- auth.uid() (spec 020 round-2,
  -- 20260514120030_eod_submissions_consistency.sql:78-94). Under the
  -- new per-user JWT path auth.uid() is the staff user's id; under
  -- the legacy service-role path it's NULL. Same posture either way.
  insert into public.eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at, client_uuid)
  values (p_store_id, p_date, p_vendor_id, null, p_status, now(), p_client_uuid)
  on conflict (store_id, date, vendor_id) do update
    set status = excluded.status,
        submitted_at = excluded.submitted_at,
        client_uuid = coalesce(public.eod_submissions.client_uuid, excluded.client_uuid)
  returning id into v_submission_id;

  -- (6) Replace entries: drop old set, insert new. Avoids diff logic.
  delete from public.eod_entries where submission_id = v_submission_id;

  -- (7) Insert new entries + capture ids + bump inventory (vendor-
  -- scoped per Q6) + audit per row.
  --
  -- Spec 086 — Hunk A: the recordset destructure gains
  -- actual_remaining_cases / actual_remaining_each so the staff screen's
  -- two split inputs ride inside the same p_entries jsonb. Elements
  -- WITHOUT these keys read as NULL (backward-compatible — the admin
  -- direct-PostgREST path and any older staff client still parse).
  for v_entry in
    select * from jsonb_to_recordset(p_entries) as x(
      ingredient_id uuid,
      actual_remaining numeric,
      actual_remaining_cases numeric,
      actual_remaining_each numeric,
      unit text,
      notes text
    )
  loop
    -- Spec 086 — Hunk B: write the two split columns alongside the
    -- existing actual_remaining (the client-computed total). The RPC
    -- stores what it receives; it does NOT recompute the total, and
    -- caseQty is never sent to or known by the RPC. Legacy callers
    -- omit the split keys → both columns insert as NULL.
    insert into public.eod_entries
      (submission_id, item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, notes)
    values
      (v_submission_id, v_entry.ingredient_id, v_entry.actual_remaining,
       v_entry.actual_remaining_cases, v_entry.actual_remaining_each,
       coalesce(v_entry.notes, ''))
    returning id into v_entry_id;
    v_entry_ids := array_append(v_entry_ids, v_entry_id);

    -- Vendor-scoped current_stock write (Q6). The WHERE adds
    -- vendor_id = p_vendor_id so items belonging to a different
    -- vendor (e.g. the unscheduled-item escape hatch) are NOT
    -- touched. The audit_log row below still emits regardless so the
    -- count remains traceable for that off-vendor entry.
    --
    -- Unchanged for spec 086: this continues to use the total
    -- (v_entry.actual_remaining), NOT the raw splits.
    update public.inventory_items
      set current_stock = v_entry.actual_remaining,
          eod_remaining = v_entry.actual_remaining,
          updated_at = now()
      where id = v_entry.ingredient_id
        and vendor_id = p_vendor_id;

    -- Audit row — append ` · vendor: <vendor_name>` to detail so the
    -- audit log surfaces vendor identification per spec 020 AC.
    -- Spec 061: the actor prefix is auth.uid()::text when present so
    -- the audit trail is spoof-proof under the per-user JWT path.
    -- The v1 'staff:unknown' fallback shape is preserved when
    -- auth.uid() and p_submitted_by are both NULL.
    --
    -- Unchanged for spec 086: the value string renders the total +
    -- unit. The human-readable cases+units breakdown is explicitly out
    -- of v1 (spec 086 OQ-3).
    insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
    select
      p_store_id,
      null,
      'EOD entry',
      v_actor || ' · vendor: ' || coalesce(v_vendor_name, 'unknown'),
      ci.name,
      v_entry.actual_remaining::text || ' ' || coalesce(v_entry.unit, ci.unit, '')
    from public.inventory_items ii
    left join public.catalog_ingredients ci on ci.id = ii.catalog_id
    where ii.id = v_entry.ingredient_id;

    v_stock_updates := v_stock_updates || jsonb_build_object(
      'ingredient_id', v_entry.ingredient_id,
      'new_stock', v_entry.actual_remaining
    );
  end loop;

  return jsonb_build_object(
    'submission_id', v_submission_id,
    'conflict', false,
    'entry_ids', to_jsonb(v_entry_ids),
    'stock_updates', v_stock_updates
  );
end;
$$;

-- ─── GRANT — UNCHANGED, deliberately NOT re-emitted ────────────
-- The signature is byte-identical to 20260525000000_...:54-62, so the
-- existing GRANT EXECUTE ... TO authenticated and the
-- REVOKE ... FROM public, anon, service_role (20260525000000_...:221-222)
-- survive the `create or replace` untouched. We do NOT re-emit them
-- (spec 086 design §"API contract" — no GRANT churn). The pgTAP test
-- pins this with a has_function_privilege assertion.

comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) is
  'spec 086: persists actual_remaining_cases / actual_remaining_each from p_entries alongside the client-computed actual_remaining total (backward-compatible — absent keys read NULL). spec 061: per-user JWT. p_submitted_by is ignored — body re-derives from auth.uid() with three-tier fallback (auth.uid → p_submitted_by → ''staff:unknown''). Store-membership gated via auth_can_see_store(). GRANTed to authenticated; REVOKE''d from service_role.';
