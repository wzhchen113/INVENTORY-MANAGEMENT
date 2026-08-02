// src/lib/db.mintInstacartCartLink.spec149.test.ts — Spec 149 (AC-25 / AC-28).
//
// Pins the CLIENT SIDE of the `instacart-cart-link` edge-function contract —
// the seam between the two halves of this spec, and the one place a silent
// regression would be invisible to the store-level suite (which mocks db).
//
// The load-bearing detail: `supabase.functions.invoke` throws
// `FunctionsHttpError` on ANY non-2xx, and its `.context` is the raw `Response`
// — NOT a parsed body (@supabase/functions-js). The 409 `retailer_unavailable`
// refusal carries `fallbackChannel`, which the OQ-2 re-route needs, so the body
// MUST be read off the Response. Reading `.body` (a ReadableStream) instead
// would type-check, pass a mocked store test, and quietly break the fallback in
// production — hence this suite.
//
// Also pins AC-15's no-fake-success posture: a 2xx with no usable url is an
// error, never `{ ok: true }`.

const mockInvoke = jest.fn();

jest.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(),
    rpc: jest.fn(),
    channel: jest.fn(),
    removeChannel: jest.fn(),
    functions: { invoke: (...a: any[]) => mockInvoke(...a) },
  },
}));

jest.mock('./auth', () => ({ callEdgeFunction: jest.fn() }));

import { mintInstacartCartLink } from './db';

/** A stand-in for the `Response` supabase-js hangs off `error.context`. */
function httpErrorWith(body: unknown) {
  return {
    message: 'Edge Function returned a non-2xx status code',
    context: {
      // The real Response exposes json() — and NOT the parsed fields.
      json: () => Promise.resolve(body),
      body: { locked: false }, // a ReadableStream stand-in: truthy, but useless
    },
  };
}

beforeEach(() => jest.clearAllMocks());

describe('mintInstacartCartLink — success path', () => {
  it('returns the minted url + expiry', async () => {
    mockInvoke.mockResolvedValue({
      data: { ok: true, url: 'https://instacart.example/c/1', expiresAt: '2026-08-31T00:00:00Z', reused: false },
      error: null,
    });
    await expect(mintInstacartCartLink('ap-1')).resolves.toEqual({
      ok: true, url: 'https://instacart.example/c/1', expiresAt: '2026-08-31T00:00:00Z', reused: false,
    });
    // AC-25 — through the functions client, never a bare fetch.
    expect(mockInvoke).toHaveBeenCalledWith(
      'instacart-cart-link',
      expect.objectContaining({ body: { approvalId: 'ap-1' } }),
    );
  });

  it('carries reused:true through for the OQ-6 re-open path', async () => {
    mockInvoke.mockResolvedValue({
      data: { ok: true, url: 'https://instacart.example/c/1', expiresAt: null, reused: true },
      error: null,
    });
    const res = await mintInstacartCartLink('ap-1');
    expect(res).toMatchObject({ ok: true, reused: true });
  });
});

describe('mintInstacartCartLink — structured refusals (the seam)', () => {
  it('recovers fallbackChannel from the 409 retailer_unavailable Response body (OQ-2)', async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpErrorWith({
        ok: false, error: 'retailer_unavailable', fallbackChannel: 'extension', postalCode: null,
      }),
    });
    await expect(mintInstacartCartLink('ap-1')).resolves.toEqual({
      ok: false, error: 'retailer_unavailable', fallbackChannel: 'extension', postalCode: null,
    });
  });

  it('passes the manual fallback through too', async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpErrorWith({ ok: false, error: 'retailer_unavailable', fallbackChannel: 'manual', postalCode: '21204' }),
    });
    await expect(mintInstacartCartLink('ap-1')).resolves.toEqual({
      ok: false, error: 'retailer_unavailable', fallbackChannel: 'manual', postalCode: '21204',
    });
  });

  it('drops an unrecognized fallbackChannel rather than trusting it', async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpErrorWith({ ok: false, error: 'retailer_unavailable', fallbackChannel: 'mealme' }),
    });
    const res = await mintInstacartCartLink('ap-1');
    expect(res).toMatchObject({ ok: false, error: 'retailer_unavailable' });
    expect((res as any).fallbackChannel).toBeUndefined();
  });

  it('surfaces the other stable error tokens verbatim', async () => {
    for (const token of ['wrong_channel', 'already_ordered', 'approval not found', 'forbidden', 'upstream_error', 'upstream_timeout']) {
      mockInvoke.mockResolvedValue({ data: null, error: httpErrorWith({ ok: false, error: token }) });
      await expect(mintInstacartCartLink('ap-1')).resolves.toMatchObject({ ok: false, error: token });
    }
  });

  it('falls back to the error message when the body is unreadable', async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: { message: 'boom', context: { json: () => Promise.reject(new Error('not json')) } },
    });
    await expect(mintInstacartCartLink('ap-1')).resolves.toEqual({ ok: false, error: 'boom' });
  });

  it('handles a network-level error with no context at all', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });
    await expect(mintInstacartCartLink('ap-1')).resolves.toEqual({ ok: false, error: 'Failed to fetch' });
  });
});

describe('mintInstacartCartLink — AC-15 never a fake success', () => {
  it('a 2xx with no url is an error, not ok:true', async () => {
    mockInvoke.mockResolvedValue({ data: { ok: true, url: '' }, error: null });
    await expect(mintInstacartCartLink('ap-1')).resolves.toMatchObject({ ok: false });
  });

  it('a 2xx with ok:false is an error', async () => {
    mockInvoke.mockResolvedValue({ data: { ok: false, error: 'wrong_channel' }, error: null });
    await expect(mintInstacartCartLink('ap-1')).resolves.toMatchObject({ ok: false, error: 'wrong_channel' });
  });

  it('a null body is an error', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: null });
    await expect(mintInstacartCartLink('ap-1')).resolves.toMatchObject({
      ok: false,
      error: 'upstream_error',
    });
  });
});
