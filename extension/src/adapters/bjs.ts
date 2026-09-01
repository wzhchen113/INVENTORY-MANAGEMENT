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

import type {
  CartReadResult,
  CheckoutStepResult,
  ConfirmationResult,
  PageActionResult,
  SelectionReadResult,
  VendorAdapter,
} from './types';

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

  // ┌─ SPEC 162 — AUTO-PLACE (the money-spending half) ─────────────────────────┐
  // │ UNVERIFIED FIRST-PASS SELECTORS. The cart-fill selectors above earned      │
  // │ their `auto-data` attributes from a live 2026-07-20 DOM inspection in the  │
  // │ owner's session; NOTHING below has had that pass yet (spec 162 OQ-1).      │
  // │ Every routine therefore fails LOUD and DIAGNOSTIC — a failure names the    │
  // │ visible candidate labels it did see, so one screenshot from a failed run   │
  // │ is enough to re-target. Edit ONLY the selector strings inside these        │
  // │ routines; the staging, the gate and the audit record are stable.           │
  // └───────────────────────────────────────────────────────────────────────────┘
  checkout: {
    checkoutUrl: `${BJS_ORIGIN}/cart`,

    pageReadCart: async (): Promise<CartReadResult> => {
      // Read-only by contract: this routine must never click, never change a
      // quantity, never remove a line. It is the input to the gate that decides
      // whether money moves, so a WRONG read is worse than no read — every
      // uncertain path returns null and lets the gate hard-stop.
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      try {
        // The cart is an SPA route; poll for rows the same way the product page
        // polls for its add-to-cart button.
        let rows: HTMLElement[] = [];
        for (let i = 0; i < 20 && rows.length === 0; i++) {
          rows = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[auto-data*="cartItem" i], [data-testid*="cart-item" i], [class*="CartItem"], [class*="cart-item"]',
            ),
          ).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2;
          });
          if (rows.length === 0) await sleep(500);
        }

        // De-dupe nested matches: a row container AND its inner wrapper can both
        // match the class probe, which would double the line count and trip the
        // gate on a cart that is actually correct. Keep only outermost matches.
        const outermost = rows.filter((el) => !rows.some((other) => other !== el && other.contains(el)));

        // Subtotal — prefer an explicit attribute, else the nearest money string
        // to a "subtotal" label. Never fall back to the order TOTAL with tax and
        // fees folded in: the cap is a cart-value cap and mixing the two makes
        // the cap mean something different run to run.
        let totalText: string | null = null;
        const explicit = document.querySelector<HTMLElement>(
          '[auto-data*="subtotal" i], [data-testid*="subtotal" i], [class*="Subtotal" i]',
        );
        if (explicit?.textContent) totalText = explicit.textContent;
        if (!totalText) {
          const labelled = Array.from(document.querySelectorAll<HTMLElement>('div, span, p, td, li')).find(
            (el) => /subtotal/i.test(el.textContent || '') && /\$\s?\d/.test(el.textContent || ''),
          );
          if (labelled?.textContent) totalText = labelled.textContent;
        }

        if (outermost.length === 0) {
          const seen = [...new Set(
            Array.from(document.querySelectorAll<HTMLElement>('h1, h2, [class*="empty" i]'))
              .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40))
              .filter(Boolean),
          )].slice(0, 5);
          return {
            lineCount: null,
            totalText,
            detail: `BJ’s: no cart rows found within 10s. Page headings: ${seen.length ? seen.join(' | ') : '(none)'}.`,
          };
        }

        return {
          lineCount: outermost.length,
          totalText,
          detail: `BJ’s: read ${outermost.length} cart line(s)${totalText ? `, subtotal text "${totalText.trim().replace(/\s+/g, ' ').slice(0, 40)}"` : ', NO subtotal found'}.`,
        };
      } catch (e) {
        return { lineCount: null, totalText: null, detail: `BJ’s: cart read error: ${(e as Error).message}` };
      }
    },

    pageStartCheckout: async (): Promise<CheckoutStepResult> => {
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const visible = (el: HTMLElement): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
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
      try {
        // "Checkout" / "Proceed to checkout" — but NOT "continue shopping", and
        // NOT the place-order control (that is a separate, later, deliberate
        // step; collapsing the two would place an order without a gate between
        // the cart read and the click).
        let btn: HTMLElement | undefined;
        for (let i = 0; i < 20 && !btn; i++) {
          btn = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a'))
            .filter(visible)
            .find((el) => {
              const t = (el.textContent || '').trim();
              return /check\s?out/i.test(t) && !/continue shopping|place order|submit order/i.test(t);
            });
          if (!btn) await sleep(500);
        }
        if (!btn) {
          const labels = [...new Set(
            Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a'))
              .filter(visible)
              .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40))
              .filter(Boolean),
          )].slice(0, 10);
          return { ok: false, detail: `BJ’s: no checkout button appeared within 10s. Visible controls: ${labels.join(' | ') || '(none)'}.` };
        }
        if ((btn as HTMLButtonElement).disabled || btn.getAttribute('aria-disabled') === 'true') {
          return { ok: false, detail: 'BJ’s: the checkout button is DISABLED — the cart may need a delivery/pickup or club selection first.' };
        }
        await dispatchClick(btn);
        await sleep(2500);
        return { ok: true, detail: 'BJ’s: checkout started.' };
      } catch (e) {
        return { ok: false, detail: `BJ’s: checkout navigation error: ${(e as Error).message}` };
      }
    },

    pageReadSelections: async (): Promise<SelectionReadResult> => {
      // READ-ONLY by contract — the gate has not run yet, so this routine must
      // not click anything or change a selection.
      //
      // Reads the checkout review step for (a) where BJ's would ship and (b)
      // which card it would charge. Both feed a refusal, so an uncertain read
      // returns null and the gate stops the run; there is no guessing here.
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const visible = (el: HTMLElement): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      try {
        let addressText: string | null = null;
        let cardLast4: string | null = null;
        const addressOptions: string[] = [];

        for (let i = 0; i < 24 && (!addressText || !cardLast4); i++) {
          // ── address ──
          if (!addressText) {
            const el = Array.from(
              document.querySelectorAll<HTMLElement>(
                '[auto-data*="address" i], [data-testid*="address" i], [class*="Address" i], [class*="delivery" i]',
              ),
            )
              .filter(visible)
              // A street address contains a number followed by words; a section
              // HEADING ("Delivery address") does not. This is what keeps the
              // label from being mistaken for the value.
              .find((e) => /\d{1,6}\s+\w/.test(clean(e.textContent)));
            if (el) addressText = clean(el.textContent);
          }

          // ── card ──
          if (!cardLast4) {
            const text = clean(document.body?.innerText);
            const m =
              text.match(/(?:ending\s+in|ending|•{2,}\s*|\*{2,}\s*|x{4,}\s*)(\d{4})\b/i) ??
              text.match(/\b(?:card|visa|mastercard|amex|discover)\b[^\d]{0,24}(\d{4})\b/i);
            if (m?.[1]) cardLast4 = m[1];
          }

          if (!addressText || !cardLast4) await sleep(500);
        }

        // ── switchable addresses ──
        // Only radio/option rows that LOOK like street addresses; a "use a new
        // address" control is not an option we may silently pick.
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="radio"], [role="option"], label:has(input[type="radio"]), [class*="AddressOption" i], [class*="address-option" i]',
          ),
        ).filter(visible)) {
          const t = clean(el.textContent);
          if (/\d{1,6}\s+\w/.test(t) && !/new address|add address/i.test(t) && !addressOptions.includes(t)) {
            addressOptions.push(t);
          }
        }

        return {
          addressText,
          cardLast4,
          addressOptions,
          detail: `BJ’s: address ${addressText ? `"${addressText.slice(0, 60)}"` : 'NOT FOUND'}, card ${
            cardLast4 ? `ending ${cardLast4}` : 'NOT FOUND'
          }, ${addressOptions.length} switchable address option(s).`,
        };
      } catch (e) {
        return {
          addressText: null,
          cardLast4: null,
          addressOptions: [],
          detail: `BJ’s: selection read error: ${(e as Error).message}`,
        };
      }
    },

    pageSelectAddress: async (target: string): Promise<CheckoutStepResult> => {
      // Picks a saved address BJ's is ALREADY offering. It never types a new
      // address and never opens an "add address" flow — the caller re-reads and
      // re-gates afterwards, so a silent no-op here fails closed rather than
      // shipping somewhere unverified.
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const visible = (el: HTMLElement): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      try {
        const wanted = clean(target);
        const row = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="radio"], [role="option"], label:has(input[type="radio"]), [class*="AddressOption" i], [class*="address-option" i]',
          ),
        )
          .filter(visible)
          .find((el) => clean(el.textContent) === wanted);
        if (!row) {
          return { ok: false, detail: `BJ’s: the saved address "${wanted.slice(0, 60)}" was no longer on the page.` };
        }
        row.scrollIntoView({ block: 'center' });
        await sleep(120);
        const r = row.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        for (const [type, Ctor] of [
          ['pointerdown', PointerEvent],
          ['mousedown', MouseEvent],
          ['pointerup', PointerEvent],
          ['mouseup', MouseEvent],
          ['click', MouseEvent],
        ] as const) {
          row.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
        }
        await sleep(1200);
        // Some pickers need an explicit confirm; click it only if one is
        // plainly visible. Never a place-order control.
        const confirm = Array.from(document.querySelectorAll<HTMLElement>('button'))
          .filter(visible)
          .find((b) => /^(use this address|save|apply|continue|deliver here)$/i.test(clean(b.textContent)));
        if (confirm) {
          confirm.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await sleep(1500);
        }
        return { ok: true, detail: `BJ’s: switched the delivery address to "${wanted.slice(0, 60)}".` };
      } catch (e) {
        return { ok: false, detail: `BJ’s: address switch error: ${(e as Error).message}` };
      }
    },

    pagePlaceOrder: async (): Promise<CheckoutStepResult> => {
      // THE ONE ROUTINE THAT SPENDS MONEY. Everything about it is deliberately
      // narrow: it matches only an explicit place/submit-order label, it refuses
      // a disabled control, and it clicks exactly once — no retry loop. A
      // retried place-order click is how you buy the same order twice.
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const visible = (el: HTMLElement): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      try {
        let btn: HTMLElement | undefined;
        for (let i = 0; i < 24 && !btn; i++) {
          btn = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
            .filter(visible)
            .find((el) => /place\s+(your\s+)?order|submit\s+order|complete\s+order/i.test((el.textContent || '').trim()));
          if (!btn) await sleep(500);
        }
        if (!btn) {
          const labels = [...new Set(
            Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
              .filter(visible)
              .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40))
              .filter(Boolean),
          )].slice(0, 10);
          return { ok: false, detail: `BJ’s: no place-order button appeared within 12s. Visible controls: ${labels.join(' | ') || '(none)'}.` };
        }
        if ((btn as HTMLButtonElement).disabled || btn.getAttribute('aria-disabled') === 'true') {
          return { ok: false, detail: 'BJ’s: the place-order button is DISABLED — payment or a delivery slot may still be required.' };
        }
        btn.scrollIntoView({ block: 'center' });
        await sleep(150);
        const r = btn.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        for (const [type, Ctor] of [
          ['pointerdown', PointerEvent],
          ['mousedown', MouseEvent],
          ['pointerup', PointerEvent],
          ['mouseup', MouseEvent],
          ['click', MouseEvent],
        ] as const) {
          btn.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
        }
        return { ok: true, detail: 'BJ’s: place-order clicked — waiting for a confirmation number.' };
      } catch (e) {
        return { ok: false, detail: `BJ’s: place-order error: ${(e as Error).message}` };
      }
    },

    pageReadConfirmation: async (): Promise<ConfirmationResult> => {
      // AC-5: the ORDER NUMBER is the only proof of placement. A thank-you
      // heading with no number is NOT success — BJ's may have rendered an
      // optimistic page while the payment is still failing behind it, and
      // reporting that as placed would leave the store waiting on an order that
      // never existed.
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      try {
        for (let i = 0; i < 30; i++) {
          const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
          const m =
            text.match(/order\s*(?:#|number|no\.?|confirmation)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/i) ??
            text.match(/confirmation\s*(?:#|number)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/i);
          if (m?.[1]) {
            return { orderNumber: m[1], detail: `BJ’s: confirmed order ${m[1]}.` };
          }
          // A payment/validation error surfacing on the checkout page is a
          // terminal failure — stop waiting and report what BJ's said.
          const err = Array.from(document.querySelectorAll<HTMLElement>('[role="alert"], [class*="error" i]'))
            .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '))
            .find((t) => t.length > 3);
          if (err) {
            return { orderNumber: null, detail: `BJ’s reported: "${err.slice(0, 200)}"` };
          }
          await sleep(1000);
        }
        const heading = (document.querySelector('h1, h2')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        return {
          orderNumber: null,
          detail: `BJ’s: no order number appeared within 30s. Page heading: "${heading || '(none)'}". CHECK BJ’S ORDER HISTORY before re-running — the order may or may not have gone through.`,
        };
      } catch (e) {
        return { orderNumber: null, detail: `BJ’s: confirmation read error: ${(e as Error).message}` };
      }
    },
  },
};
