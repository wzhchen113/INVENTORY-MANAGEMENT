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
// HARD BOUNDARY (AC-9): no adapter has a checkout/payment routine, none reads or
// stores a vendor credential, and every page routine bails on a detected
// challenge. `pageDetectChallenge` is the required challenge-detection stop.

/** In-page routine return shape (must be JSON-serializable across the bridge). */
export interface PageActionResult {
  outcome: 'added' | 'ambiguous' | 'failed';
  detail: string;
  /** For a search hit, the resolved product URL (informational). */
  url?: string;
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
}
