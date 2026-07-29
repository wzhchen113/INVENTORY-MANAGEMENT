// src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.test.tsx — Spec 144.
//
// Behavioral coverage for the phone weekly-count worksheet:
//   - category grouping (GroupCaption per category, name-sorted rows);
//   - the variance line + the ±15% danger boundary (the pure classifier);
//   - the own submit gate (blocked → toast, never onSubmit; ready → onSubmit);
//   - keypad write-through (open well → digit → the correct entry setter runs);
//   - the ◎ export-locale cycle.
//
// PhoneWeeklyCount is presentational (every datum + handler arrives in `model`),
// so these render it directly with a controlled model — no store, no section.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

const mockToastShow = jest.fn();
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: (...a: unknown[]) => mockToastShow(...a) },
}));

import PhoneWeeklyCount, { nextExportLocale, type PhoneWeeklyModel } from '../PhoneWeeklyCount';
import { weeklyVariance } from '../weeklyVariance';
import type { InventoryItem } from '../../../../../types';
import type { Locale } from '../../../../../hooks/useLocale';

function mkItem(id: string, name: string, category: string, over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id, catalogId: id, name, category, unit: 'lbs', costPerUnit: 3, currentStock: 20,
    parLevel: 10, averageDailyUsage: 0, safetyStock: 0, vendorId: 'v', vendorName: '',
    usagePerPortion: 0, lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, storeId: 'store-1',
    casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: 'lb', ...over,
  } as InventoryItem;
}

interface ModelOpts {
  items?: InventoryItem[];
  caseCounts?: Record<string, string>;
  unitCounts?: Record<string, string>;
  onSubmit?: () => void;
  setUnitCounts?: PhoneWeeklyModel['setUnitCounts'];
  setCaseCounts?: PhoneWeeklyModel['setCaseCounts'];
  setExportLocale?: (l: Locale) => void;
  exportLocale?: Locale;
  isAllOrEmpty?: boolean;
}

function makeModel(opts: ModelOpts = {}): PhoneWeeklyModel {
  const items = opts.items ?? [mkItem('i1', 'Chicken', 'Proteins')];
  const caseCounts = opts.caseCounts ?? {};
  const unitCounts = opts.unitCounts ?? {};
  const hasEntry = (id: string) =>
    (caseCounts[id] ?? '').trim() !== '' || (unitCounts[id] ?? '').trim() !== '';
  const byId = new Map(items.map((i) => [i.id, i]));
  const itemTotal = (i: InventoryItem) => {
    const c = parseFloat(caseCounts[i.id] || '');
    const u = parseFloat(unitCounts[i.id] || '');
    return (isNaN(c) ? 0 : c) * (i.caseQty || 1) + (isNaN(u) ? 0 : u);
  };
  const totalItems = items.length;
  const nonBlankCount = items.filter((i) => hasEntry(i.id)).length;
  return {
    wkNum: 30,
    storeInventory: items,
    caseCounts,
    unitCounts,
    itemNotes: {},
    setCaseCounts: opts.setCaseCounts ?? jest.fn(),
    setUnitCounts: opts.setUnitCounts ?? jest.fn(),
    setItemNotes: jest.fn(),
    hasEntry,
    itemTotal: (i) => itemTotal(byId.get((i as InventoryItem).id) ?? (i as InventoryItem)),
    nonBlankCount,
    totalItems,
    hasNegative: false,
    submitting: false,
    isAllOrEmpty: opts.isAllOrEmpty ?? false,
    onSubmit: opts.onSubmit ?? jest.fn(),
    onExportCsv: jest.fn(),
    onExportPdf: jest.fn(),
    exportLocale: opts.exportLocale ?? 'en',
    setExportLocale: opts.setExportLocale ?? jest.fn(),
  };
}

beforeEach(() => jest.clearAllMocks());

describe('PhoneWeeklyCount — grouping', () => {
  it('groups items by category (alpha) with a GroupCaption per category', () => {
    const items = [
      mkItem('i1', 'Chicken', 'Proteins'),
      mkItem('i2', 'Milk', 'Dairy'),
      mkItem('i3', 'Beef', 'Proteins'),
    ];
    const { getByText } = render(<PhoneWeeklyCount model={makeModel({ items })} />);
    // 1 dairy item, 2 protein items — captions carry the count.
    expect(getByText('Dairy · 1 ITEMS')).toBeTruthy();
    expect(getByText('Proteins · 2 ITEMS')).toBeTruthy();
    // Rows render full names (Hard Rule 2).
    expect(getByText('Chicken')).toBeTruthy();
    expect(getByText('Beef')).toBeTruthy();
    expect(getByText('Milk')).toBeTruthy();
  });
});

describe('PhoneWeeklyCount — variance line', () => {
  it('shows ✓ MATCHES SYSTEM when the count equals the system on-hand', () => {
    const items = [mkItem('i1', 'Chicken', 'Proteins', { currentStock: 20 })];
    const { getByTestId } = render(
      <PhoneWeeklyCount model={makeModel({ items, unitCounts: { i1: '20' } })} />,
    );
    expect(getByTestId('weekly-variance-i1').props.children).toBe('✓ MATCHES SYSTEM');
  });

  it('shows the signed shortfall vs system when counted below system', () => {
    const items = [mkItem('i1', 'Chicken', 'Proteins', { currentStock: 20 })];
    const { getByTestId } = render(
      <PhoneWeeklyCount model={makeModel({ items, unitCounts: { i1: '8' } })} />,
    );
    // README example: −12 lbs VS SYSTEM.
    expect(getByTestId('weekly-variance-i1').props.children).toBe('−12 lbs VS SYSTEM');
  });

  it('does not render a variance line for an uncounted row', () => {
    const items = [mkItem('i1', 'Chicken', 'Proteins')];
    const { queryByTestId } = render(<PhoneWeeklyCount model={makeModel({ items })} />);
    expect(queryByTestId('weekly-variance-i1')).toBeNull();
  });
});

describe('weeklyVariance — ±15% danger boundary', () => {
  it('is ok exactly at the system value', () => {
    expect(weeklyVariance(20, 20)).toMatchObject({ matches: true, tone: 'ok' });
  });
  it('is warn at exactly ±15% (boundary is inclusive of warn)', () => {
    // 3 / 20 = 0.15 exactly → warn (danger is strictly > 0.15).
    expect(weeklyVariance(23, 20)).toMatchObject({ tone: 'warn' });
    expect(weeklyVariance(17, 20)).toMatchObject({ tone: 'warn' });
  });
  it('is danger just past ±15%', () => {
    // 3.01 / 20 = 0.1505 > 0.15 → danger.
    expect(weeklyVariance(23.01, 20)).toMatchObject({ tone: 'danger' });
    expect(weeklyVariance(16.99, 20)).toMatchObject({ tone: 'danger' });
  });
});

describe('PhoneWeeklyCount — submit gate', () => {
  it('blocks submit + toasts the remainder when not all counted', () => {
    const onSubmit = jest.fn();
    const items = [mkItem('i1', 'Chicken', 'Proteins'), mkItem('i2', 'Milk', 'Dairy')];
    const { getByTestId } = render(
      <PhoneWeeklyCount model={makeModel({ items, unitCounts: { i1: '5' }, onSubmit })} />,
    );
    fireEvent.press(getByTestId('weekly-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(mockToastShow).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('calls onSubmit when every item is counted', () => {
    const onSubmit = jest.fn();
    const items = [mkItem('i1', 'Chicken', 'Proteins'), mkItem('i2', 'Milk', 'Dairy')];
    const { getByTestId } = render(
      <PhoneWeeklyCount model={makeModel({ items, unitCounts: { i1: '5', i2: '9' }, onSubmit })} />,
    );
    fireEvent.press(getByTestId('weekly-submit'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('PhoneWeeklyCount — keypad write-through', () => {
  it('opening a unit well + a digit appends through setUnitCounts', () => {
    const setUnitCounts = jest.fn();
    const items = [mkItem('i1', 'Chicken', 'Proteins')];
    const { getByTestId } = render(
      <PhoneWeeklyCount model={makeModel({ items, setUnitCounts })} />,
    );
    fireEvent.press(getByTestId('weekly-well-i1-units'));
    fireEvent.press(getByTestId('eod-key-5'));
    expect(setUnitCounts).toHaveBeenCalledTimes(1);
    // The setter receives an updater; applying it appends '5' to the empty field.
    const updater = setUnitCounts.mock.calls[0][0] as (p: Record<string, string>) => Record<string, string>;
    expect(updater({})).toEqual({ i1: '5' });
  });

  it('auto-selects the cases field when caseQty > 1 (write hits setCaseCounts)', () => {
    const setCaseCounts = jest.fn();
    const items = [mkItem('i1', 'Chicken', 'Proteins', { caseQty: 6 })];
    const { getByTestId } = render(
      <PhoneWeeklyCount model={makeModel({ items, setCaseCounts })} />,
    );
    fireEvent.press(getByTestId('weekly-well-i1-cases'));
    fireEvent.press(getByTestId('eod-key-2'));
    expect(setCaseCounts).toHaveBeenCalledTimes(1);
    const updater = setCaseCounts.mock.calls[0][0] as (p: Record<string, string>) => Record<string, string>;
    expect(updater({})).toEqual({ i1: '2' });
  });
});

describe('PhoneWeeklyCount — export-locale cycle', () => {
  it('nextExportLocale cycles EN → ES → 中文 → EN', () => {
    expect(nextExportLocale('en')).toBe('es');
    expect(nextExportLocale('es')).toBe('zh-CN');
    expect(nextExportLocale('zh-CN')).toBe('en');
  });

  it('the ◎ chip advances the export locale', () => {
    const setExportLocale = jest.fn();
    const { getByTestId } = render(
      <PhoneWeeklyCount model={makeModel({ exportLocale: 'en', setExportLocale })} />,
    );
    fireEvent.press(getByTestId('weekly-export-lang'));
    expect(setExportLocale).toHaveBeenCalledWith('es');
  });
});
