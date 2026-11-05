// src/components/PasswordInput.tsx
//
// A TextInput with an eye toggle inside its right edge, shared by the pre-auth
// password fields (login, phone login, register, recovery). Each input owns its
// show/hide flag and starts hidden on every mount. `style` is applied to the
// input, so each screen keeps its own look.
//
// The value is plain text while revealed, so typing aids are off by default:
// without this, a phone keyboard would capitalize or autocorrect the password
// and browsers could send it to their spellcheck service.

import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, type TextInputProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const TOGGLE_WIDTH = 44;

interface Props extends Omit<TextInputProps, 'secureTextEntry'> {
  iconColor: string;
  /** Override for translated screens; the other pre-auth screens are English-only. */
  showLabel?: string;
  hideLabel?: string;
}

export const PasswordInput: React.FC<Props> = ({
  iconColor,
  showLabel = 'Show password',
  hideLabel = 'Hide password',
  style,
  testID,
  ...inputProps
}) => {
  const [visible, setVisible] = useState(false);
  return (
    <View>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        {...inputProps}
        testID={testID}
        secureTextEntry={!visible}
        style={[style, { paddingRight: TOGGLE_WIDTH }]}
      />
      <TouchableOpacity
        testID={testID ? `${testID}-toggle` : undefined}
        onPress={() => setVisible((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={visible ? hideLabel : showLabel}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: 0,
          width: TOGGLE_WIDTH,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={20} color={iconColor} />
      </TouchableOpacity>
    </View>
  );
};
