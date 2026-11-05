// src/screens/staff/screens/eod/StaffUnitLabel.test.tsx — 2026-10 unit
// translation on the staff EOD row + keypad sheet.
//
// The free-text `catalog_ingredients.unit` token used to render raw in every
// locale ("box" under a Spanish UI). es / zh-CN now resolve it through the
// shared `enum.unit.*` dictionary; en keeps the stored token as typed, and
// units with no dictionary entry pass through unchanged.

// The path→URL resolver imports supabase at module load (mirrors
// StaffEodCountRow.test.tsx).
jest.mock('../../../../lib/ingredientImage', () => ({
  ingredientImageUrl: (p?: string | null) => (p ? `https://cdn.test/${p}` : null),
}));
// Importing the store (to switch locale) loads supabase; its module-init
// `_setActiveLocaleHook(...)` wires useI18n() to the real subscription
// (mirrors i18n/useI18n.reactivity.test.tsx).
jest.mock('../../../../lib/supabase', () => ({
  supabase: { auth: { signOut: jest.fn().mockResolvedValue({ error: null }) } },
}));

import { act, render } from '@testing-library/react-native';
import { StaffEodCountRow, type StaffEodCountRowProps } from './StaffEodCountRow';
import { StaffKeypadSheet, type StaffKeypadSheetProps } from './StaffKeypadSheet';
import { useStaffStore } from '../../store/useStaffStore';
import type { EodItem } from '../../lib/types';

const boxItem: EodItem = {
  id: 'item-1',
  vendorId: 'v-1',
  name: 'Napkins',
  unit: 'box',
  caseQty: 12,
};

function row(overrides: Partial<StaffEodCountRowProps> = {}) {
  const props: StaffEodCountRowProps = {
    item: boxItem,
    displayName: 'Napkins',
    counted: true,
    caseValue: '1',
    unitValue: '2',
    total: 14,
    hasPack: true,
    locked: false,
    onOpenWell: jest.fn(),
    ...overrides,
  };
  return render(<StaffEodCountRow {...props} />);
}

function sheet(overrides: Partial<StaffKeypadSheetProps> = {}) {
  const props: StaffKeypadSheetProps = {
    visible: true,
    item: boxItem,
    displayName: 'Napkins',
    activeField: 'units',
    setActiveField: jest.fn(),
    caseValue: '1',
    unitValue: '2',
    runningTotal: 14,
    isDone: false,
    onKey: jest.fn(),
    onSkip: jest.fn(),
    onNext: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  return render(<StaffKeypadSheet {...props} />);
}

afterEach(() => {
  act(() => useStaffStore.setState({ locale: 'en' }));
});

describe('StaffEodCountRow — unit label', () => {
  it('en shows the stored unit token as typed', () => {
    const { getAllByText, getByTestId } = row({ item: { ...boxItem, unit: 'Box' } });
    expect(getAllByText('Box').length).toBeGreaterThan(0);
    expect(getByTestId('eod-item-total-item-1')).toHaveTextContent('total 14 Box');
  });

  it('es translates the unit well, subtitle, and total', () => {
    act(() => useStaffStore.setState({ locale: 'es' }));
    const { getByText, getByTestId, queryByText } = row();
    expect(getByText('caja')).toBeTruthy();
    expect(getByText(/^caja · /)).toBeTruthy();
    expect(getByTestId('eod-item-total-item-1')).toHaveTextContent('total 14 caja');
    expect(queryByText('box')).toBeNull();
  });

  it('zh-CN translates the unit token', () => {
    act(() => useStaffStore.setState({ locale: 'zh-CN' }));
    const { getByText } = row({ item: { ...boxItem, unit: 'dozen' } });
    expect(getByText('打')).toBeTruthy();
  });

  it('a unit with no dictionary entry passes through unchanged', () => {
    act(() => useStaffStore.setState({ locale: 'es' }));
    // Subtitle + units well both carry the raw token.
    const { getAllByText } = row({ item: { ...boxItem, unit: 'loaves' }, hasPack: false });
    expect(getAllByText('loaves')).toHaveLength(2);
  });
});

describe('StaffKeypadSheet — unit label', () => {
  it('es translates the header meta, units well, and running total', () => {
    act(() => useStaffStore.setState({ locale: 'es' }));
    const { getByText, getByTestId, queryByText } = sheet();
    expect(getByText('caja')).toBeTruthy();
    expect(getByText(/^caja · /)).toBeTruthy();
    expect(getByTestId('eod-sheet-total')).toHaveTextContent('= 14 caja total');
    expect(queryByText('box')).toBeNull();
  });
});
