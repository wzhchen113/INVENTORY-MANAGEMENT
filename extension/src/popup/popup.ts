// Spec 132 — the popup UI logic. A thin client: it renders auth, the dry-run
// toggle (DEFAULT ON — AC-10), the pending-PO pickup for the current tab (AC-3),
// the Run control, the per-item report (AC-7), and the explicit mark-ordered
// button (AC-8). ALL supabase-js / tab / scripting work happens in the
// background; the popup only sends messages.

import type {
  AuthStatusResponse,
  MarkOrderedResponse,
  PendingResponse,
  PlaceOrderResponse,
  Request,
  RunResponse,
  StoreAddressesResponse,
} from '../lib/messages';
import { summarizeReport } from '../core/report';
import { describeStoreSelection, preferredStoreId } from '../core/storePicker';
import type { StoreSelection } from '../core/storePicker';
import type { PendingOrder, ReportLine, StoreAddress } from '../lib/types';

// Spec 162 — the three auto-place guards live in THIS browser's storage, not
// the DB. They are blast-radius limits on this machine's unattended clicking
// rather than business rules about the vendor (see the spec's "Why the cap
// lives in chrome.storage.local").
//
// `imr-auto-place-card` holds FOUR DIGITS — an identifier for a card BJ's
// already has on file, never a card number. It exists so the extension can
// refuse an order BJ's would charge to the wrong card; it is compared in the
// page and never sent to I.M.R or anywhere else.
//
// Rev 2 stores the chosen STORE ID, not the address text. The address is
// resolved from I.M.R every time the popup opens, so correcting a store's
// address in the app fixes the extension too — a cached string would keep
// enforcing the old address and refuse every order until someone noticed.
const CAP_STORAGE_KEY = 'imr-auto-place-cap';
const STORE_STORAGE_KEY = 'imr-auto-place-store';
const CARD_STORAGE_KEY = 'imr-auto-place-card';
const DEFAULT_CAP = 500;

/** The store list behind the address picker, loaded once per popup open. */
let storeAddresses: StoreAddress[] = [];

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

function send<T>(message: Request): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function show(el: HTMLElement, on: boolean): void {
  el.classList.toggle('hidden', !on);
}

let currentPoId: string | null = null;
// Spec 162 rev 2 — the store of the PO in hand, used to DEFAULT the shipping
// picker. `storePickedManually` stops that default from clobbering a deliberate
// override when the operator switches between POs.
let currentPoStoreId: string | null = null;
let storePickedManually = false;
let lastPendingOrders: PendingOrder[] = [];

// ─── auth ─────────────────────────────────────────────────────────────────

async function refreshAuth(): Promise<void> {
  const status = await send<AuthStatusResponse>({ type: 'AUTH_STATUS' });
  const signedIn = status.signedIn;
  show($('signed-in'), signedIn);
  show($('signed-out'), !signedIn);
  show($('main'), signedIn);
  if (signedIn) {
    $('user-email').textContent = status.email ?? '';
    await refreshPending();
  }
}

async function onSignIn(): Promise<void> {
  const email = ($('email') as HTMLInputElement).value.trim();
  const password = ($('password') as HTMLInputElement).value;
  const errEl = $('auth-error');
  show(errEl, false);
  const status = await send<AuthStatusResponse>({ type: 'SIGN_IN', email, password });
  if (status.error) {
    errEl.textContent = status.error;
    show(errEl, true);
    return;
  }
  ($('password') as HTMLInputElement).value = '';
  await refreshAuth();
}

async function onSignOut(): Promise<void> {
  await send({ type: 'SIGN_OUT' });
  await refreshAuth();
}

// ─── pickup ─────────────────────────────────────────────────────────────────

function poLabel(o: PendingOrder): string {
  const gap = o.unmappedCount > 0 ? ` — ${o.unmappedCount} unmapped` : '';
  return `${o.vendorName}: ${o.lineCount} line(s)${gap} [${o.poId.slice(0, 8)}]`;
}

async function refreshPending(): Promise<void> {
  const statusEl = $('site-status');
  const selectEl = $('po-select') as HTMLSelectElement;
  const runBtn = $('run');
  show(selectEl, false);
  show(runBtn, false);
  show($('place-block'), false);
  show($('report-card'), false);
  show($('place-outcome'), false);

  const res = await send<PendingResponse>({ type: 'PENDING_FOR_TAB' });
  if (res.error) {
    statusEl.textContent = `Error: ${res.error}`;
    return;
  }
  if (!res.onVendorSite) {
    statusEl.textContent = 'Open a BJ’s or Sam’s Club tab to pick up a pending PO.';
    return;
  }
  if (res.orders.length === 0) {
    statusEl.textContent = `No pending PO for this vendor (${res.origin}).`;
    return;
  }
  statusEl.textContent = `${res.orders.length} pending PO(s) for this vendor:`;
  selectEl.innerHTML = '';
  for (const o of res.orders) {
    const opt = document.createElement('option');
    opt.value = o.poId;
    opt.textContent = poLabel(o);
    selectEl.appendChild(opt);
  }
  currentPoId = res.orders[0].poId;
  currentPoStoreId = res.orders[0].storeId;
  lastPendingOrders = res.orders;
  show(selectEl, true);
  show(runBtn, true);
  // Spec 162 — only offered where the adapter can actually do it.
  show($('place-block'), res.canAutoPlace);
  // The picker needs the PO in hand to default to its store, so it loads HERE
  // rather than at module scope.
  if (res.canAutoPlace) await loadGuards();
}

// ─── spec 162: spend cap + auto-place ───────────────────────────────────────

/**
 * THE chokepoint. Every read of "which store, and therefore which address" goes
 * through here, and it repaints the label as a side effect — so the line under
 * the picker is not a thing that has to be kept in sync, it is the same value
 * being displayed. `onPlaceOrder` calls this too, which is what makes it
 * impossible for the popup to show one address and enforce another.
 *
 * Deliberately NOT split into a "read" and a "render" half: two functions is
 * how they drifted.
 */
function currentSelection(): StoreSelection {
  const selection = describeStoreSelection(
    storeAddresses,
    ($('expected-store') as HTMLSelectElement).value,
  );
  const el = $('expected-address-preview');
  el.textContent = selection.previewText;
  el.className = selection.isError ? 'msg err' : 'msg';
  return selection;
}

/**
 * Point the picker at `storeId` and repaint. Programmatic `.value =` does NOT
 * fire a `change` event, so every programmatic move has to come through here or
 * the label goes stale against the selection.
 */
function setSelectedStore(storeId: string | null): void {
  const select = $('expected-store') as HTMLSelectElement;
  if (storeId) select.value = storeId;
  currentSelection();
}

async function loadGuards(): Promise<void> {
  const cap = $('cap-total') as HTMLInputElement;
  const card = $('expected-card') as HTMLInputElement;
  const select = $('expected-store') as HTMLSelectElement;

  let storedStoreId = '';
  try {
    const stored = await chrome.storage.local.get([CAP_STORAGE_KEY, STORE_STORAGE_KEY, CARD_STORAGE_KEY]);
    const value = Number(stored?.[CAP_STORAGE_KEY]);
    cap.value = String(Number.isFinite(value) && value > 0 ? value : DEFAULT_CAP);
    card.value = String(stored?.[CARD_STORAGE_KEY] ?? '');
    storedStoreId = String(stored?.[STORE_STORAGE_KEY] ?? '');
  } catch {
    // A storage failure leaves the card BLANK and the store UNPICKED on
    // purpose — the background refuses a run with either unset, so the failure
    // mode is "you have to pick again", never "it ran without them".
    cap.value = String(DEFAULT_CAP);
  }

  const res = await send<StoreAddressesResponse>({ type: 'STORE_ADDRESSES' });
  storeAddresses = res.stores ?? [];
  select.innerHTML = '';
  if (storeAddresses.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = res.error ? `Couldn’t load stores: ${res.error}` : 'No stores visible';
    select.appendChild(opt);
    currentSelection();
    return;
  }
  for (const s of storeAddresses) {
    const opt = document.createElement('option');
    opt.value = s.storeId;
    opt.textContent = s.hasAddress ? s.storeName : `${s.storeName} — no address set`;
    select.appendChild(opt);
  }
  // Prefer the last pick; fall back to the store of the PO in hand, so the
  // common case (this PO ships to its own store) needs no interaction.
  setSelectedStore(preferredStoreId(storeAddresses, storedStoreId, currentPoStoreId));
}

async function saveGuards(capTotal: number, storeId: string, cardLast4: string): Promise<void> {
  try {
    await chrome.storage.local.set({
      [CAP_STORAGE_KEY]: capTotal,
      [STORE_STORAGE_KEY]: storeId,
      [CARD_STORAGE_KEY]: cardLast4,
    });
  } catch {
    /* a storage failure just means they won't persist; this run still uses them */
  }
}

function renderPlaceOutcome(res: PlaceOrderResponse): void {
  const el = $('place-outcome');
  const lines: string[] = [];
  let cls = 'outcome failed';

  if (res.suppressedByDryRun) {
    cls = 'outcome dry';
    lines.push(res.detail);
  } else if (res.outcome === 'placed') {
    cls = 'outcome placed';
    lines.push(`Order placed — BJ’s order ${res.vendorOrderNumber}.`);
    if (res.cartTotal !== null) lines.push(`Cart total $${res.cartTotal.toFixed(2)} (cap $${res.capTotal.toFixed(2)}).`);
    lines.push('The PO is marked ordered in I.M.R.');
  } else {
    lines.push(res.detail);
    lines.push('The PO was left as a draft — nothing was ordered.');
  }

  // A failed ATTEMPT RECORD is its own headline: the outcome is real but nobody
  // was notified, so the operator in front of this popup is the only witness.
  if (res.recordError) {
    lines.push(
      `⚠ I.M.R was NOT updated (${res.recordError}) — no notification or email went out. Tell someone manually.`,
    );
  }

  el.className = cls;
  el.textContent = lines.join(' ');
  show(el, true);
}

async function onPlaceOrder(): Promise<void> {
  const selectEl = $('po-select') as HTMLSelectElement;
  currentPoId = selectEl.value || currentPoId;
  if (!currentPoId) return;

  const dryRun = ($('dry-run') as HTMLInputElement).checked;
  const capTotal = Number(($('cap-total') as HTMLInputElement).value);
  // Reading through the chokepoint ALSO repaints the label, so what the
  // operator is about to confirm is provably what gets enforced.
  const selection = currentSelection();
  const storeId = selection.storeId ?? '';
  const expectedAddress = (selection.address ?? '').trim();
  const expectedCardLast4 = ($('expected-card') as HTMLInputElement).value.replace(/\D/g, '');
  const errEl = $('run-error');
  show(errEl, false);
  show($('place-outcome'), false);

  if (!Number.isFinite(capTotal) || capTotal <= 0) {
    errEl.textContent = 'Enter a spend cap above $0 before placing an order.';
    show(errEl, true);
    return;
  }
  if (!expectedAddress) {
    // The preview already says exactly what's wrong; reuse it rather than
    // inventing a second wording that could drift from the first.
    errEl.textContent = selection.previewText;
    show(errEl, true);
    return;
  }
  if (expectedCardLast4.length !== 4) {
    errEl.textContent = 'Enter the last 4 digits of the card orders may be charged to.';
    show(errEl, true);
    return;
  }
  await saveGuards(capTotal, storeId, expectedCardLast4);

  // A live auto-place spends real money with no further confirmation, so it gets
  // the one and only in-popup confirm — and it names all three guards, because
  // "up to $X" alone doesn't tell the operator where the goods are going.
  // Dry-run skips it: there is nothing to confirm when nothing happens.
  if (
    !dryRun &&
    !window.confirm(
      `Place this order on BJ’s for real?\n\n` +
        `Up to $${capTotal.toFixed(2)}\n` +
        `Shipping to: ${expectedAddress}\n` +
        `Card ending: ${expectedCardLast4}\n\n` +
        `It will stop without ordering if BJ’s shows anything different.`,
    )
  ) {
    return;
  }

  const btn = $('place-order') as HTMLButtonElement;
  const runBtn = $('run') as HTMLButtonElement;
  btn.disabled = true;
  runBtn.disabled = true;
  btn.textContent = dryRun ? 'Running dry-run…' : 'Filling cart + ordering…';

  try {
    const res = await send<PlaceOrderResponse>({
      type: 'PLACE_ORDER',
      poId: currentPoId,
      dryRun,
      capTotal,
      expectedAddress,
      expectedCardLast4,
    });
    if (res.error) {
      errEl.textContent = res.error;
      show(errEl, true);
      return;
    }
    renderReport(res.report);
    show($('report-card'), true);
    // The auto-place arm owns the PO's status end to end (the RPC does the
    // draft→sent flip on a confirmed placement), so the manual mark-ordered
    // button must stay hidden here — offering it would invite a double-mark.
    show($('mark-ordered'), false);
    renderPlaceOutcome(res);
  } finally {
    btn.disabled = false;
    runBtn.disabled = false;
    btn.textContent = 'Fill cart + place order';
  }
}

// ─── run + report ───────────────────────────────────────────────────────────

function renderReport(report: ReportLine[]): void {
  const listEl = $('report-list');
  listEl.innerHTML = '';
  for (const line of report) {
    const wrap = document.createElement('div');
    wrap.className = 'item';
    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = line.itemName || line.orderCode || line.itemId;
    const pill = document.createElement('span');
    pill.className = `pill ${line.status}`;
    pill.textContent = line.status;
    nameRow.appendChild(name);
    nameRow.appendChild(pill);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${line.orderCode ?? 'no code'} · ${line.qty} ${line.unit}`;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = line.detail;
    wrap.appendChild(nameRow);
    wrap.appendChild(meta);
    wrap.appendChild(detail);
    listEl.appendChild(wrap);
  }
  const s = summarizeReport(report);
  $('report-summary').textContent = `${s.added} added · ${s.wouldAdd} would-add · ${s.unmatched} unmatched · ${s.ambiguous} ambiguous · ${s.failed} failed`;
}

async function onRun(): Promise<void> {
  const selectEl = $('po-select') as HTMLSelectElement;
  currentPoId = selectEl.value || currentPoId;
  if (!currentPoId) return;
  const dryRun = ($('dry-run') as HTMLInputElement).checked;
  const runBtn = $('run') as HTMLButtonElement;
  const errEl = $('run-error');
  const stopEl = $('run-stop');
  show(errEl, false);
  show(stopEl, false);
  runBtn.disabled = true;
  runBtn.textContent = dryRun ? 'Running dry-run…' : 'Filling cart…';

  try {
    const res = await send<RunResponse>({ type: 'RUN', poId: currentPoId, dryRun });
    if (res.error) {
      errEl.textContent = res.error;
      show(errEl, true);
      return;
    }
    renderReport(res.report);
    show($('report-card'), true);
    if (res.stopped) {
      stopEl.textContent = res.stopped.detail;
      show(stopEl, true);
    }
    // Mark-ordered is offered only after a LIVE run (payment happens between
    // fill and mark — AC-8); dry-run never writes back (AC-10).
    const markBtn = $('mark-ordered');
    show(markBtn, !dryRun && !res.stopped);
    show($('mark-msg'), false);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'Fill cart from PO';
  }
}

async function onMarkOrdered(): Promise<void> {
  if (!currentPoId) return;
  const dryRun = ($('dry-run') as HTMLInputElement).checked;
  const msgEl = $('mark-msg');
  const res = await send<MarkOrderedResponse>({ type: 'MARK_ORDERED', poId: currentPoId, dryRun });
  if (res.error) {
    msgEl.textContent = `Error: ${res.error}`;
    msgEl.className = 'msg err';
  } else if (res.suppressedByDryRun) {
    msgEl.textContent = 'Dry-run is on — the PO was NOT marked ordered.';
    msgEl.className = 'msg stop';
  } else if (res.updated > 0) {
    msgEl.textContent = 'PO marked ordered — it will drop out of the pending set.';
    msgEl.className = 'msg';
    show($('mark-ordered'), false);
  } else {
    msgEl.textContent = 'No change (PO was already ordered or not visible).';
    msgEl.className = 'msg';
  }
  show(msgEl, true);
}

// ─── wire up ─────────────────────────────────────────────────────────────────

$('sign-in').addEventListener('click', () => void onSignIn());
$('sign-out').addEventListener('click', () => void onSignOut());
$('run').addEventListener('click', () => void onRun());
$('mark-ordered').addEventListener('click', () => void onMarkOrdered());
$('place-order').addEventListener('click', () => void onPlaceOrder());
($('po-select') as HTMLSelectElement).addEventListener('change', (e) => {
  currentPoId = (e.target as HTMLSelectElement).value;
  // Follow the new PO's store UNLESS the operator has deliberately picked one —
  // a picker left pointing at the previous PO's store is exactly the silent
  // wrong-address failure this whole gate exists to prevent.
  const order = lastPendingOrders.find((o) => o.poId === currentPoId);
  currentPoStoreId = order?.storeId ?? currentPoStoreId;
  if (!storePickedManually && currentPoStoreId && storeAddresses.some((s) => s.storeId === currentPoStoreId)) {
    setSelectedStore(currentPoStoreId);
  }
});

($('expected-store') as HTMLSelectElement).addEventListener('change', () => {
  storePickedManually = true;
  currentSelection();
});

// Spec 162 — the banner has to say what the live arm actually does now, because
// "live" no longer means "fills your cart"; it means "spends money".
function syncModeBanner(): void {
  const dryRun = ($('dry-run') as HTMLInputElement).checked;
  const banner = $('mode-banner');
  banner.className = dryRun ? 'banner' : 'banner live';
  banner.textContent = dryRun
    ? 'Dry-run logs the intended actions without touching your cart, marking the PO ordered, or placing an order. Turn it off for a live run.'
    : 'LIVE. “Fill cart from PO” changes your real cart. “Fill cart + place order” also places the order on BJ’s and charges the payment on your account.';
}
($('dry-run') as HTMLInputElement).addEventListener('change', syncModeBanner);
syncModeBanner();

void refreshAuth();
