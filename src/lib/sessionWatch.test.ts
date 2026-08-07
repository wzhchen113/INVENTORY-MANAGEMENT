// src/lib/sessionWatch.test.ts — Spec 152.
//
// Pins the auth-state watcher that turns an involuntary session loss into an
// honest sign-in bounce (AC-1…AC-4, AC-11). Before this spec the app had NO
// onAuthStateChange subscription at all, which is what let the 2026-08-03
// incident render a signed-in-looking shell over empty anon reads.
//
// The watcher is store-agnostic by design (spec 063 slice isolation): surfaces
// REGISTER themselves from App.tsx. These tests therefore register fake
// surfaces — which is also what makes the admin/staff precedence and the
// identity-change rule testable without touching either real store.

// `lib/supabase` throws at import time without EXPO_PUBLIC_* config, so every
// suite that reaches it stubs it — the established pattern (db.*.test.ts,
// useConnectionStatus.test.ts). We keep a handle on the registered callback so
// the subscription plumbing can be driven directly.
// (`mock`-prefixed names are the only out-of-scope variables jest allows a
// module factory to close over.)
const mockAuthCallbacks: Array<(event: string, session: unknown) => void> = [];
const mockUnsubscribe = jest.fn();

jest.mock('./supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: jest.fn((cb: (event: string, session: unknown) => void) => {
        mockAuthCallbacks.push(cb);
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
      }),
    },
  },
}));

import {
  isSessionLossEvent,
  handleAuthEvent,
  markIntentionalSignOut,
  clearIntentionalSignOut,
  registerSessionSurface,
  watchSessionLoss,
  _resetSessionWatch,
  type SessionLossReason,
} from './sessionWatch';

const USER_A = 'user-a';
const USER_B = 'user-b';

const sessionFor = (id: string) => ({ user: { id }, access_token: 'jwt' });

/** A registered surface whose identity + teardown are observable. */
function fakeSurface(id: string, userId: string | null) {
  const state: { userId: string | null } = { userId };
  const tearDown = jest.fn(() => { state.userId = null; });
  const announce = jest.fn<void, [SessionLossReason]>();
  registerSessionSurface({
    id,
    getUserId: () => state.userId,
    tearDown,
    announce,
  });
  return { state, tearDown, announce };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthCallbacks.length = 0;
  _resetSessionWatch();
});

describe('isSessionLossEvent — the loss predicate (Spec 152)', () => {
  // Keyed on the SESSION being null, not on an event-name allow-list: a
  // supabase-js rename must not silently disable the guard.
  test.each([
    ['SIGNED_OUT with no session', 'SIGNED_OUT', null, true],
    ['a refresh that produced no session', 'TOKEN_REFRESHED', null, true],
    ['an unknown future event with no session', 'SESSION_REVOKED', null, true],
    ['undefined session (supabase-js may pass undefined)', 'SIGNED_OUT', undefined, true],
    ['INITIAL_SESSION on a signed-out cold start', 'INITIAL_SESSION', null, false],
    ['a normal sign-in', 'SIGNED_IN', { user: { id: 'u1' } }, false],
    ['a successful refresh', 'TOKEN_REFRESHED', { user: { id: 'u1' } }, false],
  ] as const)('%s', (_label, event, session, expected) => {
    expect(isSessionLossEvent(event, session)).toBe(expected);
  });
});

describe('handleAuthEvent — session gone (AC-1, AC-2)', () => {
  test('tears the signed-in surface down and announces "expired"', () => {
    const admin = fakeSurface('admin', USER_A);

    expect(handleAuthEvent('SIGNED_OUT', null)).toBe('expired');

    expect(admin.tearDown).toHaveBeenCalledTimes(1);
    expect(admin.announce).toHaveBeenCalledWith('expired');
  });

  test('tears down EVERY signed-in surface but announces once, in registration order', () => {
    const admin = fakeSurface('admin', USER_A);
    const staff = fakeSurface('staff', USER_B);

    handleAuthEvent('SIGNED_OUT', null);

    expect(admin.tearDown).toHaveBeenCalledTimes(1);
    expect(staff.tearDown).toHaveBeenCalledTimes(1);
    // Admin registers first — same precedence RoleRouter applies.
    expect(admin.announce).toHaveBeenCalledTimes(1);
    expect(staff.announce).not.toHaveBeenCalled();
  });

  test('a surface with no session is skipped entirely', () => {
    // checkAuthGate's not-staff / no-stores signOut() and RecoveryScreen's
    // post-recovery signOut(): nothing to tear down, nothing to apologise for.
    const admin = fakeSurface('admin', null);
    const staff = fakeSurface('staff', USER_B);

    handleAuthEvent('SIGNED_OUT', null);

    expect(admin.tearDown).not.toHaveBeenCalled();
    expect(staff.tearDown).toHaveBeenCalledTimes(1);
    expect(staff.announce).toHaveBeenCalledWith('expired');
  });

  test('no registered surface holds a session — total no-op', () => {
    const admin = fakeSurface('admin', null);
    expect(handleAuthEvent('SIGNED_OUT', null)).toBeNull();
    expect(admin.tearDown).not.toHaveBeenCalled();
    expect(admin.announce).not.toHaveBeenCalled();
  });
});

// ── security-auditor M1 ──────────────────────────────────────────────────
// auth-js replays other tabs' auth events into this tab over a
// BroadcastChannel, so signing in as user B in tab 2 hands tab 1 a SIGNED_IN
// carrying a NON-NULL session for a different subject. Keying only on
// `session == null` would leave tab 1 rendering A's shell while every request
// went out with B's JWT.
describe('handleAuthEvent — identity CHANGE (AC-11)', () => {
  test('a non-null session for a DIFFERENT user is a loss for the old identity', () => {
    const admin = fakeSurface('admin', USER_A);

    expect(handleAuthEvent('SIGNED_IN', sessionFor(USER_B))).toBe('switched');

    expect(admin.tearDown).toHaveBeenCalledTimes(1);
    // Distinct copy: "expired" would be a lie — the session did not die.
    expect(admin.announce).toHaveBeenCalledWith('switched');
  });

  test('the SAME user re-appearing (refresh, re-emit) is NOT a loss', () => {
    const admin = fakeSurface('admin', USER_A);

    expect(handleAuthEvent('TOKEN_REFRESHED', sessionFor(USER_A))).toBeNull();

    expect(admin.tearDown).not.toHaveBeenCalled();
    expect(admin.announce).not.toHaveBeenCalled();
  });

  test('an identity change is NEVER suppressed by the intentional-sign-out flag', () => {
    const admin = fakeSurface('admin', USER_A);
    markIntentionalSignOut();

    expect(handleAuthEvent('SIGNED_IN', sessionFor(USER_B))).toBe('switched');
    expect(admin.tearDown).toHaveBeenCalledTimes(1);
  });

  test('only the surfaces whose identity actually moved are torn down', () => {
    const admin = fakeSurface('admin', USER_A);
    const staff = fakeSurface('staff', USER_B);

    // B signs in elsewhere: admin (A) is stale, staff (B) is still correct.
    handleAuthEvent('SIGNED_IN', sessionFor(USER_B));

    expect(admin.tearDown).toHaveBeenCalledTimes(1);
    expect(staff.tearDown).not.toHaveBeenCalled();
  });
});

describe('handleAuthEvent — the silence rules (AC-3, AC-4)', () => {
  test('INITIAL_SESSION with a null session does nothing', () => {
    const admin = fakeSurface('admin', USER_A);
    expect(handleAuthEvent('INITIAL_SESSION', null)).toBeNull();
    expect(admin.tearDown).not.toHaveBeenCalled();
    expect(admin.announce).not.toHaveBeenCalled();
  });

  test('an intentional sign-out is not reported as "expired"', () => {
    const admin = fakeSurface('admin', USER_A);
    markIntentionalSignOut();

    expect(handleAuthEvent('SIGNED_OUT', null)).toBeNull();

    expect(admin.announce).not.toHaveBeenCalled();
    // The deliberate path owns its own teardown (logout()); the watcher does
    // not double-clear.
    expect(admin.tearDown).not.toHaveBeenCalled();
  });

  test('the flag is consumed once — a LATER real loss still announces', () => {
    const admin = fakeSurface('admin', USER_A);
    markIntentionalSignOut();
    handleAuthEvent('SIGNED_OUT', null);
    expect(admin.announce).not.toHaveBeenCalled();

    handleAuthEvent('SIGNED_OUT', null);
    expect(admin.announce).toHaveBeenCalledWith('expired');
  });

  test('the flag is consumed even when no surface was signed in', () => {
    // Otherwise a sign-out from the login screen would leave it armed and eat
    // the next session's genuine loss.
    fakeSurface('signed-out-surface', null);
    markIntentionalSignOut();
    handleAuthEvent('SIGNED_OUT', null);

    const later = fakeSurface('admin', USER_A);
    handleAuthEvent('SIGNED_OUT', null);
    expect(later.announce).toHaveBeenCalledWith('expired');
  });

  test('clearIntentionalSignOut un-arms a marker whose signOut() never emitted', () => {
    // auth-js skips SIGNED_OUT when signOut() fails on a network error; both
    // call sites disarm in that branch so the next genuine loss is not eaten.
    const admin = fakeSurface('admin', USER_A);
    markIntentionalSignOut();
    clearIntentionalSignOut();

    handleAuthEvent('SIGNED_OUT', null);

    expect(admin.tearDown).toHaveBeenCalledTimes(1);
    expect(admin.announce).toHaveBeenCalledWith('expired');
  });
});

describe('registerSessionSurface', () => {
  test('unregistering stops the surface from being torn down', () => {
    const state: { userId: string | null } = { userId: USER_A };
    const tearDown = jest.fn();
    const unregister = registerSessionSurface({
      id: 'admin',
      getUserId: () => state.userId,
      tearDown,
      announce: jest.fn(),
    });

    unregister();
    handleAuthEvent('SIGNED_OUT', null);

    expect(tearDown).not.toHaveBeenCalled();
  });
});

describe('watchSessionLoss — subscription plumbing', () => {
  test('routes events into the handler and unsubscribes on teardown', () => {
    const admin = fakeSurface('admin', USER_A);
    const stop = watchSessionLoss();
    expect(mockAuthCallbacks).toHaveLength(1);

    mockAuthCallbacks[0]('INITIAL_SESSION', null);
    expect(admin.tearDown).not.toHaveBeenCalled();

    mockAuthCallbacks[0]('SIGNED_OUT', null);
    expect(admin.tearDown).toHaveBeenCalledTimes(1);
    expect(admin.announce).toHaveBeenCalledWith('expired');

    stop();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test('a live session event for the same user is a no-op', () => {
    const admin = fakeSurface('admin', USER_A);
    watchSessionLoss();
    mockAuthCallbacks[0]('TOKEN_REFRESHED', sessionFor(USER_A));
    expect(admin.tearDown).not.toHaveBeenCalled();
    expect(admin.announce).not.toHaveBeenCalled();
  });
});
