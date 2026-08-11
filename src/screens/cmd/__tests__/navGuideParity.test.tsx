// src/screens/cmd/__tests__/navGuideParity.test.tsx — Spec 158, AC-3.
//
// PATH NOTE (§0 C-1): the spec originally put this at
// `src/lib/cmdSelectors.guide.test.tsx`, which matches NO jest project — the
// node project matches `src/lib/**/*.test.ts` (not `.tsx`) and the jsdom
// project matches only `src/components/**` and `src/screens/**`. The file
// would have sat on disk looking like coverage while never executing. It lives
// here instead, where `src/screens/**/*.test.tsx` picks it up. Verify with
// `npx jest --listTests | grep -i navGuide`.
//
// Layer 2 of the drift guard. The compiler (layer 1) forces every sidebar item
// id to be an `AdminSectionId`, and the guide registry's
// `Record<Exclude<AdminSectionId, GuideExemptSectionId>, GuideTopic>` forces a
// topic to exist for each. What the compiler structurally CANNOT see is the
// ROLE GATE: a topic whose `gate` drifted from the sidebar's own visibility
// rule compiles fine and silently shows "Users & access" documentation to a
// non-master. That is what this suite pins.

// `useDefaultSidebarGroups` is a hook, so it needs a render — but nothing in
// this file needs real chrome. Mock the theme + catalog boundaries only.
jest.mock('../../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

// The two role gates the selector reads. Driven per-test.
let mockIsMaster = false;
let mockIsSuperAdmin = false;
jest.mock('../../../hooks/useRole', () => ({
  useIsMaster: () => mockIsMaster,
  useIsSuperAdmin: () => mockIsSuperAdmin,
}));

// The selector module also exports store-reading selectors; the store itself is
// never touched by `useDefaultSidebarGroups`, but the module imports it.
jest.mock('../../../store/useStore', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({}),
}));

import { renderHook } from '@testing-library/react-native';
import { useDefaultSidebarGroups } from '../../../lib/cmdSelectors';
import { ADMIN_SECTION_IDS } from '../../../lib/adminSections';
import { findGuideTopic, guideTopics } from '../../../lib/guide';

type Role = 'admin' | 'master' | 'super_admin';

function renderSidebarIds(role: Role): string[] {
  mockIsMaster = role === 'master' || role === 'super_admin';
  mockIsSuperAdmin = role === 'super_admin';
  const { result } = renderHook(() => useDefaultSidebarGroups());
  return result.current.flatMap((g) => g.items.map((it) => it.id));
}

beforeEach(() => {
  mockIsMaster = false;
  mockIsSuperAdmin = false;
});

describe('AC-3 — nav ↔ guide parity across the three admin roles', () => {
  const ROLES: Role[] = ['admin', 'master', 'super_admin'];

  for (const role of ROLES) {
    it(`every sidebar item a ${role} sees (except Guide) has a topic`, () => {
      const missing = renderSidebarIds(role)
        .filter((id) => id !== 'Guide')
        .filter((id) => findGuideTopic('admin', id) === null);
      expect({ role, missing }).toEqual({ role, missing: [] });
    });

    it(`every topic gate is consistent with the ${role} visibility it rendered under`, () => {
      const ids = renderSidebarIds(role).filter((id) => id !== 'Guide');
      const isMaster = role === 'master' || role === 'super_admin';
      const isSuperAdmin = role === 'super_admin';
      const inconsistent = ids.filter((id) => {
        const gate = findGuideTopic('admin', id)?.gate ?? null;
        if (gate === 'master') return !isMaster;
        if (gate === 'superAdmin') return !isSuperAdmin;
        return false;
      });
      expect({ role, inconsistent }).toEqual({ role, inconsistent: [] });
    });
  }

  it('the reverse direction too: every ungated DESTINATION topic is in the plain-admin sidebar', () => {
    // Catches a topic left at `gate: null` for a section the sidebar actually
    // gates — the drift the compiler cannot see, in the other direction.
    //
    // Standalone topics (OQ-1's overview) are exempt BY DEFINITION: they
    // document the operation rather than a page, so they have no sidebar id.
    // The exemption keys off `ADMIN_SECTION_IDS` rather than the group name, so
    // it stays exact if a future standalone topic uses a different group.
    const sectionIds = new Set<string>(ADMIN_SECTION_IDS);
    const plainAdminIds = new Set(renderSidebarIds('admin'));
    const orphans = guideTopics('admin')
      .filter((t) => t.gate === null && sectionIds.has(t.id))
      .map((t) => t.id)
      .filter((id) => !plainAdminIds.has(id));
    expect(orphans).toEqual([]);
  });

  it('every standalone topic is deliberately absent from the sidebar', () => {
    const sectionIds = new Set<string>(ADMIN_SECTION_IDS);
    const standalone = guideTopics('admin').filter((t) => !sectionIds.has(t.id));
    expect(standalone.map((t) => t.id)).toEqual(['Overview']);
    const everyId = new Set(renderSidebarIds('super_admin'));
    for (const t of standalone) expect(everyId.has(t.id)).toBe(false);
  });

  it('the master-gated topic appears exactly when the Admin group does', () => {
    expect(renderSidebarIds('admin')).not.toContain('Users');
    expect(renderSidebarIds('master')).toContain('Users');
    expect(renderSidebarIds('super_admin')).toContain('Users');
    expect(findGuideTopic('admin', 'Users')?.gate).toBe('master');
  });

  it('the super-admin-gated topic appears exactly when the Tenancy group does', () => {
    expect(renderSidebarIds('admin')).not.toContain('Brands');
    expect(renderSidebarIds('master')).not.toContain('Brands');
    expect(renderSidebarIds('super_admin')).toContain('Brands');
    expect(findGuideTopic('admin', 'Brands')?.gate).toBe('superAdmin');
  });
});

describe('AC-4 — the Guide sidebar item', () => {
  const ROLES: Role[] = ['admin', 'master', 'super_admin'];

  for (const role of ROLES) {
    it(`a ${role} sees the Guide item exactly once, last`, () => {
      const ids = renderSidebarIds(role);
      expect(ids.filter((id) => id === 'Guide')).toHaveLength(1);
      expect(ids[ids.length - 1]).toBe('Guide');
    });
  }

  it('lives in its own always-visible HELP group, appended after Tenancy', () => {
    mockIsMaster = true;
    mockIsSuperAdmin = true;
    const { result } = renderHook(() => useDefaultSidebarGroups());
    const labels = result.current.map((g) => g.label);
    expect(labels).toEqual([
      'sidebar.groups.operations',
      'sidebar.groups.planning',
      'sidebar.groups.insights',
      'sidebar.groups.admin',
      'sidebar.groups.tenancy',
      'sidebar.groups.help',
    ]);
    expect(result.current[result.current.length - 1].items).toEqual([
      { id: 'Guide', label: 'sidebar.items.guide' },
    ]);
  });

  it('AC-REG1: the pre-existing groups are behaviorally unchanged', () => {
    // The `NavItem` annotation in cmdSelectors is type-only; the rendered ids
    // and their order must be byte-identical to before spec 158 (modulo the
    // appended HELP group).
    expect(renderSidebarIds('admin')).toEqual([
      'Inventory', 'Dashboard', 'EODCount', 'InventoryCount', 'WasteLog',
      'Ordering', 'Vendors', 'Recipes', 'PrepRecipes',
      'MenuImpact', 'Reconciliation', 'POSImports', 'AuditLog', 'Reports', 'DBInspector',
      'Guide',
    ]);
  });
});
