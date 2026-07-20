// Spec 132 — shared types for the cart-filler extension.
//
// These mirror the spec-131 RPC output shapes (see
// 20260723000000_extension_ordering.sql: get_pending_extension_orders /
// get_extension_order_payload). Machine-facing JSON — camelCase straight from
// jsonb_build_object, no snake↔camel mapping needed.

/** One row of `get_pending_extension_orders` — a pending PO's summary. */
export interface PendingOrder {
  poId: string;
  storeId: string;
  vendorId: string;
  vendorName: string;
  /** Nullable — BJ's landing / Sam's "Reorder for Pickup using a List" page. */
  orderPageUrl: string | null;
  orderUnit: 'case' | 'unit';
  lineCount: number;
  /** How many lines have no vendor order code (the 131 AC-4 gap). */
  unmappedCount: number;
}

/** One raw structured line of `get_extension_order_payload`. */
export interface PayloadLine {
  itemId: string;
  itemName: string;
  /** item_vendors.order_code for this vendor, or null when unmapped (AC-4). */
  orderCode: string | null;
  /** COUNTED units, verbatim po_items.ordered_qty — NOT case-converted here. */
  orderedQty: number;
  /** inventory catalog case size (>= 1). */
  caseQty: number;
  /** Per-(item, vendor) direct product-page link, or null (the BJ's fallback). */
  productPageUrl: string | null;
}

/** The full structured payload for one pending PO (`get_extension_order_payload`). */
export interface OrderPayload {
  poId: string;
  storeId: string;
  vendorId: string;
  vendorName: string;
  orderPageUrl: string | null;
  orderUnit: 'case' | 'unit';
  lines: PayloadLine[];
}

/**
 * How the extension will resolve a line to a vendor product (AC-4).
 *   'url'      → a valid product_page_url is stored → direct navigate.
 *   'search'   → no URL, but an order code → per-vendor site search.
 *   'unmapped' → no order code (and no usable URL) → surfaced, never guessed (AC-5).
 */
export type Resolution = 'url' | 'search' | 'unmapped';

/**
 * One planned cart action, produced by the ADAPTER-AGNOSTIC core from the
 * payload. `qty`/`unit` are the spec-115 order-unit-CONVERTED values from the
 * shared builder (`computePoQuickOrderLines`) — the extension authors no case
 * math of its own (AC-6, 131 D-1).
 */
export interface PlannedAction {
  itemId: string;
  orderCode: string | null;
  itemName: string;
  qty: number;
  unit: 'case' | 'unit';
  /** Validated http(s) product-page URL, or null (see `resolution`). */
  productPageUrl: string | null;
  resolution: Resolution;
}

/** The per-item report status (AC-7 / AC-10). */
export type ReportStatus =
  | 'added' // matched + added to cart (live run)
  | 'would-add' // matched, dry-run — would add, no side effect (AC-10)
  | 'unmatched' // no order code / no candidate (AC-5)
  | 'ambiguous' // multiple site candidates — never auto-picked (AC-5)
  | 'failed'; // matched but the add-to-cart step errored (AC-6)

/** One row of the per-item success/failure report (AC-7). */
export interface ReportLine {
  itemId: string;
  orderCode: string | null;
  itemName: string;
  qty: number;
  unit: 'case' | 'unit';
  status: ReportStatus;
  detail: string;
}

/**
 * The outcome of the ADAPTER executing one planned action against the live site
 * (content-script side). The adapter-agnostic core turns these + the plan into
 * the report. `challenge` signals an anti-bot / CAPTCHA / login wall was hit —
 * the run STOPS and hands control to the human (AC-9).
 */
export interface ExecutionResult {
  itemId: string;
  outcome: 'added' | 'ambiguous' | 'failed';
  detail: string;
}
