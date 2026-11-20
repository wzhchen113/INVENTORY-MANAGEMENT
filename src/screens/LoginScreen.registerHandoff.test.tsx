// src/screens/LoginScreen.registerHandoff.test.tsx — Spec 198 AD-6 (jest).
//
// An invite link is `<origin>/?register=true&invite=<code>`. LoginScreen's
// mount effect navigates to Register and then strips the query string with
// replaceState, so RegisterScreen can't read the URL itself. Spec 198 hands the
// code over as a route param instead. Pins:
//   - `?register=true&invite=X` → navigate('Register', { invite: 'X' }) and
//     replaceState is still called (the code leaves the address bar)
//   - `?register=true` alone → navigate('Register', undefined) (unchanged)
//   - no `register=true` → no navigation, no replaceState
//   - non-web → the effect does nothing
//
// Everything LoginScreen imports beyond react-native is stubbed: this file
// only exercises the mount effect.

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../lib/supabase', () => ({ __esModule: true, supabase: {} }));
jest.mock('../lib/auth', () => ({ __esModule: true, signIn: jest.fn() }));
jest.mock('../lib/authGate', () => ({ __esModule: true, checkAuthGate: jest.fn() }));
jest.mock('../store/useStore', () => ({
  __esModule: true,
  useStore: (selector: (s: { login: () => void }) => unknown) => selector({ login: jest.fn() }),
}));
jest.mock('./staff/store/useStaffStore', () => ({ __esModule: true, useStaffStore: { getState: jest.fn() } }));
jest.mock('./staff/lib/eodQueue', () => ({
  __esModule: true,
  readActiveStoreId: jest.fn(),
  writeActiveStoreId: jest.fn(),
}));
jest.mock('./staff/i18n', () => ({ __esModule: true, t: (k: string) => k }));
jest.mock('../theme/breakpoints', () => ({ __esModule: true, useIsPhone: () => false }));
jest.mock('./cmd/sections/phone/PhoneLogin', () => ({ __esModule: true, PhoneLogin: () => null }));

import React from 'react';
import { Platform } from 'react-native';
import { render } from '@testing-library/react-native';
import LoginScreen from './LoginScreen';

const CODE = '0123456789abcdef0123456789abcdef';
let restoreOS: (() => void) | null = null;
let replaceSpy: jest.SpyInstance;

function setUrl(search: string) {
  window.history.pushState({}, '', `/${search}`);
}

beforeEach(() => {
  mockNavigate.mockClear();
  const replaced = jest.replaceProperty(Platform, 'OS', 'web');
  restoreOS = () => replaced.restore();
  replaceSpy = jest.spyOn(window.history, 'replaceState');
});

afterEach(() => {
  replaceSpy.mockRestore();
  restoreOS?.();
  restoreOS = null;
  window.history.pushState({}, '', '/');
});

describe('LoginScreen → Register hand-off (spec 198 AD-6)', () => {
  it('passes `invite` as a route param and still strips the query string', () => {
    setUrl(`?register=true&invite=${CODE}`);
    render(<LoginScreen />);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Register', { invite: CODE });
    expect(replaceSpy).toHaveBeenCalledWith({}, '', '/');
    expect(window.location.search).toBe('');
  });

  it('navigates before stripping the URL', () => {
    setUrl(`?register=true&invite=${CODE}`);
    render(<LoginScreen />);

    expect(mockNavigate.mock.invocationCallOrder[0]).toBeLessThan(replaceSpy.mock.invocationCallOrder[0]);
  });

  it('`?register=true` with no invite navigates with no params (unchanged)', () => {
    setUrl('?register=true');
    render(<LoginScreen />);

    expect(mockNavigate).toHaveBeenCalledWith('Register', undefined);
    expect(replaceSpy).toHaveBeenCalled();
  });

  it('does not treat `?code=` as an invite (AD-5)', () => {
    setUrl(`?register=true&code=${CODE}`);
    render(<LoginScreen />);

    expect(mockNavigate).toHaveBeenCalledWith('Register', undefined);
  });

  it('no register=true → no navigation and the URL is left alone', () => {
    setUrl(`?invite=${CODE}`);
    render(<LoginScreen />);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('non-web: the effect does nothing', () => {
    restoreOS?.();
    const replaced = jest.replaceProperty(Platform, 'OS', 'ios');
    restoreOS = () => replaced.restore();
    setUrl(`?register=true&invite=${CODE}`);
    render(<LoginScreen />);

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
