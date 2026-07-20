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

describe('updateVendor — account_number + US Foods import fields persist (2026-07)', () => {
  it('threads accountNumber → account_number (was silently dropped on update)', async () => {
    await updateVendor('v1', { accountNumber: '12345678' });
    expect(updateSpy).toHaveBeenCalledWith({ account_number: '12345678' });
  });

  it('empty accountNumber clears to null', async () => {
    await updateVendor('v1', { accountNumber: '' });
    expect(updateSpy).toHaveBeenCalledWith({ account_number: null });
  });

  it('threads the import fields incl. the per-store customer-number map', async () => {
    await updateVendor('v1', {
      orderImportFormat: 'us_foods',
      importDistributorNumber: '4147',
      importDepartment: '0',
      importCustomerNumbers: { 's1': '111', 's2': '222' },
    });
    expect(updateSpy).toHaveBeenCalledWith({
      order_import_format: 'us_foods',
      import_distributor_number: '4147',
      import_department: '0',
      import_customer_numbers: { 's1': '111', 's2': '222' },
    });
  });

  it('an empty customer-number map clears to null', async () => {
    await updateVendor('v1', { importCustomerNumbers: {} });
    expect(updateSpy).toHaveBeenCalledWith({ import_customer_numbers: null });
  });
});

describe('updateVendor — spec 131 extension-ordering + order page URL threading', () => {
  it('threads extensionOrdering → extension_ordering (boolean) into the UPDATE body', async () => {
    await updateVendor('v1', { extensionOrdering: true });
    expect(updateSpy).toHaveBeenCalledWith({ extension_ordering: true });
  });

  it('threads a false extensionOrdering (opt-out) — false !== undefined, so it persists', async () => {
    await updateVendor('v1', { extensionOrdering: false });
    expect(updateSpy).toHaveBeenCalledWith({ extension_ordering: false });
  });

  it('threads orderPageUrl → order_page_url into the UPDATE body', async () => {
    await updateVendor('v1', { orderPageUrl: 'https://www.samsclub.com/orders' });
    expect(updateSpy).toHaveBeenCalledWith({ order_page_url: 'https://www.samsclub.com/orders' });
  });

  it('an empty orderPageUrl clears to null', async () => {
    await updateVendor('v1', { orderPageUrl: '' });
    expect(updateSpy).toHaveBeenCalledWith({ order_page_url: null });
  });

  it('omit-key-to-skip: an update touching neither field writes neither key', async () => {
    await updateVendor('v1', { phone: '555-2000' });
    const body = updateSpy.mock.calls[0][0];
    expect('extension_ordering' in body).toBe(false);
    expect('order_page_url' in body).toBe(false);
  });
});

describe('updateVendor — surfaces backend errors (optimistic-revert contract)', () => {
  it('throws when the UPDATE returns an error (previously swallowed → fake success)', async () => {
    abortSpy.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    await expect(updateVendor('v1', { accountNumber: '12345678' })).rejects.toEqual({
      message: 'permission denied',
    });
  });

  it('resolves normally when the UPDATE succeeds', async () => {
    await expect(updateVendor('v1', { name: 'US FOOD' })).resolves.toBeUndefined();
  });
});
