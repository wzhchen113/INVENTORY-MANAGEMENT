// src/screens/staff/screens/eod/StaffNoNeed.spec172.test.tsx — Spec 172.
//
// Presentational NO NEED ("more than enough") arms for the staff EOD row
// (AC-31) and keypad sheet (AC-31 with AC-29 semantics). The new props are
// OPTIONAL, so a caller that omits them renders exactly as before (the
// pre-existing StaffEodCountRow / StaffKeypadSheet suites are unmodified). The
// end-to-end toggle / advance / submit flow lives in
// ../EODCount.noNeed.spec172.test.tsx.

// The path→URL resolver imports supabase at module load (mirrors
// StaffEodCountRow.test.tsx).
jest.mock('../../../../lib/ingredientImage', () => ({
  ingredientImageUrl: (p?: string | null) => (p ? `https://cdn.test/${p}` : null),
}));

import { fireEvent, render } from '@testing-library/react-native';
import { StaffEodCountRow, type StaffEodCountRowProps } from './StaffEodCountRow';
import { StaffKeypadSheet, type StaffKeypadSheetProps } from './StaffKeypadSheet';
import type { EodItem } from '../../lib/types';

const packItem: EodItem = {
  id: 'item-1',
  vendorId: 'v-1',
  name: 'Flour',
  unit: 'lb',
  caseQty: 12,
};

function row(overrides: Partial<StaffEodCountRowProps> = {}) {
  const props: StaffEodCountRowProps = {
    item: packItem,
    displayName: 'Flour',
    counted: false,
    caseValue: '',
    unitValue: '',
    total: 0,
    hasPack: true,
    locked: false,
    onOpenWell: jest.fn(),
    ...overrides,
  };
  return { props, ...render(<StaffEodCountRow {...props} />) };
}

function sheet(overrides: Partial<StaffKeypadSheetProps> = {}) {
  const props: StaffKeypadSheetProps = {
    visible: true,
    item: packItem,
    displayName: 'Flour',
    activeField: 'units',
    setActiveField: jest.fn(),
    caseValue: '',
    unitValue: '',
    runningTotal: 0,
    isDone: false,
    onKey: jest.fn(),
    onSkip: jest.fn(),
    onNext: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  return { props, ...render(<StaffKeypadSheet {...props} />) };
}

describe('StaffEodCountRow — spec 172 NO NEED', () => {
  it('omits the control when onToggleNoNeed is not supplied (pre-172 callers unchanged)', () => {
    const { queryByTestId } = row();
    expect(queryByTestId('eod-noneed-item-1')).toBeNull();
  });

  it('renders the control (localized label + aria) when unlocked and calls back with the item', () => {
    const onToggleNoNeed = jest.fn();
    const { getByTestId, getByText, getByLabelText } = row({ onToggleNoNeed });
    const btn = getByTestId('eod-noneed-item-1');
    expect(getByText('No need')).toBeTruthy();
    expect(getByLabelText('Flour: no need — more than enough')).toBeTruthy();
    expect(btn.props.accessibilityState).toEqual(expect.objectContaining({ selected: false, disabled: false }));
    fireEvent.press(btn);
    expect(onToggleNoNeed).toHaveBeenCalledWith(packItem);
  });

  it('shows the active state and suppresses the total line when noNeed', () => {
    const { getByTestId, queryByTestId } = row({
      onToggleNoNeed: jest.fn(),
      noNeed: true,
      counted: true,
      total: 0,
    });
    expect(getByTestId('eod-noneed-item-1').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(getByTestId('eod-counted-item-1')).toBeTruthy();
    // Never a "Total: 0 lb" line for a NO NEED row (AC-18c parity).
    expect(queryByTestId('eod-item-total-item-1')).toBeNull();
    // Wells stay blank.
    expect(getByTestId('eod-item-units-item-1').props.children).toBe('—');
    expect(getByTestId('eod-item-cases-item-1').props.children).toBe('—');
  });

  it('locked + noNeed: the control shows active and is disabled (no callback)', () => {
    const onToggleNoNeed = jest.fn();
    const { getByTestId } = row({ onToggleNoNeed, noNeed: true, counted: true, locked: true });
    const btn = getByTestId('eod-noneed-item-1');
    expect(btn.props.accessibilityState).toEqual(expect.objectContaining({ selected: true, disabled: true }));
    fireEvent.press(btn);
    expect(onToggleNoNeed).not.toHaveBeenCalled();
  });

  it('locked without noNeed: the control is hidden', () => {
    const { queryByTestId } = row({ onToggleNoNeed: jest.fn(), locked: true, counted: true, unitValue: '3' });
    expect(queryByTestId('eod-noneed-item-1')).toBeNull();
  });
});

describe('StaffKeypadSheet — spec 172 NO NEED', () => {
  it('omits the button when onNoNeed is not supplied', () => {
    const { queryByTestId } = sheet();
    expect(queryByTestId('eod-sheet-noneed')).toBeNull();
  });

  it('renders eod-sheet-noneed when onNoNeed is supplied and fires it', () => {
    const onNoNeed = jest.fn();
    const { getByTestId } = sheet({ onNoNeed });
    fireEvent.press(getByTestId('eod-sheet-noneed'));
    expect(onNoNeed).toHaveBeenCalledTimes(1);
  });

  it('while noNeed, the running total shows the localized label instead of a number', () => {
    const { getByTestId } = sheet({ onNoNeed: jest.fn(), noNeed: true, runningTotal: 0 });
    expect(String(getByTestId('eod-sheet-total').props.children)).toBe('No need');
  });

  it('without noNeed, the running total is the numeric line (unchanged)', () => {
    const { getByTestId } = sheet({ onNoNeed: jest.fn(), runningTotal: 27 });
    expect(String(getByTestId('eod-sheet-total').props.children)).toContain('27');
  });
});
