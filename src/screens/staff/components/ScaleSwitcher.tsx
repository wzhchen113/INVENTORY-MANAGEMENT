// src/screens/staff/components/ScaleSwitcher.tsx — compact x1 / x1.5 / x2
// segmented selector for the staff UI scale.
//
// Mirrors LocaleSwitcher's three-pill shape (touch-first: one directly
// tappable target per option). The labels are numeric and locale-invariant;
// only the aria label is translated. Reads/writes `uiScale` on
// `useStaffStore` — `useStaffTokens()` consumers across the staff surface
// re-render when it changes, and the pref persists per device via the
// AsyncStorage cache (see setUiScale).

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  UI_SCALES,
  useStaffColors,
  useStaffTokens,
  type StaffTokens,
  type UiScale,
} from '../theme';
import { useStaffStore } from '../store/useStaffStore';
import { useI18n } from '../i18n';

const LABELS: Record<UiScale, string> = { 1: 'x1', 1.2: 'x1.2', 1.5: 'x1.5' };

type Props = {
  testID?: string;
};

export function ScaleSwitcher({ testID }: Props) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  const uiScale = useStaffStore((s) => s.uiScale);
  const setUiScale = useStaffStore((s) => s.setUiScale);

  return (
    <View
      style={[styles.row, { borderColor: c.border }]}
      accessibilityRole="radiogroup"
      accessibilityLabel={t('chrome.scaleSwitcher.aria')}
      testID={testID ?? 'staff-scale-switcher'}
    >
      {UI_SCALES.map((scale) => {
        const active = scale === uiScale;
        const label = LABELS[scale];
        return (
          <Pressable
            key={scale}
            onPress={() => setUiScale(scale)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={label}
            testID={`staff-scale-${scale}`}
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
                  fontWeight: active ? T.typography.semibold : T.typography.medium,
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

const makeStyles = (T: StaffTokens) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      borderWidth: 1,
      borderRadius: T.radius.md,
      overflow: 'hidden',
    },
    segment: {
      minHeight: T.touchTarget.min,
      paddingHorizontal: T.spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: {
      fontSize: T.typography.caption,
    },
  });
