// src/screens/staff/lib/reorderExportStaff.test.ts
//
// Owner decision (2026-07): staff exports carry NO cost — only order
// quantities. These assert the price-stripped builders drop every cost field
// (CSV 'Est. Cost' column, text `(est $…)` + subtotals + Est. total, PDF
// 'Est. Cost' column + Est. total footer) while KEEPING the cases-aware
// Suggested figure and the quantity columns intact.

import type { ReorderItem, ReorderPayload, ReorderVendor } from '../../../types';
import {
  buildStaffReorderCsv,
  buildStaffReorderPdfHtml,
  buildStaffReorderText,
} from './reorderExportStaff';

function caseItem(): ReorderItem {
  // 72 units, case of 24 → 3 cases · 72 each, $144 at $2/unit.
  return {
    itemId: 'i-1',
    itemName: 'Case Item',
    unit: 'each',
    onHand: 5,
    pendingPoQty: 0,
    parLevel: 72,
    usageForecasted: 0,
    parReplacement: 72,
    suggestedQty: 72,
    costPerUnit: 2,
    estimatedCost: 144,
    caseQty: 24,
    suggestedCases: 3,
    suggestedUnits: 72,
    flags: [],
  };
}

function vendor(items: ReorderItem[]): ReorderVendor {
  return {
    vendorId: 'v-1',
    vendorName: 'Acme',
    scheduleKnown: true,
    nextDeliveryDate: '2026-06-02',
    daysUntilNextDelivery: 1,
    onHandSource: 'eod',
    eodSubmittedAt: null,
    items,
    vendorTotalCost: items.reduce((a, i) => a + i.estimatedCost, 0),
  };
}

function payload(): ReorderPayload {
  const v = vendor([caseItem()]);
  return {
    asOfDate: '2026-06-02',
    vendors: [v],
    kpis: {
      vendorCount: 1,
      itemCount: 1,
      totalEstimatedCost: v.vendorTotalCost,
      eodSourcedVendorCount: 1,
      stockFallbackVendorCount: 0,
    },
    warnings: [],
  };
}

describe('staff reorder exports are cost-free', () => {
  it('CSV drops the Est. Cost column but keeps the quantity columns', () => {
    const csv = buildStaffReorderCsv(payload());
    expect(csv).not.toContain('Est. Cost');
    expect(csv).not.toContain('144');
    expect(csv).not.toContain('$');
    // Quantity columns still present.
    expect(csv).toContain('Suggested Qty');
    expect(csv).toContain('Cases');
    expect(csv).toContain('On Hand');
    expect(csv).toContain('Case Item');
  });

  it('text drops per-item cost, subtotal, and Est. total — keeps Suggested + item count', () => {
    const txt = buildStaffReorderText(payload(), 'Towson');
    expect(txt).not.toContain('$');
    expect(txt).not.toContain('est ');
    expect(txt).not.toContain('subtotal');
    expect(txt).not.toContain('Est. total');
    // Cases-aware Suggested figure and the count footer survive.
    expect(txt).toContain('Case Item: 3 cases · 72 each');
    expect(txt).toContain('Total items: 1');
  });

  it('PDF HTML drops the Est. Cost column + Est. total footer', () => {
    const html = buildStaffReorderPdfHtml(payload(), 'Towson');
    expect(html).not.toContain('Est. Cost');
    expect(html).not.toContain('Est. total');
    expect(html).not.toContain('$');
    // Suggested cell + quantity headers survive.
    expect(html).toContain('3 cs');
    expect(html).toContain('Suggested');
    expect(html).toContain('Total items: 1');
  });
});
