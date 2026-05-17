// src/lib/translate.test.ts — Spec 040 P3 graceful-degrade coverage.
//
// Exercises the `translateOnSave` wrapper around `callEdgeFunction`. The
// load-bearing assertion: when the edge function returns an error (DeepL
// quota, missing DEEPL_API_KEY, network failure, etc.), the call must
// resolve with `{ data: null, error: <string> }` — NOT throw — so the
// form's `if (error || !data) return;` early-exit keeps the user typing
// into the manual-override fields. The save path itself never awaits this
// helper's success, so the form stays submittable regardless.
//
// Mocking shape mirrors `src/lib/auth.test.ts` (spec 032 reference shape):
//   - `jest.mock('./supabase')` stubs `getSession`.
//   - `global.fetch` reassigned per-test for the network boundary.
//   - `beforeEach(jest.clearAllMocks)` isolates state.

jest.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
  },
}));

import { supabase } from './supabase';
import { translateOnSave } from './translate';

const getSessionMock = supabase.auth.getSession as jest.Mock;

describe('translateOnSave — graceful degrade (Spec 040 P3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'fake-token' } },
    });
    (global as any).fetch = jest.fn();
  });

  it('resolves with { data: { translations }, error: null } on 200', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            translations: { es: 'Cebolla Amarilla', 'zh-CN': '黄洋葱' },
          }),
        ),
    });

    const result = await translateOnSave('Yellow Onion', ['es', 'zh-CN']);

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      translations: { es: 'Cebolla Amarilla', 'zh-CN': '黄洋葱' },
    });
  });

  it('resolves with { data: null, error: "translation_unavailable" } when DEEPL_API_KEY is absent (503)', async () => {
    // The edge function returns this when Deno.env.get('DEEPL_API_KEY')
    // is undefined; both that case and the all-locales-failed case
    // collapse to the same 503 + "translation_unavailable" envelope per
    // spec 040 §4.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () =>
        Promise.resolve(JSON.stringify({ error: 'translation_unavailable' })),
    });

    const result = await translateOnSave('Test Soap', ['es', 'zh-CN']);

    expect(result.data).toBeNull();
    expect(result.error).toBe('translation_unavailable');
  });

  it('resolves with { data: null, error: "translation_unavailable" } when all DeepL upstream calls fail (503)', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () =>
        Promise.resolve(JSON.stringify({ error: 'translation_unavailable' })),
    });

    const result = await translateOnSave('Anything', ['es', 'zh-CN']);

    expect(result.data).toBeNull();
    expect(result.error).toBe('translation_unavailable');
  });

  it('never throws on fetch rejection — surfaces the network error string', async () => {
    // Form code does `try/catch` around translateOnSave anyway, but the
    // contract is that this helper RESOLVES on every failure mode. A
    // thrown error would skip the form's `if (error || !data) return;`
    // graceful-degrade branch and could surface as an unhandled rejection.
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await translateOnSave('Anything', ['es', 'zh-CN']);

    expect(result.data).toBeNull();
    expect(result.error).toBe('connect ECONNREFUSED');
  });

  it('resolves with { error: "Not authenticated" } when no session is present (does not call fetch)', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;

    const result = await translateOnSave('Anything', ['es', 'zh-CN']);

    expect(result).toEqual({ data: null, error: 'Not authenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('threads `signal` into the underlying fetch options (cancellation path)', async () => {
    // Should-fix #3 — the AbortSignal must reach fetch so a rapid retype
    // actually cancels the in-flight DeepL call rather than just discarding
    // the stale result.
    const ctrl = new AbortController();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ translations: { es: 'x' } })),
    });
    (global as any).fetch = fetchMock;

    await translateOnSave('Anything', ['es'], ctrl.signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, callOpts] = fetchMock.mock.calls[0];
    expect(callOpts.signal).toBe(ctrl.signal);
  });

  it('sends the spec-contract request body { text, sourceLocale: "en", targetLocales }', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ translations: { es: 'x' } })),
    });
    (global as any).fetch = fetchMock;

    await translateOnSave('Test Soap', ['es', 'zh-CN']);

    const [callUrl, callOpts] = fetchMock.mock.calls[0];
    expect(callUrl).toMatch(/\/functions\/v1\/translate-on-save$/);
    expect(JSON.parse(callOpts.body)).toEqual({
      text: 'Test Soap',
      sourceLocale: 'en',
      targetLocales: ['es', 'zh-CN'],
    });
  });
});
