// src/utils/orderChannel.test.ts — Spec 149 AC-14 / AC-28 (jest track).
//
// Pins the EIGHT-row precedence truth table of `resolveOrderChannel` (design
// §1.1 / §7.2). The SQL sibling `public.vendor_order_channel(uuid)` is pinned
// by `supabase/tests/vendor_order_channel.test.sql` against the SAME fixture —
// if you change a row here, change it there in the same PR.
//
// The load-bearing row is #2: BJ's with `order_channel='instacart'` but NO
// retailer key must stay on the live-tuned spec-131/132 cart-filler. A later
// edit that silently reroutes it is exactly what this suite exists to catch.

import { resolveOrderChannel, isOrderChannel, ORDER_CHANNELS } from './orderChannel';

describe('resolveOrderChannel — AC-14 precedence truth table', () => {
  it('row 1 — instacart + retailer key beats extension_ordering', () => {
    expect(
      resolveOrderChannel({
        orderChannel: 'instacart',
        instacartRetailerKey: 'sams_club',
        extensionOrdering: true,
      }),
    ).toBe('instacart');
  });

  it('row 2 — instacart with NO retailer key falls back to the cart-filler', () => {
    expect(
      resolveOrderChannel({
        orderChannel: 'instacart',
        instacartRetailerKey: null,
        extensionOrdering: true,
      }),
    ).toBe('extension');
    expect(
      resolveOrderChannel({
        orderChannel: 'instacart',
        instacartRetailerKey: '',
        extensionOrdering: true,
      }),
    ).toBe('extension');
  });

  it('row 3 — instacart, no key, no extension flag ⇒ manual', () => {
    expect(
      resolveOrderChannel({
        orderChannel: 'instacart',
        instacartRetailerKey: '',
        extensionOrdering: false,
      }),
    ).toBe('manual');
  });

  it('row 4 — webstaurant loses to extension_ordering', () => {
    expect(
      resolveOrderChannel({ orderChannel: 'webstaurant', extensionOrdering: true }),
    ).toBe('extension');
  });

  it('row 5 — webstaurant without the flag resolves to webstaurant', () => {
    expect(
      resolveOrderChannel({ orderChannel: 'webstaurant', extensionOrdering: false }),
    ).toBe('webstaurant');
  });

  it('row 6 — order_channel="extension" can NOT contradict a false flag', () => {
    expect(
      resolveOrderChannel({ orderChannel: 'extension', extensionOrdering: false }),
    ).toBe('manual');
  });

  it('row 7 — unset column + flag ⇒ extension', () => {
    expect(resolveOrderChannel({ orderChannel: null, extensionOrdering: true })).toBe(
      'extension',
    );
  });

  it('row 8 — unset column, no flag ⇒ manual', () => {
    expect(resolveOrderChannel({ orderChannel: null, extensionOrdering: false })).toBe(
      'manual',
    );
    expect(resolveOrderChannel({ extensionOrdering: false })).toBe('manual');
  });

  it('a whitespace-only retailer key does not enable the Instacart path', () => {
    // Mirrors the SQL `nullif(btrim(coalesce(key,'')),'')` guard.
    expect(
      resolveOrderChannel({
        orderChannel: 'instacart',
        instacartRetailerKey: '   ',
        extensionOrdering: false,
      }),
    ).toBe('manual');
  });

  it('an unknown order_channel string degrades to the flag/manual arms', () => {
    expect(
      resolveOrderChannel({ orderChannel: 'mealme', extensionOrdering: true }),
    ).toBe('extension');
    expect(
      resolveOrderChannel({ orderChannel: 'mealme', extensionOrdering: false }),
    ).toBe('manual');
  });
});

describe('isOrderChannel', () => {
  it('accepts exactly the four literals', () => {
    for (const c of ORDER_CHANNELS) expect(isOrderChannel(c)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isOrderChannel('')).toBe(false);
    expect(isOrderChannel(null)).toBe(false);
    expect(isOrderChannel(undefined)).toBe(false);
    expect(isOrderChannel('Instacart')).toBe(false);
    expect(isOrderChannel(3)).toBe(false);
  });
});
