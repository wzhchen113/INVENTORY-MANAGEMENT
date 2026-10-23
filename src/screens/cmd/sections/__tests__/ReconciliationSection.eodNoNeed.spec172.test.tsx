// src/screens/cmd/sections/__tests__/ReconciliationSection.eodNoNeed.spec172.test.tsx
// — Spec 172 (AC-27).
//
// Render pairs: the Reconciliation section must render IDENTICALLY for an EOD
// history with and without one NO NEED entry, on all three tabs:
//   • variance.tsx  — "Items reconciled N / N" counts numeric entries only;
//                     rows come from computeVarianceLines (stripped).
//   • byCategory.tsx — the per-category delta skips NO NEED entries.
//   • timeline.tsx   — the per-day delta skips NO NEED entries.
// A NO NEED entry carries `actualRemaining: null` — read as 0 it would
// manufacture a large negative variance vs par.

jest.mock('../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => false };
});

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA', border: '#CCCCCC',
    borderStrong: '#888888', fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF', warn: '#854F0B',
    warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB', ok: '#3B6D11',
    okBg: '#EAF3DE', info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return `${key}:${JSON.stringify(vars)}`;
  },
}));

jest.mock('../../../../hooks/useRole', () => ({
  useIsSuperAdmin: () => false,
  useIsMaster: () => false,
  useRole: () => 'admin' as const,
}));

jest.mock('../../../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn() })),
    removeChannel: jest.fn(),
    from: jest.fn(),
    rpc: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../../../store/useStore', () => {
  const state: any = {
    eodSubmissions: [],
    inventory: [],
    stores: [],
    currentStore: { id: 'store-a', name: 'Alpha' },
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import ReconciliationSection from '../ReconciliationSection';
import { useStore } from '../../../../store/useStore';
import type { EODEntry, EODSubmission, InventoryItem } from '../../../../types';

const mockState = (useStore as any).__state as Record<string, any>;

const S = 'store-a';
const TODAY = new Date().toISOString().slice(0, 10);
const PRIOR = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
})();

function mkItem(over: Partial<InventoryItem>): InventoryItem {
  return {
    id: 'item', catalogId: 'cat', name: 'Item', category: 'produce', unit: 'lb',
    costPerUnit: 2, currentStock: 5, parLevel: 10, averageDailyUsage: 0,
    safetyStock: 0, vendorId: '', vendorName: '', usagePerPortion: 0,
    lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, storeId: S,
    casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: '',
    ...over,
  };
}

function mkEntry(over: Partial<EODEntry>): EODEntry {
  return {
    id: 'e', itemId: 'item', itemName: '', actualRemaining: 0, unit: 'lb',
    submittedBy: '', submittedByUserId: '', timestamp: '', date: TODAY, storeId: S,
    notes: '',
    ...over,
  };
}

function mkEod(id: string, date: string, entries: EODEntry[]): EODSubmission {
  return {
    id, date, storeId: S, storeName: 'Alpha', vendorId: 'v-1',
    submittedBy: '', submittedByUserId: '', timestamp: `${date}T23:00:00Z`,
    itemCount: entries.length, status: 'submitted', entries,
  };
}

const inventory: InventoryItem[] = [
  mkItem({ id: 'x', name: 'X', category: 'produce' }),
  mkItem({ id: 'y', name: 'Y', category: 'dairy' }),
];

function history(withNoNeed: boolean): EODSubmission[] {
  return [
    mkEod('s-today', TODAY, [
      mkEntry({ id: 'y1', itemId: 'y', actualRemaining: 4 }),
      ...(withNoNeed
        ? [mkEntry({ id: 'nn', itemId: 'x', actualRemaining: null, noNeed: true })]
        : []),
    ]),
    mkEod('s-prior', PRIOR, [
      mkEntry({ id: 'x0', itemId: 'x', actualRemaining: 7, date: PRIOR }),
      mkEntry({ id: 'y0', itemId: 'y', actualRemaining: 6, date: PRIOR }),
    ]),
  ];
}

function renderTab(withNoNeed: boolean, tab: string): string {
  mockState.eodSubmissions = history(withNoNeed);
  mockState.inventory = inventory;
  const r = render(<ReconciliationSection />);
  if (tab !== 'variance.tsx') fireEvent.press(screen.getByText(tab));
  const json = JSON.stringify(r.toJSON());
  r.unmount();
  return json;
}

describe('ReconciliationSection — NO NEED renders exactly like an absent entry (AC-27)', () => {
  it.each(['variance.tsx', 'byCategory.tsx', 'timeline.tsx'])('%s tab: render pair is identical', (tab) => {
    expect(renderTab(true, tab)).toBe(renderTab(false, tab));
  });

  it('variance.tsx: "items reconciled" counts numeric entries only (1 / 1, not 2 / 2)', () => {
    mockState.eodSubmissions = history(true);
    mockState.inventory = inventory;
    render(<ReconciliationSection />);
    expect(screen.getByText('1 / 1')).toBeTruthy();
    expect(screen.queryByText('2 / 2')).toBeNull();
  });
});
