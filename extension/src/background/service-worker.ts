// Spec 132 — the MV3 background service worker. The ONLY place that touches
// supabase-js (imrClient), chrome.tabs, and chrome.scripting. It orchestrates:
//   • auth (D-2), pickup (D-3), the dry-run-gated run (D-4/D-5), and the guarded
//     mark-ordered write (131 D-4 / AC-6, via imrClient.markOrdered).
//
// HARD BOUNDARY (AC-9), enforced HERE — AMENDED BY SPEC 162:
//   • `RUN` (spec 132) is unchanged: it never navigates to a checkout/payment
//     URL and never submits a payment form.
//   • `PLACE_ORDER` (spec 162) DELIBERATELY crosses that line, at the owner's
//     instruction and for BJ's only: it drives BJ's own checkout to BJ's own
//     place-order button, using whatever payment BJ's already has on file. It
//     still never types a card number or a password. An adapter with no
//     `checkout` block (Sam's Club) is REFUSED, not degraded.
//   • It stops the whole run on a detected CAPTCHA/challenge or a not-logged-in
//     vendor site, handing control to the human.
//   • The dry-run gate (core/dryRun.ts) governs ALL THREE side effects: the
//     cart-fill, the mark-ordered write, and the place-order click.

import { adapterForOrigin } from '../adapters/registry';
import type {
  CartReadResult,
  CheckoutStepResult,
  ConfirmationResult,
  PageActionResult,
  SelectionReadResult,
  VendorAdapter,
} from '../adapters/types';
import type { CheckoutStage, ExpectedSelections } from '../core/checkout';
import { evaluateCartGate, evaluateSelections, failureReason, parseMoney } from '../core/checkout';
import { actionsToExecute, canMarkOrdered, canPlaceOrder } from '../core/dryRun';
import { pendingOrdersForOrigin } from '../core/origin';
import { buildPlan } from '../core/plan';
import { assembleReport } from '../core/report';
import { isSafeHttpUrl, safeOrigin } from '../core/urlGuard';
import {
  fetchOrderPayload,
  fetchPendingOrders,
  fetchStoreAddresses,
  getSession,
  markOrdered,
  recordOrderAttempt,
  signIn,
  signOut,
} from '../lib/imrClient';
import type {
  AuthStatusResponse,
  MarkOrderedResponse,
  PendingResponse,
  PlaceOrderResponse,
  Request,
  Response,
  RunResponse,
  StoreAddressesResponse,
} from '../lib/messages';
import type { ExecutionResult, PlannedAction, ReportLine } from '../lib/types';

// ─── tab helpers ──────────────────────────────────────────────────────────

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function tabOrigin(tab: chrome.tabs.Tab | null): string | null {
  return tab?.url ? safeOrigin(tab.url) : null;
}

/** Navigate `tabId` to a SAFE http(s) URL and resolve once it finishes loading. */
async function navigateAndWait(tabId: number, url: string, timeoutMs = 20000): Promise<boolean> {
  if (!isSafeHttpUrl(url)) return false;
  await chrome.tabs.update(tabId, { url });
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    const listener = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Inject a self-contained page routine and return its result. */
async function runInPage<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
): Promise<R> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    // The adapters' page routines are self-contained (DOM + args only) and
    // MUST be arrow/function-expression properties — chrome serializes via
    // toString(), and an object-SHORTHAND method stringifies into invalid
    // standalone source, silently yielding `undefined` results (the root
    // cause of the 2026-07-20 live-run failures).
    func: func as (...a: unknown[]) => unknown,
    args,
  });
  if (result === undefined || result === null) {
    // Injected routines always return a value; undefined means the injection
    // itself failed (serialization/CSP/page error). Fail LOUD, not silent.
    throw new Error('page routine returned no result — injection failed (check the service-worker console)');
  }
  return result as R;
}

// ─── AC-9 pre-flight: challenge + login gate on the CURRENT page ────────────

async function preflight(
  tabId: number,
  adapter: VendorAdapter,
): Promise<null | { reason: 'challenge' | 'not-logged-in'; detail: string }> {
  const challenged = await runInPage(tabId, adapter.pageDetectChallenge, []);
  if (challenged) {
    return { reason: 'challenge', detail: 'A CAPTCHA / bot challenge was detected — stopping (AC-9). Please solve it, then re-run.' };
  }
  // OWNER-TUNED (live 2026-07-20): the login check is ADVISORY, not a hard
  // gate. The heuristic false-negatived on bjs.com for a signed-in member
  // (greeting not under the <header> the selector probed), blocking live
  // runs. AC-9's real guarantees are unchanged — we never log in for the
  // user, and a genuine logged-out state surfaces immediately: the first
  // add-to-cart fails / redirects to a login wall, which the per-item
  // challenge check catches and hard-stops. The popup shows the warning via
  // `loginWarning` instead of aborting.
  const loggedIn = await runInPage(tabId, adapter.pageIsLoggedIn, []);
  if (!loggedIn) {
    console.warn(`[preflight] could not confirm a ${adapter.label} session — proceeding; items will fail if signed out`);
  }
  return null;
}

// ─── live-run execution of one planned action ───────────────────────────────

async function executeAction(
  tabId: number,
  adapter: VendorAdapter,
  action: PlannedAction,
): Promise<ExecutionResult> {
  // Resolve the target product page.
  let productUrl: string | null = null;
  if (action.resolution === 'url' && action.productPageUrl) {
    productUrl = action.productPageUrl;
  } else if (action.resolution === 'search' && action.orderCode) {
    // Navigate to the site search, then let the adapter pick a single result.
    const searchUrl = adapter.searchUrl(action.orderCode);
    const ok = await navigateAndWait(tabId, searchUrl);
    if (!ok) return { itemId: action.itemId, outcome: 'failed', detail: 'Search page failed to load.' };
    // A challenge can appear on the search navigation (AC-9) — check.
    if (await runInPage(tabId, adapter.pageDetectChallenge, [])) {
      return { itemId: action.itemId, outcome: 'failed', detail: 'Challenge detected on search — skipped this item.' };
    }
    const pick: PageActionResult = await runInPage(tabId, adapter.pagePickSearchResult, [action.orderCode]);
    if (pick.outcome !== 'added' || !pick.url || !isSafeHttpUrl(pick.url)) {
      return { itemId: action.itemId, outcome: pick.outcome, detail: pick.detail };
    }
    productUrl = pick.url;
  } else {
    return { itemId: action.itemId, outcome: 'failed', detail: 'No resolvable product URL or order code.' };
  }

  const ok = await navigateAndWait(tabId, productUrl);
  if (!ok) return { itemId: action.itemId, outcome: 'failed', detail: 'Product page failed to load.' };
  if (await runInPage(tabId, adapter.pageDetectChallenge, [])) {
    return { itemId: action.itemId, outcome: 'failed', detail: 'Challenge detected on product page — skipped this item.' };
  }
  const res: PageActionResult = await runInPage(tabId, adapter.pageAddToCartOnProduct, [action.qty]);
  return { itemId: action.itemId, outcome: res.outcome, detail: res.detail };
}

/**
 * Spec 162 — the cart-fill loop, extracted from `handleRun` so the auto-place
 * path executes the IDENTICAL fill rather than a second copy that could drift.
 * Returns the raw results plus the mid-run challenge stop, if one happened.
 */
async function fillCart(
  tabId: number,
  adapter: VendorAdapter,
  toRun: PlannedAction[],
): Promise<{ results: ExecutionResult[]; challenged: boolean }> {
  const results: ExecutionResult[] = [];
  for (const action of toRun) {
    let res: ExecutionResult;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential: one tab, one cart.
      res = await executeAction(tabId, adapter, action);
    } catch (e) {
      // One item's crash (injection failure, tab race) must NOT kill the run —
      // record it as a failed line and keep going (2026-07-20 live-run lesson).
      res = { itemId: action.itemId, outcome: 'failed', detail: `error: ${(e as Error).message}` };
    }
    results.push(res);
    // A challenge surfacing mid-run stops everything (AC-9).
    if (res.detail.startsWith('Challenge detected')) {
      return { results, challenged: true };
    }
  }
  return { results, challenged: false };
}

// ─── request handlers ───────────────────────────────────────────────────────

async function handleAuthStatus(): Promise<AuthStatusResponse> {
  try {
    const session = await getSession();
    return { signedIn: !!session, email: session?.user?.email ?? null, error: null };
  } catch (e) {
    return { signedIn: false, email: null, error: (e as Error).message };
  }
}

async function handlePendingForTab(): Promise<PendingResponse> {
  const tab = await getActiveTab();
  const origin = tabOrigin(tab);
  const adapter = origin ? adapterForOrigin(origin) : null;
  const onVendorSite = adapter !== null;
  // Spec 162 — the popup's auto-place arm is driven by the ADAPTER's capability,
  // not by a vendor-name check in the UI, so adding a checkout block to Sam's
  // later needs no popup change.
  const canAutoPlace = adapter?.checkout !== undefined;
  if (!origin || !onVendorSite) {
    return { orders: [], origin, onVendorSite, canAutoPlace: false, error: null };
  }
  const { data, error } = await fetchPendingOrders(null);
  if (error) return { orders: [], origin, onVendorSite, canAutoPlace, error };
  return {
    orders: pendingOrdersForOrigin(data ?? [], origin),
    origin,
    onVendorSite,
    canAutoPlace,
    error: null,
  };
}

async function handleRun(req: Extract<Request, { type: 'RUN' }>): Promise<RunResponse> {
  const tab = await getActiveTab();
  const origin = tabOrigin(tab);
  if (!tab?.id || !origin) {
    return { report: [], stopped: null, dryRun: req.dryRun, error: 'No active vendor tab.' };
  }
  const adapter = adapterForOrigin(origin);
  if (!adapter) {
    return { report: [], stopped: null, dryRun: req.dryRun, error: 'This site is not a supported vendor.' };
  }

  const { data: payload, error } = await fetchOrderPayload(req.poId);
  if (error || !payload) {
    return { report: [], stopped: null, dryRun: req.dryRun, error: error ?? 'Payload not found.' };
  }

  const plan = buildPlan(payload);

  // DRY-RUN — matching + report run, NO cart side effect, NO write (AC-10).
  if (req.dryRun) {
    return { report: assembleReport(plan, [], true), stopped: null, dryRun: true, error: null };
  }

  // LIVE — AC-9 preflight on the current page, then execute the gated actions.
  const stop = await preflight(tab.id, adapter);
  if (stop) {
    return { report: assembleReport(plan, [], true), stopped: stop, dryRun: false, error: null };
  }

  const toRun = actionsToExecute(plan, false);
  const { results, challenged } = await fillCart(tab.id, adapter, toRun);
  if (challenged) {
    return {
      report: assembleReport(plan, results, false),
      stopped: { reason: 'challenge', detail: 'A challenge appeared during the run — stopping (AC-9).' },
      dryRun: false,
      error: null,
    };
  }

  // OWNER-ASKED (2026-07-20): a finished live run parks the tab on the
  // vendor's CART page so the review-and-pay step starts exactly where the
  // human needs to be. Best-effort — a failed navigation never fails the run.
  try {
    await navigateAndWait(tab.id, adapter.cartUrl);
  } catch {
    /* best-effort */
  }

  return { report: assembleReport(plan, results, false), stopped: null, dryRun: false, error: null };
}

// ─── spec 162: auto-place ───────────────────────────────────────────────────

/**
 * Record ONE terminal outcome and shape the popup response. Every exit from
 * `handlePlaceOrder` past the dry-run gate funnels through here, which is what
 * makes "exactly one attempt row per run" (AC-6) structural rather than a thing
 * you have to remember at seven return sites.
 *
 * A failed RECORD is reported separately from a failed ORDER: if this write
 * fails, the outcome still happened but I.M.R doesn't know, so no notification
 * and no email went out and the popup is the only witness. Saying "failed" and
 * leaving it there would be a lie by omission.
 */
async function finishAttempt(args: {
  poId: string;
  clientUuid: string;
  capTotal: number;
  report: ReportLine[];
  outcome: 'placed' | 'failed';
  stage: CheckoutStage;
  detail: string;
  cartTotal: number | null;
  vendorOrderNumber: string | null;
}): Promise<PlaceOrderResponse> {
  const detail = args.outcome === 'placed' ? args.detail : failureReason(args.stage, args.detail);
  const { data, error } = await recordOrderAttempt({
    poId: args.poId,
    outcome: args.outcome,
    stage: args.stage,
    detail,
    cartTotal: args.cartTotal,
    capTotal: args.capTotal,
    vendorOrderNumber: args.vendorOrderNumber,
    clientUuid: args.clientUuid,
  });
  return {
    report: args.report,
    dryRun: false,
    outcome: args.outcome,
    stage: args.stage,
    detail,
    vendorOrderNumber: args.vendorOrderNumber,
    cartTotal: args.cartTotal,
    capTotal: args.capTotal,
    suppressedByDryRun: false,
    attemptId: data,
    recordError: error,
    error: null,
  };
}

/**
 * Spec 162 — fill the cart, verify it, then click BJ's own place-order button.
 *
 * The staging is the safety property. Between the fill and the money there are
 * three independent stops — the cart read, the line-count compare and the cap —
 * and each one fails CLOSED. Past the place-order click there is exactly one
 * question left: did BJ's give us an order number (AC-5)?
 *
 * Every path after the dry-run gate ends in `finishAttempt`, including the
 * catch, so an unattended run can never end without a record.
 */
async function handlePlaceOrder(
  req: Extract<Request, { type: 'PLACE_ORDER' }>,
): Promise<PlaceOrderResponse> {
  const capTotal = req.capTotal;
  const empty = (error: string | null): PlaceOrderResponse => ({
    report: [],
    dryRun: req.dryRun,
    outcome: null,
    stage: null,
    detail: '',
    vendorOrderNumber: null,
    cartTotal: null,
    capTotal,
    suppressedByDryRun: false,
    attemptId: null,
    recordError: null,
    error,
  });

  // A missing / non-positive cap is a REFUSAL, not a default. Defaulting here
  // would mean a popup bug silently produces an uncapped run.
  if (!Number.isFinite(capTotal) || capTotal <= 0) {
    return empty('Set a spend cap before placing an order.');
  }

  // Same posture for the address and card: unset is a refusal, never "skip the
  // check". An automation that will spend money has to know where the goods go
  // and what gets charged before it starts, not discover it afterwards.
  const expected: ExpectedSelections = {
    address: (req.expectedAddress ?? '').trim(),
    cardLast4: (req.expectedCardLast4 ?? '').replace(/\D/g, ''),
  };
  if (!expected.address) {
    return empty('Set the shipping address orders should go to before placing an order.');
  }
  if (expected.cardLast4.length !== 4) {
    return empty('Set the last 4 digits of the card orders may be charged to before placing an order.');
  }

  const tab = await getActiveTab();
  const origin = tabOrigin(tab);
  if (!tab?.id || !origin) return empty('No active vendor tab.');

  const adapter = adapterForOrigin(origin);
  if (!adapter) return empty('This site is not a supported vendor.');
  const checkout = adapter.checkout;
  if (!checkout) {
    // Sam's Club lands here by design — it has no checkout block (spec 162
    // scope). Refuse rather than degrade to something the operator didn't ask
    // for.
    return empty(`${adapter.label} cannot be auto-placed — fill the cart and check out yourself.`);
  }

  const { data: payload, error } = await fetchOrderPayload(req.poId);
  if (error || !payload) return empty(error ?? 'Payload not found.');

  const plan = buildPlan(payload);

  // DRY-RUN — the whole live arm is suppressed (AC-1). No cart is touched, no
  // checkout is entered, no attempt is recorded (there is no attempt).
  if (!canPlaceOrder(req.dryRun)) {
    return {
      report: assembleReport(plan, [], true),
      dryRun: true,
      outcome: null,
      stage: null,
      detail: `Dry-run: would fill the cart, then place the order only if the cart matches the PO, the total is under $${capTotal.toFixed(2)}, BJ’s ships to "${expected.address}", and BJ’s charges the card ending ${expected.cardLast4}.`,
      vendorOrderNumber: null,
      cartTotal: null,
      capTotal,
      suppressedByDryRun: true,
      attemptId: null,
      recordError: null,
      error: null,
    };
  }

  const clientUuid = crypto.randomUUID();
  let report: ReportLine[] = assembleReport(plan, [], true);

  try {
    // (1) PRE-FLIGHT — a challenge here stops before anything is added.
    const stop = await preflight(tab.id, adapter);
    if (stop) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: 'challenge', detail: stop.detail,
        cartTotal: null, vendorOrderNumber: null,
      });
    }

    // (2) FILL — the identical spec-132 loop.
    const toRun = actionsToExecute(plan, false);
    const { results, challenged } = await fillCart(tab.id, adapter, toRun);
    report = assembleReport(plan, results, false);
    if (challenged) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: 'challenge',
        detail: 'A challenge appeared while filling the cart.',
        cartTotal: null, vendorOrderNumber: null,
      });
    }

    // (3) READ THE LIVE CART.
    const atCart = await navigateAndWait(tab.id, checkout.checkoutUrl);
    if (!atCart) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: 'checkout-nav', detail: 'The cart page failed to load.',
        cartTotal: null, vendorOrderNumber: null,
      });
    }
    if (await runInPage(tab.id, adapter.pageDetectChallenge, [])) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: 'challenge', detail: 'A challenge appeared on the cart page.',
        cartTotal: null, vendorOrderNumber: null,
      });
    }
    const cart: CartReadResult = await runInPage(tab.id, checkout.pageReadCart, []);
    const cartTotal = parseMoney(cart.totalText);

    // (4) THE GATE — the pure decision (AC-2 / AC-3).
    const gate = evaluateCartGate(report, { lineCount: cart.lineCount, total: cartTotal }, capTotal);
    if (gate) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: gate.stage, detail: `${gate.detail} (${cart.detail})`,
        cartTotal, vendorOrderNumber: null,
      });
    }

    // (5) CHECKOUT.
    const started: CheckoutStepResult = await runInPage(tab.id, checkout.pageStartCheckout, []);
    if (!started.ok) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: 'checkout-nav', detail: started.detail,
        cartTotal, vendorOrderNumber: null,
      });
    }
    // A bot wall most often appears HERE — checkout is the step BJ's protects.
    if (await runInPage(tab.id, adapter.pageDetectChallenge, [])) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: 'challenge', detail: 'A challenge appeared during checkout.',
        cartTotal, vendorOrderNumber: null,
      });
    }

    // (5b) WHERE IT SHIPS AND WHAT PAYS (the revision). The card is never
    // auto-corrected; the address may be, but only to an option BJ's already
    // offers, and only ONCE — a switch that doesn't take is a refusal, not a
    // retry loop. Re-reading after the switch is the whole point: we verify the
    // page, never the fact that we clicked.
    let selections: SelectionReadResult = await runInPage(tab.id, checkout.pageReadSelections, []);
    let verdict = evaluateSelections(selections, expected);

    if (!verdict.ok && 'switchToOption' in verdict) {
      const switched: CheckoutStepResult = await runInPage(
        tab.id, checkout.pageSelectAddress, [verdict.switchToOption],
      );
      if (!switched.ok) {
        return finishAttempt({
          poId: req.poId, clientUuid, capTotal, report,
          outcome: 'failed', stage: 'address-verify', detail: switched.detail,
          cartTotal, vendorOrderNumber: null,
        });
      }
      selections = await runInPage(tab.id, checkout.pageReadSelections, []);
      verdict = evaluateSelections(selections, expected);
      // A second switch request means the re-read still doesn't match — the
      // click didn't take. Refuse rather than click again.
      if (!verdict.ok && 'switchToOption' in verdict) {
        return finishAttempt({
          poId: req.poId, clientUuid, capTotal, report,
          outcome: 'failed', stage: 'address-verify',
          detail: `The address was switched but BJ’s still shows "${selections.addressText ?? 'nothing readable'}". Nothing was ordered.`,
          cartTotal, vendorOrderNumber: null,
        });
      }
    }

    if (!verdict.ok && 'failure' in verdict) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: verdict.failure.stage, detail: verdict.failure.detail,
        cartTotal, vendorOrderNumber: null,
      });
    }

    // (6) THE CLICK THAT SPENDS MONEY.
    const placed: CheckoutStepResult = await runInPage(tab.id, checkout.pagePlaceOrder, []);
    if (!placed.ok) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: 'place', detail: placed.detail,
        cartTotal, vendorOrderNumber: null,
      });
    }

    // (7) CONFIRMATION — the order number, or it didn't happen (AC-5).
    const confirmation: ConfirmationResult = await runInPage(tab.id, checkout.pageReadConfirmation, []);
    if (!confirmation.orderNumber) {
      return finishAttempt({
        poId: req.poId, clientUuid, capTotal, report,
        outcome: 'failed', stage: 'confirm', detail: confirmation.detail,
        cartTotal, vendorOrderNumber: null,
      });
    }
    // The attempt record names the address and card the order actually went
    // out on, not the ones that were asked for — so the audit trail answers
    // "where did this ship and what paid" without anyone re-opening BJ's.
    return finishAttempt({
      poId: req.poId, clientUuid, capTotal, report,
      outcome: 'placed', stage: 'confirm',
      detail: `${confirmation.detail} Shipped to "${(selections.addressText ?? expected.address).trim().replace(/\s+/g, ' ')}", charged to the card ending ${selections.cardLast4}.`,
      cartTotal, vendorOrderNumber: confirmation.orderNumber,
    });
  } catch (e) {
    // An escaped exception is still a terminal outcome, and the operator still
    // needs to be told. The one thing we must NOT do is stay silent.
    return finishAttempt({
      poId: req.poId, clientUuid, capTotal, report,
      outcome: 'failed', stage: 'error', detail: (e as Error).message,
      cartTotal: null, vendorOrderNumber: null,
    });
  }
}

/** Spec 162 rev 2 — the store list behind the popup's address picker. */
async function handleStoreAddresses(): Promise<StoreAddressesResponse> {
  const { data, error } = await fetchStoreAddresses();
  return { stores: data ?? [], error };
}

async function handleMarkOrdered(
  req: Extract<Request, { type: 'MARK_ORDERED' }>,
): Promise<MarkOrderedResponse> {
  // The dry-run gate governs the write-back too (AC-10).
  if (!canMarkOrdered(req.dryRun)) {
    return { updated: 0, suppressedByDryRun: true, error: null };
  }
  const { data, error } = await markOrdered(req.poId);
  return { updated: data ?? 0, suppressedByDryRun: false, error };
}

// ─── message router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
  (async (): Promise<Response> => {
    switch (message.type) {
      case 'AUTH_STATUS':
        return handleAuthStatus();
      case 'SIGN_IN': {
        const { error } = await signIn(message.email, message.password);
        return handleAuthStatusAfter(error);
      }
      case 'SIGN_OUT':
        await signOut();
        return { signedIn: false, email: null, error: null };
      case 'PENDING_FOR_TAB':
        return handlePendingForTab();
      case 'RUN':
        return handleRun(message);
      case 'MARK_ORDERED':
        return handleMarkOrdered(message);
      case 'STORE_ADDRESSES':
        return handleStoreAddresses();
      case 'PLACE_ORDER':
        return handlePlaceOrder(message);
      default:
        return { error: 'Unknown request.' };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: (e as Error).message }));
  return true; // keep the message channel open for the async response.
});

async function handleAuthStatusAfter(signInError: string | null): Promise<AuthStatusResponse> {
  if (signInError) return { signedIn: false, email: null, error: signInError };
  return handleAuthStatus();
}
