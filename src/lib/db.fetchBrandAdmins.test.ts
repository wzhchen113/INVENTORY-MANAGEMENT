// src/lib/db.fetchBrandAdmins.test.ts — Spec 082 Track 1 (jest).
//
// Unit-tests fetchBrandAdmins' email-inference row-shaping after the
// spec-082 fix (db.ts): the invitations query no longer filters used=false,
// so a REGISTERED user's used=true invite still feeds email inference (the
// headline bug — "(email not loaded)"); the synthetic pending rows are built
// from only the !used subset so a consumed invite never becomes a phantom
// pending row.
//
// Mocking strategy (mirrors db.crossStoreLoaders.test.ts:28-56 / cmdSelectors
// .unconfirmedPoWindow.test.ts:19 for the supabase stub + the track() boundary):
//   - jest.mock('./supabase') — supabase.from(table) returns a FRESH chainable
//     builder per call, routed BY TABLE NAME (fetchBrandAdmins queries four
//     tables: profiles, invitations, stores, user_stores). Every intermediate
//     builder method returns `this`; the terminal `.abortSignal()` resolves to
//     that table's per-test result. profiles/invitations/stores resolve via
//     Promise.all; user_stores is a conditional follow-up.
//   - jest.mock('./inflight') — track(fn) invokes fn directly with a dummy
//     AbortSignal so the real timers never arm in node.
//   - jest.mock('./auth') — db.ts imports callEdgeFunction from it; stub so the
//     import graph stays light. Not exercised here.

import type { User } from '../types';

const SENTINEL = '00000000-0000-0000-0000-000000000000';
const BRAND = 'brand-1';

// Per-table result registers, set per-test.
let profilesResult: { data: any[] | null; error: any };
let invitationsResult: { data: any[] | null; error: any };
let storesResult: { data: any[] | null; error: any };
let userStoresResult: { data: any[] | null; error: any };

/** A chainable PostgrestBuilder stub whose terminal `.abortSignal()` resolves
 *  to `result`. Every other method returns `this`. */
function makeBuilder(result: { data: any[] | null; error: any }) {
  const builder: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    abortSignal: jest.fn().mockResolvedValue(result),
  };
  return builder;
}

const mockFrom = jest.fn((table: string) => {
  switch (table) {
    case 'profiles':    return makeBuilder(profilesResult);
    case 'invitations': return makeBuilder(invitationsResult);
    case 'stores':      return makeBuilder(storesResult);
    case 'user_stores': return makeBuilder(userStoresResult);
    default: throw new Error(`unexpected table in fetchBrandAdmins: ${table}`);
  }
});

jest.mock('./supabase', () => ({
  supabase: { from: (table: string) => mockFrom(table) },
}));

jest.mock('./inflight', () => ({
  useInflight: {
    getState: () => ({
      track: (fn: (signal: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal),
    }),
  },
}));

jest.mock('./auth', () => ({ callEdgeFunction: jest.fn() }));

import { fetchBrandAdmins } from './db';

/** Minimal profiles row (snake_case, as PostgREST returns). */
function profileRow(over: Record<string, any>): any {
  return {
    id: 'p-default', brand_id: BRAND, name: 'Default', nickname: '',
    role: 'admin', status: 'active', initials: null, color: null,
    notifications_enabled: true, created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/** Minimal invitations row (snake_case). */
function inviteRow(over: Record<string, any>): any {
  return {
    id: 'inv-default', email: 'x@example.com', name: 'Default',
    role: 'manager', store_ids: [], brand_id: BRAND, used: true,
    expires_at: null, profile_id: SENTINEL,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  profilesResult = { data: [], error: null };
  invitationsResult = { data: [], error: null };
  storesResult = { data: [], error: null };
  userStoresResult = { data: [], error: null };
});

describe('fetchBrandAdmins — spec 082 email inference', () => {
  it('returns [] for an empty brandId without touching supabase', async () => {
    const result = await fetchBrandAdmins('');
    expect(result).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  // (a) THE HEADLINE BUG: a registered profile with a used=true name-matching
  // invite resolves a NON-EMPTY email. Pre-082, the used=false filter dropped
  // this invite → email '' → "(email not loaded)". The invite carries the
  // sentinel profile_id (legacy / un-backfilled) so this also proves the
  // name-match fallback still works.
  it('(a) resolves email for a registered user from a used=true name-matching invite', async () => {
    profilesResult = {
      data: [profileRow({ id: 'p-bob', name: 'Bob', role: 'admin' })],
      error: null,
    };
    invitationsResult = {
      data: [inviteRow({ id: 'inv-bob', name: 'Bob', email: 'bob@example.com', used: true, profile_id: SENTINEL })],
      error: null,
    };

    const result = await fetchBrandAdmins(BRAND);

    const bob = result.find((u: User) => u.id === 'p-bob')!;
    expect(bob).toBeDefined();
    expect(bob.email).toBe('bob@example.com'); // not '' → bug fixed
    expect(bob.status).toBe('active');
    // No phantom pending row — the used invite for an active user is excluded.
    expect(result).toHaveLength(1);
    expect(result.some((u) => u.status === 'pending')).toBe(false);
  });

  // (b) id-match precedence over name-match: two active profiles share the
  // display name "Sam"; each invite carries a DISTINCT profile_id matching its
  // own profile. Each profile must get ITS OWN email, not the other's — proves
  // the inviteByProfileId ?? inviteByName ordering with B populating profile_id.
  it('(b) id-match wins over name-match when two profiles share a display name', async () => {
    profilesResult = {
      data: [
        profileRow({ id: 'p-sam1', name: 'Sam', role: 'admin' }),
        profileRow({ id: 'p-sam2', name: 'Sam', role: 'manager' }),
      ],
      error: null,
    };
    invitationsResult = {
      data: [
        inviteRow({ id: 'inv-s1', name: 'Sam', email: 'sam1@example.com', used: true, profile_id: 'p-sam1' }),
        inviteRow({ id: 'inv-s2', name: 'Sam', email: 'sam2@example.com', used: true, profile_id: 'p-sam2' }),
      ],
      error: null,
    };

    const result = await fetchBrandAdmins(BRAND);

    const sam1 = result.find((u: User) => u.id === 'p-sam1')!;
    const sam2 = result.find((u: User) => u.id === 'p-sam2')!;
    expect(sam1.email).toBe('sam1@example.com');
    expect(sam2.email).toBe('sam2@example.com'); // NOT swapped to sam1's
    expect(result).toHaveLength(2); // both active, no pending phantoms
  });

  // (c) an UNCONSUMED invite still yields exactly one pending row, while a
  // used=true invite for an already-active user does NOT duplicate (AC #4/#5).
  it('(c) unconsumed invite → one pending row; consumed invite for an active user → no duplicate', async () => {
    profilesResult = {
      data: [profileRow({ id: 'p-amy', name: 'Amy', role: 'admin' })],
      error: null,
    };
    invitationsResult = {
      data: [
        // consumed invite for the active user Amy → inference source, NOT a pending row
        inviteRow({ id: 'inv-amy', name: 'Amy', email: 'amy@example.com', used: true, profile_id: 'p-amy' }),
        // genuinely outstanding invite for someone who hasn't registered
        inviteRow({ id: 'inv-zoe', name: 'Zoe', email: 'zoe@example.com', used: false, profile_id: SENTINEL }),
      ],
      error: null,
    };

    const result = await fetchBrandAdmins(BRAND);

    const pendings = result.filter((u: User) => u.status === 'pending');
    expect(pendings).toHaveLength(1);
    expect(pendings[0].email).toBe('zoe@example.com');
    expect(pendings[0].id).toBe('invitation:inv-zoe');
    // Amy is active with her resolved email; no phantom pending Amy row.
    const amy = result.find((u: User) => u.id === 'p-amy')!;
    expect(amy.email).toBe('amy@example.com');
    expect(result).toHaveLength(2); // 1 active (Amy) + 1 pending (Zoe)
  });

  // (d) legacy/unbackfillable path: a used=true invite whose profile_id is
  // STILL the sentinel but whose name matches an active profile resolves by
  // the name fallback (proves name-match survives for rows the backfill could
  // not link).
  it('(d) used invite with sentinel profile_id resolves by name fallback', async () => {
    profilesResult = {
      data: [profileRow({ id: 'p-meg', name: 'Meg', role: 'manager' })],
      error: null,
    };
    invitationsResult = {
      data: [inviteRow({ id: 'inv-meg', name: 'Meg', email: 'meg@example.com', used: true, profile_id: SENTINEL })],
      error: null,
    };

    const result = await fetchBrandAdmins(BRAND);

    const meg = result.find((u: User) => u.id === 'p-meg')!;
    expect(meg.email).toBe('meg@example.com'); // resolved via inviteByName
    expect(result).toHaveLength(1);
  });
});

// Spec 084 — the NULL-brand email-inference fix + the pending-row pollution
// guard. Edit 1 dropped the `.eq('brand_id', brandId)` from the invitations
// query so inference sees ALL invites (the symmetric blind spot to spec 083);
// Edit 2 re-applied a STRICT `inv.brand_id === brandId` gate to the
// pendingInvites construction so a NULL-brand (or foreign-brand) UNCONSUMED
// invite never leaks in as a phantom pending row.
//
// NOTE on the harness: makeBuilder's `eq` IGNORES its arguments (it always
// returns `this`), so dropping the query's `.eq('brand_id', …)` is transparent
// to the mock — these arms exercise the JS-side `pendingInvites` predicate and
// the inviteByProfileId/inviteByName maps, which is exactly the changed logic.
describe('fetchBrandAdmins — spec 084 NULL-brand inference + pending pollution guard', () => {
  const OTHER_BRAND = 'brand-2';

  // (e) A NULL-brand invite matched by profile_id resolves a NON-EMPTY email
  // for the active profile when a brandId is passed (AC #1, the symmetric fix).
  // In PRODUCTION the old `.eq('brand_id', BRAND)` query would have excluded the
  // brand_id:null invite → empty email; under the harness `eq` ignores its args
  // (see the NOTE above), so this arm verifies the inference CONTRACT
  // (inviteByProfileId resolves the email) rather than detecting the brand-drop
  // regression itself — arm (f) is the true regression-detector. The invite is
  // used=true AND NULL-brand, so it must NOT produce a phantom pending row either.
  it('(e) NULL-brand invite matched by profile_id feeds inference (non-empty email)', async () => {
    profilesResult = {
      data: [profileRow({ id: 'p-nina', name: 'Nina', role: 'admin', brand_id: BRAND })],
      error: null,
    };
    invitationsResult = {
      data: [inviteRow({ id: 'inv-nina', name: 'Nina', email: 'nina@example.com', used: true, profile_id: 'p-nina', brand_id: null })],
      error: null,
    };

    const result = await fetchBrandAdmins(BRAND);

    const nina = result.find((u: User) => u.id === 'p-nina')!;
    expect(nina).toBeDefined();
    expect(nina.email).toBe('nina@example.com'); // resolved via inviteByProfileId despite brand_id:null
    expect(result).toHaveLength(1);
    expect(result.some((u) => u.status === 'pending')).toBe(false);
  });

  // (f) THE POLLUTION GUARD (AC #2, load-bearing): a NULL-brand UNCONSUMED
  // invite produces NO pending row in BRAND. Strict equality means
  // `null === BRAND` is false, so the row is gated out. Ann (active) is the
  // only row that survives. This is the regression the naive `.eq`-drop would
  // introduce.
  it('(f) NULL-brand UNCONSUMED invite produces no pending row (pollution guard)', async () => {
    profilesResult = {
      data: [profileRow({ id: 'p-ann', name: 'Ann', role: 'admin', brand_id: BRAND })],
      error: null,
    };
    invitationsResult = {
      data: [inviteRow({ id: 'inv-ghost', name: 'Ghost', email: 'ghost@example.com', used: false, profile_id: SENTINEL, brand_id: null })],
      error: null,
    };

    const result = await fetchBrandAdmins(BRAND);

    const pendings = result.filter((u: User) => u.status === 'pending');
    expect(pendings).toHaveLength(0);
    expect(result.every((u) => u.id !== 'invitation:inv-ghost')).toBe(true);
    // Ann is still the lone active row.
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-ann');
  });

  // (f-bis) A FOREIGN-brand UNCONSUMED invite also yields no pending row in
  // BRAND — proves the gate is true strict equality, not a NULL-special-case.
  it('(f-bis) foreign-brand UNCONSUMED invite produces no pending row (strict equality)', async () => {
    profilesResult = {
      data: [profileRow({ id: 'p-ann', name: 'Ann', role: 'admin', brand_id: BRAND })],
      error: null,
    };
    invitationsResult = {
      data: [inviteRow({ id: 'inv-foreign', name: 'Foreigner', email: 'foreign@example.com', used: false, profile_id: SENTINEL, brand_id: OTHER_BRAND })],
      error: null,
    };

    const result = await fetchBrandAdmins(BRAND);

    const pendings = result.filter((u: User) => u.status === 'pending');
    expect(pendings).toHaveLength(0);
    expect(result.every((u) => u.id !== 'invitation:inv-foreign')).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-ann');
  });

  // (g) An in-brand UNCONSUMED invite (brand_id === BRAND) still yields exactly
  // one pending row (AC #3). The gate TIGHTENS NULL/foreign without dropping
  // legitimate in-brand pendings.
  it('(g) in-brand UNCONSUMED invite still yields exactly one pending row', async () => {
    profilesResult = { data: [], error: null };
    invitationsResult = {
      data: [inviteRow({ id: 'inv-pat', name: 'Pat', email: 'pat@example.com', used: false, profile_id: SENTINEL, brand_id: BRAND })],
      error: null,
    };

    const result = await fetchBrandAdmins(BRAND);

    const pendings = result.filter((u: User) => u.status === 'pending');
    expect(pendings).toHaveLength(1);
    expect(pendings[0].id).toBe('invitation:inv-pat');
    expect(pendings[0].email).toBe('pat@example.com');
  });
});
