// src/components/cmd/EodPopupToast.tsx — Spec 180 (release-proposal S-1).
//
// The custom `eodPopup` toast type the admin EOD pop-up renders with. The
// library's default `info` toast is a fixed 340x60 box with a one-line title,
// which truncated a grouped title's "(N updated)" marker — and lost it entirely
// in `es` — so AC-4's "the copy still says it contains updates" was not met on
// screen. This wraps the library's own BaseToast with a 2-line title + body and
// an auto height (60 kept as the floor), colored from the Cmd palette.
//
// Registered in App.tsx as `<Toast config={eodPopupToastConfig} />`. The
// library spreads its default config first, so `success` / `error` / `info`
// keep rendering exactly as before; only the new type is added.

import React from 'react';
import { BaseToast, type ToastConfig, type ToastConfigParams } from 'react-native-toast-message';
import { useCmdColors } from '../../theme/colors';
import { EOD_POPUP_TOAST_TYPE } from '../../lib/eodPopup';

/** Max lines for the pop-up's title and body (vs the library default of 1). */
export const EOD_POPUP_TEXT_LINES = 2;
/** The library's fixed toast height, kept as the minimum. */
const MIN_HEIGHT = 60;

type Props = Pick<ToastConfigParams<unknown>, 'text1' | 'text2' | 'onPress'>;

export const EodPopupToast: React.FC<Props> = ({ text1, text2, onPress }) => {
  const C = useCmdColors();
  return (
    <BaseToast
      text1={text1}
      text2={text2}
      onPress={onPress}
      text1NumberOfLines={EOD_POPUP_TEXT_LINES}
      text2NumberOfLines={EOD_POPUP_TEXT_LINES}
      style={{
        height: 'auto',
        minHeight: MIN_HEIGHT,
        backgroundColor: C.panel,
        borderLeftColor: C.accent,
      }}
      contentContainerStyle={{ paddingVertical: 10 }}
      text1Style={{ color: C.fg }}
      text2Style={{ color: C.fg2 }}
    />
  );
};

/** Toast config fragment for App.tsx. Additive: the library merges it over its
 *  default success / error / info types. */
export const eodPopupToastConfig: ToastConfig = {
  [EOD_POPUP_TOAST_TYPE]: ({ text1, text2, onPress }) => (
    <EodPopupToast text1={text1} text2={text2} onPress={onPress} />
  ),
};
