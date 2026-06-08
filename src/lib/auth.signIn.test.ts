// src/lib/auth.signIn.test.ts — Spec 095 Track 1 jest coverage.
//
// Exercises the rewritten `signIn` in src/lib/auth.ts:
//   - `@`-branch routing: an identifier with `@` is treated as an email and
//     flows straight to signInWithPassword (no resolver call); an identifier
//     WITHOUT `@` is resolved via the username-resolve edge function first.
//   - generic-error collapse: unknown username, unknown email, and wrong
//     password ALL surface the single GENERIC_LOGIN_ERROR string (no
//     enumeration oracle).
//   - resolveUsernameToEmail: raw service-token fetch, 200 contract, and
//     fail-closed behaviour on any error.
//
// Mocking strategy mirrors src/lib/auth.test.ts:
//   - jest.mock('./supabase') stubs auth.signInWithPassword + the profiles
//     read chain used by fetchProfile.
//   - global.fetch is replaced per-test for the resolver call.
//   - The db.ts imports auth.ts pulls in (fetchStoreIdsForBrand, etc.) and
//     recoveryRedirect are mocked so the module loads in the node env.

jest.mock('./supabase', () => {
  const single = jest.fn();
  // Explicit return-type annotation: `eq` references itself in its own
  // initializer (the chain is `.eq(...).eq(...)` AND `.eq(...).single()`), so
  // TS cannot infer the type under strict mode (TS7022/TS7024). Annotating the
  // return breaks the self-reference for the inferencer.
  const eq: jest.Mock = jest.fn((): { single: jest.Mock; eq: jest.Mock } => ({ single, eq }));
  const select = jest.fn(() => ({ eq }));
  const from = jest.fn(() => ({ select }));
  return {
    supabase: {
      auth: {
        signInWithPassword: jest.fn(),
      },
      from,
      __mocks: { single, eq, select, from },
    },
  };
});

jest.mock('./db', () => ({
  fetchStoreIdsForBrand: jest.fn(),
  fetchInvitationsForUserLookup: jest.fn(),
}));

jest.mock('./recoveryRedirect', () => ({
  resolveRecoveryRedirectUrl: jest.fn(() => 'http://localhost/reset'),
}));

import { supabase } from './supabase';
import { signIn, resolveUsernameToEmail, GENERIC_LOGIN_ERROR } from './auth';

const signInMock = supabase.auth.signInWithPassword as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN = 'svc-token';
  (global as any).fetch = jest.fn();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('signIn — @-branch routing', () => {
  it('treats an identifier WITH @ as an email and does NOT call the resolver', async () => {
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    // GoTrue rejects so we stop before fetchProfile — we only assert routing.
    signInMock.mockResolvedValue({ data: { user: null }, error: { message: 'x' } });

    await signIn('bob@example.com', 'pw');

    // No resolver round-trip on the email path.
    expect(fetchMock).not.toHaveBeenCalled();
    // signInWithPassword received the email verbatim.
    expect(signInMock).toHaveBeenCalledWith({ email: 'bob@example.com', password: 'pw' });
  });

  it('treats an identifier WITHOUT @ as a username and resolves it first', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ email: 'bob@example.com' })),
    });
    (global as any).fetch = fetchMock;
    signInMock.mockResolvedValue({ data: { user: null }, error: { message: 'x' } });

    await signIn('bobby_b', 'pw');

    // Resolver was called against username-resolve with the service token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/functions\/v1\/username-resolve$/);
    expect(opts.headers.Authorization).toBe('Bearer svc-token');
    expect(JSON.parse(opts.body)).toEqual({ username: 'bobby_b' });
    // Then signInWithPassword used the RESOLVED email.
    expect(signInMock).toHaveBeenCalledWith({ email: 'bob@example.com', password: 'pw' });
  });

  it('trims the identifier before branching', async () => {
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    signInMock.mockResolvedValue({ data: { user: null }, error: { message: 'x' } });

    await signIn('  bob@example.com  ', 'pw');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(signInMock).toHaveBeenCalledWith({ email: 'bob@example.com', password: 'pw' });
  });
});

describe('signIn — generic-error collapse (no enumeration oracle)', () => {
  it('unknown username (resolver returns null) → GENERIC_LOGIN_ERROR, no sign-in attempt', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ email: null })),
    });

    const result = await signIn('nosuchuser', 'pw');

    expect(result).toEqual({ user: null, error: GENERIC_LOGIN_ERROR });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('EXISTING username + wrong password → SAME GENERIC_LOGIN_ERROR as unknown username', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ email: 'bob@example.com' })),
    });
    signInMock.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid login credentials' },
    });

    const result = await signIn('bobby_b', 'wrongpw');

    // Indistinguishable from the unknown-username case above.
    expect(result).toEqual({ user: null, error: GENERIC_LOGIN_ERROR });
  });

  it('unknown email (GoTrue error) → GENERIC_LOGIN_ERROR (collapses the verbatim message)', async () => {
    signInMock.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid login credentials' },
    });

    const result = await signIn('ghost@example.com', 'pw');

    expect(result).toEqual({ user: null, error: GENERIC_LOGIN_ERROR });
  });

  it('GoTrue returns no error but no user → GENERIC_LOGIN_ERROR', async () => {
    signInMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await signIn('bob@example.com', 'pw');

    expect(result).toEqual({ user: null, error: GENERIC_LOGIN_ERROR });
  });
});

describe('resolveUsernameToEmail — fail-closed behaviour', () => {
  it('returns the email on a 200 { email: "..." } response', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ email: 'bob@example.com' })),
    });

    await expect(resolveUsernameToEmail('bobby_b')).resolves.toBe('bob@example.com');
  });

  it('returns null on a 200 { email: null } response', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ email: null })),
    });

    await expect(resolveUsernameToEmail('nope')).resolves.toBeNull();
  });

  it('returns null on a non-2xx response (does not throw)', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify({ error: 'invalid service token' })),
    });

    await expect(resolveUsernameToEmail('bobby_b')).resolves.toBeNull();
  });

  it('returns null on a network rejection (fail-closed)', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('Failed to fetch'));

    await expect(resolveUsernameToEmail('bobby_b')).resolves.toBeNull();
  });

  it('returns null when the service token env var is unset', async () => {
    delete process.env.EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN;
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;

    await expect(resolveUsernameToEmail('bobby_b')).resolves.toBeNull();
    // Fails closed BEFORE any network call.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
