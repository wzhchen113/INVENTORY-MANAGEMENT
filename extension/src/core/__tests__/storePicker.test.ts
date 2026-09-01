// Spec 162 (rev 2) — the pure half of the shipping-address picker.
//
// The bug this module was extracted to make impossible: the popup showing
// "Frederick" over Towson's address. The label and the enforced address now come
// from ONE call, so every case below pins both at once — if they could ever
// disagree, `previewText` and `address` would have to be computed separately,
// which is precisely what this shape forbids.

import { describe, expect, it } from 'vitest';
import { describeStoreSelection, preferredStoreId } from '../storePicker';
import type { StoreAddress } from '../../lib/types';

const TOWSON: StoreAddress = {
  storeId: 's-towson',
  storeName: 'Towson',
  address: '1234 York Rd, Towson MD 21204',
  hasAddress: true,
};
const FREDERICK: StoreAddress = {
  storeId: 's-frederick',
  storeName: 'Frederick',
  address: '2339 Frederick Ave, Baltimore MD 21223',
  hasAddress: true,
};
const NO_ADDRESS: StoreAddress = {
  storeId: 's-new',
  storeName: 'Brand New',
  address: null,
  hasAddress: false,
};
const STORES = [TOWSON, FREDERICK, NO_ADDRESS];

describe('describeStoreSelection — the label IS the enforced address', () => {
  it('resolves the picked store to its own address', () => {
    expect(describeStoreSelection(STORES, 's-towson')).toEqual({
      storeId: 's-towson',
      address: TOWSON.address,
      previewText: TOWSON.address,
      isError: false,
    });
  });

  it('follows the pick to a DIFFERENT store — the regression this exists for', () => {
    const selection = describeStoreSelection(STORES, 's-frederick');
    expect(selection.address).toBe(FREDERICK.address);
    // The exact failure seen in the popup: Frederick selected, Towson's address
    // displayed. Both halves come from one call, so both move together.
    expect(selection.previewText).toBe(FREDERICK.address);
    expect(selection.previewText).not.toContain('Towson');
  });

  it.each(STORES.map((s) => [s.storeName, s.storeId] as const))(
    'the preview and the enforced address never disagree — %s',
    (_name, id) => {
      const selection = describeStoreSelection(STORES, id);
      // Either the address is usable and IS the label, or it is null and the
      // label explains why. There is no third state.
      if (selection.address !== null) {
        expect(selection.previewText).toBe(selection.address);
        expect(selection.isError).toBe(false);
      } else {
        expect(selection.isError).toBe(true);
      }
    },
  );

  it('an addressless store is unusable AND names the fix', () => {
    const selection = describeStoreSelection(STORES, 's-new');
    expect(selection.address).toBeNull();
    expect(selection.isError).toBe(true);
    expect(selection.previewText).toContain('Brand New');
    expect(selection.previewText).toContain('add one on the store');
  });

  it('treats a whitespace-only address as no address, whatever hasAddress claims', () => {
    // Defence against a hasAddress that disagrees with the column — the address
    // is what gets enforced, so the address is what gets judged.
    const lying: StoreAddress = { storeId: 'x', storeName: 'Liar', address: '   ', hasAddress: true };
    const selection = describeStoreSelection([lying], 'x');
    expect(selection.address).toBeNull();
    expect(selection.isError).toBe(true);
  });

  it.each([null, undefined, '', 'no-such-store'])('handles a missing selection (%s)', (id) => {
    const selection = describeStoreSelection(STORES, id as string | null);
    expect(selection).toEqual({
      storeId: null,
      address: null,
      previewText: 'Pick the store this order ships to.',
      isError: false,
    });
  });
});

describe('preferredStoreId — saved pick beats the PO’s store', () => {
  it('prefers the operator’s saved pick', () => {
    expect(preferredStoreId(STORES, 's-frederick', 's-towson')).toBe('s-frederick');
  });

  it('falls back to the PO’s store when there is no saved pick', () => {
    expect(preferredStoreId(STORES, null, 's-towson')).toBe('s-towson');
  });

  it('ignores a saved pick that is no longer a visible store', () => {
    // Access revoked, or the store was deleted. Falling through to the PO's
    // store beats leaving the picker on a store that isn't in the list.
    expect(preferredStoreId(STORES, 's-gone', 's-towson')).toBe('s-towson');
  });

  it('ignores a PO store that is not in the list either, and takes the first', () => {
    expect(preferredStoreId(STORES, 's-gone', 's-also-gone')).toBe('s-towson');
  });

  it('returns null when there are no stores at all', () => {
    expect(preferredStoreId([], 's-towson', 's-towson')).toBeNull();
  });
});
