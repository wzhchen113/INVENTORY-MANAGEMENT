// src/lib/sessionRestore.test.ts — cold-start gate behavior.
//
// Spec 062 §B3 / §2 (AC1.5): on app launch with a persisted session,
// re-run the role + user_stores gate. If the gate fails (user demoted
// from 'user' role, or all stores unassigned), the helper MUST return
// a structured result so the caller can surface an error toast — not
// silently redirect to SignIn.
//
// Spec 063 §11.2 — coverage moved here from
// imr-staff/src/navigation/RootStack.test.tsx so the cold-start helper
// is exercised at its colocated test path. The old test rendered the
// navigator and asserted side effects on the staff store; this test
// targets the helper directly and asserts the returned
// `RestoreSessionResult` shape.

// ─── Mock supabase. We control getSession + from() outcomes per test ──
const mockGetSession = jest.fn();
const mockSignOut = jest.fn().mockResolvedValue({ error: null });
const mockFrom = jest.fn();

jest.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      signOut: () => mockSignOut(),
    },
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import { restoreSession } from './sessionRestore';

function makeFromResponse(data: unknown, error: unknown = null) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: () => Promise.resolve({ data, error }),
    // thenable for queries that don't call .maybeSingle()
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      resolve({ data, error }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('restoreSession — cold-start gate (AC1.5)', () => {
  it('signs out and returns not-staff when a stored session belongs to a non-staff user', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'admin-user' } } },
      error: null,
    });
    mockFrom.mockImplementationOnce(() =>
      // profiles.role !== 'user' → 'not-staff' gate failure
      makeFromResponse({ role: 'admin' }),
    );

    const result = await restoreSession();

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: 'not-staff' });
    if (!result.ok) {
      expect(result.message).toMatch(/staff only/i);
    }
    // checkAuthGate fired signOut as part of the gate-denial path.
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('signs out and returns no-stores when a stored session has zero user_stores rows', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'orphan-user' } } },
      error: null,
    });
    mockFrom
      .mockImplementationOnce(() => makeFromResponse({ role: 'user' }))
      .mockImplementationOnce(() => makeFromResponse([]));

    const result = await restoreSession();

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: 'no-stores' });
    if (!result.ok) {
      expect(result.message).toMatch(/No store assignments/i);
    }
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('returns no-session (and does NOT toast/sign-out) when there is no stored session', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const result = await restoreSession();

    expect(result).toEqual({ ok: false, reason: 'no-session' });
    expect(mockSignOut).not.toHaveBeenCalled();
    // No-session is the expected initial state for a fresh device — we
    // should NOT consume the gate path.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns ok=true + the joined stores when the cold-start gate passes', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'staff-1' } } },
      error: null,
    });
    mockFrom
      .mockImplementationOnce(() => makeFromResponse({ role: 'user' }))
      .mockImplementationOnce(() =>
        makeFromResponse([
          { store_id: 's-1', store: { id: 's-1', name: 'Frederick' } },
        ]),
      );

    const result = await restoreSession();

    expect(result).toEqual({
      ok: true,
      userId: 'staff-1',
      stores: [{ storeId: 's-1', storeName: 'Frederick' }],
    });
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
