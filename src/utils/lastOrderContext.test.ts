// src/utils/lastOrderContext.test.ts — spec 151 (AC-27).
//
// The PURE formatter suite. Nothing is mounted; nothing is mocked. Every claim
// the three ordering surfaces make about "last time" is decided here, so this
// is the file a reviewer reads to check the honesty rule (AC-10) holds.
//
// Coverage map (spec §10 jest bullet):
//   - the four AC-2 anchor tiers as fixtures + the confidence qualifier (AC-3)
//   - case vs. unit rendering from one base number (AC-4, read per R-H)
//   - exact fractional rendering (no rounding)
//   - counted-missing (AC-7) / item-not-on-order (AC-8) / R-I's fourth variant
//   - the AC-9 card-level empty state + R-G's tri-state 'hidden'
//   - delta up / down / same (AC-11)
//   - delta suppression on onHandSource 'stock' (AC-12) and on the row-grain
//     `eod_missing_for_item` flag (R-F)
//   - R-10: `0` and `null` are DIFFERENT and distinguishable
//   - R-4: the documented case-size drift
//   - catalog binding: every i18n key this module (and the two tiers) hard-code
//     exists in en / es / zh-CN (architect review M-2)

import {
  buildLastOrderContext,
  lastOrderCardState,
  lastOrderSentence,
  lastOrderDeltaText,
  formatLastOrderDate,
  type LastOrderLine,
} from './lastOrderContext';
import { formatQty } from './formatQty';
import enCatalog from '../i18n/en.json';
import esCatalog from '../i18n/es.json';
import zhCatalog from '../i18n/zh-CN.json';
import type { LastOrderContextVendor, LastOrderContextItem } from '../types';

// ── fixtures ────────────────────────────────────────────────────────────────

function ctxItem(over: Partial<LastOrderContextItem> & { itemId: string }): LastOrderContextItem {
  return { orderedQtyBase: null, countedQtyBase: null, ...over };
}

function ctxVendor(over: Partial<LastOrderContextVendor> = {}): LastOrderContextVendor {
  return {
    vendorId: 'v-1',
    lastOrderDate: '2026-07-29',
    confidence: 'placed',
    source: 'purchase_order',
    sourceId: 'po-1',
    countedDate: '2026-07-29',
    itemsTruncated: false,
    items: {},
    ...over,
  };
}

/** The four AC-2 anchor tiers as they arrive at the FE: the tier itself is a
 *  server decision, but the (confidence, source) pair it produces is what the
 *  formatter renders, so the FE contract is pinned per tier here. */
const ANCHOR_TIERS = [
  { tier: 1, label: 'sent/partial/received PO', confidence: 'placed', source: 'purchase_order' },
  { tier: 2, label: "'ordered' approval", confidence: 'placed', source: 'order_approval' },
  { tier: 3, label: "'approved' approval", confidence: 'recorded', source: 'order_approval' },
  { tier: 4, label: "'draft' PO", confidence: 'recorded', source: 'purchase_order' },
] as const;

function item(over: Record<string, unknown> = {}) {
  return {
    itemId: 'i-1',
    caseQty: 6,
    unit: 'lb',
    onHand: 0,
    flags: [] as string[],
    ...over,
  };
}

function line(l: LastOrderLine) {
  if (l.kind !== 'line') throw new Error(`expected a line, got ${l.kind}`);
  return l;
}

/** Render the composed sentence exactly as a tier would (single template per
 *  variant — AC-26; the tier never `+`-joins localized fragments). */
const EN: Record<string, string> = {
  'section.reorder.lastOrderFull': 'LAST {date} · COUNTED {counted} · ORDERED {ordered}',
  'section.reorder.lastOrderNoCounted': 'LAST {date} · ORDERED {ordered}',
  'section.reorder.lastOrderNotOrdered': 'LAST {date} · COUNTED {counted} · NOT ORDERED',
  'section.reorder.lastOrderNotOrderedNoCounted': 'LAST {date} · NOT ORDERED',
  'section.reorder.lastOrderDeltaUp': '▲ +{qty}',
  'section.reorder.lastOrderDeltaDown': '▼ −{qty}',
  'section.reorder.lastOrderDeltaSame': 'SAME AS LAST COUNT',
};
function renderSentence(l: LastOrderLine): string {
  const s = lastOrderSentence(line(l), formatLastOrderDate, formatQty);
  return Object.entries(s.vars).reduce(
    (acc, [k, v]) => acc.replace(`{${k}}`, v),
    EN[s.key],
  );
}
function renderDelta(l: LastOrderLine): string | null {
  const d = lastOrderDeltaText(line(l).delta, formatQty);
  if (!d) return null;
  return Object.entries(d.vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), EN[d.key]);
}

// ── AC-9 / R-G — the tri-state ──────────────────────────────────────────────

describe('lastOrderCardState — R-G tri-state', () => {
  it("null context (NOT LOADED / failed) is 'hidden', never 'empty'", () => {
    // The whole point of R-G: a loading window must not claim NO PRIOR ORDER
    // ON RECORD, which would be a lie AND an AC-17 layout shift.
    expect(lastOrderCardState(null, 'v-1')).toBe('hidden');
  });

  it("loaded-but-vendor-absent is 'empty' (AC-9's card-level line)", () => {
    expect(lastOrderCardState({}, 'v-1')).toBe('empty');
    expect(lastOrderCardState({ 'v-2': ctxVendor({ vendorId: 'v-2' }) }, 'v-1')).toBe('empty');
  });

  it("loaded-with-anchor is 'present'", () => {
    expect(lastOrderCardState({ 'v-1': ctxVendor() }, 'v-1')).toBe('present');
  });
});

describe('buildLastOrderContext — no vendor context', () => {
  it('returns { kind: "none" } so NOTHING renders (AC-17)', () => {
    const out = buildLastOrderContext({
      item: item(),
      vendorContext: null,
      onHandSource: 'eod',
    });
    expect(out).toEqual({ kind: 'none' });
  });
});

// ── AC-2 / AC-3 — anchor tiers and the confidence qualifier ─────────────────

describe('AC-2 tiers → AC-3 confidence qualifier', () => {
  it.each(ANCHOR_TIERS)(
    'tier $tier ($label) → notConfirmed=$confidence',
    ({ confidence, source }) => {
      const out = buildLastOrderContext({
        item: item(),
        vendorContext: ctxVendor({
          confidence,
          source,
          items: { 'i-1': ctxItem({ itemId: 'i-1', orderedQtyBase: 78, countedQtyBase: 30 }) },
        }),
        onHandSource: 'eod',
      });
      // 'placed' → no qualifier; 'recorded' → NOT CONFIRMED.
      expect(line(out).notConfirmed).toBe(confidence === 'recorded');
      // The qualifier never changes the numbers themselves.
      expect(renderSentence(out)).toBe('LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS');
    },
  );
});

// ── AC-4 / R-H — case vs. unit rendering ────────────────────────────────────

describe('AC-4 unit rendering (R-H: one base value through both branches)', () => {
  it('caseQty 6, base 78 → "13 CS"', () => {
    const out = buildLastOrderContext({
      item: item({ caseQty: 6, unit: 'lb' }),
      vendorContext: ctxVendor({
        items: { 'i-1': ctxItem({ itemId: 'i-1', orderedQtyBase: 78, countedQtyBase: null }) },
      }),
      onHandSource: 'eod',
    });
    expect(line(out).ordered).toEqual({ value: 13, unitLabel: 'CS' });
    expect(renderSentence(out)).toBe('LAST JUL 29 · ORDERED 13 CS');
  });

  it('caseQty 1, base 13 → "13 lb" (the item\'s own unit, not CS)', () => {
    const out = buildLastOrderContext({
      item: item({ caseQty: 1, unit: 'lb' }),
      vendorContext: ctxVendor({
        items: { 'i-1': ctxItem({ itemId: 'i-1', orderedQtyBase: 13, countedQtyBase: null }) },
      }),
      onHandSource: 'eod',
    });
    expect(line(out).ordered).toEqual({ value: 13, unitLabel: 'lb' });
    expect(renderSentence(out)).toBe('LAST JUL 29 · ORDERED 13 lb');
  });

  it('is EXACT, not rounded: base 85 / caseQty 6 → 14.17 CS', () => {
    const out = buildLastOrderContext({
      item: item({ caseQty: 6 }),
      vendorContext: ctxVendor({
        items: { 'i-1': ctxItem({ itemId: 'i-1', orderedQtyBase: 85 }) },
      }),
      onHandSource: 'eod',
    });
    expect(line(out).ordered!.value).toBeCloseTo(85 / 6, 10);
    expect(renderSentence(out)).toBe('LAST JUL 29 · ORDERED 14.17 CS');
  });

  it('R-4 (documented, not hidden) — case-size drift renders in TODAY\'s caseQty', () => {
    // The anchor order was placed when the item shipped 6/case; the catalog now
    // says 12/case. 78 base was "13 cases" then and renders "6.5 CS" now.
    // po_items has no case_qty column, so per-era rendering is impossible for
    // PO-sourced anchors — a uniform current-caseQty basis is the honest
    // trade, and the date is always shown so the reference is self-evident.
    const out = buildLastOrderContext({
      item: item({ caseQty: 12 }),
      vendorContext: ctxVendor({
        items: { 'i-1': ctxItem({ itemId: 'i-1', orderedQtyBase: 78 }) },
      }),
      onHandSource: 'eod',
    });
    expect(renderSentence(out)).toBe('LAST JUL 29 · ORDERED 6.5 CS');
  });
});

// ── AC-1 / AC-7 / AC-8 / R-I — the four sentence variants ───────────────────

describe('sentence variants (AC-1 / AC-7 / AC-8 / R-I)', () => {
  const withEntry = (e: Partial<LastOrderContextItem>) =>
    buildLastOrderContext({
      item: item({ caseQty: 6 }),
      vendorContext: ctxVendor({ items: { 'i-1': ctxItem({ itemId: 'i-1', ...e }) } }),
      onHandSource: 'eod',
    });

  it('AC-1 — both figures present → the full line', () => {
    expect(renderSentence(withEntry({ orderedQtyBase: 78, countedQtyBase: 30 })))
      .toBe('LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS');
  });

  it('AC-7 — counted missing → the COUNTED clause is OMITTED (no 0, no —)', () => {
    const out = withEntry({ orderedQtyBase: 78, countedQtyBase: null });
    expect(line(out).counted).toBeNull();
    const s = renderSentence(out);
    expect(s).toBe('LAST JUL 29 · ORDERED 13 CS');
    expect(s).not.toMatch(/COUNTED/);
  });

  it('AC-8 — item not on the anchor order → NOT ORDERED (never "ORDERED 0")', () => {
    const out = withEntry({ orderedQtyBase: null, countedQtyBase: 30 });
    expect(line(out).ordered).toBeNull();
    expect(renderSentence(out)).toBe('LAST JUL 29 · COUNTED 5 CS · NOT ORDERED');
  });

  it('R-I — item on neither the order nor the count → the anchored short form', () => {
    // The entry is absent entirely (not just null-valued).
    const out = buildLastOrderContext({
      item: item({ itemId: 'i-missing', caseQty: 6 }),
      vendorContext: ctxVendor({
        items: { 'i-1': ctxItem({ itemId: 'i-1', orderedQtyBase: 78 }) },
      }),
      onHandSource: 'eod',
    });
    expect(line(out).counted).toBeNull();
    expect(line(out).ordered).toBeNull();
    // Still ANCHORED — the date is rendered, so the NOT ORDERED claim is a
    // statement about an identified order (design guidance 7).
    expect(renderSentence(out)).toBe('LAST JUL 29 · NOT ORDERED');
  });

  it('R-10 — `0` and `null` are DIFFERENT and distinguishable', () => {
    const zero = withEntry({ orderedQtyBase: 0, countedQtyBase: 0 });
    const nul = withEntry({ orderedQtyBase: null, countedQtyBase: null });
    expect(line(zero).ordered).toEqual({ value: 0, unitLabel: 'CS' });
    expect(line(zero).counted).toEqual({ value: 0, unitLabel: 'CS' });
    expect(renderSentence(zero)).toBe('LAST JUL 29 · COUNTED 0 CS · ORDERED 0 CS');
    expect(renderSentence(nul)).toBe('LAST JUL 29 · NOT ORDERED');
    expect(renderSentence(zero)).not.toBe(renderSentence(nul));
  });
});

// ── AC-11 / AC-12 / R-F — the trend marker ─────────────────────────────────

describe('AC-11 delta', () => {
  const withOnHand = (onHand: number, countedQtyBase: number, over: Record<string, unknown> = {}) =>
    buildLastOrderContext({
      item: item({ caseQty: 6, onHand, ...over }),
      vendorContext: ctxVendor({
        items: { 'i-1': ctxItem({ itemId: 'i-1', orderedQtyBase: 78, countedQtyBase }) },
      }),
      onHandSource: (over.onHandSource as 'eod' | 'stock') ?? 'eod',
    });

  it('▲ up when MORE stock is on hand than at the anchor count (slower week)', () => {
    // 48 base on hand vs 30 counted then → +18 base = +3 cases.
    const out = withOnHand(48, 30);
    expect(line(out).delta).toEqual({ direction: 'up', value: 3, unitLabel: 'CS' });
    expect(renderDelta(out)).toBe('▲ +3 CS');
  });

  it('▼ down when LESS stock is on hand, with the value ABSOLUTE', () => {
    const out = withOnHand(12, 30);
    expect(line(out).delta).toEqual({ direction: 'down', value: 3, unitLabel: 'CS' });
    expect(renderDelta(out)).toBe('▼ −3 CS');
  });

  it('"same" when the delta rounds below formatQty resolution', () => {
    const out = withOnHand(30.001, 30);
    expect(line(out).delta!.direction).toBe('same');
    expect(renderDelta(out)).toBe('SAME AS LAST COUNT');
  });

  it('renders in the item\'s own unit for a non-case row', () => {
    const out = buildLastOrderContext({
      item: item({ caseQty: 1, unit: 'lb', onHand: 9 }),
      vendorContext: ctxVendor({
        items: { 'i-1': ctxItem({ itemId: 'i-1', orderedQtyBase: 13, countedQtyBase: 4 }) },
      }),
      onHandSource: 'eod',
    });
    expect(renderDelta(out)).toBe('▲ +5 lb');
  });

  it('AC-12 — SUPPRESSED when the vendor fell back to stock', () => {
    const out = withOnHand(48, 30, { onHandSource: 'stock' });
    // The context line itself still renders — only the marker is suppressed.
    expect(line(out).delta).toBeNull();
    expect(renderSentence(out)).toBe('LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS');
    expect(renderDelta(out)).toBeNull();
  });

  it('R-F — SUPPRESSED at ROW grain when this row carries eod_missing_for_item', () => {
    // The vendor rolled up to 'eod' but THIS row fell back to current_stock —
    // comparing that estimate to a real physical count is the same fabricate
    // trap AC-12 forbids, one grain finer.
    const out = withOnHand(48, 30, { flags: ['eod_missing_for_item'] });
    expect(line(out).delta).toBeNull();
    expect(renderDelta(out)).toBeNull();
  });

  it('an unrelated flag does NOT suppress the marker', () => {
    const out = withOnHand(48, 30, { flags: ['no_par', 'truncated'] });
    expect(line(out).delta).toEqual({ direction: 'up', value: 3, unitLabel: 'CS' });
  });

  it('no delta without a counted figure (AC-7 rows)', () => {
    const out = buildLastOrderContext({
      item: item({ caseQty: 6, onHand: 48 }),
      vendorContext: ctxVendor({
        items: { 'i-1': ctxItem({ itemId: 'i-1', orderedQtyBase: 78, countedQtyBase: null }) },
      }),
      onHandSource: 'eod',
    });
    expect(line(out).delta).toBeNull();
  });

  it('a counted ZERO still produces a delta (0 is a real count, R-10)', () => {
    const out = withOnHand(12, 0);
    expect(line(out).delta).toEqual({ direction: 'up', value: 2, unitLabel: 'CS' });
  });
});

// ── AC-10 — the honesty rule ────────────────────────────────────────────────

describe('AC-10 — never fabricate', () => {
  it('ignores every suggestion/par field even when they are present on the item', () => {
    // The Pick<> makes this unreachable at the type level; this pins the
    // RUNTIME behavior too, so a future widening of the signature fails here.
    const out = buildLastOrderContext({
      item: item({
        caseQty: 6,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ suggestedUnits: 999, suggestedQty: 999, parLevel: 999, pendingPoQty: 999 } as any),
      }),
      vendorContext: ctxVendor({ items: {} }),
      onHandSource: 'eod',
    });
    expect(line(out).ordered).toBeNull();
    expect(renderSentence(out)).toBe('LAST JUL 29 · NOT ORDERED');
    expect(JSON.stringify(out)).not.toContain('999');
  });
});

// ── date rendering ──────────────────────────────────────────────────────────

describe('formatLastOrderDate', () => {
  it('renders the short form without a timezone day shift', () => {
    expect(formatLastOrderDate('2026-07-29')).toBe('JUL 29');
    expect(formatLastOrderDate('2026-01-01')).toBe('JAN 1');
    expect(formatLastOrderDate('2026-12-31')).toBe('DEC 31');
  });

  it('tolerates a timestamp suffix and degrades gracefully on garbage', () => {
    expect(formatLastOrderDate('2026-07-29T00:00:00+00:00')).toBe('JUL 29');
    expect(formatLastOrderDate('')).toBe('');
    expect(formatLastOrderDate('nope')).toBe('nope');
  });
});

// ── catalog binding (architect review M-2) ──────────────────────────────────
//
// The module hard-codes its i18n keys as string-literal unions, which is a typo
// guard WITHIN the module but proves nothing about the catalogs. Neither the
// unit suite above (it renders through a LOCAL copy of the templates) nor the
// i18n parity test (it only compares the three catalogs to EACH OTHER) would
// notice a rename in en/es/zh-CN: `t()` would silently fall back to returning
// the raw key, and the ordering screens would render the literal text
// `section.reorder.lastOrderFull`. This case closes that gap.

describe('M-2 — every hard-coded i18n key exists in ALL THREE catalogs', () => {
  const CATALOGS: Array<[string, Record<string, unknown>]> = [
    ['en', enCatalog as Record<string, unknown>],
    ['es', esCatalog as Record<string, unknown>],
    ['zh-CN', zhCatalog as Record<string, unknown>],
  ];

  /** Same dot-path walk `src/i18n/index.ts` uses — deliberately NOT `t()`,
   *  which falls back to English and would hide a missing es/zh-CN key. */
  function lookup(catalog: Record<string, unknown>, key: string): string | undefined {
    let cur: unknown = catalog;
    for (const seg of key.split('.')) {
      if (typeof cur !== 'object' || cur === null) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return typeof cur === 'string' ? cur : undefined;
  }

  const mkLine = (over: Partial<Extract<LastOrderLine, { kind: 'line' }>>) =>
    ({
      kind: 'line',
      dateIso: '2026-07-29',
      counted: null,
      ordered: null,
      notConfirmed: false,
      delta: null,
      ...over,
    }) as Extract<LastOrderLine, { kind: 'line' }>;

  const qty = { value: 13, unitLabel: 'CS' };

  // Harvested from the formatter at RUNTIME (never a hand-copied list), so a
  // rename inside lastOrderContext.ts is caught here too.
  const sentenceKeys = [
    mkLine({ counted: qty, ordered: qty }),
    mkLine({ ordered: qty }),
    mkLine({ counted: qty }),
    mkLine({}),
  ].map((l) => lastOrderSentence(l, formatLastOrderDate, formatQty).key);

  const deltaKeys = (['up', 'down', 'same'] as const).map(
    (direction) =>
      lastOrderDeltaText({ direction, value: 3, unitLabel: 'CS' }, formatQty)!.key,
  );

  // The two keys the TIERS reference directly rather than through the module
  // (ReorderSection.tsx + phone/PhoneOrdering.tsx): the NOT CONFIRMED
  // qualifier and the card-level AC-9 empty state.
  const TIER_KEYS = [
    'section.reorder.lastOrderNotConfirmed',
    'section.reorder.lastOrderNone',
  ];

  it('exercises every sentence and delta variant (so the list below is complete)', () => {
    expect(new Set(sentenceKeys).size).toBe(4);
    expect(new Set(deltaKeys).size).toBe(3);
  });

  it.each(CATALOGS)('%s resolves all 9 keys to a non-empty string', (_locale, catalog) => {
    const keys = [...sentenceKeys, ...deltaKeys, ...TIER_KEYS];
    expect(keys).toHaveLength(9);
    for (const key of keys) {
      const value = lookup(catalog, key);
      expect(typeof value).toBe('string');
      expect(value).not.toBe('');
    }
  });
});
