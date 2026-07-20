// Spec 132 (D-3 step 1, OQ-5) — the vendor↔site join. The extension matches the
// current tab origin to a pending PO via `new URL(order_page_url).origin` (131
// D-2) — there is no separate origin field and no fixed extension-side map.
// Pure + total; unit-testable (AC-12).

import type { PendingOrder } from '../lib/types';
import { safeOrigin } from './urlGuard';

/**
 * Given the pending set and the current tab origin, return the pending POs whose
 * vendor's order_page_url shares that origin (AC-3). A pending order with a
 * null/unsafe order_page_url can NOT be origin-matched and is excluded (the
 * extension does not act on a site it can't positively map to a vendor).
 *
 * Multiple pending POs can match (e.g. two draft POs for the same vendor); the
 * caller (popup) lets the human pick. On a site with no match → `[]` → the
 * extension does nothing (AC-3).
 */
export function pendingOrdersForOrigin(
  pending: PendingOrder[],
  currentOrigin: string,
): PendingOrder[] {
  const target = safeOrigin(currentOrigin);
  if (!target) return [];
  return pending.filter((p) => {
    const o = safeOrigin(p.orderPageUrl);
    return o !== null && o === target;
  });
}
