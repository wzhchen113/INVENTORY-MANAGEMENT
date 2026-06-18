// src/components/cmd/IngredientForm.help-text.test.tsx — Spec 052 coverage.
// Spec 054 added the fifth test below that blurs the inline input to
// assert help + error coexist.
//
// Spec 093 (§9) rewrote the PACK UNIT help copy (the old "shipping wrapper"
// wording contradicted unitConversion's "sub-unit = per tracking unit"
// meaning). The PACK_UNIT_HELP constant below was updated to the new copy;
// the behavioral assertions (help persists under error, renders in both the
// SelectField and CustomUnitInput branches) are unchanged.
//
// Verifies the DEFAULT UNIT and PACK UNIT help/sublabel strings landed by
// spec 052 render in BOTH the SelectField branch (initial render) AND the
// inline CustomUnitInput branch (after the user picks "+ custom…").
//
// Scope is deliberately narrow: one substring assertion per branch per
// field × two fields × two branches = four assertions. No interaction
// with form persistence, validation, or the math-readback / abstract-unit
// warning blocks — those are explicitly out-of-scope per the spec.
//
// Boundary mocking — same shape as CopyToBrandDialog.test.tsx:
//   - `../../theme/colors` — useCmdColors returns a deterministic palette.
//   - `../../hooks/useT` — key-echoing translator.
//   - `../../store/useStore` — fixed snapshot with empty lookup collections.
//   - `../../lib/supabase` — stub so the import graph doesn't crash on
//     missing EXPO_PUBLIC_SUPABASE_* env vars.
//   - `../../lib/translate` — stub so `translateOnSave` never network-fetches.
//
// Platform note: jest-expo sets babel-jest's caller.platform to 'ios', so
// `Platform.OS === 'ios'` inside the component code. SelectField therefore
// renders its native branch (TouchableOpacity trigger + inline panel),
// NOT the web <select>. We exercise both forms by pressing the trigger
// to open the panel and pressing the "+ custom…" row to flip into
// CustomUnitInput.
//
// Component-project (jsdom) because this file imports a `.tsx`.

// ── Mocks (must precede any import of the component) ────────────────

jest.mock('../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
    })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../theme/colors', () => ({
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
    accentFg:     '#FFFFFF',
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

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

jest.mock('../../store/useStore', () => {
  const state: any = {
    ingredientCategories: [],
    ingredientConversions: [],
    catalogIngredients: [],
    vendors: [],
    currentStore: { id: 'store-1', brandId: 'brand-1' },
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

jest.mock('../../lib/translate', () => ({
  translateOnSave: jest.fn(() => Promise.resolve({ data: null, error: null })),
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { IngredientForm, blankValues } from './IngredientForm';

const DEFAULT_UNIT_HELP = 'the smallest unit you count one of (each, lb, oz, mL)';
// Spec 093 (§9) — the PACK UNIT help no longer describes a "shipping wrapper"
// (which contradicted unitConversion's "sub-unit = per tracking unit"
// meaning). It now describes the unit each sub-unit is measured in. The
// "define abstract units on the Conversions tab" sentence is preserved.
const PACK_UNIT_HELP =
  'the unit each sub-unit is measured in — each, lb, oz. For abstract units like "case" or "tray", define their physical meaning on the Conversions tab.';

describe('IngredientForm — spec 052 help text', () => {
  it('renders the DEFAULT UNIT help string under the SelectField branch on initial render', () => {
    render(
      <IngredientForm mode="new" values={blankValues()} onChange={() => {}} />
    );
    expect(screen.getAllByText(DEFAULT_UNIT_HELP)).toHaveLength(1);
  });

  it('renders the PACK UNIT prefixed help string under the SelectField branch on initial render', () => {
    render(
      <IngredientForm mode="new" values={blankValues()} onChange={() => {}} />
    );
    expect(screen.getAllByText(PACK_UNIT_HELP)).toHaveLength(1);
  });

  it('keeps the DEFAULT UNIT help string visible after flipping into CustomUnitInput via the "+ custom…" sentinel', () => {
    // Test the IngredientForm as a controlled component — the parent
    // (this test) holds `values` in state so the onChange path round-trips
    // correctly. The "+ custom…" press never modifies `values.unit`
    // directly; it flips component-local `customMode.default`. So we just
    // need to drive the press and re-assert the substring.
    function Harness() {
      const [vals, setVals] = React.useState(blankValues());
      return (
        <IngredientForm
          mode="new"
          values={vals}
          onChange={(next) =>
            setVals(typeof next === 'function' ? (next as any)(vals) : next)
          }
        />
      );
    }
    render(<Harness />);

    // Pre-flip assertion — sanity check.
    expect(screen.getAllByText(DEFAULT_UNIT_HELP)).toHaveLength(1);

    // Open the DEFAULT UNIT dropdown — its initial display text is the
    // resolved unit label for 'each' (via the key-echoing T mock that
    // returns the key path verbatim, i.e. 'enum.unit.each').
    const defaultDisplay = screen.getByText('enum.unit.each');
    fireEvent.press(defaultDisplay);
    // The panel mounts and renders option rows. There may be multiple
    // "+ custom…" matches if the PACK UNIT dropdown is also open (it
    // isn't here) — pick the first.
    const customRows = screen.getAllByText('+ custom…');
    fireEvent.press(customRows[0]);

    // CustomUnitInput now mounts in place of the SelectField; the help
    // prop renders the same string under the inline TextInput.
    expect(screen.getAllByText(DEFAULT_UNIT_HELP)).toHaveLength(1);
  });

  it('keeps the PACK UNIT prefixed help string visible after flipping into CustomUnitInput via the "+ custom…" sentinel', () => {
    function Harness() {
      const [vals, setVals] = React.useState(blankValues());
      return (
        <IngredientForm
          mode="new"
          values={vals}
          onChange={(next) =>
            setVals(typeof next === 'function' ? (next as any)(vals) : next)
          }
        />
      );
    }
    render(<Harness />);

    // Pre-flip assertion.
    expect(screen.getAllByText(PACK_UNIT_HELP)).toHaveLength(1);

    // The PACK UNIT SelectField has `allowEmpty` and `subUnitUnit` is
    // empty, so the display shows the placeholder.
    const packDisplay = screen.getByText('— pick pack unit —');
    fireEvent.press(packDisplay);
    // Now press the pack-unit dropdown's "+ custom…" row. The default-unit
    // dropdown is closed at this point so there is exactly one `+ custom…`
    // row visible; `[customRows.length - 1]` reduces to `[0]` in practice
    // but the indexing remains defensive if test setup ever pre-opens both.
    const customRows = screen.getAllByText('+ custom…');
    fireEvent.press(customRows[customRows.length - 1]);

    expect(screen.getAllByText(PACK_UNIT_HELP)).toHaveLength(1);
  });

  it('keeps the DEFAULT UNIT help string visible alongside the "required" error after blurring CustomUnitInput with an empty value', () => {
    // Spec 054: when the inline TextInput blurs with empty value,
    // validateCustomUnit returns { ok: false, error: 'required' } and the
    // parent sets customError.default = 'required' without flipping
    // customMode.default off. The component re-renders with both a
    // non-empty `help` prop AND a non-empty `error` prop. Per spec 054
    // both must coexist in the rendered tree (previously the
    // `{error || help}` swap supplanted the help line).
    function Harness() {
      const [vals, setVals] = React.useState(blankValues());
      return (
        <IngredientForm
          mode="new"
          values={vals}
          onChange={(next) =>
            setVals(typeof next === 'function' ? (next as any)(vals) : next)
          }
        />
      );
    }
    render(<Harness />);

    // Open the DEFAULT UNIT dropdown and flip into CustomUnitInput.
    const defaultDisplay = screen.getByText('enum.unit.each');
    fireEvent.press(defaultDisplay);
    const customRows = screen.getAllByText('+ custom…');
    fireEvent.press(customRows[0]);

    // Inline TextInput is now mounted with autoFocus. Find it by
    // placeholder and fire a blur — handleCommit → validateCustomUnit('')
    // → { ok: false, error: 'required' } → customError.default =
    // 'required'.
    const inlineInput = screen.getByPlaceholderText('e.g. case, box, tray');
    fireEvent(inlineInput, 'blur');

    // Both lines render simultaneously.
    expect(screen.getAllByText(DEFAULT_UNIT_HELP)).toHaveLength(1);
    expect(screen.getAllByText('required')).toHaveLength(1);
  });

  it('keeps the PACK UNIT help string visible alongside the "required" error after blurring CustomUnitInput with an empty value', () => {
    // Spec 054 symmetry — `CustomUnitInput` is shared between DEFAULT
    // UNIT and PACK UNIT custom branches, so the help+error coexistence
    // fix architecturally covers both. This test asserts the PACK UNIT
    // path explicitly so a future divergence between the two call sites
    // would surface as a coverage regression.
    function Harness() {
      const [vals, setVals] = React.useState(blankValues());
      return (
        <IngredientForm
          mode="new"
          values={vals}
          onChange={(next) =>
            setVals(typeof next === 'function' ? (next as any)(vals) : next)
          }
        />
      );
    }
    render(<Harness />);

    // Open the PACK UNIT dropdown (uses the placeholder text because
    // subUnitUnit is empty in blankValues) and flip into CustomUnitInput.
    const packDisplay = screen.getByText('— pick pack unit —');
    fireEvent.press(packDisplay);
    const customRows = screen.getAllByText('+ custom…');
    fireEvent.press(customRows[customRows.length - 1]);

    // Inline TextInput is now mounted for PACK UNIT. Both PACK UNIT and
    // (potentially) DEFAULT UNIT could have inputs with the same
    // placeholder; PACK UNIT was opened last so its input is the most
    // recently mounted — pick the last match.
    const inlineInputs = screen.getAllByPlaceholderText('e.g. case, box, tray');
    fireEvent(inlineInputs[inlineInputs.length - 1], 'blur');

    // Both lines render simultaneously for PACK UNIT.
    expect(screen.getAllByText(PACK_UNIT_HELP)).toHaveLength(1);
    expect(screen.getAllByText('required')).toHaveLength(1);
  });
});
