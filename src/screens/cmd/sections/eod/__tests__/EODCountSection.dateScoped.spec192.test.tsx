// src/screens/cmd/sections/eod/__tests__/EODCountSection.dateScoped.spec192.test.tsx
//
// Spec 192 — admin EOD drafts and EDIT stay on their own (store, date). Renders
// the FULL EODCountSection (desktop, and phone with `mockIsPhone = true`)
// against a seeded store, because the leak lived in the parent's state:
//   - AC-1..AC-7   typed values, notes, NO NEED, gate, tab switch, success
//                  clear and export are per (store, date, vendor) slot.
//   - AC-8, AC-9   a write in flight while the user picks another date acts on
//                  the slot it was started from (and D-192-1, §7.3).
//   - AC-10..AC-14 EDIT is per slot.
//   - AC-15, AC-16 the header follows the selected date, in the app locale.
//   - AC-17        store switch.
//   - AC-18        phone repeats of AC-1, AC-3, AC-10, AC-11.
//   - AC-19, AC-20, AC-24  spec 189 interplay (baseline, pill-agnostic payload,
//                  the 189 residual: a blank typed on another day).
//   - AC-21        + COUNT rows are per (store, date).
//
// Harness from the spec 172 / 189 suites: inert db.ts Proxy with a
// controllable `submitEODCount`, stubbed supabase, the `mockIsPhone` toggle, a
// `submitEOD` spy returning an undo, and the `downloadCSV` stub. "Submits
// with X" means both the spy and the `submitEODCount` mock receive X.

import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
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

let mockIsPhone = false;
jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => mockIsPhone,
    useBreakpoint: () => (mockIsPhone ? 'phone' : 'desktop'),
  };
});

const mockDownloadCSV = jest.fn();
jest.mock('../../../../../utils', () => ({
  ...jest.requireActual('../../../../../utils'),
  downloadCSV: (...args: unknown[]) => mockDownloadCSV(...args),
}));

import EODCountSection from '../../EODCountSection';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';
import type { EODSubmission, InventoryItem } from '../../../../../types';

// ── dates: D0 = today, D-1 … D-3 (the week list is the last 7 days) ────────
function localDayIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function dayAt(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}
const DAYS = [0, 1, 2, 3].map(dayAt);
const ISO = DAYS.map(localDayIso);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Desktop week-sidebar cell text ("Nov 8") and phone day-strip a11y label.
const sidebarLabel = (d: Date) => `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
const stripLabel = (d: Date) => `${DAY_NAMES[d.getDay()]} ${sidebarLabel(d)}`;

// ── fixtures ─────────────────────────────────────────────────────────
const S1 = { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' };
const S2 = { id: 'store-2', brandId: 'brand-1', name: 'Towson', address: '', status: 'active' };

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
    currentStock: 0,
    eodRemaining: 0,
    costPerUnit: 1,
    subUnitSize: 1,
    ...over,
  } as unknown as InventoryItem;
}

// BJ (v1): a (case of 6 → both boxes), b, c, s (shared with Costco) under
// Produce, d under Dairy. Costco (v2): x, s. y is linked to no vendor (a
// + COUNT-only row).
const V1_IDS = ['a', 'b', 'c', 'd', 's'];
const INVENTORY: InventoryItem[] = [
  makeItem('a', { caseQty: 6 }),
  makeItem('b'),
  makeItem('c'),
  makeItem('d', { category: 'Dairy' }),
  makeItem('s', { vendorIds: ['v1', 'v2'] }),
  makeItem('x', { vendorId: 'v2', vendorIds: ['v2'] }),
  makeItem('y', { category: 'Dry', vendorId: null as any, vendorIds: [] }),
  // Store 2's own item (item ids are per store), linked to the brand vendor BJ.
  makeItem('a2', { storeId: 'store-2' }),
];

function sub(
  dateIso: string,
  units: Record<string, number>,
  over: Partial<EODSubmission> = {},
): EODSubmission {
  const storeId = over.storeId ?? 'store-1';
  return {
    id: `sub-${storeId}-${dateIso}`,
    date: dateIso,
    storeId,
    storeName: 'Frederick',
    vendorId: 'v1',
    vendorName: 'BJ',
    submittedBy: 'Admin',
    submittedByUserId: 'user-1',
    timestamp: `${dateIso}T20:00:00.000Z`,
    itemCount: Object.keys(units).length,
    status: 'submitted',
    entries: Object.entries(units).map(([itemId, n]) => ({
      id: `e-${dateIso}-${itemId}`,
      itemId,
      itemName: `Item ${itemId}`,
      unit: 'ea',
      submittedBy: 'Admin',
      submittedByUserId: 'user-1',
      timestamp: `${dateIso}T20:00:00.000Z`,
      date: dateIso,
      storeId,
      notes: '',
      actualRemaining: n,
      actualRemainingEach: n,
    })),
    ...over,
  };
}
const allV1 = (n: number) => Object.fromEntries(V1_IDS.map((id) => [id, n]));

// Spec 189 §8 — submitEOD returns an undo.
const undoSpy = jest.fn();
const submitEODSpy = jest.fn<any, any[]>(() => undoSpy);

function seed(eodSubmissions: EODSubmission[] = []) {
  useStore.setState({
    currentStore: S1 as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: INVENTORY,
    vendors: [{ id: 'v1', name: 'BJ' } as any, { id: 'v2', name: 'Costco' } as any],
    eodSubmissions,
    // Empty schedule → every vendor on every day, no rest days (a configured
    // schedule missing a weekday would make that day `rest` and lock it).
    orderSchedule: {},
    storeLoading: false,
    submitEOD: submitEODSpy as any,
    locale: 'en',
  } as any);
}

// ── helpers ──────────────────────────────────────────────────────────
type Api = ReturnType<typeof render>;
const unitIn = (api: Api, id: string) => api.getByTestId(`eod-unit-input-${id}`);
const caseIn = (api: Api, id: string) => api.getByTestId(`eod-case-input-${id}`);
const type = (api: Api, id: string, v: string) => fireEvent.changeText(unitIn(api, id), v);
// Rows render grouped by category, alphabetized: Dairy (d), then Produce in
// inventory order (a, b, c, s). The note inputs follow that order.
const NOTE_ORDER = ['d', 'a', 'b', 'c', 's'];
const noteIn = (api: Api, id: string) => api.getAllByPlaceholderText('Note…')[NOTE_ORDER.indexOf(id)];

function selectDay(api: Api, n: number) {
  fireEvent.press(mockIsPhone ? api.getByLabelText(stripLabel(DAYS[n])) : api.getByText(sidebarLabel(DAYS[n])));
}
function fillV1(api: Api, n: string) {
  for (const id of V1_IDS) type(api, id, n);
}
async function press(api: Api, text: string) {
  await act(async () => {
    fireEvent.press(api.getByText(text));
  });
}
async function enterEdit(api: Api, probe = 'a') {
  fireEvent.press(api.getByLabelText("Edit this vendor's submitted count"));
  if (!mockIsPhone) await waitFor(() => expect(unitIn(api, probe).props.editable).toBe(true));
}
const writes = () => mockSubmitEODCount.mock.calls.map((c) => ({ submission: c[0] as Omit<EODSubmission, 'id'>, removed: c[1] as string[] }));
const lastWrite = () => writes()[writes().length - 1];
const ids = (s: Omit<EODSubmission, 'id'>) => s.entries.map((e) => e.itemId).sort();
const toastTexts = () => (Toast.show as jest.Mock).mock.calls.map((c) => c[0].text1);
function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const csvCell = (csv: string, itemName: string, column: string) => {
  const lines = csv.split(/\r?\n/);
  const header = lines[0].split(',');
  const row = lines.find((l) => l.split(',').includes(itemName))!.split(',');
  return row[header.indexOf(column)];
};
// The spec 192 R4 header formatter, computed independently (AC-15).
const headerFor = (iso: string, locale: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(locale, { weekday: 'long', month: 'short', day: 'numeric' });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsPhone = false;
  mockSubmitEODCount.mockResolvedValue({ submissionId: 'sub-x', entryCount: 0 });
  jest.spyOn(Toast, 'show').mockImplementation(() => {});
  usePaletteAction.setState({ pending: null });
});

// ── Q1: typed values ─────────────────────────────────────────────────
describe('EODCountSection — spec 192 typed values per date (desktop)', () => {
  it('AC-1: values typed on D0 are blank on D-1 (rows, counter, footer) and come back on D0', () => {
    seed();
    const api = render(<EODCountSection />);
    fireEvent.changeText(caseIn(api, 'a'), '1'); // 1 case of 6
    type(api, 'b', '2');
    expect(api.getByText('2 of 5 items counted')).toBeTruthy();
    expect(api.getByText('$8.00')).toBeTruthy();

    selectDay(api, 1);
    expect(caseIn(api, 'a').props.value).toBe('');
    expect(unitIn(api, 'b').props.value).toBe('');
    expect(api.getByText('0 of 5 items counted')).toBeTruthy();
    expect(api.getByText('$0.00')).toBeTruthy();

    selectDay(api, 0);
    expect(caseIn(api, 'a').props.value).toBe('1');
    expect(unitIn(api, 'b').props.value).toBe('2');
    expect(api.getByText('2 of 5 items counted')).toBeTruthy();
    expect(api.getByText('$8.00')).toBeTruthy();
  });

  it('AC-2: a note and a NO NEED mark on D0 are not shown on D-1, and come back on D0', () => {
    seed();
    const api = render(<EODCountSection />);
    fireEvent.changeText(noteIn(api, 'a'), 'top shelf');
    fireEvent.press(api.getByTestId('eod-noneed-c'));
    expect(api.getByTestId('eod-noneed-c').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));

    selectDay(api, 1);
    expect(noteIn(api, 'a').props.value).toBe('');
    expect(api.getByTestId('eod-noneed-c').props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
    expect(api.getByText('0 of 5 items counted')).toBeTruthy();

    selectDay(api, 0);
    expect(noteIn(api, 'a').props.value).toBe('top shelf');
    expect(api.getByTestId('eod-noneed-c').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
  });

  it('AC-3 (run 1 negative): a D-1 SUBMIT ships only D-1 values, dated D-1; D0 keeps its values', async () => {
    seed();
    const api = render(<EODCountSection />);
    fireEvent.changeText(caseIn(api, 'a'), '1');
    type(api, 'b', '2');

    selectDay(api, 1);
    fillV1(api, '3');
    await press(api, 'SUBMIT COUNT');

    expect(mockSubmitEODCount).toHaveBeenCalledTimes(1);
    expect(submitEODSpy).toHaveBeenCalledTimes(1);
    const { submission } = lastWrite();
    expect(submitEODSpy.mock.calls[0][0]).toBe(submission);
    expect(submission.date).toBe(ISO[1]);
    expect(ids(submission)).toEqual([...V1_IDS].sort());
    for (const e of submission.entries) {
      expect(e.date).toBe(ISO[1]);
      expect(e.actualRemaining).toBe(3);
      expect(e.actualRemainingCases).toBeUndefined();
    }
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', text2: `5 items · ${ISO[1]}` }));

    selectDay(api, 0);
    expect(caseIn(api, 'a').props.value).toBe('1');
    expect(unitIn(api, 'b').props.value).toBe('2');
  });

  it('AC-4: an item typed only on D0 is not counted on D-1 — the gate blocks and names it', async () => {
    seed();
    const api = render(<EODCountSection />);
    type(api, 'a', '1'); // a is typed on D0 only
    expect(api.getByText('1 of 5 items counted')).toBeTruthy();

    selectDay(api, 1);
    for (const id of ['b', 'c', 'd', 's']) type(api, id, '2'); // a is never touched on D-1
    expect(unitIn(api, 'a').props.value).toBe('');
    expect(api.getByText('4 of 5 items counted')).toBeTruthy();
    await press(api, 'SUBMIT COUNT');
    expect(mockSubmitEODCount).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text1: 'Count every item first', text2: '1 still need a count' }),
    );
  });

  it('AC-5: within one date, a vendor-tab switch keeps drafts, and a shared item counts once across tabs', () => {
    seed();
    const api = render(<EODCountSection />);
    type(api, 'a', '4');
    type(api, 's', '9');
    fireEvent.press(api.getByText('COSTCO (2)'));
    // Counted-once-globally (spec 102): s counts under Costco too.
    expect(api.getByText('1 of 2 items counted')).toBeTruthy();
    expect(unitIn(api, 's').props.value).toBe('');
    fireEvent.press(api.getByText('BJ (5)'));
    expect(unitIn(api, 'a').props.value).toBe('4');
    expect(unitIn(api, 's').props.value).toBe('9');
  });

  it('AC-6: a successful SUBMIT on (D-1, BJ) clears only that slot', async () => {
    seed();
    const api = render(<EODCountSection />);
    type(api, 'a', '1'); // D0, BJ
    selectDay(api, 1);
    fireEvent.press(api.getByText('COSTCO (2)'));
    type(api, 'x', '7'); // D-1, Costco
    fireEvent.press(api.getByText('BJ (5)'));
    fillV1(api, '3');
    await press(api, 'SUBMIT COUNT');
    expect(lastWrite().submission.date).toBe(ISO[1]);

    // D-1 BJ cleared (the spy doesn't add a slice row, so it stays unlocked).
    expect(unitIn(api, 'b').props.value).toBe('');
    fireEvent.press(api.getByText('COSTCO (2)'));
    expect(unitIn(api, 'x').props.value).toBe('7');
    fireEvent.press(api.getByText('BJ (5)'));
    selectDay(api, 0);
    expect(unitIn(api, 'a').props.value).toBe('1');
  });

  it('AC-7: the CSV export holds only the selected date\'s values', () => {
    seed();
    const api = render(<EODCountSection />);
    fireEvent.changeText(caseIn(api, 'a'), '1'); // D0
    selectDay(api, 1);
    type(api, 'b', '4'); // D-1

    fireEvent.press(api.getByTestId('eod-export-csv'));
    const d1 = mockDownloadCSV.mock.calls[0][1] as string;
    expect(csvCell(d1, 'Item a', 'Counted Cases')).toBe('');
    expect(csvCell(d1, 'Item b', 'Counted Units')).toBe('4');

    selectDay(api, 0);
    fireEvent.press(api.getByTestId('eod-export-csv'));
    const d0 = mockDownloadCSV.mock.calls[1][1] as string;
    expect(csvCell(d0, 'Item a', 'Counted Cases')).toBe('1');
    expect(csvCell(d0, 'Item b', 'Counted Units')).toBe('');
  });
});

// ── R2: a write in flight across a date change ───────────────────────
describe('EODCountSection — spec 192 in-flight submit (AC-8, AC-9, D-192-1)', () => {
  // BJ submitted on D0 and D-1. EDIT on D0 (a → 7); EDIT on D-1 (b → 9) and
  // UPDATE COUNT, held pending; select D0; then settle the write.
  async function startPendingUpdateOnD1(api: Api) {
    await enterEdit(api);
    type(api, 'a', '7'); // D0 EDIT
    selectDay(api, 1);
    await enterEdit(api);
    type(api, 'b', '9'); // D-1 EDIT
    const d = deferred();
    mockSubmitEODCount.mockImplementationOnce(() => d.promise);
    act(() => {
      fireEvent.press(api.getByText('UPDATE COUNT'));
    });
    selectDay(api, 0);
    return d;
  }

  it('AC-8: resolves after D0 is selected — dated D-1, only D-1 cleared and relocked, D0 untouched, toast names D-1, no jump', async () => {
    seed([sub(ISO[0], allV1(1)), sub(ISO[1], allV1(2))]);
    const api = render(<EODCountSection />);
    const d = await startPendingUpdateOnD1(api);
    await act(async () => {
      d.resolve({ submissionId: 'sub-x', entryCount: 5 });
    });

    expect(mockSubmitEODCount).toHaveBeenCalledTimes(1);
    expect(lastWrite().submission.date).toBe(ISO[1]);
    expect(ids(lastWrite().submission)).toEqual(['b']);
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', text2: `5 items · ${ISO[1]}` }));
    // D-192-1: the user moved to D0 while the write was in flight → no jump.
    expect(usePaletteAction.getState().pending).toBeNull();
    // D0: still in EDIT with its edit.
    expect(api.getByText('UPDATE COUNT')).toBeTruthy();
    expect(api.getByText('EDITING')).toBeTruthy();
    expect(unitIn(api, 'a').props.value).toBe('7');
    // D-1: relocked; re-entering EDIT seeds from the submission, so its slot
    // was cleared (a surviving local '9' would beat the seed).
    selectDay(api, 1);
    expect(api.queryByText('UPDATE COUNT')).toBeNull();
    await enterEdit(api);
    expect(unitIn(api, 'b').props.value).toBe('2');
  });

  it('AC-9: the write rejects after D0 is selected — error toast, D-1 keeps values and EDIT, D0 untouched', async () => {
    seed([sub(ISO[0], allV1(1)), sub(ISO[1], allV1(2))]);
    const api = render(<EODCountSection />);
    const d = await startPendingUpdateOnD1(api);
    await act(async () => {
      d.reject(new Error('network'));
    });

    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text1: 'Saved locally only', text2: 'Cloud save failed — check connection' }),
    );
    expect(toastTexts()).not.toContain('Count submitted');
    expect(usePaletteAction.getState().pending).toBeNull();
    expect(unitIn(api, 'a').props.value).toBe('7');
    expect(api.getByText('UPDATE COUNT')).toBeTruthy();
    selectDay(api, 1);
    expect(api.getByText('UPDATE COUNT')).toBeTruthy();
    expect(unitIn(api, 'b').props.value).toBe('9');
  });

  it('AC-9 (SAVE DRAFT): rejected after a date change keeps the D-2 slot; resolved, the baseline advances at D-2 only', async () => {
    seed();
    const api = render(<EODCountSection />);
    type(api, 'a', '1'); // D0
    selectDay(api, 2);
    type(api, 'b', '4');
    // Two rows: blanking the ONLY baseline row would be spec 189's `empty`
    // plan (no write), so c keeps the later removal call non-empty.
    type(api, 'c', '5');

    // Rejected.
    const d1 = deferred();
    mockSubmitEODCount.mockImplementationOnce(() => d1.promise);
    act(() => {
      fireEvent.press(api.getByText('SAVE DRAFT'));
    });
    selectDay(api, 0);
    await act(async () => {
      d1.reject(new Error('network'));
    });
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', text1: 'Saved locally only' }));
    // The draft carried only D-2's rows, dated D-2 (never D0's a).
    expect(writes()[0].submission.date).toBe(ISO[2]);
    expect(ids(writes()[0].submission)).toEqual(['b', 'c']);
    expect(unitIn(api, 'a').props.value).toBe('1');
    selectDay(api, 2);
    expect(unitIn(api, 'b').props.value).toBe('4');

    // Resolved after a date change.
    const d2 = deferred();
    mockSubmitEODCount.mockImplementationOnce(() => d2.promise);
    act(() => {
      fireEvent.press(api.getByText('SAVE DRAFT'));
    });
    selectDay(api, 0);
    await act(async () => {
      d2.resolve({ submissionId: 'sub-x', entryCount: 1 });
    });
    expect(writes()[1].submission.date).toBe(ISO[2]);
    expect(unitIn(api, 'a').props.value).toBe('1');
    // The baseline advanced at D-2: blanking b there and saving again removes it.
    selectDay(api, 2);
    expect(unitIn(api, 'b').props.value).toBe('4');
    type(api, 'b', '');
    await press(api, 'SAVE DRAFT');
    expect(lastWrite().submission.date).toBe(ISO[2]);
    expect(lastWrite().removed).toEqual(['b']);
    // …and D0 has no baseline, so its a = 1 is still just a typed value.
    selectDay(api, 0);
    expect(unitIn(api, 'a').props.value).toBe('1');
  });

  it('D-192-1: with no date change, a successful SUBMIT still jumps to Ordering', async () => {
    seed();
    const api = render(<EODCountSection />);
    selectDay(api, 1);
    fillV1(api, '1');
    await press(api, 'SUBMIT COUNT');
    expect(usePaletteAction.getState().pending).toEqual(expect.objectContaining({ section: 'Ordering' }));
  });

  it('D-192-1: a vendor-tab switch on the same date during the write still jumps (by day, not slot)', async () => {
    seed();
    const api = render(<EODCountSection />);
    fillV1(api, '1');
    const d = deferred();
    mockSubmitEODCount.mockImplementationOnce(() => d.promise);
    act(() => {
      fireEvent.press(api.getByText('SUBMIT COUNT'));
    });
    fireEvent.press(api.getByText('COSTCO (2)'));
    await act(async () => {
      d.resolve({ submissionId: 'sub-x', entryCount: 5 });
    });
    expect(usePaletteAction.getState().pending).toEqual(expect.objectContaining({ section: 'Ordering' }));
  });
});

// ── Q2: EDIT per slot ────────────────────────────────────────────────
describe('EODCountSection — spec 192 EDIT per (store, date, vendor) (desktop)', () => {
  it('AC-10 (run 2 negative): EDIT on D-1 does not follow to D-2; D-2 submits only its own values', async () => {
    seed([sub(ISO[1], allV1(1))]);
    const api = render(<EODCountSection />);
    selectDay(api, 1);
    await enterEdit(api);
    type(api, 'a', '3');

    selectDay(api, 2);
    expect(api.queryByText('EDITING')).toBeNull();
    expect(api.queryByText('UPDATE COUNT')).toBeNull();
    expect(api.getByText('SUBMIT COUNT')).toBeTruthy();
    expect(unitIn(api, 'a').props.value).toBe('');
    fillV1(api, '2');
    await press(api, 'SUBMIT COUNT');
    expect(mockSubmitEODCount).toHaveBeenCalledTimes(1);
    const { submission, removed } = lastWrite();
    expect(submission.date).toBe(ISO[2]);
    expect(submission.entries.every((e) => e.actualRemaining === 2)).toBe(true);
    expect(removed).toEqual([]);
    expect(writes().some((w) => w.submission.date === ISO[1])).toBe(false);
  });

  it('AC-11: returning to the EDIT date resumes EDIT with the edited values', async () => {
    seed([sub(ISO[1], allV1(1))]);
    const api = render(<EODCountSection />);
    selectDay(api, 1);
    await enterEdit(api);
    type(api, 'a', '3');
    selectDay(api, 2);
    selectDay(api, 1);
    expect(api.getByText('EDITING')).toBeTruthy();
    expect(api.getByText('UPDATE COUNT')).toBeTruthy();
    expect(unitIn(api, 'a').props.value).toBe('3');
  });

  it('AC-12: EDIT on D-1 leaves D-3 SUBMITTED · LOCKED, read-only with its own submitted values', async () => {
    seed([sub(ISO[1], allV1(1)), sub(ISO[3], allV1(4))]);
    const api = render(<EODCountSection />);
    selectDay(api, 1);
    await enterEdit(api);
    type(api, 'a', '3');
    selectDay(api, 3);
    expect(api.getByLabelText("Edit this vendor's submitted count")).toBeTruthy();
    expect(api.queryByText('UPDATE COUNT')).toBeNull();
    expect(api.queryByText('EDITING')).toBeNull();
    expect(unitIn(api, 'a').props.editable).toBe(false);
    expect(unitIn(api, 'a').props.value).toBe('4');
  });

  it('AC-13: EDIT seeds only its own slot — a value typed on D0 does not beat D-1\'s submission', async () => {
    seed([sub(ISO[1], allV1(1))]);
    const api = render(<EODCountSection />);
    type(api, 'a', '5'); // D0
    selectDay(api, 1);
    await enterEdit(api);
    expect(unitIn(api, 'a').props.value).toBe('1');
  });

  it('AC-14: a successful UPDATE COUNT on D-1 ends EDIT there only; EDIT on D-3 remains', async () => {
    seed([sub(ISO[1], allV1(1)), sub(ISO[3], allV1(4))]);
    const api = render(<EODCountSection />);
    selectDay(api, 3);
    await enterEdit(api);
    type(api, 'c', '8');
    selectDay(api, 1);
    await enterEdit(api);
    type(api, 'a', '3');
    await press(api, 'UPDATE COUNT');
    expect(lastWrite().submission.date).toBe(ISO[1]);
    expect(api.getByLabelText("Edit this vendor's submitted count")).toBeTruthy();
    selectDay(api, 3);
    expect(api.getByText('UPDATE COUNT')).toBeTruthy();
    expect(unitIn(api, 'c').props.value).toBe('8');
  });
});

// ── Q3: header ───────────────────────────────────────────────────────
describe('EODCountSection — spec 192 header shows the selected date (AC-15, AC-16)', () => {
  afterEach(() => {
    useStore.setState({ locale: 'en' } as any);
  });

  it('AC-15: desktop header is the selected date in the app locale', () => {
    seed();
    const api = render(<EODCountSection />);
    expect(api.getByText(headerFor(ISO[0], 'en'))).toBeTruthy();
    selectDay(api, 1);
    expect(api.getByText(headerFor(ISO[1], 'en'))).toBeTruthy();
    expect(api.queryByText(headerFor(ISO[0], 'en'))).toBeNull();
    act(() => {
      useStore.setState({ locale: 'es' } as any);
    });
    expect(api.getByText(headerFor(ISO[1], 'es'))).toBeTruthy();
  });

  it('AC-16: phone header is unchanged — week number and month / year of the selected date', () => {
    mockIsPhone = true;
    seed();
    const api = render(<EODCountSection />);
    const monthYear = (iso: string) =>
      new Date(iso + 'T00:00:00').toLocaleString('en', { month: 'short', year: 'numeric' }).toUpperCase();
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    selectDay(api, 3);
    expect(api.getByText(new RegExp(`^WK \\d+ · ${esc(monthYear(ISO[3]))}$`))).toBeTruthy();
    expect(api.queryByText(headerFor(ISO[3], 'en'))).toBeNull();
  });
});

// ── Q4: store switch ─────────────────────────────────────────────────
describe('EODCountSection — spec 192 store switch (AC-17)', () => {
  it('EDIT and typed values on S1 stay on S1; S2 opens by its own status; both come back on S1', async () => {
    seed([sub(ISO[1], allV1(1))]);
    const api = render(<EODCountSection />);
    type(api, 'b', '2'); // S1, D0
    selectDay(api, 1);
    await enterEdit(api);
    type(api, 'a', '3'); // S1, D-1 EDIT

    act(() => {
      useStore.setState({ currentStore: S2 as any });
    });
    expect(api.queryByText('EDITING')).toBeNull();
    expect(api.queryByText('UPDATE COUNT')).toBeNull();
    expect(api.getByText('SUBMIT COUNT')).toBeTruthy();
    expect(unitIn(api, 'a2').props.editable).toBe(true);
    expect(unitIn(api, 'a2').props.value).toBe('');

    act(() => {
      useStore.setState({ currentStore: S1 as any });
    });
    expect(api.getByText('EDITING')).toBeTruthy();
    expect(api.getByText('UPDATE COUNT')).toBeTruthy();
    expect(unitIn(api, 'a').props.value).toBe('3');
    selectDay(api, 0);
    expect(unitIn(api, 'b').props.value).toBe('2');
  });

  it('S2 with its own submission on D-1 opens locked, never in EDIT', async () => {
    seed([sub(ISO[1], allV1(1)), sub(ISO[1], { a2: 6 }, { storeId: 'store-2' })]);
    const api = render(<EODCountSection />);
    selectDay(api, 1);
    await enterEdit(api);
    act(() => {
      useStore.setState({ currentStore: S2 as any });
    });
    expect(api.getByLabelText("Edit this vendor's submitted count")).toBeTruthy();
    expect(api.queryByText('EDITING')).toBeNull();
    expect(unitIn(api, 'a2').props.editable).toBe(false);
    expect(unitIn(api, 'a2').props.value).toBe('6');
  });
});

// ── Phone ────────────────────────────────────────────────────────────
describe('EODCountSection phone — spec 192 (AC-18)', () => {
  beforeEach(() => {
    mockIsPhone = true;
  });

  const well = (api: Api, id: string) => api.getByTestId(`eod-well-${id}-units`);
  const wellShows = (api: Api, id: string, text: string) => within(well(api, id)).getByText(text);
  function keypad(api: Api, id: string, digits: string) {
    fireEvent.press(well(api, id));
    for (const ch of digits) fireEvent.press(api.getByTestId(`eod-key-${ch}`));
    fireEvent.press(api.getByLabelText('Close'));
  }
  const fillV1Phone = (api: Api, digit: string) => {
    for (const id of V1_IDS) keypad(api, id, digit);
  };
  async function submitPhone(api: Api) {
    await act(async () => {
      fireEvent.press(api.getByTestId('eod-submit'));
    });
  }

  it('AC-1: values keyed on D0 are blank on D-1 and come back on D0', () => {
    seed();
    const api = render(<EODCountSection />);
    keypad(api, 'a', '1');
    keypad(api, 'b', '2');
    expect(wellShows(api, 'a', '1')).toBeTruthy();
    selectDay(api, 1);
    expect(wellShows(api, 'a', '—')).toBeTruthy();
    expect(wellShows(api, 'b', '—')).toBeTruthy();
    selectDay(api, 0);
    expect(wellShows(api, 'a', '1')).toBeTruthy();
    expect(wellShows(api, 'b', '2')).toBeTruthy();
  });

  it('AC-3: a D-1 SUBMIT ships only D-1 values, dated D-1; D0 keeps its values', async () => {
    seed();
    const api = render(<EODCountSection />);
    keypad(api, 'a', '1');
    keypad(api, 'b', '2');
    selectDay(api, 1);
    fillV1Phone(api, '3');
    await submitPhone(api);
    expect(mockSubmitEODCount).toHaveBeenCalledTimes(1);
    const { submission } = lastWrite();
    expect(submission.date).toBe(ISO[1]);
    expect(submission.entries.every((e) => e.actualRemaining === 3 && e.date === ISO[1])).toBe(true);
    selectDay(api, 0);
    expect(wellShows(api, 'a', '1')).toBeTruthy();
    expect(wellShows(api, 'b', '2')).toBeTruthy();
  });

  it('AC-10: EDIT on D-1 does not follow to D-2; D-2 submits only its own values', async () => {
    seed([sub(ISO[1], allV1(1))]);
    const api = render(<EODCountSection />);
    selectDay(api, 1);
    await enterEdit(api);
    keypad(api, 'a', '3'); // appends to the seeded 1 → 13
    selectDay(api, 2);
    expect(api.getByLabelText('SUBMIT COUNT')).toBeTruthy();
    expect(api.queryByLabelText('UPDATE COUNT')).toBeNull();
    expect(wellShows(api, 'a', '—')).toBeTruthy();
    fillV1Phone(api, '2');
    await submitPhone(api);
    expect(mockSubmitEODCount).toHaveBeenCalledTimes(1);
    expect(lastWrite().submission.date).toBe(ISO[2]);
    expect(lastWrite().submission.entries.every((e) => e.actualRemaining === 2)).toBe(true);
  });

  it('AC-11: returning to the EDIT date resumes EDIT with the edited value', async () => {
    seed([sub(ISO[1], allV1(1))]);
    const api = render(<EODCountSection />);
    selectDay(api, 1);
    await enterEdit(api);
    keypad(api, 'a', '3');
    selectDay(api, 2);
    selectDay(api, 1);
    expect(api.getByLabelText('UPDATE COUNT')).toBeTruthy();
    expect(wellShows(api, 'a', '13')).toBeTruthy();
  });
});

// ── Q5: spec 189 interplay ───────────────────────────────────────────
describe('EODCountSection — spec 192 × spec 189 (AC-19, AC-20, AC-24)', () => {
  it('AC-19: a blank in D-1 EDIT ships no removal from D-2; back on D-1 UPDATE COUNT sends it, dated D-1', async () => {
    seed([sub(ISO[1], allV1(1))]);
    const api = render(<EODCountSection />);
    selectDay(api, 1);
    await enterEdit(api);
    type(api, 'a', '');

    selectDay(api, 2);
    fillV1(api, '2');
    await press(api, 'SUBMIT COUNT');
    expect(lastWrite().submission.date).toBe(ISO[2]);
    expect(lastWrite().removed).toEqual([]);

    selectDay(api, 1);
    expect(api.getByText('UPDATE COUNT')).toBeTruthy();
    await press(api, 'UPDATE COUNT');
    expect(mockSubmitEODCount).toHaveBeenCalledTimes(2);
    expect(lastWrite().submission.date).toBe(ISO[1]);
    expect(lastWrite().removed).toEqual(['a']);
    expect(lastWrite().submission.entries).toEqual([]);
  });

  it('AC-20: a value typed on D0 under another category pill does not ship with a D-1 submit', async () => {
    seed();
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByText('Dairy (1)'));
    type(api, 'd', '4'); // D0, Dairy pill
    selectDay(api, 1);
    fireEvent.press(api.getByText('Produce (4)'));
    for (const id of ['a', 'b', 'c', 's']) type(api, id, '1');
    await press(api, 'SUBMIT COUNT');
    expect(lastWrite().submission.date).toBe(ISO[1]);
    expect(ids(lastWrite().submission)).toEqual(['a', 'b', 'c', 's']);
  });

  it('AC-24: a blank typed on D-1 does not become a removal of a SAVE DRAFT value on D0', async () => {
    seed();
    const api = render(<EODCountSection />);
    type(api, 'a', '5');
    await press(api, 'SAVE DRAFT'); // a is now in D0's baseline
    expect(lastWrite().submission.date).toBe(ISO[0]);

    selectDay(api, 1);
    type(api, 'a', '7');
    type(api, 'a', ''); // blank it on D-1, don't submit

    selectDay(api, 0);
    expect(unitIn(api, 'a').props.value).toBe('5');
    for (const id of ['b', 'c', 'd', 's']) type(api, id, '1');
    await press(api, 'SUBMIT COUNT');
    expect(lastWrite().submission.date).toBe(ISO[0]);
    expect(lastWrite().removed).toEqual([]);
    expect(ids(lastWrite().submission)).not.toContain('a');
  });

  it('AC-24: a blank typed on D-1 does not become a removal of an EDIT-seeded value on D0', async () => {
    seed([sub(ISO[0], allV1(1))]);
    const api = render(<EODCountSection />);
    await enterEdit(api); // a = 1 seeded into D0's baseline
    selectDay(api, 1);
    type(api, 'a', '');

    selectDay(api, 0);
    expect(unitIn(api, 'a').props.value).toBe('1');
    type(api, 'b', '6'); // a real change, so the call is made
    await press(api, 'UPDATE COUNT');
    expect(lastWrite().submission.date).toBe(ISO[0]);
    expect(lastWrite().removed).toEqual([]);
    expect(ids(lastWrite().submission)).toEqual(['b']);
  });
});

// ── Q6: + COUNT rows ─────────────────────────────────────────────────
describe('EODCountSection — spec 192 + COUNT rows per (store, date) (AC-21)', () => {
  it('a + COUNT row on D0 is not on D-1 nor asked for by its gate; it is on D0 across vendor tabs', async () => {
    seed();
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByText('+ COUNT'));
    fireEvent.press(api.getByText('Item y'));
    expect(api.getByTestId('eod-unit-input-y')).toBeTruthy();
    expect(api.getByText('0 of 6 items counted')).toBeTruthy();

    selectDay(api, 1);
    expect(api.queryByTestId('eod-unit-input-y')).toBeNull();
    fillV1(api, '1');
    await press(api, 'SUBMIT COUNT');
    expect(mockSubmitEODCount).toHaveBeenCalledTimes(1);
    expect(lastWrite().submission.date).toBe(ISO[1]);

    selectDay(api, 0);
    expect(api.getByTestId('eod-unit-input-y')).toBeTruthy();
    fireEvent.press(api.getByText('COSTCO (2)'));
    expect(api.getByTestId('eod-unit-input-y')).toBeTruthy();
  });
});
