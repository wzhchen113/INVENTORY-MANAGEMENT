// src/lib/storeVisibility.test.ts — Spec 150 (shared store-visibility predicate).
//
// `visibleStoresFor` replaced THREE byte-identical inline copies of the same
// rule (TitleBar's desktop store switcher, PhoneStoreSwitch's phone sheet, and
// the store's own active-brand validation). This suite is the equivalence
// proof: for every role × brand-context × grant combination, the shared helper
// returns exactly what the previous inline logic returned.
//
// `legacyInline` below is a verbatim transcription of the pre-refactor
// expression from TitleBar.tsx (which PhoneStoreSwitch.tsx had copied). Do NOT
// "simplify" it — its whole job is to be the old code.

import { visibleStoresFor, isPrivilegedRole, brandNameFor } from './storeVisibility';
import type { Store, User } from '../types';

/** The pre-spec-150 inline predicate, transcribed unchanged. */
function legacyInline(stores: Store[], currentUser: User | null, currentBrandId: string | null): Store[] {
  const isAdmin =
    currentUser?.role === 'admin' ||
    currentUser?.role === 'master' ||
    currentUser?.role === 'super_admin';
  return (isAdmin
    ? stores
    : stores.filter((s) => currentUser?.stores?.includes(s.id))
  ).filter((s) => currentBrandId === null || s.brandId === currentBrandId);
}

const mk = (id: string, brandId: string): Store => ({
  id, brandId, name: `Store ${id}`, address: '', status: 'active',
});

const STORES: Store[] = [mk('s1', 'b1'), mk('s2', 'b1'), mk('s3', 'b2'), mk('s4', 'b3')];

const ROLES = ['super_admin', 'master', 'admin', 'user'] as const;
const GRANTS: string[][] = [[], ['s1'], ['s3'], ['s1', 's3'], ['s-unknown']];
const BRAND_CONTEXTS: Array<string | null> = [null, 'b1', 'b2', 'b3', 'b-empty'];

function user(role: (typeof ROLES)[number], stores: string[]): User {
  return {
    id: 'u1', name: 'U', email: 'u@x.test', role, stores,
    status: 'active', initials: 'U', color: '#378ADD',
  } as User;
}

describe('visibleStoresFor — equivalence with the pre-spec-150 inline logic', () => {
  it('matches for every role × grants × brand-context combination', () => {
    for (const role of ROLES) {
      for (const grants of GRANTS) {
        for (const brandId of BRAND_CONTEXTS) {
          const u = user(role, grants);
          const label = `${role} / grants=[${grants}] / brand=${brandId}`;
          expect({ label, ids: visibleStoresFor(STORES, u, brandId).map((s) => s.id) })
            .toEqual({ label, ids: legacyInline(STORES, u, brandId).map((s) => s.id) });
        }
      }
    }
  });

  it('matches for a null user and an empty store list', () => {
    for (const brandId of BRAND_CONTEXTS) {
      expect(visibleStoresFor(STORES, null, brandId)).toEqual(legacyInline(STORES, null, brandId));
      expect(visibleStoresFor([], null, brandId)).toEqual(legacyInline([], null, brandId));
    }
  });
});

describe('visibleStoresFor — contract', () => {
  it('privileged roles see every store regardless of grants', () => {
    for (const role of ['admin', 'master', 'super_admin'] as const) {
      expect(visibleStoresFor(STORES, user(role, []), null).map((s) => s.id))
        .toEqual(['s1', 's2', 's3', 's4']);
    }
  });

  it('non-privileged roles see only their grants', () => {
    expect(visibleStoresFor(STORES, user('user', ['s3']), null).map((s) => s.id)).toEqual(['s3']);
    expect(visibleStoresFor(STORES, user('user', []), null)).toEqual([]);
  });

  it('narrows to the active brand, and skips narrowing for "All brands"', () => {
    const su = user('super_admin', []);
    expect(visibleStoresFor(STORES, su, 'b1').map((s) => s.id)).toEqual(['s1', 's2']);
    expect(visibleStoresFor(STORES, su, 'b-empty')).toEqual([]);
    expect(visibleStoresFor(STORES, su, null)).toHaveLength(4);
  });

  it('preserves input order, so [0] is a stable landing pick', () => {
    expect(visibleStoresFor(STORES, user('admin', []), null)[0].id).toBe('s1');
  });

  it('fails closed for an unknown user', () => {
    expect(visibleStoresFor(STORES, null, null)).toEqual([]);
    expect(isPrivilegedRole(null)).toBe(false);
  });
});

// ── brandNameFor (spec 159) ─────────────────────────────────────
//
// The Dashboard's scope label is brand-named (OQ-2) and MUST degrade to a
// generic string rather than render a wrong or blank brand. Every `null`
// path below is a real production state, not a defensive nicety.
describe('brandNameFor', () => {
  const BRANDS = [
    { id: 'b1', name: '2AM PROJECT' },
    { id: 'b2', name: 'BALTIMORE SEAFOOD' },
  ];

  it('resolves from brandsList (the super-admin case: every brand loaded)', () => {
    expect(brandNameFor('b2', null, BRANDS)).toBe('BALTIMORE SEAFOOD');
  });

  it('resolves from the single `brand` slice (the admin/master case: brandsList empty)', () => {
    expect(brandNameFor('b1', { id: 'b1', name: '2AM PROJECT' }, [])).toBe('2AM PROJECT');
  });

  it('prefers `brand` over brandsList — it is the session\'s own, freshly-renamed copy', () => {
    expect(brandNameFor('b1', { id: 'b1', name: 'RENAMED' }, BRANDS)).toBe('RENAMED');
  });

  it('returns null for "All brands" (no brandId), so callers pick their own fallback', () => {
    expect(brandNameFor(null, null, BRANDS)).toBeNull();
    expect(brandNameFor(undefined, null, BRANDS)).toBeNull();
    expect(brandNameFor('', null, BRANDS)).toBeNull();
  });

  it('returns null for an unknown id and for first paint before the slices hydrate', () => {
    expect(brandNameFor('b-unknown', null, BRANDS)).toBeNull();
    expect(brandNameFor('b1', null, [])).toBeNull();
  });

  it('returns null rather than an empty string when the loaded name is blank', () => {
    expect(brandNameFor('b1', { id: 'b1', name: '' }, [{ id: 'b1', name: '' }])).toBeNull();
  });
});
