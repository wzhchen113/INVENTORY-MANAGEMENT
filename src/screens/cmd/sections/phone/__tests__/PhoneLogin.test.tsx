// src/screens/cmd/sections/phone/__tests__/PhoneLogin.test.tsx
//
// Spec 148 — the phone-tier login restyle (README §19). Behavioral suite for the
// presentational PhoneLogin (brand mark + fields + SIGN IN + honest FORGOT
// PASSWORD toast) PLUS the LoginScreen fork pin (isPhone → PhoneLogin renders;
// desktop → the byte-unchanged card layout, no phone component).

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

let mockTier: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => mockTier === 'phone',
    useIsTablet: () => mockTier === 'tablet',
    useIsDesktop: () => mockTier === 'desktop',
    useBreakpoint: () => mockTier,
  };
});

import { PhoneLogin, type PhoneLoginModel } from '../PhoneLogin';
import LoginScreen from '../../../../LoginScreen';

function makeModel(over: Partial<PhoneLoginModel> = {}): PhoneLoginModel {
  return {
    identifier: '',
    setIdentifier: jest.fn(),
    password: '',
    setPassword: jest.fn(),
    loading: false,
    error: '',
    onSubmit: jest.fn(),
    onRegister: jest.fn(),
    demoUsers: [],
    onQuickLogin: jest.fn(),
    ...over,
  };
}

beforeEach(() => { jest.clearAllMocks(); mockTier = 'phone'; });

describe('PhoneLogin (presentational)', () => {
  it('renders the im.cmd brand mark, console caption and the two 48px wells', () => {
    const { getByText, getByTestId } = render(<PhoneLogin model={makeModel()} />);
    expect(getByText('im.cmd')).toBeTruthy();
    expect(getByText('▮')).toBeTruthy();
    expect(getByText('RESTAURANT COMMAND CONSOLE')).toBeTruthy();
    expect(getByTestId('phone-login-identifier')).toBeTruthy();
    expect(getByTestId('phone-login-password')).toBeTruthy();
  });

  it('SIGN IN calls the lifted onSubmit', () => {
    const onSubmit = jest.fn();
    const { getByTestId } = render(<PhoneLogin model={makeModel({ onSubmit })} />);
    fireEvent.press(getByTestId('phone-login-submit'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('FORGOT PASSWORD surfaces an honest toast (no reset flow exists)', () => {
    const { getByTestId } = render(<PhoneLogin model={makeModel()} />);
    fireEvent.press(getByTestId('phone-login-forgot'));
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'Password reset lives on the desktop console for now.' }),
    );
  });

  it('register link calls onRegister', () => {
    const onRegister = jest.fn();
    const { getByTestId } = render(<PhoneLogin model={makeModel({ onRegister })} />);
    fireEvent.press(getByTestId('phone-login-register'));
    expect(onRegister).toHaveBeenCalledTimes(1);
  });

  it('renders a surfaced error', () => {
    const { getByTestId, getByText } = render(<PhoneLogin model={makeModel({ error: 'Bad password' })} />);
    expect(getByTestId('phone-login-error')).toBeTruthy();
    expect(getByText('Bad password')).toBeTruthy();
  });
});

describe('LoginScreen fork pin (AC-REG)', () => {
  it('phone renders PhoneLogin, not the desktop card', () => {
    mockTier = 'phone';
    const { getByTestId, queryByTestId } = render(<LoginScreen />);
    expect(getByTestId('phone-login')).toBeTruthy();
    expect(queryByTestId('signin-submit')).toBeNull();
  });

  it('desktop renders the byte-unchanged card, not PhoneLogin', () => {
    mockTier = 'desktop';
    const { getByTestId, queryByTestId } = render(<LoginScreen />);
    expect(getByTestId('signin-submit')).toBeTruthy();
    expect(queryByTestId('phone-login')).toBeNull();
  });

  it('tablet also stays on the desktop card', () => {
    mockTier = 'tablet';
    const { getByTestId, queryByTestId } = render(<LoginScreen />);
    expect(getByTestId('signin-submit')).toBeTruthy();
    expect(queryByTestId('phone-login')).toBeNull();
  });
});
