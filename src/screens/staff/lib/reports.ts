// src/screens/staff/lib/reports.ts — staff "report an issue" write path.
//
// Spec 126. The staff subtree is a documented supabase-direct carve-out
// (CLAUDE.md), so this does NOT route through `src/lib/db.ts`. The single
// SECURITY DEFINER RPC `submit_staff_report` derives brand / store name /
// reporter server-side from trusted rows and gates on
// `auth_can_see_store(p_store_id)`, so the client cannot forge a report for a
// store/brand it cannot see. We only pass the store id, category token, and
// the free-text message; everything else is attached server-side.
//
// Returns the new `staff_reports.id` on success; THROWS on error so the
// Settings form can surface it via `notifyStaffBackendError` + inline error
// copy (no silent success — see the acceptance criteria).

import { supabase } from '../../../lib/supabase';

/** The four report categories. Mirrors the CHECK on `staff_reports.category`
 *  (`equipment` / `inventory` / `app_tech` / `other`). */
export type StaffReportCategory = 'equipment' | 'inventory' | 'app_tech' | 'other';

/**
 * File a staff problem report for the given store. Resolves to the new report
 * id (a uuid) on success; throws on RPC error.
 */
export async function submitStaffReport(
  storeId: string,
  category: StaffReportCategory,
  message: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('submit_staff_report', {
    p_store_id: storeId,
    p_category: category,
    p_message: message,
  });
  if (error) {
    throw new Error(error.message ?? 'submit_staff_report failed');
  }
  return data as string;
}
