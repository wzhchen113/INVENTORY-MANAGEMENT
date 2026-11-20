// src/lib/inviteUser.test.ts — Spec 198 §8.3 (jest), rewritten from spec 090.
//
// Spec 198 moved invitation creation behind the SECURITY INVOKER RPC
// `create_invitation`, which replaces a visible pending invitation for the same
// email (B8), stores only the code's sha256, and returns the plaintext code
// once. This file pins the CLIENT half of that contract:
//   - exactly one rpc('create_invitation', <exact args>)
//   - ZERO from('invitations') calls (no expired-row delete, no "already
//     exists" read, no direct insert); from('stores') is allowed (spec 090)
//   - the send-invite-email payload carries `inviteCode` (AD-7: the code, not
//     a URL)
//   - success returns { error: null, inviteCode, expiresAt } (snake → camel)
//   - an RPC error returns { error } and sends no email
//   - a malformed `data.code` is an error
//   - an admin invite without a brand makes no RPC
//   - the spec 090 store-derived brand is retained
//
// The server half (RLS scope, replace-on-reinvite, hash storage, AD-4 brand
// stamp) is pgTAP: supabase/tests/invitations_hardening.test.sql.
//
// Boundary mocked: `./supabase` (rpc / from / auth.getSession) and global
// fetch. callEdgeFunction lives in auth.ts and reads getSession first, so a
// session is returned and `fetch` captures the edge-function body.

const BRAND_A = '2a000000-0000-0000-0000-000000000001';
const STORE_IN_BRAND_A = '00000000-0000-0000-0000-000000000001';
const CODE = '0123456789abcdef0123456789abcdef';
const EXPIRES = '2026-11-12T12:00:00+00:00';

// Prefixed `mock` so the hoisted jest.mock() factory may reference them.
let mockRpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let mockStoreBrandRow: { brand_id: string } | null = null;

jest.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() =>
        Promise.resolve({ data: { session: { access_token: 'tok-198' } } }),
      ),
    },
    rpc: jest.fn(() => Promise.resolve(mockRpcResult)),
    from: jest.fn((table: string) => {
      if (table === 'stores') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(() => Promise.resolve({ data: mockStoreBrandRow, error: null })),
            })),
          })),
        };
      }
      // Any other table is a regression; return a chain that resolves so the
      // assertion on from() calls (not a crash) is what fails.
      const chain: any = {};
      for (const m of ['select', 'insert', 'delete', 'update', 'eq', 'lt', 'single']) {
        chain[m] = jest.fn(() => chain);
      }
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return chain;
    }),
  },
}));

import { inviteUser } from './auth';
import { supabase } from './supabase';

const rpcMock = supabase.rpc as unknown as jest.Mock;
const fromMock = supabase.from as unknown as jest.Mock;
const fetchMock = jest.fn();

function fromTables(): unknown[] {
  return fromMock.mock.calls.map((c: unknown[]) => c[0]);
}

/** Bodies POSTed to send-invite-email (callEdgeFunction → fetch). */
function inviteEmailBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((c: unknown[]) => String(c[0]).endsWith('/functions/v1/send-invite-email'))
    .map((c: unknown[]) => JSON.parse((c[1] as { body: string }).body));
}

// callEdgeFunction is fire-and-forget; let its awaited getSession + fetch run.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('{"success":true}') });
  mockRpcResult = {
    data: { invitation_id: 'inv-198', code: CODE, expires_at: EXPIRES },
    error: null,
  };
  mockStoreBrandRow = { brand_id: BRAND_A };
});

describe('inviteUser → create_invitation (spec 198)', () => {
  it('calls create_invitation exactly once with the exact args and touches no invitations table', async () => {
    const result = await inviteUser({
      email: '  StaffWithStore@Test.Local ',
      name: 'Staff With Store',
      role: 'user',
      brandId: BRAND_A,
      storeIds: [STORE_IN_BRAND_A],
      storeNames: 'Towson',
      username: '  Staff_B ',
    });

    expect(result).toEqual({ error: null, inviteCode: CODE, expiresAt: EXPIRES });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('create_invitation', {
      p_email: 'staffwithstore@test.local',
      p_name: 'Staff With Store',
      p_role: 'user',
      p_store_ids: [STORE_IN_BRAND_A],
      p_brand_id: BRAND_A,
      p_username: 'staff_b',
    });
    expect(fromTables()).not.toContain('invitations');
  });

  it('passes p_username null when no username is given', async () => {
    await inviteUser({ email: 'a@test.local', name: 'A', role: 'user', brandId: BRAND_A, storeIds: [] });
    expect(rpcMock.mock.calls[0][1]).toEqual(expect.objectContaining({ p_username: null }));
  });

  it('sends the invite code (not a URL) in the send-invite-email payload', async () => {
    await inviteUser({
      email: 'Invitee@test.local',
      name: 'Invitee',
      role: 'user',
      brandId: BRAND_A,
      storeIds: [STORE_IN_BRAND_A],
      storeNames: 'Towson',
    });
    await flush();

    const bodies = inviteEmailBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      email: 'Invitee@test.local',
      name: 'Invitee',
      role: 'user',
      storeNames: 'Towson',
      inviteCode: CODE,
    });
  });

  it('an RPC error returns { error } and sends no email', async () => {
    mockRpcResult = {
      data: null,
      error: { message: 'new row violates row-level security policy for table "invitations"' },
    };
    const result = await inviteUser({
      email: 'x@test.local', name: 'X', role: 'user', brandId: BRAND_A, storeIds: [STORE_IN_BRAND_A],
    });
    await flush();

    expect(result.error).toBe('new row violates row-level security policy for table "invitations"');
    expect(result.inviteCode).toBeUndefined();
    expect(inviteEmailBodies()).toHaveLength(0);
  });

  it.each([
    ['missing', { invitation_id: 'i', expires_at: EXPIRES }],
    ['upper case', { invitation_id: 'i', code: CODE.toUpperCase(), expires_at: EXPIRES }],
    ['too short', { invitation_id: 'i', code: CODE.slice(2), expires_at: EXPIRES }],
    ['not a string', { invitation_id: 'i', code: 12345, expires_at: EXPIRES }],
    ['null data', null],
  ])('a malformed data.code (%s) is an error and sends no email', async (_label, data) => {
    mockRpcResult = { data, error: null };
    const result = await inviteUser({
      email: 'x@test.local', name: 'X', role: 'user', brandId: BRAND_A, storeIds: [],
    });
    await flush();

    expect(result.error).toBe('Unexpected response from server');
    expect(inviteEmailBodies()).toHaveLength(0);
  });

  it('an admin invite without a brand returns the existing error and makes no RPC', async () => {
    const result = await inviteUser({
      email: 'admin-nobrand@test.local',
      name: 'Admin No Brand',
      role: 'admin',
      brandId: null,
      storeIds: [STORE_IN_BRAND_A],
    });

    expect(result.error).toBe('Admin invitations require a brand assignment');
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('inviteUser brand derivation (spec 090, retained by spec 198)', () => {
  it('derives p_brand_id from the first assigned store for a brand-less user invite', async () => {
    const result = await inviteUser({
      email: 'staff@test.local',
      name: 'Staff',
      role: 'user',
      brandId: null,
      storeIds: [STORE_IN_BRAND_A],
    });

    expect(result.error).toBeNull();
    expect(fromTables()).toEqual(['stores']);
    expect(rpcMock.mock.calls[0][1]).toEqual(expect.objectContaining({ p_brand_id: BRAND_A }));
  });

  it('a zero-store user invite passes p_brand_id null and skips the stores read (server stamps AD-4)', async () => {
    const result = await inviteUser({
      email: 'nostore@test.local',
      name: 'No Store Staff',
      role: 'user',
      brandId: null,
      storeIds: [],
    });

    expect(result.error).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ p_brand_id: null, p_store_ids: [] }),
    );
  });

  it('an admin invite passes its brand verbatim and skips the stores read', async () => {
    const result = await inviteUser({
      email: 'admin@test.local',
      name: 'Admin Person',
      role: 'admin',
      brandId: BRAND_A,
      storeIds: [STORE_IN_BRAND_A],
    });

    expect(result.error).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ p_role: 'admin', p_brand_id: BRAND_A }),
    );
  });
});
