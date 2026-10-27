// src/components/cmd/EodPopupToast.test.tsx — Spec 180 (release-proposal S-1).
//
// Pins the custom `eodPopup` toast type: 2-line title + body (the library
// default is 1) and no fixed 60px height, so the longest grouped titles — the
// en and es mixed titles with their "(N updated)" marker — wrap instead of
// being truncated. Also pins that the config fragment adds ONLY the new type
// (the library keeps its default success / error / info).

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

// tests/jest.setup.ts stubs this module globally (show/hide only); this test
// needs the library's real BaseToast, which the component wraps.
jest.unmock('react-native-toast-message');

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({ panel: 'PANEL', accent: 'ACCENT', fg: 'FG', fg2: 'FG2' }),
}));

import { eodPopupToastConfig, EOD_POPUP_TEXT_LINES } from './EodPopupToast';
import { EOD_POPUP_TOAST_TYPE } from '../../lib/eodPopup';

const LONG_EN = 'Reisterstown: 6 vendor counts submitted (3 updated)';
const LONG_ES = 'Reisterstown: 6 conteos por proveedor enviados (actualizados: 3)';

function renderToast(text1: string, text2: string, onPress = jest.fn()) {
  const renderer = eodPopupToastConfig[EOD_POPUP_TOAST_TYPE];
  const el = renderer({
    position: 'top', type: EOD_POPUP_TOAST_TYPE, isVisible: true, text1, text2,
    show: jest.fn(), hide: jest.fn(), onPress, props: {},
  });
  return render(<>{el}</>);
}

describe('eodPopup toast type', () => {
  it('registers only the eodPopup key (defaults stay with the library)', () => {
    expect(Object.keys(eodPopupToastConfig)).toEqual(['eodPopup']);
  });

  it.each([LONG_EN, LONG_ES])('renders "%s" on up to 2 lines with no fixed height', (title) => {
    const { getByText, getByTestId } = renderToast(title, 'by Cook and 2 more · 2 ready to approve');
    expect(EOD_POPUP_TEXT_LINES).toBe(2);
    expect(getByText(title).props.numberOfLines).toBe(2);
    expect(getByText('by Cook and 2 more · 2 ready to approve').props.numberOfLines).toBe(2);
    const style = StyleSheet.flatten(getByTestId('toastTouchableContainer').props.style);
    expect(style.height).not.toBe(60);
    expect(style.minHeight).toBe(60);
    expect(style.borderLeftColor).toBe('ACCENT');
    expect(style.backgroundColor).toBe('PANEL');
  });

  it('forwards onPress', () => {
    const onPress = jest.fn();
    const { getByText } = renderToast('Towson: EOD count updated', 'by Manager', onPress);
    fireEvent.press(getByText('Towson: EOD count updated'));
    expect(onPress).toHaveBeenCalled();
  });
});
