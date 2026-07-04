// src/components/cmd/InventoryTable.test.tsx — Spec 112.
//
// Pins the full-width operational table:
//   - AC-1 / AC-13 case 1: the operational column HEADERS render at a wide
//     (≥1400) width, and a data row renders cost + stock-value cells.
//   - AC-7 / AC-13 case 7: the width-keyed column-collapse tiers
//     (≥1400 → all 8; 1200–1399 drop last-counted; 1100–1199 drop category,
//     the 6-column floor). The table takes `width` as an explicit prop, so
//     each tier is exercised by rendering at that width directly (no need to
//     drive onLayout through the parent).
//   - the ★ money cells use the itemMoney helpers (real, un-mocked) so the
//     cost/each + stock-value strings are pinned here too.
//
// Boundary mocks mirror StatusPill.test.tsx: `../../theme/colors` +
// `../../hooks/useT` so the StatusPill / StatusDot / ParBar children resolve
// without dragging the Zustand store import graph. `itemMoney` is the real
// module (the point is to pin its output).

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA',
    danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE',
    info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { InventoryTable, visibleColumnsForWidth } from './InventoryTable';
import { InventoryItem, ItemStatus, Vendor } from '../../types';

// Header labels — real English strings so we can query the DOM by them.
const LABELS = {
  name:        'name',
  onHand:      'on hand',
  status:      'status',
  costEach:    'cost / ea',
  stockValue:  'stock value',
  vendor:      'vendor',
  category:    'category',
  lastCounted: 'last counted',
};

function makeItem(over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'i1', catalogId: 'c1', name: 'Tomato', category: 'Produce', unit: 'lb',
    costPerUnit: 0.02, currentStock: 3, parLevel: 10, averageDailyUsage: 1,
    safetyStock: 0, vendorId: 'v1', vendorName: 'Acme', usagePerPortion: 0,
    lastUpdatedBy: 'u1', lastUpdatedAt: '2026-07-01T00:00:00Z', eodRemaining: 0,
    storeId: 's1', casePrice: 0, caseQty: 1, subUnitSize: 2000, subUnitUnit: 'g',
    ...over,
  } as InventoryItem;
}

const VENDORS: Vendor[] = [
  { id: 'v1', brandId: 'b1', name: 'Acme', contactName: '', phone: '', email: '',
    accountNumber: '', leadTimeDays: 1, deliveryDays: [], categories: [] },
] as unknown as Vendor[];

const getItemStatus = (it: InventoryItem): ItemStatus =>
  it.currentStock <= 0 ? 'out' : it.currentStock < it.parLevel ? 'low' : 'ok';

function renderTable(width: number, items: InventoryItem[] = [makeItem()]) {
  return render(
    <InventoryTable
      items={items}
      vendors={VENDORS}
      selectedName={null}
      onSelect={() => {}}
      width={width}
      getItemStatus={getItemStatus}
      displayName={(it) => it.name}
      labels={LABELS}
    />,
  );
}

describe('InventoryTable (spec 112)', () => {
  describe('AC-1 — operational columns at a wide (≥1400) width', () => {
    it('renders all 8 column headers', () => {
      renderTable(1600);
      for (const label of Object.values(LABELS)) {
        expect(screen.getByText(label)).toBeTruthy();
      }
    });

    it('renders the ★ cost/each + stock-value cells for a data row', () => {
      renderTable(1600);
      // formatCostPerEach → "$0.02"; the " /g" label is a sibling Text.
      expect(screen.getByText('$0.02')).toBeTruthy();
      // formatStockValue → 3 × 0.02 × 2000 = "$120".
      expect(screen.getByText('$120')).toBeTruthy();
      // vendor lookup by id.
      expect(screen.getByText('Acme')).toBeTruthy();
    });
  });

  describe('AC-7 — width-keyed column collapse tiers (render)', () => {
    it('≥1400 shows last-counted (all 8)', () => {
      renderTable(1450);
      expect(screen.getByText('last counted')).toBeTruthy();
      expect(screen.getByText('category')).toBeTruthy();
    });

    it('1200–1399 drops last-counted, keeps category (7)', () => {
      renderTable(1250);
      expect(screen.queryByText('last counted')).toBeNull();
      expect(screen.getByText('category')).toBeTruthy();
      expect(screen.getByText('vendor')).toBeTruthy();
    });

    it('1100–1199 drops category, keeps the 6-column floor', () => {
      renderTable(1150);
      expect(screen.queryByText('last counted')).toBeNull();
      expect(screen.queryByText('category')).toBeNull();
      // Floor survivors: name / on hand / status / cost / stock value / vendor.
      expect(screen.getByText('name')).toBeTruthy();
      expect(screen.getByText('on hand')).toBeTruthy();
      expect(screen.getByText('status')).toBeTruthy();
      expect(screen.getByText('cost / ea')).toBeTruthy();
      expect(screen.getByText('stock value')).toBeTruthy();
      expect(screen.getByText('vendor')).toBeTruthy();
    });
  });

  describe('AC-7 — visibleColumnsForWidth (pure)', () => {
    it('≥1400 → all 8 in order', () => {
      expect(visibleColumnsForWidth(1400)).toEqual([
        'name', 'onHand', 'status', 'costEach', 'stockValue', 'vendor', 'category', 'lastCounted',
      ]);
    });
    it('1200–1399 → drop lastCounted', () => {
      expect(visibleColumnsForWidth(1399)).not.toContain('lastCounted');
      expect(visibleColumnsForWidth(1200)).toContain('category');
    });
    it('1100–1199 → drop lastCounted + category (floor)', () => {
      const cols = visibleColumnsForWidth(1150);
      expect(cols).not.toContain('lastCounted');
      expect(cols).not.toContain('category');
      expect(cols).toEqual(['name', 'onHand', 'status', 'costEach', 'stockValue', 'vendor']);
    });
  });

  describe('row press + selection a11y', () => {
    it('fires onSelect with the lowercased name on row press', () => {
      const onSelect = jest.fn();
      render(
        <InventoryTable
          items={[makeItem()]}
          vendors={VENDORS}
          selectedName={null}
          onSelect={onSelect}
          width={1600}
          getItemStatus={getItemStatus}
          displayName={(it) => it.name}
          labels={LABELS}
        />,
      );
      fireEvent.press(screen.getByText('Tomato'));
      expect(onSelect).toHaveBeenCalledWith('tomato');
    });
  });
});
