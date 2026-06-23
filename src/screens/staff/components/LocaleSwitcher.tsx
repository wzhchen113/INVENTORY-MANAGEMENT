// src/screens/staff/components/LocaleSwitcher.tsx — compact EN / ES / 中文
// segmented selector for the staff app.
//
// Three side-by-side pills (one per locale) rather than the admin's
// cycle-pill, because the staff app is touch-first: a directly-tappable
// target per language beats a "tap to cycle" affordance under gloves.
// Each segment is ≥ the touch-target min height. The active segment fills
// with `primary`; inactive segments are outline pills.
//
// Reads the live locale from `useStaffStore` so the component re-renders
// when the language changes (and the active fill follows). The segment
// labels are locale-invariant (each catalog ships the same EN/ES/中文
// triplet) so a Chinese user already sees 中文 highlighted.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, touchTarget, typography, useStaffColors } from '../theme';
import { useStaffStore } from '../store/useStaffStore';
import { useI18n, type Locale } from '../i18n';

const LOCALES: Locale[] = ['en', 'es', 'zh-CN'];

type Props = {
  testID?: string;
};

export function LocaleSwitcher({ testID }: Props) {
  const c = useStaffColors();
  const { t } = useI18n();
  const locale = useStaffStore((s) => s.locale);
  const setLocale = useStaffStore((s) => s.setLocale);

  return (
    <View
      style={[styles.row, { borderColor: c.border }]}
      accessibilityRole="radiogroup"
      accessibilityLabel={t('chrome.localeSwitcher.aria')}
      testID={testID ?? 'staff-locale-switcher'}
    >
      {LOCALES.map((code) => {
        const active = code === locale;
        const label = t(`chrome.localeSwitcher.labels.${code}`);
        return (
          <Pressable
            key={code}
            onPress={() => setLocale(code)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={label}
            testID={`staff-locale-${code}`}
            style={({ pressed }) => [
              styles.segment,
              {
                backgroundColor: active
                  ? c.primary
                  : pressed
                    ? c.surfaceAlt
                    : 'transparent',
              },
            ]}
          >
            <Text
              style={[
                styles.label,
                {
                  color: active ? c.textOnPrimary : c.textSecondary,
                  fontWeight: active ? typography.semibold : typography.medium,
                },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  segment: {
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: typography.caption,
  },
});
