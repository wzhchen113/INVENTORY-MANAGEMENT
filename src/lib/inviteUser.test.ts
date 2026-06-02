// src/lib/inviteUser.test.ts — Spec 090 Track 1 (jest).
//
// Covers the write-side source fix: inviteUser must stop writing NULL-brand
// invitations for user/manager invites that carry assigned stores. The brand
// is DERIVED from the first assigned store's brand (mirroring the server-side
// COALESCE(brand_id, store_ids[1] brand) in get_pending_invitation, spec 069).
// A zero-store user invite legitimately stays NULL-brand, and the admin path is
// unchanged (verbatim passthrough + the existing missing-brand error).
//
// Boundary mocked: `./supabase`. inviteUser touches
//   - supabase.from('invitations').delete().lt().eq()        → expired cleanup (ignored)
//   - supabase.from('invitations').select().eq().eq().single() → dup check (no row)
//   - supabase.from('stores').select().eq().single()         → THE DERIVE READ
//   - supabase.from('invitations').insert(…)                 → THE ASSERTION TARGET
//   - supabase.auth.getSession()                             → via callEdgeFunction for
//                                                              the fire-and-forget invite email
// We record the object passed to the invitations INSERT and assert its brand_id,
// and track whether the stores derive read fired.
//
// This file does NOT reuse src/lib/auth.test.ts's module mock (which only stubs
// supabase.auth.getSession) — inviteUser needs the full from() surface, so a
// dedicated mock is cleaner than widening the other file's stub. Modeled on
// src/lib/registerInvitedUser.test.ts (spec 069).

const BRAND_A = '2a000000-0000-0000-0000-000000000001';
const STORE_IN_BRAND_A = '00000000-0000-0000-0000-000000000001';

// Captured payload from the invitations INSERT, per test. Prefixed `mock` so the
// hoisted jest.mock() factory below is permitted to reference it (jest's
// out-of-scope-variable guard allows `mock*`-prefixed names).
let mockInvitationInsertPayload: any = null;
// True when the secondary stores derive read fired.
let mockStoresReadFired = false;
// What the stores derive read resolves to (the assigned store's brand).
let mockStoreBrandRow: any = null;

jest.mock('./supabase', () => ({
  supabase: {
    auth: {
      // callEdgeFunction (send-invite-email) reads this; return no session so
      // it short-circuits to { error: 'Not authenticated' } without a network
      // call. The invite email is fire-and-forget; inviteUser does not await or
      // branch on it, so this does not affect the result.
      getSession: jest.fn(() => Promise.resolve({ data: { session: null } })),
    },
    from: jest.fn((table: string) => {
      if (table === 'stores') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(() => {
                mockStoresReadFired = true;
                return Promise.resolve({ data: mockStoreBrandRow, error: null });
              }),
            })),
          })),
        };
      }
      // table === 'invitations'
      return {
        // Expired-invite cleanup: .delete().lt().eq()
        delete: jest.fn(() => ({
          lt: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ error: null })) })),
        })),
        // Dup check: .select('id').eq('email', …).eq('used', false).single()
        // → no existing row.
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(() => Promise.resolve({ data: null, error: null })),
            })),
          })),
        })),
        insert: jest.fn((payload: any) => {
          mockInvitationInsertPayload = payload;
          return Promise.resolve({ error: null });
        }),
      };
    }),
  },
}));

import { inviteUser } from './auth';

describe('inviteUser brand derivation (spec 090)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvitationInsertPayload = null;
    mockStoresReadFired = false;
    // Default: the assigned store belongs to BRAND_A.
    mockStoreBrandRow = { brand_id: BRAND_A };
  });

  it('derives a non-null brand_id from the assigned store for a user invite (AC-110)', async () => {
    // The drawer passes brandId: null for user invites; the assigned store is
    // in BRAND_A, so the invitation row must be written with brand_id === BRAND_A.
    const result = await inviteUser({
      email: 'StaffWithStore@test.local',
      name: 'Staff With Store',
      role: 'user',
      brandId: null,
      storeIds: [STORE_IN_BRAND_A],
      storeNames: 'Store A',
    });

    expect(result.error).toBeNull();
    expect(mockStoresReadFired).toBe(true);
    expect(mockInvitationInsertPayload).not.toBeNull();
    // THE CORE ASSERTION — brand_id is the assigned store's brand, NOT null.
    expect(mockInvitationInsertPayload.brand_id).toBe(BRAND_A);
    expect(mockInvitationInsertPayload.role).toBe('user');
    // Email is lower-cased on write.
    expect(mockInvitationInsertPayload.email).toBe('staffwithstore@test.local');
  });

  it('leaves a zero-store user invite NULL-brand and does NOT fire the derive read (AC-122)', async () => {
    // A zero-store user invite is legitimate (the invitee gains access when
    // stores are assigned). With no store to derive from, brand_id stays null
    // and the stores read must be skipped.
    const result = await inviteUser({
      email: 'nostore@test.local',
      name: 'No Store Staff',
      role: 'user',
      brandId: null,
      storeIds: [],
    });

    expect(result.error).toBeNull();
    expect(mockStoresReadFired).toBe(false);
    expect(mockInvitationInsertPayload).not.toBeNull();
    expect(mockInvitationInsertPayload.brand_id).toBeNull();
    expect(mockInvitationInsertPayload.role).toBe('user');
  });

  it('passes an admin invite brand_id through verbatim and does NOT fire the derive read (AC-116, half 1)', async () => {
    // Admin invites already carry an explicit brand; the derive branch is gated
    // on role !== 'admin', so it must not fire. The brand is written verbatim.
    const result = await inviteUser({
      email: 'admin@test.local',
      name: 'Admin Person',
      role: 'admin',
      brandId: BRAND_A,
      storeIds: [STORE_IN_BRAND_A],
    });

    expect(result.error).toBeNull();
    expect(mockStoresReadFired).toBe(false);
    expect(mockInvitationInsertPayload).not.toBeNull();
    expect(mockInvitationInsertPayload.brand_id).toBe(BRAND_A);
    expect(mockInvitationInsertPayload.role).toBe('admin');
  });

  it('returns the existing missing-brand error for an admin invite with no brand and writes NO row (AC-116, half 2)', async () => {
    // The admin guard fires before any side-effect: no invitations INSERT, no
    // stores read. The error string is unchanged.
    const result = await inviteUser({
      email: 'admin-nobrand@test.local',
      name: 'Admin No Brand',
      role: 'admin',
      brandId: null,
      storeIds: [STORE_IN_BRAND_A],
    });

    expect(result.error).toBe('Admin invitations require a brand assignment');
    expect(mockInvitationInsertPayload).toBeNull();
    expect(mockStoresReadFired).toBe(false);
  });
});
