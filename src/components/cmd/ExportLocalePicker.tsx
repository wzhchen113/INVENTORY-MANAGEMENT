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
//
// Spec 183 added optional, backward-compatible props (`options`, `size`,
// `accessibilityLabel`, `testIDPrefix`) so the Ordering-page export language
// prompt (`ExportLanguagePrompt`) can host it. With none of them passed, the
// render is identical to spec 139's (the count-export call sites are unedited).

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
  /** Spec 183. Subset of locales to render. Default: all three. Rendered in the
   *  canonical order en → es → zh-CN whatever order the caller passes.
   *  A locale not listed is NOT rendered (not greyed out). */
  options?: readonly Locale[];
  /** Spec 183. 'compact' (default) = the exact spec-139 styles.
   *  'touch' = phone-safe targets: each segment flex:1, minHeight 44,
   *  centered, label fontSize 12. */
  size?: 'compact' | 'touch';
  /** Spec 183. Overrides the radiogroup label. Default: T('chrome.localeSwitcher.aria'). */
  accessibilityLabel?: string;
  /** Spec 183. When set, each segment gets testID `${testIDPrefix}-${locale}`.
   *  Default: no testID (spec-139 render unchanged). */
  testIDPrefix?: string;
}

export const ExportLocalePicker: React.FC<Props> = ({
  value,
  onChange,
  options,
  size = 'compact',
  accessibilityLabel,
  testIDPrefix,
}) => {
  const C = useCmdColors();
  const T = useT();
  // Spec 183 — filter the CANONICAL list (never the caller's order), so the
  // segment order is stable and the divider index below is the filtered index.
  const segments = options ? SEGMENTS.filter((s) => options.includes(s)) : SEGMENTS;
  const touch = size === 'touch';
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel ?? T('chrome.localeSwitcher.aria')}
      style={{
        flexDirection: 'row',
        borderRadius: CmdRadius.xs,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.panel2,
        overflow: 'hidden',
      }}
    >
      {segments.map((seg, i) => {
        const sel = seg === value;
        return (
          <TouchableOpacity
            key={seg}
            {...(testIDPrefix ? { testID: `${testIDPrefix}-${seg}` } : {})}
            onPress={() => onChange(seg)}
            activeOpacity={0.85}
            accessibilityRole="radio"
            accessibilityState={{ selected: sel }}
            accessibilityLabel={T(`chrome.localeSwitcher.labels.${seg}`)}
            style={
              touch
                ? {
                    flex: 1,
                    minHeight: 44,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingHorizontal: 8,
                    borderLeftWidth: i === 0 ? 0 : 1,
                    borderLeftColor: C.border,
                    backgroundColor: sel ? C.accent : 'transparent',
                  }
                : {
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderLeftWidth: i === 0 ? 0 : 1,
                    borderLeftColor: C.border,
                    backgroundColor: sel ? C.accent : 'transparent',
                  }
            }
          >
            <Text
              style={{
                fontFamily: mono(sel ? 700 : 500),
                fontSize: touch ? 12 : 9.5,
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
