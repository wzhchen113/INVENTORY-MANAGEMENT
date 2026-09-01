// @vitest-environment jsdom
//
// Spec 162 (rev 2) — the popup's shipping-address picker, exercised against the
// REAL popup.html in a real DOM.
//
// WHY THIS FILE EXISTS: the owner watched the popup show "Frederick" over
// Towson's address and asked for proof the two move together. The pure resolver
// (core/storePicker) proves the VALUES agree; only this proves the wiring
// actually fires — that `change` on the select repaints the label, and that the
// address handed to the background is the one on screen. A pure test would have
// passed happily with no event listener attached at all.
//
// It loads public/popup.html from disk rather than restating the markup, so
// renaming an id (`expected-store`, `expected-address-preview`) fails here
// instead of silently at runtime in a browser nobody is watching.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const POPUP_HTML = readFileSync(resolve(__dirname, '../../../public/popup.html'), 'utf8');

const STORES = [
  { storeId: 's-charles', storeName: 'Charles', address: '2018 N Charles St, Baltimore MD 21218', hasAddress: true },
  { storeId: 's-frederick', storeName: 'Frederick', address: '2339 Frederick Ave, Baltimore MD 21223', hasAddress: true },
  { storeId: 's-towson', storeName: 'Towson', address: '1234 York Rd, Towson MD 21204', hasAddress: true },
  { storeId: 's-new', storeName: 'Brand New', address: null, hasAddress: false },
];

const PENDING_ORDERS = [
  { poId: 'po-1', storeId: 's-towson', vendorId: 'v1', vendorName: "BJ's", orderPageUrl: null, orderUnit: 'case', lineCount: 3, unmappedCount: 0 },
  { poId: 'po-2', storeId: 's-charles', vendorId: 'v1', vendorName: "BJ's", orderPageUrl: null, orderUnit: 'case', lineCount: 2, unmappedCount: 0 },
];

const sendMessage = vi.fn();
const placeOrderCalls: any[] = [];

/** Mount the real popup markup + a stubbed chrome, then load the popup module. */
async function mountPopup(storedGuards: Record<string, unknown> = {}) {
  document.documentElement.innerHTML = POPUP_HTML;
  placeOrderCalls.length = 0;
  sendMessage.mockReset();
  sendMessage.mockImplementation(async (msg: any) => {
    switch (msg.type) {
      case 'AUTH_STATUS':
        return { signedIn: true, email: 'admin@local.test', error: null };
      case 'PENDING_FOR_TAB':
        return { orders: PENDING_ORDERS, origin: 'https://www.bjs.com', onVendorSite: true, canAutoPlace: true, error: null };
      case 'STORE_ADDRESSES':
        return { stores: STORES, error: null };
      case 'PLACE_ORDER':
        placeOrderCalls.push(msg);
        return {
          report: [], dryRun: msg.dryRun, outcome: null, stage: null, detail: 'dry',
          vendorOrderNumber: null, cartTotal: null, capTotal: msg.capTotal,
          suppressedByDryRun: true, attemptId: null, recordError: null, error: null,
        };
      default:
        return { error: null };
    }
  });

  (globalThis as any).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn().mockResolvedValue(storedGuards), set: vi.fn().mockResolvedValue(undefined) } },
  };

  vi.resetModules();
  await import('../popup');
  // Let refreshAuth → refreshPending → loadGuards settle.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const $ = (id: string) => document.getElementById(id)!;
const select = () => $('expected-store') as HTMLSelectElement;
const preview = () => $('expected-address-preview').textContent;

/** A real user picking a different store: set the value, dispatch `change`. */
function pickStore(storeId: string) {
  select().value = storeId;
  select().dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('popup shipping picker — the address follows the store', () => {
  it('populates the picker from the store list', async () => {
    await mountPopup();
    expect([...select().options].map((o) => o.textContent)).toEqual([
      'Charles',
      'Frederick',
      'Towson',
      // An addressless store stays in the list, FLAGGED — a store that silently
      // vanished would be unactionable.
      'Brand New — no address set',
    ]);
  });

  it('defaults to the store of the PO in hand and shows THAT address', async () => {
    await mountPopup();
    expect(select().value).toBe('s-towson');
    expect(preview()).toBe('1234 York Rd, Towson MD 21204');
  });

  it('★ changing the store changes the address — the reported bug', async () => {
    await mountPopup();
    expect(preview()).toContain('Towson');

    pickStore('s-frederick');

    expect(preview()).toBe('2339 Frederick Ave, Baltimore MD 21223');
    expect(preview()).not.toContain('Towson');
  });

  it('keeps following through several picks, including back again', async () => {
    await mountPopup();
    pickStore('s-charles');
    expect(preview()).toBe('2018 N Charles St, Baltimore MD 21218');
    pickStore('s-frederick');
    expect(preview()).toBe('2339 Frederick Ave, Baltimore MD 21223');
    pickStore('s-towson');
    expect(preview()).toBe('1234 York Rd, Towson MD 21204');
  });

  it('picking an addressless store says so instead of showing a stale address', async () => {
    await mountPopup();
    pickStore('s-new');
    expect(preview()).toContain('Brand New has no address');
    // The previous store's address must NOT still be sitting there.
    expect(preview()).not.toContain('York Rd');
    expect($('expected-address-preview').className).toContain('err');
  });

  it('restores the operator’s saved pick over the PO’s store', async () => {
    await mountPopup({ 'imr-auto-place-store': 's-charles', 'imr-auto-place-card': '4321' });
    expect(select().value).toBe('s-charles');
    expect(preview()).toBe('2018 N Charles St, Baltimore MD 21218');
  });
});

describe('popup shipping picker — what is SENT matches what is SHOWN', () => {
  it('sends the picked store’s address, not the defaulted one', async () => {
    await mountPopup({ 'imr-auto-place-card': '4321' });
    pickStore('s-frederick');
    const shown = preview();

    ($('place-order') as HTMLButtonElement).click();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(placeOrderCalls).toHaveLength(1);
    // The assertion that matters: the address on the wire IS the address on
    // screen. Not "an address" — that one.
    expect(placeOrderCalls[0].expectedAddress).toBe('2339 Frederick Ave, Baltimore MD 21223');
    expect(placeOrderCalls[0].expectedAddress).toBe(shown);
  });

  it('refuses to send at all when the picked store has no address', async () => {
    await mountPopup({ 'imr-auto-place-card': '4321' });
    pickStore('s-new');

    ($('place-order') as HTMLButtonElement).click();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(placeOrderCalls).toHaveLength(0);
    expect($('run-error').textContent).toContain('Brand New has no address');
  });

  it('refuses to send when no card is set, before any address question', async () => {
    await mountPopup();
    ($('place-order') as HTMLButtonElement).click();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(placeOrderCalls).toHaveLength(0);
    expect($('run-error').textContent).toContain('last 4 digits');
  });
});
