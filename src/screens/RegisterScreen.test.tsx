// src/screens/RegisterScreen.test.tsx — the password fields' show/hide eyes.

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('../lib/supabase', () => ({ __esModule: true, supabase: {} }));

jest.mock('../lib/auth', () => ({
  __esModule: true,
  registerInvitedUser: jest.fn(),
}));

import RegisterScreen from './RegisterScreen';

describe('RegisterScreen password reveal', () => {
  it('reveals the password and confirm fields independently', () => {
    const { getByTestId } = render(<RegisterScreen />);
    expect(getByTestId('register-password').props.secureTextEntry).toBe(true);
    expect(getByTestId('register-confirm').props.secureTextEntry).toBe(true);

    fireEvent.press(getByTestId('register-password-toggle'));
    expect(getByTestId('register-password').props.secureTextEntry).toBe(false);
    expect(getByTestId('register-confirm').props.secureTextEntry).toBe(true);

    fireEvent.press(getByTestId('register-confirm-toggle'));
    expect(getByTestId('register-confirm').props.secureTextEntry).toBe(false);
  });
});
