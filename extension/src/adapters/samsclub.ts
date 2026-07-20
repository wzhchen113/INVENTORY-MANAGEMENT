// Spec 132 — Sam's Club (www.samsclub.com) adapter.
//
// Sam's item numbers ARE searchable, so matching is by the line's vendor order
// code (item number) via site search (AC-4), or a stored product_page_url when
// present (preferred, direct navigate). The "Reorder for Pickup using a List"
// Excel bulk upload is a FOLLOW-UP gated on the owner's live-account format check
// (OQ-3/OQ-6, unverified) — NO bulk-upload code in v1. This file owns Sam's
// best-effort DOM selectors; expect owner-observed tuning (AC-11).
//
// ┌─ OWNER-TUNE ZONE ────────────────────────────────────────────────────────┐
// │ The selector strings inside the page* routines are first-pass guesses.     │
// │ Edit ONLY those constants when a live run misfires. Never add a checkout /  │
// │ payment routine (AC-9).                                                     │
// └────────────────────────────────────────────────────────────────────────────┘

import type { PageActionResult, VendorAdapter } from './types';

const SAMS_ORIGIN = 'https://www.samsclub.com';

export const samsClubAdapter: VendorAdapter = {
  key: 'samsclub',
  label: "Sam's Club",

  matchesOrigin(origin: string): boolean {
    return origin === SAMS_ORIGIN;
  },

  // Sam's search endpoint (best-effort). Item numbers are searchable here.
  searchUrl(query: string): string {
    return `${SAMS_ORIGIN}/s/${encodeURIComponent(query)}`;
  },

  pageDetectChallenge(): boolean {
    // AC-9 — stop on any anti-bot / CAPTCHA / interstitial. Best-effort markers.
    const html = document.documentElement.innerHTML.toLowerCase();
    if (document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="challenge" i]')) {
      return true;
    }
    if (document.querySelector('#px-captcha, [class*="px-captcha"], [id*="captcha" i]')) return true;
    return (
      html.includes('verify you are human') ||
      html.includes('are you a human') ||
      html.includes('unusual traffic') ||
      html.includes('robot or human') ||
      html.includes('access denied')
    );
  },

  pageIsLoggedIn(): boolean {
    // AC-9 — detects an existing session only; never logs in.
    if (document.querySelector('[href*="logout" i], [href*="signout" i], [data-automation-id*="account" i]')) {
      return true;
    }
    const text = (document.querySelector('header')?.textContent || '').toLowerCase();
    if (text.includes('sign out') || text.includes('account')) return true;
    const signIn = document.querySelector('[href*="login" i], [data-automation-id*="signin" i]');
    return signIn ? false : true;
  },

  pageAddToCartOnProduct(qty: number): PageActionResult {
    try {
      const qtyInput = document.querySelector<HTMLInputElement>(
        'input[name="quantity" i], input[aria-label*="quantity" i], input[data-automation-id*="quantity" i]',
      );
      if (qtyInput) {
        qtyInput.value = String(qty);
        qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const addBtn = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
        (b) => /add to cart/i.test(b.textContent || '') && !/checkout|place order|pay|continue to/i.test(b.textContent || ''),
      );
      if (!addBtn) return { outcome: 'failed', detail: 'Sam’s: no add-to-cart button found on the product page.' };
      addBtn.click();
      return { outcome: 'added', detail: `Sam’s: clicked add-to-cart (qty ${qty}).` };
    } catch (e) {
      return { outcome: 'failed', detail: `Sam’s: add-to-cart error: ${(e as Error).message}` };
    }
  },

  pagePickSearchResult(query: string): PageActionResult {
    try {
      const tiles = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/" i], a[data-automation-id*="product" i]'),
      ).filter((a) => a.href);
      const seen = new Set<string>();
      const unique = tiles.filter((a) => (seen.has(a.href) ? false : (seen.add(a.href), true)));
      if (unique.length === 0) {
        return { outcome: 'failed', detail: `Sam’s: no search results for item "${query}".` };
      }
      if (unique.length > 1) {
        return { outcome: 'ambiguous', detail: `Sam’s: ${unique.length} results for "${query}" — resolve manually.` };
      }
      return { outcome: 'added', detail: `Sam’s: single match for "${query}".`, url: unique[0].href };
    } catch (e) {
      return { outcome: 'failed', detail: `Sam’s: search error: ${(e as Error).message}` };
    }
  },
};
