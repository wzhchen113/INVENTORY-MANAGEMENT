// src/components/cmd/InventoryTable.test.tsx — Spec 112, re-pinned by spec 160.
//
// Pins the full-width operational table:
//   - AC-1 / AC-13 case 1: the operational column HEADERS render at a wide
//     (≥1400) width, and a data row renders cost + stock-value cells.
//   - spec 160 AC-13/AC-14: the RE-PRIORITIZED width-keyed collapse tiers
//     (≥1400 → all 8; 1200–1399 drop CATEGORY; <1200 floor drops category +
//     VENDOR). `lastCounted` moved to 4th and now survives every tier — the
//     old tier assertions pinned spec 112's priority order, which is exactly
//     the product fact AC-13/AC-14 changed. The table takes `width` as an
//     explicit prop, so each tier is exercised by rendering at that width
//     directly (no need to drive onLayout through the parent).
//   - spec 160 AC-7/8/9/10: the last-counted cell for counted / never /
//     LOADING, the tone grading, and the a11y long form.
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

// Spec 160 — the last-counted prop bundle. `undefined` (the default) exercises
// the AC-9 loading path, which is what every pre-existing case lands on.
const NOW = new Date('2026-08-17T12:00:00Z');
function lastCountedProp(
  byItem: Record<string, string | null>,
  loaded = true,
) {
  return {
    byItem,
    loaded,
    timezone: 'America/New_York',
    locale: 'en',
    neverLabel: 'never counted',
    loadingLabel: 'loading',
    ariaTemplate: 'last counted {date}',
    now: NOW,
  };
}

function renderTable(
  width: number,
  items: InventoryItem[] = [makeItem()],
  lastCounted?: ReturnType<typeof lastCountedProp>,
) {
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
      lastCounted={lastCounted}
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

  describe('spec 160 AC-14 — re-prioritized collapse tiers (render)', () => {
    it('≥1400 shows all 8, including last-counted and category', () => {
      renderTable(1450);
      expect(screen.getByText('last counted')).toBeTruthy();
      expect(screen.getByText('category')).toBeTruthy();
    });

    it('1200–1399 drops CATEGORY and keeps last-counted (7)', () => {
      renderTable(1250);
      expect(screen.getByText('last counted')).toBeTruthy();
      expect(screen.queryByText('category')).toBeNull();
      expect(screen.getByText('vendor')).toBeTruthy();
    });

    it('the 1100–1199 floor drops category + vendor and STILL keeps last-counted', () => {
      renderTable(1150);
      expect(screen.getByText('last counted')).toBeTruthy();
      expect(screen.queryByText('category')).toBeNull();
      expect(screen.queryByText('vendor')).toBeNull();
      // Floor survivors: name / on hand / status / last counted / cost / stock value.
      expect(screen.getByText('name')).toBeTruthy();
      expect(screen.getByText('on hand')).toBeTruthy();
      expect(screen.getByText('status')).toBeTruthy();
      expect(screen.getByText('cost / ea')).toBeTruthy();
      expect(screen.getByText('stock value')).toBeTruthy();
    });

    it('survives a pane-open width well under 1100 (the unbounded floor)', () => {
      renderTable(920);
      expect(screen.getByText('last counted')).toBeTruthy();
    });
  });

  describe('spec 160 AC-13/14 — visibleColumnsForWidth (pure)', () => {
    it('≥1400 → all 8 in the new display order', () => {
      expect(visibleColumnsForWidth(1400)).toEqual([
        'name', 'onHand', 'status', 'lastCounted', 'costEach', 'stockValue', 'vendor', 'category',
      ]);
    });
    it('1200–1399 → drop category, keep lastCounted', () => {
      expect(visibleColumnsForWidth(1399)).toEqual([
        'name', 'onHand', 'status', 'lastCounted', 'costEach', 'stockValue', 'vendor',
      ]);
      expect(visibleColumnsForWidth(1200)).toContain('lastCounted');
    });
    it('<1200 floor → drop category + vendor, keep lastCounted', () => {
      const cols = visibleColumnsForWidth(1150);
      expect(cols).not.toContain('category');
      expect(cols).not.toContain('vendor');
      expect(cols).toEqual(['name', 'onHand', 'status', 'lastCounted', 'costEach', 'stockValue']);
      expect(visibleColumnsForWidth(920)).toEqual(cols);
    });
  });

  describe('spec 160 — the last-counted cell', () => {
    // Tone math uses the INJECTED `now` (stable, pinned to NOW). The relative
    // fragment comes from the real `relativeTime()`, which anchors on the
    // system clock — so composition assertions build their fixture off
    // `Date.now()` and match a SHAPE, never a hard-coded date that would rot.
    const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const realAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
    const nowProp = (byItem: Record<string, string | null>) => ({
      ...lastCountedProp(byItem),
      now: new Date(),
    });
    const DAY = 86_400_000;

    it('AC-9 — renders `—` (never the never-counted words) while unloaded', () => {
      renderTable(1450, [makeItem()], lastCountedProp({ i1: null }, false));
      expect(screen.getByText('—')).toBeTruthy();
      expect(screen.queryByText('never counted')).toBeNull();
      // a11y announces "loading", not a bare dash.
      expect(screen.getByLabelText('loading')).toBeTruthy();
    });

    it('AC-9 — also renders `—` when the prop bundle is absent entirely', () => {
      renderTable(1450);
      expect(screen.getByText('—')).toBeTruthy();
      expect(screen.queryByText('never counted')).toBeNull();
    });

    it('AC-7 / §0.1 — renders the absolute date AND the relative age together', () => {
      renderTable(1450, [makeItem()], nowProp({ i1: realAgo(3 * DAY) }));
      // e.g. "Aug 14 · 3d" — short month + day, separator, terse age.
      expect(screen.getByText(/^[A-Za-z]{3,4}\.? \d{1,2} · 3d$/)).toBeTruthy();
    });

    it('AC-10 — the a11y label carries the LONG absolute date', () => {
      renderTable(1450, [makeItem()], nowProp({ i1: realAgo(3 * DAY) }));
      // e.g. "last counted August 14, 2026 · 3d".
      expect(screen.getByLabelText(/^last counted [A-Za-z]+ \d{1,2}, \d{4} · 3d$/)).toBeTruthy();
    });

    it('AC-5/AC-25 — a null value renders the localized never-counted words', () => {
      renderTable(1450, [makeItem()], lastCountedProp({ i1: null }));
      expect(screen.getByText('never counted')).toBeTruthy();
      expect(screen.getByLabelText('never counted')).toBeTruthy();
    });

    it('an item MISSING from the map reads as never counted once loaded', () => {
      renderTable(1450, [makeItem()], lastCountedProp({}));
      expect(screen.getByText('never counted')).toBeTruthy();
    });

    it('AC-1 — it does NOT read item.lastUpdatedAt (last EDITED)', () => {
      // lastUpdatedAt is "just now" while the true last count is 40 days old.
      // Under the old wiring the cell would read ~0s; it must read ~1mo.
      renderTable(
        1450,
        [makeItem({ lastUpdatedAt: new Date().toISOString() })],
        nowProp({ i1: realAgo(40 * DAY) }),
      );
      expect(screen.getByText(/· 1mo$/)).toBeTruthy();
    });

    it('AC-8 — grades the tone: fresh muted, stale warn, cold + never danger', () => {
      const toneOf = (iso: string | null) => {
        const { unmount } = renderTable(1450, [makeItem()], lastCountedProp({ i1: iso }));
        const node = screen.getByText(iso === null ? 'never counted' : /·/);
        const style = Array.isArray(node.props.style) ? Object.assign({}, ...node.props.style) : node.props.style;
        const color = style.color;
        unmount();
        return color;
      };
      // Palette from the mock at the top of this file.
      expect(toneOf(ago(1 * DAY))).toBe('#888888');   // fresh → C.fg3
      expect(toneOf(ago(10 * DAY))).toBe('#854F0B');  // stale → C.warn
      expect(toneOf(ago(40 * DAY))).toBe('#791F1F');  // cold  → C.danger
      expect(toneOf(null)).toBe('#791F1F');           // never → C.danger
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
