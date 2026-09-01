// Spec 132 — the popup ↔ background message protocol. A small discriminated
// union; the background is the only place that touches supabase-js + chrome
// tabs/scripting, so the popup stays a thin UI.

import type { CheckoutStage } from '../core/checkout';
import type { PendingOrder, ReportLine, StoreAddress } from './types';

export type Request =
  | { type: 'AUTH_STATUS' }
  | { type: 'SIGN_IN'; email: string; password: string }
  | { type: 'SIGN_OUT' }
  | { type: 'PENDING_FOR_TAB' }
  | { type: 'RUN'; poId: string; dryRun: boolean }
  | { type: 'MARK_ORDERED'; poId: string; dryRun: boolean }
  // Spec 162 rev 2 — the stores + addresses behind the shipping-address picker.
  | { type: 'STORE_ADDRESSES' }
  // Spec 162 — fill the cart AND place the order. All three guards travel WITH
  // the request rather than being read in the background, so what the popup
  // showed the operator is provably what the gates used.
  //
  // All three are REQUIRED: there is no uncapped auto-place, no "ship wherever
  // BJ's defaults to", and no "charge whatever card is selected".
  // `expectedCardLast4` is four digits — an identifier for a card BJ's already
  // holds, never a card number, and never sent anywhere but this gate.
  //
  // `expectedAddress` is resolved by the POPUP from the store the operator
  // picked, not typed. It still travels as text because the gate compares it to
  // what BJ's renders — the background has no business re-reading a store row
  // the operator already chose from.
  | {
      type: 'PLACE_ORDER';
      poId: string;
      dryRun: boolean;
      capTotal: number;
      expectedAddress: string;
      expectedCardLast4: string;
    };

export interface AuthStatusResponse {
  signedIn: boolean;
  email: string | null;
  error: string | null;
}

export interface PendingResponse {
  /** Pending POs matched to the CURRENT tab's vendor origin (AC-3), or []. */
  orders: PendingOrder[];
  /** The current tab origin, for display. */
  origin: string | null;
  /** True if the current tab is one of the two host-permitted vendor sites. */
  onVendorSite: boolean;
  /**
   * Spec 162 — true only when this vendor's adapter declares a `checkout` block
   * (BJ's yes, Sam's Club no). The popup hides the whole auto-place arm when
   * false, so the operator is never offered a button the background would
   * refuse.
   */
  canAutoPlace: boolean;
  error: string | null;
}

export interface RunResponse {
  report: ReportLine[];
  /** Set when the run STOPPED on an AC-9 boundary (challenge / not-logged-in). */
  stopped: null | { reason: 'challenge' | 'not-logged-in'; detail: string };
  dryRun: boolean;
  error: string | null;
}

export interface StoreAddressesResponse {
  stores: StoreAddress[];
  error: string | null;
}

export interface MarkOrderedResponse {
  /** Rows updated: 1 on a real draft→sent transition, 0 on a no-op/blocked. */
  updated: number;
  /** True when the write was suppressed because dry-run is on (AC-10). */
  suppressedByDryRun: boolean;
  error: string | null;
}

/**
 * Spec 162 — the auto-place outcome. `outcome === 'placed'` is true ONLY when
 * BJ's returned an order number (AC-5); every other terminal shape is 'failed'
 * with a `stage` saying where it died.
 */
export interface PlaceOrderResponse {
  /** The cart-fill report that preceded the placement attempt. */
  report: ReportLine[];
  dryRun: boolean;
  /** null when dry-run suppressed the live arm, or the run never got that far. */
  outcome: 'placed' | 'failed' | null;
  stage: CheckoutStage | null;
  detail: string;
  vendorOrderNumber: string | null;
  cartTotal: number | null;
  capTotal: number;
  /** True when dry-run suppressed the whole live arm (AC-1). */
  suppressedByDryRun: boolean;
  /** The `vendor_order_attempts` row id written to I.M.R, or null. */
  attemptId: string | null;
  /**
   * Set when the ATTEMPT RECORD itself could not be written. Surfaced
   * separately from `detail` because it means the outcome is real but I.M.R
   * does NOT know about it — so no notification and no email went out, and the
   * operator is the only one who can see what happened.
   */
  recordError: string | null;
  error: string | null;
}

export type Response =
  | AuthStatusResponse
  | PendingResponse
  | RunResponse
  | MarkOrderedResponse
  | StoreAddressesResponse
  | PlaceOrderResponse
  | { error: string | null };
