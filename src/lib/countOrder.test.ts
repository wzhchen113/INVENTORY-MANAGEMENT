// src/lib/countOrder.test.ts — Spec 103.
//
// Pure-function unit tests for the per-user custom count-screen order. Lives in
// the fast node-env project (no React / DOM — countOrder.ts is dependency-free).
//
// Covers the design's apply-order contract (OQ-3):
//   - ranked items first in saved order, unranked appended in default order;
//   - deleted ids (in savedIds but not in items) ignored;
//   - null / empty saved order = identity in default input order;
//   - duplicate savedIds de-duplicated, no input item ever dropped (AC-14);
// and `firstUncounted` resolving the gate jump against the on-screen order
// (AC-12).

import { applyCountOrder, firstUncounted } from './countOrder';

// Minimal item shape — only an id (the field the apply function keys on) plus a
// `counted` flag for the firstUncounted tests.
type Item = { id: string; counted?: boolean };
const item = (id: string, counted = false): Item => ({ id, counted });
const idOf = (i: Item) => i.id;
const ids = (arr: Item[]) => arr.map(idOf);

describe('applyCountOrder', () => {
  test('orders ranked items by the saved id array, then appends unranked in default order (OQ-3)', () => {
    // Default (input) order: a, b, c, d. Saved order ranks c, a only.
    const items = [item('a'), item('b'), item('c'), item('d')];
    const saved = ['c', 'a'];
    // Expect: ranked (c, a) first in saved order, then unranked (b, d) in their
    // default relative order.
    expect(ids(applyCountOrder(items, saved, idOf))).toEqual(['c', 'a', 'b', 'd']);
  });

  test('ignores saved ids that reference now-deleted items (OQ-3)', () => {
    // 'x' and 'z' were ranked but no longer exist in items.
    const items = [item('a'), item('b'), item('c')];
    const saved = ['x', 'c', 'z', 'a'];
    // 'x'/'z' dropped; ranked (c, a); unranked tail (b).
    expect(ids(applyCountOrder(items, saved, idOf))).toEqual(['c', 'a', 'b']);
  });

  test('null saved order returns the input order unchanged (default view)', () => {
    const items = [item('a'), item('b'), item('c')];
    expect(ids(applyCountOrder(items, null, idOf))).toEqual(['a', 'b', 'c']);
  });

  test('undefined saved order returns the input order unchanged', () => {
    const items = [item('a'), item('b'), item('c')];
    expect(ids(applyCountOrder(items, undefined, idOf))).toEqual(['a', 'b', 'c']);
  });

  test('empty saved order returns the input order unchanged', () => {
    const items = [item('a'), item('b'), item('c')];
    expect(ids(applyCountOrder(items, [], idOf))).toEqual(['a', 'b', 'c']);
  });

  test('returns a fresh array, not an alias of the input', () => {
    const items = [item('a'), item('b')];
    const out = applyCountOrder(items, null, idOf);
    expect(out).not.toBe(items);
    expect(ids(out)).toEqual(['a', 'b']);
  });

  test('all items ranked — pure reordering, no tail', () => {
    const items = [item('a'), item('b'), item('c')];
    const saved = ['c', 'b', 'a'];
    expect(ids(applyCountOrder(items, saved, idOf))).toEqual(['c', 'b', 'a']);
  });

  test('new / unranked items append in the screen default order and never disappear (AC-14)', () => {
    // 'e' and 'f' are newly-added items the user never placed. Default order
    // among the unranked tail is the input order: e then f.
    const items = [item('a'), item('e'), item('b'), item('f')];
    const saved = ['b', 'a'];
    const out = applyCountOrder(items, saved, idOf);
    expect(ids(out)).toEqual(['b', 'a', 'e', 'f']);
    // Belt-and-braces: every input item is present exactly once (none dropped).
    expect(out).toHaveLength(items.length);
    expect(new Set(ids(out))).toEqual(new Set(['a', 'b', 'e', 'f']));
  });

  test('duplicate saved ids are de-duplicated (first occurrence wins), no item emitted twice', () => {
    const items = [item('a'), item('b'), item('c')];
    const saved = ['b', 'b', 'a', 'b'];
    const out = applyCountOrder(items, saved, idOf);
    expect(ids(out)).toEqual(['b', 'a', 'c']);
    expect(out).toHaveLength(3);
  });

  test('empty item set yields an empty result regardless of saved order', () => {
    expect(applyCountOrder<Item>([], ['a', 'b'], idOf)).toEqual([]);
  });

  test('preserves the SAME object references from the input (render stability)', () => {
    const a = item('a');
    const b = item('b');
    const out = applyCountOrder([a, b], ['b', 'a'], idOf);
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(a);
  });
});

describe('firstUncounted', () => {
  const isCounted = (i: Item) => i.counted === true;

  test('returns the first uncounted item in the GIVEN order (custom order — AC-12)', () => {
    // Simulate a custom order where 'c' is first on screen and uncounted, even
    // though 'a' is alphabetically/default first. The gate must jump to 'c'.
    const ordered = [item('c', false), item('a', true), item('b', false)];
    expect(firstUncounted(ordered, isCounted)?.id).toBe('c');
  });

  test('skips counted items and returns the first failing one', () => {
    const ordered = [item('a', true), item('b', true), item('c', false), item('d', false)];
    expect(firstUncounted(ordered, isCounted)?.id).toBe('c');
  });

  test('returns null when every item is counted', () => {
    const ordered = [item('a', true), item('b', true)];
    expect(firstUncounted(ordered, isCounted)).toBeNull();
  });

  test('returns null for an empty list', () => {
    expect(firstUncounted<Item>([], isCounted)).toBeNull();
  });

  test('the jump target follows the custom order, not the default order (AC-12 regression)', () => {
    // Default order is a, b, c, d. Apply a custom order that puts d, b first.
    const items = [item('a', true), item('b', false), item('c', true), item('d', false)];
    const ordered = applyCountOrder(items, ['d', 'b'], idOf);
    // In the custom order [d, b, a, c], the first uncounted is 'd' — NOT 'b'
    // (which would be first uncounted in the DEFAULT order). This is the exact
    // behavior AC-12 pins: the gate jumps to the topmost uncounted as the user
    // currently sees the rows.
    expect(firstUncounted(ordered, isCounted)?.id).toBe('d');
  });
});
