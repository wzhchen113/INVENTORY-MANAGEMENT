// src/components/cmd/LocaleSwitcher.tsx
//
// Spec 038 — three-state cycle pill that mirrors the ThemeToggle shape.
// Tap cycles EN → ES → 中文 → EN. The pill copy is the locale's own
// short name pulled from the catalog (`chrome.localeSwitcher.labels.<code>`),
// which is locale-invariant by design (each catalog has the same triplet)
// so a Chinese user sees `中文` already and a Spanish user sees `ES`.
//
// Pattern matches `src/components/cmd/ThemeToggle.tsx`:
//   - CmdRadius.xs / panel2 / fg2 token language
//   - mono(500) typography at 9.5 fontSize
//   - same paddingHorizontal/paddingVertical
// so the two pills sit side-by-side without visual divergence.

import React from 'react';
import { TouchableOpacity, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useT } from '../../hooks/useT';
import { useLocale } from '../../hooks/useLocale';
import type { Locale } from '../../i18n';

const CYCLE: Locale[] = ['en', 'es', 'zh-CN'];

function nextLocale(current: Locale): Locale {
  const idx = CYCLE.indexOf(current);
  return CYCLE[(idx + 1) % CYCLE.length];
}

export const LocaleSwitcher: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const setLocale = useStore((s) => s.setLocale);
  const label = T(`chrome.localeSwitcher.labels.${locale}`);
  return (
    <TouchableOpacity
      onPress={() => setLocale(nextLocale(locale))}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={T('chrome.localeSwitcher.aria')}
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: CmdRadius.xs,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.panel2,
      }}
    >
      <Text style={{ fontFamily: mono(500), fontSize: 9.5, color: C.fg2 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
};
