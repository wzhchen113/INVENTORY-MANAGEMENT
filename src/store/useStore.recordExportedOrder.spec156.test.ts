// src/store/useStore.recordExportedOrder.spec156.test.ts — Spec 156 (AC-20).
//
// Pins the export → draft-order recorder:
//   • `buildDraftOrderLines` (AC-2) — the pure helper extracted OUT of
//     `fillCartForVendor` so the two paths can never drift: the edit overlay,
//     the spec-104 ★ `costPerUnit × subUnitSize` bridge, the qty>0 / itemId
//     filter, and PARITY with the lines `fillCartForVendor` actually passes.
//   • `recordExportedOrder` (AC-3..AC-7, AC-12, D-4) — the ONE action the six
//     export call sites invoke: params, the silent guards, the never-rejects
//     failure posture, the POs-list-only refresh, the same-day upsert key, and
//     the in-flight de-dupe that closes finding F-1.
//   • AC-14 — `approveAndOrder` records NOTHING new: manual / instacart /
//     webstaurant call `upsertVendorDraftOrder` zero times, and `extension`
//     calls it exactly once (the UNCHANGED spec-138 path).
//
// Mocking mirrors useStore.fillCartForVendor.spec138.test.ts verbatim (stub
// ../lib/supabase, ../lib/auth, ../lib/db; db.upsertVendorDraftOrder is the
// assertion surface; the refresh chain stubbed inert; snapshot-and-replace state
// isolation), plus the spec-149 approval stubs needed to drive `approveAndOrder`
// for AC-14 — so this spec never has to touch spec 149's own suite.

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

// Targeted Linking stub (the webstaurant channel opens a URL). Spreading the
// whole `react-native` module eagerly evaluates its lazy getters and blows up in
// the node-env project, so mock the leaf module instead.
const mockOpenURL = jest.fn((..._a: any[]) => Promise.resolve(true));
jest.mock('react-native/Libraries/Linking/Linking', () => ({
  __esModule: true,
  default: { openURL: (...a: any[]) => mockOpenURL(...a), canOpenURL: jest.fn(() => Promise.resolve(true)) },
  openURL: (...a: any[]) => mockOpenURL(...a),
}));

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

// The `manual` approve channel dynamically imports the share orchestrator.
const mockShare = jest.fn((..._a: any[]) =>
  Promise.resolve({ shared: true, previewText: null as string | null }),
);
jest.mock('../screens/cmd/lib/sharePo', () => ({
  sharePurchaseOrder: (...a: any[]) => mockShare(...a),
}));

jest.mock('../lib/db', () => ({
  fetchStores: jest.fn().mockResolvedValue([]),
  fetchAllForStore: jest.fn().mockResolvedValue({
    brand: null, catalogIngredients: [], inventory: [], recipes: [], prepRecipes: [],
    vendors: [], wasteLog: [], auditLog: [], eodSubmissions: [], posRecipeAliases: [],
    recipeCategories: [], ingredientCategories: [], ingredientConversions: [],
  }),
  cleanupOldRecords: jest.fn().mockResolvedValue(undefined),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  // Spec 156 — THE assertion surface (the unchanged spec-138 writer).
  upsertVendorDraftOrder: jest.fn().mockResolvedValue('po-1'),
  // The post-record refresh chain; stubbed to inert shapes.
  fetchRecentPurchaseOrders: jest.fn().mockResolvedValue([]),
  fetchReorderSuggestions: jest.fn().mockResolvedValue(null),
  // Spec 149 approve-order surface — only used by the AC-14 block.
  createOrderApproval: jest.fn(),
  fetchOrderApproval: jest.fn().mockResolvedValue(null),
  advanceOrderApproval: jest.fn(),
  fetchEodSubmissionContext: jest.fn(),
  mintInstacartCartLink: jest.fn(),
}));

import * as db from '../lib/db';
import { useStore, buildDraftOrderLines } from './useStore';
import type { ReorderVendor, InventoryItem } from '../types';

const INITIAL_STATE = useStore.getState();
const upsertMock = db.upsertVendorDraftOrder as jest.Mock;
const createMock = db.createOrderApproval as jest.Mock;
const advanceMock = db.advanceOrderApproval as jest.Mock;
const mintMock = db.mintInstacartCartLink as jest.Mock;
const fetchApprovalMock = db.fetchOrderApproval as jest.Mock;
const Toast = require('react-native-toast-message').default as { show: jest.Mock };

const flush = () => new Promise<void>((r) => setImmediate(r));

function makeVendor(over?: Partial<ReorderVendor>): ReorderVendor {
  return {
    vendorId: 'v1',
    vendorName: 'US FOODS',
    daysUntil: 0,
    scheduleKnown: true,
    nextDeliveryDate: '2026-08-09',
    items: [
      { itemId: 'item-1', itemName: 'Wings', suggestedUnits: 3, suggestedQty: 3, costPerUnit: 2 } as any,
    ],
    ...over,
  } as ReorderVendor;
}

const INVENTORY = [
  { id: 'item-1', catalogId: 'cat-1', subUnitSize: 4, storeId: 'store-1' } as any as InventoryItem,
];

// The `(store, reorder date)` a call site snapshots BEFORE its first await.
// Matches the seeded state below, so the happy path is a clean match.
const CTX = { storeId: 'store-1', referenceDate: '2026-08-08' };

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState(INITIAL_STATE, true);
  upsertMock.mockResolvedValue('po-1');
  mockShare.mockResolvedValue({ shared: true, previewText: null });
  fetchApprovalMock.mockResolvedValue(null);
  advanceMock.mockImplementation((_id: string, patch: any) =>
    Promise.resolve({ id: 'ap-1', ...patch, channel: patch.channel ?? 'instacart' }),
  );
  useStore.setState({
    currentStore: { id: 'store-1', name: 'Frederick' } as any,
    currentUser: { id: 'user-1' } as any,
    stores: [{ id: 'store-1', name: 'Frederick' } as any],
    inventory: INVENTORY as any,
    reorderPayload: { asOfDate: '2026-08-08', vendors: [], kpis: {} as any, warnings: [] } as any,
    reorderEdits: { v1: { 'item-1': 5 } },
  });
});

// ── AC-2: the extracted pure helper ─────────────────────────────────────────
describe('buildDraftOrderLines — purity, overlay, and the ★ spec-104 bridge', () => {
  it('applies the edit overlay and costPerUnit × subUnitSize', () => {
    expect(buildDraftOrderLines(makeVendor(), { 'item-1': 5 }, INVENTORY)).toEqual([
      { itemId: 'item-1', orderedQty: 5, costPerUnitCounted: 8 },
    ]);
  });

  it('falls back to the server suggestion when the item has no edit', () => {
    expect(buildDraftOrderLines(makeVendor(), undefined, INVENTORY)[0].orderedQty).toBe(3);
  });

  it('falls back to suggestedQty when suggestedUnits is absent', () => {
    const v = makeVendor({
      items: [{ itemId: 'item-1', itemName: 'Wings', suggestedUnits: 0, suggestedQty: 7, costPerUnit: 2 } as any],
    });
    expect(buildDraftOrderLines(v, undefined, INVENTORY)[0].orderedQty).toBe(7);
  });

  it('★ defaults subUnitSize to 1 when the inventory row is missing', () => {
    expect(buildDraftOrderLines(makeVendor(), undefined, [])[0].costPerUnitCounted).toBe(2);
  });

  it('drops zero-qty and id-less lines', () => {
    const v = makeVendor({
      items: [
        { itemId: 'item-1', suggestedUnits: 0, suggestedQty: 0, costPerUnit: 2 } as any,
        { itemId: '', suggestedUnits: 9, suggestedQty: 9, costPerUnit: 2 } as any,
      ],
    });
    expect(buildDraftOrderLines(v, undefined, INVENTORY)).toEqual([]);
  });

  it('is pure — it mutates neither the vendor, the edits, nor the inventory', () => {
    const vendor = makeVendor();
    const edits = { 'item-1': 5 };
    const inv = [...INVENTORY];
    const vendorSnapshot = JSON.parse(JSON.stringify(vendor));
    const editsSnapshot = { ...edits };
    const invSnapshot = JSON.parse(JSON.stringify(inv));
    buildDraftOrderLines(vendor, edits, inv);
    expect(vendor).toEqual(vendorSnapshot);
    expect(edits).toEqual(editsSnapshot);
    expect(inv).toEqual(invSnapshot);
  });

  it('PARITY: its output deep-equals the lines fillCartForVendor passes to the writer', async () => {
    const vendor = makeVendor();
    await useStore.getState().fillCartForVendor(vendor);
    await flush();
    const fillCartLines = upsertMock.mock.calls[0][0].lines;
    expect(buildDraftOrderLines(vendor, { 'item-1': 5 }, INVENTORY)).toEqual(fillCartLines);
  });

  it('PARITY (no edits): same lines through both paths', async () => {
    useStore.setState({ reorderEdits: {} });
    const vendor = makeVendor();
    await useStore.getState().fillCartForVendor(vendor);
    await flush();
    expect(buildDraftOrderLines(vendor, undefined, INVENTORY)).toEqual(
      upsertMock.mock.calls[0][0].lines,
    );
  });
});

// ── AC-3: the params ────────────────────────────────────────────────────────
describe('recordExportedOrder — params (AC-3)', () => {
  it('passes storeId / vendorId / createdByUserId / referenceDate / lines', async () => {
    const poId = await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();

    expect(poId).toBe('po-1');
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0]).toEqual({
      storeId: 'store-1',
      vendorId: 'v1',
      createdByUserId: 'user-1',
      referenceDate: '2026-08-08', // = reorderPayload.asOfDate
      // Edited 5 (NOT the server suggestion 3); cost = costPerUnit(2) × subUnitSize(4).
      lines: [{ itemId: 'item-1', orderedQty: 5, costPerUnitCounted: 8 }],
    });
  });

  it('does NOT clear the edit buffer — the call site owns that (D-2 property 4)', async () => {
    await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();
    expect(useStore.getState().reorderEdits.v1).toEqual({ 'item-1': 5 });
  });
});

// ── AC-4 / AC-5: the SILENT guards ──────────────────────────────────────────
// Note the store now comes from the export-start SNAPSHOT, so AC-4 is expressed
// as "the export STARTED with no single active store".
describe('recordExportedOrder — silent guards (AC-4, AC-5)', () => {
  it('no active store at export start → no write, no toast', async () => {
    useStore.setState({ currentStore: null as any });
    const res = await useStore.getState().recordExportedOrder(makeVendor(), {
      storeId: undefined, referenceDate: '2026-08-08',
    });
    await flush();
    expect(res).toBeNull();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it("'__all__' (no single store) at export start → no write, no toast", async () => {
    useStore.setState({ currentStore: { id: '__all__', name: 'All stores' } as any });
    const res = await useStore.getState().recordExportedOrder(makeVendor(), {
      storeId: '__all__', referenceDate: '2026-08-08',
    });
    await flush();
    expect(res).toBeNull();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('every line filtered out → no write, no toast, no empty draft header', async () => {
    useStore.setState({ reorderEdits: { v1: { 'item-1': 0 } } });
    expect(await useStore.getState().recordExportedOrder(makeVendor(), CTX)).toBeNull();
    await flush();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
  });
});

// ── Security review (2026-08-08) Medium 1 — mid-export store switch ─────────
//
// The call sites are async closures that await a user-paced share sheet / a
// `jspdf` chunk fetch. The desktop TitleBar store switcher stays live during
// that window. The recorded row must never be filed against a store the export
// did not come from: store A's item ids, quantities and costs under
// `store_id = B` would be readable by store-B-only members (RLS admits the
// write because the operator can see both).
describe('mid-export store switch is REFUSED, not mis-filed (Medium 1)', () => {
  it('records nothing and reports when the active store changed during the export', async () => {
    // Export started on store-1 (CTX); the operator switched to store-2 while
    // the share sheet / PDF chunk fetch was in flight.
    useStore.setState({ currentStore: { id: 'store-2', name: 'Baltimore' } as any });

    const res = await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();

    expect(res).toBeNull();
    // Critically: NOT written under store-2, and NOT written under store-1
    // either — we refuse rather than guess.
    expect(upsertMock).not.toHaveBeenCalled();
    // Reported (not silent): the operator caused it and can re-export.
    expect(Toast.show).toHaveBeenCalledTimes(1);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: 'Record exported order failed',
        text2: 'Active store changed during the export — not recorded',
      }),
    );
  });

  it('records normally when the store is unchanged (the guard is not over-eager)', async () => {
    const res = await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();
    expect(res).toBe('po-1');
    expect(upsertMock.mock.calls[0][0].storeId).toBe('store-1');
    expect(Toast.show).not.toHaveBeenCalled();
  });
});

// ── Security review (2026-08-08) Medium 2 — the undated-draft escape ────────
//
// `loadFromSupabase` nulls `reorderPayload` on EVERY realtime reload, including
// the self-echo of the draft this feature just wrote. A `referenceDate` read at
// record time could therefore be `undefined`, sending
// `upsertVendorDraftOrder` down its `reference_date IS NULL` branch — a SECOND
// draft header for the same day, invisible to `report_reorder_list.has_po` and
// un-collapsible by the D-4 key.
describe('the reference date is snapshotted, never re-read (Medium 2)', () => {
  it('records the EXPORT-START date even after a realtime reload nulled reorderPayload', async () => {
    // The echo landed while the export was still in flight.
    useStore.setState({ reorderPayload: null as any });

    const res = await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();

    expect(res).toBe('po-1');
    // The dated key survived — no `reference_date IS NULL` branch.
    expect(upsertMock.mock.calls[0][0].referenceDate).toBe('2026-08-08');
  });

  it('two in-flight exports still collapse to ONE write after the echo (D-4 key stable)', async () => {
    let release: (v: string) => void = () => {};
    upsertMock.mockImplementationOnce(
      () => new Promise<string>((r) => { release = r; }),
    );

    // Export #1 (a CSV) is in flight…
    const first = useStore.getState().recordExportedOrder(makeVendor(), CTX);
    // …its own draft INSERT echoes back and nulls the payload…
    useStore.setState({ reorderPayload: null as any });
    // …and export #2 (a PDF, pressed before the echo) now resolves. Before the
    // fix its referenceDate was `undefined`, producing a DIFFERENT D-4 key and
    // a second draft header. It must collapse into the in-flight key instead.
    const second = useStore.getState().recordExportedOrder(makeVendor(), CTX);

    await expect(second).resolves.toBeNull();
    expect(upsertMock).toHaveBeenCalledTimes(1);

    release('po-1');
    await expect(first).resolves.toBe('po-1');
    await flush();
  });

  it('an export with NO reorder date to key against records nothing, silently', async () => {
    const res = await useStore.getState().recordExportedOrder(makeVendor(), {
      storeId: 'store-1', referenceDate: undefined,
    });
    await flush();
    // An UNDATED draft escapes the upsert key, the D-4 key and `has_po` — worse
    // than no draft, so we refuse. Silent: same family as the AC-4/AC-5 guards.
    expect(res).toBeNull();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
  });
});

// ── AC-6: never breaks (or rejects into) the export ─────────────────────────
describe('recordExportedOrder — failure posture (AC-6 / OQ-1)', () => {
  it('a null po id reports once via notifyBackendError and returns null', async () => {
    upsertMock.mockResolvedValueOnce(null);
    await expect(useStore.getState().recordExportedOrder(makeVendor(), CTX)).resolves.toBeNull();
    await flush();
    expect(Toast.show).toHaveBeenCalledTimes(1);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text1: 'Record exported order failed' }),
    );
  });

  it('a thrown write NEVER rejects — it resolves null and reports', async () => {
    upsertMock.mockRejectedValueOnce(new Error('rls denied'));
    await expect(useStore.getState().recordExportedOrder(makeVendor(), CTX)).resolves.toBeNull();
    await flush();
    expect(Toast.show).toHaveBeenCalledTimes(1);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text2: 'rls denied' }),
    );
  });

  it('a failure leaves the edit buffer untouched (nothing is reverted)', async () => {
    upsertMock.mockRejectedValueOnce(new Error('boom'));
    await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();
    expect(useStore.getState().reorderEdits.v1).toEqual({ 'item-1': 5 });
  });
});

// ── AC-7 / OQ-6: POs list only ──────────────────────────────────────────────
describe('recordExportedOrder — post-write refresh (AC-7 / OQ-6)', () => {
  it('refreshes the PO list and NOT the reorder suggestions', async () => {
    await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();
    expect(db.fetchRecentPurchaseOrders).toHaveBeenCalledWith('store-1');
    expect(db.fetchReorderSuggestions).not.toHaveBeenCalled();
  });

  it('does not refresh when nothing was written', async () => {
    upsertMock.mockResolvedValueOnce(null);
    await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();
    expect(db.fetchRecentPurchaseOrders).not.toHaveBeenCalled();
  });
});

// ── AC-12: same-day re-export rides ONE upsert key ──────────────────────────
describe('recordExportedOrder — same-day re-export (AC-12)', () => {
  it('every call carries an identical (storeId, vendorId, referenceDate) key', async () => {
    const qtys = [5, 8, 2, 11];
    for (const q of qtys) {
      useStore.setState({ reorderEdits: { v1: { 'item-1': q } } });
      await useStore.getState().recordExportedOrder(makeVendor(), CTX);
      await flush();
    }
    expect(upsertMock).toHaveBeenCalledTimes(4);
    const keys = upsertMock.mock.calls.map(([p]: any[]) => ({
      storeId: p.storeId, vendorId: p.vendorId, referenceDate: p.referenceDate,
    }));
    for (const k of keys) {
      expect(k).toEqual({ storeId: 'store-1', vendorId: 'v1', referenceDate: '2026-08-08' });
    }
    // …while the LAST export's quantities are what the writer was handed last.
    expect(upsertMock.mock.calls[3][0].lines[0].orderedQty).toBe(11);
  });
});

// ── D-4 (finding F-1): the in-flight de-dupe ────────────────────────────────
describe('recordExportedOrder — in-flight key de-dupe (D-4 / F-1)', () => {
  it('a double-fire for the same key writes ONCE, and the key is released after', async () => {
    let release: (v: string) => void = () => {};
    upsertMock.mockImplementationOnce(
      () => new Promise<string>((r) => { release = r; }),
    );

    const first = useStore.getState().recordExportedOrder(makeVendor(), CTX);
    const second = useStore.getState().recordExportedOrder(makeVendor(), CTX);

    // The second click is swallowed — one concurrent write, one draft header.
    await expect(second).resolves.toBeNull();
    expect(upsertMock).toHaveBeenCalledTimes(1);

    release('po-1');
    await expect(first).resolves.toBe('po-1');
    await flush();

    // Key released in the `finally` → a LATER export for the same key writes again.
    await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  it('a DIFFERENT vendor is never blocked by an in-flight key', async () => {
    let release: (v: string) => void = () => {};
    upsertMock.mockImplementationOnce(
      () => new Promise<string>((r) => { release = r; }),
    );
    const first = useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await useStore.getState().recordExportedOrder(makeVendor({ vendorId: 'v2' }), CTX);
    expect(upsertMock).toHaveBeenCalledTimes(2);
    release('po-1');
    await first;
    await flush();
  });

  it('releases the key even when the write throws', async () => {
    upsertMock.mockRejectedValueOnce(new Error('boom'));
    await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();
    await useStore.getState().recordExportedOrder(makeVendor(), CTX);
    await flush();
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });
});

// ── AC-14: Approve Order records NOTHING new ────────────────────────────────
describe('approveAndOrder records no export draft (AC-14)', () => {
  const approvalRow = (over?: Record<string, any>) => ({
    id: 'ap-1',
    storeId: 'store-1',
    vendorId: 'v1',
    businessDate: '2026-08-08',
    approvedBy: 'user-1',
    approvedAt: '2026-08-08T23:00:00Z',
    channel: 'instacart',
    status: 'pending',
    lines: [{ itemId: 'item-1', itemName: 'Wings', qtyBase: 5, caseQty: 6, unit: 'each', costPerCountedUnit: 8 }],
    lineCount: 1,
    estTotalCost: 40,
    externalRef: null,
    externalRefExpiresAt: null,
    orderedAt: null,
    sourceSubmissionId: 'sub-1',
    ...over,
  });

  beforeEach(() => {
    useStore.setState({
      vendors: [{
        id: 'v1', name: 'US FOODS', extensionOrdering: true, orderUnit: 'case',
        orderPageUrl: 'https://webstaurant.example/rapid',
      } as any],
      approvalContext: {
        submissionId: 'sub-1', storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-08',
      },
    });
  });

  it('manual → upsertVendorDraftOrder is called ZERO times', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'manual' }));
    await useStore.getState().approveAndOrder(makeVendor());
    await flush();
    expect(mockShare).toHaveBeenCalledTimes(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('instacart → upsertVendorDraftOrder is called ZERO times', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'instacart' }));
    mintMock.mockResolvedValue({ ok: true, url: 'https://instacart.example/c/1', expiresAt: null, reused: false });
    await useStore.getState().approveAndOrder(makeVendor());
    await flush();
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('webstaurant → upsertVendorDraftOrder is called ZERO times', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'webstaurant' }));
    await useStore.getState().approveAndOrder(makeVendor());
    await flush();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('extension → exactly ONE call (the unchanged spec-138 fillCart path)', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'extension' }));
    await useStore.getState().approveAndOrder(makeVendor());
    await flush();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});
