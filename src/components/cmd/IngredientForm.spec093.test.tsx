// src/components/cmd/IngredientForm.spec093.test.tsx — Spec 093 frontend.
//
// Covers the form-side fix for the case-size column-swap bug (spec 093 §0,
// §9). Three render-driven concerns:
//
//   1. Readback string — for DEFAULT UNIT=`cases`, case size (caseQty)=`20`,
//      PACK UNIT (subUnitUnit)=`lbs`, the grey readback MUST contain
//      "1 case = 20 lbs" and MUST NOT contain "20 cases per order" (the old
//      inverted arithmetic the owner flagged).
//   2. Label/help reconciliation — the CASE-SIZE field and the SUB-UNIT
//      field carry distinct labels, and the sub-unit/pack help describes a
//      PER-TRACKING-UNIT meaning, not a shipping-wrapper-only one.
//   3. Independent-axes write — typing a case size and a distinct sub-unit
//      drives `caseQty` and `subUnitSize` INDEPENDENTLY through onChange;
//      neither is conflated into the other (the canonical fix per §7/§9).
//
// The exact PACK_UNIT help copy is pinned by the sibling
// IngredientForm.help-text.test.tsx (spec 052/054, updated for spec 093 §9);
// this file asserts the SEMANTICS the spec requires, keyed off substrings, so
// it doesn't duplicate that byte-for-byte pin.
//
// Boundary mocking is copied verbatim from IngredientForm.help-text.test.tsx
// (the established pattern for rendering this component under jest-expo):
//   - `../../lib/supabase`   — stub so the import graph doesn't crash on
//     missing EXPO_PUBLIC_SUPABASE_* env vars.
//   - `../../theme/colors`   — deterministic palette.
//   - `../../hooks/useT`     — key-echoing translator.
//   - `../../store/useStore` — fixed snapshot with empty lookup collections.
//   - `../../lib/translate`  — stub so translateOnSave never network-fetches.
//
// Platform note: jest-expo sets Platform.OS === 'ios', so SelectField renders
// its native branch (TouchableOpacity trigger + inline panel), not the web
// <select>.

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
import { IngredientForm, IngredientFormValues, blankValues } from './IngredientForm';

// Controlled-component harness: holds `values` in state and exposes the
// latest snapshot via a ref so a test can assert the accumulated form state
// after firing input changes. Mirrors the Harness in help-text.test.tsx but
// records the live values for the independent-axes assertion.
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

describe('IngredientForm — spec 093 case-size readback', () => {
  it('renders "1 case = 20 lbs" for DEFAULT UNIT=cases / case size=20 / PACK UNIT=lbs', () => {
    // The mis-encoded prod shape the owner complained about: a case of 20 lbs.
    renderForm({
      ...blankValues(),
      unit: 'cases',
      caseQty: '20',
      subUnitUnit: 'lbs',
    });
    // Contains the plain, correct conversion …
    expect(screen.getByText('1 case = 20 lbs')).toBeTruthy();
  });

  it('does NOT render the old inverted "20 cases per order" sentence', () => {
    renderForm({
      ...blankValues(),
      unit: 'cases',
      caseQty: '20',
      subUnitUnit: 'lbs',
    });
    expect(screen.queryByText(/20 cases per order/)).toBeNull();
    // Belt-and-suspenders: the old "× … per order" arithmetic is gone
    // entirely, in any form.
    expect(screen.queryByText(/per order/)).toBeNull();
    expect(screen.queryByText(/×/)).toBeNull();
  });

  it('falls back to the tracking unit when no PACK UNIT is set (e.g. 1 case = 450 each)', () => {
    // The #1 Togo Box shape: DEFAULT UNIT=each, case size 450, no pack unit.
    renderForm({
      ...blankValues(),
      unit: 'each',
      caseQty: '450',
      subUnitUnit: '',
    });
    expect(screen.getByText('1 case = 450 each')).toBeTruthy();
  });

  it('renders nothing for an empty / non-positive case size (guard preserved)', () => {
    renderForm({
      ...blankValues(),
      unit: 'cases',
      caseQty: '',
      subUnitUnit: 'lbs',
    });
    // No conversion line of any "1 case = …" shape.
    expect(screen.queryByText(/^1 case = /)).toBeNull();
  });
});

describe('IngredientForm — spec 093 label / help reconciliation', () => {
  it('gives the case-size field and the sub-unit field DISTINCT labels', () => {
    renderForm(blankValues());
    // Case-size field reads as units-per-case; sub-unit field is visibly
    // distinct. Both labels render (InputLine uppercases via CSS only — the
    // underlying text node keeps the raw lowercase label).
    const caseLabel = screen.getByText('units / case');
    const subUnitLabel = screen.getByText('sub-unit / unit');
    expect(caseLabel).toBeTruthy();
    expect(subUnitLabel).toBeTruthy();
    // And the old conflated "units / pack" label is gone (it was the bug —
    // the input a manager reached for to type the case size).
    expect(screen.queryByText('units / pack')).toBeNull();
    expect(screen.queryByText('packs / order')).toBeNull();
  });

  it('describes the case-size help as units-per-case', () => {
    renderForm(blankValues());
    expect(
      screen.getByText('how many tracking units come in one case (e.g. 20 lbs per case)'),
    ).toBeTruthy();
  });

  it('describes the sub-unit help as PER-TRACKING-UNIT, not a shipping wrapper', () => {
    renderForm(blankValues());
    const subUnitHelp = screen.getByText(
      'how many sub-units make up ONE tracking unit (e.g. a bag of 10 each)',
    );
    expect(subUnitHelp).toBeTruthy();
  });

  it('reworded the PACK UNIT help away from the "shipping wrapper" meaning', () => {
    renderForm(blankValues());
    // The new copy describes the unit each sub-unit is measured in …
    expect(
      screen.getByText(
        'the unit each sub-unit is measured in — each, lb, oz. For abstract units like "case" or "tray", define their physical meaning on the Conversions tab.',
      ),
    ).toBeTruthy();
    // … and the old "shipping wrapper" framing is gone.
    expect(screen.queryByText(/shipping wrapper/)).toBeNull();
  });
});

describe('IngredientForm — spec 093 independent-axes write', () => {
  it('drives caseQty and subUnitSize independently (neither conflated)', () => {
    // Seed distinct sentinel values so each numeric TextInput is uniquely
    // addressable by its current display value, then type a case size of 20
    // and a sub-unit of 10. The accumulated form state must carry BOTH
    // axes, unconflated — the core of the spec 093 fix.
    const { latest } = renderForm({
      ...blankValues(),
      unit: 'cases',
      caseQty: '5',     // case-size input — distinct sentinel
      subUnitSize: '7', // sub-unit input — distinct sentinel
      subUnitUnit: 'lbs',
    });

    // The case-size input currently shows '5'; the sub-unit input shows '7'.
    fireEvent.changeText(screen.getByDisplayValue('5'), '20');
    fireEvent.changeText(screen.getByDisplayValue('7'), '10');

    expect(latest.current.caseQty).toBe('20');
    expect(latest.current.subUnitSize).toBe('10');
    // Cross-check: writing the case size did NOT bleed into subUnitSize, and
    // writing the sub-unit did NOT bleed into caseQty.
    expect(latest.current.caseQty).not.toBe('10');
    expect(latest.current.subUnitSize).not.toBe('20');
  });
});
