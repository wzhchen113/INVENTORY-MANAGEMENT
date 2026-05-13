-- ============================================================
-- Spec 020 — staff_submit_eod with per-vendor partitioning
--
-- Adds a new 7-arg overload of `staff_submit_eod` that takes
-- `p_vendor_id uuid` (NOT NULL — enforced inside the body). The new
-- signature lives alongside the legacy 6-arg signature for the
-- duration of the sibling-app rollout window; the legacy 6-arg body
-- is replaced with a fail-loud RAISE so any pre-update caller fails
-- noisily instead of silently corrupting data with NULL-vendor
-- partitioning.
--
-- Idempotency keys:
--   - p_client_uuid (offline-retry dedup, partial unique index on
--     eod_submissions.client_uuid from 20260504000000_staff_api_idempotency.sql)
--   - (p_store_id, p_date, p_vendor_id) (new unique from
--     20260514120000_eod_submissions_vendor_id.sql) drives the
--     ON CONFLICT DO UPDATE so the EDIT path preserves the
--     eod_submissions.id (FK stability for eod_entries.submission_id).
--
-- Q6 — vendor-scoped current_stock writes: when updating
-- inventory_items.current_stock / eod_remaining, the UPDATE is gated
-- on `inventory_items.vendor_id = p_vendor_id`. Items belonging to a
-- different vendor (the unscheduled-item escape hatch case) still get
-- their eod_entries row persisted AND an audit_log entry, but the
-- inventory mutation is skipped. The eod_entries row is the audit
-- trail; the count is traceable even when the inventory write is gated.
--
-- Audit detail: appends ` · vendor: <vendor_name>` so the existing
-- audit_log.detail (text) column surfaces vendor identification
-- without a schema change to a permission-sensitive table.
-- ============================================================

-- ─── New 7-arg signature ───────────────────────────────────
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
begin
  -- (1) Vendor presence check. Q1 — strict NOT NULL on the parameter.
  if p_vendor_id is null then
    raise exception
      'staff_submit_eod: vendor_id is required as of spec 020'
      using errcode = '22023';
  end if;

  -- (2) Hydrate the vendor name once for audit-log detail. NULL is
  -- tolerated (audit row falls back to 'unknown' to mirror v1's
  -- 'staff:unknown' fallback shape). vendors is brand-shared and
  -- visible to service_role.
  select v.name into v_vendor_name
    from public.vendors v
   where v.id = p_vendor_id;

  -- (3) Idempotency check on p_client_uuid (per-attempt). If a row
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

  -- (4) Upsert parent submission on (store_id, date, vendor_id). The
  -- EDIT path (same triple, new client_uuid) hits DO UPDATE which
  -- preserves the row id; eod_entries.submission_id FKs stay valid.
  --
  -- submitted_by stays NULL for staff-app callers (no `profiles` row;
  -- intentional, inherited from v1). Spec 020 round-2 added a BEFORE
  -- INSERT/UPDATE trigger `eod_submissions_set_submitted_by` (see
  -- 20260514120030_eod_submissions_consistency.sql) that overrides
  -- `submitted_by := auth.uid()`. This RPC runs as `security definer`
  -- with the service-role key, where `auth.uid()` returns NULL — so the
  -- trigger's override naturally produces the same NULL we'd write
  -- explicitly here. The explicit `null` is left in place as belt-and-
  -- braces in case the trigger is ever dropped or reordered.
  insert into public.eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at, client_uuid)
  values (p_store_id, p_date, p_vendor_id, null, p_status, now(), p_client_uuid)
  on conflict (store_id, date, vendor_id) do update
    set status = excluded.status,
        submitted_at = excluded.submitted_at,
        client_uuid = coalesce(public.eod_submissions.client_uuid, excluded.client_uuid)
  returning id into v_submission_id;

  -- (5) Replace entries: drop old set, insert new. Avoids diff logic.
  delete from public.eod_entries where submission_id = v_submission_id;

  -- (6) Insert new entries + capture ids + bump inventory (vendor-
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
    -- `vendor_id = p_vendor_id` so items belonging to a different
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
    -- audit log surfaces vendor identification per spec 020 AC. v1's
    -- 'staff:unknown' fallback shape is preserved for submitted_by.
    -- Item name + unit are sourced from catalog_ingredients via
    -- inventory_items.catalog_id; the v1 RPC referenced ii.name/ii.unit
    -- which were dropped in P3 lockdown (20260504072830:59-60), so the
    -- v2 audit insert routes through the catalog join. The fallback for
    -- a missing catalog row preserves the value column's text shape.
    insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
    select
      p_store_id,
      null,
      'EOD entry',
      coalesce(p_submitted_by, 'staff:unknown')
        || ' · vendor: ' || coalesce(v_vendor_name, 'unknown'),
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

-- Lock execute to service_role — same as v1, the staff-app Edge
-- Function uses the service-role key to call this RPC. Authenticated
-- (admin) users continue to use the direct-PostgREST path through
-- submitEODCount() in src/lib/db.ts.
revoke all on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) to service_role;

-- ─── Deprecate legacy 6-arg signature ──────────────────────
-- Replace the legacy body with a fail-loud RAISE. Keeps the function
-- and its GRANT in place so the rollback story is simple (re-applying
-- 20260504000001_staff_submit_eod_rpc.sql swaps the body back in via
-- create or replace) AND so any pre-update sibling-app deploy that
-- hits the 6-arg signature gets a clean error rather than a silent
-- corruption window.
create or replace function public.staff_submit_eod(
  p_client_uuid uuid,
  p_store_id uuid,
  p_date date,
  p_submitted_by text,
  p_status text,
  p_entries jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception
    'staff_submit_eod: vendor_id is required as of spec 020 — sibling staff-app must update'
    using errcode = '22023';
end;
$$;
