// src/lib/eodEmptyState.ts — Spec 184 (D-12).
//
// Pure, dependency-free derivation of why the admin EOD screen has no vendor tabs
// to show. No `supabase`, no React, no store, so it's unit-testable without
// mounting the component. Same extract-and-pin pattern as `eodDayStatus.ts`.
//
// The old banner said "no vendors scheduled" whenever the tabs were empty and a
// schedule existed, and offered a toggle that couldn't help when the store had no
// items or no vendor links. This names the actual reason.
//
// First match wins, in this order:
//
//   | # | Condition                                 | State                      |
//   |---|-------------------------------------------|----------------------------|
//   | 1 | there are vendor tabs                     | none                       |
//   | 2 | the inventory load failed                 | load_failed                |
//   | 3 | not loaded yet, or loading with no items  | loading                    |
//   | 4 | no items at this store                    | no_items (S1)              |
//   | 5 | items, none with a vendor link            | no_vendor_links (S2)       |
//   | 6 | linked, but no vendor resolves to a tab   | vendors_unresolved         |
//   | 7 | no vendor scheduled for the day           | no_scheduled_vendors (S3)  |
//   | 8 | otherwise                                 | scheduled_vendors_no_items (S4) |
//
// Rows 2 and 3 exist so a failed or unfinished load never reads as an empty store
// (N5). Row 6 exists because `fetchVendors(...).catch(() => [])` also swallows
// failures, so linked items with an empty `vendors` slice mustn't read as "no
// vendor linked" (F-9). That's also why `storeItemsWithLinkCount` comes from the
// items' own vendorIds and not from `allVendorTabs`.

export type EodEmptyState =
  | 'none' | 'loading' | 'load_failed'
  | 'no_items'                    // S1
  | 'no_vendor_links'             // S2
  | 'vendors_unresolved'
  | 'no_scheduled_vendors'        // S3
  | 'scheduled_vendors_no_items'; // S4

/** Spec 184 OD-3 — states with nothing a submit could send: the store has no
 *  items, none of them has a vendor link, or they failed to load. SUBMIT COUNT is
 *  disabled here on desktop and phone, rather than answering with the
 *  "enter at least one count" toast, which contradicts the message on screen. */
export function isNothingToCount(state: EodEmptyState | undefined): boolean {
  return state === 'no_items' || state === 'no_vendor_links' || state === 'load_failed';
}

export function deriveEodEmptyState(input: {
  vendorTabsCount: number; allVendorTabsCount: number;
  storeItemCount: number;
  storeItemsWithLinkCount: number;     // from item vendorIds, NOT allVendorTabs (F-9)
  dayScheduledVendorCount: number;
  inventoryLoadStatus: 'unknown' | 'loaded' | 'failed'; storeLoading: boolean;
}): EodEmptyState {
  const {
    vendorTabsCount, allVendorTabsCount, storeItemCount, storeItemsWithLinkCount,
    dayScheduledVendorCount, inventoryLoadStatus, storeLoading,
  } = input;
  if (vendorTabsCount > 0) return 'none';
  if (inventoryLoadStatus === 'failed') return 'load_failed';
  if (inventoryLoadStatus === 'unknown' || (storeLoading && storeItemCount === 0)) return 'loading';
  if (storeItemCount === 0) return 'no_items';
  if (storeItemsWithLinkCount === 0) return 'no_vendor_links';
  if (allVendorTabsCount === 0) return 'vendors_unresolved';
  if (dayScheduledVendorCount === 0) return 'no_scheduled_vendors';
  return 'scheduled_vendors_no_items';
}
