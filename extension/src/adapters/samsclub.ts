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

  cartUrl: `${SAMS_ORIGIN}/cart`,

  matchesOrigin(origin: string): boolean {
    // OWNER-TUNED (live 2026-07-20): accept ANY https samsclub.com subdomain —
    // exact-origin equality broke tab recognition off the www host.
    try {
      const u = new URL(origin);
      return u.protocol === 'https:' && (u.hostname === 'samsclub.com' || u.hostname.endsWith('.samsclub.com'));
    } catch {
      return false;
    }
  },

  // Sam's search endpoint (best-effort). Item numbers are searchable here.
  searchUrl(query: string): string {
    return `${SAMS_ORIGIN}/s/${encodeURIComponent(query)}`;
  },

  pageDetectChallenge: (): boolean => {
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

  pageIsLoggedIn: (): boolean => {
    // AC-9 — detects an existing session only; never logs in.
    if (document.querySelector('[href*="logout" i], [href*="signout" i], [data-automation-id*="account" i]')) {
      return true;
    }
    const text = (document.querySelector('header')?.textContent || '').toLowerCase();
    if (text.includes('sign out') || text.includes('account')) return true;
    // Signed-in samsclub.com headers greet the member ("Hello, <name>") —
    // mirror of the bjs.ts owner-tuned greeting positive (2026-07-20).
    if (/\bhello,\s*\S/.test(text) || /\bhi,\s*\S/.test(text)) return true;
    // Sign-in affordance IN THE HEADER only — footer sign-in links exist on
    // every page and must not read as "not logged in" (bjs.ts false-negative
    // fix, applied here preemptively).
    const signIn = document
      .querySelector('header')
      ?.querySelector('[href*="login" i], [data-automation-id*="signin" i]');
    return signIn ? false : true;
  },

  pageAddToCartOnProduct: async (qty: number): Promise<PageActionResult> => {
    // Mirror of the bjs.ts owner-tune (2026-07-20): SPA product pages render
    // the add-to-cart button after document-complete — poll up to ~12s; set
    // qty via the native setter for React-controlled inputs.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // Mirror of the bjs.ts owner-tune: visible clickables incl. open shadow
    // roots + anchors; diagnostic labels on failure; disabled-state check.
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
    try {
      let addBtn: HTMLElement | undefined;
      for (let i = 0; i < 24 && !addBtn; i++) {
        addBtn = clickables().find(
          (b) =>
            /add to cart/i.test(b.textContent || '') &&
            !/checkout|place order|pay|continue to|add to list/i.test(b.textContent || ''),
        );
        if (!addBtn) await sleep(500);
      }
      if (!addBtn) {
        const labels = [...new Set(
          clickables()
            .map((b) => (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40))
            .filter((t) => t && /add|cart|deliver|pickup|club/i.test(t)),
        )].slice(0, 8);
        return {
          outcome: 'failed',
          detail: `Sam’s: no add-to-cart button appeared within 12s. Visible candidates: ${labels.length ? labels.join(' | ') : '(none matching add/cart)'}.`,
        };
      }
      if ((addBtn as HTMLButtonElement).disabled || addBtn.getAttribute('aria-disabled') === 'true') {
        return { outcome: 'failed', detail: 'Sam’s: add-to-cart is DISABLED — the page may need a delivery/pickup or club selection first.' };
      }
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
      // Mirror of the bjs.ts run-4 owner-tune: SELF-CORRECTING quantity loop —
      // hydration can reset the qty input to 1 after we set it, so measure the
      // cart-badge DELTA per add and re-add the remainder until it totals qty.
      const visible = (el: HTMLElement | null): el is HTMLElement => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const cartCount = (): number | null => {
        const el = document.querySelector(
          '[class*="cartCount" i], [class*="cart-count" i], [class*="CartCount"], [data-automation-id*="cart" i] [class*="badge" i]',
        );
        const n = parseInt((el?.textContent || '').replace(/\D/g, ''), 10);
        return Number.isFinite(n) ? n : null;
      };
      const findQtyInput = () =>
        Array.from(document.querySelectorAll<HTMLInputElement>(
          'input[name="quantity" i], input[aria-label*="quantity" i], input[data-automation-id*="quantity" i]',
        )).find(visible);
      const setQty = async (n: number): Promise<boolean> => {
        const qi = findQtyInput();
        if (!qi) return false;
        const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        nativeSet?.call(qi, String(n));
        qi.dispatchEvent(new Event('input', { bubbles: true }));
        qi.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(400);
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
        // eslint-disable-next-line no-await-in-loop
        await setQty(qty - addedUnits);
        const before = cartCount();
        // eslint-disable-next-line no-await-in-loop
        await dispatchClick(addBtn);
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
        if (delta === 0) break;
        addedUnits += delta;
        // eslint-disable-next-line no-await-in-loop
        await sleep(400);
      }
      if (addedUnits === 0) {
        return { outcome: 'failed', detail: `Sam’s: add-to-cart clicked but the cart badge never moved (wanted qty ${qty}) — verify in cart.` };
      }
      if (addedUnits < qty) {
        return { outcome: 'added', detail: `Sam’s: PARTIAL — badge confirmed ${addedUnits} of ${qty} units after ${rounds} attempts; bump the rest in the cart.` };
      }
      if (addedUnits > qty) {
        return { outcome: 'added', detail: `Sam’s: badge confirmed ${addedUnits} units (wanted ${qty}) — remove the extra in the cart.` };
      }
      return { outcome: 'added', detail: `Sam’s: CONFIRMED exactly qty ${qty} by cart badge.` };
    } catch (e) {
      return { outcome: 'failed', detail: `Sam’s: add-to-cart error: ${(e as Error).message}` };
    }
  },

  pagePickSearchResult: (query: string): PageActionResult => {
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
