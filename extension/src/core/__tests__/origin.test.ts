import { describe, it, expect } from 'vitest';
import { pendingOrdersForOrigin } from '../origin';
import type { PendingOrder } from '../../lib/types';

function order(overrides: Partial<PendingOrder>): PendingOrder {
  return {
    poId: 'po-1',
    storeId: 'store-1',
    vendorId: 'vendor-1',
    vendorName: "BJ's",
    orderPageUrl: 'https://www.bjs.com/order',
    orderUnit: 'case',
    lineCount: 3,
    unmappedCount: 0,
    ...overrides,
  };
}

describe('pendingOrdersForOrigin (AC-3 / OQ-5 — vendor↔site join by order_page_url origin)', () => {
  it('matches a pending PO whose order_page_url shares the current origin', () => {
    const pending = [order({ poId: 'a', orderPageUrl: 'https://www.bjs.com/deep/path?x=1' })];
    const out = pendingOrdersForOrigin(pending, 'https://www.bjs.com');
    expect(out.map((o) => o.poId)).toEqual(['a']);
  });

  it('excludes a pending PO for a different vendor origin', () => {
    const pending = [
      order({ poId: 'bjs', orderPageUrl: 'https://www.bjs.com/order' }),
      order({ poId: 'sams', orderPageUrl: 'https://www.samsclub.com/reorder', vendorName: "Sam's" }),
    ];
    expect(pendingOrdersForOrigin(pending, 'https://www.samsclub.com').map((o) => o.poId)).toEqual(['sams']);
  });

  it('excludes a pending PO with a null or unsafe order_page_url (cannot positively map)', () => {
    const pending = [
      order({ poId: 'nulled', orderPageUrl: null }),
      order({ poId: 'unsafe', orderPageUrl: 'javascript:void(0)' }),
    ];
    expect(pendingOrdersForOrigin(pending, 'https://www.bjs.com')).toEqual([]);
  });

  it('returns [] when the current origin is unsafe/unparseable', () => {
    const pending = [order({})];
    expect(pendingOrdersForOrigin(pending, 'not-a-url')).toEqual([]);
  });

  it('can return multiple pending POs for the same vendor origin', () => {
    const pending = [order({ poId: 'a' }), order({ poId: 'b' })];
    expect(pendingOrdersForOrigin(pending, 'https://www.bjs.com').map((o) => o.poId)).toEqual(['a', 'b']);
  });
});
