// src/store/useStore.submitEOD.undo.spec189.test.ts — Spec 189 (design §8, §13).
//
// The store's optimistic `submitEOD` after spec 189:
//   • drops `opts.removedItemIds` from the merged row, so the slice holds
//     exactly the new entries without a reload (AC-23);
//   • no longer calls db.adjustItemStock (the server writes on-hand in the
//     same transaction as the entries);
//   • returns an UNDO that restores the (storeId, date, vendorId) row — or
//     removes it if the call created it — and the mirrored on-hand fields,
//     while leaving other rows and other items alone. The audit rows and the
//     bell are not undone (D-5).
//
// Mocking follows useStore.submitEOD.noNeed.spec172.test.ts.

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
import { supabase } from '../lib/supabase';
import { useStore } from './useStore';
import type { EODEntry, EODSubmission, InventoryItem } from '../types';

const STORE = 'store-a';
const VENDOR = 'vendor-1';
const DATE = '2026-11-08';

function mkItem(over: Partial<InventoryItem>): InventoryItem {
  return {
    id: 'item', catalogId: 'cat', name: 'Item', category: 'produce', unit: 'lb',
    costPerUnit: 1, currentStock: 7, parLevel: 10, averageDailyUsage: 0,
    safetyStock: 0, vendorId: VENDOR, vendorName: 'V', usagePerPortion: 0,
    lastUpdatedBy: 'seed', lastUpdatedAt: 'seed-at', eodRemaining: 7, storeId: STORE,
    casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: '', vendorIds: [VENDOR],
    ...over,
  };
}

function mkEntry(over: Partial<EODEntry>): EODEntry {
  return {
    id: 'e', itemId: 'item', itemName: 'Item', actualRemaining: 0, unit: 'lb',
    submittedBy: 'Pat', submittedByUserId: 'user-1', timestamp: '2026-11-08T22:00:00Z',
    date: DATE, storeId: STORE, notes: '',
    ...over,
  };
}

function submission(entries: EODEntry[], over: Partial<EODSubmission> = {}): Omit<EODSubmission, 'id'> {
  return {
    date: DATE, storeId: STORE, storeName: 'Alpha', vendorId: VENDOR,
    vendorName: 'V', submittedBy: 'Pat', submittedByUserId: 'user-1',
    timestamp: '2026-11-08T22:00:00Z', itemCount: entries.length,
    status: 'submitted', entries,
    ...over,
  };
}

const SAVED: EODSubmission = {
  id: 'sub-1',
  ...submission(
    [
      mkEntry({ itemId: 'a', itemName: 'A', actualRemaining: 6 }),
      mkEntry({ itemId: 'b', itemName: 'B', actualRemaining: 8 }),
      mkEntry({ itemId: 'c', itemName: 'C', actualRemaining: 2 }),
    ],
    { timestamp: '2026-11-08T20:00:00Z' },
  ),
};

const OTHER_VENDOR: EODSubmission = {
  ...SAVED,
  id: 'sub-other',
  vendorId: 'vendor-2',
  entries: [mkEntry({ itemId: 'z', actualRemaining: 1 })],
  itemCount: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState({
    inventory: [
      mkItem({ id: 'a', name: 'A', currentStock: 6, eodRemaining: 6 }),
      mkItem({ id: 'b', name: 'B', currentStock: 8, eodRemaining: 8 }),
      mkItem({ id: 'c', name: 'C', currentStock: 2, eodRemaining: 2 }),
      mkItem({ id: 'untouched', name: 'U', currentStock: 9, eodRemaining: 9 }),
    ],
    eodSubmissions: [SAVED, OTHER_VENDOR],
  });
});

describe('useStore.submitEOD — removal merge (AC-23)', () => {
  it('drops removed items and applies shipped ones, so the slice holds exactly the new entries', () => {
    useStore.getState().submitEOD(
      submission([mkEntry({ itemId: 'a', itemName: 'A', actualRemaining: 18 })]),
      { removedItemIds: ['c'] },
    );
    const sub = useStore.getState().eodSubmissions.find((s) => s.id === 'sub-1')!;
    expect(sub.entries.map((e) => [e.itemId, e.actualRemaining])).toEqual([
      ['a', 18],
      ['b', 8],
    ]);
    expect(sub.itemCount).toBe(2);
    // The other vendor's row is untouched.
    expect(useStore.getState().eodSubmissions.find((s) => s.id === 'sub-other')).toBe(OTHER_VENDOR);
  });

  it('a blank-only correction (no shipped entries) removes only the named row', () => {
    useStore.getState().submitEOD(submission([]), { removedItemIds: ['b'] });
    const sub = useStore.getState().eodSubmissions.find((s) => s.id === 'sub-1')!;
    expect(sub.entries.map((e) => e.itemId)).toEqual(['a', 'c']);
  });

  it('with no opts the merge is the pre-189 one (nothing removed)', () => {
    useStore.getState().submitEOD(submission([mkEntry({ itemId: 'b', itemName: 'B', actualRemaining: 20 })]));
    const sub = useStore.getState().eodSubmissions.find((s) => s.id === 'sub-1')!;
    expect(sub.entries.map((e) => [e.itemId, e.actualRemaining])).toEqual([
      ['a', 6],
      ['b', 20],
      ['c', 2],
    ]);
  });

  it('never calls db.adjustItemStock, but still mirrors on-hand locally (design §8)', () => {
    useStore.getState().submitEOD(submission([mkEntry({ itemId: 'a', itemName: 'A', actualRemaining: 18 })]));
    expect(db.adjustItemStock).not.toHaveBeenCalled();
    const a = useStore.getState().inventory.find((i) => i.id === 'a')!;
    expect(a).toMatchObject({ currentStock: 18, eodRemaining: 18, lastUpdatedBy: 'Pat' });
  });
});

describe('useStore.submitEOD — undo (design §8, AC-22)', () => {
  it('re-submit: undo restores the previous row and the mirrored on-hand fields', () => {
    const undo = useStore.getState().submitEOD(
      submission([mkEntry({ itemId: 'a', itemName: 'A', actualRemaining: 18 })], { status: 'draft' }),
      { removedItemIds: ['c'] },
    );
    expect(useStore.getState().inventory.find((i) => i.id === 'a')!.currentStock).toBe(18);

    undo();

    const subs = useStore.getState().eodSubmissions;
    expect(subs.find((s) => s.id === 'sub-1')).toBe(SAVED);
    expect(subs.find((s) => s.id === 'sub-other')).toBe(OTHER_VENDOR);
    expect(subs).toHaveLength(2);
    const a = useStore.getState().inventory.find((i) => i.id === 'a')!;
    expect(a).toMatchObject({ currentStock: 6, eodRemaining: 6, lastUpdatedBy: 'seed', lastUpdatedAt: 'seed-at' });
    // Items the call never mirrored are untouched.
    expect(useStore.getState().inventory.find((i) => i.id === 'untouched')!.currentStock).toBe(9);
  });

  it('first submit: undo removes the row it created (a failed first SUBMIT no longer locks the vendor)', () => {
    useStore.setState({ eodSubmissions: [OTHER_VENDOR] });
    const undo = useStore.getState().submitEOD(
      submission([mkEntry({ itemId: 'b', itemName: 'B', actualRemaining: 3 })]),
    );
    expect(useStore.getState().eodSubmissions).toHaveLength(2);
    undo();
    expect(useStore.getState().eodSubmissions).toEqual([OTHER_VENDOR]);
    expect(useStore.getState().inventory.find((i) => i.id === 'b')!.currentStock).toBe(8);
  });

  it('an off-vendor (escape-hatch) or NO NEED entry has no on-hand to restore', () => {
    useStore.setState({
      inventory: [
        mkItem({ id: 'off', vendorId: 'vendor-9', vendorIds: ['vendor-9'], currentStock: 4, eodRemaining: 4 }),
        mkItem({ id: 'nn', currentStock: 5, eodRemaining: 5 }),
      ],
    });
    const before = useStore.getState().inventory;
    const undo = useStore.getState().submitEOD(
      submission([
        mkEntry({ itemId: 'off', actualRemaining: 1 }),
        mkEntry({ itemId: 'nn', actualRemaining: null, noNeed: true }),
      ]),
    );
    expect(useStore.getState().inventory).toBe(before);
    undo();
    expect(useStore.getState().inventory).toBe(before);
  });

  it('AC-24: a first submit writes one "Remaining count submitted" EOD entry row per entry; a re-submit writes "Count updated"', () => {
    useStore.setState({ eodSubmissions: [OTHER_VENDOR] });
    useStore.getState().submitEOD(
      submission([
        mkEntry({ itemId: 'a', itemName: 'A', actualRemaining: 1 }),
        mkEntry({ itemId: 'b', itemName: 'B', actualRemaining: 2 }),
      ]),
    );
    const first = (db.addAuditEvent as jest.Mock).mock.calls.map((c) => c[0]);
    expect(first).toHaveLength(2);
    first.forEach((e) =>
      expect(e).toMatchObject({ action: 'EOD entry', detail: 'Remaining count submitted · vendor: V' }),
    );
    (db.addAuditEvent as jest.Mock).mockClear();
    useStore.getState().submitEOD(
      submission([mkEntry({ itemId: 'a', itemName: 'A', actualRemaining: 5 })]),
    );
    const again = (db.addAuditEvent as jest.Mock).mock.calls.map((c) => c[0]);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ action: 'EOD entry', detail: 'Count updated · vendor: V' });
  });

  it('does not undo the audit rows or the bell (D-5)', () => {
    const undo = useStore.getState().submitEOD(
      submission([mkEntry({ itemId: 'a', itemName: 'A', actualRemaining: 18 })]),
    );
    undo();
    expect(db.addAuditEvent).toHaveBeenCalledTimes(1);
    expect((db.addAuditEvent as jest.Mock).mock.calls[0][0]).toMatchObject({
      action: 'EOD entry',
      detail: 'Count updated · vendor: V',
    });
    expect(supabase.rpc).toHaveBeenCalledWith('broadcast_notification', expect.any(Object));
  });
});
