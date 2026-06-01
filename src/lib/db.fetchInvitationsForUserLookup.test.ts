// src/lib/db.fetchInvitationsForUserLookup.test.ts — Spec 083 Track 1 (jest).
//
// Unit-tests the spec-083 relaxation of fetchInvitationsForUserLookup (db.ts):
// the brand filter `.eq('brand_id', brandId)` is REMOVED so a NULL-brand
// invitation can no longer be hidden from email inference. fetchAllUsers
// (src/lib/auth.ts) infers each user's email from these rows; a NULL-brand
// invitation matched by profile_id was dropped whenever a brand was scoped,
// rendering "(email not loaded)" (the headline bug). The fix drops the filter.
//
// Mocking strategy (mirrors db.fetchBrandAdmins.test.ts:28-70):
//   - jest.mock('./supabase') — supabase.from('invitations') returns a FRESH
//     chainable builder whose terminal `.abortSignal()` resolves to the
//     per-test invitations result. Every intermediate method returns `this`,
//     and `eq` is a tracked jest.fn so the mechanism arm can assert it was
//     never called with ('brand_id', …).
//   - jest.mock('./inflight') — track(fn) invokes fn directly with a dummy
//     AbortSignal so the real timers never arm in node.
//   - jest.mock('./auth') — db.ts imports callEdgeFunction from it; stub so the
//     import graph stays light. Not exercised here.
//
// Two arms:
//   (a) NULL-brand invitation IS returned even when a brandId is passed (the
//       headline AC for the query relaxation).
//   (b) the builder's `eq` was NOT called with ('brand_id', …) (mechanism pin
//       against a regression re-adding the filter).

const SENTINEL = '00000000-0000-0000-0000-000000000000';
const BRAND = 'brand-1';

let invitationsResult: { data: any[] | null; error: any };

/** The single chainable builder for the invitations read. `eq` is tracked so
 *  the mechanism arm can assert it was never invoked with a brand filter. */
let eqSpy: jest.Mock;

function makeBuilder(result: { data: any[] | null; error: any }) {
  eqSpy = jest.fn().mockReturnThis();
  const builder: any = {
    select: jest.fn().mockReturnThis(),
    eq: eqSpy,
    abortSignal: jest.fn().mockResolvedValue(result),
  };
  return builder;
}

const mockFrom = jest.fn((table: string) => {
  if (table === 'invitations') return makeBuilder(invitationsResult);
  throw new Error(`unexpected table in fetchInvitationsForUserLookup: ${table}`);
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

import { fetchInvitationsForUserLookup } from './db';

/** Minimal invitations row (snake_case, as PostgREST returns). */
function inviteRow(over: Record<string, any>): any {
  return {
    email: 'x@example.com', name: 'Default',
    brand_id: BRAND, profile_id: SENTINEL,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  invitationsResult = { data: [], error: null };
});

describe('fetchInvitationsForUserLookup — spec 083 brand-filter relaxation', () => {
  // (a) THE HEADLINE BUG FIX: a NULL-brand invitation matched by profile_id is
  // still returned even when a brandId is passed. Pre-083, `.eq('brand_id',
  // brandId)` filtered it out (NULL never equals 'brand-1') → email inference
  // missed → "(email not loaded)".
  it('(a) returns a NULL-brand invitation even when a brandId is passed', async () => {
    invitationsResult = {
      data: [
        inviteRow({ name: 'Bobby', email: 'bobby@example.com', brand_id: null, profile_id: 'p-bob' }),
      ],
      error: null,
    };

    const result = await fetchInvitationsForUserLookup(BRAND);

    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('bobby@example.com');
    expect(result[0].brand_id).toBeNull(); // the NULL-brand row survived the query
    expect(result[0].profile_id).toBe('p-bob');
  });

  // (b) MECHANISM PIN: the builder's `eq` must NOT be called with
  // ('brand_id', …). This detects a regression that re-adds the brand filter.
  it('(b) does not apply a brand_id filter on the invitations query', async () => {
    invitationsResult = {
      data: [inviteRow({ name: 'Charles', email: 'charles@example.com', brand_id: null, profile_id: 'p-chuck' })],
      error: null,
    };

    await fetchInvitationsForUserLookup(BRAND);

    expect(mockFrom).toHaveBeenCalledWith('invitations');
    // The relaxation: NO .eq('brand_id', …) is applied. Assert the spy was
    // never invoked with a brand_id filter (it may be unused entirely).
    const brandEqCalls = eqSpy.mock.calls.filter((args) => args[0] === 'brand_id');
    expect(brandEqCalls).toHaveLength(0);
  });
});
