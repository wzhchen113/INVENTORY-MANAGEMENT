// src/utils/lastOrderContext.noNeed.spec172.test.ts — Spec 172 (AC-37).
//
// A reorder row flagged `no_need` carries the stale `current_stock` as its
// `onHand` (a NO NEED mark never updates it), so the counted-vs-on-hand delta
// is suppressed exactly like `eod_missing_for_item`. Everything else on the
// line (counted / ordered / date) is unchanged.

import { buildLastOrderContext, type LastOrderLine } from './lastOrderContext';
import type { LastOrderContextVendor } from '../types';

const vendorContext: LastOrderContextVendor = {
  vendorId: 'v-1',
  lastOrderDate: '2026-10-20',
  confidence: 'placed',
  source: 'purchase_order',
  sourceId: 'po-1',
  countedDate: '2026-10-20',
  itemsTruncated: false,
  items: { 'i-1': { itemId: 'i-1', orderedQtyBase: 12, countedQtyBase: 4 } },
};

function build(flags: string[]): Extract<LastOrderLine, { kind: 'line' }> {
  const l = buildLastOrderContext({
    item: { itemId: 'i-1', caseQty: 1, unit: 'lb', onHand: 10, flags },
    vendorContext,
    onHandSource: 'eod',
  });
  if (l.kind !== 'line') throw new Error('expected a line');
  return l;
}

describe('buildLastOrderContext — spec 172 no_need (AC-37)', () => {
  it('control: an unflagged EOD row computes the delta', () => {
    expect(build([]).delta).toEqual({ direction: 'up', value: 6, unitLabel: 'lb' });
  });

  it('a no_need row suppresses the delta (same as eod_missing_for_item)', () => {
    expect(build(['no_need']).delta).toBeNull();
    expect(build(['eod_missing_for_item']).delta).toBeNull();
  });

  it('the rest of the line is unchanged for a no_need row', () => {
    const l = build(['no_par', 'no_need']);
    expect(l.counted).toEqual({ value: 4, unitLabel: 'lb' });
    expect(l.ordered).toEqual({ value: 12, unitLabel: 'lb' });
    expect(l.dateIso).toBe('2026-10-20');
    expect(l.notConfirmed).toBe(false);
  });
});
