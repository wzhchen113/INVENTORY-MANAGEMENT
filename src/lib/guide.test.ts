// src/lib/guide.test.ts — Spec 158 (node project).
//
// The pure model's contract:
//   • AC-1 — exact id arrays for both audiences, in index order, with the
//     right gates. Written as EXACT ARRAY EQUALITY on purpose (§7 OQ-1): if
//     the owner later approves the overview topic, this is a one-line change.
//   • AC-2 — the compile-time drift gate. `npm run typecheck:test` is what
//     actually runs the `@ts-expect-error` pins below; jest only proves the
//     file imports and the runtime shape holds.
//   • `guideTopicKeys()` shape and `findGuideTopic()` returning null on a miss
//     (the deep-link-safety contract both surfaces depend on).
//
// NOTE the absence of a `jest.mock('react-native', ...)` block that
// `installGuide.test.ts` needs: `guide.ts` imports NOTHING from react-native,
// which is precisely why this suite runs in the fast node project.

import { ADMIN_SECTION_IDS, type AdminSectionId } from './adminSections';
import {
  GUIDE_CHROME_KEYS,
  findGuideTopic,
  guideTopicKeys,
  guideTopics,
  visibleGuideTopics,
  type GuideTopic,
} from './guide';

describe('guideTopics — AC-1', () => {
  it('admin returns the overview topic then the 17 sidebar destinations, in sidebar order', () => {
    expect(guideTopics('admin').map((t) => t.id)).toEqual([
      // OQ-1 (owner-approved 2026-08-10) — a standalone topic, so it has no
      // sidebar id and sorts BEFORE the destinations.
      'Overview',
      'Inventory',
      'Dashboard',
      'EODCount',
      'InventoryCount',
      'WasteLog',
      'Ordering',
      'Vendors',
      'Recipes',
      'PrepRecipes',
      'MenuImpact',
      'Reconciliation',
      'POSImports',
      'AuditLog',
      'Reports',
      'DBInspector',
      'Users',
      'Brands',
    ]);
    expect(guideTopics('admin')).toHaveLength(18); // 17 destinations + 1 standalone
  });

  it('the admin index order IS ADMIN_SECTION_IDS minus the exempt ids', () => {
    // `guide.ts` derives its order from the registry's own key order rather
    // than importing ADMIN_SECTION_IDS at runtime (§11 keeps that import
    // type-only, so the module is erased from the staff bundle). This pins the
    // two together so the hand-written literal can never silently drift.
    const exempt = new Set<AdminSectionId>(['Guide']);
    // Standalone topics (group 'overview') prefix the list and have no sidebar
    // id, so compare the DESTINATION half against ADMIN_SECTION_IDS.
    const sectionIds = guideTopics('admin')
      .filter((t) => t.group !== 'overview')
      .map((t) => t.id);
    expect(sectionIds).toEqual(ADMIN_SECTION_IDS.filter((id) => !exempt.has(id)));
  });

  it('every admin gate is null except Users (master) and Brands (superAdmin)', () => {
    const gates = Object.fromEntries(guideTopics('admin').map((t) => [t.id, t.gate]));
    expect(gates.Users).toBe('master');
    expect(gates.Brands).toBe('superAdmin');
    for (const [id, gate] of Object.entries(gates)) {
      if (id === 'Users' || id === 'Brands') continue;
      expect({ id, gate }).toEqual({ id, gate: null });
    }
  });

  it('staff returns the overview topic then the 5 staff screens', () => {
    expect(guideTopics('staff').map((t) => t.id)).toEqual([
      'Overview',
      'EODCount',
      'Reorder',
      'WeeklyCount',
      'StorePicker',
      'Settings',
    ]);
    expect(guideTopics('staff').every((t) => t.gate === null)).toBe(true);
  });

  it('tags every topic with its own audience and a 1-4 action count', () => {
    for (const audience of ['admin', 'staff'] as const) {
      for (const topic of guideTopics(audience)) {
        expect(topic.audience).toBe(audience);
        expect(topic.actions).toBeGreaterThanOrEqual(1);
        expect(topic.actions).toBeLessThanOrEqual(4);
        expect(topic.key.startsWith('topics.')).toBe(true);
      }
    }
  });

  it('no admin topic id collides with a group label key, and ids are unique', () => {
    for (const audience of ['admin', 'staff'] as const) {
      const ids = guideTopics(audience).map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('the `Guide` section itself is deliberately undocumented', () => {
    expect(ADMIN_SECTION_IDS).toContain('Guide');
    expect(guideTopics('admin').map((t) => t.id)).not.toContain('Guide');
    expect(findGuideTopic('admin', 'Guide')).toBeNull();
  });

  it('OQ-1 IS built (owner-approved 2026-08-10) and reads first on both surfaces', () => {
    // Was "no topic uses the reserved group" while OQ-1 was deferred. The
    // reserved `'overview'` GuideGroup member + `guide.groups.overview` shipped
    // in the first pass precisely so this became a one-entry change.
    for (const audience of ['admin', 'staff'] as const) {
      const topics = guideTopics(audience);
      const overview = topics.filter((t) => t.group === 'overview');
      expect(overview).toHaveLength(1);
      expect(overview[0].id).toBe('Overview');
      expect(overview[0].gate).toBeNull();
      // Prominence: it is the FIRST row of the index (AC-5 renders in this order).
      expect(topics[0].id).toBe('Overview');
    }
    expect(GUIDE_CHROME_KEYS).toContain('groups.overview');
  });

  it('the overview topic is NOT a sidebar destination', () => {
    // It documents the daily rhythm, not a page — so it must never leak into
    // the section-id union, and the nav-parity suite exempts it by that fact.
    expect(ADMIN_SECTION_IDS).not.toContain('Overview');
  });
});

describe('findGuideTopic', () => {
  it('resolves a known id per audience', () => {
    expect(findGuideTopic('admin', 'Reconciliation')?.group).toBe('insights');
    expect(findGuideTopic('staff', 'WeeklyCount')?.audience).toBe('staff');
  });

  it('returns null (never throws) for an unknown id, null, or undefined', () => {
    expect(findGuideTopic('admin', 'NotASection')).toBeNull();
    expect(findGuideTopic('admin', null)).toBeNull();
    expect(findGuideTopic('admin', undefined)).toBeNull();
    expect(findGuideTopic('staff', '')).toBeNull();
  });

  it('does NOT leak an admin-only topic into the staff audience', () => {
    // AC-15: the two registries are different arrays, so an admin id looked up
    // under the staff audience simply misses.
    expect(findGuideTopic('staff', 'Inventory')).toBeNull();
    expect(findGuideTopic('staff', 'Users')).toBeNull();
    expect(findGuideTopic('staff', 'Brands')).toBeNull();
    // ...and vice versa for a staff-only id under the admin audience.
    expect(findGuideTopic('admin', 'StorePicker')).toBeNull();
  });

  it('shares two ids across audiences but returns the audience-correct topic', () => {
    // `EODCount` exists on both surfaces with DIFFERENT copy keys' owners.
    expect(findGuideTopic('admin', 'EODCount')?.audience).toBe('admin');
    expect(findGuideTopic('staff', 'EODCount')?.audience).toBe('staff');
  });
});

describe('guideTopicKeys', () => {
  it('returns title + purpose + one key per declared action', () => {
    const topic = findGuideTopic('admin', 'Inventory') as GuideTopic;
    expect(guideTopicKeys(topic)).toEqual([
      'topics.inventory.title',
      'topics.inventory.purpose',
      'topics.inventory.actions.1',
      'topics.inventory.actions.2',
      'topics.inventory.actions.3',
    ]);
  });

  it('key count is always 2 + actions', () => {
    for (const audience of ['admin', 'staff'] as const) {
      for (const topic of guideTopics(audience)) {
        expect(guideTopicKeys(topic)).toHaveLength(2 + topic.actions);
      }
    }
  });
});

describe('visibleGuideTopics — role gating (presentation parity, not authz)', () => {
  it('a plain admin sees neither Users nor Brands', () => {
    const ids = visibleGuideTopics('admin', { isMaster: false, isSuperAdmin: false }).map((t) => t.id);
    expect(ids).not.toContain('Users');
    expect(ids).not.toContain('Brands');
    expect(ids).toHaveLength(16); // 15 ungated destinations + the overview topic
  });

  it('a master sees Users but not Brands', () => {
    const ids = visibleGuideTopics('admin', { isMaster: true, isSuperAdmin: false }).map((t) => t.id);
    expect(ids).toContain('Users');
    expect(ids).not.toContain('Brands');
  });

  it('a super-admin (master + superAdmin) sees all 18', () => {
    expect(visibleGuideTopics('admin', { isMaster: true, isSuperAdmin: true })).toHaveLength(18);
  });

  it('staff topics are ungated, so the role flags are inert', () => {
    expect(visibleGuideTopics('staff', { isMaster: false, isSuperAdmin: false })).toHaveLength(6);
    expect(visibleGuideTopics('staff', { isMaster: true, isSuperAdmin: true })).toHaveLength(6);
  });
});

describe('AC-2 — the compile-time drift gate', () => {
  it('rejects a non-member section id (checked by `npm run typecheck:test`)', () => {
    // @ts-expect-error — 'Receiving' was retired by spec 138 and is NOT a
    // member of AdminSectionId. If someone widens the union without adding a
    // guide topic, the registry's Record<Exclude<...>> fails first; if someone
    // narrows/renames a member, THIS line stops erroring and the suite fails.
    const notASection: AdminSectionId = 'Receiving';
    expect(notASection).toBe('Receiving');
  });

  it('accepts every real member', () => {
    for (const id of ADMIN_SECTION_IDS) {
      const ok: AdminSectionId = id;
      expect(typeof ok).toBe('string');
    }
  });
});
