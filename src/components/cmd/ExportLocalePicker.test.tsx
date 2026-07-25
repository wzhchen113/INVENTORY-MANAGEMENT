// src/components/cmd/ExportLocalePicker.test.tsx — Spec 139.
//
// Covers the export-scoped language picker: it renders the three locale
// segments, marks the controlled `value` as selected, and calls `onChange`
// on press. Also pins the spec-139 default-seeding CONTRACT via a harness
// mirroring the section pattern (`useState<Locale>(() => useLocale())`) — the
// picker defaults to the app's active locale WITHOUT mutating it.
//
// Boundary mocks (same rationale as StatusPill.test.tsx): the theme + i18n
// hooks read the Zustand store, whose import graph crashes without env vars.

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    accent: '#185FA5',
    accentFg: '#FFFFFF',
    fg2: '#555',
    border: '#DDD',
    panel2: '#F4F4F2',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6, pill: 999 },
}));

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => {
    const dict: Record<string, string> = {
      'chrome.localeSwitcher.aria': 'Change language',
      'chrome.localeSwitcher.labels.en': 'EN',
      'chrome.localeSwitcher.labels.es': 'ES',
      'chrome.localeSwitcher.labels.zh-CN': '中文',
    };
    return dict[key] ?? key;
  },
}));

// The app-wide locale — the section seeds the picker's initial value from
// this. Mocked to zh-CN so the default-seeding assertion is unambiguous.
jest.mock('../../hooks/useLocale', () => ({
  useLocale: () => 'zh-CN',
}));

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ExportLocalePicker } from './ExportLocalePicker';
import { useLocale, type Locale } from '../../hooks/useLocale';

describe('ExportLocalePicker', () => {
  it('renders the three locale segments', () => {
    render(<ExportLocalePicker value="en" onChange={() => {}} />);
    expect(screen.getByText('EN')).toBeTruthy();
    expect(screen.getByText('ES')).toBeTruthy();
    expect(screen.getByText('中文')).toBeTruthy();
  });

  it('marks the controlled value as the selected segment', () => {
    render(<ExportLocalePicker value="es" onChange={() => {}} />);
    expect(screen.getByLabelText('ES').props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText('EN').props.accessibilityState.selected).toBe(false);
    expect(screen.getByLabelText('中文').props.accessibilityState.selected).toBe(false);
  });

  it('calls onChange with the pressed locale', () => {
    const onChange = jest.fn();
    render(<ExportLocalePicker value="en" onChange={onChange} />);
    fireEvent.press(screen.getByLabelText('中文'));
    expect(onChange).toHaveBeenCalledWith('zh-CN');
  });

  it('defaults to the app active locale when seeded via useLocale() (export-scoped, no setLocale)', () => {
    // Harness mirrors the section wiring: local state seeded once from the
    // app locale (mocked zh-CN). The picker must show 中文 selected without
    // touching the app-wide locale.
    function Harness() {
      const app = useLocale();
      const [loc, setLoc] = React.useState<Locale>(() => app);
      return <ExportLocalePicker value={loc} onChange={setLoc} />;
    }
    render(<Harness />);
    expect(screen.getByLabelText('中文').props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText('EN').props.accessibilityState.selected).toBe(false);
  });
});
