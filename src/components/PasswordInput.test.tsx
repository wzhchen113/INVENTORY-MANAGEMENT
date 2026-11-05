// src/components/PasswordInput.test.tsx — the show/hide eye on pre-auth password fields.

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import { PasswordInput } from './PasswordInput';

const renderField = (props: Partial<React.ComponentProps<typeof PasswordInput>> = {}) =>
  render(<PasswordInput testID="pw" iconColor="#000" value="s3cret" onChangeText={jest.fn()} {...props} />);

describe('PasswordInput', () => {
  it('starts hidden, reveals on press and hides again on a second press', () => {
    const { getByTestId } = renderField();
    expect(getByTestId('pw').props.secureTextEntry).toBe(true);
    fireEvent.press(getByTestId('pw-toggle'));
    expect(getByTestId('pw').props.secureTextEntry).toBe(false);
    fireEvent.press(getByTestId('pw-toggle'));
    expect(getByTestId('pw').props.secureTextEntry).toBe(true);
  });

  it('keeps the typed value when toggled', () => {
    const { getByTestId } = renderField();
    fireEvent.press(getByTestId('pw-toggle'));
    expect(getByTestId('pw').props.value).toBe('s3cret');
  });

  it('labels the toggle with the action it will perform', () => {
    const { getByTestId } = renderField();
    expect(getByTestId('pw-toggle').props.accessibilityLabel).toBe('Show password');
    fireEvent.press(getByTestId('pw-toggle'));
    expect(getByTestId('pw-toggle').props.accessibilityLabel).toBe('Hide password');
  });

  it('uses the translated labels a screen passes in', () => {
    const { getByTestId } = renderField({ showLabel: 'Mostrar', hideLabel: 'Ocultar' });
    expect(getByTestId('pw-toggle').props.accessibilityLabel).toBe('Mostrar');
    fireEvent.press(getByTestId('pw-toggle'));
    expect(getByTestId('pw-toggle').props.accessibilityLabel).toBe('Ocultar');
  });

  it('turns typing aids off so a revealed password is not capitalized, corrected or spellchecked', () => {
    const { getByTestId } = renderField();
    fireEvent.press(getByTestId('pw-toggle'));
    const input = getByTestId('pw');
    expect(input.props.autoCapitalize).toBe('none');
    expect(input.props.autoCorrect).toBe(false);
    expect(input.props.spellCheck).toBe(false);
  });
});
