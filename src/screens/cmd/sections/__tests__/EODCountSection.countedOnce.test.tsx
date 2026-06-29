// src/screens/cmd/sections/__tests__/EODCountSection.countedOnce.test.ts
//
// Spec 102 (AC-D / AC-I) — the COUNTED-ONCE-GLOBALLY gate logic for the admin
// EOD count. A shared item (linked to ≥2 vendors) appears under each vendor tab
// but has a SINGLE shared on-hand, so counting it once must read as counted in
// EVERY tab it appears in — it must NOT show as an outstanding gap (nor red,
// nor jumped-to) under another tab. The gate's predicate is
// `deriveCountedItemIds(...)`, exercised here at the unit level.
//
// Boundary mocking: EODCountSection.tsx transitively imports `../../../lib/db`,
// which imports `../../../lib/supabase` — the client crashes at module load
// when EXPO_PUBLIC_SUPABASE_* env vars are unset (jest has no .env). Stub the
// supabase module so the importable surface loads; the pure function under test
// touches none of it. Same pattern as IngredientForm.test.ts.
//
// File is `.test.tsx` (not `.test.ts`) so the jsdom `component` jest project's
// `src/screens/**/*.test.tsx` testMatch picks it up — it imports a helper from
// a `.tsx` module (EODCountSection) which transitively pulls in react-native,
// so it needs the jsdom env, not the fast node `unit` project. No JSX in the
// file itself; the extension is purely for the testMatch.

jest.mock('../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

import { deriveCountedItemIds } from '../EODCountSection';

const STORE = 'store-1';
const DATE = '2026-06-29';
const VENDOR_A = 'vendor-a';
const VENDOR_B = 'vendor-b';
const SHARED = 'item-shared';
const ONLY_A = 'item-a';
const ONLY_B = 'item-b';

describe('deriveCountedItemIds (spec 102 §6c — counted-once-globally)', () => {
  it('returns an empty set when nothing is entered or submitted', () => {
    const counted = deriveCountedItemIds({
      caseCountsByVendor: {},
      unitCountsByVendor: {},
      submissions: [],
      storeId: STORE,
      dateIso: DATE,
    });
    expect(counted.size).toBe(0);
  });

  it('credits an item counted via a UNIT entry under ANY vendor tab', () => {
    // Shared item typed under vendor A's tab only.
    const counted = deriveCountedItemIds({
      caseCountsByVendor: {},
      unitCountsByVendor: { [VENDOR_A]: { [SHARED]: '12' } },
      submissions: [],
      storeId: STORE,
      dateIso: DATE,
    });
    expect(counted.has(SHARED)).toBe(true);
  });

  it('credits an item counted via a CASE entry under any vendor tab', () => {
    const counted = deriveCountedItemIds({
      caseCountsByVendor: { [VENDOR_A]: { [SHARED]: '2' } },
      unitCountsByVendor: {},
      submissions: [],
      storeId: STORE,
      dateIso: DATE,
    });
    expect(counted.has(SHARED)).toBe(true);
  });

  it('THE KEY CASE: a shared item counted under vendor A reads as counted from vendor B\'s perspective', () => {
    // Counted under A's tab; the gate for B's tab ORs this set, so SHARED is
    // not an outstanding gap when the user switches to B.
    const counted = deriveCountedItemIds({
      caseCountsByVendor: {},
      unitCountsByVendor: { [VENDOR_A]: { [SHARED]: '12' } },
      submissions: [],
      storeId: STORE,
      dateIso: DATE,
    });
    // From B's perspective: SHARED is in the global counted set → not a gap.
    expect(counted.has(SHARED)).toBe(true);
    // ONLY_B (B-exclusive, uncounted) is NOT credited.
    expect(counted.has(ONLY_B)).toBe(false);
  });

  it('treats a blank / whitespace-only entry as NOT counted', () => {
    const counted = deriveCountedItemIds({
      caseCountsByVendor: { [VENDOR_A]: { [SHARED]: '   ' } },
      unitCountsByVendor: { [VENDOR_A]: { [ONLY_A]: '' } },
      submissions: [],
      storeId: STORE,
      dateIso: DATE,
    });
    expect(counted.has(SHARED)).toBe(false);
    expect(counted.has(ONLY_A)).toBe(false);
  });

  it('credits items from an already-submitted submission for this (store, date)', () => {
    const counted = deriveCountedItemIds({
      caseCountsByVendor: {},
      unitCountsByVendor: {},
      submissions: [
        {
          storeId: STORE,
          date: DATE,
          status: 'submitted',
          entries: [{ itemId: SHARED }, { itemId: ONLY_A }],
        },
      ],
      storeId: STORE,
      dateIso: DATE,
    });
    expect(counted.has(SHARED)).toBe(true);
    expect(counted.has(ONLY_A)).toBe(true);
  });

  it('ignores submissions for a DIFFERENT store or date', () => {
    const counted = deriveCountedItemIds({
      caseCountsByVendor: {},
      unitCountsByVendor: {},
      submissions: [
        { storeId: 'other-store', date: DATE, status: 'submitted', entries: [{ itemId: SHARED }] },
        { storeId: STORE, date: '2026-06-28', status: 'submitted', entries: [{ itemId: ONLY_A }] },
      ],
      storeId: STORE,
      dateIso: DATE,
    });
    expect(counted.size).toBe(0);
  });

  it('unions local entries across MULTIPLE vendor tabs + submissions', () => {
    const counted = deriveCountedItemIds({
      caseCountsByVendor: { [VENDOR_B]: { [ONLY_B]: '1' } },
      unitCountsByVendor: { [VENDOR_A]: { [SHARED]: '5' } },
      submissions: [
        { storeId: STORE, date: DATE, status: 'submitted', entries: [{ itemId: ONLY_A }] },
      ],
      storeId: STORE,
      dateIso: DATE,
    });
    expect(counted.has(SHARED)).toBe(true);
    expect(counted.has(ONLY_A)).toBe(true);
    expect(counted.has(ONLY_B)).toBe(true);
    expect(counted.size).toBe(3);
  });

  it('counts a DRAFT submission too (a recorded count of the shared on-hand)', () => {
    const counted = deriveCountedItemIds({
      caseCountsByVendor: {},
      unitCountsByVendor: {},
      submissions: [
        { storeId: STORE, date: DATE, status: 'draft', entries: [{ itemId: SHARED }] },
      ],
      storeId: STORE,
      dateIso: DATE,
    });
    expect(counted.has(SHARED)).toBe(true);
  });
});
