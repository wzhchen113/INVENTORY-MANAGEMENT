// Spec 132 — BJ's Wholesale (www.bjs.com) adapter.
//
// BJ's has NO item-number / quick-order entry (verified vendor research, spec
// 131/132) — so matching is by a stored product_page_url (preferred, direct
// navigate) or site SEARCH on the order code / item name (AC-4). This file owns
// BJ's best-effort DOM selectors; they WILL drift and are expected to need
// owner-observed tuning against a real account (AC-11). The page-context
// routines are self-contained (DOM + args only) because Chrome serializes them
// into the tab's world.
//
// ┌─ OWNER-TUNE ZONE ────────────────────────────────────────────────────────┐
// │ The selector strings below are first-pass guesses. When the owner runs the │
// │ extension live and an add-to-cart / login / challenge check misfires, edit │
// │ ONLY the constants inside the page* routines. Everything else is stable.   │
// └────────────────────────────────────────────────────────────────────────────┘

import type { PageActionResult, VendorAdapter } from './types';

const BJS_ORIGIN = 'https://www.bjs.com';

export const bjsAdapter: VendorAdapter = {
  key: 'bjs',
  label: "BJ's Wholesale",

  matchesOrigin(origin: string): boolean {
    return origin === BJS_ORIGIN;
  },

  // BJ's site search endpoint (best-effort). Owner-tune if the search route changes.
  searchUrl(query: string): string {
    return `${BJS_ORIGIN}/search/${encodeURIComponent(query)}`;
  },

  pageDetectChallenge(): boolean {
    // AC-9 — stop on any anti-bot / CAPTCHA / interstitial. Best-effort markers.
    const html = document.documentElement.innerHTML.toLowerCase();
    if (document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="challenge" i]')) {
      return true;
    }
    if (document.querySelector('#px-captcha, [class*="px-captcha"], [id*="captcha" i]')) return true;
    return (
      html.includes('are you a human') ||
      html.includes('verify you are human') ||
      html.includes('unusual traffic') ||
      html.includes('access denied')
    );
  },

  pageIsLoggedIn(): boolean {
    // AC-9 — never logs in for the user; only detects an existing session.
    // Best-effort: an account/sign-out affordance implies a live session.
    if (document.querySelector('[href*="logout" i], [href*="signout" i], [data-testid*="account" i]')) {
      return true;
    }
    const text = (document.querySelector('header')?.textContent || '').toLowerCase();
    if (text.includes('sign out') || text.includes('my account')) return true;
    // A visible "sign in" prompt implies NOT logged in.
    const signIn = document.querySelector('[href*="signin" i], [href*="login" i]');
    return signIn ? false : true;
  },

  pageAddToCartOnProduct(qty: number): PageActionResult {
    try {
      // Best-effort qty field + add-to-cart button. Owner-tune these selectors.
      const qtyInput = document.querySelector<HTMLInputElement>(
        'input[name="quantity" i], input[id*="qty" i], input[aria-label*="quantity" i]',
      );
      if (qtyInput) {
        qtyInput.value = String(qty);
        qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const addBtn = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
        (b) => /add to cart|add to list/i.test(b.textContent || '') && !/checkout|place order|pay/i.test(b.textContent || ''),
      );
      if (!addBtn) return { outcome: 'failed', detail: 'BJ’s: no add-to-cart button found on the product page.' };
      addBtn.click();
      return { outcome: 'added', detail: `BJ’s: clicked add-to-cart (qty ${qty}).` };
    } catch (e) {
      return { outcome: 'failed', detail: `BJ’s: add-to-cart error: ${(e as Error).message}` };
    }
  },

  pagePickSearchResult(query: string): PageActionResult {
    try {
      // Best-effort product-tile selector on the search results grid.
      const tiles = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href*="/product/" i], a[data-testid*="product" i]'),
      ).filter((a) => a.href);
      const seen = new Set<string>();
      const unique = tiles.filter((a) => (seen.has(a.href) ? false : (seen.add(a.href), true)));
      if (unique.length === 0) {
        return { outcome: 'failed', detail: `BJ’s: no search results for "${query}".` };
      }
      if (unique.length > 1) {
        // AC-5 — never auto-pick among multiple candidates.
        return { outcome: 'ambiguous', detail: `BJ’s: ${unique.length} results for "${query}" — resolve manually.` };
      }
      return { outcome: 'added', detail: `BJ’s: single match for "${query}".`, url: unique[0].href };
    } catch (e) {
      return { outcome: 'failed', detail: `BJ’s: search error: ${(e as Error).message}` };
    }
  },
};
