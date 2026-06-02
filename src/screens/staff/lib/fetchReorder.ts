// src/screens/staff/lib/fetchReorder.ts — staff Reorder data fetch (carve-out).
//
// Spec 089 (B). Direct `supabase.rpc` / `supabase.from` calls are sanctioned
// for the `src/screens/staff/` subtree (CLAUDE.md "DB access centralized"
// carve-out — the whole staff subtree may call supabase directly, like the
// EOD fetch helpers in EODCount.tsx). This file does NOT go through
// `src/lib/db.ts` (that's the admin store/theme path) and does NOT use the
// admin `useInflight.track()` construct — it's plain `await` like
// `fetchVendorsForToday`.
//
// Two exports:
//   - fetchStaffReorder       → the report_reorder_list RPC, mapped to the
//                               SHARED ReorderPayload type (copies
//                               db.ts:mapReorderVendor verbatim so the case
//                               fields ride through unchanged).
//   - fetchStaffOrderSchedule → the order_schedule read for ALL weekdays,
//                               mapped to the SHARED OrderSchedule shape that
//                               activeWeekdaysFromSchedule +
//                               partitionReorderVendors consume.
//
// Type reuse: the SHARED ReorderPayload / OrderSchedule types (not a staff
// mirror) — the pure utils (reorderDayFilter / reorderExport) are typed
// against exactly those shapes; a staff-local mirror would drift.
//
// Errors: throw on PostgREST error. The SCREEN catches and routes to
// notifyStaffBackendError + a retry-able error pane (mirrors EODCount's
// fetchVendorsForToday catch). A store the manager is NOT granted yields the
// RPC's RLS error (42501) which propagates as a thrown error → error pane
// (AC: "not a silent blank").

import { supabase } from '../../../lib/supabase';
import type {
  OnHandSource,
  OrderDayVendor,
  OrderSchedule,
  ReorderItem,
  ReorderPayload,
  ReorderVendor,
} from '../../../types';

// Verbatim copy of db.ts:mapReorderVendor (~25 lines). Duplicating a flat
// snake_case→camelCase mapper is lower-risk than coupling the staff lib to
// the admin db.ts module (same isolation rationale the EOD fetch helpers
// follow). If the report's per-item shape changes, BOTH copies update.
function mapReorderVendor(v: any): ReorderVendor {
  const items: ReorderItem[] = Array.isArray(v?.items)
    ? v.items.map((it: any) => ({
        itemId: String(it?.item_id ?? ''),
        itemName: String(it?.item_name ?? ''),
        unit: String(it?.unit ?? ''),
        onHand: Number(it?.on_hand ?? 0),
        pendingPoQty: Number(it?.pending_po_qty ?? 0),
        parLevel: Number(it?.par_level ?? 0),
        usageForecasted: Number(it?.usage_forecasted ?? 0),
        parReplacement: Number(it?.par_replacement ?? 0),
        suggestedQty: Number(it?.suggested_qty ?? 0),
        costPerUnit: Number(it?.cost_per_unit ?? 0),
        estimatedCost: Number(it?.estimated_cost ?? 0),
        // Spec 088 — case-based ordering fields. `case_qty` is always present
        // (1 = no case size); `suggested_cases` is null when caseQty <= 1;
        // `suggested_units` is the server's ordered base-unit total (falls
        // back to suggested_qty).
        caseQty: Number(it?.case_qty ?? 1),
        suggestedCases: it?.suggested_cases == null ? null : Number(it.suggested_cases),
        suggestedUnits: Number(it?.suggested_units ?? it?.suggested_qty ?? 0),
        flags: Array.isArray(it?.flags) ? it.flags.map((f: any) => String(f)) : [],
      }))
    : [];
  const source: OnHandSource = v?.on_hand_source === 'stock' ? 'stock' : 'eod';
  return {
    vendorId: String(v?.vendor_id ?? ''),
    vendorName: String(v?.vendor_name ?? ''),
    scheduleKnown: Boolean(v?.schedule_known ?? false),
    nextDeliveryDate: String(v?.next_delivery_date ?? ''),
    daysUntilNextDelivery: Number(v?.days_until_next_delivery ?? 0),
    onHandSource: source,
    eodSubmittedAt: v?.eod_submitted_at ? String(v.eod_submitted_at) : null,
    items,
    vendorTotalCost: Number(v?.vendor_total_cost ?? 0),
  };
}

/**
 * Call `report_reorder_list(p_store_id, p_params)` for the manager's active
 * store as of `asOfDate` (always passed — store-local today or a picked
 * date). Returns the SHARED ReorderPayload. Throws on RLS / PostgREST error.
 */
export async function fetchStaffReorder(
  storeId: string,
  asOfDate: string,
): Promise<ReorderPayload> {
  const { data, error } = await supabase.rpc('report_reorder_list', {
    p_store_id: storeId,
    p_params: { as_of_date: asOfDate },
  });
  if (error) throw error;

  const envelope = (data || {}) as any;
  const vendors: ReorderVendor[] = Array.isArray(envelope.vendors)
    ? envelope.vendors.map((v: any) => mapReorderVendor(v))
    : [];
  const kpis = envelope.kpis || {};
  return {
    asOfDate: envelope.as_of_date || asOfDate || '',
    vendors,
    kpis: {
      vendorCount: Number(kpis.vendor_count ?? 0),
      itemCount: Number(kpis.item_count ?? 0),
      totalEstimatedCost: Number(kpis.total_estimated_cost ?? 0),
      eodSourcedVendorCount: Number(kpis.eod_sourced_vendor_count ?? 0),
      stockFallbackVendorCount: Number(kpis.stock_fallback_vendor_count ?? 0),
    },
    warnings: Array.isArray(envelope._warnings)
      ? envelope._warnings.map((w: any) => ({
          code: String(w?.code ?? ''),
          message: String(w?.message ?? ''),
        }))
      : [],
  };
}

/**
 * Read the store's `order_schedule` rows for ALL weekdays and map them to the
 * SHARED `OrderSchedule` slice shape (`{ [DayName]: OrderDayVendor[] }`) that
 * `activeWeekdaysFromSchedule` (calendar highlight) +
 * `partitionReorderVendors` (order-out filter) consume. Unlike EODCount's
 * per-day `fetchVendorsForToday`, we need every weekday for the calendar
 * highlight, so this is unfiltered by day. RLS `auth_can_see_store(store_id)`
 * — manager-readable. Throws on PostgREST error.
 */
export async function fetchStaffOrderSchedule(storeId: string): Promise<OrderSchedule> {
  const { data, error } = await supabase
    .from('order_schedule')
    .select('day_of_week, vendor_id, vendor_name, delivery_day')
    .eq('store_id', storeId);
  if (error) throw error;

  type Row = {
    day_of_week: string | null;
    vendor_id: string | null;
    vendor_name: string | null;
    delivery_day: string | null;
  };
  const rows = (data ?? []) as Row[];
  const out: OrderSchedule = {};
  for (const r of rows) {
    const day = r.day_of_week;
    if (!day) continue;
    const entry: OrderDayVendor = {
      vendorId: r.vendor_id ?? undefined,
      vendorName: r.vendor_name ?? '',
      deliveryDay: r.delivery_day ?? '',
    };
    if (!out[day]) out[day] = [];
    out[day].push(entry);
  }
  return out;
}
