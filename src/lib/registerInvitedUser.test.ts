// src/lib/registerInvitedUser.test.ts — Spec 198 B10 (jest), rewritten from 164.
//
// Pins the client half of the code-gated claim:
//   - an invalid / missing code → INVITE_CODE_REQUIRED_ERROR with NO network
//     call (no RPC, no signUp)
//   - the pre-check is check_invitation_code({ p_email, p_code }) with both
//     normalized (trimmed + lower-cased; a pasted full link yields the code)
//   - zero rows or an error from the pre-check → NO_PENDING_INVITATION_ERROR
//     and signUp is NOT called (no orphan auth user on a wrong code)
//   - success order: check_invitation_code → signUp (no `role`, name from the
//     pre-check row) → register_invited_profile({ p_code }) exactly once
//   - never calls get_pending_invitation (dropped server-side) and makes no
//     from() writes; never calls consume_invitation
//   - a claim error → "Account created but profile setup failed: …"
//
// The server half (selection by code, inviter re-check, refusal matrix,
// pre-check / claim agreement) is pgTAP:
// supabase/tests/invitations_hardening.test.sql.
//
// Welcome-email detection: callEdgeFunction lives in the same module, so it
// cannot be spied through the import. Its first statement is
// supabase.auth.getSession(), so "getSession was called" is the observable
// proxy for "the welcome email was attempted".

const CODE = '0123456789abcdef0123456789abcdef';

// Prefixed `mock` so the hoisted jest.mock() factory may reference them.
let mockCheckResult: { data: unknown; error: { message: string } | null } = { data: [], error: null };
let mockRegisterResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let mockSignUpResult: { data: { user: { id: string } | null }; error: { message: string } | null } = {
  data: { user: { id: 'new-user-id-198' } },
  error: null,
};

jest.mock('./supabase', () => ({
  supabase: {
    rpc: jest.fn((fn: string) => {
      if (fn === 'check_invitation_code') return Promise.resolve(mockCheckResult);
      if (fn === 'register_invited_profile') return Promise.resolve(mockRegisterResult);
      // Anything else (a regressed get_pending_invitation / consume_invitation
      // call) → benign; the assertions below catch it by name.
      return Promise.resolve({ data: null, error: null });
    }),
    auth: {
      signUp: jest.fn(() => Promise.resolve(mockSignUpResult)),
      getSession: jest.fn(() => Promise.resolve({ data: { session: null } })),
    },
    from: jest.fn(() => ({
      insert: jest.fn(() => Promise.resolve({ error: null })),
      update: jest.fn(() => Promise.resolve({ error: null })),
      delete: jest.fn(() => Promise.resolve({ error: null })),
    })),
  },
}));

import {
  registerInvitedUser,
  INVITE_CODE_REQUIRED_ERROR,
  NO_PENDING_INVITATION_ERROR,
} from './auth';
import { supabase } from './supabase';

const rpcMock = supabase.rpc as unknown as jest.Mock;
const signUpMock = supabase.auth.signUp as unknown as jest.Mock;
const getSessionMock = supabase.auth.getSession as unknown as jest.Mock;
const fromMock = supabase.from as unknown as jest.Mock;

function rpcCallsNamed(name: string): unknown[][] {
  return rpcMock.mock.calls.filter((c: unknown[]) => c[0] === name);
}

describe('registerInvitedUser (spec 198 — code-gated claim)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckResult = { data: [{ name: 'Staff Member' }], error: null };
    mockRegisterResult = { data: 'new-user-id-198', error: null };
    mockSignUpResult = { data: { user: { id: 'new-user-id-198' } }, error: null };
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['too short', CODE.slice(1)],
    ['non-hex', `${CODE.slice(1)}z`],
    ['a recovery-style link', `https://app.example/?code=${CODE}`],
  ])('an invalid code (%s) → INVITE_CODE_REQUIRED_ERROR, no RPC, no signUp', async (_label, code) => {
    const result = await registerInvitedUser('staff@test.local', 'password', code);

    expect(result).toEqual({ user: null, error: INVITE_CODE_REQUIRED_ERROR });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('normalizes the pre-check arguments (email trimmed + lower-cased; code from a pasted link)', async () => {
    await registerInvitedUser(
      '  Staff@Test.Local ',
      'password',
      ` https://app.example/?register=true&invite=${CODE.toUpperCase()} `,
    );

    const checks = rpcCallsNamed('check_invitation_code');
    expect(checks).toHaveLength(1);
    expect(checks[0][1]).toEqual({ p_email: 'staff@test.local', p_code: CODE });
  });

  it.each([
    ['zero rows', { data: [], error: null }],
    ['null data', { data: null, error: null }],
    ['an RPC error', { data: null, error: { message: 'permission denied' } }],
  ])('pre-check %s → NO_PENDING_INVITATION_ERROR and signUp is not called', async (_label, res) => {
    mockCheckResult = res;

    const result = await registerInvitedUser('staff@test.local', 'password', CODE);

    expect(result).toEqual({ user: null, error: NO_PENDING_INVITATION_ERROR });
    expect(signUpMock).not.toHaveBeenCalled();
    expect(rpcCallsNamed('register_invited_profile')).toHaveLength(0);
  });

  it('success: check_invitation_code → signUp (no role, name from pre-check) → one register_invited_profile({ p_code })', async () => {
    const result = await registerInvitedUser('staff@test.local', 'password', CODE);

    expect(result.error).toBeNull();

    // signUp once; options.data is exactly { name } from the pre-check row.
    expect(signUpMock).toHaveBeenCalledTimes(1);
    const signUpArg = signUpMock.mock.calls[0][0];
    expect(signUpArg.email).toBe('staff@test.local');
    expect(signUpArg.options.data).toEqual({ name: 'Staff Member' });
    expect(signUpArg.options.data).not.toHaveProperty('role');

    // Exactly one claim, carrying the code.
    const regCalls = rpcCallsNamed('register_invited_profile');
    expect(regCalls).toHaveLength(1);
    expect(regCalls[0][1]).toEqual({ p_code: CODE });

    // Order: pre-check < signUp < claim.
    const checkIdx = rpcMock.mock.calls.findIndex((c: unknown[]) => c[0] === 'check_invitation_code');
    const regIdx = rpcMock.mock.calls.findIndex((c: unknown[]) => c[0] === 'register_invited_profile');
    const signUpOrder = signUpMock.mock.invocationCallOrder[0];
    expect(rpcMock.mock.invocationCallOrder[checkIdx]).toBeLessThan(signUpOrder);
    expect(rpcMock.mock.invocationCallOrder[regIdx]).toBeGreaterThan(signUpOrder);

    // Never the dropped lookup, never consume_invitation, no table writes.
    expect(rpcCallsNamed('get_pending_invitation')).toHaveLength(0);
    expect(rpcCallsNamed('consume_invitation')).toHaveLength(0);
    expect(fromMock).not.toHaveBeenCalled();

    // Welcome email attempted (callEdgeFunction reads the session first).
    expect(getSessionMock).toHaveBeenCalled();
  });

  it('accepts a single-object pre-check payload as well as an array', async () => {
    mockCheckResult = { data: { name: 'Solo Row' }, error: null };

    const result = await registerInvitedUser('staff@test.local', 'password', CODE);

    expect(result.error).toBeNull();
    expect(signUpMock.mock.calls[0][0].options.data).toEqual({ name: 'Solo Row' });
  });

  it('a claim error → "profile setup failed" and no welcome email', async () => {
    mockRegisterResult = { data: null, error: { message: 'no pending invitation' } };

    const result = await registerInvitedUser('staff@test.local', 'password', CODE);

    expect(result.error).toBe('Account created but profile setup failed: no pending invitation');
    expect(result.user).toBeNull();
    expect(rpcCallsNamed('register_invited_profile')).toHaveLength(1);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('a signUp error returns its message and no claim is made', async () => {
    mockSignUpResult = { data: { user: null }, error: { message: 'User already registered' } };

    const result = await registerInvitedUser('staff@test.local', 'password', CODE);

    expect(result.error).toBe('User already registered');
    expect(rpcCallsNamed('register_invited_profile')).toHaveLength(0);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
