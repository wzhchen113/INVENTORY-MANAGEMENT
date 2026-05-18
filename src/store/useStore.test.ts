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
  updateRecipeI18n: jest.fn().mockResolvedValue(undefined),
  updatePrepRecipeI18n: jest.fn().mockResolvedValue(undefined),
  updateRecipeCategoryI18n: jest.fn().mockResolvedValue(undefined),
  updateIngredientCategoryI18n: jest.fn().mockResolvedValue(undefined),
}));

// ─── Imports (resolve mocks above) ───────────────────────────────────
import Toast from 'react-native-toast-message';
import { deleteUser } from '../lib/auth';
import { useStore } from './useStore';
import type { User } from '../types';

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
