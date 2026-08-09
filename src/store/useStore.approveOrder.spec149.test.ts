// src/store/useStore.approveOrder.spec149.test.ts — Spec 149 (AC-28, jest track).
//
// Pins the `approveAndOrder` slice — the ONE primary action behind the phone
// Approve Order screen:
//   • the line snapshot: the reorderEdits overlay + the spec-104 ★ per-each →
//     per-counted-unit cost bridge (`costPerUnit × subUnitSize`);
//   • channel → primary-action routing for ALL FOUR channels (AC-15..AC-18),
//     with the channel taken from the SERVER-returned approval row (the client
//     never supplies it);
//   • the OQ-2 `retailer_unavailable` → fallbackChannel re-route (§5.5), which
//     must re-run exactly ONCE and must NOT open a link;
//   • AC-15's no-silent-fake-success posture: an upstream failure leaves the row
//     at `pending` (retriable) and returns null;
//   • R-6: an already-approved row comes back verbatim with no channel run;
//   • guidance 6: `approvalBusy` makes a double-tap a client-side no-op;
//   • AC-20 / OQ-3: `markOrderApprovalOrdered` is optimistic-then-revert and the
//     app NEVER infers `ordered` from link generation.
//
// Mocking mirrors useStore.fillCartForVendor.spec138.test.ts.

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

// Targeted Linking stub — spreading the whole `react-native` module eagerly
// evaluates its lazy getters (DevMenu → TurboModuleRegistry) and blows up in
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
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
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

// The `manual` channel dynamically imports the share orchestrator; the
// dynamic-import babel transform (tests/babel-jest-dynamic-import.js) routes it
// through jest's registry, so this factory intercepts it.
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
  // Spec 149 assertion surface.
  createOrderApproval: jest.fn(),
  fetchOrderApproval: jest.fn().mockResolvedValue(null),
  advanceOrderApproval: jest.fn(),
  fetchEodSubmissionContext: jest.fn(),
  mintInstacartCartLink: jest.fn(),
  // Fired by the extension branch + the post-fill refresh chain.
  upsertVendorDraftOrder: jest.fn().mockResolvedValue('po-9'),
  fetchRecentPurchaseOrders: jest.fn().mockResolvedValue([]),
  fetchReorderSuggestions: jest.fn().mockResolvedValue(null),
}));

import * as db from '../lib/db';
import { useStore, buildOrderApprovalLines } from './useStore';
import type { ReorderVendor } from '../types';

const INITIAL_STATE = useStore.getState();
const createMock = db.createOrderApproval as jest.Mock;
const advanceMock = db.advanceOrderApproval as jest.Mock;
const mintMock = db.mintInstacartCartLink as jest.Mock;
const fetchApprovalMock = db.fetchOrderApproval as jest.Mock;
const ctxMock = db.fetchEodSubmissionContext as jest.Mock;
const upsertMock = db.upsertVendorDraftOrder as jest.Mock;

const flush = () => new Promise<void>((r) => setImmediate(r));

function approvalRow(over?: Record<string, any>) {
  return {
    id: 'ap-1',
    storeId: 'store-1',
    vendorId: 'v1',
    businessDate: '2026-08-01',
    approvedBy: 'user-1',
    approvedAt: '2026-08-01T23:00:00Z',
    channel: 'instacart',
    status: 'pending',
    lines: [],
    lineCount: 1,
    estTotalCost: 40,
    externalRef: null,
    externalRefExpiresAt: null,
    orderedAt: null,
    sourceSubmissionId: 'sub-1',
    ...over,
  };
}

function makeVendor(over?: Partial<ReorderVendor>): ReorderVendor {
  return {
    vendorId: 'v1',
    vendorName: "BJ's",
    scheduleKnown: true,
    nextDeliveryDate: '2026-08-02',
    daysUntilNextDelivery: 1,
    onHandSource: 'eod',
    eodSubmittedAt: '2026-08-01T22:00:00Z',
    vendorTotalCost: 40,
    items: [
      {
        itemId: 'item-1', itemName: 'Buns', unit: 'each', caseQty: 6,
        suggestedUnits: 3, suggestedQty: 3, suggestedCases: null,
        costPerUnit: 2, estimatedCost: 40, onHand: 0, pendingPoQty: 0,
        parLevel: 10, usageForecasted: 0, parReplacement: 10, flags: [],
      } as any,
    ],
    ...over,
  } as ReorderVendor;
}

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState(INITIAL_STATE, true);
  fetchApprovalMock.mockResolvedValue(null);
  advanceMock.mockImplementation((_id: string, patch: any) =>
    Promise.resolve(approvalRow({ ...patch, channel: patch.channel ?? 'instacart' })),
  );
  upsertMock.mockResolvedValue('po-9');
  mockShare.mockResolvedValue({ shared: true, previewText: null });
  useStore.setState({
    currentStore: { id: 'store-1', name: 'Frederick' } as any,
    currentUser: { id: 'user-1' } as any,
    stores: [{ id: 'store-1', name: 'Frederick' } as any],
    inventory: [{ id: 'item-1', name: 'Buns', subUnitSize: 4, storeId: 'store-1' } as any],
    vendors: [{ id: 'v1', name: "BJ's", extensionOrdering: true, orderUnit: 'case', orderPageUrl: 'https://webstaurant.example/rapid' } as any],
    reorderPayload: { asOfDate: '2026-08-01', vendors: [], kpis: {} as any, warnings: [] } as any,
    reorderEdits: { v1: { 'item-1': 5 } },
    approvalContext: {
      submissionId: 'sub-1', storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01',
    },
  });
});

// ── The ★ bridge ────────────────────────────────────────────────────────────
describe('buildOrderApprovalLines — spec-104 ★ bridge + edit overlay', () => {
  it('uses the EDITED base qty and costPerUnit × subUnitSize', () => {
    const lines = buildOrderApprovalLines(
      makeVendor(),
      { 'item-1': 5 },
      [{ id: 'item-1', subUnitSize: 4 } as any],
    );
    expect(lines).toEqual([
      { itemId: 'item-1', itemName: 'Buns', qtyBase: 5, caseQty: 6, unit: 'each', costPerCountedUnit: 8 },
    ]);
  });

  it('falls back to the server suggestion when the item has no edit', () => {
    const lines = buildOrderApprovalLines(makeVendor(), undefined, [
      { id: 'item-1', subUnitSize: 4 } as any,
    ]);
    expect(lines[0].qtyBase).toBe(3);
  });

  it('drops zero-qty lines (the RPC requires qty > 0)', () => {
    const lines = buildOrderApprovalLines(makeVendor(), { 'item-1': 0 }, []);
    expect(lines).toEqual([]);
  });

  it('defaults subUnitSize to 1 when the inventory row is missing', () => {
    const lines = buildOrderApprovalLines(makeVendor(), undefined, []);
    expect(lines[0].costPerCountedUnit).toBe(2);
  });
});

// ── loadOrderApproval ───────────────────────────────────────────────────────
describe('loadOrderApproval — deep-link resolution', () => {
  it('resolves the submission → context → existing approval', async () => {
    ctxMock.mockResolvedValue({
      id: 'sub-1', storeId: 'store-1', vendorId: 'v1',
      businessDate: '2026-08-01', status: 'submitted', submittedAt: 'x',
    });
    fetchApprovalMock.mockResolvedValue(approvalRow({ status: 'approved' }));
    await useStore.getState().loadOrderApproval({ submissionId: 'sub-1', storeId: 'store-1' });
    const s = useStore.getState();
    expect(s.approvalContext).toEqual({
      submissionId: 'sub-1', storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01',
    });
    expect(s.approval?.status).toBe('approved');
    expect(s.approvalError).toBeNull();
  });

  it('surfaces a read failure in approvalError (in-screen pane, not a toast)', async () => {
    ctxMock.mockRejectedValue(new Error('boom'));
    await useStore.getState().loadOrderApproval({ submissionId: 'sub-1', storeId: 'store-1' });
    expect(useStore.getState().approvalError).toBe('boom');
    expect(useStore.getState().approvalContext).toBeNull();
  });
});

// ── Channel routing (AC-15..AC-18) ──────────────────────────────────────────
describe('approveAndOrder — channel routing', () => {
  it('instacart: persists, mints the link, opens it, and re-reads the row', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'instacart' }));
    mintMock.mockResolvedValue({ ok: true, url: 'https://instacart.example/c/1', expiresAt: null, reused: false });
    fetchApprovalMock.mockResolvedValue(approvalRow({ channel: 'instacart', status: 'approved', externalRef: 'https://instacart.example/c/1' }));

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    // Lines carry the edit overlay + ★ bridge, and the client never sends a channel.
    const [params] = createMock.mock.calls[0];
    expect(params.storeId).toBe('store-1');
    expect(params.vendorId).toBe('v1');
    expect(params.businessDate).toBe('2026-08-01');
    expect(params.sourceSubmissionId).toBe('sub-1');
    expect(params.lines[0]).toMatchObject({ itemId: 'item-1', qtyBase: 5, costPerCountedUnit: 8 });
    expect(params.channel).toBeUndefined();

    expect(mintMock).toHaveBeenCalledWith('ap-1');
    expect(res).toEqual({ channel: 'instacart', url: 'https://instacart.example/c/1' });
    expect(useStore.getState().approval?.status).toBe('approved');
  });

  it('webstaurant: opens the order page, records the approval, makes NO api call', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'webstaurant' }));

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(mintMock).not.toHaveBeenCalled();
    expect(res).toEqual({ channel: 'webstaurant', url: 'https://webstaurant.example/rapid' });
    expect(advanceMock).toHaveBeenCalledWith('ap-1', {
      status: 'approved', externalRef: 'https://webstaurant.example/rapid',
    });
  });

  // security-auditor Medium 1 (spec 149 review round) — `vendors.order_page_url`
  // is operator-writable free text, so a planted `javascript:` value must be
  // refused by the shared opener's http(s) allowlist BEFORE anything opens, and
  // must NOT record an approval for a page that never opened.
  it('webstaurant with a javascript: order page opens nothing and does not approve', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'webstaurant' }));
    useStore.setState({
      vendors: [{
        id: 'v1', extensionOrdering: false, orderUnit: 'case',
        orderPageUrl: 'javascript:alert(document.cookie)',
      } as any],
    });

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(res).toBeNull();
    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(mintMock).not.toHaveBeenCalled();
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('webstaurant with no configured order page refuses instead of half-approving', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'webstaurant' }));
    useStore.setState({ vendors: [{ id: 'v1', extensionOrdering: false, orderUnit: 'case', orderPageUrl: null } as any] });

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(res).toBeNull();
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('extension: runs the UNCHANGED spec-138 fillCartForVendor handoff (AC-REG-3)', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'extension' }));

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(mintMock).not.toHaveBeenCalled();
    // The frozen spec-131/132 RPC is what actually ran.
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ channel: 'extension' });
    expect(advanceMock).toHaveBeenCalledWith('ap-1', { status: 'approved', externalRef: 'po-9' });
  });

  it('manual: runs the EXISTING quick-order share path, then approves', async () => {
    createMock.mockResolvedValue(
      approvalRow({
        channel: 'manual',
        lines: [{ itemId: 'item-1', itemName: 'Buns', qtyBase: 5, caseQty: 6, unit: 'each', costPerCountedUnit: 8 }],
      }),
    );

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(mintMock).not.toHaveBeenCalled();
    expect(mockShare).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ channel: 'manual' });
    expect(advanceMock).toHaveBeenCalledWith('ap-1', { status: 'approved' });
  });

  it('manual: a DISMISSED share does not advance the approval', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'manual', lines: [] }));
    mockShare.mockResolvedValue({ shared: false, previewText: null });

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(res).toBeNull();
    expect(advanceMock).not.toHaveBeenCalled();
  });
});

// ── OQ-2 fallback (§5.5) ────────────────────────────────────────────────────
describe('approveAndOrder — retailer_unavailable fallback (OQ-2)', () => {
  it('re-routes to the server-supplied extension channel and never opens a link', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'instacart' }));
    mintMock.mockResolvedValue({
      ok: false, error: 'retailer_unavailable', fallbackChannel: 'extension', postalCode: null,
    });

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    // Channel switched on the pending row, then the cart-filler ran.
    expect(advanceMock).toHaveBeenCalledWith('ap-1', { channel: 'extension' });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ channel: 'extension' });
    // Exactly ONE mint attempt — the fallback must not recurse back to Instacart.
    expect(mintMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to manual when the function reports no extension adapter', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'instacart', lines: [] }));
    mintMock.mockResolvedValue({ ok: false, error: 'retailer_unavailable', fallbackChannel: 'manual' });

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(mockShare).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ channel: 'manual' });
  });
});

// ── Spec 155 AC-17 — the advisory info toast (the demoted probe) ────────────
//
// Spec 155 demoted the `instacart-cart-link` retailer-availability probe from
// blocking (409 / short-circuit) to ADVISORY: the minted link is retailer-
// agnostic, so a missing ZIP, an unlisted retailer key or a failed probe
// predict nothing about whether the link works. The client's job is therefore
// narrow and must stay narrow — ONE info toast, and the link still opens. An
// advisory must never become an error toast, never re-route the channel, and
// never consume the `allowFallback` budget.
describe('approveAndOrder — advisory toasts (spec 155 AC-17)', () => {
  const Toast = require('react-native-toast-message').default as { show: jest.Mock };

  const advisoryCases = [
    ['no_postal_code', 'section.approveOrder.advisoryNoPostalCode'],
    ['retailer_not_in_zip', 'section.approveOrder.advisoryRetailerNotInZip'],
    ['retailers_probe_failed', 'section.approveOrder.advisoryProbeFailed'],
  ] as const;

  it.each(advisoryCases)(
    '%s: shows ONE info toast, still opens the link, still re-reads the row',
    async (advisory) => {
      createMock.mockResolvedValue(approvalRow({ channel: 'instacart' }));
      mintMock.mockResolvedValue({
        ok: true, url: 'https://instacart.example/c/1', expiresAt: null, reused: false, advisory,
      });
      fetchApprovalMock.mockResolvedValue(approvalRow({ channel: 'instacart', status: 'approved' }));

      const res = await useStore.getState().approveAndOrder(makeVendor());
      await flush();

      // The link opened and the row was re-read — the advisory changes NOTHING
      // about the happy path.
      expect(res).toEqual({ channel: 'instacart', url: 'https://instacart.example/c/1' });
      expect(mockOpenURL).toHaveBeenCalledWith('https://instacart.example/c/1');
      expect(useStore.getState().approval?.status).toBe('approved');
      // No re-route: exactly one mint, and the channel was never advanced.
      expect(mintMock).toHaveBeenCalledTimes(1);
      expect(advanceMock).not.toHaveBeenCalled();

      // Exactly one toast, type INFO — never 'error', never notifyBackendError.
      expect(Toast.show).toHaveBeenCalledTimes(1);
      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'info', visibilityTime: 5000 }),
      );
      expect(Toast.show).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    },
  );

  it.each(advisoryCases)('%s maps to its own i18n string (OQ-6 — three, not one)', async (advisory, key) => {
    createMock.mockResolvedValue(approvalRow({ channel: 'instacart' }));
    mintMock.mockResolvedValue({
      ok: true, url: 'https://instacart.example/c/1', expiresAt: null, reused: false, advisory,
    });
    // `locale` is not a real catalog lookup under test here — assert the three
    // tokens produce three DISTINCT strings, which is the OQ-6 contract.
    await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    const text = Toast.show.mock.calls[0][0].text1 as string;
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    // Not the raw key: it resolved through the catalog.
    expect(text).not.toBe(key);
  });

  it('produces three DISTINCT strings across the three tokens', async () => {
    const texts: string[] = [];
    for (const [advisory] of advisoryCases) {
      jest.clearAllMocks();
      createMock.mockResolvedValue(approvalRow({ channel: 'instacart' }));
      fetchApprovalMock.mockResolvedValue(null);
      mintMock.mockResolvedValue({
        ok: true, url: 'https://instacart.example/c/1', expiresAt: null, reused: false, advisory,
      });
      useStore.setState({ approvalBusy: false });
      await useStore.getState().approveAndOrder(makeVendor());
      await flush();
      texts.push(Toast.show.mock.calls[0][0].text1);
    }
    expect(new Set(texts).size).toBe(3);
  });

  it('NO advisory ⇒ no extra toast at all (the clean-probe case)', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'instacart' }));
    mintMock.mockResolvedValue({
      ok: true, url: 'https://instacart.example/c/1', expiresAt: null, reused: false,
    });

    await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    expect(Toast.show).not.toHaveBeenCalled();
  });
});

// ── Failure + idempotency posture ───────────────────────────────────────────
describe('approveAndOrder — failure, replay, and double-tap', () => {
  it('an upstream error returns null and leaves the row PENDING (retriable, AC-15)', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'instacart' }));
    mintMock.mockResolvedValue({ ok: false, error: 'upstream_error' });

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(res).toBeNull();
    expect(useStore.getState().approval?.status).toBe('pending');
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('an ALREADY-approved row is returned verbatim; no channel action runs (R-6)', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'instacart', status: 'approved' }));

    const res = await useStore.getState().approveAndOrder(makeVendor());
    await flush();

    expect(res).toEqual({ channel: 'instacart' });
    expect(mintMock).not.toHaveBeenCalled();
    expect(useStore.getState().approval?.status).toBe('approved');
  });

  it('a double-tap is a client-side no-op while approvalBusy (guidance 6)', async () => {
    createMock.mockResolvedValue(approvalRow({ channel: 'webstaurant' }));
    const first = useStore.getState().approveAndOrder(makeVendor());
    const second = useStore.getState().approveAndOrder(makeVendor());
    expect(await second).toBeNull();
    await first;
    await flush();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('refuses with no context (nothing to approve against)', async () => {
    useStore.setState({ approvalContext: null });
    expect(await useStore.getState().approveAndOrder(makeVendor())).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses when every line nets to zero', async () => {
    useStore.setState({ reorderEdits: { v1: { 'item-1': 0 } } });
    expect(await useStore.getState().approveAndOrder(makeVendor())).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});

// ── markOrderApprovalOrdered (AC-20 / OQ-3) ─────────────────────────────────
describe('markOrderApprovalOrdered — optimistic-then-revert', () => {
  it('flips to ordered and keeps the server row on success', async () => {
    useStore.setState({ approval: approvalRow({ status: 'approved' }) as any });
    advanceMock.mockResolvedValue(approvalRow({ status: 'ordered', orderedAt: '2026-08-02T01:00:00Z' }));
    await useStore.getState().markOrderApprovalOrdered();
    expect(advanceMock).toHaveBeenCalledWith('ap-1', { status: 'ordered' });
    expect(useStore.getState().approval?.status).toBe('ordered');
  });

  it('reverts to the previous row when the trigger rejects the transition', async () => {
    const prev = approvalRow({ status: 'approved' });
    useStore.setState({ approval: prev as any });
    advanceMock.mockRejectedValue(new Error('illegal order approval status transition'));
    await useStore.getState().markOrderApprovalOrdered();
    expect(useStore.getState().approval).toEqual(prev);
  });

  it('is a no-op once the row is already ordered', async () => {
    useStore.setState({ approval: approvalRow({ status: 'ordered' }) as any });
    await useStore.getState().markOrderApprovalOrdered();
    expect(advanceMock).not.toHaveBeenCalled();
  });
});
