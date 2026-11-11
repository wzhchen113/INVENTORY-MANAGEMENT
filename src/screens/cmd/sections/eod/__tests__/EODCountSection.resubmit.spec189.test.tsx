// src/screens/cmd/sections/eod/__tests__/EODCountSection.resubmit.spec189.test.tsx
//
// Spec 189 — admin EOD re-submit through the full EODCountSection (desktop).
// The write is a change set plus a removal list (design §4/§5), the failure
// path reverts the optimistic slice (§8), and EDIT seeds only non-blank local
// values over the saved entries (§5 seed fix):
//   - AC-25 (D-4): no-change UPDATE issues no write; a pill-scoped EDIT ships
//     only the changed row; a blanked row is the only removal; draft, reload,
//     count the rest keeps the drafted rows; an off-vendor saved row survives.
//   - AC-22: a rejected write shows savedLocally / cloudFailed, no success
//     toast, no jump to Ordering; typed values and EDIT mode stay; the
//     optimistic row is reverted; a retry sends the same diff. SUBMIT and
//     SAVE DRAFT.
//   - AC-20 / AC-23: after a re-submit the locked view shows the new values,
//     a dropped row is gone from the slice, EDIT seeds the same values, and
//     the day tile counts each item once.
//
// `submitEODCount` is mocked at the db.ts seam against the §13 contract
// `(submission, removedItemIds = []) => Promise<{ submissionId; entryCount }>`.
// Most arms use the REAL store `submitEOD` so the slice merge + undo run.

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

const mockSubmitEODCount = jest.fn();
jest.mock('../../../../../lib/db', () =>
  new Proxy(
    {
      __esModule: true,
      submitEODCount: (...args: unknown[]) => mockSubmitEODCount(...args),
    },
    {
      get: (target: Record<string, unknown>, prop: string) => {
        if (prop in target) return (target as any)[prop];
        return jest.fn(() => Promise.resolve(null));
      },
    },
  ),
);

jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => false, useBreakpoint: () => 'desktop' };
});

import EODCountSection from '../../EODCountSection';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';
import type { EODSubmission, InventoryItem } from '../../../../../types';

// ── fixtures ─────────────────────────────────────────────────────────
function localDayIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const TODAY = localDayIso(new Date());

function makeItem(id: string, over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id,
    name: `Item ${id}`,
    category: 'Produce',
    unit: 'ea',
    storeId: 'store-1',
    vendorId: 'v1',
    vendorIds: ['v1'],
    caseQty: 1,
    parLevel: 0,
    currentStock: 50,
    eodRemaining: 50,
    lastUpdatedBy: 'seed',
    lastUpdatedAt: 'seed-at',
    costPerUnit: 0,
    subUnitSize: 1,
    ...over,
  } as unknown as InventoryItem;
}

// v1 has p1, p2 (Produce) and d1 (Dairy). `off` is linked to v2 only — an
// escape-hatch row that can sit in v1's submission.
const INVENTORY = [
  makeItem('p1'),
  makeItem('p2'),
  makeItem('d1', { category: 'Dairy' }),
  makeItem('off', { category: 'Dry', vendorId: 'v2', vendorIds: ['v2'] }),
];

function sub(
  entries: Array<{ itemId: string; actualRemaining: number | null; noNeed?: boolean; notes?: string }>,
  status: 'draft' | 'submitted' = 'submitted',
): EODSubmission {
  return {
    id: 'sub-1',
    date: TODAY,
    storeId: 'store-1',
    storeName: 'Frederick',
    vendorId: 'v1',
    vendorName: 'BJ',
    submittedBy: 'Admin',
    submittedByUserId: 'user-1',
    timestamp: '2026-11-08T20:00:00.000Z',
    itemCount: entries.length,
    status,
    entries: entries.map((e) => ({
      id: `e-${e.itemId}`,
      itemName: `Item ${e.itemId}`,
      unit: 'ea',
      submittedBy: 'Admin',
      submittedByUserId: 'user-1',
      timestamp: '2026-11-08T20:00:00.000Z',
      date: TODAY,
      storeId: 'store-1',
      notes: e.notes ?? '',
      actualRemaining: e.actualRemaining,
      actualRemainingEach: e.actualRemaining ?? undefined,
      noNeed: e.noNeed,
      itemId: e.itemId,
    })),
  };
}

const SAVED = sub([
  { itemId: 'p1', actualRemaining: 6 },
  { itemId: 'p2', actualRemaining: 8 },
  { itemId: 'd1', actualRemaining: 4 },
  { itemId: 'off', actualRemaining: 3 },
]);

const realSubmitEOD = useStore.getState().submitEOD;

function seed(eodSubmissions: EODSubmission[] = [], submitEOD = realSubmitEOD) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: INVENTORY,
    vendors: [{ id: 'v1', name: 'BJ' } as any, { id: 'v2', name: 'Sams' } as any],
    eodSubmissions,
    orderSchedule: {},
    storeLoading: false,
    submitEOD,
  });
}

const toastTexts = () => (Toast.show as jest.Mock).mock.calls.map((c) => c[0].text1);
const unitInput = (api: ReturnType<typeof render>, id: string) => api.getByTestId(`eod-unit-input-${id}`);
const lastWrite = () => {
  const call = mockSubmitEODCount.mock.calls[mockSubmitEODCount.mock.calls.length - 1];
  return { submission: call[0] as Omit<EODSubmission, 'id'>, removed: call[1] as string[] };
};
const ids = (s: Omit<EODSubmission, 'id'>) => s.entries.map((e) => e.itemId);

async function press(api: ReturnType<typeof render>, text: string) {
  await act(async () => {
    fireEvent.press(api.getByText(text));
  });
}

async function enterEdit(api: ReturnType<typeof render>, probeId = 'p1') {
  fireEvent.press(api.getByLabelText("Edit this vendor's submitted count"));
  await waitFor(() => expect(unitInput(api, probeId).props.editable).toBe(true));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSubmitEODCount.mockResolvedValue({ submissionId: 'sub-1', entryCount: 0 });
  jest.spyOn(Toast, 'show').mockImplementation(() => {});
  usePaletteAction.setState({ pending: null });
});

// ── AC-25 (D-4) ─────────────────────────────────────────────────────
describe('EODCountSection — spec 189 change set (AC-25)', () => {
  it('EDIT then UPDATE COUNT with no changes, under a pill: no write, success toast with the saved row count', async () => {
    const spy = jest.fn<any, any[]>(() => jest.fn());
    seed([SAVED], spy);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByText('Dairy (1)'));
    await enterEdit(api, 'd1');
    await press(api, 'UPDATE COUNT');
    expect(mockSubmitEODCount).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'Count submitted', text2: `4 items · ${TODAY}` }),
    );
    expect(usePaletteAction.getState().pending).toEqual(expect.objectContaining({ section: 'Ordering' }));
    // Relocked.
    expect(api.getByLabelText("Edit this vendor's submitted count")).toBeTruthy();
  });

  it('EDIT under a pill, change one row: ships only that row; other categories and the off-vendor row stay', async () => {
    seed([SAVED]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByText('Dairy (1)'));
    await enterEdit(api, 'd1');
    fireEvent.changeText(unitInput(api, 'd1'), '9');
    await press(api, 'UPDATE COUNT');
    expect(mockSubmitEODCount).toHaveBeenCalledTimes(1);
    const { submission, removed } = lastWrite();
    expect(ids(submission)).toEqual(['d1']);
    expect(submission.entries[0]).toEqual(expect.objectContaining({ actualRemaining: 9 }));
    expect(submission.status).toBe('submitted');
    expect(removed).toEqual([]);
    const after = useStore.getState().eodSubmissions[0];
    expect(after.entries.map((e) => [e.itemId, e.actualRemaining])).toEqual([
      ['p1', 6], ['p2', 8], ['d1', 9], ['off', 3],
    ]);
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', text2: `4 items · ${TODAY}` }));
  });

  it('EDIT, blank a row: removes only that row (blank-only correction)', async () => {
    seed([SAVED]);
    const api = render(<EODCountSection />);
    await enterEdit(api);
    fireEvent.changeText(unitInput(api, 'p2'), '');
    await press(api, 'UPDATE COUNT');
    const { submission, removed } = lastWrite();
    expect(submission.entries).toEqual([]);
    expect(removed).toEqual(['p2']);
    expect(useStore.getState().eodSubmissions[0].entries.map((e) => e.itemId)).toEqual(['p1', 'd1', 'off']);
  });

  it('draft, reload, count the rest, submit: ships only what was typed; the drafted row is not removed', async () => {
    // After a reload the draft is in the slice but its rows don't refill.
    seed([sub([{ itemId: 'p1', actualRemaining: 6 }], 'draft')]);
    const api = render(<EODCountSection />);
    expect(unitInput(api, 'p1').props.value).toBe('');
    fireEvent.changeText(unitInput(api, 'p2'), '2');
    fireEvent.changeText(unitInput(api, 'd1'), '3');
    await press(api, 'SUBMIT COUNT');
    const { submission, removed } = lastWrite();
    expect(ids(submission)).toEqual(['d1', 'p2']);
    expect(submission.status).toBe('submitted');
    expect(removed).toEqual([]);
    const after = useStore.getState().eodSubmissions[0];
    expect(after.status).toBe('submitted');
    expect(after.entries.map((e) => e.itemId).sort()).toEqual(['d1', 'p1', 'p2']);
  });

  it('first SUBMIT under a pill also ships values typed under other pills (the D-4 visible change)', async () => {
    seed([]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByText('Produce (2)'));
    fireEvent.changeText(unitInput(api, 'p1'), '5');
    fireEvent.press(api.getByText('Dairy (1)'));
    fireEvent.changeText(unitInput(api, 'd1'), '7');
    await press(api, 'SUBMIT COUNT');
    expect(ids(lastWrite().submission)).toEqual(['d1', 'p1']);
  });

  it('same-session draft, blank a drafted row, save again: a removal of that row only', async () => {
    seed([]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(unitInput(api, 'p1'), '5');
    fireEvent.changeText(unitInput(api, 'p2'), '6');
    await press(api, 'SAVE DRAFT');
    expect(ids(lastWrite().submission)).toEqual(['p1', 'p2']);
    fireEvent.changeText(unitInput(api, 'p2'), '');
    await press(api, 'SAVE DRAFT');
    expect(lastWrite().submission.entries).toEqual([]);
    expect(lastWrite().removed).toEqual(['p2']);
    expect(useStore.getState().eodSubmissions[0].entries.map((e) => e.itemId)).toEqual(['p1']);
  });

  it('same-session draft then SUBMIT with no changes: ships the baseline rows to carry the status change', async () => {
    seed([]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(unitInput(api, 'p1'), '5');
    fireEvent.changeText(unitInput(api, 'p2'), '6');
    fireEvent.changeText(unitInput(api, 'd1'), '7');
    await press(api, 'SAVE DRAFT');
    await press(api, 'SUBMIT COUNT');
    expect(mockSubmitEODCount).toHaveBeenCalledTimes(2);
    const { submission, removed } = lastWrite();
    expect(submission.status).toBe('submitted');
    expect(ids(submission)).toEqual(['d1', 'p1', 'p2']);
    expect(removed).toEqual([]);
  });

  it('SAVE DRAFT on an unchanged same-session draft: no second write, draft toast with the saved count', async () => {
    seed([]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(unitInput(api, 'p1'), '5');
    await press(api, 'SAVE DRAFT');
    await press(api, 'SAVE DRAFT');
    expect(mockSubmitEODCount).toHaveBeenCalledTimes(1);
    const drafts = (Toast.show as jest.Mock).mock.calls.filter((c) => c[0].text1 === 'DRAFT SAVED');
    expect(drafts).toHaveLength(2);
    expect(drafts[1][0].text2).toMatch(/^1 of 3 items/);
  });

  it('seed fix: a leftover blank local value does not beat the saved value on EDIT', async () => {
    seed([]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(unitInput(api, 'p1'), '1');
    fireEvent.changeText(unitInput(api, 'p1'), ''); // leaves key '' in the map
    // A count lands for this vendor (e.g. a realtime reload).
    act(() => {
      useStore.setState({ eodSubmissions: [SAVED] });
    });
    await enterEdit(api);
    expect(unitInput(api, 'p1').props.value).toBe('6');
    await press(api, 'UPDATE COUNT');
    expect(mockSubmitEODCount).not.toHaveBeenCalled();
  });
});

// ── AC-22 failure path ──────────────────────────────────────────────
describe('EODCountSection — spec 189 failure path (AC-22)', () => {
  it('UPDATE COUNT rejected: error toast only, no jump, values + EDIT kept, slice reverted, retry sends the same diff', async () => {
    seed([SAVED]);
    const api = render(<EODCountSection />);
    await enterEdit(api);
    fireEvent.changeText(unitInput(api, 'd1'), '9');
    fireEvent.changeText(unitInput(api, 'p2'), '');
    mockSubmitEODCount.mockRejectedValueOnce(new Error('42501'));
    await press(api, 'UPDATE COUNT');

    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text1: 'Saved locally only', text2: 'Cloud save failed — check connection' }),
    );
    expect(toastTexts()).not.toContain('Count submitted');
    expect(usePaletteAction.getState().pending).toBeNull();
    expect(api.getByText('UPDATE COUNT')).toBeTruthy();
    expect(unitInput(api, 'd1').props.value).toBe('9');
    expect(unitInput(api, 'p2').props.value).toBe('');
    // The optimistic row and the on-hand mirror are reverted.
    expect(useStore.getState().eodSubmissions).toEqual([SAVED]);
    expect(useStore.getState().inventory.find((i) => i.id === 'd1')!.currentStock).toBe(50);

    const first = mockSubmitEODCount.mock.calls[0];
    await press(api, 'UPDATE COUNT');
    const retry = mockSubmitEODCount.mock.calls[1];
    expect(ids(retry[0])).toEqual(ids(first[0]));
    expect(retry[0].entries.map((e: any) => e.actualRemaining)).toEqual(first[0].entries.map((e: any) => e.actualRemaining));
    expect(retry[1]).toEqual(first[1]);
    expect(retry[1]).toEqual(['p2']);
  });

  it('first SUBMIT rejected: the vendor does not lock and no local submission is left behind', async () => {
    seed([]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(unitInput(api, 'p1'), '1');
    fireEvent.changeText(unitInput(api, 'p2'), '2');
    fireEvent.changeText(unitInput(api, 'd1'), '3');
    mockSubmitEODCount.mockRejectedValueOnce(new Error('network'));
    await press(api, 'SUBMIT COUNT');
    expect(useStore.getState().eodSubmissions).toEqual([]);
    expect(api.getByText('SUBMIT COUNT')).toBeTruthy();
    expect(api.queryByLabelText("Edit this vendor's submitted count")).toBeNull();
    expect(unitInput(api, 'p1').props.value).toBe('1');
    expect(usePaletteAction.getState().pending).toBeNull();
  });

  it('SAVE DRAFT rejected: error toast, no draft toast, typed values kept, slice reverted', async () => {
    seed([]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(unitInput(api, 'p1'), '4');
    mockSubmitEODCount.mockRejectedValueOnce(new Error('network'));
    await press(api, 'SAVE DRAFT');
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', text1: 'Saved locally only' }));
    expect(toastTexts()).not.toContain('DRAFT SAVED');
    expect(unitInput(api, 'p1').props.value).toBe('4');
    expect(useStore.getState().eodSubmissions).toEqual([]);
  });

  it('calls the undo returned by submitEOD exactly once on a rejected write, never on success', async () => {
    const undo = jest.fn();
    const spy = jest.fn<any, any[]>(() => undo);
    seed([], spy);
    const api = render(<EODCountSection />);
    fireEvent.changeText(unitInput(api, 'p1'), '4');
    await press(api, 'SAVE DRAFT');
    expect(undo).not.toHaveBeenCalled();
    fireEvent.changeText(unitInput(api, 'p1'), '5');
    mockSubmitEODCount.mockRejectedValueOnce(new Error('boom'));
    await press(api, 'SAVE DRAFT');
    expect(undo).toHaveBeenCalledTimes(1);
    // The write is called with the removal list as its second argument (§13).
    expect(mockSubmitEODCount.mock.calls[1][1]).toEqual([]);
    expect(spy.mock.calls[1]).toEqual([expect.objectContaining({ status: 'draft' }), { removedItemIds: [] }]);
  });
});

// ── AC-20 / AC-23 ───────────────────────────────────────────────────
describe('EODCountSection — spec 189 after a re-submit (AC-20 / AC-23)', () => {
  it('locked view shows the new values, the dropped row is gone, EDIT seeds the same values, the day tile counts once', async () => {
    seed([SAVED]);
    const api = render(<EODCountSection />);
    expect(api.getAllByText('4/4').length).toBeGreaterThan(0);
    await enterEdit(api);
    fireEvent.changeText(unitInput(api, 'd1'), '9');
    fireEvent.changeText(unitInput(api, 'p2'), '');
    await press(api, 'UPDATE COUNT');

    // Relocked, showing the new values; the cleared row is blank.
    expect(unitInput(api, 'd1').props.editable).toBe(false);
    expect(unitInput(api, 'd1').props.value).toBe('9');
    expect(unitInput(api, 'p2').props.value).toBe('');
    expect(unitInput(api, 'p1').props.value).toBe('6');
    // The slice holds exactly the new entries (no reload).
    expect(useStore.getState().eodSubmissions[0].entries.map((e) => e.itemId)).toEqual(['p1', 'd1', 'off']);
    // Day tile: each item once.
    expect(api.getAllByText('3/4').length).toBeGreaterThan(0);

    await enterEdit(api);
    expect(unitInput(api, 'd1').props.value).toBe('9');
    expect(unitInput(api, 'p2').props.value).toBe('');
    expect(unitInput(api, 'p1').props.value).toBe('6');
  });
});

// ── code-reviewer S1: a stale baseline on another date ──────────────
// The input maps are keyed by vendor only; the baseline is keyed by store,
// date and vendor. A SUBMIT on one date empties the vendor's maps, so it must
// also drop that vendor's baselines for every other date. Otherwise a draft
// saved on day A keeps a baseline the screen no longer holds values for, and
// day A's next SUBMIT reads every drafted row as "blanked" and removes it.
describe('EODCountSection — spec 189 stale baseline across dates (code-reviewer S1)', () => {
  const dayA = new Date();
  dayA.setHours(0, 0, 0, 0);
  dayA.setDate(dayA.getDate() - 1);
  const DAY_A = localDayIso(dayA);
  // The week sidebar row shows "<Mon> <d>" (e.g. "Nov 8") for each day.
  const sidebarDate = (d: Date) => `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
  const selectDay = (api: ReturnType<typeof render>, d: Date) => {
    fireEvent.press(api.getByText(sidebarDate(d)));
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  it('draft on day A, SUBMIT on day B, back to A, count one more and SUBMIT: no removal of the drafted rows', async () => {
    seed([]);
    const api = render(<EODCountSection />);

    // 1. Day A: SAVE DRAFT for v1 (p1, p2). Day A's baseline advances to them.
    selectDay(api, dayA);
    fireEvent.changeText(unitInput(api, 'p1'), '5');
    fireEvent.changeText(unitInput(api, 'p2'), '6');
    await press(api, 'SAVE DRAFT');
    expect(lastWrite().submission.date).toBe(DAY_A);
    expect(lastWrite().submission.status).toBe('draft');
    expect(ids(lastWrite().submission)).toEqual(['p1', 'p2']);

    // 2. Day B: the vendor-keyed maps still hold day A's values (spec 192's
    //    leak); count the rest and SUBMIT. This empties v1's maps.
    selectDay(api, today);
    fireEvent.changeText(unitInput(api, 'd1'), '7');
    await press(api, 'SUBMIT COUNT');
    expect(lastWrite().submission.date).toBe(TODAY);
    expect(lastWrite().submission.status).toBe('submitted');

    // 3. Back to day A: the draft is unlocked and its rows don't refill.
    selectDay(api, dayA);
    expect(unitInput(api, 'p1').props.editable).toBe(true);
    expect(unitInput(api, 'p1').props.value).toBe('');
    expect(unitInput(api, 'p2').props.value).toBe('');

    // 4. Count the one row left and SUBMIT (the drafted rows pass the gate).
    fireEvent.changeText(unitInput(api, 'd1'), '3');
    await press(api, 'SUBMIT COUNT');
    expect(mockSubmitEODCount).toHaveBeenCalledTimes(3);
    const { submission, removed } = lastWrite();
    expect(submission.date).toBe(DAY_A);
    expect(submission.status).toBe('submitted');
    expect(ids(submission)).toEqual(['d1']);
    // 5. The drafted rows are NOT in the removal list.
    expect(removed).toEqual([]);
    expect(toastTexts()).toContain('Count submitted');
    const dayASub = useStore.getState().eodSubmissions.find((s) => s.date === DAY_A && s.vendorId === 'v1')!;
    expect(dayASub.status).toBe('submitted');
    expect(dayASub.entries.map((e) => e.itemId).sort()).toEqual(['d1', 'p1', 'p2']);
  });
});
