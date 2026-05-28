// src/utils/userPermissions.test.ts
//
// Spec 033 §AC3.3 + §AC3.4 — pure-function coverage for the DELETE-gate
// helpers extracted from `src/screens/cmd/sections/UsersSection.tsx`.
//
// No mocks. The helpers have no collaborators (no React, no Zustand, no
// network) — this is the cleanest possible unit-test shape.
//
// Branch matrix per spec 033 §AC3.3 (canDeleteUser, 11 cases) and
// §AC3.4 (deriveLastOfRole, 5 cases). Total: 16 it() blocks. Each
// canDeleteUser case isolates one conjunction in the lifted boolean
// expression; each deriveLastOfRole case isolates one input-shape
// boundary.

import { canDeleteUser, deriveLastOfRole, deriveAccessibleStores } from './userPermissions';

describe('canDeleteUser', () => {
  // Reusable baseline — every case overrides what it cares about.
  const baseline = {
    isMaster: false,
    isSelf: false,
    targetRole: 'user' as const,
    lastOfRole: { super_admin: false, master: false },
  };

  it('master cannot delete self', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: true,
        isSelf: true,
        targetRole: 'master',
      }),
    ).toBe(false);
  });

  it('master can delete peer non-master row', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: true,
        isSelf: false,
        targetRole: 'user',
      }),
    ).toBe(true);
  });

  it('master can delete peer master row when not last master', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: true,
        isSelf: false,
        targetRole: 'master',
        lastOfRole: { super_admin: false, master: false },
      }),
    ).toBe(true);
  });

  it('master cannot delete peer master row when it is the last master', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: true,
        isSelf: false,
        targetRole: 'master',
        lastOfRole: { super_admin: false, master: true },
      }),
    ).toBe(false);
  });

  it('master can delete peer super_admin row when not last super_admin', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: true,
        isSelf: false,
        targetRole: 'super_admin',
        lastOfRole: { super_admin: false, master: false },
      }),
    ).toBe(true);
  });

  it('master cannot delete peer super_admin row when it is the last super_admin', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: true,
        isSelf: false,
        targetRole: 'super_admin',
        lastOfRole: { super_admin: true, master: false },
      }),
    ).toBe(false);
  });

  it('non-master admin cannot delete self', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: false,
        isSelf: true,
        targetRole: 'admin',
      }),
    ).toBe(false);
  });

  it('non-master admin can delete peer user row', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: false,
        isSelf: false,
        targetRole: 'user',
      }),
    ).toBe(true);
  });

  it('non-master admin cannot delete peer admin row', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: false,
        isSelf: false,
        targetRole: 'admin',
      }),
    ).toBe(false);
  });

  it('non-master admin cannot delete peer master row', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: false,
        isSelf: false,
        targetRole: 'master',
      }),
    ).toBe(false);
  });

  it('non-master admin cannot delete peer super_admin row', () => {
    expect(
      canDeleteUser({
        ...baseline,
        isMaster: false,
        isSelf: false,
        targetRole: 'super_admin',
      }),
    ).toBe(false);
  });
});

describe('deriveLastOfRole', () => {
  it('returns { super_admin: true, master: true } for an empty array (defensive)', () => {
    // Zero of each role — count <= 1 holds — so the helper hides the
    // DELETE button rather than showing it. Matches the existing inline
    // expression's behavior in UsersSection.tsx.
    expect(deriveLastOfRole([])).toEqual({ super_admin: true, master: true });
  });

  it('flags master:false when two masters exist alongside one super_admin', () => {
    const users = [
      { role: 'super_admin' as const },
      { role: 'master' as const },
      { role: 'master' as const },
    ];
    expect(deriveLastOfRole(users)).toEqual({ super_admin: true, master: false });
  });

  it('flags super_admin:false when two super_admins exist alongside one master', () => {
    const users = [
      { role: 'super_admin' as const },
      { role: 'super_admin' as const },
      { role: 'master' as const },
    ];
    expect(deriveLastOfRole(users)).toEqual({ super_admin: false, master: true });
  });

  it('returns both true with zero super_admins and zero masters (five users only)', () => {
    const users = [
      { role: 'user' as const },
      { role: 'user' as const },
      { role: 'user' as const },
      { role: 'user' as const },
      { role: 'user' as const },
    ];
    expect(deriveLastOfRole(users)).toEqual({ super_admin: true, master: true });
  });

  it('counts only rows with the matching role (mixed roles)', () => {
    // Five user rows + two super_admins + zero masters → super_admin:false,
    // master:true. Pins that the counter ignores non-target rows.
    const users = [
      { role: 'user' as const },
      { role: 'user' as const },
      { role: 'user' as const },
      { role: 'user' as const },
      { role: 'user' as const },
      { role: 'super_admin' as const },
      { role: 'super_admin' as const },
    ];
    expect(deriveLastOfRole(users)).toEqual({ super_admin: false, master: true });
  });
});

describe('deriveAccessibleStores', () => {
  // Spec 068 §3 + §12.2. The store-chip access predicate for
  // `UsersSection.tsx` `UserRow`. Mirrors the prod brand→store
  // allocation in the spec problem statement:
  //   - 2AM PROJECT (brand '2a…') → 4 stores: Charles, Frederick,
  //     Reisters, Towson.
  //   - Baltimore Seafood (brand 'e1…') → 1 store: Baltimore Seafood.
  const STORE_2AM = [
    { id: 'charles',   brandId: '2a', name: 'Charles' },
    { id: 'frederick', brandId: '2a', name: 'Frederick' },
    { id: 'reisters',  brandId: '2a', name: 'Reisters' },
    { id: 'towson',    brandId: '2a', name: 'Towson' },
  ];
  const STORE_BSF = [{ id: 'baltimore', brandId: 'e1', name: 'Baltimore Seafood' }];
  // The global store cache a super-admin would have loaded across brands.
  const ALL_STORES = [...STORE_2AM, ...STORE_BSF];

  it('renders ALL stores for a super_admin (sees every brand)', () => {
    // super_admin.brandId is null; a brandId-match filter would wrongly
    // yield an empty list. The whole array is the truthful answer.
    const result = deriveAccessibleStores(
      { role: 'super_admin', brandId: null, stores: [] },
      ALL_STORES,
    );
    expect(result).toEqual(ALL_STORES);
  });

  it("renders the admin's OWN brand stores, not the global list (Bobby's case)", () => {
    // Bobby: admin, brand 2AM ('2a'), literal user_stores grant of just
    // Towson. The fix must show his FOUR 2AM stores (brand-wide access
    // via auth_can_see_store), NOT five (the old all-stores bug) and NOT
    // one (his literal grant), and NEVER Baltimore Seafood.
    const bobby = { role: 'admin' as const, brandId: '2a', stores: ['towson'] };
    const result = deriveAccessibleStores(bobby, ALL_STORES);
    expect(result).toEqual(STORE_2AM);
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.id)).not.toContain('baltimore');
  });

  it("renders the master's OWN brand stores (same brand-wide rule as admin)", () => {
    const result = deriveAccessibleStores(
      { role: 'master', brandId: 'e1', stores: [] },
      ALL_STORES,
    );
    expect(result).toEqual(STORE_BSF);
  });

  it('renders only the literal user_stores grants for a `user` (staff) row', () => {
    // Staff access IS the literal user_stores list — unchanged behavior.
    const result = deriveAccessibleStores(
      { role: 'user', brandId: null, stores: ['towson', 'reisters'] },
      ALL_STORES,
    );
    // sort() so the assertion checks set membership, not allStores-vs-grant
    // iteration order (filter preserves allStores order — an implementation
    // detail this test shouldn't pin).
    expect(result.map((s) => s.id).sort()).toEqual(['reisters', 'towson'].sort());
  });

  it('returns an empty list for a `user` row with no grants', () => {
    const result = deriveAccessibleStores(
      { role: 'user', brandId: null, stores: [] },
      ALL_STORES,
    );
    expect(result).toEqual([]);
  });

  it('returns an empty list for an admin whose brand has no stores in the cache', () => {
    // An admin scoped to a brand with no loaded stores → no chips. This
    // is the correct "no brand-scoped stores" signal, not a fallback to
    // the global list.
    const result = deriveAccessibleStores(
      { role: 'admin', brandId: 'unknown-brand', stores: ['towson'] },
      ALL_STORES,
    );
    expect(result).toEqual([]);
  });
});
