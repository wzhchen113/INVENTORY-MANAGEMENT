// src/store/useStore.removePoLine.test.ts — Spec 194 (kept-records delete hardening).
//
// Pins useStore.removePoLine's optimistic-then-revert path now that a refused
// po_items delete reaches it as a throw from db.deletePoItem (spec 194 D-5: the
// server refusal is a silent 0 rows, and deletePoItem turns that into an Error).
//   • Refused: poLinesById[poId] is restored to the pre-call lines, and the
//     "Remove PO line failed" error toast is shown via notifyBackendError.
//   • Happy path: the line stays removed and no toast is shown.
//
// notifyBackendError is module-local in useStore.ts, so it is observed through
// its two side-effects: Toast.show and console.warn. Mocking follows
// useStore.fillCartForVendor.spec138.test.ts.

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

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

jest.mock('../lib/auth', () => ({
  deleteUser: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/db', () => ({
  fetchStores: jest.fn().mockResolvedValue([]),
  fetchAllForStore: jest.fn().mockResolvedValue({
    brand: null, catalogIngredients: [], inventory: [], recipes: [], prepRecipes: [],
    vendors: [], wasteLog: [], auditLog: [], eodSubmissions: [], posRecipeAliases: [],
    recipeCategories: [], ingredientCategories: [], ingredientConversions: [],
  }),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  // Spec 194 — the assertion surface.
  deletePoItem: jest.fn().mockResolvedValue(true),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import type { PoLine } from '../lib/db';
import { useStore } from './useStore';

const INITIAL_STATE = useStore.getState();
const deleteMock = db.deletePoItem as jest.Mock;
const toastShow = Toast.show as jest.Mock;

const REFUSED_MESSAGE = 'PO line was not removed. The order may no longer be a draft.';

const LINES: PoLine[] = [
  { poItemId: 'line-1', itemId: 'item-1', itemName: 'Buns', unit: 'each', orderedQty: 2,
    receivedQty: 0, costPerUnit: 3, subUnitSize: 1, caseQty: 1 },
  { poItemId: 'line-2', itemId: 'item-2', itemName: 'Patties', unit: 'each', orderedQty: 5,
    receivedQty: 0, costPerUnit: 4, subUnitSize: 1, caseQty: 1 },
];

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({ poLinesById: { 'po-1': LINES } });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('useStore.removePoLine — spec 194 refused delete', () => {
  it('restores the line and toasts "Remove PO line" when deletePoItem throws', async () => {
    deleteMock.mockRejectedValueOnce(new Error(REFUSED_MESSAGE));

    await useStore.getState().removePoLine('po-1', 'line-1');

    expect(deleteMock).toHaveBeenCalledWith('line-1');
    expect(useStore.getState().poLinesById['po-1']).toEqual(LINES);
    expect(warnSpy).toHaveBeenCalledWith('[Supabase] Remove PO line failed:', REFUSED_MESSAGE);
    expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: 'Remove PO line failed',
        text2: REFUSED_MESSAGE,
      }),
    );
  });

  it('keeps the line removed and shows no toast when the delete succeeds', async () => {
    deleteMock.mockResolvedValueOnce(true);

    await useStore.getState().removePoLine('po-1', 'line-1');

    expect(useStore.getState().poLinesById['po-1']).toEqual([LINES[1]]);
    expect(toastShow).not.toHaveBeenCalled();
  });
});
