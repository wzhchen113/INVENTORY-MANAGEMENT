// src/screens/staff/lib/borrowSources.ts — Spec 200 (design §2).
//
// The server half of the staff EOD "count a shared item once" overlay: every
// `status = 'submitted'` eod_submissions row at (store, count date), of ANY
// vendor, with its entries and its vendor's name. The cross-spec borrow-source
// contract (spec 200 §1 = spec 201 §2) fixes the candidate set and the order
// (`submitted_at DESC NULLS LAST, id DESC`); the pure `deriveBorrowedEntries`
// (./borrowedEntries.ts) re-applies both, so the `.order()` here is only a
// stable read order, not the decision.
//
// Deliberately NOT filtered by vendor server-side: `.neq('vendor_id', x)`
// would also drop null-vendor rows and diverge from contract rule 1. The
// helper excludes the selected vendor.
//
// Its own module (like submittedStatus.ts) for a clean jest mock seam. Staff
// carve-out — direct supabase read. Unlike fetchSubmittedVendorIds it THROWS
// on error: the screen catches, calls notifyBackendError and uses [] (R9).

import { supabase } from '../../../lib/supabase';
import type { EodEntry, ServerEodSource } from './types';

type EntryRow = {
  item_id: string;
  actual_remaining: number | string | null;
  actual_remaining_cases: number | string | null;
  actual_remaining_each: number | string | null;
  // NOT NULL DEFAULT false in the DB; nullable only for defensive reads.
  no_need: boolean | null;
};

type VendorEmbed = { name: string | null };

type Row = {
  id: string;
  store_id: string;
  date: string;
  vendor_id: string | null;
  status: string;
  submitted_at: string | null;
  vendor: VendorEmbed | VendorEmbed[] | null;
  eod_entries: EntryRow[] | null;
};

function numOrNull(v: number | string | null): number | null {
  return v == null ? null : Number(v);
}

/** Faithful entry mapping. NO NEED → three null numerics + `no_need: true`
 *  (§6.3 shape); numeric → no `no_need` key. A null `actual_remaining` stays
 *  null (a legacy blank entry the helper skips) — never coerced to 0, which is
 *  why `fetchExistingSubmission`'s mapper cannot be reused here. */
function mapEntry(e: EntryRow): EodEntry {
  if (e.no_need) {
    return {
      item_id: e.item_id,
      actual_remaining: null,
      actual_remaining_cases: null,
      actual_remaining_each: null,
      no_need: true,
    };
  }
  return {
    item_id: e.item_id,
    actual_remaining: numOrNull(e.actual_remaining),
    actual_remaining_cases: numOrNull(e.actual_remaining_cases),
    actual_remaining_each: numOrNull(e.actual_remaining_each),
  };
}

export async function fetchBorrowSources(
  storeId: string,
  countIso: string,
): Promise<ServerEodSource[]> {
  const { data, error } = await supabase
    .from('eod_submissions')
    .select(
      'id, store_id, date, vendor_id, status, submitted_at, vendor:vendors(name), eod_entries(item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, no_need)',
    )
    .eq('store_id', storeId)
    .eq('date', countIso)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Row[]).map((r) => {
    const v = Array.isArray(r.vendor) ? r.vendor[0] : r.vendor;
    return {
      submissionId: r.id,
      storeId: r.store_id,
      date: r.date,
      vendorId: r.vendor_id,
      vendorName: v?.name ?? null,
      status: r.status,
      // RAW string — microsecond digits survive for the tiebreak.
      submittedAt: r.submitted_at,
      entries: (r.eod_entries ?? []).map(mapEntry),
    };
  });
}
