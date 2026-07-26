// src/screens/cmd/lib/inventoryStatusView.test.ts
//
// Pins the items.tsv stock-status quick-filter helper: per-status chip counts,
// status narrowing, and the urgency-first (out → low → ok) then-name sort.

import { applyInventoryStatusView } from './inventoryStatusView';
import type { ItemStatus } from '../../../types';

interface Row { name: string; status: ItemStatus }
const rows: Row[] = [
  { name: 'Zucchini', status: 'ok' },
  { name: 'Apples', status: 'out' },
  { name: 'Milk', status: 'low' },
  { name: 'Bread', status: 'out' },
  { name: 'Cheese', status: 'ok' },
];
const getStatus = (r: Row) => r.status;
const nameOf = (r: Row) => r.name;

describe('applyInventoryStatusView', () => {
  it('counts every status over ALL input rows, regardless of the active filter', () => {
    const { counts } = applyInventoryStatusView(rows, getStatus, 'out', nameOf, 'en');
    // Counts do not change when a chip is active (they read the full set).
    expect(counts).toEqual({ out: 2, low: 1, ok: 2 });
  });

  it('with no status filter, sorts by urgency (out → low → ok) then by name', () => {
    const { items } = applyInventoryStatusView(rows, getStatus, null, nameOf, 'en');
    expect(items.map((r) => r.name)).toEqual([
      // out first (alpha within): Apples, Bread
      'Apples', 'Bread',
      // then low: Milk
      'Milk',
      // then ok (alpha within): Cheese, Zucchini
      'Cheese', 'Zucchini',
    ]);
  });

  it('narrows to a single status when a chip is active, keeping the name sort', () => {
    const { items } = applyInventoryStatusView(rows, getStatus, 'out', nameOf, 'en');
    expect(items.map((r) => r.name)).toEqual(['Apples', 'Bread']);
    expect(items.every((r) => r.status === 'out')).toBe(true);
  });

  it('does not mutate the input array', () => {
    const snapshot = rows.map((r) => r.name);
    applyInventoryStatusView(rows, getStatus, null, nameOf, 'en');
    expect(rows.map((r) => r.name)).toEqual(snapshot);
  });

  it('handles an empty input (zero counts, empty list)', () => {
    const { counts, items } = applyInventoryStatusView([], getStatus, null, nameOf, 'en');
    expect(counts).toEqual({ out: 0, low: 0, ok: 0 });
    expect(items).toEqual([]);
  });
});
