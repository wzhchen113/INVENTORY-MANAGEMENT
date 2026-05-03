-- Phase 13d — RPC for staff-app waste-log push.
-- Two-table atomic write: insert into waste_log, decrement
-- inventory_items.current_stock, write audit row. All in one transaction.
--
-- Idempotency on client_uuid mirrors staff_submit_eod.

CREATE OR REPLACE FUNCTION public.staff_log_waste(
  p_client_uuid uuid,
  p_store_id uuid,
  p_ingredient_id uuid,
  p_quantity numeric,
  p_unit text,
  p_reason text,
  p_notes text,
  p_submitted_by text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id uuid;
  v_waste_id uuid;
  v_item record;
  v_new_stock numeric;
BEGIN
  -- Idempotency check
  IF p_client_uuid IS NOT NULL THEN
    SELECT id INTO v_existing_id
      FROM public.waste_log
      WHERE client_uuid = p_client_uuid;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'waste_id', v_existing_id,
        'conflict', true,
        'reason', 'client_uuid already processed'
      );
    END IF;
  END IF;

  -- Lookup the item to capture cost_per_unit + name + unit + current stock.
  SELECT id, name, unit, current_stock, cost_per_unit
    INTO v_item
    FROM public.inventory_items
    WHERE id = p_ingredient_id AND store_id = p_store_id;

  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'ingredient % not found at store %', p_ingredient_id, p_store_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Insert waste row. cost_per_unit captured at log-time so historical
  -- waste cost stays meaningful even if the item's cost is later edited.
  INSERT INTO public.waste_log (
    store_id, item_id, quantity, unit, cost_per_unit, reason, notes, client_uuid
  ) VALUES (
    p_store_id,
    p_ingredient_id,
    p_quantity,
    COALESCE(p_unit, v_item.unit),
    v_item.cost_per_unit,
    p_reason,
    COALESCE(p_notes, ''),
    p_client_uuid
  ) RETURNING id INTO v_waste_id;

  -- Decrement stock (clamped at 0 — negative stock isn't meaningful).
  v_new_stock := GREATEST(0, COALESCE(v_item.current_stock, 0) - p_quantity);
  UPDATE public.inventory_items
    SET current_stock = v_new_stock,
        updated_at = now()
    WHERE id = p_ingredient_id;

  -- Audit row.
  INSERT INTO public.audit_log (store_id, user_id, action, detail, item_ref, value)
  VALUES (
    p_store_id,
    NULL,
    'Waste log',
    COALESCE(p_submitted_by, 'staff:unknown'),
    v_item.name,
    p_quantity::text || ' ' || COALESCE(p_unit, v_item.unit) || ' · ' || p_reason
  );

  RETURN jsonb_build_object(
    'waste_id', v_waste_id,
    'conflict', false,
    'stock_after', v_new_stock
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_log_waste(uuid, uuid, uuid, numeric, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_log_waste(uuid, uuid, uuid, numeric, text, text, text, text) TO service_role;
