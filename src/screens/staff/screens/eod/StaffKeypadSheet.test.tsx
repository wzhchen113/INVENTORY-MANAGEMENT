// src/screens/staff/screens/eod/StaffKeypadSheet.test.tsx — Spec 141 §12(c).
//
// Presentational keypad sheet: header/title + ✕, the two field wells with
// active-field select, the running total, the 3-column digit pad, and the
// SKIP / NEXT-ITEM→DONE footer. Every write is a callback to the orchestrator;
// the full open→enter→advance→gate flow is exercised end-to-end in
// EODCount.test.tsx. There is deliberately NO note input (OQ-A).

import { fireEvent, render } from '@testing-library/react-native';
import { StaffKeypadSheet, type StaffKeypadSheetProps } from './StaffKeypadSheet';
import { KEYPAD_BACKSPACE } from '../../lib/eodKeypad';
import type { EodItem } from '../../lib/types';

const packItem: EodItem = {
  id: 'item-1',
  vendorId: 'v-1',
  name: 'Flour',
  unit: 'lb',
  caseQty: 12,
};

function setup(overrides: Partial<StaffKeypadSheetProps> = {}) {
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

describe('StaffKeypadSheet', () => {
  it('renders the item title + both wells for a pack item', () => {
    const { getByTestId } = setup();
    expect(getByTestId('eod-sheet-title').props.children).toBe('Flour');
    expect(getByTestId('eod-sheet-well-cases')).toBeTruthy();
    expect(getByTestId('eod-sheet-well-units')).toBeTruthy();
  });

  it('renders only the units well when the item has no pack', () => {
    const { queryByTestId, getByTestId } = setup({
      item: { ...packItem, caseQty: 1 },
    });
    expect(queryByTestId('eod-sheet-well-cases')).toBeNull();
    expect(getByTestId('eod-sheet-well-units')).toBeTruthy();
  });

  it('renders nothing when item is null', () => {
    const { queryByTestId } = setup({ item: null });
    expect(queryByTestId('eod-sheet-title')).toBeNull();
  });

  it('forwards each digit / dot / backspace key to onKey', () => {
    const { getByTestId, props } = setup();
    fireEvent.press(getByTestId('eod-key-7'));
    expect(props.onKey).toHaveBeenCalledWith('7');
    fireEvent.press(getByTestId('eod-key-dot'));
    expect(props.onKey).toHaveBeenCalledWith('.');
    fireEvent.press(getByTestId('eod-key-0'));
    expect(props.onKey).toHaveBeenCalledWith('0');
    fireEvent.press(getByTestId('eod-key-back'));
    expect(props.onKey).toHaveBeenCalledWith(KEYPAD_BACKSPACE);
  });

  it('switches the active field when the inactive well is tapped (AC-6)', () => {
    const { getByTestId, props } = setup({ activeField: 'units' });
    fireEvent.press(getByTestId('eod-sheet-well-cases'));
    expect(props.setActiveField).toHaveBeenCalledWith('cases');
  });

  it('shows the active well value and the running total', () => {
    const { getByTestId } = setup({ activeField: 'units', unitValue: '112', runningTotal: 112 });
    expect(String(getByTestId('eod-sheet-total').props.children)).toContain('112');
  });

  it('SKIP and NEXT ITEM invoke their handlers', () => {
    const { getByTestId, props } = setup();
    fireEvent.press(getByTestId('eod-sheet-skip'));
    expect(props.onSkip).toHaveBeenCalled();
    fireEvent.press(getByTestId('eod-sheet-next'));
    expect(props.onNext).toHaveBeenCalled();
  });

  it('labels the advance button "Next item →" while work remains and "Done ✓" when done', () => {
    const remaining = setup({ isDone: false });
    expect(remaining.getByTestId('eod-sheet-next').props.accessibilityLabel).toBe('Next item →');
    remaining.unmount();
    const done = setup({ isDone: true });
    expect(done.getByTestId('eod-sheet-next').props.accessibilityLabel).toBe('Done ✓');
  });

  it('✕ close calls onClose', () => {
    const { getByTestId, props } = setup();
    fireEvent.press(getByTestId('eod-sheet-close'));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('renders NO note input (OQ-A)', () => {
    const { UNSAFE_queryAllByType } = setup();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TextInput } = require('react-native');
    expect(UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
  });
});
