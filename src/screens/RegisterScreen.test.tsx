// src/screens/RegisterScreen.test.tsx — the password fields' show/hide eyes,
// plus spec 198 B9: the invite-code field.
//
// Spec 198 — LoginScreen hands `?invite=<code>` over as the `invite` route
// param (AD-6); this screen prefills `register-code` from it, validates the
// code client-side (email → code → password → confirm), and calls
// registerInvitedUser(email, password, normalizedCode).

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

// Prefixed `mock` so the hoisted factory below may reference it.
let mockRouteParams: { invite?: string } | undefined;

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
  useRoute: () => ({ key: 'Register-1', name: 'Register', params: mockRouteParams }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('../lib/supabase', () => ({ __esModule: true, supabase: {} }));

jest.mock('../lib/auth', () => ({
  __esModule: true,
  registerInvitedUser: jest.fn(),
  INVITE_CODE_REQUIRED_ERROR: 'Enter the invite code from your invitation link.',
}));

import RegisterScreen from './RegisterScreen';
import { registerInvitedUser } from '../lib/auth';

const registerMock = registerInvitedUser as jest.Mock;
const CODE = '0123456789abcdef0123456789abcdef';
const CODE_REQUIRED = 'Enter the invite code from your invitation link.';

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = undefined;
  registerMock.mockResolvedValue({ user: null, error: null });
});

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

describe('RegisterScreen invite code (spec 198 B9)', () => {
  const fill = (utils: ReturnType<typeof render>, opts: { code?: string } = {}) => {
    fireEvent.changeText(utils.getByTestId('register-email'), 'invitee@example.com');
    if (opts.code !== undefined) fireEvent.changeText(utils.getByTestId('register-code'), opts.code);
    fireEvent.changeText(utils.getByTestId('register-password'), 'secret123');
    fireEvent.changeText(utils.getByTestId('register-confirm'), 'secret123');
  };

  it('prefills register-code from the `invite` route param (normalized)', () => {
    mockRouteParams = { invite: ` ${CODE.toUpperCase()} ` };
    const { getByTestId } = render(<RegisterScreen />);
    expect(getByTestId('register-code').props.value).toBe(CODE);
  });

  it('register-code is empty with no route param, and is not auto-capitalized', () => {
    const { getByTestId } = render(<RegisterScreen />);
    const field = getByTestId('register-code');
    expect(field.props.value).toBe('');
    expect(field.props.autoCapitalize).toBe('none');
    expect(field.props.autoCorrect).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['too short', CODE.slice(4)],
    ['non-hex', 'not-an-invite-code-not-an-invite'],
  ])('an %s code shows the client error and does not call registerInvitedUser', async (_label, code) => {
    const utils = render(<RegisterScreen />);
    fill(utils, { code });
    await act(async () => {
      fireEvent.press(utils.getByTestId('register-submit'));
    });

    expect(utils.getByTestId('register-error').props.children).toBe(CODE_REQUIRED);
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('validates the code before the password rules', async () => {
    const utils = render(<RegisterScreen />);
    fireEvent.changeText(utils.getByTestId('register-email'), 'invitee@example.com');
    // No code AND no password: the code error wins (email → code → password).
    await act(async () => {
      fireEvent.press(utils.getByTestId('register-submit'));
    });
    expect(utils.getByTestId('register-error').props.children).toBe(CODE_REQUIRED);
  });

  it('a valid code calls registerInvitedUser(email, password, normalizedCode)', async () => {
    mockRouteParams = { invite: CODE };
    const utils = render(<RegisterScreen />);
    fill(utils);
    await act(async () => {
      fireEvent.press(utils.getByTestId('register-submit'));
    });

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith('invitee@example.com', 'secret123', CODE);
    expect(utils.getByTestId('register-success')).toBeTruthy();
    expect(utils.getByTestId('register-go-signin')).toBeTruthy();
  });

  it('a pasted full link in register-code is reduced to the code', async () => {
    const utils = render(<RegisterScreen />);
    fill(utils, { code: `https://imr.example.com/?register=true&invite=${CODE}` });
    await act(async () => {
      fireEvent.press(utils.getByTestId('register-submit'));
    });

    expect(registerMock).toHaveBeenCalledWith('invitee@example.com', 'secret123', CODE);
  });

  it('a server error is shown in register-error', async () => {
    registerMock.mockResolvedValueOnce({ user: null, error: 'No pending invitation matches this email and invite code.' });
    mockRouteParams = { invite: CODE };
    const utils = render(<RegisterScreen />);
    fill(utils);
    await act(async () => {
      fireEvent.press(utils.getByTestId('register-submit'));
    });

    expect(utils.getByTestId('register-error').props.children).toBe(
      'No pending invitation matches this email and invite code.',
    );
    expect(utils.queryByTestId('register-success')).toBeNull();
  });
});
