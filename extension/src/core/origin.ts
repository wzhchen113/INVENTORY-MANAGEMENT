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
/**
 * Registrable-site key for an https origin/URL: the last two hostname labels
 * ("www.bjs.com" → "bjs.com"). OWNER-TUNED (live 2026-07-20): exact-origin
 * equality was too strict — a tab on any bjs.com subdomain (or a saved
 * order_page_url on one) failed the match and the popup claimed "not a vendor
 * tab" with the pending PO invisible. Both club sites use flat two-label
 * domains, so the suffix key is safe here.
 */
export function siteKey(originOrUrl: string | null): string | null {
  const o = safeOrigin(originOrUrl);
  if (!o) return null;
  const host = new URL(o).hostname;
  const parts = host.split('.');
  if (parts.length < 2) return null;
  return parts.slice(-2).join('.');
}

export function pendingOrdersForOrigin(
  pending: PendingOrder[],
  currentOrigin: string,
): PendingOrder[] {
  const target = siteKey(currentOrigin);
  if (!target) return [];
  return pending.filter((p) => siteKey(p.orderPageUrl) === target);
}
