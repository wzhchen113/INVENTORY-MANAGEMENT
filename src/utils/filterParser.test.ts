// src/utils/filterParser.test.ts — Spec 160.
//
// Pins the `counted:` token added to the shared inventory filter DSL:
//   AC-15  counted:never → only never-counted rows; counted:stale → stale,
//          cold OR never ("not counted in the last 7 days, including never").
//   AC-16  counted:<anything else> matches ZERO rows and does NOT fall through
//          to a name search.
//   AC-17  the matcher never sees a threshold — it takes a tone produced by
//          countAgeTone, so the constants live in exactly one module.
//   AC-18  it ANDs with the pre-existing tokens.
//   §9.3   `countedTone === undefined` (aggregate loading / errored / not wired
//          on this surface) matches ZERO rows, not every row.
//
// The pre-existing status/category/vendor/bare-token behavior is asserted
// alongside so this file is a regression net for the whole parser, which had
// no direct coverage before.

import { parseFilter, matchesFilter } from './filterParser';
import { countAgeTone } from './countAge';
import type { InventoryItem, ItemStatus } from '../types';

const getStatus = (i: InventoryItem): ItemStatus =>
  i.currentStock <= 0 ? 'out' : i.currentStock < i.parLevel ? 'low' : 'ok';

function item(over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'i1', catalogId: 'c1', name: 'Tomato', category: 'Produce', unit: 'lb',
    costPerUnit: 1, currentStock: 5, parLevel: 10, averageDailyUsage: 1,
    safetyStock: 0, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 0,
    lastUpdatedBy: 'u1', lastUpdatedAt: '2026-07-01T00:00:00Z', eodRemaining: 0,
    storeId: 's1', casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: 'lb',
    ...over,
  } as InventoryItem;
}

describe('parseFilter', () => {
  it('maps the counted alias into the filters list, not the bare text', () => {
    expect(parseFilter('counted:never')).toEqual({
      text: [],
      filters: [{ key: 'counted', value: 'never' }],
    });
  });

  it('keeps the pre-existing aliases working alongside it', () => {
    expect(parseFilter('counted:stale cat:produce tomato')).toEqual({
      text: ['tomato'],
      filters: [
        { key: 'counted', value: 'stale' },
        { key: 'category', value: 'produce' },
      ],
    });
  });

  it('lower-cases the key and value', () => {
    expect(parseFilter('COUNTED:NEVER').filters).toEqual([{ key: 'counted', value: 'never' }]);
  });

  it('still drops an UNKNOWN key into the bare-text bucket', () => {
    expect(parseFilter('bogus:x').text).toEqual(['bogus:x']);
  });
});

describe('matchesFilter — counted: (AC-15/16/17)', () => {
  const parsedNever = parseFilter('counted:never');
  const parsedStale = parseFilter('counted:stale');

  it('counted:never admits only the `never` tone', () => {
    expect(matchesFilter(item(), parsedNever, getStatus, undefined, 'never')).toBe(true);
    expect(matchesFilter(item(), parsedNever, getStatus, undefined, 'fresh')).toBe(false);
    expect(matchesFilter(item(), parsedNever, getStatus, undefined, 'stale')).toBe(false);
    expect(matchesFilter(item(), parsedNever, getStatus, undefined, 'cold')).toBe(false);
  });

  it('counted:stale admits stale, cold AND never — everything but fresh', () => {
    expect(matchesFilter(item(), parsedStale, getStatus, undefined, 'stale')).toBe(true);
    expect(matchesFilter(item(), parsedStale, getStatus, undefined, 'cold')).toBe(true);
    expect(matchesFilter(item(), parsedStale, getStatus, undefined, 'never')).toBe(true);
    expect(matchesFilter(item(), parsedStale, getStatus, undefined, 'fresh')).toBe(false);
  });

  it('AC-16 — an unknown counted: value matches ZERO rows (no name fallthrough)', () => {
    const parsed = parseFilter('counted:tomato');
    expect(parsed.filters).toEqual([{ key: 'counted', value: 'tomato' }]);
    expect(parsed.text).toEqual([]);
    for (const tone of ['fresh', 'stale', 'cold', 'never'] as const) {
      expect(matchesFilter(item(), parsed, getStatus, undefined, tone)).toBe(false);
    }
  });

  it('§9.3 — an UNDEFINED tone (loading / errored / unwired) matches zero rows', () => {
    expect(matchesFilter(item(), parsedNever, getStatus, undefined, undefined)).toBe(false);
    expect(matchesFilter(item(), parsedStale, getStatus, undefined, undefined)).toBe(false);
  });

  it('AC-17 — the tone the matcher consumes comes from countAgeTone', () => {
    const now = new Date('2026-08-17T12:00:00Z');
    const eightDaysAgo = new Date(now.getTime() - 8 * 86_400_000).toISOString();
    const tone = countAgeTone(eightDaysAgo, now);
    expect(tone).toBe('stale');
    expect(matchesFilter(item(), parsedStale, getStatus, undefined, tone)).toBe(true);
    expect(matchesFilter(item(), parsedNever, getStatus, undefined, tone)).toBe(false);
  });

  it('AC-18 — counted: ANDs with cat: and with a bare token', () => {
    const parsed = parseFilter('counted:never cat:produce tom');
    expect(matchesFilter(item(), parsed, getStatus, 'Tomato', 'never')).toBe(true);
    // Right tone, wrong category.
    expect(matchesFilter(item({ category: 'Dairy' }), parsed, getStatus, 'Tomato', 'never')).toBe(false);
    // Right category, wrong tone.
    expect(matchesFilter(item(), parsed, getStatus, 'Tomato', 'fresh')).toBe(false);
    // Right tone + category, name misses.
    expect(matchesFilter(item({ name: 'Basil' }), parsed, getStatus, 'Basil', 'never')).toBe(false);
  });

  it('rows are unaffected by counted: when no counted token is present', () => {
    const parsed = parseFilter('cat:produce');
    expect(matchesFilter(item(), parsed, getStatus, undefined, undefined)).toBe(true);
  });
});

describe('matchesFilter — pre-existing tokens (regression net)', () => {
  it('status: matches the derived status', () => {
    const parsed = parseFilter('status:low');
    expect(matchesFilter(item({ currentStock: 5, parLevel: 10 }), parsed, getStatus)).toBe(true);
    expect(matchesFilter(item({ currentStock: 20, parLevel: 10 }), parsed, getStatus)).toBe(false);
  });

  it('vendor: substring-matches the vendor name', () => {
    const parsed = parseFilter('vendor:sys');
    expect(matchesFilter(item(), parsed, getStatus)).toBe(true);
    expect(matchesFilter(item({ vendorName: 'BJ' }), parsed, getStatus)).toBe(false);
  });

  it('a bare token substring-matches the English name', () => {
    expect(matchesFilter(item(), parseFilter('mat'), getStatus)).toBe(true);
    expect(matchesFilter(item(), parseFilter('zzz'), getStatus)).toBe(false);
  });
});
