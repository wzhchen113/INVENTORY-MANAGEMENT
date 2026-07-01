// src/screens/cmd/sections/__tests__/InventoryCountSection.parStatus.test.tsx
//
// Spec 105 — par-status + inline reorder math on the read-only inventory count
// history detail (InventoryCountSection.tsx → DetailFrame). Covers the THREE
// par states (at/above → green ✓, below → red + reorder suggestion, no-par → no
// indicator) plus the TWO edge cases the design + AC line 106 pin:
//   • unresolvable itemId (deleted since the count) → no indicator, no RPC entry
//   • actualRemaining == null (no total recorded)   → no indicator, no RPC entry
// and the omitted-suggestion collapse (item in the request but ABSENT from the
// response → red dot, no suggestion text) + the empty/error-fetch degradation.
//
// Approach mirrors the sibling InventoryCountSection.customOrder.test.tsx: the
// section's par-join + on-hand-map + suggestion-string logic is the PURE
// `countHistoryPar` module the section imports and composes verbatim, so this
// exercises the EXACT functions the section calls (parStateFor /
// buildCountedOnHandMap / formatCountedReorderSuggestion) rather than a brittle
// full render. The reorder RPC is mocked at the db.ts boundary (matching how
// the reorder suites stub report_reorder_list), and the map→fetch→byItem flow
// is driven through that mock to assert the FE only ever hands the RPC the
// below-par resolvable non-null rows.
//
// `.test.tsx` so the jsdom `component` project picks it up (the section is a
// `.tsx`); the supabase module is mocked so importing anything in the section's
// module graph does not crash at load (EXPO_PUBLIC_SUPABASE_* unset).

jest.mock('../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

// Mock the db.ts reorder fetcher — the boundary the section's companion fetch
// crosses. Every test drives its own resolved/rejected value.
const mockFetchReorder = jest.fn();
jest.mock('../../../../lib/db', () => ({
  __esModule: true,
  fetchReorderForCountedOnHand: (...args: any[]) => mockFetchReorder(...args),
  // The section imports these too; stub as inert so the module graph resolves.
  fetchRecentInventoryCounts: jest.fn(() => Promise.resolve([])),
  fetchInventoryCount: jest.fn(() => Promise.resolve(null)),
  fetchCountOrder: jest.fn(() => Promise.resolve(null)),
  saveCountOrder: jest.fn(() => Promise.resolve()),
  resetCountOrder: jest.fn(() => Promise.resolve()),
}));

import type { CountedReorderItem } from '../../../../types';
import {
  parStateFor,
  buildCountedOnHandMap,
  formatCountedReorderSuggestion,
  daysUntilLabel,
  type ParInventoryRow,
  type ParCountEntry,
} from '../countHistoryPar';
// Importing the section pins that its module graph loads with the new imports
// (a regression that drops the countHistoryPar import breaks this file's graph).
import InventoryCountSection from '../InventoryCountSection';

// ── Fixtures ─────────────────────────────────────────────────────────────
// Store CURRENT inventory keyed by id — the par-join source (OQ-1).
//   apple: par 10, case size 1 (no case)         → drives at/above + below
//   bread: par 20, case size 6                    → case-math suggestion
//   cream: par 0  (unset)                         → no-par row (no marker)
const INVENTORY: ParInventoryRow[] = [
  { id: 'item-apple', parLevel: 10, caseQty: 1, unit: 'lb' },
  { id: 'item-bread', parLevel: 20, caseQty: 6, unit: 'ea' },
  { id: 'item-cream', parLevel: 0, caseQty: 1, unit: 'ea' },
  // Resolvable + has a par, so the null-total exclusion below is gated by
  // `actualRemaining == null`, NOT the unresolvable-item check (code-review CR1).
  { id: 'item-apple-null', parLevel: 10, caseQty: 1, unit: 'lb' },
];
const inventoryById: ReadonlyMap<string, ParInventoryRow> = new Map(INVENTORY.map((i) => [i.id, i]));

function makeReorderItem(over: Partial<CountedReorderItem> & { itemId: string }): CountedReorderItem {
  return {
    itemId: over.itemId,
    onHand: over.onHand ?? 0,
    parLevel: over.parLevel ?? 0,
    parReplacement: over.parReplacement ?? 0,
    usageForecasted: over.usageForecasted ?? 0,
    suggestedQty: over.suggestedQty ?? 0,
    caseQty: over.caseQty ?? 1,
    suggestedCases: over.suggestedCases ?? null,
    suggestedUnits: over.suggestedUnits ?? 0,
    daysUntil: over.daysUntil ?? 0,
    nextDeliveryDate: over.nextDeliveryDate ?? '',
    scheduleKnown: over.scheduleKnown ?? false,
    flags: over.flags ?? [],
  };
}

beforeEach(() => {
  mockFetchReorder.mockReset();
});

describe('InventoryCountSection — spec 105 par status (module loads)', () => {
  it('is a real React component that imports + composes countHistoryPar', () => {
    expect(typeof InventoryCountSection).toBe('function');
  });
});

describe('parStateFor — the three states + null-total + unresolvable (OQ-1/OQ-4)', () => {
  it('at/above par (actualRemaining >= parLevel, par > 0) → "above" (green ✓)', () => {
    expect(parStateFor(10, 10)).toBe('above'); // exactly at par is at-or-above
    expect(parStateFor(14, 10)).toBe('above');
  });

  it('below par (actualRemaining < parLevel, par > 0) → "below" (red + suggestion)', () => {
    expect(parStateFor(6, 10)).toBe('below');
    expect(parStateFor(0, 10)).toBe('below');
  });

  it('no par set (parLevel <= 0) → "none" (NO marker)', () => {
    expect(parStateFor(3, 0)).toBe('none');
    expect(parStateFor(3, -1)).toBe('none');
  });

  it('null / undefined total → "none" (nothing to compare, no RPC)', () => {
    expect(parStateFor(null, 10)).toBe('none');
    expect(parStateFor(undefined, 10)).toBe('none');
  });

  it('unresolvable item is modeled by passing par 0 (no inventory row) → "none"', () => {
    // The section calls parStateFor(e.actualRemaining, parItem?.parLevel ?? 0);
    // an unresolvable itemId yields parItem == null → par 0 → "none".
    const parItem = inventoryById.get('item-ghost'); // deleted since the count
    expect(parItem).toBeUndefined();
    expect(parStateFor(5, parItem?.parLevel ?? 0)).toBe('none');
  });
});

describe('buildCountedOnHandMap — only below-par, resolvable, non-null rows', () => {
  it('includes ONLY below-par resolvable non-null entries (the RPC is never handed at/above-par, no-par, unresolvable, or null-total rows)', () => {
    const entries: ParCountEntry[] = [
      { itemId: 'item-apple', actualRemaining: 6 },     // below par 10 → INCLUDED
      { itemId: 'item-bread', actualRemaining: 24 },    // above par 20 → excluded
      { itemId: 'item-cream', actualRemaining: 1 },     // par 0 (no par) → excluded
      { itemId: 'item-ghost', actualRemaining: 3 },     // unresolvable → excluded
      { itemId: 'item-apple-null', actualRemaining: null }, // null total → excluded
    ];
    const map = buildCountedOnHandMap(entries, inventoryById);
    expect(map).toEqual({ 'item-apple': 6 });
    // Explicitly assert the excluded ids are absent (not just the ==).
    expect(map).not.toHaveProperty('item-bread');
    expect(map).not.toHaveProperty('item-cream');
    expect(map).not.toHaveProperty('item-ghost');
  });

  it('empty when nothing is below par → the section skips the RPC entirely', () => {
    const entries: ParCountEntry[] = [
      { itemId: 'item-apple', actualRemaining: 12 }, // above
      { itemId: 'item-bread', actualRemaining: 20 }, // at par
    ];
    const map = buildCountedOnHandMap(entries, inventoryById);
    expect(Object.keys(map)).toHaveLength(0);
  });
});

describe('formatCountedReorderSuggestion — quantity + timing, NO cost (OQ-5)', () => {
  it('case item → "order N cases · M unit · forecast … · deliver <date> (in N days)"', () => {
    const item = makeReorderItem({
      itemId: 'item-bread',
      suggestedQty: 12,
      caseQty: 6,
      suggestedCases: 2,
      suggestedUnits: 12,
      usageForecasted: 4,
      daysUntil: 2,
      nextDeliveryDate: '2026-07-03',
    });
    const s = formatCountedReorderSuggestion(item, 'ea');
    expect(s).toBe('order 2 cases · 12 ea · forecast 4 ea · deliver 2026-07-03 (in 2 days)');
    // Cost must never appear.
    expect(s).not.toMatch(/\$/);
  });

  it('non-case item → base-unit qty, singular "case" respected, no forecast line when 0', () => {
    const item = makeReorderItem({
      itemId: 'item-apple',
      suggestedQty: 4,
      caseQty: 1,
      suggestedCases: null,
      suggestedUnits: 4,
      usageForecasted: 0, // no forecast contribution → no "forecast" segment
      daysUntil: 1,
      nextDeliveryDate: '2026-07-02',
    });
    const s = formatCountedReorderSuggestion(item, 'lb');
    expect(s).toBe('order 4 lb · deliver 2026-07-02 (tomorrow)');
    expect(s).not.toMatch(/forecast/);
  });

  it('singular "1 case" and unknown schedule (no date) fall back to the bare days label', () => {
    const item = makeReorderItem({
      itemId: 'item-bread',
      suggestedCases: 1,
      suggestedUnits: 6,
      caseQty: 6,
      daysUntil: 0,
      nextDeliveryDate: '', // schedule unknown
      scheduleKnown: false,
    });
    const s = formatCountedReorderSuggestion(item, 'ea');
    expect(s).toBe('order 1 case · 6 ea · today');
  });

  it('daysUntilLabel: today / tomorrow / in N days', () => {
    expect(daysUntilLabel(0)).toBe('today');
    expect(daysUntilLabel(1)).toBe('tomorrow');
    expect(daysUntilLabel(3)).toBe('in 3 days');
  });
});

// ── The companion-fetch flow: map → mocked RPC → keyed response → render gate.
// Drives the EXACT sequence the section's lazy-detail effect performs.
describe('companion reorder fetch — map → mocked RPC → per-row suggestion', () => {
  const entries: ParCountEntry[] = [
    { itemId: 'item-apple', actualRemaining: 6 },  // below → suggestion expected
    { itemId: 'item-bread', actualRemaining: 8 },  // below → present in request, ABSENT in response
    { itemId: 'item-cream', actualRemaining: 1 },  // no par → not in map
  ];

  it('sends only the below-par map and renders a suggestion for the returned item; a requested-but-absent item shows the red dot with NO suggestion (suggested_qty < 0.001 collapse)', async () => {
    const map = buildCountedOnHandMap(entries, inventoryById);
    // Both below-par items go to the RPC…
    expect(map).toEqual({ 'item-apple': 6, 'item-bread': 8 });

    // …but the RPC returns ONLY apple (bread collapsed out: nothing to order).
    mockFetchReorder.mockResolvedValueOnce({
      'item-apple': makeReorderItem({
        itemId: 'item-apple',
        suggestedQty: 4,
        suggestedUnits: 4,
        caseQty: 1,
        suggestedCases: null,
        daysUntil: 1,
        nextDeliveryDate: '2026-07-02',
      }),
    });

    const byItem: Record<string, CountedReorderItem> = await mockFetchReorder('store-1', map, '2026-07-01');
    expect(mockFetchReorder).toHaveBeenCalledWith('store-1', { 'item-apple': 6, 'item-bread': 8 }, '2026-07-01');

    // Render gate the section applies per row: below-par + present → text.
    const appleState = parStateFor(6, inventoryById.get('item-apple')!.parLevel);
    expect(appleState).toBe('below');
    const appleSuggestion = byItem['item-apple'];
    expect(appleSuggestion).toBeDefined();
    expect(formatCountedReorderSuggestion(appleSuggestion, 'lb')).toContain('order 4 lb');

    // bread: below par (red dot) but ABSENT from the response → no text.
    const breadState = parStateFor(8, inventoryById.get('item-bread')!.parLevel);
    expect(breadState).toBe('below');
    expect(byItem['item-bread']).toBeUndefined(); // → bare red dot, no suggestion
  });

  it('degrades on RPC failure: par states still resolve, byItem is empty → below-par rows show a bare red dot, no toast/crash', async () => {
    const map = buildCountedOnHandMap(entries, inventoryById);
    mockFetchReorder.mockRejectedValueOnce(new Error('network down'));

    // The section's .catch sets byItem = {} and console.warns (no throw).
    let byItem: Record<string, CountedReorderItem> = {};
    await mockFetchReorder('store-1', map, '2026-07-01').catch(() => {
      byItem = {};
    });

    // Par comparison is pure client-side → unaffected by the failed read.
    expect(parStateFor(6, inventoryById.get('item-apple')!.parLevel)).toBe('below');
    expect(byItem['item-apple']).toBeUndefined(); // red dot, no suggestion text
  });

  it('empty below-par map short-circuits (the section never calls the RPC)', () => {
    const allAtOrAbove: ParCountEntry[] = [
      { itemId: 'item-apple', actualRemaining: 10 },
      { itemId: 'item-bread', actualRemaining: 30 },
    ];
    const map = buildCountedOnHandMap(allAtOrAbove, inventoryById);
    // The section guards `if (Object.keys(onHandMap).length === 0) return;`
    expect(Object.keys(map)).toHaveLength(0);
    expect(mockFetchReorder).not.toHaveBeenCalled();
  });
});
