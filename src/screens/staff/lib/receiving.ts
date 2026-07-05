// src/screens/staff/lib/receiving.ts — staff receiving data + RPC carve-out.
//
// Spec 113 §5 (frontend slice). Direct `supabase.from` / `supabase.rpc` calls are
// sanctioned for the `src/screens/staff/` subtree (CLAUDE.md "DB access
// centralized" carve-out — the whole staff subtree may call supabase directly,
// like fetchReorder.ts / countLayouts.ts). This file does NOT go through
// `src/lib/db.ts` (that's the admin store/theme path) and does NOT use the admin
// `useInflight.track()` construct — it's plain `await` like fetchReorder.ts.
//
// Three exports:
//   - fetchStaffOpenPos    → the active store's OPEN POs (status ∈ {sent,
//                            partial}), newest-first, with the joined vendor name.
//   - fetchStaffPoLines    → one PO's real po_items lines, joined through
//                            inventory_items → catalog_ingredients for the name /
//                            unit / i18n_names. NO price/cost column is selected
//                            or mapped (R-1).
//   - submitStaffReceive   → calls the spec-107/109 receive_purchase_order RPC
//                            with the additive stock deltas and a caller-minted
//                            client uuid. The mapped line object contains EXACTLY
//                            two keys (po_item_id, received_qty) — it NEVER sends
//                            a `new_case_price` key (belt to the server's braces —
//                            R-1; the server also refuses a priced staff call with
//                            42501 'forbidden: price change requires admin').
//
// R-1 (STOCK-ONLY for staff): there is deliberately NO price input anywhere in
// this module's types or payloads. `StaffPoLine` mirrors the admin `PoLine`
// (db.ts:1404-1428) MINUS every price/cost field — no costPerUnit, no case price,
// no subUnitSize/caseQty (those exist only to drive the admin case-price ghost +
// 30% bridge). Verbatim-copy discipline: if the po_items projection changes, this
// AND the admin copy update — but this copy NEVER gains a price field.
//
// Errors: throw on PostgREST / RPC error. The SCREEN catches and routes to
// notifyStaffBackendError + a retry-able error pane (mirrors the fetchReorder
// idiom). A store the member is NOT granted yields the RLS error (42501) which
// propagates as a thrown error → error pane (not a silent blank).

import { supabase } from '../../../lib/supabase';
import type { LocalizedNames } from '../../../types';

// One open PO header for the list (AC-7). Newest-first ordering is done in the
// query (created_at DESC); the two OPEN states are the same filter the admin
// PoReceivingMode uses (ReceivingSection.tsx:120-129).
export interface StaffOpenPo {
  id: string;
  status: 'sent' | 'partial'; // the two OPEN states
  vendorName: string; // joined vendors.name ('' when unnamed / no vendor)
  referenceDate: string | null; // reference_date — the delivery/order date shown
  createdAt: string; // for newest-first sort + a stable secondary display
}

// Staff-local PO line shape — MIRRORS the admin PoLine (db.ts:1404-1428) MINUS
// every price/cost field. Renders localized names via getLocalizedName (spec 100,
// staff-only — the admin copy stays English).
export interface StaffPoLine {
  poItemId: string; // po_items.id
  itemId: string; // inventory_items.id
  itemName: string; // catalog_ingredients.name
  unit: string; // catalog_ingredients.unit
  orderedQty: number; // ordered_qty (0 when null)
  receivedQty: number; // cumulative received_qty (0 when null)
  i18nNames: LocalizedNames; // per-item name overrides ({} when absent)
}

/**
 * The this-receive ADDITIVE delta shape sent to the RPC. Two fields ONLY — no
 * price. Exported so the screen + tests share the exact type (belt to the
 * server's braces — the type itself has no price surface, R-1).
 */
export interface StaffReceiveDelta {
  poItemId: string;
  receivedQty: number;
}

/**
 * PURE helper (unit-tested independently of the render). Builds the this-receive
 * ADDITIVE deltas from the loaded lines + the per-line "received now" input map,
 * dropping blank/zero/negative rows. The resulting objects carry EXACTLY
 * `{ poItemId, receivedQty }` — never a price key (the R-1 carve-out contract is
 * testable at this boundary). A blank or non-numeric input parses to 0 and is
 * filtered out (matching the admin `.filter(d => d.receivedQty > 0)` at
 * ReceivingSection.tsx:191).
 */
export function buildReceiveDeltas(
  lines: Array<{ poItemId: string }>,
  inputs: Record<string, string>,
): StaffReceiveDelta[] {
  const out: StaffReceiveDelta[] = [];
  for (const ln of lines) {
    const raw = (inputs[ln.poItemId] ?? '').trim();
    const parsed = parseFloat(raw);
    const receivedQty = Number.isFinite(parsed) ? parsed : 0;
    if (receivedQty > 0) {
      out.push({ poItemId: ln.poItemId, receivedQty });
    }
  }
  return out;
}

/**
 * The outstanding remainder for a line = max(0, ordered − received). Pure; used
 * to prefill the "received now" input (AC-8) and unit-tested directly.
 */
export function outstandingRemainder(line: { orderedQty: number; receivedQty: number }): number {
  return Math.max(0, line.orderedQty - line.receivedQty);
}

/**
 * (a) List the active store's OPEN POs (status ∈ {sent, partial}), newest-first.
 *     RLS `auth_can_see_store` — staff-readable (spec 107; no new read policy —
 *     AC-6). Throws on PostgREST error (the screen catches →
 *     notifyStaffBackendError + error pane). The `vendors(name)` join rides the
 *     existing vendor read RLS (same shape the admin PO list uses).
 */
export async function fetchStaffOpenPos(storeId: string): Promise<StaffOpenPo[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('id, status, reference_date, created_at, vendors(name)')
    .eq('store_id', storeId)
    .in('status', ['sent', 'partial'])
    .order('created_at', { ascending: false });
  if (error) throw error;

  type VendorJoin = { name: string | null };
  type Row = {
    id: string;
    status: string | null;
    reference_date: string | null;
    created_at: string | null;
    // PostgREST returns an embedded to-one relation as an object, but the
    // generated types can widen it to an array — handle both defensively.
    vendors: VendorJoin | VendorJoin[] | null;
  };
  const rows = (data ?? []) as Row[];
  return rows.map((r) => {
    const v = Array.isArray(r.vendors) ? r.vendors[0] : r.vendors;
    return {
      id: r.id,
      // The query already filters to sent|partial; the narrowing is safe.
      status: (r.status === 'partial' ? 'partial' : 'sent') as 'sent' | 'partial',
      vendorName: v?.name ?? '',
      referenceDate: r.reference_date ?? null,
      createdAt: r.created_at ?? '',
    };
  });
}

/**
 * (b) Load one PO's real po_items lines, joined through inventory_items →
 *     catalog_ingredients for the name / unit / i18n_names. NO price/cost column
 *     is selected or mapped (R-1 — do NOT add cost_per_unit / sub_unit_size /
 *     case_qty here). Mirrors the admin `mapPoItemRow` (db.ts:1416-1430) minus the
 *     price fields, ADDING `i18n_names` (staff renders localized names — the same
 *     fetchReorder divergence, spec 100). Throws on PostgREST error.
 */
export async function fetchStaffPoLines(poId: string): Promise<StaffPoLine[]> {
  const { data, error } = await supabase
    .from('po_items')
    .select(
      'id, item_id, ordered_qty, received_qty, inventory_items(catalog_id, catalog_ingredients(name, unit, i18n_names))',
    )
    .eq('po_id', poId);
  if (error) throw error;

  type CatalogRow = {
    name: string | null;
    unit: string | null;
    i18n_names: LocalizedNames | null;
  };
  type InvRow = {
    catalog_id: string | null;
    catalog_ingredients: CatalogRow | CatalogRow[] | null;
  };
  type Row = {
    id: string;
    item_id: string;
    ordered_qty: number | string | null;
    received_qty: number | string | null;
    inventory_items: InvRow | InvRow[] | null;
  };
  const rows = (data ?? []) as Row[];
  return rows.map((r) => {
    const ii = Array.isArray(r.inventory_items) ? r.inventory_items[0] : r.inventory_items;
    const ci = ii
      ? Array.isArray(ii.catalog_ingredients)
        ? ii.catalog_ingredients[0]
        : ii.catalog_ingredients
      : null;
    return {
      poItemId: r.id,
      itemId: r.item_id,
      itemName: ci?.name ?? '',
      unit: ci?.unit ?? '',
      orderedQty: Number(r.ordered_qty) || 0,
      receivedQty: Number(r.received_qty) || 0,
      i18nNames: (ci?.i18n_names ?? {}) as LocalizedNames,
    };
  });
}

/**
 * (c) Commit a STOCK-ONLY receive. Calls `receive_purchase_order` with the
 *     additive deltas and the caller-minted `clientUuid` (minted ONCE per receive
 *     event for idempotency — AC-10). The mapped line object contains EXACTLY
 *     `po_item_id` + `received_qty` — it NEVER sends a `new_case_price` key
 *     (belt-and-braces R-1; the server refuses a priced staff call with 42501
 *     regardless). Returns the resulting `status` + `conflict` flag; the
 *     `price_changes` array is ignored (always `[]` on staff calls — OQ-4). A
 *     `conflict: true` envelope is an idempotent REPLAY (the server has already
 *     deduped) — surfaced to the caller so the screen treats it as
 *     success-no-reapply. Throws on RPC error (incl. the AC-2 42501, surfaced as an
 *     error — never a phantom success).
 */
export async function submitStaffReceive(
  poId: string,
  lines: StaffReceiveDelta[],
  clientUuid: string,
): Promise<{ status: string; conflict: boolean }> {
  const { data, error } = await supabase.rpc('receive_purchase_order', {
    p_po_id: poId,
    // EXACTLY two keys per line — no new_case_price (R-1).
    p_lines: lines.map((ln) => ({
      po_item_id: ln.poItemId,
      received_qty: ln.receivedQty,
    })),
    p_client_uuid: clientUuid,
  });
  if (error) throw error;
  const result = (data || {}) as { status?: string; conflict?: boolean };
  return { status: result.status || '', conflict: !!result.conflict };
}
