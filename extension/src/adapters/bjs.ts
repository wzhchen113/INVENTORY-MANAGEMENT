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

  cartUrl: `${BJS_ORIGIN}/cart`,

  matchesOrigin(origin: string): boolean {
    // OWNER-TUNED (live 2026-07-20): accept ANY https bjs.com subdomain —
    // exact-origin equality broke tab recognition off the www host.
    try {
      const u = new URL(origin);
      return u.protocol === 'https:' && (u.hostname === 'bjs.com' || u.hostname.endsWith('.bjs.com'));
    } catch {
      return false;
    }
  },

  // BJ's site search endpoint (best-effort). Owner-tune if the search route changes.
  searchUrl(query: string): string {
    return `${BJS_ORIGIN}/search/${encodeURIComponent(query)}`;
  },

  pageDetectChallenge: (): boolean => {
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

  pageIsLoggedIn: (): boolean => {
    // AC-9 — never logs in for the user; only detects an existing session.
    // Best-effort: an account/sign-out affordance implies a live session.
    if (document.querySelector('[href*="logout" i], [href*="signout" i], [data-testid*="account" i]')) {
      return true;
    }
    const text = (document.querySelector('header')?.textContent || '').toLowerCase();
    if (text.includes('sign out') || text.includes('my account')) return true;
    // OWNER-TUNED (live 2026-07-20): a signed-in bjs.com header greets the
    // member — "Hi, Kenny · Rewards: $26.26". Either token is a positive.
    if (/\bhi,\s*\S/.test(text) || text.includes('rewards')) return true;
    // A sign-in affordance IN THE HEADER implies NOT logged in. Scoped to the
    // header on purpose: bjs.com keeps sign-in links in the footer of EVERY
    // page (logged in or not), which made the page-wide check a false negative
    // that blocked live runs for a signed-in member.
    const signIn = document
      .querySelector('header')
      ?.querySelector('[href*="signin" i], [href*="login" i]');
    return signIn ? false : true;
  },

  pageAddToCartOnProduct: async (qty: number): Promise<PageActionResult> => {
    // OWNER-TUNED (live 2026-07-20): bjs.com is a React SPA — the add-to-cart
    // button renders well AFTER document-complete, so the original immediate
    // querySelector always missed it ("paused" on the first product page).
    // Poll up to ~12s. Also: (a) "add to list" REMOVED from the finder — that
    // button files items into a shopping list, not the cart; (b) qty is set
    // via the native value setter so React's controlled input sees the change.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // Collect clickables across the document INCLUDING open shadow roots and
    // anchor-styled buttons; only count VISIBLE ones (SPA pages keep hidden
    // template/duplicate buttons in the DOM that swallow naive clicks).
    const clickables = (): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const walk = (root: Document | ShadowRoot) => {
        root.querySelectorAll<HTMLElement>('button, [role="button"], a').forEach((el) => out.push(el));
        root.querySelectorAll<HTMLElement>('*').forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      };
      walk(document);
      return out.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      });
    };
    // VERIFIED LIVE (2026-07-20, DOM-inspected in the owner's session):
    // bjs.com ships its own automation attributes —
    //   add-to-cart : button[auto-data="product_addToCartBtn"] (2 in DOM; use the VISIBLE one)
    //   qty input   : input[auto-data="product_quantityIndValue"] (native setter verified: qty stuck)
    //   qty +/-     : button[auto-data="product_incQuantity"] / product_decQuantity
    //   cart badge  : [class*="CartCount"] inside .mini-cart (counts UNITS; 2→9 on a qty-7 add)
    // A plain .click() on the real visible button WORKS (badge-verified).
    const visible = (el: HTMLElement | null): el is HTMLElement => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };
    try {
      let addBtn: HTMLElement | undefined;
      for (let i = 0; i < 24 && !addBtn; i++) {
        addBtn =
          Array.from(document.querySelectorAll<HTMLElement>('button[auto-data="product_addToCartBtn"]')).find(visible) ??
          clickables().find(
            (b) =>
              /add to cart/i.test(b.textContent || '') &&
              !/checkout|place order|pay|add to list/i.test(b.textContent || ''),
          );
        if (!addBtn) await sleep(500);
      }
      if (!addBtn) {
        // DIAGNOSTIC failure: name what IS on the page so the owner's
        // screenshot tells us the exact label/shape to target next.
        const labels = [...new Set(
          clickables()
            .map((b) => (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40))
            .filter((t) => t && /add|cart|deliver|pickup|club/i.test(t)),
        )].slice(0, 8);
        return {
          outcome: 'failed',
          detail: `BJ’s: no add-to-cart button appeared within 12s. Visible candidates: ${labels.length ? labels.join(' | ') : '(none matching add/cart)'}.`,
        };
      }
      if ((addBtn as HTMLButtonElement).disabled || addBtn.getAttribute('aria-disabled') === 'true') {
        return { outcome: 'failed', detail: 'BJ’s: add-to-cart is DISABLED — the page may need a delivery/pickup or club selection first.' };
      }
      // Full pointer sequence — React handlers can ignore a bare .click()
      // (same lesson as this app's own RN-web buttons).
      const dispatchClick = async (el: HTMLElement) => {
        el.scrollIntoView({ block: 'center' });
        await sleep(120);
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        for (const [type, Ctor] of [
          ['pointerdown', PointerEvent],
          ['mousedown', MouseEvent],
          ['pointerup', PointerEvent],
          ['mouseup', MouseEvent],
          ['click', MouseEvent],
        ] as const) {
          el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
        }
      };
      // OWNER-TUNED (live 2026-07-20, run 4): SELF-CORRECTING quantity loop.
      // Run-4 lesson: late hydration RESETS the qty input to 1 after we set it
      // (only the slow first page kept the value), so items landed with qty 1.
      // The badge counts UNITS (verified 2→9 on a qty-7 add), so we can MEASURE
      // each add and re-add the remainder until the delta totals the PO qty.
      const cartCount = (): number | null => {
        const el =
          document.querySelector('[class*="CartCount"]') ??
          document.querySelector('[class*="cart-count" i], [data-testid*="cart" i] [class*="badge" i]');
        const n = parseInt((el?.textContent || '').replace(/\D/g, ''), 10);
        return Number.isFinite(n) ? n : null;
      };
      const findQtyInput = () =>
        Array.from(document.querySelectorAll<HTMLInputElement>('input[auto-data="product_quantityIndValue"]')).find(visible) ??
        Array.from(document.querySelectorAll<HTMLInputElement>(
          'input[name="quantity" i], input[id*="qty" i], input[aria-label*="quantity" i]',
        )).find(visible);
      const setQty = async (n: number): Promise<boolean> => {
        const qi = findQtyInput();
        if (!qi) return false;
        const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        nativeSet?.call(qi, String(n));
        qi.dispatchEvent(new Event('input', { bubbles: true }));
        qi.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(400);
        // Verify against the hydration-reset race; one re-set if it bounced.
        const check = findQtyInput();
        if (check && check.value !== String(n)) {
          nativeSet?.call(check, String(n));
          check.dispatchEvent(new Event('input', { bubbles: true }));
          check.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(400);
          return findQtyInput()?.value === String(n);
        }
        return true;
      };
      let addedUnits = 0;
      let rounds = 0;
      while (addedUnits < qty && rounds < 4) {
        rounds++;
        const target = qty - addedUnits;
        // eslint-disable-next-line no-await-in-loop
        await setQty(target); // best-effort; the badge delta is the truth either way
        const before = cartCount();
        // Re-find the button each round — the SPA may re-render it.
        const btn =
          Array.from(document.querySelectorAll<HTMLElement>('button[auto-data="product_addToCartBtn"]')).find(visible) ?? addBtn;
        // eslint-disable-next-line no-await-in-loop
        await dispatchClick(btn);
        let delta = 0;
        for (let i = 0; i < 20; i++) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(500);
          const after = cartCount();
          if (before !== null && after !== null && after > before) {
            delta = after - before;
            break;
          }
        }
        if (delta === 0) break; // no badge movement this round — stop retrying
        addedUnits += delta;
        // eslint-disable-next-line no-await-in-loop
        await sleep(400); // let the mini-cart settle before another round
      }
      if (addedUnits === 0) {
        return { outcome: 'failed', detail: `BJ’s: add-to-cart clicked but the cart badge never moved (wanted qty ${qty}) — verify in cart.` };
      }
      if (addedUnits < qty) {
        return { outcome: 'added', detail: `BJ’s: PARTIAL — badge confirmed ${addedUnits} of ${qty} units after ${rounds} attempts; bump the rest in the cart.` };
      }
      if (addedUnits > qty) {
        return { outcome: 'added', detail: `BJ’s: badge confirmed ${addedUnits} units (wanted ${qty}) — remove the extra in the cart.` };
      }
      return { outcome: 'added', detail: `BJ’s: CONFIRMED exactly qty ${qty} by cart badge.` };
    } catch (e) {
      return { outcome: 'failed', detail: `BJ’s: add-to-cart error: ${(e as Error).message}` };
    }
  },

  pagePickSearchResult: (query: string): PageActionResult => {
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
