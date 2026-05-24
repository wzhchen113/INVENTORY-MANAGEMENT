// src/components/Input.tsx — text input primitive with label + min tap target.

import { forwardRef } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { colors, radius, spacing, touchTarget, typography } from '../theme';

type Props = TextInputProps & {
  label?: string;
  errorText?: string;
  testID?: string;
};

export const Input = forwardRef<TextInput, Props>(function Input(
  { label, errorText, testID, style, ...rest },
  ref,
) {
  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        ref={ref}
        testID={testID}
        placeholderTextColor={colors.textSecondary}
        // inputMode for web, keyboardType for native — both kept where
        // the caller supplied them. The decimal-pad case is set by the
        // EODCount input row.
        {...rest}
        style={[styles.input, errorText ? styles.inputError : null, style]}
      />
      {errorText ? <Text style={styles.error}>{errorText}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
  },
  label: {
    fontSize: typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
    fontWeight: typography.medium,
  },
  input: {
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typography.body,
    backgroundColor: colors.surface,
    color: colors.text,
    // Web-only — focus ring control. Native ignores this.
    ...(Platform.OS === 'web' ? { outlineWidth: 0 } : {}),
  },
  inputError: {
    borderColor: colors.error,
  },
  error: {
    fontSize: typography.caption,
    color: colors.error,
    marginTop: spacing.xs,
  },
});
