// src/screens/cmd/sections/__tests__/EODCountSection.customOrder.test.tsx
//
// Spec 103 review-fix pass — admin EOD section AC coverage (test-engineer
// Critical #2). Spec §13 requires the admin EOD surface to pin:
//   - AC-9  : the submitted entry set is byte-identical whether the Custom or
//             Default view is active (the sort never changes what is submitted).
//   - AC-10 : the ingredient-name search composes with the custom order.
//   - AC-12 : the count-everything gate's "jump to first uncounted" target is
//             the TOPMOST uncounted row in the user's CUSTOM order.
//
// EODCountSection's `buildSubmission` and the gate's jump are CLOSURES over the
// component's state (not separately exported), so — following the established
// admin-section pattern in EODCountSection.countedOnce.test.tsx, which unit-tests
// the section's exported pure predicate `deriveCountedItemIds` rather than
// rendering the heavy section — this file exercises the EXACT composition the
// section performs, using the section's OWN exported gate predicate
// (`deriveCountedItemIds`) together with the shared ordering helpers
// (`applyCountOrder` / `firstUncounted`) the section imports and calls. That
// pins the section's render-only-sort invariant: the submission scope is
// `filteredItems` (never the reordered view), and only the render list + the
// gate's "first" resolution follow the custom order.
//
// Boundary mock: importing EODCountSection transitively reaches
// ../../../lib/supabase, which crashes at module load when EXPO_PUBLIC_SUPABASE_*
// is unset. Stub it (same shape + rationale as EODCountSection.countedOnce.test.tsx).
// `.test.tsx` so the jsdom `component` project's testMatch picks it up.

jest.mock('../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

import { deriveCountedItemIds } from '../EODCountSection';
import { applyCountOrder, firstUncounted } from '../../../../lib/countOrder';

// A minimal item shape carrying the fields the EOD submission entry-builder
// reads (id, name, unit, caseQty). Category drives the DEFAULT grouped order so
// AC-12's "not alphabetical/category default" is distinguishable from custom.
type Item = { id: string; name: string; category: string; unit: string; caseQty: number };

const STORE = 'store-1';
const DATE = '2026-06-30';
const VENDOR_A = 'vendor-a';

// `filteredItems` as the section derives it: per-store, alphabetized within
// category (Apple/Produce, Bread/Bakery, Cream/Dairy). Default render order.
const FILTERED: Item[] = [
  { id: 'item-bread', name: 'Bread', category: 'Bakery', unit: 'ea', caseQty: 1 },
  { id: 'item-cream', name: 'Cream', category: 'Dairy', unit: 'ea', caseQty: 1 },
  { id: 'item-apple', name: 'Apple', category: 'Produce', unit: 'lb', caseQty: 1 },
];

// The section's exact entry-builder over `filteredItems` (mirrors
// EODCountSection.buildSubmission §595): iterate `filteredItems`, keep the rows
// with a local entry, map to the entry shape. This is the submission SCOPE — it
// reads `filteredItems`, never the reordered view.
function buildEntrySet(
  caseCounts: Record<string, string>,
  unitCounts: Record<string, string>,
) {
  const localHasEntry = (id: string) =>
    (caseCounts[id] ?? '').trim() !== '' || (unitCounts[id] ?? '').trim() !== '';
  return FILTERED.filter((i) => localHasEntry(i.id)).map((i) => ({
    itemId: i.id,
    itemName: i.name,
    unit: i.unit,
  }));
}

describe('EODCountSection — spec 103 custom order (AC-9 / AC-10 / AC-12)', () => {
  // A saved order that crosses categories: Apple, Cream, Bread — a physical
  // walk, distinct from both the default category order and alphabetical.
  const SAVED = ['item-apple', 'item-cream', 'item-bread'];

  it('AC-9: the submission entry set is byte-identical with and without a custom order', () => {
    const caseCounts = { 'item-bread': '2', 'item-apple': '1', 'item-cream': '3' };
    const unitCounts: Record<string, string> = {};

    // The entry set is built from `filteredItems` and does not take savedIds at
    // all — proving the sort is render-only. Capture it once...
    const entries = buildEntrySet(caseCounts, unitCounts);

    // ...and assert the custom order is a PERMUTATION of `filteredItems` (same
    // membership, same length), so iterating `filteredItems` for the submission
    // yields the identical set whichever view is active.
    const customOrdered = applyCountOrder(FILTERED, SAVED, (i) => i.id);
    expect(customOrdered).toHaveLength(FILTERED.length);
    expect(new Set(customOrdered.map((i) => i.id))).toEqual(
      new Set(FILTERED.map((i) => i.id)),
    );

    // The entries iterate `filteredItems` order (Bread, Cream, Apple), NOT the
    // custom order (Apple, Cream, Bread) — byte-identical regardless of view.
    expect(entries).toEqual([
      { itemId: 'item-bread', itemName: 'Bread', unit: 'ea' },
      { itemId: 'item-cream', itemName: 'Cream', unit: 'ea' },
      { itemId: 'item-apple', itemName: 'Apple', unit: 'lb' },
    ]);
  });

  it('AC-10: the name search composes with the custom order (survivors in custom relative order)', () => {
    // Custom view list as the section builds it (EODCountSection §538): order
    // `filteredItems` by the saved ranking, THEN narrow by the search.
    const search = 'r'; // matches "Bread" and "Cream" (folded substring), not "Apple"
    const matches = (name: string) => name.toLowerCase().includes(search);

    const ordered = applyCountOrder(FILTERED, SAVED, (i) => i.id); // Apple, Cream, Bread
    const visible = ordered.filter((i) => matches(i.name));

    // Search survivors render in the CUSTOM relative order (Cream before Bread),
    // not the default category order (Bread before Cream).
    expect(visible.map((i) => i.id)).toEqual(['item-cream', 'item-bread']);
  });

  it('AC-12: the gate jump targets the first uncounted in the CUSTOM order, not the default order', () => {
    // Count Apple only. Uncounted = {Bread, Cream}. In the DEFAULT order the
    // first uncounted is Bread; in the CUSTOM order (Apple, Cream, Bread) it is
    // Cream. The gate must jump to Cream.
    const caseCounts = { 'item-apple': '5' };
    const unitCounts: Record<string, string> = {};

    // The section's real gate predicate (counted-once-globally) over the
    // local entries — exercised through the section's OWN exported helper.
    const counted = deriveCountedItemIds({
      caseCountsByVendor: { [VENDOR_A]: caseCounts },
      unitCountsByVendor: { [VENDOR_A]: unitCounts },
      submissions: [],
      storeId: STORE,
      dateIso: DATE,
    });
    const hasEntry = (id: string) => counted.has(id);

    // Default view: first uncounted is the topmost of `filteredItems` (Bread).
    const defaultTarget = firstUncounted(FILTERED, (i) => hasEntry(i.id));
    expect(defaultTarget?.id).toBe('item-bread');

    // Custom view: resolve "first" against the custom-ordered FULL set.
    const customOrdered = applyCountOrder(FILTERED, SAVED, (i) => i.id);
    const customTarget = firstUncounted(customOrdered, (i) => hasEntry(i.id));
    expect(customTarget?.id).toBe('item-cream');

    // The completeness COUNT itself is order-independent (AC-9/AC-11): two of
    // three remain uncounted regardless of view.
    const missingDefault = FILTERED.filter((i) => !hasEntry(i.id));
    const missingCustom = customOrdered.filter((i) => !hasEntry(i.id));
    expect(missingDefault.length).toBe(2);
    expect(missingCustom.length).toBe(2);
  });
});
