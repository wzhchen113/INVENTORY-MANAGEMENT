// Spec 162 (rev 2) — the PURE resolution behind the shipping-address picker.
//
// WHY THIS IS ITS OWN MODULE: the address shown under the picker and the address
// the gate enforces MUST be the same value. Before this, they were two DOM reads
// kept in step by three call sites each remembering to refresh the label — the
// exact shape that lets a popup say "Frederick · 1234 York Rd, Towson" and mean
// it. One pure function now produces BOTH, so they cannot disagree: if the label
// is stale the enforced address is stale in the identical way, and a single test
// covers both.

import type { StoreAddress } from '../lib/types';

export interface StoreSelection {
  /** The store's id, echoed back for the caller to persist. */
  storeId: string | null;
  /**
   * The address that would be ENFORCED at checkout, or null when the selection
   * can't be used. Never a best guess — null means the run is refused.
   */
  address: string | null;
  /** The line rendered under the picker. */
  previewText: string;
  /** True when `previewText` describes a problem the operator has to fix. */
  isError: boolean;
}

const NO_SELECTION = 'Pick the store this order ships to.';

/**
 * Resolve the picked store to the address that will be enforced, plus the line
 * to render under the picker.
 *
 * A store with no address resolves to `address: null` with an error line that
 * NAMES THE FIX. "Invalid selection" is not something an operator can act on;
 * "Frederick has no address in I.M.R yet" is.
 */
export function describeStoreSelection(
  stores: StoreAddress[],
  storeId: string | null | undefined,
): StoreSelection {
  const store = storeId ? stores.find((s) => s.storeId === storeId) : undefined;
  if (!store) {
    return { storeId: null, address: null, previewText: NO_SELECTION, isError: false };
  }
  if (!store.hasAddress || !store.address || !store.address.trim()) {
    return {
      storeId: store.storeId,
      address: null,
      previewText: `${store.storeName} has no address in I.M.R yet — add one on the store, then reopen this popup.`,
      isError: true,
    };
  }
  return {
    storeId: store.storeId,
    address: store.address,
    previewText: store.address,
    isError: false,
  };
}

/**
 * Which store the picker should show, in priority order: the operator's last
 * pick (if it's still a visible store), else the store of the PO in hand, else
 * the first store. Returns null when there are no stores at all.
 *
 * Pure so the precedence is testable without a popup — "my saved pick wins over
 * the PO's store" is a rule, not an implementation detail.
 */
export function preferredStoreId(
  stores: StoreAddress[],
  storedStoreId: string | null | undefined,
  poStoreId: string | null | undefined,
): string | null {
  if (stores.length === 0) return null;
  if (storedStoreId && stores.some((s) => s.storeId === storedStoreId)) return storedStoreId;
  if (poStoreId && stores.some((s) => s.storeId === poStoreId)) return poStoreId;
  return stores[0].storeId;
}
