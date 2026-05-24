-- ============================================================
-- Spec 061 — staff_submit_eod under per-user JWT (Track A).
--
-- Reworks the 7-arg public.staff_submit_eod() RPC so the staff app can
-- call it directly with its own per-user JWT instead of routing through
-- the deprecated staff-eod-submit Edge Function under a shared
-- STAFF_SERVICE_TOKEN. Three load-bearing changes:
--
--   (1) Body re-derives audit attribution from auth.uid() instead of
--       trusting the caller-supplied p_submitted_by. The parameter
--       stays in the signature for backward compatibility (the legacy
--       Edge Function — now deprecated, see supabase/functions/
--       staff-eod-submit/index.ts in the same deploy as this migration
--       — still passes it), but the body ignores it for trust purposes.
--       Three-tier fallback: auth.uid() → caller-supplied p_submitted_by
--       → literal 'staff:unknown'. auth.uid() MUST win when present so
--       the staff caller cannot spoof attribution. eod_submissions.
--       submitted_by was already server-derived via the
--       eod_submissions_set_submitted_by_trg trigger (spec 020 round-2);
--       only audit_log.detail still trusted the parameter. Closes that
--       spoof surface.
--
--   (2) Store-membership gate via auth_can_see_store(p_store_id) added
--       at the top of the body (after vendor presence check, before
--       vendor-name hydration). The RPC is security definer so RLS does
--       NOT auto-enforce on its INSERTs — without an explicit gate, a
--       staff user holding a per-user JWT could submit for ANY store
--       including stores in other brands. This is the load-bearing
--       change for AC A2; same shape as report_run's caller-can-see-
--       store guard (supabase/migrations/20260510120000_report_runs.sql:
--       35).
--
--   (3) GRANT swap: REVOKE EXECUTE from service_role, GRANT EXECUTE to
--       authenticated. Locks down the legacy service-token caller path
--       (the deprecated Edge Function, which 410s in the same deploy as
--       this migration). public, anon stay REVOKE'd (defense in depth).
--
-- Rollout safety: this migration ships in the SAME deploy as the
-- deprecation of supabase/functions/staff-{catalog,eod-submit,waste-log}
-- to HTTP 410. If the deploy is split, the operator MUST deploy the
-- Edge Function 410 FIRST so a stale service-token caller returns 410
-- cleanly rather than 500-ing on the missing GRANT.
--
-- No new RLS policies. No schema change. No realtime publication
-- membership change. The "docker restart supabase_realtime_*" ritual
-- does NOT apply.
-- ============================================================

-- Drop+recreate to mirror the spec 020 round-2 / spec 020 v2 pattern.
-- create or replace would also work but drop+recreate makes the
-- intent explicit and surfaces signature drift.
drop function if exists public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid);

create function public.staff_submit_eod(
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
  for v_entry in
    select * from jsonb_to_recordset(p_entries) as x(
      ingredient_id uuid,
      actual_remaining numeric,
      unit text,
      notes text
    )
  loop
    insert into public.eod_entries (submission_id, item_id, actual_remaining, notes)
    values (v_submission_id, v_entry.ingredient_id, v_entry.actual_remaining, coalesce(v_entry.notes, ''))
    returning id into v_entry_id;
    v_entry_ids := array_append(v_entry_ids, v_entry_id);

    -- Vendor-scoped current_stock write (Q6). The WHERE adds
    -- vendor_id = p_vendor_id so items belonging to a different
    -- vendor (e.g. the unscheduled-item escape hatch) are NOT
    -- touched. The audit_log row below still emits regardless so the
    -- count remains traceable for that off-vendor entry.
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

-- ─── GRANT swap (per spec 061 §1 Q1) ───────────────────────
-- REVOKE EXECUTE from service_role (the legacy staff-eod-submit Edge
-- Function deprecates to 410 in the same deploy as this migration —
-- the only known service-role caller of this RPC). GRANT EXECUTE to
-- authenticated so the staff app can call directly with its per-user
-- JWT. public + anon stay REVOKE'd (defense in depth — explicit denial
-- preserved from the v2 migration).
revoke all on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) to authenticated;

comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) is
  'spec 061: per-user JWT. p_submitted_by is ignored — body re-derives from auth.uid() with three-tier fallback (auth.uid → p_submitted_by → ''staff:unknown''). Store-membership gated via auth_can_see_store(). GRANTed to authenticated; REVOKE''d from service_role.';
