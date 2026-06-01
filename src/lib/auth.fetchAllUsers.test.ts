// src/lib/auth.fetchAllUsers.test.ts — Spec 083 Track 1 (jest).
//
// End-to-end assertion of the spec-083 fix at the fetchAllUsers boundary (the
// REAL loader behind UsersSection's "(email not loaded)" bug). fetchAllUsers
// (src/lib/auth.ts) infers each user's email from invitation rows, indexing by
// profile_id (winning) then name. Spec 083 relaxes fetchInvitationsForUserLookup
// (db.ts) so a NULL-brand invitation is no longer hidden when a brandId is
// scoped. This test asserts fetchAllUsers resolves a NON-EMPTY email for a
// profile whose only matching invitation is NULL-brand, matched by profile_id,
// WHEN a brandId is supplied — the literal spec AC.
//
// Mocking strategy:
//   - jest.mock('./db') — stub fetchInvitationsForUserLookup (return the
//     NULL-brand invitation) and fetchStoreIdsForBrand (return an empty set).
//     This isolates the test to fetchAllUsers' inference logic and means the
//     db.ts helpers' own supabase reads never fire.
//   - jest.mock('./supabase') — supabase.from(table) returns a FRESH chainable
//     builder per call, routed BY TABLE NAME. fetchAllUsers reads `profiles`
//     (terminal await on the query) and `user_stores` (terminal `.in(...)`).
//     The builders are await-able directly (no .abortSignal in auth.ts —
//     fetchAllUsers is a carve-out that predates the inflight discipline), so
//     each builder is a thenable resolving to its per-test result.
//   - jest.mock('./sidebarLayout') — auth.ts imports isValidOverride; stub so
//     the import graph stays light. Not exercised here.

import type { User } from '../types';

const SENTINEL = '00000000-0000-0000-0000-000000000000';
const BRAND = 'brand-1';

let profilesResult: { data: any[] | null; error: any };
let userStoresResult: { data: any[] | null; error: any };
let invitationsReturn: any[];

/** A chainable, await-able builder. Intermediate methods return `this`; the
 *  builder itself is a thenable resolving to `result` (auth.ts awaits the
 *  query directly, no terminal `.abortSignal()`). */
function makeBuilder(result: { data: any[] | null; error: any }) {
  const builder: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    then: (resolve: (v: any) => any) => resolve(result),
  };
  return builder;
}

const mockFrom = jest.fn((table: string) => {
  switch (table) {
    case 'profiles':    return makeBuilder(profilesResult);
    case 'user_stores': return makeBuilder(userStoresResult);
    default: throw new Error(`unexpected table in fetchAllUsers: ${table}`);
  }
});

jest.mock('./supabase', () => ({
  supabase: { from: (table: string) => mockFrom(table) },
}));

// Stub the db.ts helpers fetchAllUsers calls. fetchInvitationsForUserLookup
// returns the NULL-brand invitation (the row the spec-083 relaxation now keeps
// in scope); fetchStoreIdsForBrand returns an empty allow-set.
const mockFetchInvitations = jest.fn((_brandId?: string) =>
  Promise.resolve(invitationsReturn),
);
const mockFetchStoreIds = jest.fn((_brandId: string) =>
  Promise.resolve(new Set<string>()),
);

jest.mock('./db', () => ({
  fetchInvitationsForUserLookup: (brandId?: string) => mockFetchInvitations(brandId),
  fetchStoreIdsForBrand: (brandId: string) => mockFetchStoreIds(brandId),
}));

jest.mock('./sidebarLayout', () => ({ isValidOverride: () => true }));

import { fetchAllUsers } from './auth';

function profileRow(over: Record<string, any>): any {
  return {
    id: 'p-default', brand_id: BRAND, name: 'Default', nickname: '',
    role: 'admin', status: 'active', initials: null, color: null,
    notifications_enabled: true, created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function inviteRow(over: Record<string, any>): any {
  return {
    email: 'x@example.com', name: 'Default',
    brand_id: BRAND, profile_id: SENTINEL,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  profilesResult = { data: [], error: null };
  userStoresResult = { data: [], error: null };
  invitationsReturn = [];
});

describe('fetchAllUsers — spec 083 NULL-brand email inference', () => {
  // THE LITERAL SPEC AC: a brand-scoped call (opts.brandId set) resolves a
  // non-empty email for a profile whose only matching invitation is NULL-brand,
  // matched by profile_id. Pre-083 the brand filter dropped that invitation and
  // the email rendered '' → "(email not loaded)".
  it('resolves a non-empty email for a NULL-brand invitation matched by profile_id when a brandId is supplied', async () => {
    profilesResult = {
      data: [profileRow({ id: 'p-bob', name: 'Bobby', role: 'admin', brand_id: BRAND })],
      error: null,
    };
    invitationsReturn = [
      inviteRow({ name: 'Bobby', email: 'bobby@example.com', brand_id: null, profile_id: 'p-bob' }),
    ];

    const result = await fetchAllUsers({ brandId: BRAND });

    // The brandId reached the (now-ignored) lookup arg — proves the brand-scoped
    // call path, even though the relaxed helper no longer filters on it.
    expect(mockFetchInvitations).toHaveBeenCalledWith(BRAND);
    const bob = result.find((u: User) => u.id === 'p-bob')!;
    expect(bob).toBeDefined();
    expect(bob.email).toBe('bobby@example.com'); // not '' → bug fixed
    expect(bob.status).toBe('active');
  });

  // The all-brands (super_admin) call resolves the same NULL-brand invitation
  // too — opts.brandId undefined, no brand filter anywhere. Both views fixed.
  it('resolves the NULL-brand invitation in the all-brands (no brandId) call', async () => {
    profilesResult = {
      data: [profileRow({ id: 'p-chuck', name: 'Charles', role: 'user', brand_id: BRAND })],
      error: null,
    };
    invitationsReturn = [
      inviteRow({ name: 'Charles', email: 'charles@example.com', brand_id: null, profile_id: 'p-chuck' }),
    ];

    const result = await fetchAllUsers();

    expect(mockFetchInvitations).toHaveBeenCalledWith(undefined);
    const chuck = result.find((u: User) => u.id === 'p-chuck')!;
    expect(chuck.email).toBe('charles@example.com');
  });
});
