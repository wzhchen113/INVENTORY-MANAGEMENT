// src/lib/registerInvitedUser.test.ts — Spec 069 Track 1 (jest).
//
// Covers the brand-stamp half of the spec 069 fix: registerInvitedUser must
// write profiles.brand_id from the invitation's resolved_brand_id for
// role='user' (staff) invites, so newly-invited staff land WITH a brand and can
// read brand-scoped catalog data in the EOD app (the catalog_ingredients /
// vendors embeds). Admin invites are unchanged — they already carry a non-NULL
// invitation.brand_id and resolved_brand_id COALESCEs to it.
//
// Boundary mocked: `./supabase`. registerInvitedUser touches
//   - supabase.rpc('get_pending_invitation', …)  → the invitation envelope
//   - supabase.auth.signUp(…)                     → the new auth user
//   - supabase.from('profiles').insert(…)         → THE ASSERTION TARGET
//   - supabase.from('user_stores').insert(…)      → store links (ignored)
//   - supabase.rpc('consume_invitation', …)       → mark used (ignored)
//   - supabase.auth.getSession()                  → via callEdgeFunction for the
//                                                    fire-and-forget welcome email
// We record the object passed to the profiles INSERT and assert its brand_id.
//
// This file does NOT reuse src/lib/auth.test.ts's module mock (which only stubs
// supabase.auth.getSession) — registerInvitedUser needs rpc + signUp + from, so
// a dedicated mock with the full surface is cleaner than widening the other
// file's stub.

const BRAND_A = '2a000000-0000-0000-0000-000000000001';

// Captured payload from the profiles INSERT, per test. Prefixed `mock` so the
// hoisted jest.mock() factory below is permitted to reference it (jest's
// out-of-scope-variable guard allows `mock*`-prefixed names).
let mockProfileInsertPayload: any = null;

// Per-test override for what get_pending_invitation resolves to. Same `mock`
// prefix rule as above.
let mockInvitationRow: any = null;

jest.mock('./supabase', () => ({
  supabase: {
    rpc: jest.fn((fn: string) => {
      if (fn === 'get_pending_invitation') {
        return Promise.resolve({ data: [mockInvitationRow], error: null });
      }
      // consume_invitation and any other rpc → benign success
      return Promise.resolve({ data: null, error: null });
    }),
    auth: {
      signUp: jest.fn(() =>
        Promise.resolve({
          data: { user: { id: 'new-user-id-069' } },
          error: null,
        }),
      ),
      // callEdgeFunction (send-welcome-email) reads this; return no session so
      // it short-circuits to { error: 'Not authenticated' } without a network
      // call. The welcome email is fire-and-forget; registerInvitedUser does
      // not await or branch on it, so this does not affect the result.
      getSession: jest.fn(() => Promise.resolve({ data: { session: null } })),
    },
    from: jest.fn((table: string) => ({
      insert: jest.fn((payload: any) => {
        if (table === 'profiles') {
          mockProfileInsertPayload = payload;
        }
        return Promise.resolve({ error: null });
      }),
      // inviteUser's expired-invite cleanup chain (.delete().lt().eq()) is not
      // exercised by registerInvitedUser, but keep the stub permissive.
      delete: jest.fn(() => ({ lt: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ error: null })) })) })),
    })),
  },
}));

import { registerInvitedUser } from './auth';

describe('registerInvitedUser brand stamp (spec 069)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProfileInsertPayload = null;
    mockInvitationRow = null;
  });

  it('stamps profiles.brand_id from resolved_brand_id for a staff (role=user) invite', async () => {
    // The staff invite carries brand_id: null (InviteUserDrawer sends null for
    // staff) but get_pending_invitation resolves the brand server-side from the
    // assigned store. registerInvitedUser must write that resolved brand.
    mockInvitationRow = {
      id: 'inv-staff-069',
      email: 'staff069@test.local',
      name: 'Staff Member',
      role: 'user',
      store_ids: ['00000000-0000-0000-0000-000000000001'],
      brand_id: null,
      resolved_brand_id: BRAND_A,
      expires_at: null,
    };

    const result = await registerInvitedUser('staff069@test.local', 'password', 'Staff Member');

    expect(result.error).toBeNull();
    expect(mockProfileInsertPayload).not.toBeNull();
    // THE CORE ASSERTION — brand_id is the resolved brand, NOT null.
    expect(mockProfileInsertPayload.brand_id).toBe(BRAND_A);
    expect(mockProfileInsertPayload.role).toBe('user');
  });

  it('falls back to invitation.brand_id then null for a staff invite when resolved_brand_id is absent', async () => {
    // Defensive: if resolved_brand_id is missing (e.g. a pre-069 cached RPC
    // shape) the role='user' branch falls through to brand_id ?? null. With a
    // zero-store staff invite this is null — constraint-legal, a benign no-op.
    mockInvitationRow = {
      id: 'inv-staff-069-nostore',
      email: 'staff069nostore@test.local',
      name: 'No Store Staff',
      role: 'user',
      store_ids: [],
      brand_id: null,
      // resolved_brand_id intentionally undefined
      expires_at: null,
    };

    const result = await registerInvitedUser('staff069nostore@test.local', 'password', 'No Store Staff');

    expect(result.error).toBeNull();
    expect(mockProfileInsertPayload).not.toBeNull();
    expect(mockProfileInsertPayload.brand_id).toBeNull();
  });

  it('leaves the admin invite path unchanged — brand_id from invitation.brand_id (resolved == brand_id)', async () => {
    // Admin invites already require a non-NULL brand_id; resolved_brand_id
    // COALESCEs to it. The role!=='user' branch passes invitation.brand_id
    // straight through, so the admin path is byte-for-byte unchanged.
    mockInvitationRow = {
      id: 'inv-admin-069',
      email: 'admin069@test.local',
      name: 'Admin Person',
      role: 'admin',
      store_ids: ['00000000-0000-0000-0000-000000000001'],
      brand_id: BRAND_A,
      resolved_brand_id: BRAND_A,
      expires_at: null,
    };

    const result = await registerInvitedUser('admin069@test.local', 'password', 'Admin Person');

    expect(result.error).toBeNull();
    expect(mockProfileInsertPayload).not.toBeNull();
    expect(mockProfileInsertPayload.brand_id).toBe(BRAND_A);
    expect(mockProfileInsertPayload.role).toBe('admin');
  });

  it('does NOT use resolved_brand_id for an admin invite even if the two ever diverge (admin path reads brand_id only)', async () => {
    // Guard against a future regression where the admin branch is accidentally
    // pointed at resolved_brand_id. The admin path must read invitation.brand_id
    // exclusively. Construct a (contrived) row where they differ and assert the
    // INSERT used brand_id, not resolved_brand_id.
    mockInvitationRow = {
      id: 'inv-admin-069-diverge',
      email: 'admin069diverge@test.local',
      name: 'Admin Diverge',
      role: 'admin',
      store_ids: ['00000000-0000-0000-0000-000000000001'],
      brand_id: BRAND_A,
      resolved_brand_id: 'b1000000-0000-0000-0000-000000000001', // different brand
      expires_at: null,
    };

    const result = await registerInvitedUser('admin069diverge@test.local', 'password', 'Admin Diverge');

    expect(result.error).toBeNull();
    expect(mockProfileInsertPayload.brand_id).toBe(BRAND_A);
  });
});
