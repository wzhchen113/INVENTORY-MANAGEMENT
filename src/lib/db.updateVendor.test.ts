// src/lib/db.updateVendor.test.ts — cleanup pass (2026-07-05).
//
// Pins the fix for a silent data-loss bug: `updateVendor` dropped
// `deliveryDays` and `categories` from its UPDATE body even though
// VendorFormDrawer lets an admin edit both — so editing a vendor's delivery
// days or categories and saving appeared to succeed but persisted nothing.
// These tests prove the two fields now reach the UPDATE (as the direct
// string[] the columns expect, mirroring createVendor), while keeping the
// omit-key-to-skip discipline the other fields use.
//
// Mocking strategy mirrors db.updateStore.test.ts: a single chainable builder
// per from('vendors'); track(fn) runs the thunk directly with a dummy signal.

let updateSpy: jest.Mock;
let eqSpy: jest.Mock;
let abortSpy: jest.Mock;
let builder: any;

const mockFrom = jest.fn((table: string) => {
  if (table === 'vendors') return builder;
  throw new Error(`unexpected table in db.updateVendor test: ${table}`);
});

jest.mock('./supabase', () => ({
  supabase: { from: (table: string) => mockFrom(table) },
}));

jest.mock('./inflight', () => ({
  useInflight: {
    getState: () => ({
      track: (fn: (signal: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal),
    }),
  },
}));

jest.mock('./auth', () => ({ callEdgeFunction: jest.fn() }));

import { updateVendor } from './db';

beforeEach(() => {
  jest.clearAllMocks();
  updateSpy = jest.fn().mockReturnThis();
  eqSpy = jest.fn().mockReturnThis();
  abortSpy = jest.fn().mockResolvedValue({ data: [], error: null });
  builder = { update: updateSpy, eq: eqSpy, abortSignal: abortSpy };
});

describe('updateVendor — deliveryDays + categories data-loss fix', () => {
  it('threads deliveryDays → delivery_days (string[]) into the UPDATE body', async () => {
    await updateVendor('v1', { deliveryDays: ['Mon', 'Thu'] });

    expect(mockFrom).toHaveBeenCalledWith('vendors');
    expect(updateSpy).toHaveBeenCalledWith({ delivery_days: ['Mon', 'Thu'] });
    expect(eqSpy).toHaveBeenCalledWith('id', 'v1');
  });

  it('threads categories → categories (string[]) into the UPDATE body', async () => {
    await updateVendor('v1', { categories: ['Produce', 'Dairy'] });

    expect(updateSpy).toHaveBeenCalledWith({ categories: ['Produce', 'Dairy'] });
  });

  it('writes both alongside the other fields in one UPDATE', async () => {
    await updateVendor('v1', {
      name: 'Sysco',
      deliveryDays: ['Tue'],
      categories: ['Dry Goods'],
      orderUnit: 'case',
    });

    expect(updateSpy).toHaveBeenCalledWith({
      name: 'Sysco',
      delivery_days: ['Tue'],
      categories: ['Dry Goods'],
      order_unit: 'case',
    });
  });

  it('empty arrays still persist (clear-out), not dropped', async () => {
    await updateVendor('v1', { deliveryDays: [], categories: [] });

    // `[] !== undefined`, so the omit-key-to-skip guard passes them through —
    // an admin CAN clear a vendor's days/categories.
    expect(updateSpy).toHaveBeenCalledWith({ delivery_days: [], categories: [] });
  });

  it('omit-key-to-skip: an update touching neither field writes neither key', async () => {
    await updateVendor('v1', { phone: '555-1000' });

    const body = updateSpy.mock.calls[0][0];
    expect(body).toEqual({ phone: '555-1000' });
    expect('delivery_days' in body).toBe(false);
    expect('categories' in body).toBe(false);
  });
});
