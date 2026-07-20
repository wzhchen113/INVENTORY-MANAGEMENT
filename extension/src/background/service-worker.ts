// Spec 132 — the MV3 background service worker. The ONLY place that touches
// supabase-js (imrClient), chrome.tabs, and chrome.scripting. It orchestrates:
//   • auth (D-2), pickup (D-3), the dry-run-gated run (D-4/D-5), and the guarded
//     mark-ordered write (131 D-4 / AC-6, via imrClient.markOrdered).
//
// HARD BOUNDARY (AC-9), enforced HERE:
//   • It never navigates to a checkout/payment URL and never submits a payment
//     form — it only navigates to product/search pages and calls the adapters'
//     add-to-cart routine.
//   • It stops the whole run on a detected CAPTCHA/challenge or a not-logged-in
//     vendor site, handing control to the human.
//   • The dry-run gate (core/dryRun.ts) governs BOTH the cart-fill side effect
//     AND the mark-ordered write.

import { adapterForOrigin } from '../adapters/registry';
import type { PageActionResult, VendorAdapter } from '../adapters/types';
import { actionsToExecute, canMarkOrdered } from '../core/dryRun';
import { pendingOrdersForOrigin } from '../core/origin';
import { buildPlan } from '../core/plan';
import { assembleReport } from '../core/report';
import { isSafeHttpUrl, safeOrigin } from '../core/urlGuard';
import {
  fetchOrderPayload,
  fetchPendingOrders,
  getSession,
  markOrdered,
  signIn,
  signOut,
} from '../lib/imrClient';
import type {
  AuthStatusResponse,
  MarkOrderedResponse,
  PendingResponse,
  Request,
  Response,
  RunResponse,
} from '../lib/messages';
import type { ExecutionResult, PlannedAction } from '../lib/types';

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
    // The adapters' page routines are self-contained (DOM + args only).
    func: func as (...a: unknown[]) => unknown,
    args,
  });
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
  const loggedIn = await runInPage(tabId, adapter.pageIsLoggedIn, []);
  if (!loggedIn) {
    return { reason: 'not-logged-in', detail: `You are not logged in to ${adapter.label} — please log in, then re-run (AC-9: the extension never logs in for you).` };
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
  const onVendorSite = origin ? adapterForOrigin(origin) !== null : false;
  if (!origin || !onVendorSite) {
    return { orders: [], origin, onVendorSite, error: null };
  }
  const { data, error } = await fetchPendingOrders(null);
  if (error) return { orders: [], origin, onVendorSite, error };
  return { orders: pendingOrdersForOrigin(data ?? [], origin), origin, onVendorSite, error: null };
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
  const results: ExecutionResult[] = [];
  for (const action of toRun) {
    // eslint-disable-next-line no-await-in-loop -- sequential: one tab, one cart.
    const res = await executeAction(tab.id, adapter, action);
    results.push(res);
    // A challenge surfacing mid-run stops everything (AC-9).
    if (res.detail.startsWith('Challenge detected')) {
      return {
        report: assembleReport(plan, results, false),
        stopped: { reason: 'challenge', detail: 'A challenge appeared during the run — stopping (AC-9).' },
        dryRun: false,
        error: null,
      };
    }
  }

  return { report: assembleReport(plan, results, false), stopped: null, dryRun: false, error: null };
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
