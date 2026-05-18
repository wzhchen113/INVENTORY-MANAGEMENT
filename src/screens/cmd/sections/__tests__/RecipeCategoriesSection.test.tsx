// src/screens/cmd/sections/__tests__/RecipeCategoriesSection.test.tsx
//
// Spec 048 — RecipeCategoriesSection coverage.
//
// Covers the five paths called out by the architect (spec 048 §9):
//   1. render — row with N>0 usage shows the combined count.
//   2. positive delete (count=0) — `confirmAction` confirms, then
//      `deleteRecipeCategory(name)` is called.
//   3. negative delete (count>0) — `deleteRecipeCategory` is NOT called,
//      and the Toast.error includes BOTH the recipes count AND the prep
//      recipes count (split, not summed) per AC #3.
//   4. add — trimmed name flows through to `addRecipeCategory(name, i18n)`.
//   5. rename — `updateRecipeCategory(oldName, newName, i18nNames)` runs.
//
// Boundary mocking (same shape as StatusPill.test.tsx + IngredientForm.test.ts):
//   - `react-native-toast-message` (global, jest.setup.ts) — Toast.show
//     is a jest.fn() so we can assert call shape.
//   - `../../../theme/colors` — `useCmdColors()` returns a deterministic
//     palette; avoids dragging the Zustand store import chain in for
//     a hook that only needs a tokens map.
//   - `../../../hooks/useT` — return a key-echoing translator so we can
//     match by stable dot-path; mirrors StatusPill.test.tsx.
//   - `../../../hooks/useLocale` — return 'en' so localeCompare is
//     deterministic.
//   - `../../../store/useStore` — return a fixed snapshot for selectors
//     and jest.fn() for write actions. Same pattern as the auth.test.ts
//     namespace-stub approach (one snapshot, one selector function).
//   - `../../../utils/confirmAction` — auto-confirms so the positive
//     path can assert the post-confirm side effect without mocking
//     window.confirm or Alert.alert.
//   - `../../../lib/translate` — `translateOnSave` is a no-op resolver
//     so the test doesn't hit DeepL or its env-var crash.
//
// Component-project (jsdom) because this file imports a `.tsx`. See
// jest.config.js > projects > component.

// ── Mocks (must precede any import of the component) ────────────────

// useCmdColors — same minimal palette pattern as StatusPill.test.tsx.
jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg:           '#FFFFFF',
    panel:        '#F4F4F4',
    panel2:       '#EAEAEA',
    border:       '#CCCCCC',
    borderStrong: '#888888',
    fg:           '#000000',
    fg2:          '#444444',
    fg3:          '#888888',
    accent:       '#185FA5',
    accentBg:     '#E6F1FB',
    warn:         '#854F0B',
    warnBg:       '#FAEEDA',
    danger:       '#791F1F',
    dangerBg:     '#FCEBEB',
    ok:           '#3B6D11',
    okBg:         '#EAF3DE',
    info:         '#185FA5',
    infoBg:       '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

// useT — Return a stable template per key. For most keys the template
// IS the key path (so assertions can key off stable strings rather
// than locale-specific user copy). For the two interpolated keys
// covered by the count-render and in-use-toast assertions, the
// template includes the {recipes} / {preps} / {count} tokens so the
// substitution pass produces a string containing the numeric values
// — that's the production behavior the test is meant to lock.
// Matches the StatusPill.test.tsx mock-table idiom, just keyed by
// key-path instead of enum value.
jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    const templates: Record<string, string> = {
      // Render-test: the row's right-aligned usage column.
      'section.recipes.categories.uses':           '{count} uses',
      // Negative-delete: the toast body that surfaces N / M split.
      'section.recipes.categories.inUseToastBody': 'Used by {recipes} recipes / {preps} prep recipes — cannot delete.',
      'section.recipes.categories.cannotDeleteInUse':
        'Cannot delete "{name}" — used by {recipes} recipes / {preps} prep recipes.',
    };
    const template = templates[key] ?? key;
    if (!vars) return template;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      template,
    );
  },
}));

// useLocale — pin to 'en' so localeCompare sort order is stable.
jest.mock('../../../../hooks/useLocale', () => ({
  useLocale: () => 'en',
}));

// translateOnSave — stub the DeepL helper; the component fires it on
// debounce/blur. Return a resolved success-shape with empty translations
// so no override field is mutated and the assertions on add/edit aren't
// flaked by auto-fill content. See spec 040 P3 architecture.
jest.mock('../../../../lib/translate', () => ({
  translateOnSave: jest.fn().mockResolvedValue({
    data: { translations: {} },
    error: null,
  }),
}));

// confirmAction — auto-confirm. The positive-delete test asserts the
// callback fires; mocking this avoids needing to drive `window.confirm`
// or `Alert.alert` from the test environment.
jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: (_title: string, _body: string, onConfirm: () => void) => {
    onConfirm();
  },
}));

// useStore — mock as a hook AND a `.getState()` returner. The component
// calls `useStore((s) => s.recipeCategories)` per selector AND
// `useStore.getState().setRecipeCategoryI18nNames(...)` once in saveEdit.
// Both surfaces are covered.
//
// The mock state object lives INSIDE the jest.mock factory so the
// hoisted factory can reference it without tripping the
// "out-of-scope variable" guard. We re-export it via the module
// closure as a getter on the mock function so the test file can
// mutate the snapshot between tests through `mockStateRef.current`.
jest.mock('../../../../store/useStore', () => {
  const state: any = {
    recipeCategories: [],
    recipes: [],
    prepRecipes: [],
    addRecipeCategory: jest.fn(),
    updateRecipeCategory: jest.fn(),
    deleteRecipeCategory: jest.fn(),
    setRecipeCategoryI18nNames: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  // Expose the raw object so the test can mutate it.
  fn.__state = state;
  return { useStore: fn };
});

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import RecipeCategoriesSection from '../RecipeCategoriesSection';
import { useStore } from '../../../../store/useStore';

const toastShowMock = (Toast as any).show as jest.Mock;
const mockState = (useStore as any).__state as Record<string, any>;

// ── Helpers ─────────────────────────────────────────────────────────
function seedStore(overrides: Partial<typeof mockState> = {}) {
  // Reset every slice + action mock to its base state before each test.
  mockState.recipeCategories = overrides.recipeCategories ?? [];
  mockState.recipes          = overrides.recipes          ?? [];
  mockState.prepRecipes      = overrides.prepRecipes      ?? [];
  mockState.addRecipeCategory          = jest.fn();
  mockState.updateRecipeCategory       = jest.fn();
  mockState.deleteRecipeCategory       = jest.fn();
  mockState.setRecipeCategoryI18nNames = jest.fn();
  if (overrides.addRecipeCategory)          mockState.addRecipeCategory          = overrides.addRecipeCategory;
  if (overrides.updateRecipeCategory)       mockState.updateRecipeCategory       = overrides.updateRecipeCategory;
  if (overrides.deleteRecipeCategory)       mockState.deleteRecipeCategory       = overrides.deleteRecipeCategory;
  if (overrides.setRecipeCategoryI18nNames) mockState.setRecipeCategoryI18nNames = overrides.setRecipeCategoryI18nNames;
}

beforeEach(() => {
  jest.clearAllMocks();
  seedStore();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('RecipeCategoriesSection — render', () => {
  it('renders a row per category with the combined usage count', () => {
    seedStore({
      recipeCategories: [
        { name: 'Sauces',  i18nNames: {} },
        { name: 'Entrées', i18nNames: {} },
      ],
      recipes: [
        // 2 recipes use Sauces, 0 use Entrées
        { id: 'r1', menuItem: 'Aioli',         category: 'Sauces',  sellPrice: 0, ingredients: [], prepItems: [], brandId: 'b', storeId: 's' },
        { id: 'r2', menuItem: 'Garlic butter', category: 'Sauces',  sellPrice: 0, ingredients: [], prepItems: [], brandId: 'b', storeId: 's' },
      ],
      prepRecipes: [
        // 1 prep uses Sauces
        { id: 'p1', name: 'Demi-glace', category: 'Sauces', yieldQuantity: 1, yieldUnit: 'l', notes: '', ingredients: [], brandId: 'b', storeId: 's', createdBy: '', createdAt: '', version: 1, isCurrent: true },
      ],
    });

    render(<RecipeCategoriesSection />);

    // Both categories rendered.
    expect(screen.getByText('Sauces')).toBeTruthy();
    expect(screen.getByText('Entrées')).toBeTruthy();

    // Combined count = 2 recipes + 1 prep recipe = 3 for Sauces.
    // Mock useT template for `section.recipes.categories.uses` is
    // '{count} uses' — substitute gives the rendered text per row.
    expect(screen.getByText('3 uses')).toBeTruthy(); // Sauces (2 + 1)
    expect(screen.getByText('0 uses')).toBeTruthy(); // Entrées
  });
});

describe('RecipeCategoriesSection — positive delete (count = 0)', () => {
  it('calls deleteRecipeCategory when the category is unused', () => {
    seedStore({
      recipeCategories: [{ name: 'Unused', i18nNames: {} }],
      recipes: [],
      prepRecipes: [],
    });

    render(<RecipeCategoriesSection />);

    // Click the per-row DELETE button. There's only one row, so getByText
    // for the delete button key is unambiguous.
    fireEvent.press(screen.getByText('section.recipes.categories.deleteButton'));

    // confirmAction auto-confirms (per the mock above), so
    // deleteRecipeCategory should have been called with the row name.
    expect(mockState.deleteRecipeCategory).toHaveBeenCalledTimes(1);
    expect(mockState.deleteRecipeCategory).toHaveBeenCalledWith('Unused');

    // No error toast — the success toast fires after confirmation.
    const errorToastCalls = toastShowMock.mock.calls.filter(
      ([arg]: any[]) => arg && arg.type === 'error',
    );
    expect(errorToastCalls).toHaveLength(0);
  });
});

describe('RecipeCategoriesSection — negative delete (count > 0, blocked)', () => {
  it('blocks delete and shows a toast with N/M split when in use', () => {
    seedStore({
      recipeCategories: [{ name: 'Sauces', i18nNames: {} }],
      recipes: [
        { id: 'r1', menuItem: 'Aioli', category: 'Sauces', sellPrice: 0, ingredients: [], prepItems: [], brandId: 'b', storeId: 's' },
        { id: 'r2', menuItem: 'BBQ',   category: 'Sauces', sellPrice: 0, ingredients: [], prepItems: [], brandId: 'b', storeId: 's' },
      ],
      prepRecipes: [
        { id: 'p1', name: 'Demi-glace', category: 'Sauces', yieldQuantity: 1, yieldUnit: 'l', notes: '', ingredients: [], brandId: 'b', storeId: 's', createdBy: '', createdAt: '', version: 1, isCurrent: true },
        { id: 'p2', name: 'Bechamel',   category: 'Sauces', yieldQuantity: 1, yieldUnit: 'l', notes: '', ingredients: [], brandId: 'b', storeId: 's', createdBy: '', createdAt: '', version: 1, isCurrent: true },
        { id: 'p3', name: 'Tomato',     category: 'Sauces', yieldQuantity: 1, yieldUnit: 'l', notes: '', ingredients: [], brandId: 'b', storeId: 's', createdBy: '', createdAt: '', version: 1, isCurrent: true },
      ],
    });

    render(<RecipeCategoriesSection />);
    fireEvent.press(screen.getByText('section.recipes.categories.deleteButton'));

    // No DELETE call was issued — block-on-use guard refused.
    expect(mockState.deleteRecipeCategory).not.toHaveBeenCalled();

    // Toast.error fired with N=2 (recipes) and M=3 (prep recipes) in
    // text2. The mock useT substitutes `{recipes}` and `{preps}` into
    // the key path, so the rendered text2 contains both numbers
    // verbatim — guarding that the split is preserved end-to-end (AC #3:
    // "surface both N and M, not just the sum").
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: 'section.recipes.categories.inUseToast',
        text2: expect.stringMatching(/2.*3|recipes.*2.*preps.*3/),
      }),
    );
    // Stronger split assertion — both numbers are present.
    const lastCall = toastShowMock.mock.calls[toastShowMock.mock.calls.length - 1][0];
    expect(lastCall.text2).toContain('2');
    expect(lastCall.text2).toContain('3');
  });
});

describe('RecipeCategoriesSection — add', () => {
  it('passes trimmed name + i18n object to addRecipeCategory on submit', () => {
    seedStore({ recipeCategories: [] });

    render(<RecipeCategoriesSection />);

    // Find the + ADD form's name input by placeholder key.
    const nameInput = screen.getByPlaceholderText('section.recipes.categories.namePlaceholder');
    // Whitespace at both ends — addRecipeCategory should receive the trimmed value.
    fireEvent.changeText(nameInput, '  Desserts  ');

    // Press the + ADD button.
    fireEvent.press(screen.getByText('section.recipes.categories.newCategoryButton'));

    expect(mockState.addRecipeCategory).toHaveBeenCalledTimes(1);
    // Empty i18n because the override inputs were untouched.
    expect(mockState.addRecipeCategory).toHaveBeenCalledWith('Desserts', {});
  });
});

describe('RecipeCategoriesSection — rename', () => {
  it('calls updateRecipeCategory(oldName, newName, i18nNames) on save', () => {
    seedStore({
      recipeCategories: [{ name: 'Sauces', i18nNames: { es: 'Salsas' } }],
    });

    render(<RecipeCategoriesSection />);

    // Enter edit mode for the only row.
    fireEvent.press(screen.getByText('section.recipes.categories.editButton'));

    // The edit TextInput's value reflects the current name. After
    // autoFocus, change it.
    // Find the input by its current value via testID would be cleaner,
    // but our component doesn't set testIDs. Instead, find by display
    // value — RTL exposes `getByDisplayValue` for controlled inputs.
    const editInput = screen.getByDisplayValue('Sauces');
    fireEvent.changeText(editInput, 'Condiments');

    // SAVE
    fireEvent.press(screen.getByText('section.recipes.categories.saveButton'));

    expect(mockState.updateRecipeCategory).toHaveBeenCalledTimes(1);
    // oldName='Sauces', newName='Condiments', i18n preserves the es
    // override (it was non-empty before edit and untouched in this
    // test — the edit form does NOT clear it on a rename).
    expect(mockState.updateRecipeCategory).toHaveBeenCalledWith(
      'Sauces',
      'Condiments',
      { es: 'Salsas' },
    );
  });
});
