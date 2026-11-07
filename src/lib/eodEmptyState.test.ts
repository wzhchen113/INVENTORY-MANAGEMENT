// src/lib/eodEmptyState.test.ts — Spec 184 (D-12).
//
// Every row of the D-12 table, and each precedence pair: an input that satisfies
// two rows must resolve to the earlier one.

import { deriveEodEmptyState } from './eodEmptyState';

type Input = Parameters<typeof deriveEodEmptyState>[0];

// A loaded, stocked store whose selected day has a scheduled vendor with items
// elsewhere: the last row of the table. Each case overrides what it's about.
const base: Input = {
  vendorTabsCount: 0,
  allVendorTabsCount: 3,
  storeItemCount: 10,
  storeItemsWithLinkCount: 8,
  dayScheduledVendorCount: 1,
  inventoryLoadStatus: 'loaded',
  storeLoading: false,
};
const derive = (o: Partial<Input> = {}) => deriveEodEmptyState({ ...base, ...o });

describe('deriveEodEmptyState — each row of the D-12 table', () => {
  it('row 1: vendor tabs exist', () => {
    expect(derive({ vendorTabsCount: 2 })).toBe('none');
  });
  it('row 2: the inventory load failed', () => {
    expect(derive({ inventoryLoadStatus: 'failed' })).toBe('load_failed');
  });
  it('row 3: nothing has loaded yet', () => {
    expect(derive({ inventoryLoadStatus: 'unknown' })).toBe('loading');
  });
  it('row 3: loading, with no items here', () => {
    expect(derive({ storeLoading: true, storeItemCount: 0 })).toBe('loading');
  });
  it('row 4 (S1): loaded, no items', () => {
    expect(
      derive({ storeItemCount: 0, storeItemsWithLinkCount: 0, allVendorTabsCount: 0 }),
    ).toBe('no_items');
  });
  it('row 5 (S2): items, none linked', () => {
    expect(derive({ storeItemsWithLinkCount: 0, allVendorTabsCount: 0 })).toBe('no_vendor_links');
  });
  it('row 6: linked, but no vendor resolves to a tab (F-9)', () => {
    expect(derive({ allVendorTabsCount: 0 })).toBe('vendors_unresolved');
  });
  it('row 7 (S3): vendors have items here, none scheduled today', () => {
    expect(derive({ dayScheduledVendorCount: 0 })).toBe('no_scheduled_vendors');
  });
  it('row 8 (S4): scheduled vendors, none with items here', () => {
    expect(derive()).toBe('scheduled_vendors_no_items');
  });
});

describe('deriveEodEmptyState — precedence', () => {
  it('tabs win over a failed load', () => {
    expect(derive({ vendorTabsCount: 1, inventoryLoadStatus: 'failed' })).toBe('none');
  });
  it('tabs win over not having loaded', () => {
    expect(derive({ vendorTabsCount: 1, inventoryLoadStatus: 'unknown' })).toBe('none');
  });
  it('a failed load wins over an in-flight reload', () => {
    expect(derive({ inventoryLoadStatus: 'failed', storeLoading: true })).toBe('load_failed');
  });
  it('N5: a failed load with no items is never S1', () => {
    expect(
      derive({
        inventoryLoadStatus: 'failed',
        storeItemCount: 0,
        storeItemsWithLinkCount: 0,
        allVendorTabsCount: 0,
      }),
    ).toBe('load_failed');
  });
  it('N5: not having loaded, with no items, is never S1', () => {
    expect(
      derive({
        inventoryLoadStatus: 'unknown',
        storeItemCount: 0,
        storeItemsWithLinkCount: 0,
        allVendorTabsCount: 0,
      }),
    ).toBe('loading');
  });
  it('an in-flight reload with no items here is not yet S1', () => {
    expect(
      derive({ storeLoading: true, storeItemCount: 0, storeItemsWithLinkCount: 0, allVendorTabsCount: 0 }),
    ).toBe('loading');
  });
  it('a background reload does not hide a state at a store that has items', () => {
    expect(derive({ storeLoading: true, dayScheduledVendorCount: 0 })).toBe('no_scheduled_vendors');
  });
  it('S1 wins over S2', () => {
    expect(derive({ storeItemCount: 0, storeItemsWithLinkCount: 0 })).toBe('no_items');
  });
  it('S2 wins over vendors_unresolved', () => {
    expect(derive({ storeItemsWithLinkCount: 0, allVendorTabsCount: 0 })).toBe('no_vendor_links');
  });
  it('S2 wins over S3', () => {
    expect(derive({ storeItemsWithLinkCount: 0, dayScheduledVendorCount: 0 })).toBe('no_vendor_links');
  });
  it('S2 wins over S4', () => {
    expect(derive({ storeItemsWithLinkCount: 0, dayScheduledVendorCount: 1 })).toBe('no_vendor_links');
  });
  it('vendors_unresolved wins over S3', () => {
    expect(derive({ allVendorTabsCount: 0, dayScheduledVendorCount: 0 })).toBe('vendors_unresolved');
  });
  it('AC-23: some unlinked items at a stocked store never trigger S2', () => {
    expect(derive({ storeItemCount: 10, storeItemsWithLinkCount: 1, dayScheduledVendorCount: 0 })).toBe(
      'no_scheduled_vendors',
    );
  });
});
