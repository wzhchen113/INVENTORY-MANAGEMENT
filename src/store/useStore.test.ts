// src/store/useStore.test.ts
//
// Spec 033 — Zustand store-action harness + back-fill for the
// `deleteProfile` silent branch deferred by spec 029.
//
// Pattern (architect §3-§4):
//   - Mock the two collaborator modules `../lib/supabase` and `../lib/db`
//     so the store import chain doesn't crash on missing env or fire
//     real PostgREST calls. Mock `../lib/auth` to control the
//     dynamic-import boundary inside deleteProfile.
//   - jest.mock(...) is HOISTED above all import statements at compile
//     time. We declare mocks at the top of the file, then `import`
//     the mocked symbols back so the test can drive them via
//     `(deleteUser as jest.Mock).mockResolvedValue(...)`. Same shape as
//     src/lib/auth.test.ts.
//   - State isolation via snapshot-and-restore: capture the initial
//     state object once at module-eval, restore in beforeEach with
//     `useStore.setState(INITIAL_STATE, true)` (second arg = replace,
//     not merge — otherwise nested objects merge and reset is partial).
//   - Use the vanilla Zustand `getState()` / `setState()` API. No React
//     renderer, no `@testing-library/react-hooks`. Same precedent as
//     auth.test.ts (function-direct invocation, no hook wrapper).
//
// Dynamic-import-mock note:
//   The `deleteProfile` action in `useStore.ts:795` uses
//   `await import('../lib/auth')` (lazy-loaded for code-splitting on
//   web builds). `babel-preset-expo` preserves the expression rather
//   than transpiling it, and Node's native ESM loader would bypass
//   jest's module registry. The
//   [tests/babel-jest-dynamic-import.js](../../tests/babel-jest-dynamic-import.js)
//   transformer (wired in jest.config.js) rewrites `import('literal')`
//   to `Promise.resolve(require('literal'))` for the test pipeline so
//   the `jest.mock('../lib/auth', ...)` factory below DOES intercept
//   the dynamic import. No production-code change.
//
// Three test cases per architect §4 + spec §AC2.1:
//   (1) deleteProfile(id) [no opts] → success info-toast fires; cached
//       members list filtered; returns true.
//   (2) deleteProfile(id, { silent: true }) → no info-toast; cached
//       members list still filtered; returns true.
//   (3) deleteProfile(id, { silent: true }) when auth returns an error
//       → error toast still fires via notifyBackendError; cached list
//       UNCHANGED; returns false. Locks spec 029 §3 "error path
//       unchanged" guarantee — silent does NOT suppress error toasts.

// ─── Mocks (must precede any import of useStore.ts) ──────────────────
// Prevent supabase.ts from crashing on module-eval (it reads
// EXPO_PUBLIC_SUPABASE_URL at import time and crashes when unset; jest
// runs without .env). The store transitively imports supabase, so this
// stub is required even though the deleteProfile path itself never
// touches supabase.* directly.
jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      signOut: jest.fn(),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    from: jest.fn(),
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

// Stub the dynamic-import boundary inside deleteProfile
// (useStore.ts:795 — `const { deleteUser } = await import('../lib/auth')`).
// The dynamic-import test transformer (see header comment) rewrites
// that to `require('../lib/auth')`, which goes through jest's module
// registry and resolves to this factory.
jest.mock('../lib/auth', () => ({
  deleteUser: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
}));

// Stub the `import * as db from '../lib/db'` namespace import in
// useStore.ts. The deleteProfile path itself does NOT call any db.X,
// but other store init paths might fire during test setup or via
// promise chains from sibling actions; enumerate the minimal surface
// (returning safe-empty defaults) so a stray access doesn't TypeError.
// Add names here on demand if a future test reaches a new db.X.
jest.mock('../lib/db', () => ({
  fetchStores: jest.fn().mockResolvedValue([]),
  fetchAllForStore: jest.fn().mockResolvedValue({
    brand: null,
    catalogIngredients: [],
    inventory: [],
    recipes: [],
    prepRecipes: [],
    vendors: [],
    wasteLog: [],
    auditLog: [],
    eodSubmissions: [],
    posRecipeAliases: [],
    recipeCategories: [],
    ingredientCategories: [],
    ingredientConversions: [],
  }),
  cleanupOldRecords: jest.fn().mockResolvedValue(undefined),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  // Spec 040 P3 — new helpers the store imports. The deleteProfile
  // test path doesn't exercise these, but the import-level namespace
  // resolves to this mock and a stray reference would TypeError.
  updateCatalogIngredientI18n: jest.fn().mockResolvedValue(undefined),
  // Spec 122 — brand-wide scalar fan-out RPC wrapper. Default success shape;
  // per-test overridden to reject for the revert path.
  applyItemScalarsToBrand: jest.fn().mockResolvedValue({
    updatedCount: 3,
    skippedCount: 0,
    skippedStoreIds: [],
  }),
  updateRecipeI18n: jest.fn().mockResolvedValue(undefined),
  updatePrepRecipeI18n: jest.fn().mockResolvedValue(undefined),
  updateRecipeCategoryI18n: jest.fn().mockResolvedValue(undefined),
  updateIngredientCategoryI18n: jest.fn().mockResolvedValue(undefined),
}));

// ─── Imports (resolve mocks above) ───────────────────────────────────
import Toast from 'react-native-toast-message';
import { deleteUser } from '../lib/auth';
import { useStore } from './useStore';
import type { User, InventoryItem, IngredientConversion } from '../types';

// Snapshot the initial state object once. Zustand `setState(state, true)`
// in beforeEach restores this whole object — actions + data slices both —
// so action references stay stable across tests AND data slices reset to
// their declared defaults. The snapshot is opaque: this file never names
// an internal-only field directly, it just captures once and replaces.
const INITIAL_STATE = useStore.getState();

// Cast mocks to jest.Mock for cleaner per-test setup.
const deleteUserMock = deleteUser as jest.Mock;
const toastShowMock = (Toast as any).show as jest.Mock;

// Minimal valid User row used to seed the brandAdminsByBrandId map.
function makeUser(id: string, name: string): User {
  return {
    id,
    name,
    nickname: '',
    email: `${id}@example.com`,
    role: 'admin',
    stores: [],
    status: 'active',
    initials: name.slice(0, 2).toUpperCase(),
    color: '#000000',
  };
}

describe('deleteProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Replace, not merge — the second positional `true` is Zustand's
    // replace flag. Without it, nested objects (like
    // brandAdminsByBrandId) merge rather than reset.
    useStore.setState(INITIAL_STATE, true);
  });

  it('toasts info on success without opts, returns true, and clears cached members lists', async () => {
    deleteUserMock.mockResolvedValue({ error: null });
    const u1 = makeUser('u1', 'User One');
    const u2 = makeUser('u2', 'User Two');
    useStore.setState({
      brandAdminsByBrandId: { 'brand-1': [u1, u2] },
    });

    const result = await useStore.getState().deleteProfile('u1');

    expect(result).toBe(true);
    // Cached-list cleanup ran — u1 filtered out, u2 retained.
    expect(useStore.getState().brandAdminsByBrandId).toEqual({
      'brand-1': [u2],
    });
    // Info-toast fired with the spec 029-locked shape.
    expect(toastShowMock).toHaveBeenCalledTimes(1);
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text1: 'Profile deleted',
      }),
    );
  });

  it('does NOT fire the info-toast with { silent: true }, returns true, and still clears cached members lists', async () => {
    deleteUserMock.mockResolvedValue({ error: null });
    const u1 = makeUser('u1', 'User One');
    const u2 = makeUser('u2', 'User Two');
    useStore.setState({
      brandAdminsByBrandId: { 'brand-1': [u1, u2] },
    });

    const result = await useStore.getState().deleteProfile('u1', { silent: true });

    expect(result).toBe(true);
    // Cached-list cleanup still runs (silent only suppresses the toast,
    // not the cleanup).
    expect(useStore.getState().brandAdminsByBrandId).toEqual({
      'brand-1': [u2],
    });
    // No info-toast — the spec 029 silent branch.
    expect(toastShowMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'Profile deleted' }),
    );
  });

  it('surfaces the auth error via notifyBackendError regardless of { silent: true }, returns false, and does NOT clear cached members lists', async () => {
    // Spec 029 architect §3 lock-in — `silent` suppresses ONLY the
    // success info-toast. Error path is unconditional: notifyBackendError
    // still fires so the operator sees the refusal reason (e.g. the spec
    // 031 last-of-role guard's verbatim string).
    deleteUserMock.mockResolvedValue({
      error: 'cannot delete the last super_admin',
    });
    const u1 = makeUser('u1', 'User One');
    const u2 = makeUser('u2', 'User Two');
    const seeded = { 'brand-1': [u1, u2] };
    useStore.setState({ brandAdminsByBrandId: seeded });

    const result = await useStore.getState().deleteProfile('u1', { silent: true });

    expect(result).toBe(false);
    // The early-return preserves state — cached list is untouched.
    expect(useStore.getState().brandAdminsByBrandId).toEqual(seeded);
    // notifyBackendError fired with the verbatim refusal string.
    expect(toastShowMock).toHaveBeenCalledTimes(1);
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: 'Delete profile failed',
        text2: 'cannot delete the last super_admin',
      }),
    );
  });
});

// ─── Spec 044 — hydrateBrand no-persist action ───────────────────────
// Mirrors hydrateLocale / hydrateSidebarLayoutOverride. Pure sync
// `set({ brand })`; no DB write, no toast. Four cases pin the slice
// shape:
//   (1) seeds a brand row → slice reflects it on the next read
//   (2) accepts null → slice clears (super_admin / soft-deleted brand /
//       RLS-denied embed)
//   (3) pure local hydrator — no toast, no db.* call
//   (4) idempotent — calling twice with the same value is a no-op
//       (relevant because App.tsx fires it on every session-restore)
describe('hydrateBrand (spec 044)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState(INITIAL_STATE, true);
  });

  it('seeds the brand slice from the AuthResult shape', () => {
    expect(useStore.getState().brand).toBeNull();

    useStore.getState().hydrateBrand({ id: 'brand-1', name: '2AM PROJECT' });

    expect(useStore.getState().brand).toEqual({
      id: 'brand-1',
      name: '2AM PROJECT',
    });
  });

  it('accepts null to clear the slice (super_admin / soft-deleted / RLS-denied)', () => {
    useStore.setState({ brand: { id: 'brand-1', name: '2AM PROJECT' } });
    expect(useStore.getState().brand).not.toBeNull();

    useStore.getState().hydrateBrand(null);

    expect(useStore.getState().brand).toBeNull();
  });

  it('does not fire any side-effect toast or DB call (pure local hydrator)', () => {
    useStore.getState().hydrateBrand({ id: 'brand-1', name: '2AM PROJECT' });

    // Pure local hydrator — no info / error toast.
    expect(toastShowMock).not.toHaveBeenCalled();
    // No db.* mock should fire either — assert against a representative
    // helper from the file-level db mock. Locks the "pure local set()"
    // contract: any future refactor that accidentally fan-outs to a DB
    // call would surface here. fetchStores is representative because
    // every store-init code path eventually goes through it.
    const db = require('../lib/db');
    expect(db.fetchStores).not.toHaveBeenCalled();
    expect(db.fetchAllForStore).not.toHaveBeenCalled();
  });

  it('is idempotent — calling twice with the same value is a no-op', () => {
    // Relevant because App.tsx fires hydrateBrand on every session-restore,
    // including post-login refreshes that re-read the same profile row.
    useStore.getState().hydrateBrand({ id: 'brand-1', name: '2AM PROJECT' });
    const afterFirst = useStore.getState().brand;
    expect(afterFirst).toEqual({ id: 'brand-1', name: '2AM PROJECT' });

    useStore.getState().hydrateBrand({ id: 'brand-1', name: '2AM PROJECT' });
    const afterSecond = useStore.getState().brand;

    // Slice unchanged across the second call. Equality is structural —
    // pure `set({ brand })` may produce a new reference but the shape
    // must match.
    expect(afterSecond).toEqual(afterFirst);
  });
});

// ─── Spec 104 — getIngredientLineCost per-each regression (§8 R7) ─────────────
//
// Spec 104 flips the STORED `costPerUnit` from per-COUNTED-unit
// (case_price / case_qty) to per-EACH (case_price / (case_qty × sub_unit_size)).
// The governing constraint is that every recipe/BOM dollar figure stays
// UNCHANGED across the flip. This suite seeds the store with the NEW per-each
// costPerUnit and asserts the line dollar equals the PRE-FLIP dollar (computed by
// hand under the old per-counted-unit basis). It exercises ALL THREE branches of
// getIngredientLineCost — the function §8 R8 calls the highest-risk single
// function — each of which needed a different edit to preserve the invariant:
//   1. short-circuit (ing.unit === item.unit)        → `× subUnitSize` bridge added
//   2. standard conversion (recipe unit → sub-unit)  → the 2nd `/ subUnitSize` divide removed
//   3. abstract conversion (ingredient_conversions)  → `× subUnitSize` bridge into costPerBase
// A miss in any branch silently shifts recipe costs by sub_unit_size×.
describe('getIngredientLineCost — per-each basis (spec 104)', () => {
  const STORE_ID = 'store-1';

  // Minimal InventoryItem factory — only the fields getIngredientLineCost reads
  // carry meaning; the rest are inert defaults to satisfy the strict type.
  function makeItem(over: Partial<InventoryItem>): InventoryItem {
    return {
      id: 'item-x',
      catalogId: 'cat-x',
      name: 'X',
      category: 'misc',
      unit: 'each',
      costPerUnit: 0,
      currentStock: 0,
      parLevel: 0,
      averageDailyUsage: 0,
      safetyStock: 0,
      vendorId: '',
      vendorName: '',
      usagePerPortion: 0,
      lastUpdatedBy: '',
      lastUpdatedAt: '',
      eodRemaining: 0,
      storeId: STORE_ID,
      casePrice: 0,
      caseQty: 1,
      subUnitSize: 1,
      subUnitUnit: '',
      ...over,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState(INITIAL_STATE, true);
    useStore.setState({ currentStore: { id: STORE_ID, name: 'Store 1' } as any });
  });

  it('branch 1 (short-circuit, ing.unit === item.unit) bridges × subUnitSize', () => {
    // Item: bags of 10 each. casePrice 20, caseQty 4 → per-each = 20/(4×10) = 0.5.
    // Pre-flip cost_per_unit (per bag) = 20/4 = 5.0. Recipe "2 bag" (short-circuit).
    // Pre-flip dollar = 5.0 × 2 = 10.0.  New = 0.5 × 2 × 10 (bridge) = 10.0.
    useStore.setState({
      inventory: [makeItem({ catalogId: 'cat-bag', unit: 'bag', subUnitUnit: 'each', subUnitSize: 10, costPerUnit: 0.5 })],
    });
    const cost = useStore.getState().getIngredientLineCost({
      itemId: 'cat-bag', itemName: 'Bagged item', unit: 'bag', quantity: 2,
    } as any);
    expect(cost).toBeCloseTo(10.0, 6);
  });

  it('branch 1b (short-circuit, each-tracked item, subUnitSize=1) is a no-op bridge', () => {
    // Item tracked in each, subUnitSize 1. casePrice 12, caseQty 12 → per-each = 1.0.
    // Recipe "3 each". Pre-flip = 1.0 × 3 = 3.0.  New = 1.0 × 3 × 1 = 3.0.
    useStore.setState({
      inventory: [makeItem({ catalogId: 'cat-each', unit: 'each', subUnitSize: 1, costPerUnit: 1.0 })],
    });
    const cost = useStore.getState().getIngredientLineCost({
      itemId: 'cat-each', itemName: 'Each item', unit: 'each', quantity: 3,
    } as any);
    expect(cost).toBeCloseTo(3.0, 6);
  });

  it('branch 2 (standard conversion) drops the 2nd sub-unit divide', () => {
    // Item tracked in lbs, sub-unit oz (16 oz/lb). casePrice 32, caseQty 2 →
    // per-each (per oz) = 32/(2×16) = 1.0. Pre-flip cost_per_unit (per lb) = 16.0.
    // Recipe "8 oz". Pre-flip: (8/16) × 16 = 8.0.  New: 1.0 × 8 = 8.0.
    useStore.setState({
      inventory: [makeItem({ catalogId: 'cat-lb', unit: 'lbs', subUnitUnit: 'oz', subUnitSize: 16, costPerUnit: 1.0 })],
    });
    const cost = useStore.getState().getIngredientLineCost({
      itemId: 'cat-lb', itemName: 'Weighed item', unit: 'oz', quantity: 8,
    } as any);
    expect(cost).toBeCloseTo(8.0, 6);
  });

  it('branch 3 (abstract conversion, representative subUnitSize=1) is dollar-unchanged', () => {
    // Item tracked in each, no standard sub-unit, ingredient_conversion 1 each =
    // 400 g. casePrice 20, caseQty 10, sub 1 → per-each = 2.0 (== pre-flip per each).
    // Recipe "800 g". costPerBase = (2.0 × 1)/400 = 0.005/g. × 800 = 4.0.
    // Pre-flip: 2.0/400 × 800 = 4.0.
    const conv: IngredientConversion = {
      id: 'conv-1', inventoryItemId: 'cat-abs', purchaseUnit: 'each', baseUnit: 'g',
      conversionFactor: 400, netYieldPct: 100,
    } as IngredientConversion;
    useStore.setState({
      inventory: [makeItem({ catalogId: 'cat-abs', unit: 'each', subUnitUnit: '', subUnitSize: 1, costPerUnit: 2.0 })],
      ingredientConversions: [conv],
    });
    const cost = useStore.getState().getIngredientLineCost({
      itemId: 'cat-abs', itemName: 'Abstract item', unit: 'g', quantity: 800,
    } as any);
    expect(cost).toBeCloseTo(4.0, 6);
  });

  it('branch 3b (abstract conversion, subUnitSize>1) bridges × subUnitSize into costPerBase', () => {
    // Synthetic: subUnitSize 5 AND an abstract conversion (subUnitUnit non-standard
    // so grams can't convert to it → abstract branch fires). casePrice 50, caseQty
    // 2, sub 5 → per-each = 50/(2×5) = 5.0. Pre-flip cost_per_unit = 50/2 = 25.0.
    // conversion 1 each = 100 g. Recipe "200 g".
    // Pre-flip: costPerBase = 25.0/100 = 0.25/g × 200 = 50.0.
    // New: costPerBase = (5.0 × 5)/100 = 0.25/g × 200 = 50.0.
    const conv: IngredientConversion = {
      id: 'conv-2', inventoryItemId: 'cat-abs2', purchaseUnit: 'each', baseUnit: 'g',
      conversionFactor: 100, netYieldPct: 100,
    } as IngredientConversion;
    useStore.setState({
      inventory: [makeItem({ catalogId: 'cat-abs2', unit: 'each', subUnitUnit: '', subUnitSize: 5, costPerUnit: 5.0 })],
      ingredientConversions: [conv],
    });
    const cost = useStore.getState().getIngredientLineCost({
      itemId: 'cat-abs2', itemName: 'Abstract sub>1', unit: 'g', quantity: 200,
    } as any);
    expect(cost).toBeCloseTo(50.0, 6);
  });

  it('returns 0 when the recipe item resolves to no inventory row', () => {
    useStore.setState({ inventory: [] });
    const cost = useStore.getState().getIngredientLineCost({
      itemId: 'missing', itemName: 'Nope', unit: 'each', quantity: 5,
    } as any);
    expect(cost).toBe(0);
  });
});

// ─── Spec 122 — applyScalarsToAllStores brand-wide fan-out ─────────────────
//
// The catalog view holds every store's inventory_items row in the `inventory`
// slice, so the action optimistically patches par/cost/case_price on ALL rows
// for the catalog, fires db.applyItemScalarsToBrand, and reverts on failure.
// current_stock is NEVER touched (AC-5/AC-6).
describe('applyScalarsToAllStores (spec 122)', () => {
  const CAT = 'cat-fanout';
  function seedRow(over: Partial<InventoryItem>): InventoryItem {
    return {
      id: 'r', catalogId: CAT, name: 'Corn', category: 'produce', unit: 'each',
      costPerUnit: 1, currentStock: 0, parLevel: 0, averageDailyUsage: 0,
      safetyStock: 0, vendorId: '', vendorName: '', usagePerPortion: 0,
      lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, storeId: 's',
      casePrice: 10, caseQty: 1, subUnitSize: 1,
      ...over,
    } as InventoryItem;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState(INITIAL_STATE, true);
    // clearAllMocks wiped the default resolved value on the db wrapper.
    const db = require('../lib/db');
    (db.applyItemScalarsToBrand as jest.Mock).mockResolvedValue({
      updatedCount: 2, skippedCount: 1, skippedStoreIds: ['store-z'],
    });
  });

  it('optimistically overwrites par/cost/case_price on every row for the catalog, leaving current_stock untouched, and returns the summary', async () => {
    useStore.setState({
      currentStore: { id: 'store-1', name: 'Frederick' } as any,
      inventory: [
        seedRow({ id: 'r1', storeId: 'store-1', parLevel: 480, currentStock: 5, costPerUnit: 1, casePrice: 40 }),
        seedRow({ id: 'r2', storeId: 'store-2', parLevel: 4, currentStock: 99, costPerUnit: 2, casePrice: 50 }),
        // A different catalog — must NOT be touched.
        seedRow({ id: 'r3', catalogId: 'other', storeId: 'store-1', parLevel: 7, currentStock: 3 }),
      ],
    });

    const result = await useStore.getState().applyScalarsToAllStores(CAT, {
      parLevel: 480, costPerUnit: 9, casePrice: 40,
    });

    expect(result).toEqual({ updatedCount: 2, skippedCount: 1, skippedStoreIds: ['store-z'] });

    const inv = useStore.getState().inventory;
    const r1 = inv.find((i) => i.id === 'r1')!;
    const r2 = inv.find((i) => i.id === 'r2')!;
    const r3 = inv.find((i) => i.id === 'r3')!;

    // Both catalog rows fanned to the new scalars.
    expect(r1.parLevel).toBe(480);
    expect(r2.parLevel).toBe(480);
    expect(r1.costPerUnit).toBe(9);
    expect(r2.costPerUnit).toBe(9);
    expect(r1.casePrice).toBe(40);
    expect(r2.casePrice).toBe(40);
    // current_stock is NEVER overwritten.
    expect(r1.currentStock).toBe(5);
    expect(r2.currentStock).toBe(99);
    // The other catalog's row is untouched.
    expect(r3.parLevel).toBe(7);

    const db = require('../lib/db');
    expect(db.applyItemScalarsToBrand).toHaveBeenCalledWith(CAT, {
      parLevel: 480, costPerUnit: 9, casePrice: 40,
    });
  });

  it('reverts the optimistic patch and surfaces notifyBackendError on failure, returning null', async () => {
    const db = require('../lib/db');
    (db.applyItemScalarsToBrand as jest.Mock).mockRejectedValueOnce(new Error('rpc boom'));

    useStore.setState({
      currentStore: { id: 'store-1', name: 'Frederick' } as any,
      inventory: [
        seedRow({ id: 'r1', storeId: 'store-1', parLevel: 480, currentStock: 5, costPerUnit: 1, casePrice: 40 }),
        seedRow({ id: 'r2', storeId: 'store-2', parLevel: 4, currentStock: 99, costPerUnit: 2, casePrice: 50 }),
      ],
    });

    const result = await useStore.getState().applyScalarsToAllStores(CAT, {
      parLevel: 999, costPerUnit: 9, casePrice: 88,
    });

    expect(result).toBeNull();

    // Rows reverted to their pre-patch values.
    const inv = useStore.getState().inventory;
    const r1 = inv.find((i) => i.id === 'r1')!;
    const r2 = inv.find((i) => i.id === 'r2')!;
    expect(r1.parLevel).toBe(480);
    expect(r2.parLevel).toBe(4);
    expect(r1.casePrice).toBe(40);
    expect(r2.costPerUnit).toBe(2);

    // Error surfaced via notifyBackendError (→ toast).
    expect(toastShowMock).toHaveBeenCalled();
  });
});
