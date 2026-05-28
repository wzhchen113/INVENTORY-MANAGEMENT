// src/components/Button.tsx — primary CTA button.
//
// Tap target ≥ 44pt per spec 062 §B5/B10. Two variants:
//   - primary  : filled blue (Submit) — gets a subtle elevation lift
//   - secondary: outlined (Cancel, secondary actions) — stays flat
//
// Spec 070: colors come from `useStaffColors()` (light/dark), applied
// inline over a static structural StyleSheet. The primary fill is
// lifted with `useStaffElevation().card`.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, touchTarget, typography, useStaffColors, useStaffElevation } from '../theme';

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary';
  testID?: string;
  accessibilityLabel?: string;
};

export function Button({
  label,
  onPress,
  disabled = false,
  loading = false,
  variant = 'primary',
  testID,
  accessibilityLabel,
}: Props) {
  const c = useStaffColors();
  const e = useStaffElevation();
  const isDisabled = disabled || loading;
  const isPrimary = variant === 'primary';

  // Fill / border resolved per variant + state, applied inline.
  const containerColor = (pressed: boolean) => {
    if (isPrimary) {
      return {
        backgroundColor: isDisabled
          ? c.primaryDisabled
          : pressed
            ? c.primaryPressed
            : c.primary,
      };
    }
    return {
      backgroundColor: pressed && !isDisabled ? c.primaryPressedLight : 'transparent',
      borderColor: isDisabled ? c.borderStrong : c.primary,
    };
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        // Only the secondary (outline) variant adds structural chrome
        // (a border). The primary variant's fill + lift come from
        // containerColor() and e.card below — no structural override.
        !isPrimary && styles.secondary,
        // Subtle lift on the primary filled variant only (not when disabled).
        isPrimary && !isDisabled ? e.card : null,
        containerColor(pressed),
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator
            color={isPrimary ? c.textOnPrimary : c.primary}
            size="small"
          />
        ) : null}
        <Text
          style={[
            styles.label,
            { color: isPrimary ? c.textOnPrimary : c.primary },
            isDisabled && styles.labelDisabled,
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: touchTarget.min,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  secondary: {
    borderWidth: 1,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  label: {
    fontSize: typography.body,
    fontWeight: typography.semibold,
    textAlign: 'center',
  },
  labelDisabled: {
    opacity: 0.7,
  },
});
