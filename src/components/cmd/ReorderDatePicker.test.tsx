// src/components/cmd/ReorderDatePicker.test.tsx — Spec 087.
//
// Component-project (jsdom) tests for the Cmd-native reorder calendar.
// Boundary mocking mirrors MenuCapacityBadge.test.tsx / StatusPill —
// mock useCmdColors so the component renders without the theme provider.
// useT is NOT imported by this component (the calendar's only text is the
// month/day labels + the selected date), so no useT mock is needed.
//
// Covers the architect's calendar contract: default-today, past-only /
// future-disabled, active-day marker, and the Today action.

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
    accent:       '#3F7C20',
    accentBg:     '#E0EFC9',
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

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import ReorderDatePicker from './ReorderDatePicker';
import type { DayName } from '../../utils/enumLabels';

// Fixed reference month: June 2026.
//   2026-06-01 = Monday … 2026-06-15 = Monday, 2026-06-30 = Tuesday.
// Use a maxDate mid-month so there are real past AND future cells in the
// same view.
const MAX_DATE = '2026-06-15'; // a Monday
const VALUE = '2026-06-10';    // a Wednesday (past, selected)

function renderPicker(opts?: {
  value?: string;
  maxDate?: string;
  activeWeekdays?: ReadonlySet<DayName>;
  onChange?: (iso: string) => void;
}) {
  const onChange = opts?.onChange ?? jest.fn();
  const utils = render(
    <ReorderDatePicker
      value={opts?.value ?? VALUE}
      maxDate={opts?.maxDate ?? MAX_DATE}
      activeWeekdays={opts?.activeWeekdays ?? new Set<DayName>()}
      onChange={onChange}
    />,
  );
  // Open the modal so the grid mounts.
  fireEvent.press(screen.getByTestId('reorder-datepicker-trigger'));
  return { ...utils, onChange };
}

describe('ReorderDatePicker', () => {
  it('renders the selected date on the closed-state trigger (default value)', () => {
    render(
      <ReorderDatePicker
        value={VALUE}
        maxDate={MAX_DATE}
        activeWeekdays={new Set<DayName>()}
        onChange={jest.fn()}
      />,
    );
    // formatDisplay('2026-06-10') → "Jun 10, 2026"
    expect(screen.getByTestId('reorder-datepicker-trigger')).toBeTruthy();
    expect(screen.getByText('Jun 10, 2026')).toBeTruthy();
  });

  it('opens the grid and marks the selected cell as selected', () => {
    renderPicker();
    const selectedCell = screen.getByTestId('reorder-datepicker-day-10');
    expect(selectedCell.props.accessibilityState?.selected).toBe(true);
  });

  it('selecting a PAST cell calls onChange with the right ISO and does not error', () => {
    const { onChange } = renderPicker();
    // The 5th (2026-06-05) is in the past relative to maxDate 2026-06-15.
    fireEvent.press(screen.getByTestId('reorder-datepicker-day-5'));
    expect(onChange).toHaveBeenCalledWith('2026-06-05');
  });

  it('disables FUTURE cells and does not call onChange when pressed', () => {
    const { onChange } = renderPicker();
    // The 20th (2026-06-20) is after maxDate 2026-06-15 → disabled.
    const futureCell = screen.getByTestId('reorder-datepicker-day-20');
    expect(futureCell.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(futureCell);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('today (maxDate) is selectable — the latest selectable cell', () => {
    const { onChange } = renderPicker();
    // The 15th IS maxDate → selectable.
    const todayCell = screen.getByTestId('reorder-datepicker-day-15');
    expect(todayCell.props.accessibilityState?.disabled).toBe(false);
    fireEvent.press(todayCell);
    expect(onChange).toHaveBeenCalledWith('2026-06-15');
  });

  it('marks active-weekday cells (Mondays) and not other weekdays', () => {
    // Mondays in June 2026: 1, 8, 15. (15 is maxDate, still selectable +
    // active.) 22 and 29 are future Mondays → not marked (future cells are
    // never highlighted). Wednesdays (e.g. 10) must NOT be marked.
    renderPicker({ activeWeekdays: new Set<DayName>(['Monday']) });

    // Active markers present on past/today Mondays.
    expect(screen.getByTestId('reorder-datepicker-active-1')).toBeTruthy();
    expect(screen.getByTestId('reorder-datepicker-active-8')).toBeTruthy();
    expect(screen.getByTestId('reorder-datepicker-active-15')).toBeTruthy();

    // No marker on a Wednesday.
    expect(screen.queryByTestId('reorder-datepicker-active-10')).toBeNull();

    // No marker on a FUTURE Monday (the 22nd), even though Monday is active.
    expect(screen.queryByTestId('reorder-datepicker-active-22')).toBeNull();
  });

  it('renders no active markers when activeWeekdays is empty', () => {
    renderPicker({ activeWeekdays: new Set<DayName>() });
    expect(screen.queryByTestId('reorder-datepicker-active-1')).toBeNull();
    expect(screen.queryByTestId('reorder-datepicker-active-8')).toBeNull();
  });

  it('the Today action calls onChange(maxDate)', () => {
    const { onChange } = renderPicker({ value: VALUE, maxDate: MAX_DATE });
    fireEvent.press(screen.getByTestId('reorder-datepicker-today'));
    expect(onChange).toHaveBeenCalledWith(MAX_DATE);
  });

  it('navigates months via the prev/next chevrons', () => {
    renderPicker();
    // Opens on June (the selected value's month). Going back lands on May,
    // which has a 31st — June does not display a day-31 cell, May does.
    expect(screen.queryByTestId('reorder-datepicker-day-31')).toBeNull();
    fireEvent.press(screen.getByTestId('reorder-datepicker-prev-month'));
    expect(screen.getByTestId('reorder-datepicker-day-31')).toBeTruthy();
  });
});
