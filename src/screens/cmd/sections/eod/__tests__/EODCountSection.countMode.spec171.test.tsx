// src/screens/cmd/sections/eod/__tests__/EODCountSection.countMode.spec171.test.tsx
//
// Spec 171 — per-ingredient EOD count mode on the ADMIN EOD surfaces. Renders
// the FULL EODCountSection (desktop tier and phone tier) against a seeded store
// so the parent's mode-aware `itemTotal` / `localHasEntry` / `hasEntry` /
// `buildSubmission` / gate are exercised through the real rows:
//   - AC-10 desktop row: the disabled box is non-editable, blank, '—'
//     placeholder + caption, dimmed, never danger-bordered.
//   - AC-11 gate jump focuses the ENABLED input.
//   - AC-12 deriveCountedItemIds ignores a disabled-box value (pure arms).
//   - AC-13 phone row + keypad sheet omit the disabled well; AC-8 the sheet
//     seats the enabled field.
//   - AC-16 a stale value in a now-disabled box (realtime mode flip): total 0,
//     uncounted, gate blocks, draft omits it / drops the disabled value.
//   - AC-20 + OQ-A (owner-approved): the locked view renders the stored splits
//     with the legacy layout, and UNITS falls back to the total only when BOTH
//     splits are null — desktop read-only, desktop EDIT prefill, phone locked.
//
// Mocks: inert db.ts Proxy + stubbed supabase (same as EODCountSection.acReg),
// controllable phone tier, and a `submitEOD` spy on the store.

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

import EODCountSection, { deriveCountedItemIds, unitsDisplayFor } from '../../EODCountSection';
import { useStore } from '../../../../../store/useStore';
import { useCmdColors } from '../../../../../theme/colors';
import type { EodCountMode } from '../../../../../lib/eodCountMode';
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

// Spec 189 §8 — submitEOD returns an undo; the section calls it when the
// server write rejects, so the spy must return one.
const submitEODSpy = jest.fn<any, any[]>(() => jest.fn());

function seed(inventory: InventoryItem[], eodSubmissions: unknown[] = []) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory,
    vendors: [{ id: 'v1', name: 'BJ' } as any],
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

// ── AC-12: deriveCountedItemIds (pure) ─────────────────────────────────
describe('deriveCountedItemIds — spec 171 effectiveModeOf (AC-12)', () => {
  const base = { submissions: [], storeId: 'store-1', dateIso: TODAY };
  const modes: Record<string, EodCountMode> = { u: 'units_only', c: 'cases_only', b: 'cases_and_units' };
  const effectiveModeOf = (id: string) => modes[id];

  it('ignores a CASE value in any tab for a units_only item', () => {
    const counted = deriveCountedItemIds({
      ...base,
      caseCountsByVendor: { vA: { u: '2' }, vB: { u: '3' } },
      unitCountsByVendor: {},
      effectiveModeOf,
    });
    expect(counted.has('u')).toBe(false);
  });

  it('ignores a UNIT value in any tab for a cases_only item', () => {
    const counted = deriveCountedItemIds({
      ...base,
      caseCountsByVendor: {},
      unitCountsByVendor: { vB: { c: '5' } },
      effectiveModeOf,
    });
    expect(counted.has('c')).toBe(false);
  });

  it('credits the ENABLED box per mode, and either box for cases_and_units', () => {
    const counted = deriveCountedItemIds({
      ...base,
      caseCountsByVendor: { vA: { c: '1', b: '1' } },
      unitCountsByVendor: { vB: { u: '4' } },
      effectiveModeOf,
    });
    expect([...counted].sort()).toEqual(['b', 'c', 'u']);
  });

  it('an id the resolver does not know keeps the either-box rule', () => {
    const counted = deriveCountedItemIds({
      ...base,
      caseCountsByVendor: { vA: { zz: '1' } },
      unitCountsByVendor: {},
      effectiveModeOf,
    });
    expect(counted.has('zz')).toBe(true);
  });

  it('arm (b) persisted submissions are unchanged by the mode', () => {
    const counted = deriveCountedItemIds({
      ...base,
      caseCountsByVendor: {},
      unitCountsByVendor: {},
      submissions: [{ storeId: 'store-1', date: TODAY, status: 'draft', entries: [{ itemId: 'u' }] }],
      effectiveModeOf,
    });
    expect(counted.has('u')).toBe(true);
  });
});

// ── OQ-A: unitsDisplayFor (pure) ───────────────────────────────────────
describe('unitsDisplayFor — spec 171 OQ-A', () => {
  it('shows actual_remaining_each when present', () => {
    expect(unitsDisplayFor({ actualRemaining: 53, actualRemainingCases: 2, actualRemainingEach: 5 })).toBe('5');
  });
  it('a cases-only entry (each null, cases set) shows BLANK units, not the total', () => {
    expect(unitsDisplayFor({ actualRemaining: 48, actualRemainingCases: 2, actualRemainingEach: null })).toBe('');
    expect(unitsDisplayFor({ actualRemaining: 48, actualRemainingCases: 2 })).toBe('');
  });
  it('a legacy entry (both splits null) falls back to the total', () => {
    expect(unitsDisplayFor({ actualRemaining: 18, actualRemainingCases: null, actualRemainingEach: null })).toBe('18');
    expect(unitsDisplayFor({ actualRemaining: 18 })).toBe('18');
  });
});

// ── Desktop tier ───────────────────────────────────────────────────────
describe('EODCountSection desktop — spec 171 count mode', () => {
  it('AC-10 units_only: CASES box disabled/blank/"—"/dimmed, no danger border; UNITS editable', () => {
    seed([makeItem('u', { unit: 'lb', eodCountMode: 'units_only' })]);
    const api = render(<><Probe /><EODCountSection /></>);
    const cs = api.getByTestId('eod-case-input-u');
    const un = api.getByTestId('eod-unit-input-u');
    expect(cs.props.editable).toBe(false);
    expect(cs.props.value).toBe('');
    expect(cs.props.placeholder).toBe('—');
    expect(styleOf(cs).opacity).toBe(0.5);
    // Row is uncounted (nothing typed) → the ENABLED box is danger-bordered,
    // the disabled one never is.
    expect(styleOf(un).borderColor).toBe(C.danger);
    expect(styleOf(cs).borderColor).not.toBe(C.danger);
    expect(api.queryByText('× 24')).toBeNull();
    expect(un.props.editable).toBe(true);
    expect(un.props.placeholder).toBe('0');
    expect(api.getByText('lb')).toBeTruthy(); // units caption
  });

  it('AC-10 cases_only: UNITS box disabled/blank/"—"/dimmed + caption "—", no danger border; CASES editable "× 24"', () => {
    seed([makeItem('c', { unit: 'bag', eodCountMode: 'cases_only' })]);
    const api = render(<><Probe /><EODCountSection /></>);
    const cs = api.getByTestId('eod-case-input-c');
    const un = api.getByTestId('eod-unit-input-c');
    expect(un.props.editable).toBe(false);
    expect(un.props.value).toBe('');
    expect(un.props.placeholder).toBe('—');
    expect(styleOf(un).opacity).toBe(0.5);
    expect(styleOf(un).borderColor).not.toBe(C.danger);
    expect(styleOf(cs).borderColor).toBe(C.danger);
    expect(api.queryByText('bag')).toBeNull(); // units caption replaced by '—'
    expect(cs.props.editable).toBe(true);
    expect(api.getByText('× 24')).toBeTruthy();
  });

  it('cases_and_units (default) keeps both boxes editable (AC-21)', () => {
    seed([makeItem('b')]);
    const api = render(<EODCountSection />);
    expect(api.getByTestId('eod-case-input-b').props.editable).toBe(true);
    expect(api.getByTestId('eod-unit-input-b').props.editable).toBe(true);
  });

  it('cases_only: typing cases counts the row; the draft ships cases × caseQty with each = undefined (AC-7)', async () => {
    seed([makeItem('c', { eodCountMode: 'cases_only' })]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(api.getByTestId('eod-case-input-c'), '2');
    await act(async () => {
      fireEvent.press(api.getByText('SAVE DRAFT'));
    });
    expect(submitEODSpy).toHaveBeenCalledTimes(1);
    const sub = submitEODSpy.mock.calls[0][0];
    expect(sub.entries).toHaveLength(1);
    expect(sub.entries[0]).toEqual(
      expect.objectContaining({ itemId: 'c', actualRemaining: 48, actualRemainingCases: 2, actualRemainingEach: undefined }),
    );
  });

  it('AC-11: the gate jump focuses the ENABLED input (units for units_only, cases for cases_only)', async () => {
    const focus = (TextInput as any).prototype.focus as jest.Mock;
    focus.mockClear();
    seed([makeItem('u', { eodCountMode: 'units_only' })]);
    const api = render(<EODCountSection />);
    await act(async () => {
      fireEvent.press(api.getByText('SUBMIT COUNT'));
    });
    await waitFor(() => expect(focus).toHaveBeenCalled());
    expect(focus.mock.contexts.map((c: any) => c.props.testID)).toContain('eod-unit-input-u');
    expect(submitEODSpy).not.toHaveBeenCalled();
    api.unmount();

    focus.mockClear();
    seed([makeItem('c', { eodCountMode: 'cases_only' })]);
    const api2 = render(<EODCountSection />);
    await act(async () => {
      fireEvent.press(api2.getByText('SUBMIT COUNT'));
    });
    await waitFor(() => expect(focus).toHaveBeenCalled());
    expect(focus.mock.contexts.map((c: any) => c.props.testID)).toContain('eod-case-input-c');
  });

  it('AC-16: a stale cases value on an item flipped to units_only is inert — uncounted, gate blocks, draft omits it', async () => {
    seed([makeItem('s'), makeItem('ok', { unit: 'lb' })]);
    const api = render(<><Probe /><EODCountSection /></>);
    fireEvent.changeText(api.getByTestId('eod-case-input-s'), '2');
    fireEvent.changeText(api.getByTestId('eod-unit-input-ok'), '4');
    expect(api.getByText(/total 48 ea/)).toBeTruthy();

    // Realtime catalog reload flips the brand-level mode.
    act(() => {
      useStore.setState({
        inventory: [makeItem('s', { eodCountMode: 'units_only' }), makeItem('ok', { unit: 'lb' })],
      });
    });

    // (d) the CASES box renders disabled and hides the stale value.
    const cs = api.getByTestId('eod-case-input-s');
    expect(cs.props.editable).toBe(false);
    expect(cs.props.value).toBe('');
    // (a) total is 0 → the "· total" meta line is gone.
    expect(api.queryByText(/total 48 ea/)).toBeNull();
    // (b) the row reads uncounted (danger border on the enabled box)…
    expect(styleOf(api.getByTestId('eod-unit-input-s')).borderColor).toBe(C.danger);
    // …and the final-submit gate blocks.
    await act(async () => {
      fireEvent.press(api.getByText('SUBMIT COUNT'));
    });
    expect(submitEODSpy).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', text1: 'Count every item first' }));

    // (c) a draft omits the stale item entirely.
    await act(async () => {
      fireEvent.press(api.getByText('SAVE DRAFT'));
    });
    expect(submitEODSpy).toHaveBeenCalledTimes(1);
    const ids = submitEODSpy.mock.calls[0][0].entries.map((e: any) => e.itemId);
    expect(ids).toEqual(['ok']);
  });

  it('AC-16 mirror: an item flipped to cases_only drops its stale units value from the entry', async () => {
    seed([makeItem('m')]);
    const api = render(<EODCountSection />);
    fireEvent.changeText(api.getByTestId('eod-case-input-m'), '1');
    fireEvent.changeText(api.getByTestId('eod-unit-input-m'), '5');
    act(() => {
      useStore.setState({ inventory: [makeItem('m', { eodCountMode: 'cases_only' })] });
    });
    expect(api.getByTestId('eod-unit-input-m').props.value).toBe('');
    await act(async () => {
      fireEvent.press(api.getByText('SAVE DRAFT'));
    });
    expect(submitEODSpy.mock.calls[0][0].entries[0]).toEqual(
      expect.objectContaining({ itemId: 'm', actualRemaining: 24, actualRemainingCases: 1, actualRemainingEach: undefined }),
    );
  });

  it('AC-20: a locked submission renders the stored cases even though the item is now units_only; OQ-A units stay blank', () => {
    seed(
      [makeItem('u', { eodCountMode: 'units_only' }), makeItem('legacy', { eodCountMode: 'cases_only' })],
      [
        submittedSub([
          { itemId: 'u', actualRemaining: 48, actualRemainingCases: 2, actualRemainingEach: undefined },
          { itemId: 'legacy', actualRemaining: 18 },
        ]),
      ],
    );
    const api = render(<EODCountSection />);
    // Legacy layout while locked: the cases box shows the stored 2…
    expect(api.getByTestId('eod-case-input-u').props.value).toBe('2');
    // …and units do NOT fall back to the 48 total (OQ-A).
    expect(api.getByTestId('eod-unit-input-u').props.value).toBe('');
    // A true legacy row (both splits null) still shows the total in UNITS,
    // even though the item is now cases_only (mode governs editing only).
    expect(api.getByTestId('eod-unit-input-legacy').props.value).toBe('18');
    expect(api.getByTestId('eod-case-input-legacy').props.value).toBe('');
  });

  // Spec 189 §5: UPDATE COUNT with nothing changed no longer re-ships the row
  // (no RPC at all), so the re-submit arm changes the cases value: the units
  // box was seeded blank, so the total is cases × caseQty only, not
  // cases × caseQty + the old 48 total.
  it('OQ-A: EDIT prefill of a cases-only submission seeds cases, leaves units blank (no double count on re-submit)', async () => {
    seed(
      [makeItem('b')],
      [submittedSub([{ itemId: 'b', actualRemaining: 48, actualRemainingCases: 2, actualRemainingEach: undefined }])],
    );
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByLabelText("Edit this vendor's submitted count"));
    await waitFor(() => expect(api.getByTestId('eod-case-input-b').props.editable).toBe(true));
    expect(api.getByTestId('eod-case-input-b').props.value).toBe('2');
    expect(api.getByTestId('eod-unit-input-b').props.value).toBe('');
    fireEvent.changeText(api.getByTestId('eod-case-input-b'), '3');
    await act(async () => {
      fireEvent.press(api.getByText('UPDATE COUNT'));
    });
    expect(submitEODSpy.mock.calls[0][0].entries[0]).toEqual(
      expect.objectContaining({ itemId: 'b', actualRemaining: 72, actualRemainingCases: 3, actualRemainingEach: undefined }),
    );
  });
});

// ── Phone tier ─────────────────────────────────────────────────────────
describe('EODCountSection phone — spec 171 count mode', () => {
  beforeEach(() => {
    mockIsPhone = true;
  });

  it('AC-13: row wells follow the mode (units_only → no CS; cases_only → no unit well; default → both)', () => {
    seed([
      makeItem('u', { eodCountMode: 'units_only' }),
      makeItem('c', { eodCountMode: 'cases_only' }),
      makeItem('b'),
    ]);
    const api = render(<EODCountSection />);
    expect(api.queryByTestId('eod-well-u-cases')).toBeNull();
    expect(api.getByTestId('eod-well-u-units')).toBeTruthy();
    expect(api.getByTestId('eod-well-c-cases')).toBeTruthy();
    expect(api.queryByTestId('eod-well-c-units')).toBeNull();
    expect(api.getByTestId('eod-well-b-cases')).toBeTruthy();
    expect(api.getByTestId('eod-well-b-units')).toBeTruthy();
  });

  it('AC-13 sheet + AC-8: a cases_only item opens a sheet with ONLY the CS well; keys write cases', () => {
    seed([makeItem('c', { eodCountMode: 'cases_only' })]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-well-c-cases'));
    expect(api.getByTestId('eod-sheet-well-cases')).toBeTruthy();
    expect(api.queryByTestId('eod-sheet-well-units')).toBeNull();
    fireEvent.press(api.getByTestId('eod-key-3'));
    expect(api.getByText('= 72 ea total')).toBeTruthy(); // running total 3 × 24
    expect(api.getByTestId('eod-counted-c')).toBeTruthy();
  });

  it('AC-8: the gate jump seats the UNITS field for a units_only item', async () => {
    seed([makeItem('u', { eodCountMode: 'units_only' })]);
    const api = render(<EODCountSection />);
    await act(async () => {
      fireEvent.press(api.getByTestId('eod-submit'));
    });
    await waitFor(() => expect(api.getByTestId('eod-sheet-title')).toBeTruthy());
    expect(api.queryByTestId('eod-sheet-well-cases')).toBeNull();
    fireEvent.press(api.getByTestId('eod-key-7'));
    expect(api.getByTestId('eod-counted-u')).toBeTruthy();
    expect(submitEODSpy).not.toHaveBeenCalled();
  });

  it('AC-8 advance: Next onto an uncounted units_only item seats the UNITS field (no CS well)', () => {
    seed([makeItem('a'), makeItem('b', { eodCountMode: 'units_only' })]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-well-a-cases'));
    fireEvent.press(api.getByTestId('eod-key-3')); // count item a
    fireEvent.press(api.getByTestId('eod-sheet-next')); // advance → b
    expect(api.getByTestId('eod-sheet-title').props.children).toBe('Item b');
    expect(api.queryByTestId('eod-sheet-well-cases')).toBeNull();
    fireEvent.press(api.getByTestId('eod-key-7'));
    expect(api.getByTestId('eod-counted-b')).toBeTruthy();
  });

  it('seated-field clamp: a sheet open on CASES whose item flips to units_only writes into UNITS', () => {
    seed([makeItem('f')]);
    const api = render(<EODCountSection />);
    fireEvent.press(api.getByTestId('eod-well-f-cases'));
    act(() => {
      useStore.setState({ inventory: [makeItem('f', { eodCountMode: 'units_only' })] });
    });
    expect(api.queryByTestId('eod-sheet-well-cases')).toBeNull();
    fireEvent.press(api.getByTestId('eod-key-5'));
    // The keystroke landed in the enabled (units) map → the row counts.
    expect(api.getByTestId('eod-counted-f')).toBeTruthy();
  });

  it('AC-20 + OQ-A phone: locked view shows stored cases with the legacy layout and blank units', () => {
    seed(
      [makeItem('u', { eodCountMode: 'units_only' })],
      [submittedSub([{ itemId: 'u', actualRemaining: 48, actualRemainingCases: 2, actualRemainingEach: undefined }])],
    );
    const api = render(<EODCountSection />);
    // Legacy layout while locked: BOTH wells render (caseQty 24) even though
    // the live mode is units_only; the CS well shows the stored 2…
    expect(within(api.getByTestId('eod-well-u-cases')).getByText('2')).toBeTruthy();
    // …and the units well shows its '—' placeholder, not the 48 total (OQ-A).
    expect(within(api.getByTestId('eod-well-u-units')).getByText('—')).toBeTruthy();
    expect(api.queryByText('48')).toBeNull();
  });
});
