// src/screens/staff/screens/eod/StaffEodCountRow.test.tsx — Spec 141 §12(b).
//
// Presentational count-row: the counted/uncounted indicator (replacing the old
// red-name treatment), the two count wells, the locked read-only state, and the
// preserved item metadata.

// The path→URL resolver is backend-owned (spec 127 §6) and imports supabase at
// module load; mock it so the row test does not need Supabase env (mirrors
// IngredientThumb.test.tsx).
jest.mock('../../../../lib/ingredientImage', () => ({
  ingredientImageUrl: (p?: string | null) => (p ? `https://cdn.test/${p}` : null),
}));

import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { StaffEodCountRow, type StaffEodCountRowProps } from './StaffEodCountRow';
import { darkColors } from '../../theme';
import type { EodItem } from '../../lib/types';

const packItem: EodItem = {
  id: 'item-1',
  vendorId: 'v-1',
  name: 'Flour',
  unit: 'lb',
  caseQty: 12,
};

function setup(overrides: Partial<StaffEodCountRowProps> = {}) {
  const onOpenWell = jest.fn();
  const props: StaffEodCountRowProps = {
    item: packItem,
    displayName: 'Flour',
    counted: false,
    caseValue: '',
    unitValue: '',
    total: 0,
    hasPack: true,
    locked: false,
    onOpenWell,
    ...overrides,
  };
  return { onOpenWell, ...render(<StaffEodCountRow {...props} />) };
}

function flatColor(styleProp: unknown): unknown {
  return (StyleSheet.flatten(styleProp as never) as { color?: unknown }).color;
}

describe('StaffEodCountRow — indicator', () => {
  it('shows NO ✓ and the dashed indicator (aria "Not counted") when uncounted', () => {
    const { queryByTestId, getByLabelText } = setup({ counted: false });
    expect(queryByTestId('eod-counted-item-1')).toBeNull();
    expect(getByLabelText('Not counted')).toBeTruthy();
  });

  it('shows the ✓ indicator (aria "Counted") when counted', () => {
    const { getByTestId, getByLabelText } = setup({ counted: true, unitValue: '3' });
    expect(getByTestId('eod-counted-item-1')).toBeTruthy();
    expect(getByLabelText('Counted')).toBeTruthy();
  });

  it('renders the item name in c.text (never c.error) regardless of counted state', () => {
    // AC-1: the red-name treatment is gone — the indicator carries the state.
    const uncounted = setup({ counted: false });
    expect(flatColor(uncounted.getByText('Flour').props.style)).toBe(darkColors.text);
    uncounted.unmount();
    const counted = setup({ counted: true, unitValue: '3' });
    expect(flatColor(counted.getByText('Flour').props.style)).toBe(darkColors.text);
  });
});

describe('StaffEodCountRow — wells', () => {
  it('renders both wells for a pack item and maps the legacy value testIDs', () => {
    const { getByTestId } = setup({ hasPack: true, caseValue: '2', unitValue: '5' });
    expect(getByTestId('eod-well-item-1-cases')).toBeTruthy();
    expect(getByTestId('eod-well-item-1-units')).toBeTruthy();
    // Old ids kept on the value text so existing tests still resolve.
    expect(getByTestId('eod-item-cases-item-1').props.children).toBe('2');
    expect(getByTestId('eod-item-units-item-1').props.children).toBe('5');
  });

  it('shows the — placeholder in an empty well', () => {
    const { getByTestId } = setup({ caseValue: '', unitValue: '' });
    expect(getByTestId('eod-item-units-item-1').props.children).toBe('—');
  });

  it('omits the CS well when the item has no pack (hasPack false)', () => {
    const { queryByTestId, getByTestId } = setup({
      item: { ...packItem, caseQty: 1 },
      hasPack: false,
    });
    expect(queryByTestId('eod-well-item-1-cases')).toBeNull();
    expect(getByTestId('eod-well-item-1-units')).toBeTruthy();
  });

  it('opens the tapped well via onOpenWell when unlocked', () => {
    const { getByTestId, onOpenWell } = setup();
    fireEvent.press(getByTestId('eod-well-item-1-units'));
    expect(onOpenWell).toHaveBeenCalledWith(packItem, 'units');
    fireEvent.press(getByTestId('eod-well-item-1-cases'));
    expect(onOpenWell).toHaveBeenCalledWith(packItem, 'cases');
  });

  it('locked wells are disabled and do NOT open the keypad (AC-REG-3)', () => {
    const { getByTestId, onOpenWell } = setup({ locked: true, unitValue: '3', counted: true });
    const well = getByTestId('eod-well-item-1-units');
    expect(well.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(well);
    expect(onOpenWell).not.toHaveBeenCalled();
  });
});

describe('StaffEodCountRow — metadata (AC-2)', () => {
  it('keeps the running-total line once counted for a pack item', () => {
    const { getByTestId } = setup({ counted: true, caseValue: '2', total: 24 });
    expect(getByTestId('eod-item-total-item-1')).toBeTruthy();
  });

  it('renders the "Updated" badge only when item.updated is set', () => {
    const withBadge = setup({ item: { ...packItem, updated: true } });
    expect(withBadge.getByTestId('eod-updated-badge-item-1')).toBeTruthy();
    withBadge.unmount();
    const without = setup();
    expect(without.queryByTestId('eod-updated-badge-item-1')).toBeNull();
  });
});
