// src/components/Banner.tsx — top-of-screen info/error banner.
//
// Used by EODCount for the "Last submitted at HH:MM" pre-fill notice
// and for the forbidden-store error message. Pure presentational —
// dismissibility is the caller's concern.

import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../theme';

type Tone = 'info' | 'warning' | 'error' | 'success';

type Props = {
  tone?: Tone;
  text: string;
  testID?: string;
};

const TONE_STYLES: Record<Tone, { bg: string; fg: string; border: string }> = {
  info: { bg: colors.infoBg, fg: colors.info, border: colors.info },
  warning: { bg: colors.warningBg, fg: colors.warning, border: colors.warning },
  error: { bg: colors.errorBg, fg: colors.error, border: colors.error },
  success: { bg: colors.successBg, fg: colors.success, border: colors.success },
};

export function Banner({ tone = 'info', text, testID }: Props) {
  const t = TONE_STYLES[tone];
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={[
        styles.banner,
        { backgroundColor: t.bg, borderLeftColor: t.border },
      ]}
    >
      <Text style={[styles.text, { color: t.fg }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderLeftWidth: 4,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
  },
  text: {
    fontSize: typography.body,
    fontWeight: typography.medium,
    lineHeight: 22,
  },
});
