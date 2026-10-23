// src/components/cmd/IngredientForm.spec171.test.tsx — Spec 171 (AC-17).
//
// The per-ingredient "EOD count" control in IngredientForm:
//   - rendered only when the parsed case size is > 1 (blank / 0 / 1 /
//     unparseable → hidden);
//   - three options "Cases + units" / "Cases only" / "Units only", defaulting to
//     "Cases + units" for a new ingredient;
//   - hiding it (case size dropped to <= 1) PRESERVES the stored mode, so raising
//     the case size back above 1 resurfaces the prior choice (AC-17 / N2).
//
// Boundary mocking copied verbatim from IngredientForm.spec093.test.tsx (the
// established pattern for rendering this component under jest-expo). jest-expo
// sets Platform.OS === 'ios', so SelectField renders its native branch
// (TouchableOpacity trigger + inline option panel).

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
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA', border: '#CCCCCC',
    borderStrong: '#888888', fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE', info: '#185FA5', infoBg: '#E6F1FB',
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
import {
  IngredientForm,
  IngredientFormValues,
  blankValues,
  showEodCountModeControl,
  EOD_COUNT_MODE_OPTIONS,
} from './IngredientForm';

function renderForm(initial: IngredientFormValues) {
  const latest = { current: initial };
  function Harness() {
    const [vals, setVals] = React.useState(initial);
    latest.current = vals;
    return (
      <IngredientForm
        mode="new"
        values={vals}
        onChange={(next) =>
          setVals((prev) => {
            const resolved = typeof next === 'function' ? (next as any)(prev) : next;
            latest.current = resolved;
            return resolved;
          })
        }
      />
    );
  }
  const utils = render(<Harness />);
  return { ...utils, latest };
}

// The "units / case" InputLine — located by its current value (the test seeds
// values so the case size is the only TextInput showing it).
function caseSizeInput(value: string) {
  return screen.getByDisplayValue(value);
}

describe('showEodCountModeControl (pure)', () => {
  it('is true only for a parsed case size > 1', () => {
    expect(showEodCountModeControl('24')).toBe(true);
    expect(showEodCountModeControl('1.5')).toBe(true);
    expect(showEodCountModeControl('')).toBe(false);
    expect(showEodCountModeControl('0')).toBe(false);
    expect(showEodCountModeControl('1')).toBe(false);
    expect(showEodCountModeControl('abc')).toBe(false);
  });

  it('offers exactly the three modes with the spec labels, in DB order', () => {
    expect(EOD_COUNT_MODE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['cases_and_units', 'Cases + units'],
      ['cases_only', 'Cases only'],
      ['units_only', 'Units only'],
    ]);
  });
});

describe('IngredientForm — spec 171 EOD count control (AC-17)', () => {
  it('blankValues() seeds the default mode (cases_and_units)', () => {
    expect(blankValues().eodCountMode).toBe('cases_and_units');
  });

  it('is HIDDEN for a new ingredient at the default case size (1)', () => {
    renderForm(blankValues());
    expect(screen.queryByText('EOD count')).toBeNull();
  });

  it('is SHOWN at case size > 1 and defaults to "Cases + units"', () => {
    renderForm({ ...blankValues(), caseQty: '24' });
    expect(screen.getByText('EOD count')).toBeTruthy();
    expect(screen.getByText('Cases + units')).toBeTruthy();
  });

  it('picking an option writes the stored mode', () => {
    const { latest } = renderForm({ ...blankValues(), caseQty: '24' });
    fireEvent.press(screen.getByText('Cases + units')); // open the native panel
    fireEvent.press(screen.getByText('Units only'));
    expect(latest.current.eodCountMode).toBe('units_only');
  });

  it('dropping the case size to 1 hides the control but PRESERVES the stored mode; raising it resurfaces the choice', () => {
    // Distinct sub-unit size / case price so the case-size input's display
    // value is unique on screen.
    const { latest } = renderForm({
      ...blankValues(),
      caseQty: '24',
      subUnitSize: '3',
      casePrice: '9',
      eodCountMode: 'cases_only',
    });
    expect(screen.getByText('Cases only')).toBeTruthy();

    fireEvent.changeText(caseSizeInput('24'), '1');
    expect(screen.queryByText('EOD count')).toBeNull();
    expect(latest.current.caseQty).toBe('1');
    expect(latest.current.eodCountMode).toBe('cases_only'); // NOT rewritten (N2)

    fireEvent.changeText(caseSizeInput('1'), '12');
    expect(screen.getByText('EOD count')).toBeTruthy();
    expect(screen.getByText('Cases only')).toBeTruthy();
    expect(latest.current.eodCountMode).toBe('cases_only');
  });

  it('is hidden for a blank / unparseable case size', () => {
    renderForm({ ...blankValues(), caseQty: '' });
    expect(screen.queryByText('EOD count')).toBeNull();
  });
});
