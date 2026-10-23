// src/screens/cmd/sections/eod/__tests__/EODCountSection.noNeed.spec172.test.tsx
//
// Spec 172 — the EOD "NO NEED" ("more than enough; not counted numerically")
// mark on the ADMIN EOD surfaces. Renders the FULL EODCountSection (desktop and
// phone tier) against a seeded store so the parent's NO NEED state, the
// counted predicates, buildSubmission, the gate, EDIT prefill, the locked view
// and the export are exercised through the real rows:
//   - AC-17 deriveCountedItemIds arm (c) (pure) + cross-tab counted-once.
//   - AC-18..AC-21, AC-24, AC-25 desktop row / submission / footer / locked.
//   - AC-28..AC-30 phone row + keypad sheet (OQ-5 mark-and-advance).
//   - AC-35 every spec 171 count mode.
//   - AC-39 the CSV export cell.
//   - PhoneKeypadSheet without `onNoNeed` (the weekly count) shows no button.
//
// Harness copied from EODCountSection.countMode.spec171.test.tsx (inert db.ts
// Proxy + stubbed supabase, controllable phone tier, `submitEOD` spy).

import React from 'react';
import { TextInput, StyleSheet } from 'react-native';
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

jest.mock('../../../../../lib/db', () =>
  new Proxy(
    { __esModule: true },
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

// Spec 172 (AC-39) — capture the CSV the export button builds (the real
// pure builder still runs; only the browser download seam is stubbed).
const mockDownloadCSV = jest.fn();
jest.mock('../../../../../utils', () => ({
  ...jest.requireActual('../../../../../utils'),
  downloadCSV: (...args: unknown[]) => mockDownloadCSV(...args),
}));

import EODCountSection, { deriveCountedItemIds } from '../../EODCountSection';
import { PhoneKeypadSheet } from '../PhoneKeypadSheet';
import { useStore } from '../../../../../store/useStore';
import { useCmdColors } from '../../../../../theme/colors';
import type { InventoryItem } from '../../../../../types';

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
    caseQty: 24,
    parLevel: 0,
    currentStock: 0,
    costPerUnit: 0,
    subUnitSize: 1,
    ...over,
  } as unknown as InventoryItem;
}

function submittedSub(entries: Array<Record<string, unknown>>) {
  return {
    id: 'sub-1',
    date: TODAY,
    storeId: 'store-1',
    storeName: 'Frederick',
    vendorId: 'v1',
    vendorName: 'BJ',
    submittedBy: 'Admin',
    submittedByUserId: 'user-1',
    timestamp: new Date().toISOString(),
    itemCount: entries.length,
    status: 'submitted',
    entries: entries.map((e) => ({
      id: `e-${e.itemId}`,
      itemName: 'x',
      unit: 'ea',
      submittedBy: 'Admin',
      submittedByUserId: 'user-1',
      timestamp: new Date().toISOString(),
      date: TODAY,
      storeId: 'store-1',
      notes: '',
      ...e,
    })),
  };
}

const submitEODSpy = jest.fn();

function seed(inventory: InventoryItem[], eodSubmissions: unknown[] = [], vendors: unknown[] = [{ id: 'v1', name: 'BJ' }]) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory,
    vendors: vendors as any,
    eodSubmissions: eodSubmissions as any,
    orderSchedule: {},
    storeLoading: false,
    submitEOD: submitEODSpy as any,
  });
}

let C: ReturnType<typeof useCmdColors>;
function Probe() {
  C = useCmdColors();
  return null;
}

function styleOf(el: { props: { style?: unknown } }) {
  return StyleSheet.flatten(el.props.style as never) as { opacity?: number; borderColor?: string };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsPhone = false;
  jest.spyOn(Toast, 'show').mockImplementation(() => {});
});


const LOCKED_NO_NEED = { itemId: 'n', actualRemaining: null, noNeed: true };

// ── AC-17: deriveCountedItemIds arm (c) (pure) ─────────────────────────
describe('deriveCountedItemIds — spec 172 noNeedByVendor (AC-17)', () => {
  const base = {
    caseCountsByVendor: { vA: { typed: '1' } },
    unitCountsByVendor: {},
    submissions: [{ storeId: 'store-1', date: TODAY, status: 'draft', entries: [{ itemId: 'persisted' }] }],
    storeId: 'store-1',
    dateIso: TODAY,
  };

  it('omitting the argument reproduces today\'s output', () => {
    expect([...deriveCountedItemIds(base)].sort()).toEqual(['persisted', 'typed']);
  });

  it('an item marked NO NEED in ANY vendor tab is counted', () => {
    const counted = deriveCountedItemIds({
      ...base,
      noNeedByVendor: { vB: { nn: true }, vC: { off: false } },
    });
    expect([...counted].sort()).toEqual(['nn', 'persisted', 'typed']);
  });
});

// ── Desktop tier ───────────────────────────────────────────────────────
describe('EODCountSection desktop — spec 172 NO NEED', () => {
  it('AC-18: tapping NO NEED counts the row — no danger border, blank boxes, active control, no total suffix', () => {
    seed([makeItem('n'), makeItem('other')]);
    const api = render(<><Probe /><EODCountSection /></>);
    // Uncounted first: danger border on the inputs.
    expect(styleOf(api.getByTestId('eod-case-input-n')).borderColor).toBe(C.danger);
    expect(api.getByText('0 of 2 items counted')).toBeTruthy();

    fireEvent.press(api.getByTestId('eod-noneed-n'));
    expect(styleOf(api.getByTestId('eod-case-input-n')).borderColor).not.toBe(C.danger);
    expect(styleOf(api.getByTestId('eod-unit-input-n')).borderColor).not.toBe(C.danger);
    expect(api.getByTestId('eod-case-input-n').props.value).toBe('');
    expect(api.getByTestId('eod-unit-input-n').props.value).toBe('');
    expect(api.getByTestId('eod-noneed-n').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(api.queryByText(/total \d+ ea/)).toBeNull();
    expect(api.getByText('1 of 2 items counted')).toBeTruthy();
    // The localized label + aria.
    expect(api.getByLabelText('Item n: no need — more than enough')).toBeTruthy();
  });

  it('AC-19 / OQ-1: NO NEED on a typed row clears the number; typing after NO NEED clears the mark', () => {
    seed([makeItem('n')]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(api.getByTestId('eod-case-input-n'), '2');
    fireEvent.changeText(api.getByTestId('eod-unit-input-n'), '5');
    expect(api.getByText(/total 53 ea/)).toBeTruthy();
    fireEvent.press(api.getByTestId('eod-noneed-n'));
    expect(api.getByTestId('eod-case-input-n').props.value).toBe('');
    expect(api.getByTestId('eod-unit-input-n').props.value).toBe('');
    expect(api.queryByText(/total 53 ea/)).toBeNull();

    fireEvent.changeText(api.getByTestId('eod-unit-input-n'), '7');
    expect(api.getByTestId('eod-noneed-n').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    expect(api.getByTestId('eod-unit-input-n').props.value).toBe('7');
  });

  it('AC-16: a re-tap clears NO NEED → the row is uncounted with blank boxes again', () => {
    seed([makeItem('n')]);
    const api = render(<><Probe /><EODCountSection /></>);
    fireEvent.press(api.getByTestId('eod-noneed-n'));
    fireEvent.press(api.getByTestId('eod-noneed-n'));
    expect(api.getByText('0 of 1 items counted')).toBeTruthy();
    expect(styleOf(api.getByTestId('eod-case-input-n')).borderColor).toBe(C.danger);
  });

  it('AC-18d + AC-21: a NO NEED-only worksheet passes the gate and ships { noNeed, actualRemaining: null } with the note', async () => {
    seed([makeItem('n', { unit: 'lb' })]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-noneed-n'));
    fireEvent.changeText(api.getByPlaceholderText('Note…'), 'shelf full');
    await act(async () => {
      fireEvent.press(api.getByText('SUBMIT COUNT'));
    });
    expect(submitEODSpy).toHaveBeenCalledTimes(1);
    const sub = submitEODSpy.mock.calls[0][0];
    expect(sub.itemCount).toBe(1);
    expect(sub.status).toBe('submitted');
    expect(sub.entries).toHaveLength(1);
    expect(sub.entries[0]).toEqual(
      expect.objectContaining({
        itemId: 'n',
        noNeed: true,
        actualRemaining: null,
        actualRemainingCases: undefined,
        actualRemainingEach: undefined,
        notes: 'shelf full',
        unit: 'lb',
      }),
    );
  });

  it('AC-21: Save Draft with only NO NEED marks builds a non-null submission; a numeric entry has no noNeed key', async () => {
    seed([makeItem('n'), makeItem('c')]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-noneed-n'));
    fireEvent.changeText(api.getByTestId('eod-unit-input-c'), '4');
    await act(async () => {
      fireEvent.press(api.getByText('SAVE DRAFT'));
    });
    const sub = submitEODSpy.mock.calls[0][0];
    expect(sub.status).toBe('draft');
    expect(sub.itemCount).toBe(2);
    const numeric = sub.entries.find((e: any) => e.itemId === 'c');
    expect(numeric).toEqual(expect.objectContaining({ actualRemaining: 4, actualRemainingEach: 4 }));
    expect('noNeed' in numeric).toBe(false);
  });

  it('AC-24: the footer est. value / variance exclude a NO NEED row', () => {
    seed([makeItem('n', { currentStock: 10, costPerUnit: 2 })]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-noneed-n'));
    // A 0-total row would read -10.0; a NO NEED row contributes nothing.
    expect(api.queryByText('-10.0')).toBeNull();
    expect(api.getByText('+0.0')).toBeTruthy();
    expect(api.getByText('$0.00')).toBeTruthy();
  });

  it('AC-20: the control is disabled on a locked vendor', () => {
    seed([makeItem('n'), makeItem('x')], [submittedSub([{ itemId: 'x', actualRemaining: 3, actualRemainingEach: 3 }])]);
    const api = render(<EODCountSection />);
    const btn = api.getByTestId('eod-noneed-n');
    expect(btn.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true, selected: false }));
  });

  it('AC-25: a locked NO NEED entry renders blank boxes + the active disabled control (never "0")', () => {
    seed([makeItem('n')], [submittedSub([LOCKED_NO_NEED])]);
    const api = render(<EODCountSection />);
    expect(api.getByTestId('eod-case-input-n').props.value).toBe('');
    expect(api.getByTestId('eod-unit-input-n').props.value).toBe('');
    expect(api.getByTestId('eod-noneed-n').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true, disabled: true }),
    );
  });

  it('AC-25: EDIT prefill seeds the NO NEED state (not "0"); UPDATE re-ships it', async () => {
    seed([makeItem('n')], [submittedSub([LOCKED_NO_NEED])]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByLabelText("Edit this vendor's submitted count"));
    await waitFor(() => expect(api.getByTestId('eod-unit-input-n').props.editable).toBe(true));
    expect(api.getByTestId('eod-unit-input-n').props.value).toBe('');
    expect(api.getByTestId('eod-noneed-n').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true, disabled: false }),
    );
    await act(async () => {
      fireEvent.press(api.getByText('UPDATE COUNT'));
    });
    expect(submitEODSpy.mock.calls[0][0].entries[0]).toEqual(
      expect.objectContaining({ itemId: 'n', noNeed: true, actualRemaining: null }),
    );
  });

  it('AC-17: a shared item marked NO NEED under one vendor tab is counted under the other', () => {
    const shared = makeItem('s', { vendorIds: ['v1', 'v2'] });
    seed([shared, makeItem('only2', { vendorId: 'v2', vendorIds: ['v2'] })], [], [
      { id: 'v1', name: 'BJ' },
      { id: 'v2', name: 'Sams' },
    ]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-noneed-s'));
    fireEvent.press(api.getAllByText(/SAMS/)[0]);
    // Under v2 the shared item is not re-marked locally, yet it counts.
    expect(api.getByTestId('eod-noneed-s').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    expect(api.getByText('1 of 2 items counted')).toBeTruthy();
  });

  it.each(['cases_only', 'units_only', 'cases_and_units'] as const)(
    'AC-35 (%s): NO NEED counts and ships no quantity',
    async (mode) => {
      seed([makeItem('n', { eodCountMode: mode })]);
      const api = render(<EODCountSection />);
      fireEvent.press(api.getByTestId('eod-noneed-n'));
      expect(api.getByText('1 of 1 items counted')).toBeTruthy();
      await act(async () => {
        fireEvent.press(api.getByText('SUBMIT COUNT'));
      });
      expect(submitEODSpy.mock.calls[0][0].entries[0]).toEqual(
        expect.objectContaining({ noNeed: true, actualRemaining: null }),
      );
    },
  );

  it('AC-35: a stale disabled-box value is cleared by NO NEED and cannot un-set it', async () => {
    seed([makeItem('s')]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(api.getByTestId('eod-case-input-s'), '2');
    act(() => {
      useStore.setState({ inventory: [makeItem('s', { eodCountMode: 'units_only' })] });
    });
    fireEvent.press(api.getByTestId('eod-noneed-s'));
    // Flip back: the cleared cases value does not resurface.
    act(() => {
      useStore.setState({ inventory: [makeItem('s')] });
    });
    expect(api.getByTestId('eod-case-input-s').props.value).toBe('');
    expect(api.getByTestId('eod-noneed-s').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
  });

  it('AC-39: the CSV export puts NO NEED in Counted Total with blank case / unit cells', () => {
    seed([makeItem('n', { name: 'Napkins' })]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-noneed-n'));
    fireEvent.press(api.getByTestId('eod-export-csv'));
    expect(mockDownloadCSV).toHaveBeenCalledTimes(1);
    const csv: string = mockDownloadCSV.mock.calls[0][1];
    const lines = csv.split(/\r?\n/);
    const header = lines[0].split(',');
    const row = lines.find((l) => l.includes('Napkins'))!.split(',');
    expect(row[header.indexOf('Counted Cases')]).toBe('');
    expect(row[header.indexOf('Counted Units')]).toBe('');
    expect(row[header.indexOf('Counted Total')]).toBe('NO NEED');
  });
});

// ── Phone tier ─────────────────────────────────────────────────────────
describe('EODCountSection phone — spec 172 NO NEED', () => {
  beforeEach(() => {
    mockIsPhone = true;
  });

  it('AC-28: the row control marks the row counted without opening the keypad; wells stay blank', () => {
    seed([makeItem('n')]);
    const api = render(<EODCountSection />);
    expect(api.queryByTestId('eod-counted-n')).toBeNull();
    fireEvent.press(api.getByTestId('eod-noneed-n'));
    expect(api.getByTestId('eod-counted-n')).toBeTruthy();
    expect(api.queryByTestId('eod-sheet-title')).toBeNull();
    expect(within(api.getByTestId('eod-well-n-units')).getByText('—')).toBeTruthy();
    expect(within(api.getByTestId('eod-well-n-cases')).getByText('—')).toBeTruthy();
    // The meta suffix reads the NO NEED label, never "· 0 ea".
    expect(api.queryByText(/· 0 ea/)).toBeNull();
    expect(api.getAllByText('READY').length).toBeGreaterThan(0);
  });

  it('AC-29 / OQ-5: the sheet NO NEED marks the seated item and advances; the last one closes with the toast', () => {
    seed([makeItem('a'), makeItem('b')]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-well-a-units'));
    expect(api.getByTestId('eod-sheet-title').props.children).toBe('Item a');
    fireEvent.press(api.getByTestId('eod-sheet-noneed'));
    expect(api.getByTestId('eod-sheet-title').props.children).toBe('Item b');
    expect(api.getByTestId('eod-counted-a')).toBeTruthy();
    fireEvent.press(api.getByTestId('eod-sheet-noneed'));
    expect(api.queryByTestId('eod-sheet-title')).toBeNull();
    expect(api.getByTestId('eod-counted-b')).toBeTruthy();
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ text1: 'All items counted ✓' }));
  });

  it('AC-29: while NO NEED the running total shows the label; a digit clears it and writes the digit', () => {
    seed([makeItem('n')]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-noneed-n'));
    fireEvent.press(api.getByTestId('eod-well-n-units'));
    expect(api.getByTestId('eod-sheet-total').props.children).toBe('NO NEED');
    fireEvent.press(api.getByTestId('eod-key-4'));
    expect(api.getByText('= 4 ea total')).toBeTruthy();
    expect(within(api.getByTestId('eod-well-n-units')).getByText('4')).toBeTruthy();
    expect(api.getByTestId('eod-noneed-n').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('AC-30: a locked NO NEED entry shows the active disabled control and blank wells (never "0")', () => {
    seed([makeItem('n')], [submittedSub([LOCKED_NO_NEED])]);
    const api = render(<EODCountSection />);
    expect(api.getByTestId('eod-noneed-n').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true, disabled: true }),
    );
    expect(within(api.getByTestId('eod-well-n-units')).getByText('—')).toBeTruthy();
    expect(api.queryByText('0')).toBeNull();
  });

  it('AC-30: a locked numeric row shows no NO NEED control', () => {
    seed([makeItem('x')], [submittedSub([{ itemId: 'x', actualRemaining: 3, actualRemainingEach: 3 }])]);
    const api = render(<EODCountSection />);
    expect(api.queryByTestId('eod-noneed-x')).toBeNull();
  });
});

// ── PhoneKeypadSheet opt-in (weekly count must not show NO NEED) ───────
describe('PhoneKeypadSheet — spec 172 opt-in', () => {
  const base = {
    visible: true,
    item: makeItem('w'),
    activeField: 'units' as const,
    setActiveField: jest.fn(),
    caseValue: '',
    unitValue: '',
    noteValue: '',
    runningTotal: 0,
    isDone: false,
    onKey: jest.fn(),
    onNote: jest.fn(),
    onSkip: jest.fn(),
    onNext: jest.fn(),
    onClose: jest.fn(),
  };

  it('without onNoNeed (PhoneWeeklyCount) there is no NO NEED button and the total is numeric', () => {
    const api = render(<PhoneKeypadSheet {...base} />);
    expect(api.queryByTestId('eod-sheet-noneed')).toBeNull();
    expect(api.getByText('= 0 ea total')).toBeTruthy();
  });

  it('with onNoNeed the button renders and fires', () => {
    const onNoNeed = jest.fn();
    const api = render(<PhoneKeypadSheet {...base} onNoNeed={onNoNeed} />);
    fireEvent.press(api.getByTestId('eod-sheet-noneed'));
    expect(onNoNeed).toHaveBeenCalledTimes(1);
  });
});
