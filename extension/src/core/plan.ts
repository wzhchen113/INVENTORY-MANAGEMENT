// Spec 132 (D-3) — the ADAPTER-AGNOSTIC planning core. Turns a spec-131 order
// payload into a list of PlannedActions, applying the SHARED order-unit builder
// (computePoQuickOrderLines, 131 D-1/D-7) for the case math so the extension
// authors NO case conversion of its own (AC-6). Pure + total; no DOM, no chrome
// API, no site interaction — unit-testable in isolation (AC-12).

import {
  computePoQuickOrderLines,
  type PoQuickOrderLine,
} from '../../../src/utils/poQuickOrderText';
import type { OrderPayload, PayloadLine, PlannedAction, Resolution } from '../lib/types';
import { isSafeHttpUrl } from './urlGuard';

/**
 * Decide how a single line resolves to a vendor product (AC-4 / AC-5):
 *   • a valid stored product_page_url  → 'url'      (direct navigate — preferred)
 *   • else an order code present       → 'search'   (per-vendor site search)
 *   • else (no code)                   → 'unmapped' (surfaced, never guessed)
 *
 * NOTE: a null order code ALWAYS resolves 'unmapped' even if a URL is absent —
 * the 131 AC-4 gap is reported, never dropped (AC-5). A stored URL rescues a
 * null-code line into 'url' (a direct link needs no code).
 */
export function resolveLine(orderCode: string | null, productPageUrl: string | null): Resolution {
  if (isSafeHttpUrl(productPageUrl)) return 'url';
  if (orderCode && orderCode.trim().length > 0) return 'search';
  return 'unmapped';
}

/**
 * Build the ordered list of PlannedActions from a payload (AC-4). The qty/unit
 * on each action are the shared builder's order-unit-converted values — the
 * extension does not re-derive case math (131 D-1). Line order is preserved.
 */
export function buildPlan(payload: OrderPayload): PlannedAction[] {
  const byId = new Map<string, PayloadLine>();
  const quickLines: PoQuickOrderLine[] = payload.lines.map((l) => {
    byId.set(l.itemId, l);
    return {
      itemId: l.itemId,
      itemName: l.itemName,
      orderedQty: l.orderedQty,
      caseQty: l.caseQty,
    };
  });

  // The shared builder resolves the code (trims, null→unmapped) and converts the
  // quantity to the vendor's order unit (ceil-to-cases for a 'case' vendor).
  const { lines: structured } = computePoQuickOrderLines(
    quickLines,
    (itemId) => byId.get(itemId)?.orderCode ?? null,
    (itemId, fallback) => byId.get(itemId)?.itemName || fallback,
    payload.orderUnit,
  );

  return structured.map((s) => {
    const raw = byId.get(s.itemId);
    const productPageUrl = raw && isSafeHttpUrl(raw.productPageUrl) ? raw.productPageUrl : null;
    return {
      itemId: s.itemId,
      orderCode: s.orderCode,
      itemName: s.itemName,
      qty: s.qty,
      unit: s.unit,
      productPageUrl,
      resolution: resolveLine(s.orderCode, productPageUrl),
    };
  });
}
