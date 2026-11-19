// src/store/useStore.orderPaths.primaryWins.spec201.test.ts — Spec 201 (AC-24).
//
// Spec 201 R1/R4 put the "primary wins" rule in `report_reorder_list`: on a
// coincident day a shared item F is returned ONLY on its primary vendor A's
// card, and is absent from B's. Every order-placing path is built from
// `reorderPayload.vendors[].items`, so the client needs NO per-consumer filter
// — and this suite pins that it adds none / re-adds nothing:
//   - FILL CART / export recording → `buildDraftOrderLines` for B has no F line;
//     for A it does;
//   - CREATE PO → `createPoDraft` for B sends no F line to the writer;
//   - CSV / Sysco / US Foods planners → `resolveExportBase` for a B import
//     config has no F item.
//
// Mocking follows useStore.createPoDraft.spec125.test.ts.

jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      signOut: jest.fn(),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    from: jest.fn(),
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

jest.mock('../lib/auth', () => ({
  deleteUser: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/db', () => ({
  fetchStores: jest.fn().mockResolvedValue([]),
  createPurchaseOrderDraft: jest.fn().mockResolvedValue('po-new'),
  fetchRecentPurchaseOrders: jest.fn().mockResolvedValue([]),
  fetchReorderSuggestions: jest.fn().mockResolvedValue(null),
}));

import * as db from '../lib/db';
import { useStore, buildDraftOrderLines } from './useStore';
import { resolveExportBase } from '../utils/vendorImportShared';
import type { InventoryItem, ReorderItem, ReorderPayload, ReorderVendor } from '../types';

const INITIAL_STATE = useStore.getState();
const createDraftMock = db.createPurchaseOrderDraft as jest.Mock;

const STORE_ID = 'store-s';
const AS_OF = '2026-11-16';

function item(over: Partial<ReorderItem> & { itemId: string; itemName: string }): ReorderItem {
  return {
    unit: 'each',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: 10,
    usageForecasted: 0,
    parReplacement: 10,
    suggestedQty: 10,
    costPerUnit: 2,
    estimatedCost: 20,
    caseQty: 1,
    suggestedCases: null,
    suggestedUnits: 10,
    flags: [],
    otherVendorCount: 0,
    alsoFromVendors: [],
    yieldedFromVendors: [],
    ...over,
  };
}

function vendor(over: Partial<ReorderVendor> & { vendorId: string; items: ReorderItem[] }): ReorderVendor {
  return {
    vendorName: over.vendorId,
    scheduleKnown: true,
    nextDeliveryDate: '2026-11-17',
    daysUntilNextDelivery: 1,
    onHandSource: 'eod',
    eodSubmittedAt: `${AS_OF}T18:00:00Z`,
    vendorTotalCost: over.items.reduce((acc, it) => acc + it.estimatedCost, 0),
    hasPo: false,
    ...over,
  } as ReorderVendor;
}

// The server's coincident-day output (spec 201 §4): F on A only, carrying the
// new `yieldedFromVendors` naming B; B keeps only its own item G.
const F = item({
  itemId: 'item-f',
  itemName: 'Fryer Oil',
  otherVendorCount: 1,
  alsoFromVendors: [{ vendorId: 'vendor-b', vendorName: 'Bravo Supply' }],
  yieldedFromVendors: [{ vendorId: 'vendor-b', vendorName: 'Bravo Supply' }],
});
const G = item({ itemId: 'item-g', itemName: 'Gloves', estimatedCost: 5, costPerUnit: 0.5 });
const A = vendor({ vendorId: 'vendor-a', vendorName: 'Alpha Foods', items: [F] });
const B = vendor({ vendorId: 'vendor-b', vendorName: 'Bravo Supply', items: [G] });

const PAYLOAD: ReorderPayload = {
  asOfDate: AS_OF,
  vendors: [A, B],
  kpis: { vendorCount: 2, itemCount: 2, totalEstimatedCost: 25, eodSourcedVendorCount: 2, stockFallbackVendorCount: 0 },
  warnings: [],
} as unknown as ReorderPayload;

const INVENTORY = [
  { id: 'item-f', subUnitSize: 1 },
  { id: 'item-g', subUnitSize: 1 },
] as unknown as InventoryItem[];

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({
    currentStore: { id: STORE_ID, brandId: 'b1', name: 'Store S', address: '', status: 'active' },
    inventory: INVENTORY,
    reorderPayload: PAYLOAD,
  });
});

describe('spec 201 AC-24 — order paths take no F line for the yielding vendor', () => {
  it('buildDraftOrderLines: B has no F line; A has F', () => {
    const bLines = buildDraftOrderLines(B, undefined, INVENTORY);
    expect(bLines.map((l) => l.itemId)).toEqual(['item-g']);
    const aLines = buildDraftOrderLines(A, undefined, INVENTORY);
    expect(aLines.map((l) => l.itemId)).toEqual(['item-f']);
  });

  it('createPoDraft for B sends no F line to createPurchaseOrderDraft', async () => {
    const poId = await useStore.getState().createPoDraft(B);
    expect(poId).toBe('po-new');
    expect(createDraftMock).toHaveBeenCalledTimes(1);
    const sent = createDraftMock.mock.calls[0][0] as { vendorId: string; lines: Array<{ itemId: string }> };
    expect(sent.vendorId).toBe('vendor-b');
    expect(sent.lines.map((l) => l.itemId)).toEqual(['item-g']);
  });

  it('resolveExportBase for a B import config (Sysco / US Foods / CSV) has no F item', () => {
    const base = resolveExportBase(PAYLOAD, STORE_ID, { id: 'vendor-b', accountNumber: 'ACCT-B' });
    expect(base.items.map((i) => i.itemId)).toEqual(['item-g']);
    const baseA = resolveExportBase(PAYLOAD, STORE_ID, { id: 'vendor-a', accountNumber: 'ACCT-A' });
    expect(baseA.items.map((i) => i.itemId)).toEqual(['item-f']);
  });
});
