// src/lib/auth.storeUser.test.ts — Spec 165 §7 (jest, node env).
//
// The two manage-store-user wrappers: createStoreUser + setStoreUserPassword.
// Pins the request body (action + only the allowlisted fields; username
// trimmed + lowercased, password verbatim, storeIds deduped), the envelope /
// error mapping through callEdgeFunction, and that the password never appears
// in a returned string, a console call, or a toast.
//
// Mocking strategy mirrors src/lib/auth.test.ts: stub supabase.auth.getSession
// and reassign global.fetch per test (node env has no real fetch).

jest.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

import Toast from 'react-native-toast-message';
import { supabase } from './supabase';
import { createStoreUser, setStoreUserPassword, STORE_USER_PASSWORD_MIN_LENGTH } from './auth';

const getSessionMock = supabase.auth.getSession as jest.Mock;
const PASSWORD = 'S3cret-Pa55word!';

function respond(status: number, body: unknown) {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
  });
}

function sentBody(): Record<string, unknown> {
  const call = ((global as any).fetch as jest.Mock).mock.calls[0];
  return JSON.parse(call[1].body);
}

let consoleSpies: jest.SpyInstance[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  getSessionMock.mockResolvedValue({ data: { session: { access_token: 'fake-token' } } });
  (global as any).fetch = jest.fn();
  consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
    jest.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  // The password must never reach any console method or a toast.
  for (const spy of consoleSpies) {
    for (const args of spy.mock.calls) {
      expect(JSON.stringify(args)).not.toContain(PASSWORD);
    }
    spy.mockRestore();
  }
  for (const args of (Toast.show as jest.Mock).mock.calls) {
    expect(JSON.stringify(args)).not.toContain(PASSWORD);
  }
});

describe('STORE_USER_PASSWORD_MIN_LENGTH', () => {
  it('mirrors the server floor of 8', () => {
    expect(STORE_USER_PASSWORD_MIN_LENGTH).toBe(8);
  });
});

describe('createStoreUser', () => {
  it('posts action=create with only the allowlisted, normalized fields', async () => {
    respond(201, { id: 'new-id', username: 'marcus.l' });

    const res = await createStoreUser({
      name: '  Marcus Lee ',
      username: '  Marcus.L ',
      password: ` ${PASSWORD} `,
      storeIds: ['s1', 's2', 's1'],
    });

    expect(res).toEqual({ data: { id: 'new-id', username: 'marcus.l' }, error: null });
    const [url, init] = ((global as any).fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toMatch(/\/functions\/v1\/manage-store-user$/);
    expect(init.headers.Authorization).toBe('Bearer fake-token');
    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(['action', 'name', 'password', 'storeIds', 'username']);
    expect(body).toEqual({
      action: 'create',
      name: 'Marcus Lee',
      username: 'marcus.l',
      // Verbatim — no trim on the password.
      password: ` ${PASSWORD} `,
      storeIds: ['s1', 's2'],
    });
  });

  it('surfaces the 409 "username taken" string verbatim (mapped in the drawer)', async () => {
    respond(409, { error: 'username taken' });
    const res = await createStoreUser({ name: 'M', username: 'marcus', password: PASSWORD, storeIds: ['s1'] });
    expect(res).toEqual({ data: null, error: 'username taken' });
  });

  it('surfaces a 403 forbidden string', async () => {
    respond(403, { error: 'forbidden: target is in a different brand' });
    const res = await createStoreUser({ name: 'M', username: 'marcus', password: PASSWORD, storeIds: ['s1'] });
    expect(res.error).toBe('forbidden: target is in a different brand');
    expect(res.data).toBeNull();
  });

  it('surfaces a 400 validation string', async () => {
    respond(400, { error: 'stores must belong to one brand' });
    const res = await createStoreUser({ name: 'M', username: 'marcus', password: PASSWORD, storeIds: ['s1', 's2'] });
    expect(res.error).toBe('stores must belong to one brand');
  });

  it('falls back to HTTP <status> on a non-JSON 5xx', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, text: () => Promise.resolve('<html>boom</html>'),
    });
    const res = await createStoreUser({ name: 'M', username: 'marcus', password: PASSWORD, storeIds: ['s1'] });
    expect(res.error).toBe('HTTP 500');
  });

  it('treats a 2xx body without id/username as an error', async () => {
    respond(201, { ok: true });
    const res = await createStoreUser({ name: 'M', username: 'marcus', password: PASSWORD, storeIds: ['s1'] });
    expect(res.data).toBeNull();
    expect(res.error).toBe('Unexpected response from server');
  });

  it('returns "Not authenticated" and never calls fetch without a session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const res = await createStoreUser({ name: 'M', username: 'marcus', password: PASSWORD, storeIds: ['s1'] });
    expect(res).toEqual({ data: null, error: 'Not authenticated' });
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('returns the network error message on fetch rejection', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
    const res = await createStoreUser({ name: 'M', username: 'marcus', password: PASSWORD, storeIds: ['s1'] });
    expect(res.error).toBe('Failed to fetch');
    expect(res.error).not.toContain(PASSWORD);
  });
});

describe('setStoreUserPassword', () => {
  it('posts action=set_password with userId + password only', async () => {
    respond(200, { success: true });
    const res = await setStoreUserPassword('target-id', PASSWORD);
    expect(res).toEqual({ error: null });
    expect(sentBody()).toEqual({ action: 'set_password', userId: 'target-id', password: PASSWORD });
  });

  it.each([
    [400, 'cannot set password for self'],
    [400, 'account has an email; use password reset'],
    [403, 'forbidden: target is not a store user'],
    [400, 'password must be at least 8 characters'],
  ])('surfaces HTTP %i "%s"', async (status, error) => {
    respond(status, { error });
    const res = await setStoreUserPassword('target-id', PASSWORD);
    expect(res).toEqual({ error });
  });
});
