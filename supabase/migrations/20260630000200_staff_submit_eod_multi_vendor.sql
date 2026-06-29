-- ============================================================
-- Spec 102 — staff_submit_eod shared-on-hand reconciliation (FG-1).
--
-- The spec brief named only the ADMIN on-hand write (src/lib/db.ts) as
-- vendor-scoped. The architect's FG-1 found a SECOND vendor-scoped write:
-- the staff path inside this RPC. A shared item counted under a NON-matching
-- vendor would have its on-hand silently DROPPED on the staff surface too
-- (AC-E / AC-F break). Both writes must be reconciled identically (§5).
--
-- Additive `create or replace` of the 7-arg
-- public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid). The
-- body is copied VERBATIM from the CURRENT on-disk LATEST definition
-- (20260601000000_staff_submit_eod_cases_each.sql — spec 086 Cases+Units,
-- which itself carries spec 061 per-user JWT) with EXACTLY ONE hunk:
--
--   Hunk — the inventory_items on-hand write predicate changes from
--     `and ii.vendor_id = p_vendor_id` (vendor-equality on inventory_items)
--     to a JUNCTION-MEMBERSHIP check:
--       and exists (select 1 from public.item_vendors iv
--                    where iv.item_id = ii.id and iv.vendor_id = p_vendor_id)
--     so the shared on-hand is keyed by ITEM, not (item, vendor). The
--     on-hand is written for any item LEGITIMATELY COUNTABLE under the
--     submitting vendor (it has an item_vendors link for that vendor),
--     regardless of which link is "primary". Items with NO link to the
--     submitting vendor (the unscheduled-item escape hatch / a truly
--     off-vendor entry) keep the current skip-the-mutation behavior —
--     the EXISTS yields false, the UPDATE matches no row, the audit row
--     below STILL emits (preserving the documented escape-hatch invariant).
--
-- Order-independent (AC-F): two same-day vendor submissions that both
-- include the shared item write the SAME physical count to the SAME
-- inventory_items row (the client sends the same total under each tab
-- because the on-hand is one value the UI shows identically). Whichever
-- submission lands last writes the same number — no competing writes.
--
-- EVERYTHING ELSE IS UNCHANGED (copied byte-for-byte): the signature, the
-- GRANT (authenticated EXECUTE) / REVOKE (service_role), the
-- security-definer posture, the spec 061 auth_can_see_store membership
-- gate, the idempotency check on p_client_uuid, the vendor-presence check,
-- the (store, date, vendor) on-conflict upsert, the delete+insert entry
-- replacement, the spec 086 actual_remaining_cases / actual_remaining_each
-- columns, the two eod_entries consistency triggers, and the audit-log row
-- (which still emits for off-vendor entries — that behavior is preserved).
--
-- AC-F submission identity is UNTOUCHED — this changes only how a shared
-- item's on-hand resolves, NOT eod_submissions (store, date, vendor)
-- uniqueness. Signature byte-identical → no GRANT change (the
-- has_function_privilege pgTAP assertion pins the GRANT survived). No RLS
-- change. eod_entries is NOT in the supabase_realtime publication, so the
-- "docker restart supabase_realtime_imr-inventory" ritual does NOT apply
-- here (it applies to the item_vendors publication add in
-- 20260630000000_item_vendors.sql). Depends on item_vendors existing →
-- ordered AFTER …000000.
-- ============================================================

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

  -- (7) Insert new entries + capture ids + bump inventory (junction-
  -- membership per spec 102) + audit per row.
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

    -- Spec 102 — JUNCTION-MEMBERSHIP on-hand write (was: vendor-scoped
    -- `and ii.vendor_id = p_vendor_id`). The on-hand is keyed by ITEM,
    -- not (item, vendor): write current_stock/eod_remaining for the item
    -- itself whenever it has an item_vendors link for the submitting
    -- vendor — so a SHARED item counted under ANY of its vendors updates
    -- the single shared on-hand (AC-E / AC-F), regardless of which link
    -- is "primary". Items with NO link to p_vendor_id (the
    -- unscheduled-item escape hatch / a truly off-vendor entry) have the
    -- EXISTS yield false → no row matches → the on-hand mutation is
    -- skipped, exactly as the vendor-equality predicate skipped it before.
    -- The audit_log row below STILL emits for that off-vendor entry so
    -- the count remains traceable (escape-hatch invariant preserved).
    --
    -- Unchanged for spec 086: this continues to use the total
    -- (v_entry.actual_remaining), NOT the raw splits.
    update public.inventory_items ii
      set current_stock = v_entry.actual_remaining,
          eod_remaining = v_entry.actual_remaining,
          updated_at = now()
      where ii.id = v_entry.ingredient_id
        and exists (select 1 from public.item_vendors iv
                     where iv.item_id = ii.id
                       and iv.vendor_id = p_vendor_id);

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
-- The signature is byte-identical to 20260601000000_...:70-78 (itself
-- byte-identical back to 20260525000000_...:54-62), so the existing
-- GRANT EXECUTE ... TO authenticated and the
-- REVOKE ... FROM public, anon, service_role survive the
-- `create or replace` untouched. We do NOT re-emit them. The pgTAP test
-- (staff_submit_eod_cases_each.test.sql assertion 1) pins this with a
-- has_function_privilege assertion.

comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) is
  'spec 102: on-hand write is JUNCTION-MEMBERSHIP scoped (item has an item_vendors link for p_vendor_id) so a shared item counted under any of its vendors updates the single shared on-hand; off-vendor entries skip the on-hand write but still audit. spec 086: persists actual_remaining_cases / actual_remaining_each from p_entries alongside the client-computed actual_remaining total (backward-compatible — absent keys read NULL). spec 061: per-user JWT. p_submitted_by is ignored — body re-derives from auth.uid() with three-tier fallback (auth.uid → p_submitted_by → ''staff:unknown''). Store-membership gated via auth_can_see_store(). GRANTed to authenticated; REVOKE''d from service_role.';
