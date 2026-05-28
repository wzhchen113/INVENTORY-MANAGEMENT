// src/components/Banner.tsx — top-of-screen info/error banner.
//
// Used by EODCount for the "Last submitted at HH:MM" pre-fill notice
// and for the forbidden-store error message. Pure presentational —
// dismissibility is the caller's concern.
//
// Spec 070: soft-card radius (lg) to match cards, keeps the 4pt left
// accent bar as the tone signal. The tone map is built INSIDE the
// component from the active palette (it previously closed over the
// static `colors` at module load and would not react to dark mode).

import { StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography, useStaffColors, type StaffColors } from '../theme';

type Tone = 'info' | 'warning' | 'error' | 'success';

type Props = {
  tone?: Tone;
  text: string;
  testID?: string;
};

function makeToneStyles(
  c: StaffColors,
): Record<Tone, { bg: string; fg: string; border: string }> {
  return {
    info: { bg: c.infoBg, fg: c.info, border: c.info },
    warning: { bg: c.warningBg, fg: c.warning, border: c.warning },
    error: { bg: c.errorBg, fg: c.error, border: c.error },
    success: { bg: c.successBg, fg: c.success, border: c.success },
  };
}

export function Banner({ tone = 'info', text, testID }: Props) {
  const c = useStaffColors();
  const t = makeToneStyles(c)[tone];
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={[styles.banner, { backgroundColor: t.bg, borderLeftColor: t.border }]}
    >
      <Text style={[styles.text, { color: t.fg }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderLeftWidth: 4,
    borderRadius: radius.lg,
    // Inset to match the item-card gutter (FlatList itemList uses
    // spacing.lg) so the soft-card corners read instead of bleeding to
    // the screen edges. Banner is only ever a full-width screen sibling
    // in EODCount, so the margin lives on the component.
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  text: {
    fontSize: typography.body,
    fontWeight: typography.medium,
    lineHeight: typography.lineHeightBody,
  },
});
