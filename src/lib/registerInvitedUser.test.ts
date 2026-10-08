// src/lib/registerInvitedUser.test.ts — Spec 164 (jest).
//
// Pins the spec 164 registration contract: after signUp, registerInvitedUser
// finishes registration with exactly ONE call to the SECURITY DEFINER RPC
// register_invited_profile(), which derives role / brand / username / stores
// server-side from the pending invitation. The client must NOT:
//   - insert into `profiles` or `user_stores`
//   - call consume_invitation
//   - send a `role` in signUp options.data
//
// Spec 069 brand-stamp cases that used to live here were deleted: brand
// derivation is now server-side, and the spec 069 rule (staff brand resolved
// from store_ids[1] when the invitation brand is NULL; explicit brand wins) is
// pinned by pgTAP supabase/tests/profiles_insert_hardening.test.sql arms
// C-2 and C-6.
//
// Boundary mocked: `./supabase`. registerInvitedUser touches
//   - supabase.rpc('get_pending_invitation', …)  → the invitation envelope
//   - supabase.auth.signUp(…)                     → the new auth user (captured)
//   - supabase.rpc('register_invited_profile')    → per-test { data, error }
//   - supabase.auth.getSession()                  → via callEdgeFunction for the
//                                                    fire-and-forget welcome
//                                                    email (returns no session,
//                                                    so no network call)
//   - supabase.from(…)                            → spy only; must NOT be hit
//                                                    for profiles / user_stores
//
// Welcome-email detection: callEdgeFunction lives in the same module, so it
// cannot be spied through the import. Its first statement is
// supabase.auth.getSession(), so "getSession was called" is the observable
// proxy for "the welcome email was attempted".

const BRAND_A = '2a000000-0000-0000-0000-000000000001';

// Per-test fixtures. Prefixed `mock` so the hoisted jest.mock() factory below
// may reference them (jest's out-of-scope-variable guard allows `mock*`).
let mockInvitationRow: any = null;
let mockRegisterResult: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: null,
};
let mockSignUpResult: { data: { user: { id: string } | null }; error: { message: string } | null } = {
  data: { user: { id: 'new-user-id-164' } },
  error: null,
};

jest.mock('./supabase', () => ({
  supabase: {
    rpc: jest.fn((fn: string) => {
      if (fn === 'get_pending_invitation') {
        return Promise.resolve({
          data: mockInvitationRow ? [mockInvitationRow] : [],
          error: null,
        });
      }
      if (fn === 'register_invited_profile') {
        return Promise.resolve(mockRegisterResult);
      }
      // Anything else (e.g. a regressed consume_invitation call) → benign
      // success; the assertions below catch it by name.
      return Promise.resolve({ data: null, error: null });
    }),
    auth: {
      signUp: jest.fn(() => Promise.resolve(mockSignUpResult)),
      getSession: jest.fn(() => Promise.resolve({ data: { session: null } })),
    },
    from: jest.fn(() => ({
      insert: jest.fn(() => Promise.resolve({ error: null })),
      delete: jest.fn(() => ({ lt: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ error: null })) })) })),
    })),
  },
}));

import { registerInvitedUser } from './auth';
import { supabase } from './supabase';

const rpcMock = supabase.rpc as unknown as jest.Mock;
const signUpMock = supabase.auth.signUp as unknown as jest.Mock;
const getSessionMock = supabase.auth.getSession as unknown as jest.Mock;
const fromMock = supabase.from as unknown as jest.Mock;

function rpcCallsNamed(name: string): unknown[][] {
  return rpcMock.mock.calls.filter((c: unknown[]) => c[0] === name);
}

function fromTables(): unknown[] {
  return fromMock.mock.calls.map((c: unknown[]) => c[0]);
}

const STAFF_INVITE = {
  id: 'inv-staff-164',
  email: 'staff164@test.local',
  name: 'Staff Member',
  role: 'user',
  store_ids: ['00000000-0000-0000-0000-000000000001'],
  brand_id: null,
  resolved_brand_id: BRAND_A,
  username: 'staff164',
  expires_at: null,
};

describe('registerInvitedUser (spec 164 — server-side registration RPC)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvitationRow = null;
    mockRegisterResult = { data: 'new-user-id-164', error: null };
    mockSignUpResult = { data: { user: { id: 'new-user-id-164' } }, error: null };
  });

  it('success: signUp without role, then exactly one register_invited_profile call and no direct writes', async () => {
    mockInvitationRow = STAFF_INVITE;

    const result = await registerInvitedUser('staff164@test.local', 'password', 'Staff Member');

    expect(result.error).toBeNull();

    // signUp called once; options.data is exactly { name } — no role key.
    expect(signUpMock).toHaveBeenCalledTimes(1);
    const signUpArg = signUpMock.mock.calls[0][0];
    expect(signUpArg.options.data).toEqual({ name: 'Staff Member' });
    expect(signUpArg.options.data).not.toHaveProperty('role');

    // Exactly one RPC call, with no args object.
    const regCalls = rpcCallsNamed('register_invited_profile');
    expect(regCalls).toHaveLength(1);
    expect(regCalls[0][1]).toBeUndefined();

    // The RPC runs after signUp.
    const signUpOrder = signUpMock.mock.invocationCallOrder[0];
    const regIndex = rpcMock.mock.calls.findIndex((c: unknown[]) => c[0] === 'register_invited_profile');
    expect(rpcMock.mock.invocationCallOrder[regIndex]).toBeGreaterThan(signUpOrder);

    // No direct table writes, no consume_invitation.
    expect(fromTables()).not.toContain('profiles');
    expect(fromTables()).not.toContain('user_stores');
    expect(rpcCallsNamed('consume_invitation')).toHaveLength(0);

    // Welcome email attempted (callEdgeFunction reads the session first).
    expect(getSessionMock).toHaveBeenCalled();
  });

  it('RPC error: returns the "profile setup failed" error and does not send the welcome email', async () => {
    mockInvitationRow = STAFF_INVITE;
    mockRegisterResult = { data: null, error: { message: 'no pending invitation' } };

    const result = await registerInvitedUser('staff164@test.local', 'password', 'Staff Member');

    expect(result.error).toBe('Account created but profile setup failed: no pending invitation');
    expect(result.user).toBeNull();
    expect(rpcCallsNamed('register_invited_profile')).toHaveLength(1);
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(rpcCallsNamed('consume_invitation')).toHaveLength(0);
  });

  it('admin invitation with NULL brand: existing pre-check error; signUp and the RPC are not called', async () => {
    mockInvitationRow = {
      id: 'inv-admin-164-nobrand',
      email: 'admin164@test.local',
      name: 'Admin Person',
      role: 'admin',
      store_ids: [],
      brand_id: null,
      resolved_brand_id: null,
      username: null,
      expires_at: null,
    };

    const result = await registerInvitedUser('admin164@test.local', 'password', 'Admin Person');

    expect(result.error).toBe(
      'Invitation is missing a brand assignment. Please ask your admin to re-issue the invite.',
    );
    expect(signUpMock).not.toHaveBeenCalled();
    expect(rpcCallsNamed('register_invited_profile')).toHaveLength(0);
  });

  it('no invitation: existing "No invitation found" error; signUp is not called', async () => {
    mockInvitationRow = null;

    const result = await registerInvitedUser('nobody164@test.local', 'password', 'Nobody');

    expect(result.error).toBe('No invitation found for this email. Please ask an admin to invite you.');
    expect(signUpMock).not.toHaveBeenCalled();
    expect(rpcCallsNamed('register_invited_profile')).toHaveLength(0);
  });

  it('signUp error: returns its message and the RPC is not called', async () => {
    mockInvitationRow = STAFF_INVITE;
    mockSignUpResult = { data: { user: null }, error: { message: 'User already registered' } };

    const result = await registerInvitedUser('staff164@test.local', 'password', 'Staff Member');

    expect(result.error).toBe('User already registered');
    expect(rpcCallsNamed('register_invited_profile')).toHaveLength(0);
    expect(fromTables()).not.toContain('profiles');
  });
});
