// src/lib/recoveryRedirect.test.ts — Spec 085 Track 1 (jest, unit project).
//
// Covers:
//   1. resolveRecoveryRedirectUrl() per-platform branch (criteria test #3):
//      - web + env var set → returns the env var verbatim
//      - web + no env var → window.location.origin + '/reset-password'
//      - native → Linking.createURL('/reset-password')
//   2. sendPasswordReset calls resetPasswordForEmail(email, { redirectTo })
//      with a NON-EMPTY redirectTo matching the running platform, and preserves
//      its { error } return contract.

import { Platform } from 'react-native';

// expo-linking: stub createURL so the native branch is deterministic and no
// native module is loaded in the node test env.
jest.mock('expo-linking', () => ({
  __esModule: true,
  createURL: jest.fn((path: string) => `imrinventory:/${path}`),
}));

// supabase: stub only the auth methods these helpers touch.
jest.mock('./supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      resetPasswordForEmail: jest.fn(),
      verifyOtp: jest.fn(),
      exchangeCodeForSession: jest.fn(),
      getSession: jest.fn(),
    },
  },
}));

import * as Linking from 'expo-linking';
import { supabase } from './supabase';
import { resolveRecoveryRedirectUrl, establishRecoverySession } from './recoveryRedirect';
import { sendPasswordReset } from './auth';

const resetMock = supabase.auth.resetPasswordForEmail as jest.Mock;
const verifyOtpMock = supabase.auth.verifyOtp as jest.Mock;
const exchangeMock = supabase.auth.exchangeCodeForSession as jest.Mock;
const getSessionMock = supabase.auth.getSession as jest.Mock;
const createURLMock = Linking.createURL as jest.Mock;

const ORIGINAL_OS = Platform.OS;

function setPlatform(os: 'web' | 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

describe('resolveRecoveryRedirectUrl', () => {
  const ORIGINAL_ENV = process.env.EXPO_PUBLIC_WEB_RECOVERY_URL;
  const ORIGINAL_WINDOW = (global as { window?: unknown }).window;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EXPO_PUBLIC_WEB_RECOVERY_URL;
  });

  afterEach(() => {
    setPlatform(ORIGINAL_OS as 'web' | 'ios' | 'android');
    if (ORIGINAL_ENV === undefined) {
      delete process.env.EXPO_PUBLIC_WEB_RECOVERY_URL;
    } else {
      process.env.EXPO_PUBLIC_WEB_RECOVERY_URL = ORIGINAL_ENV;
    }
    if (ORIGINAL_WINDOW === undefined) {
      delete (global as { window?: unknown }).window;
    } else {
      (global as { window?: unknown }).window = ORIGINAL_WINDOW;
    }
  });

  it('returns the EXPO_PUBLIC_WEB_RECOVERY_URL env value on web when set', () => {
    setPlatform('web');
    process.env.EXPO_PUBLIC_WEB_RECOVERY_URL = 'https://app.example.com/reset-password';
    expect(resolveRecoveryRedirectUrl()).toBe('https://app.example.com/reset-password');
  });

  it('falls back to window.location.origin + /reset-password on web dev', () => {
    setPlatform('web');
    (global as { window?: unknown }).window = { location: { origin: 'http://localhost:8081' } };
    expect(resolveRecoveryRedirectUrl()).toBe('http://localhost:8081/reset-password');
  });

  it('uses Linking.createURL on native', () => {
    setPlatform('ios');
    const url = resolveRecoveryRedirectUrl();
    expect(createURLMock).toHaveBeenCalledWith('/reset-password');
    // Whatever createURL returns is the native redirect — assert it is the
    // mocked scheme URL and non-empty (the per-platform branch is what matters).
    expect(url).toBe('imrinventory://reset-password');
    expect(url.length).toBeGreaterThan(0);
  });
});

describe('sendPasswordReset', () => {
  const ORIGINAL_WINDOW = (global as { window?: unknown }).window;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EXPO_PUBLIC_WEB_RECOVERY_URL;
    setPlatform('web');
    (global as { window?: unknown }).window = { location: { origin: 'http://localhost:8081' } };
  });

  afterEach(() => {
    setPlatform(ORIGINAL_OS as 'web' | 'ios' | 'android');
    if (ORIGINAL_WINDOW === undefined) {
      delete (global as { window?: unknown }).window;
    } else {
      (global as { window?: unknown }).window = ORIGINAL_WINDOW;
    }
  });

  it('passes a non-empty redirectTo matching the running platform and returns { error: null } on success', async () => {
    resetMock.mockResolvedValue({ error: null });

    const result = await sendPasswordReset('user@example.com');

    expect(result).toEqual({ error: null });
    expect(resetMock).toHaveBeenCalledTimes(1);
    const [emailArg, optionsArg] = resetMock.mock.calls[0];
    expect(emailArg).toBe('user@example.com');
    expect(optionsArg.redirectTo).toBe('http://localhost:8081/reset-password');
    expect(optionsArg.redirectTo.length).toBeGreaterThan(0);
  });

  it('surfaces the Supabase error message and preserves the { error } contract', async () => {
    resetMock.mockResolvedValue({ error: { message: 'rate limit exceeded' } });

    const result = await sendPasswordReset('user@example.com');

    expect(result).toEqual({ error: 'rate limit exceeded' });
  });

  it('catches a thrown error and returns a fallback message', async () => {
    resetMock.mockRejectedValue(new Error('network down'));

    const result = await sendPasswordReset('user@example.com');

    expect(result).toEqual({ error: 'network down' });
  });
});

describe('establishRecoverySession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redeems the CHOSEN token_hash flow via verifyOtp({ token_hash, type: recovery })', async () => {
    verifyOtpMock.mockResolvedValue({ data: { session: {} }, error: null });

    const result = await establishRecoverySession({
      kind: 'recovery-token-hash',
      tokenHash: 'hash-xyz',
    });

    expect(result).toEqual({ ok: true });
    expect(verifyOtpMock).toHaveBeenCalledWith({ token_hash: 'hash-xyz', type: 'recovery' });
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('surfaces a verifyOtp failure as { ok: false }', async () => {
    verifyOtpMock.mockResolvedValue({ data: { session: null }, error: { message: 'Token has expired or is invalid' } });

    const result = await establishRecoverySession({
      kind: 'recovery-token-hash',
      tokenHash: 'stale-hash',
    });

    expect(result).toEqual({ ok: false, error: 'Token has expired or is invalid' });
  });

  it('falls back to exchangeCodeForSession for a defensive ?code= recovery', async () => {
    exchangeMock.mockResolvedValue({ error: null });

    const result = await establishRecoverySession({ kind: 'recovery', code: 'abc123' });

    expect(result).toEqual({ ok: true });
    expect(exchangeMock).toHaveBeenCalledWith('abc123');
    expect(verifyOtpMock).not.toHaveBeenCalled();
  });

  it('verifies the implicit hash-flow session via getSession when present', async () => {
    getSessionMock.mockResolvedValue({ data: { session: {} } });

    const result = await establishRecoverySession({
      kind: 'recovery-implicit',
      accessToken: 'access-xyz',
    });

    expect(result).toEqual({ ok: true });
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(verifyOtpMock).not.toHaveBeenCalled();
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('returns { ok: false, error: recovery session missing } when the implicit session is absent', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });

    const result = await establishRecoverySession({
      kind: 'recovery-implicit',
      accessToken: 'access-xyz',
    });

    expect(result).toEqual({ ok: false, error: 'recovery session missing' });
  });

  it('returns { ok: false } for an error parse without calling any exchange', async () => {
    const result = await establishRecoverySession({
      kind: 'error',
      code: 'otp_expired',
      description: 'expired',
    });

    expect(result.ok).toBe(false);
    expect(verifyOtpMock).not.toHaveBeenCalled();
    expect(exchangeMock).not.toHaveBeenCalled();
  });
});
