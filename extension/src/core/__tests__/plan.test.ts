import { describe, it, expect } from 'vitest';
import { buildPlan, resolveLine } from '../plan';
import type { OrderPayload } from '../../lib/types';

function payload(overrides: Partial<OrderPayload>): OrderPayload {
  return {
    poId: 'po-1',
    storeId: 'store-1',
    vendorId: 'vendor-1',
    vendorName: "Sam's",
    orderPageUrl: 'https://www.samsclub.com/reorder',
    orderUnit: 'unit',
    lines: [],
    ...overrides,
  };
}

describe('resolveLine (AC-4/AC-5 — resolution strategy)', () => {
  it("prefers a valid product_page_url ('url'), even with no code", () => {
    expect(resolveLine(null, 'https://www.bjs.com/product/9')).toBe('url');
    expect(resolveLine('ABC', 'https://www.bjs.com/product/9')).toBe('url');
  });
  it("falls back to search when a code is present but no URL", () => {
    expect(resolveLine('ABC123', null)).toBe('search');
    expect(resolveLine('ABC123', 'javascript:void(0)')).toBe('search'); // unsafe URL ignored
  });
  it("marks a line with no code and no URL as unmapped (never guessed — AC-5)", () => {
    expect(resolveLine(null, null)).toBe('unmapped');
    expect(resolveLine('   ', null)).toBe('unmapped');
  });
});

describe('buildPlan (AC-4/AC-6 — payload → planned actions via the shared builder)', () => {
  it('is empty for an empty payload', () => {
    expect(buildPlan(payload({ lines: [] }))).toEqual([]);
  });

  it("passes 'unit' quantities through verbatim (no case math)", () => {
    const plan = buildPlan(
      payload({
        orderUnit: 'unit',
        lines: [
          { itemId: 'i1', itemName: 'Milk', orderCode: 'M1', orderedQty: 7, caseQty: 4, productPageUrl: null },
        ],
      }),
    );
    expect(plan[0]).toMatchObject({ orderCode: 'M1', qty: 7, unit: 'unit', resolution: 'search' });
  });

  it("ceils to whole cases for a 'case' vendor (delegates to spec-115 shared math)", () => {
    const plan = buildPlan(
      payload({
        orderUnit: 'case',
        lines: [
          { itemId: 'i1', itemName: 'Soda', orderCode: 'S1', orderedQty: 13, caseQty: 6, productPageUrl: null },
        ],
      }),
    );
    // 13 counted / 6 per case = 2.17 → ceil → 3 cases
    expect(plan[0]).toMatchObject({ qty: 3, unit: 'case' });
  });

  it("surfaces an unmapped line with orderCode:null (never dropped — AC-4)", () => {
    const plan = buildPlan(
      payload({
        orderUnit: 'unit',
        lines: [
          { itemId: 'i1', itemName: 'Mystery Item', orderCode: null, orderedQty: 2, caseQty: 1, productPageUrl: null },
        ],
      }),
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ itemId: 'i1', orderCode: null, resolution: 'unmapped', itemName: 'Mystery Item' });
  });

  it("resolves a stored product_page_url to a direct-navigate 'url' action", () => {
    const plan = buildPlan(
      payload({
        orderUnit: 'unit',
        lines: [
          {
            itemId: 'i1',
            itemName: 'Bread',
            orderCode: 'B1',
            orderedQty: 1,
            caseQty: 1,
            productPageUrl: 'https://www.samsclub.com/p/bread/12345',
          },
        ],
      }),
    );
    expect(plan[0]).toMatchObject({ resolution: 'url', productPageUrl: 'https://www.samsclub.com/p/bread/12345' });
  });

  it('preserves input line order', () => {
    const plan = buildPlan(
      payload({
        orderUnit: 'unit',
        lines: [
          { itemId: 'a', itemName: 'A', orderCode: 'A1', orderedQty: 1, caseQty: 1, productPageUrl: null },
          { itemId: 'b', itemName: 'B', orderCode: 'B1', orderedQty: 1, caseQty: 1, productPageUrl: null },
          { itemId: 'c', itemName: 'C', orderCode: 'C1', orderedQty: 1, caseQty: 1, productPageUrl: null },
        ],
      }),
    );
    expect(plan.map((p) => p.itemId)).toEqual(['a', 'b', 'c']);
  });
});
