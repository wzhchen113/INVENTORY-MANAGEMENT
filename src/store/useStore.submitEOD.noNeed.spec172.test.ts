// src/store/useStore.submitEOD.noNeed.spec172.test.ts — Spec 172 (AC-23; design §8).
//
// The store's optimistic `submitEOD` is the THIRD on-hand writer (the db.ts
// submitEODCount loop and the staff RPC's hunk S3 are the other two). For a
// NO NEED entry it must:
//   • NOT mirror currentStock / eodRemaining locally,
//   • NOT call db.adjustItemStock,
//   • still emit its audit event, with value 'NO NEED'.
// A numeric entry in the same submission keeps today's behavior verbatim.
//
// Mocking follows useStore.lastCounted.spec160.test.ts: stub ../lib/supabase
// (module-eval crash guard; `rpc` resolves for the broadcast_notification
// fire-and-forget), ../lib/auth, and ../lib/db (namespace import).

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
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
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

jest.mock('../lib/auth', () => ({
  deleteUser: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
  hasActiveSession: jest.fn().mockResolvedValue(true),
}));

jest.mock('../lib/db', () => ({
  adjustItemStock: jest.fn().mockResolvedValue(undefined),
  addAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

import * as db from '../lib/db';
import { useStore } from './useStore';
import type { EODEntry, EODSubmission, InventoryItem } from '../types';

const STORE = 'store-a';
const VENDOR = 'vendor-1';

function mkItem(over: Partial<InventoryItem>): InventoryItem {
  return {
    id: 'item', catalogId: 'cat', name: 'Item', category: 'produce', unit: 'lb',
    costPerUnit: 1, currentStock: 7, parLevel: 10, averageDailyUsage: 0,
    safetyStock: 0, vendorId: VENDOR, vendorName: 'V', usagePerPortion: 0,
    lastUpdatedBy: 'seed', lastUpdatedAt: 'seed', eodRemaining: 7, storeId: STORE,
    casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: '', vendorIds: [VENDOR],
    ...over,
  };
}

function mkEntry(over: Partial<EODEntry>): EODEntry {
  return {
    id: 'e', itemId: 'item', itemName: 'Item', actualRemaining: 0, unit: 'lb',
    submittedBy: 'Pat', submittedByUserId: 'user-1', timestamp: '2026-10-23T22:00:00Z',
    date: '2026-10-23', storeId: STORE, notes: '',
    ...over,
  };
}

function submission(entries: EODEntry[]): Omit<EODSubmission, 'id'> {
  return {
    date: '2026-10-23', storeId: STORE, storeName: 'Alpha', vendorId: VENDOR,
    vendorName: 'V', submittedBy: 'Pat', submittedByUserId: 'user-1',
    timestamp: '2026-10-23T22:00:00Z', itemCount: entries.length,
    status: 'submitted', entries,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState({
    inventory: [
      mkItem({ id: 'num', name: 'Numeric' }),
      mkItem({ id: 'nn', name: 'NoNeed' }),
    ],
    eodSubmissions: [],
  });
});

describe('useStore.submitEOD — NO NEED (AC-23)', () => {
  it('skips the optimistic on-hand mirror and adjustItemStock for a NO NEED entry', () => {
    useStore.getState().submitEOD(
      submission([
        mkEntry({ itemId: 'num', itemName: 'Numeric', actualRemaining: 3 }),
        mkEntry({ itemId: 'nn', itemName: 'NoNeed', actualRemaining: null, noNeed: true }),
      ]),
    );

    const inv = useStore.getState().inventory;
    const nn = inv.find((i) => i.id === 'nn')!;
    expect(nn.currentStock).toBe(7);
    expect(nn.eodRemaining).toBe(7);
    expect(nn.lastUpdatedBy).toBe('seed');

    // The numeric entry keeps today's behavior.
    const num = inv.find((i) => i.id === 'num')!;
    expect(num.currentStock).toBe(3);
    expect(num.eodRemaining).toBe(3);

    expect(db.adjustItemStock).toHaveBeenCalledTimes(1);
    expect(db.adjustItemStock).toHaveBeenCalledWith('num', 3, 'user-1');
  });

  it("audits a NO NEED entry with value 'NO NEED' (and the numeric one unchanged)", () => {
    useStore.getState().submitEOD(
      submission([
        mkEntry({ itemId: 'num', itemName: 'Numeric', actualRemaining: 3, unit: 'lb' }),
        mkEntry({ itemId: 'nn', itemName: 'NoNeed', actualRemaining: null, noNeed: true }),
      ]),
    );
    const calls = (db.addAuditEvent as jest.Mock).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls.find((e) => e.itemRef === 'NoNeed')).toMatchObject({
      action: 'EOD entry',
      value: 'NO NEED',
    });
    expect(calls.find((e) => e.itemRef === 'Numeric')).toMatchObject({
      action: 'EOD entry',
      value: '3 lb',
    });
  });

  it('keeps the NO NEED entry in the optimistic submission (it is a counted entry)', () => {
    useStore.getState().submitEOD(
      submission([mkEntry({ itemId: 'nn', itemName: 'NoNeed', actualRemaining: null, noNeed: true })]),
    );
    const [sub] = useStore.getState().eodSubmissions;
    expect(sub.entries).toHaveLength(1);
    expect(sub.entries[0]).toMatchObject({ itemId: 'nn', noNeed: true, actualRemaining: null });
    expect(db.adjustItemStock).not.toHaveBeenCalled();
  });

  // Review-fix SF-3: on-hand mirror, adjustItemStock and the audit value all
  // key off the same isNumericEodEntry decision. A non-NO-NEED entry with a
  // null total (no client builds one today) writes no on-hand and never
  // audits "null <unit>".
  it('a non-NO-NEED entry with a null total: no on-hand write, no adjustItemStock, sane audit text', () => {
    useStore.getState().submitEOD(
      submission([
        mkEntry({ itemId: 'num', itemName: 'Numeric', actualRemaining: 3, unit: 'lb' }),
        mkEntry({ itemId: 'nn', itemName: 'NullTotal', actualRemaining: null, unit: 'lb' }),
      ]),
    );

    const nullItem = useStore.getState().inventory.find((i) => i.id === 'nn')!;
    expect(nullItem.currentStock).toBe(7);
    expect(nullItem.eodRemaining).toBe(7);
    expect(nullItem.lastUpdatedBy).toBe('seed');

    expect(db.adjustItemStock).toHaveBeenCalledTimes(1);
    expect(db.adjustItemStock).toHaveBeenCalledWith('num', 3, 'user-1');

    const calls = (db.addAuditEvent as jest.Mock).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    const nullAudit = calls.find((e) => e.itemRef === 'NullTotal');
    expect(nullAudit).toMatchObject({ action: 'EOD entry', value: '' });
    expect(nullAudit.value).not.toMatch(/null/);
    expect(nullAudit.value).not.toBe('NO NEED');
    expect(calls.find((e) => e.itemRef === 'Numeric')).toMatchObject({ value: '3 lb' });
  });
});
