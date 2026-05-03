-- Phase 13c — RPC for staff-app EOD submission.
-- Wraps the 4-table write (eod_submissions upsert, eod_entries replace,
-- inventory_items stock update, audit_log per entry) in a single
-- transaction. Edge Functions don't have first-class transactions;
-- calling this RPC via supabase.rpc() runs the body inside the request's
-- implicit transaction.
--
-- Idempotency: if p_client_uuid matches an existing eod_submissions row,
-- return that row's id with status='conflict' so the caller knows it was
-- a retry, not a fresh submission.
--
-- Args:
--   p_client_uuid     uuid       — staff app's per-attempt UUID (idempotency)
--   p_store_id        uuid
--   p_date            date
--   p_submitted_by    text       — staff app's identity claim ("staff:user-id")
--   p_status          text       — 'submitted' | 'draft'
--   p_entries         jsonb      — array of { ingredient_id, actual_remaining, unit, notes }
--
-- Returns: jsonb { submission_id, conflict, entry_ids[], stock_updates[] }

CREATE OR REPLACE FUNCTION public.staff_submit_eod(
  p_client_uuid uuid,
  p_store_id uuid,
  p_date date,
  p_submitted_by text,
  p_status text,
  p_entries jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id uuid;
  v_submission_id uuid;
  v_entry record;
  v_entry_ids uuid[] := ARRAY[]::uuid[];
  v_stock_updates jsonb := '[]'::jsonb;
  v_entry_id uuid;
BEGIN
  -- Idempotency check
  IF p_client_uuid IS NOT NULL THEN
    SELECT id INTO v_existing_id
      FROM public.eod_submissions
      WHERE client_uuid = p_client_uuid;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'submission_id', v_existing_id,
        'conflict', true,
        'reason', 'client_uuid already processed'
      );
    END IF;
  END IF;

  -- Upsert parent submission. (store_id, date) unique constraint means
  -- same-day re-submission updates the existing row's status + timestamp.
  INSERT INTO public.eod_submissions (store_id, date, submitted_by, status, submitted_at, client_uuid)
  VALUES (p_store_id, p_date, NULL, p_status, now(), p_client_uuid)
  ON CONFLICT (store_id, date) DO UPDATE
    SET status = EXCLUDED.status,
        submitted_at = EXCLUDED.submitted_at,
        client_uuid = COALESCE(public.eod_submissions.client_uuid, EXCLUDED.client_uuid)
  RETURNING id INTO v_submission_id;

  -- Replace entries: drop old set, insert new. Avoids diffing logic.
  DELETE FROM public.eod_entries WHERE submission_id = v_submission_id;

  -- Insert new entries + capture ids + bump inventory + audit per row.
  FOR v_entry IN
    SELECT * FROM jsonb_to_recordset(p_entries) AS x(
      ingredient_id uuid,
      actual_remaining numeric,
      unit text,
      notes text
    )
  LOOP
    INSERT INTO public.eod_entries (submission_id, item_id, actual_remaining, notes)
    VALUES (v_submission_id, v_entry.ingredient_id, v_entry.actual_remaining, COALESCE(v_entry.notes, ''))
    RETURNING id INTO v_entry_id;
    v_entry_ids := array_append(v_entry_ids, v_entry_id);

    UPDATE public.inventory_items
      SET current_stock = v_entry.actual_remaining,
          eod_remaining = v_entry.actual_remaining,
          updated_at = now()
      WHERE id = v_entry.ingredient_id;

    -- Audit row — submitted_by goes in `detail` since user_id is uuid
    -- and staff app users aren't in profiles. The staff app's claim
    -- (e.g. "staff:user-id") is used as-is — no extra prefix here.
    INSERT INTO public.audit_log (store_id, user_id, action, detail, item_ref, value)
    SELECT
      p_store_id,
      NULL,
      'EOD entry',
      COALESCE(p_submitted_by, 'staff:unknown'),
      ii.name,
      v_entry.actual_remaining::text || ' ' || COALESCE(v_entry.unit, ii.unit)
    FROM public.inventory_items ii
    WHERE ii.id = v_entry.ingredient_id;

    v_stock_updates := v_stock_updates || jsonb_build_object(
      'ingredient_id', v_entry.ingredient_id,
      'new_stock', v_entry.actual_remaining
    );
  END LOOP;

  RETURN jsonb_build_object(
    'submission_id', v_submission_id,
    'conflict', false,
    'entry_ids', to_jsonb(v_entry_ids),
    'stock_updates', v_stock_updates
  );
END;
$$;

-- Edge Functions call this via supabase.rpc(); only the service-role key
-- needs to invoke it. Lock down EXECUTE to service_role to keep app-side
-- direct calls (with user JWT) from bypassing the Edge Function's auth.
REVOKE ALL ON FUNCTION public.staff_submit_eod(uuid, uuid, date, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_submit_eod(uuid, uuid, date, text, text, jsonb) TO service_role;
