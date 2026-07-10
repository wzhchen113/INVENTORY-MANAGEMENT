// src/utils/reorderExport.test.ts — Spec 089 (A).
//
// Covers the PURE export builders extracted from ReorderSection.tsx plus the
// NEW shared `buildReorderText` / `buildReorderPdfHtml`. The byte-for-byte
// cases·units formatting is the spec-088 invariant the admin reorder jest
// also pins (those tests still import formatSuggested/formatSuggestedPdf/
// buildReorderCsv from ReorderSection, which now re-exports them from here)
// — this file is the canonical unit coverage for the shared util.

import { ReorderItem, ReorderPayload, ReorderVendor } from '../types';
import {
  buildReorderCsv,
  buildReorderPdfHtml,
  buildReorderText,
  formatMoney,
  formatQty,
  formatSuggested,
  formatSuggestedPdf,
  localizeUnit,
  slugifyStore,
  todayLocalIso,
} from './reorderExport';

// Same fixture builders the admin ReorderSectionCases test uses (the server
// is the source of truth for suggestedCases/suggestedUnits/estimatedCost).
function caseItem(over: {
  itemId?: string;
  itemName?: string;
  unit?: string;
  suggestedQty: number;
  caseQty: number;
  costPerUnit?: number;
}): ReorderItem {
  const cost = over.costPerUnit ?? 1;
  const cases = Math.ceil(over.suggestedQty / over.caseQty);
  const orderedUnits = cases * over.caseQty;
  return {
    itemId: over.itemId ?? 'i-case',
    itemName: over.itemName ?? 'Case Item',
    unit: over.unit ?? 'each',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: over.suggestedQty,
    usageForecasted: 0,
    parReplacement: over.suggestedQty,
    suggestedQty: over.suggestedQty,
    costPerUnit: cost,
    estimatedCost: orderedUnits * cost,
    caseQty: over.caseQty,
    suggestedCases: cases,
    suggestedUnits: orderedUnits,
    flags: [],
  };
}

function plainItem(over: {
  itemId?: string;
  itemName?: string;
  unit?: string;
  suggestedQty: number;
  caseQty?: number;
  costPerUnit?: number;
}): ReorderItem {
  const cost = over.costPerUnit ?? 1;
  return {
    itemId: over.itemId ?? 'i-plain',
    itemName: over.itemName ?? 'Plain Item',
    unit: over.unit ?? 'gal',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: over.suggestedQty,
    usageForecasted: 0,
    parReplacement: over.suggestedQty,
    suggestedQty: over.suggestedQty,
    costPerUnit: cost,
    estimatedCost: over.suggestedQty * cost,
    caseQty: over.caseQty ?? 1,
    suggestedCases: null,
    suggestedUnits: over.suggestedQty,
    flags: [],
  };
}

function vendor(over: {
  vendorId: string;
  items: ReorderItem[];
  onHandSource?: 'eod' | 'stock';
  vendorName?: string;
  nextDeliveryDate?: string;
}): ReorderVendor {
  return {
    vendorId: over.vendorId,
    vendorName: over.vendorName ?? over.vendorId,
    scheduleKnown: true,
    nextDeliveryDate: over.nextDeliveryDate ?? '2026-06-02',
    daysUntilNextDelivery: 1,
    onHandSource: over.onHandSource ?? 'eod',
    eodSubmittedAt: null,
    items: over.items,
    vendorTotalCost: over.items.reduce((acc, i) => acc + i.estimatedCost, 0),
  };
}

function payloadWith(items: ReorderItem[], storeAsOf = '2026-06-02'): ReorderPayload {
  const v = vendor({ vendorId: 'v-1', items });
  return {
    asOfDate: storeAsOf,
    vendors: [v],
    kpis: {
      vendorCount: 1,
      itemCount: items.length,
      totalEstimatedCost: v.vendorTotalCost,
      eodSourcedVendorCount: 1,
      stockFallbackVendorCount: 0,
    },
    warnings: [],
  };
}

describe('formatQty / formatMoney', () => {
  it('drops trailing-zero decimals but keeps up to 2dp', () => {
    expect(formatQty(8)).toBe('8');
    expect(formatQty(2.5)).toBe('2.5');
    expect(formatQty(2.5)).not.toBe('2.50');
  });
  it('formatMoney renders $ with exactly 2dp', () => {
    expect(formatMoney(72)).toBe('$72.00');
    expect(formatMoney(12.5)).toBe('$12.50');
  });
});

describe('formatSuggested (cases·units, spec 088 byte-for-byte)', () => {
  it('case item → N cases · M unit', () => {
    expect(formatSuggested(caseItem({ suggestedQty: 72, caseQty: 24, unit: 'each' }))).toBe(
      '3 cases · 72 each',
    );
  });
  it('singular at exactly one case', () => {
    expect(formatSuggested(caseItem({ suggestedQty: 24, caseQty: 24, unit: 'each' }))).toBe(
      '1 case · 24 each',
    );
  });
  it('non-case item unchanged', () => {
    expect(formatSuggested(plainItem({ suggestedQty: 8, unit: 'gal' }))).toBe('8 gal');
  });
  it('suppresses the redundant sub when the base unit is itself "cases"', () => {
    // "3 cases · 12 cases" would repeat the noun → just the case figure (2026-07).
    expect(formatSuggested(caseItem({ suggestedQty: 12, caseQty: 4, unit: 'cases' }))).toBe('3 cases');
    expect(formatSuggested(caseItem({ suggestedQty: 4, caseQty: 4, unit: 'case' }))).toBe('1 case');
    expect(formatSuggestedPdf(caseItem({ suggestedQty: 12, caseQty: 4, unit: 'cases' }))).toBe('3 cs');
  });
  it('PDF variant uses the cs abbreviation', () => {
    expect(formatSuggestedPdf(caseItem({ suggestedQty: 49, caseQty: 24, unit: 'each' }))).toBe(
      '3 cs · 72 each',
    );
  });
});

describe('slugifyStore', () => {
  it('replaces spaces + strips unsafe chars', () => {
    expect(slugifyStore('Towson Store #2')).toBe('Towson_Store_2');
  });
  it('falls back to "store" when the result is empty (no usable chars)', () => {
    // Whitespace collapses to "_" (an allowed char), so the fallback only
    // triggers when nothing survives — e.g. an empty string or all-stripped
    // punctuation. Pins the EXISTING admin behavior, unchanged by extraction.
    expect(slugifyStore('')).toBe('store');
    expect(slugifyStore('!!!')).toBe('store');
  });
});

describe('todayLocalIso (spec 091 A1 — local, not UTC)', () => {
  const RealDate = global.Date;
  afterEach(() => {
    global.Date = RealDate;
  });

  it('builds YYYY-MM-DD from LOCAL date components, not toISOString().slice(0,10)', () => {
    // Construct a moment where the LOCAL calendar day differs from the UTC
    // calendar day: local is 2026-06-02, but the UTC instant has already
    // rolled to 2026-06-03 (e.g. late-evening in a negative-offset TZ). The
    // OLD `toISOString().slice(0,10)` body would return the UTC '2026-06-03';
    // the fixed local-components body must return '2026-06-02'.
    class FakeDate extends RealDate {
      // No explicit constructor — the parent's is used implicitly (matches the
      // second FakeDate below); the overrides are what the assertion reads.
      getFullYear(): number {
        return 2026;
      }
      getMonth(): number {
        return 5; // June (0-indexed)
      }
      getDate(): number {
        return 2;
      }
      toISOString(): string {
        // The divergent UTC representation — one day ahead of local.
        return '2026-06-03T01:30:00.000Z';
      }
    }
    // @ts-expect-error — swapping the Date constructor for the assertion.
    global.Date = FakeDate;

    expect(todayLocalIso()).toBe('2026-06-02');
    // Must NOT be the UTC-slice form (the pre-091 bug).
    expect(todayLocalIso()).not.toBe('2026-06-03');
  });

  it('zero-pads single-digit month + day', () => {
    class FakeDate extends RealDate {
      getFullYear(): number {
        return 2026;
      }
      getMonth(): number {
        return 0; // January
      }
      getDate(): number {
        return 5;
      }
    }
    // @ts-expect-error — swapping the Date constructor for the assertion.
    global.Date = FakeDate;

    expect(todayLocalIso()).toBe('2026-01-05');
  });
});

describe('buildReorderCsv (cases columns, spec 088)', () => {
  it('emits Cases + Units Per Case immediately after Suggested Qty', () => {
    const csv = buildReorderCsv(payloadWith([caseItem({ suggestedQty: 49, caseQty: 24 })]));
    expect(csv.split('\n')[0]).toMatch(/Suggested Qty,Cases,Units Per Case,Unit/);
  });
  it('case row → Suggested Qty = ordered units M, Cases populated, Est case-rounded', () => {
    const csv = buildReorderCsv(
      payloadWith([caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 1, itemName: 'Buns' })]),
    );
    // Columns (2026-07 — 'Needs Order' inserted at index 1): Vendor(0),
    // Needs Order(1), Item Name(2), On Hand(3), Pending PO(4), Par Level(5),
    // Suggested Qty(6), Cases(7), Units Per Case(8), Unit(9), Est. Cost(10).
    const cells = csv.split('\n').find((l) => l.includes('Buns'))!.split(',');
    expect(cells[1]).toBe('yes'); // below par → needs order
    expect(cells[6]).toBe('72');
    expect(cells[7]).toBe('3');
    expect(cells[8]).toBe('24');
    expect(cells[10]).toBe('72.00');
  });
});

describe('buildReorderText (NEW — share-sheet plain text)', () => {
  it('includes the store + as-of header', () => {
    const txt = buildReorderText(payloadWith([plainItem({ suggestedQty: 8 })]), 'Towson');
    expect(txt).toContain('Store: Towson');
    expect(txt).toContain('As of: 2026-06-02');
  });

  it('renders the cases-aware Suggested string per item (matches formatSuggested)', () => {
    const item = caseItem({ suggestedQty: 49, caseQty: 24, unit: 'each', itemName: 'Buns' });
    const txt = buildReorderText(payloadWith([item]), 'Towson');
    expect(txt).toContain(`Buns: ${formatSuggested(item)}`);
    expect(txt).toContain('3 cases · 72 each');
  });

  it('uses the server-rounded est cost (no FE cost math)', () => {
    const item = caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 2 }); // 72 × $2 = $144
    const txt = buildReorderText(payloadWith([item]), 'Towson');
    expect(txt).toContain('est $144.00');
  });

  it('footer totals read the payload kpis verbatim', () => {
    const txt = buildReorderText(
      payloadWith([caseItem({ suggestedQty: 24, caseQty: 24, costPerUnit: 3 })]),
      'Towson',
    );
    // 1 item, total = $72.00
    expect(txt).toContain('Total items: 1');
    expect(txt).toContain('Est. total: $72.00');
  });

  it('reflects the DERIVED (filtered) payload — only the vendors passed', () => {
    // Caller passes primary vendors only; text must not invent others.
    const onlyOne = payloadWith([plainItem({ suggestedQty: 5, itemName: 'Oil' })]);
    const txt = buildReorderText(onlyOne, 'Towson');
    expect(txt).toContain('Oil');
    expect((txt.match(/subtotal:/g) || []).length).toBe(1);
  });

  it('handles an empty (nothing-to-order) payload without crashing', () => {
    const empty: ReorderPayload = {
      asOfDate: '2026-06-02',
      vendors: [],
      kpis: { vendorCount: 0, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    const txt = buildReorderText(empty, 'Towson');
    expect(txt).toContain('(no items to order)');
    expect(txt).toContain('Total items: 0');
  });
});

describe('buildReorderPdfHtml (NEW — shared HTML→PDF source)', () => {
  it('renders a table row per item with the compact cs Suggested cell — main bold, subunit muted', () => {
    const item = caseItem({ suggestedQty: 49, caseQty: 24, unit: 'each', itemName: 'Buns' });
    const html = buildReorderPdfHtml(payloadWith([item]), 'Towson');
    expect(html).toContain('Buns');
    // Main case unit in the bold span; the base-unit subunit in the smaller,
    // non-bold `sub-unit` span so it reads as supporting detail.
    expect(html).toContain('<span class="strong">3 cs</span>');
    expect(html).toContain('<span class="sub-unit"> &middot; 72 each</span>');
    expect(html).toContain('Store: Towson');
  });

  it('renders a non-case Suggested cell as a single bold span (no subunit)', () => {
    const item = plainItem({ suggestedQty: 8, unit: 'gal', itemName: 'Oil' });
    const html = buildReorderPdfHtml(payloadWith([item]), 'Towson');
    expect(html).toContain('<span class="strong">8 gal</span>');
    expect(html).not.toContain('sub-unit"> &middot;');
  });

  it('escapes HTML-unsafe characters in vendor + item names', () => {
    const item = plainItem({ suggestedQty: 5, itemName: 'Salt & <Pepper>' });
    const v = vendor({ vendorId: 'v-x', vendorName: 'Acme "Foods" & Co', items: [item] });
    const payload: ReorderPayload = {
      asOfDate: '2026-06-02',
      vendors: [v],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: v.vendorTotalCost, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    const html = buildReorderPdfHtml(payload, 'Store & Co');
    expect(html).toContain('Salt &amp; &lt;Pepper&gt;');
    expect(html).toContain('Acme &quot;Foods&quot; &amp; Co');
    expect(html).toContain('Store &amp; Co');
    // The raw unescaped forms must NOT leak into the markup.
    expect(html).not.toContain('Salt & <Pepper>');
  });

  it('renders a placeholder for an empty payload', () => {
    const empty: ReorderPayload = {
      asOfDate: '2026-06-02',
      vendors: [],
      kpis: { vendorCount: 0, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    expect(buildReorderPdfHtml(empty, 'Towson')).toContain('(no items to order)');
  });
});

describe('localized downloads (2026-07)', () => {
  it('English output is byte-identical to the no-locale default', () => {
    const p = payloadWith([
      caseItem({ itemName: 'Chicken Leg', unit: 'bags', suggestedQty: 16, caseQty: 4 }),
    ]);
    expect(buildReorderCsv(p, 'en')).toBe(buildReorderCsv(p));
    const it = p.vendors[0].items[0];
    expect(formatSuggestedPdf(it, 'en')).toBe(formatSuggestedPdf(it));
    expect(formatSuggestedPdf(it)).toBe('4 cs · 16 bags');
  });

  it('localizeUnit translates dictionary units and passes unknown units through', () => {
    expect(localizeUnit('bags', 'zh-CN')).toBe('袋');
    expect(localizeUnit('lbs', 'zh-CN')).toBe('磅');
    expect(localizeUnit('bags', 'es')).toBe('bolsas');
    // Not in the enum.unit dictionary → passes through unchanged.
    expect(localizeUnit('loaves', 'zh-CN')).toBe('loaves');
  });

  it('formatSuggestedPdf localizes the case noun + unit token (es / zh)', () => {
    const it = caseItem({ unit: 'bags', suggestedQty: 16, caseQty: 4 });
    expect(formatSuggestedPdf(it, 'zh-CN')).toBe('4 箱 · 16 袋');
    expect(formatSuggestedPdf(it, 'es')).toBe('4 cs · 16 bolsas');
  });

  it('CSV headers + unit + item name localize; the English EOD numeric shape survives', () => {
    const item = caseItem({ itemName: 'Chicken Leg', unit: 'bags', suggestedQty: 16, caseQty: 4 });
    item.i18nNames = { 'zh-CN': '鸡腿' };
    const csv = buildReorderCsv(payloadWith([item]), 'zh-CN');
    expect(csv).toContain('供应商'); // Vendor header
    expect(csv).toContain('建议数量'); // Suggested Qty header
    expect(csv).toContain('鸡腿'); // localized item name
    expect(csv).toContain('袋'); // localized unit
    expect(csv).not.toContain('Suggested Qty');
  });

  it('item name falls back to English when the locale override is absent', () => {
    const item = caseItem({ itemName: 'Chicken Leg', unit: 'bags', suggestedQty: 16, caseQty: 4 });
    const csv = buildReorderCsv(payloadWith([item]), 'zh-CN');
    expect(csv).toContain('Chicken Leg');
  });
});
