// src/components/cmd/ExportLocalePicker.tsx
//
// Spec 139 — an EXPORT-SCOPED language picker for the count-export toolbars.
//
// Distinct from `LocaleSwitcher.tsx`: that pill mutates the APP-WIDE locale
// (`setLocale`), which this must NOT do — the picked export language applies to
// that export only and never changes the UI language (spec 139 AC). This is a
// controlled 3-segment control; the section owns the `useState<Locale>`
// (seeded from `useLocale()` on first render) and passes it in.
//
// Copy reuses the locale-invariant labels `chrome.localeSwitcher.labels.*`
// (each catalog ships the same triplet), so the segments read EN / ES / 中文
// regardless of the app's active locale.

import React from 'react';
import { View, TouchableOpacity, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useT } from '../../hooks/useT';
import type { Locale } from '../../i18n';

const SEGMENTS: Locale[] = ['en', 'es', 'zh-CN'];

interface Props {
  value: Locale;
  onChange: (locale: Locale) => void;
}

export const ExportLocalePicker: React.FC<Props> = ({ value, onChange }) => {
  const C = useCmdColors();
  const T = useT();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={T('chrome.localeSwitcher.aria')}
      style={{
        flexDirection: 'row',
        borderRadius: CmdRadius.xs,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.panel2,
        overflow: 'hidden',
      }}
    >
      {SEGMENTS.map((seg, i) => {
        const sel = seg === value;
        return (
          <TouchableOpacity
            key={seg}
            onPress={() => onChange(seg)}
            activeOpacity={0.85}
            accessibilityRole="radio"
            accessibilityState={{ selected: sel }}
            accessibilityLabel={T(`chrome.localeSwitcher.labels.${seg}`)}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderLeftWidth: i === 0 ? 0 : 1,
              borderLeftColor: C.border,
              backgroundColor: sel ? C.accent : 'transparent',
            }}
          >
            <Text
              style={{
                fontFamily: mono(sel ? 700 : 500),
                fontSize: 9.5,
                color: sel ? C.accentFg : C.fg2,
              }}
            >
              {T(`chrome.localeSwitcher.labels.${seg}`)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};
