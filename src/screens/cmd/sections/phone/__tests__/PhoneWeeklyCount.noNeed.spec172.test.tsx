// src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.noNeed.spec172.test.tsx — Spec 172.
//
// AC-40 / "weekly count is out of scope" guard: the spec 172 NO NEED control is
// EOD-only. PhoneWeeklyCount reuses PhoneKeypadSheet and never passes
// `onNoNeed`, so neither the row nor the sheet may render a NO NEED control.
// (PhoneKeypadSheet's opt-in contract is pinned in
// EODCountSection.noNeed.spec172.test.tsx; this pins the weekly SURFACE.)

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

describe('PhoneWeeklyCount — spec 172: no NO NEED control (EOD-only)', () => {
  it('renders no eod-noneed-<id> row control for counted or uncounted rows', () => {
    const items = [
      mkItem('i1', 'Chicken', 'Proteins'),
      mkItem('i2', 'Beef', 'Proteins', { caseQty: 6 }),
    ];
    const api = render(
      <PhoneWeeklyCount model={makeModel({ items, unitCounts: { i1: '4' } })} />,
    );
    expect(api.queryByTestId('eod-noneed-i1')).toBeNull();
    expect(api.queryByTestId('eod-noneed-i2')).toBeNull();
    expect(api.queryByText(/NO NEED/i)).toBeNull();
  });

  it('the keypad sheet opened from a weekly well has no eod-sheet-noneed button', () => {
    const items = [mkItem('i1', 'Chicken', 'Proteins')];
    const api = render(<PhoneWeeklyCount model={makeModel({ items })} />);
    fireEvent.press(api.getByTestId('weekly-well-i1-units'));
    // The sheet is open (digit pad present) ...
    expect(api.getByTestId('eod-key-5')).toBeTruthy();
    // ... and carries no NO NEED affordance.
    expect(api.queryByTestId('eod-sheet-noneed')).toBeNull();
    expect(api.queryByText(/NO NEED/i)).toBeNull();
  });
});
