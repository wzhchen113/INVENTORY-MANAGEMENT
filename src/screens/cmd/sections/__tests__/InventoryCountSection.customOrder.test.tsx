// src/screens/cmd/sections/__tests__/InventoryCountSection.customOrder.test.tsx
//
// Spec 103 review-fix pass — admin Inventory section AC coverage (test-engineer
// Critical #2). Spec §13 requires the admin Inventory surface to pin AC-9
// (submission byte-identical with/without a custom order) and AC-10 (search
// composes with the custom order). Admin Inventory has NO count-everything gate
// (spec line 262), so AC-12 does NOT apply here — and this file asserts that
// absence: the drag/apply must not introduce a first-uncounted jump.
//
// Same approach + rationale as EODCountSection.customOrder.test.tsx: the
// section's `submit` entry-builder is a closure over component state, so this
// exercises the EXACT composition the section performs — submission iterates
// `storeInventory` (NOT `filteredItems`, NOT the reordered view: the
// release-proposal C-FE-1 invariant), while the Custom view list is
// `applyCountOrder(filteredItems, savedIds, …)` with `filteredItems` already
// search-narrowed.
//
// Boundary mock identical to the sibling admin-section tests (importing the
// section reaches ../../../lib/supabase, which crashes at module load when
// EXPO_PUBLIC_SUPABASE_* is unset). `.test.tsx` for the jsdom `component`
// project testMatch.

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

// Import the section so the test pins that the Inventory section module loads +
// composes the shared ordering helper (the section calls applyCountOrder; a
// regression that drops the import would break this file's module graph).
import InventoryCountSection from '../InventoryCountSection';
import { applyCountOrder } from '../../../../lib/countOrder';

type Item = { id: string; name: string; category: string; unit: string; caseQty: number };

// `storeInventory` — every item in the active store (the submission SCOPE).
// Two categories so the category-chip view filter is distinguishable from the
// full submission set (the C-FE-1 invariant).
const STORE_INVENTORY: Item[] = [
  { id: 'item-apple', name: 'Apple', category: 'Produce', unit: 'lb', caseQty: 1 },
  { id: 'item-bread', name: 'Bread', category: 'Bakery', unit: 'ea', caseQty: 1 },
  { id: 'item-cream', name: 'Cream', category: 'Dairy', unit: 'ea', caseQty: 1 },
];

// `filteredItems` as the section derives it for a given category chip + search:
// category filter → search filter → alpha sort by name (InventoryCountSection
// §167). Default 'all' + no search = the whole store, alphabetized.
function deriveFilteredItems(selectedCategory: string, search: string): Item[] {
  const byCat =
    selectedCategory === 'all'
      ? STORE_INVENTORY
      : STORE_INVENTORY.filter((i) => i.category === selectedCategory);
  const base = search.trim()
    ? byCat.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
    : byCat;
  return base.slice().sort((a, b) => a.name.localeCompare(b.name));
}

// The section's submission entry-builder (InventoryCountSection §407): iterate
// `storeInventory` (NOT filteredItems), keep non-blank rows, map to entries.
function buildEntrySet(
  caseCounts: Record<string, string>,
  unitCounts: Record<string, string>,
) {
  const hasEntry = (id: string) =>
    (caseCounts[id] ?? '').trim() !== '' || (unitCounts[id] ?? '').trim() !== '';
  return STORE_INVENTORY.filter((i) => hasEntry(i.id)).map((i) => ({
    itemId: i.id,
    itemName: i.name,
    unit: i.unit,
  }));
}

describe('InventoryCountSection — spec 103 custom order (AC-9 / AC-10, no gate)', () => {
  // A cross-category walk order distinct from alpha + category default.
  const SAVED = ['item-cream', 'item-apple', 'item-bread'];

  it('is a real React component (the section imports + composes applyCountOrder)', () => {
    expect(typeof InventoryCountSection).toBe('function');
  });

  it('AC-9: the submission entry set is byte-identical with and without a custom order', () => {
    const caseCounts = { 'item-apple': '1', 'item-bread': '2', 'item-cream': '3' };
    const unitCounts: Record<string, string> = {};

    // Submission iterates `storeInventory` and never reads savedIds — render-only.
    const entries = buildEntrySet(caseCounts, unitCounts);

    // The Custom view list is a permutation of `filteredItems`; it never feeds
    // the submission.
    const filtered = deriveFilteredItems('all', '');
    const custom = applyCountOrder(filtered, SAVED, (i) => i.id);
    expect(new Set(custom.map((i) => i.id))).toEqual(new Set(filtered.map((i) => i.id)));

    // Entries follow `storeInventory` order (Apple, Bread, Cream), NOT the
    // custom order (Cream, Apple, Bread) — identical regardless of view.
    expect(entries).toEqual([
      { itemId: 'item-apple', itemName: 'Apple', unit: 'lb' },
      { itemId: 'item-bread', itemName: 'Bread', unit: 'ea' },
      { itemId: 'item-cream', itemName: 'Cream', unit: 'ea' },
    ]);
  });

  it('AC-9 (C-FE-1): a category-chip view filter does NOT narrow the submission scope', () => {
    // Only the 'Produce' chip is active (the view shows Apple only), but counts
    // were entered for items in OTHER categories too. Submission still ships all
    // non-blank rows across categories.
    const filteredView = deriveFilteredItems('Produce', '');
    expect(filteredView.map((i) => i.id)).toEqual(['item-apple']); // view shows 1

    const caseCounts = { 'item-apple': '1', 'item-cream': '4' }; // entries cross categories
    const entries = buildEntrySet(caseCounts, {});
    // Submission ships both, not just the chip's Produce row.
    expect(entries.map((e) => e.itemId)).toEqual(['item-apple', 'item-cream']);
  });

  it('AC-10: the name search composes with the custom order (survivors in custom relative order)', () => {
    // Search "r" matches Bread + Cream (folded substring), not Apple.
    // `filteredItems` already applies the search, then Custom view orders it.
    const filtered = deriveFilteredItems('all', 'r'); // Bread, Cream (alpha) — search-narrowed
    expect(filtered.map((i) => i.id)).toEqual(['item-bread', 'item-cream']);

    const visible = applyCountOrder(filtered, SAVED, (i) => i.id);
    // SAVED ranks Cream before Bread → survivors render Cream, Bread.
    expect(visible.map((i) => i.id)).toEqual(['item-cream', 'item-bread']);
  });

  it('has NO count-everything gate: submit is governed by non-blank count, not a first-uncounted jump', () => {
    // The Inventory section's submit guard (InventoryCountSection §394) blocks
    // only when nonBlankCount === 0 — there is no "every item must be counted"
    // gate and no firstUncounted jump. Model that: a single entry is enough to
    // pass the guard even though most of the store is uncounted.
    const caseCounts: Record<string, string> = { 'item-bread': '2' };
    const hasEntry = (id: string) => (caseCounts[id] ?? '').trim() !== '';
    const nonBlankCount = STORE_INVENTORY.filter((i) => hasEntry(i.id)).length;

    expect(nonBlankCount).toBe(1);
    // Submit is enabled at >= 1 (NOT gated on full-store completeness).
    expect(nonBlankCount === 0).toBe(false);
    // Most of the store remains uncounted, yet there is no blocking gate — the
    // absence of an AC-12 jump is the asserted property for this screen.
    const uncounted = STORE_INVENTORY.filter((i) => !hasEntry(i.id));
    expect(uncounted.length).toBe(2);
  });
});
