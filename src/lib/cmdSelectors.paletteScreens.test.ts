// src/lib/cmdSelectors.paletteScreens.test.ts — spec 137 follow-up.
//
// Regression guard for the ⌘K palette's screen entries after the Reorder +
// Purchase-orders unification (test-engineer flagged the alias mechanism as
// untested). Locks:
//   - three entries route to the unified 'Ordering' section, labeled with the
//     ordering / reorder / purchaseOrders keys, so searching the words
//     "reorder" or "purchase orders" still surfaces the destination;
//   - the alias discriminator keeps their ids (React keys) unique;
//   - no screen entry routes to the retired 'Reorder' / 'PurchaseOrders'
//     section names (they would land on ComingSoon).

// Stub `./supabase` — cmdSelectors.ts transitively imports useStore → db.ts →
// supabase.ts, which calls createClient() at module-load time and crashes
// without EXPO_PUBLIC_SUPABASE_URL. Mirrors cmdSelectors.eodAndStreak.test.ts.
jest.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(),
    })),
    removeChannel: jest.fn(),
    from: jest.fn(),
    rpc: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

import { getCommandPaletteIndex } from './cmdSelectors';

const emptyIndexArgs = {
  inventory: [],
  recipes: [],
  prepRecipes: [],
  vendors: [],
  auditLog: [],
} as any;

describe('getCommandPaletteIndex — unified Ordering screen entries (spec 137/138)', () => {
  const screens = () =>
    getCommandPaletteIndex(emptyIndexArgs).filter((e: any) => e.type === 'screen');

  it('emits two entries routing to Ordering, labeled ordering / reorder (spec 138 dropped the pos alias)', () => {
    const ordering = screens().filter((e: any) => e.route.name === 'Ordering');
    expect(ordering).toHaveLength(2);
    // The default translate is identity over the label KEY, so searching the
    // rendered labels for "reorder" maps to this key. The retired `pos` alias /
    // purchaseOrders label is gone with the PO surface (spec 138).
    expect(ordering.map((e: any) => e.label).sort()).toEqual([
      'sidebar.items.ordering',
      'sidebar.items.reorder',
    ]);
  });

  it('gives the two Ordering entries unique ids via the alias discriminator', () => {
    const ids = screens()
      .filter((e: any) => e.route.name === 'Ordering')
      .map((e: any) => e.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('screen:Ordering');
    expect(ids).toContain('screen:Ordering:reorder');
    // Spec 138 — the pos alias entry is retired.
    expect(ids).not.toContain('screen:Ordering:pos');
  });

  it('routes NO screen entry to the retired Reorder / PurchaseOrders / Receiving section names', () => {
    const retired = screens().filter(
      (e: any) =>
        e.route.name === 'Reorder' ||
        e.route.name === 'PurchaseOrders' ||
        e.route.name === 'Receiving',
    );
    expect(retired).toEqual([]);
  });

  it('keeps every screen-entry id unique across the whole screen list', () => {
    const ids = screens().map((e: any) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
