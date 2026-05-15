// src/lib/auth.test.ts — Spec 032 Track 1 jest coverage.
//
// Exercises the rewritten `callEdgeFunction` helper inside `src/lib/auth.ts`.
// The helper is module-private (not exported), so we exercise it indirectly
// through `deleteUser`, which is a thin destructure-and-return wrapper after
// the spec 032 refactor. `deleteUser` returns the same `{ error }` envelope
// it consumes from the helper, with `data` discarded — so to assert on
// `data` paths we ALSO import a fresh module instance with a custom Supabase
// mock that lets us inspect the helper's full envelope via a temporary
// caller. The simplest path: use `deleteUser` for `error`-side assertions
// (the load-bearing surface) and a `__test__` accessor is NOT added (per
// spec 032 §3 — minimal surface change). The 2xx `data` shape is therefore
// asserted indirectly: when the helper resolves with `error: null` on a
// 2xx response, `deleteUser` returns `{ error: null }`. The `data` shape
// itself doesn't reach `deleteUser`, but the test still proves the helper
// classified the response as 2xx correctly.
//
// Mocking strategy (spec 032 §4):
//   - `jest.mock('./supabase', ...)` stubs `supabase.auth.getSession` —
//     the helper's only call into the supabase client.
//   - `global.fetch = jest.fn().mockImplementation(...)` replaces the
//     network boundary. Per spec 032 §4, this is per-test reassignment
//     rather than `jest.spyOn(global, 'fetch')` because the `node` jest
//     env doesn't ship a real `fetch` to spy on.
//   - `beforeEach(jest.clearAllMocks)` isolates state between tests.
//   - No `tests/jest.setup.ts` change — per spec 032 §4 the fetch mock
//     stays local to this file.
//
// 11 test cases per spec 032 §"Jest test coverage":
//   (1)  HTTP 200 + JSON body
//   (2)  HTTP 200 + empty body
//   (3)  HTTP 200 + non-JSON body (graceful)
//   (4)  HTTP 400 + { error: "cannot delete the last super_admin" }
//   (5)  HTTP 400 + { error: "cannot delete self" }
//   (6)  HTTP 500 + { message: "internal error" } (fallback to message)
//   (7)  HTTP 500 + non-JSON body → "HTTP 500"
//   (8)  HTTP 401 + { error: "Unauthorized" }
//   (9)  fetch rejection (network failure)
//   (10) Missing session → fetch never called
//   (11) Session present → fetch called with correct URL + bearer

// Stub the supabase client at module boundary so the helper resolves to a
// controllable `getSession()` return. We pull the mocked symbol back via
// `import` below the `jest.mock` call — same pattern as
// `src/utils/seedVarianceDates.test.ts`.
jest.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}));

import { supabase } from './supabase';
import { deleteUser } from './auth';

// Tighten the `supabase.auth.getSession` reference to the jest.Mock type
// without spreading `(supabase.auth.getSession as jest.Mock)` everywhere.
const getSessionMock = supabase.auth.getSession as jest.Mock;

describe('callEdgeFunction (via deleteUser)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default session — every test overrides as needed.
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'fake-token' } },
    });
    // Default fetch — every test overrides as needed.
    (global as any).fetch = jest.fn();
  });

  it('returns { error: null } on HTTP 200 with valid JSON body', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: null });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns { error: null } on HTTP 200 with empty body', async () => {
    // Webhook-style 204 / empty 200 — body is "" so JSON.parse is skipped.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: null });
  });

  it('returns { error: null } on HTTP 200 with non-JSON body (graceful)', async () => {
    // `text/plain "ok"` — JSON.parse throws, caught, `data` stays null,
    // 2xx → error is null.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
    });

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: null });
  });

  it('surfaces the verbatim refusal string on HTTP 400 + { error: "cannot delete the last super_admin" }', async () => {
    // Spec 031 regression case — the load-bearing test. The verbatim
    // string from the edge function MUST reach the caller.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({ error: 'cannot delete the last super_admin' }),
        ),
    });

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: 'cannot delete the last super_admin' });
  });

  it('surfaces the verbatim refusal string on HTTP 400 + { error: "cannot delete self" }', async () => {
    // Spec 027 / 029 / 030 surface — self-delete refusal.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ error: 'cannot delete self' })),
    });

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: 'cannot delete self' });
  });

  it('falls back to `message` field on HTTP 500 + { message: "internal error" }', async () => {
    // Tier 2 — no `error` field, but `message` present. Helper picks
    // `message` so the gateway-style shape still surfaces a useful string.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () =>
        Promise.resolve(JSON.stringify({ message: 'internal error' })),
    });

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: 'internal error' });
  });

  it('synthesizes "HTTP <status>" on HTTP 500 + non-JSON body', async () => {
    // Tier 3 — last-resort string. Operator still sees the status code
    // in the toast rather than a fake-success.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('upstream nginx 502 error page'),
    });

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: 'HTTP 500' });
  });

  it('surfaces { error: "Unauthorized" } on HTTP 401', async () => {
    // Defense-in-depth for the gateway path — no edge function currently
    // emits this shape, but the JWT-verify path could.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify({ error: 'Unauthorized' })),
    });

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: 'Unauthorized' });
  });

  it('returns the rejection message on fetch failure (network error)', async () => {
    // DNS failure / connection refused / timeout. fetch rejects; helper
    // catches and surfaces the message.
    (global as any).fetch = jest
      .fn()
      .mockRejectedValue(new Error('Failed to fetch'));

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: 'Failed to fetch' });
  });

  it('returns { error: "Not authenticated" } when session is null and never calls fetch', async () => {
    // Operator signed out mid-action — previously silent-success, now
    // surfaces to the toast.
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;

    const result = await deleteUser('user-id-abc');

    expect(result).toEqual({ error: 'Not authenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls fetch with the correct edge-function URL and bearer header when session present', async () => {
    // Pins the URL routing (fnName interpolates into the path correctly)
    // AND the Authorization header carries the session bearer. A future
    // refactor that breaks either of these would defeat the entire spec.
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });
    (global as any).fetch = fetchMock;

    await deleteUser('user-id-abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [callUrl, callOpts] = fetchMock.mock.calls[0];
    // URL must contain the fnName path segment under /functions/v1/.
    expect(callUrl).toMatch(/\/functions\/v1\/delete-user$/);
    // Bearer header must carry the session token.
    expect(callOpts.headers.Authorization).toBe('Bearer fake-token');
    // Method + content type defense-in-depth.
    expect(callOpts.method).toBe('POST');
    expect(callOpts.headers['Content-Type']).toBe('application/json');
    // Body carries the userId.
    expect(JSON.parse(callOpts.body)).toEqual({ userId: 'user-id-abc' });
  });
});
