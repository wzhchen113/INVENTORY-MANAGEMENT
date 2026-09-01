// Spec 132 (D-3/D-4) — the per-vendor adapter contract. ONE adapter module per
// vendor (bjs.ts, samsclub.ts), each owning that site's best-effort DOM
// selectors. Two halves:
//
//   • PURE, unit-testable (AC-12): `key`, `label`, `matchesOrigin`, `searchUrl`.
//   • PAGE-CONTEXT routines injected into the tab via
//     chrome.scripting.executeScript — `pageDetectChallenge`, `pageIsLoggedIn`,
//     `pageAddToCartOnProduct`, `pagePickSearchResult`. These run in the vendor
//     page's world, so they MUST be self-contained (reference only their args +
//     the DOM — no module-scope helpers, they are serialized by Chrome). Their
//     selectors are BEST-EFFORT and expected to need owner-observed tuning
//     against real accounts (AC-11 / OQ-6); they are NOT unit-tested against
//     live sites.
//
// HARD BOUNDARY (spec 132 AC-9), AMENDED BY SPEC 162: no adapter reads or
// stores a vendor credential, none logs in for the operator, and every page
// routine bails on a detected challenge. `pageDetectChallenge` is the required
// challenge-detection stop.
//
// SPEC 162 carves ONE hole in the "no checkout/payment routine" half of that
// boundary, at the owner's explicit instruction: an adapter MAY declare a
// `checkout` block that drives the vendor's OWN checkout to the vendor's OWN
// place-order button, using whatever payment the vendor already has on file.
// It is OPTIONAL by design — Sam's Club opts out by omitting it and keeps the
// spec-132 fill-then-pay-by-hand flow untouched. The credential half of the
// boundary is NOT amended: an adapter still never types a password or a card
// number.

/** In-page routine return shape (must be JSON-serializable across the bridge). */
export interface PageActionResult {
  outcome: 'added' | 'ambiguous' | 'failed';
  detail: string;
  /** For a search hit, the resolved product URL (informational). */
  url?: string;
}

/**
 * Spec 162 — what a page-context checkout step reports back. `ok: false` always
 * carries a `detail` the operator can act on; the SERVICE WORKER decides which
 * `CheckoutStage` that maps to, so the page routines stay dumb about the audit
 * schema.
 */
export interface CheckoutStepResult {
  ok: boolean;
  detail: string;
}

/** Spec 162 — the live cart read that feeds the pure gate (AC-2 / AC-3). */
export interface CartReadResult {
  /** Distinct product rows in the cart, or null when the page can't be read. */
  lineCount: number | null;
  /** Raw subtotal text as it appears on the page; parsed by core/checkout. */
  totalText: string | null;
  detail: string;
}

/**
 * Spec 162 (revision) — what the checkout review step says about WHERE the
 * order ships and WHICH card pays. Read-only; the gate in core/checkout decides
 * what to do about it.
 */
export interface SelectionReadResult {
  addressText: string | null;
  cardLast4: string | null;
  /** Addresses BJ's offers to switch to. Empty on a single-address account. */
  addressOptions: string[];
  detail: string;
}

/** Spec 162 — the terminal confirmation read (AC-5). */
export interface ConfirmationResult {
  /** The vendor's own order number. Its PRESENCE is the definition of success. */
  orderNumber: string | null;
  detail: string;
}

/**
 * Spec 162 — the OPTIONAL checkout half of an adapter. An adapter without this
 * block cannot be auto-placed; the service worker refuses before any side
 * effect. All four routines are PAGE-CONTEXT and therefore self-contained (DOM +
 * args only, arrow-function properties — see `runInPage`'s serialization note).
 */
export interface VendorCheckout {
  /** The vendor's checkout entry URL, navigated to only AFTER the gate passes. */
  checkoutUrl: string;
  /** Read the live cart for the pre-checkout gate. Never mutates the cart. */
  pageReadCart: () => CartReadResult | Promise<CartReadResult>;
  /** Advance the vendor's checkout to the final review/place step. */
  pageStartCheckout: () => CheckoutStepResult | Promise<CheckoutStepResult>;
  /**
   * Read the shipping address + card off the review step. Read-only — it must
   * not change a selection, because the gate has not run yet.
   */
  pageReadSelections: () => SelectionReadResult | Promise<SelectionReadResult>;
  /**
   * Switch the delivery address to `target` (one of the options a prior
   * `pageReadSelections` reported). The caller ALWAYS re-reads and re-gates
   * afterwards — a switch is never trusted to have worked.
   */
  pageSelectAddress: (target: string) => CheckoutStepResult | Promise<CheckoutStepResult>;
  /** Click the vendor's OWN place-order control. The money-spending step. */
  pagePlaceOrder: () => CheckoutStepResult | Promise<CheckoutStepResult>;
  /** Read the confirmation page. No order number ⇒ NOT placed (AC-5). */
  pageReadConfirmation: () => ConfirmationResult | Promise<ConfirmationResult>;
}

export type VendorKey = 'bjs' | 'samsclub';

export interface VendorAdapter {
  key: VendorKey;
  label: string;

  /** PURE — does this adapter own the given site origin? (unit-tested) */
  matchesOrigin(origin: string): boolean;

  /** PURE — build the site search URL for a query (order code / name). (unit-tested) */
  searchUrl(query: string): string;

  /**
   * PAGE-CONTEXT — true if the current page is a CAPTCHA / bot challenge /
   * interstitial / login wall. On true the caller STOPS and hands control to the
   * human (AC-9). Self-contained: DOM-only, no external refs.
   */
  pageDetectChallenge: () => boolean;

  /**
   * PAGE-CONTEXT — true if the admin appears logged in on the vendor site. On
   * false the caller STOPS and asks the human to log in (AC-9 — never logs in
   * for them). Self-contained.
   */
  pageIsLoggedIn: () => boolean;

  /**
   * PAGE-CONTEXT — on a product page, set the quantity and click the site's own
   * add-to-cart control. Returns 'added' | 'failed'. Never proceeds to checkout
   * (AC-9). Self-contained; `qty` is the only arg.
   */
  /** The vendor's cart page — the live run parks the tab here when done. */
  cartUrl: string;

  // May be async: SPA product pages render the add-to-cart button AFTER
  // document-complete, so adapters poll for it (chrome.scripting awaits a
  // returned Promise and resolves to its value).
  pageAddToCartOnProduct: (qty: number) => PageActionResult | Promise<PageActionResult>;

  /**
   * PAGE-CONTEXT — on a search-results page, resolve the query to a single
   * product. Zero results → 'failed'; multiple → 'ambiguous' (never auto-picks —
   * AC-5). A single confident hit returns its product URL for the caller to
   * navigate + add. Self-contained; `query` is the only arg.
   */
  pagePickSearchResult: (query: string) => PageActionResult;

  /**
   * Spec 162 — OPTIONAL auto-place block. Present on BJ's, ABSENT on Sam's Club.
   * The service worker treats absence as "this vendor cannot be auto-placed" and
   * refuses the run rather than falling back to anything.
   */
  checkout?: VendorCheckout;
}
