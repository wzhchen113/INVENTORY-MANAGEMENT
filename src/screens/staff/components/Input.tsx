// src/components/Input.tsx — text input primitive with label + min tap target.
//
// Spec 070: a faint "pill" field — fill `surfaceAlt` (recessed look),
// hairline border, error border in `error`. Colors come from
// `useStaffColors()`, applied inline over a static structural
// StyleSheet.

import { forwardRef, useMemo } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../theme';

type Props = TextInputProps & {
  label?: string;
  errorText?: string;
  testID?: string;
};

export const Input = forwardRef<TextInput, Props>(function Input(
  { label, errorText, testID, style, ...rest },
  ref,
) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  return (
    <View style={styles.wrap}>
      {label ? (
        <Text style={[styles.label, { color: c.textSecondary }]}>{label}</Text>
      ) : null}
      <TextInput
        ref={ref}
        testID={testID}
        // Placeholder is decorative (not read-critical body text), so the
        // de-emphasized tertiary tier is allowed here per §2.
        placeholderTextColor={c.textTertiary}
        // inputMode for web, keyboardType for native — both kept where
        // the caller supplied them. The decimal-pad case is set by the
        // EODCount input row.
        {...rest}
        style={[
          styles.input,
          {
            backgroundColor: c.surfaceAlt,
            borderColor: errorText ? c.error : c.border,
            color: c.text,
          },
          style,
        ]}
      />
      {errorText ? (
        <Text style={[styles.error, { color: c.error }]}>{errorText}</Text>
      ) : null}
    </View>
  );
});

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  wrap: {
    width: '100%',
  },
  label: {
    fontSize: T.typography.caption,
    marginBottom: T.spacing.xs,
    fontWeight: T.typography.medium,
  },
  input: {
    minHeight: T.touchTarget.min,
    borderWidth: 1,
    borderRadius: T.radius.sm,
    paddingHorizontal: T.spacing.sm,
    paddingVertical: T.spacing.xs,
    fontSize: T.typography.body,
    // Web-only — focus ring control. Native ignores this.
    ...(Platform.OS === 'web' ? { outlineWidth: 0 } : {}),
  },
  error: {
    fontSize: T.typography.caption,
    marginTop: T.spacing.xs,
  },
});
