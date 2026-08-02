// src/utils/orderChannel.ts
//
// Spec 149 §7.2 — PURE, framework-free resolution of a vendor's ORDER CHANNEL.
// The display-side mirror of the SQL `public.vendor_order_channel(uuid)`
// (spec 149 §1.1): both implement the SAME eight-row truth table, jest pins the
// TS side and pgTAP pins the SQL side. The duplication is DELIBERATE (design
// §7.2): a DB round-trip per vendor per render is not acceptable, and the
// Instacart edge-function bundle is a separate Deno build that can import
// neither. Read this as intent, not drift.
//
// Precedence (R-3) — `vendors.extension_ordering` (specs 131/132) stays the
// source of truth for the cart-filler path, and the NEW `order_channel` column
// can never contradict it:
//
//   | order_channel  | instacartRetailerKey | extensionOrdering | ⇒ resolved  |
//   |----------------|----------------------|-------------------|-------------|
//   | 'instacart'    | 'sams_club'          | true              | instacart   |  ← only case that beats the flag
//   | 'instacart'    | null / ''            | true              | extension   |  ← BJ's stays on the tuned cart-filler
//   | 'instacart'    | null / ''            | false             | manual      |
//   | 'webstaurant'  | —                    | true              | extension   |
//   | 'webstaurant'  | —                    | false             | webstaurant |
//   | 'extension'    | —                    | false             | manual      |  ← column cannot contradict the flag
//   | null           | —                    | true              | extension   |
//   | null           | —                    | false             | manual      |
//
// No React, no supabase, no theme, no i18n import — same purity discipline as
// `poCaseDisplay.ts` / `formatQty.ts`.

/** The four terminal order destinations for APPROVE & ORDER (spec 149 AC-14). */
export type OrderChannel = 'instacart' | 'webstaurant' | 'extension' | 'manual';

/** The four literals `vendors.order_channel` accepts (NULL = unset). */
export const ORDER_CHANNELS: readonly OrderChannel[] = [
  'instacart',
  'webstaurant',
  'extension',
  'manual',
] as const;

/** Narrowing guard for an untrusted string (a DB row read in a mixed window,
 *  a form value, an edge-function body). Anything else ⇒ treat as unset. */
export function isOrderChannel(v: unknown): v is OrderChannel {
  return typeof v === 'string' && (ORDER_CHANNELS as readonly string[]).includes(v);
}

/**
 * Resolve the ONE channel a vendor's APPROVE & ORDER button routes to.
 * PURE + total: every input combination lands on exactly one of the four.
 *
 * `instacartRetailerKey` is treated as present only when it trims to a
 * non-empty string — mirroring the SQL `nullif(btrim(coalesce(key,'')),'')`
 * so a whitespace-only key does NOT enable the Instacart path.
 */
export function resolveOrderChannel(v: {
  orderChannel?: string | null;
  instacartRetailerKey?: string | null;
  extensionOrdering: boolean;
}): OrderChannel {
  const hasRetailerKey = (v.instacartRetailerKey ?? '').trim().length > 0;
  if (v.orderChannel === 'instacart' && hasRetailerKey) return 'instacart';
  if (v.extensionOrdering) return 'extension';
  if (v.orderChannel === 'webstaurant') return 'webstaurant';
  return 'manual';
}
