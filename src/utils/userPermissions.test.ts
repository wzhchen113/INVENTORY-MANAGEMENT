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

import { canDeleteUser, deriveLastOfRole } from './userPermissions';

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
