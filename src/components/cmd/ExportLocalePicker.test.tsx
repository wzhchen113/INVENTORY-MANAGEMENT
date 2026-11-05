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
import { StyleSheet, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
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

// Spec 183 — additive props. The four spec-139 cases above are unedited; these
// pin the new props AND that the defaults leave the spec-139 render unchanged.
describe('ExportLocalePicker — spec 183 additive props', () => {
  const flat = (style: unknown) => (StyleSheet.flatten(style as StyleProp<ViewStyle & TextStyle>) ?? {}) as ViewStyle & TextStyle;

  it('options renders only the listed locales, in canonical order (even if passed reversed)', () => {
    render(<ExportLocalePicker value="en" onChange={() => {}} options={['es', 'en']} testIDPrefix="p" />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.props.accessibilityLabel)).toEqual(['EN', 'ES']);
    expect(screen.queryByText('中文')).toBeNull();
    // The divider index is the FILTERED index: the first segment has no left border.
    expect(flat(screen.getByTestId('p-en').props.style).borderLeftWidth).toBe(0);
    expect(flat(screen.getByTestId('p-es').props.style).borderLeftWidth).toBe(1);
  });

  it('default props: no testID, and the spec-139 compact styles are byte-identical', () => {
    render(<ExportLocalePicker value="en" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    radios.forEach((r) => expect(r.props.testID).toBeUndefined());
    const segStyle = flat(screen.getByLabelText('ES').props.style);
    expect(segStyle.paddingVertical).toBe(3);
    expect(segStyle.paddingHorizontal).toBe(8);
    expect(segStyle.minHeight).toBeUndefined();
    expect(flat(screen.getByText('ES').props.style).fontSize).toBe(9.5);
    // Default radiogroup label is still the spec-139 one.
    expect(screen.getByLabelText('Change language')).toBeTruthy();
  });

  it('accessibilityLabel overrides the radiogroup label', () => {
    render(<ExportLocalePicker value="en" onChange={() => {}} accessibilityLabel="Choose export language" />);
    expect(screen.getByLabelText('Choose export language').props.accessibilityRole).toBe('radiogroup');
    expect(screen.queryByLabelText('Change language')).toBeNull();
  });

  it('testIDPrefix produces `${prefix}-${locale}` on each segment', () => {
    render(<ExportLocalePicker value="en" onChange={() => {}} testIDPrefix="export-lang-option" />);
    expect(screen.getByTestId('export-lang-option-en')).toBeTruthy();
    expect(screen.getByTestId('export-lang-option-es')).toBeTruthy();
    expect(screen.getByTestId('export-lang-option-zh-CN')).toBeTruthy();
  });

  it("size='touch' gives 44-tall segments", () => {
    render(<ExportLocalePicker value="en" onChange={() => {}} size="touch" testIDPrefix="p" />);
    expect(flat(screen.getByTestId('p-en').props.style).minHeight).toBe(44);
  });
});
