// src/lib/guide.ts — Spec 158. The in-app Guide's pure content model.
//
// Same split that `installGuide.ts` already proved (spec 153): a PURE,
// catalog-agnostic registry that jest exercises in the fast `node` project,
// returning catalog-RELATIVE key suffixes so the admin catalog
// (`src/i18n/*.json`) and the staff catalog (`src/screens/staff/i18n/*.json`)
// stay two independent trees (the spec-063 contract) over ONE model.
//
// Hard constraints (backend design §5) — this module:
//   - imports NO store (`useStore` / `useStaffStore`) — ever;
//   - imports NOTHING from a `.tsx` file;
//   - imports NOTHING from `react-native` (it needs none, not even Platform);
//   - imports `AdminSectionId` from `adminSections.ts` as `import type`, so the
//     runtime module graph gains no edge at all;
//   - registers no listener and reads no global.
// Those five properties are exactly what make it spec-063-legal for the staff
// subtree to import.
//
// Drift prevention lives here, in three layers (§6):
//   1. COMPILE-TIME. `ADMIN_SECTION_TOPICS` is
//      `Record<Exclude<AdminSectionId, GuideExemptSectionId>, GuideTopic>`, and
//      `cmdSelectors.ts` forces its sidebar item ids to `AdminSectionId` via a
//      local `NavItem` type. A new sidebar destination therefore fails
//      compilation until a topic exists for it.
//   2. NAV PARITY TEST (`src/screens/cmd/__tests__/navGuideParity.test.tsx`) —
//      catches what the compiler structurally cannot: a topic whose `gate`
//      drifted from the sidebar's own role gate.
//   3. i18n PARITY (`src/lib/guide.i18n.test.ts` + the two existing catalog
//      parity suites) — catches a topic that would render a raw dot-path.

import type { AdminSectionId } from './adminSections';

export type GuideAudience = 'admin' | 'staff';

/** Role gate mirroring the sidebar's own gates. `null` = visible to every
 *  admin role. NOTE (§2): this is PRESENTATION gating, not authorization —
 *  the real gate is `auth_is_privileged()` on the DB side. */
export type GuideGate = null | 'master' | 'superAdmin';

/** Index grouping — mirrors the sidebar groups so the Guide reads in the same
 *  order as the nav, plus `'overview'`: the group for topics that describe the
 *  operation as a whole rather than one sidebar destination. Shipped reserved
 *  (unused) in the first pass and filled by OQ-1's "how a normal day flows"
 *  topic, owner-approved 2026-08-10 — exactly the one-entry change the reserved
 *  member was designed to make possible. */
export type GuideGroup =
  | 'overview'
  | 'operations'
  | 'planning'
  | 'insights'
  | 'admin'
  | 'tenancy'
  | 'staff';

export interface GuideTopic {
  /** Admin: identical to the shell's section id (that identity is
   *  load-bearing — it is what makes the `?` a one-line lookup).
   *  Staff: the route/screen name. */
  id: string;
  audience: GuideAudience;
  gate: GuideGate;
  group: GuideGroup;
  /** Catalog-RELATIVE key root, e.g. 'topics.inventory'. Each surface
   *  prefixes it with its own catalog root (`guide.`). */
  key: string;
  /** How many "key actions" bullets this topic has (1-4). */
  actions: number;
}

/** Sections that are deliberately undocumented. Naming the exemption as its
 *  own type makes adding one a deliberate, reviewable edit rather than an
 *  inline `Exclude<..., 'Foo' | 'Bar'>` nobody notices (§0 C-3). `Guide`
 *  itself is exempt: documenting the documentation is circular. */
export type GuideExemptSectionId = 'Guide';

type DocumentedSectionId = Exclude<AdminSectionId, GuideExemptSectionId>;

// ── Admin registry ───────────────────────────────────────────────────
//
// THE compile-time drift gate. Adding a member to `ADMIN_SECTION_IDS`
// without adding a topic here fails `npx tsc --noEmit` and
// `npm run typecheck:test`.
const ADMIN_SECTION_TOPICS: Record<DocumentedSectionId, GuideTopic> = {
  Inventory: {
    id: 'Inventory', audience: 'admin', gate: null,
    group: 'operations', key: 'topics.inventory', actions: 3,
  },
  Dashboard: {
    id: 'Dashboard', audience: 'admin', gate: null,
    group: 'operations', key: 'topics.dashboard', actions: 2,
  },
  EODCount: {
    id: 'EODCount', audience: 'admin', gate: null,
    group: 'operations', key: 'topics.eodCount', actions: 3,
  },
  InventoryCount: {
    id: 'InventoryCount', audience: 'admin', gate: null,
    group: 'operations', key: 'topics.inventoryCount', actions: 3,
  },
  WasteLog: {
    id: 'WasteLog', audience: 'admin', gate: null,
    group: 'operations', key: 'topics.wasteLog', actions: 2,
  },
  Ordering: {
    id: 'Ordering', audience: 'admin', gate: null,
    group: 'planning', key: 'topics.ordering', actions: 3,
  },
  Vendors: {
    id: 'Vendors', audience: 'admin', gate: null,
    group: 'planning', key: 'topics.vendors', actions: 3,
  },
  Recipes: {
    id: 'Recipes', audience: 'admin', gate: null,
    group: 'planning', key: 'topics.recipes', actions: 3,
  },
  PrepRecipes: {
    id: 'PrepRecipes', audience: 'admin', gate: null,
    group: 'planning', key: 'topics.prepRecipes', actions: 3,
  },
  MenuImpact: {
    id: 'MenuImpact', audience: 'admin', gate: null,
    group: 'insights', key: 'topics.menuImpact', actions: 2,
  },
  Reconciliation: {
    id: 'Reconciliation', audience: 'admin', gate: null,
    group: 'insights', key: 'topics.reconciliation', actions: 3,
  },
  POSImports: {
    id: 'POSImports', audience: 'admin', gate: null,
    group: 'insights', key: 'topics.posImports', actions: 3,
  },
  AuditLog: {
    id: 'AuditLog', audience: 'admin', gate: null,
    group: 'insights', key: 'topics.auditLog', actions: 2,
  },
  Reports: {
    id: 'Reports', audience: 'admin', gate: null,
    group: 'insights', key: 'topics.reports', actions: 2,
  },
  DBInspector: {
    id: 'DBInspector', audience: 'admin', gate: null,
    group: 'insights', key: 'topics.dbInspector', actions: 2,
  },
  Users: {
    id: 'Users', audience: 'admin', gate: 'master',
    group: 'admin', key: 'topics.users', actions: 3,
  },
  Brands: {
    id: 'Brands', audience: 'admin', gate: 'superAdmin',
    group: 'tenancy', key: 'topics.brands', actions: 2,
  },
};

/**
 * Topics with NO sidebar destination — they describe the operation as a whole.
 * `guideTopics('admin')` puts these FIRST, which is why the overview reads at
 * the top of the index (the reserved group's design position).
 *
 * OQ-1, owner-approved 2026-08-10: the "how a normal day flows" topic. It is
 * NOT documenting a page, so it has no sidebar id and is exempt from the
 * nav-parity test's reverse direction (which keys off `ADMIN_SECTION_IDS`).
 */
const ADMIN_STANDALONE_TOPICS: readonly GuideTopic[] = [
  {
    id: 'Overview', audience: 'admin', gate: null,
    group: 'overview', key: 'topics.overview', actions: 4,
  },
];

/**
 * The order the admin index renders in: standalone topics first (reserved),
 * then the sidebar destinations in `ADMIN_SECTION_IDS` order minus the exempt
 * ids.
 *
 * Derived from the registry's own key order rather than by importing
 * `ADMIN_SECTION_IDS` at runtime, because §11 requires the `adminSections`
 * import to stay `import type` (so the module is erased and never enters the
 * staff bundle). The literal above is therefore written in `ADMIN_SECTION_IDS`
 * order deliberately, and `src/lib/guide.test.ts` pins the resulting id array
 * against `ADMIN_SECTION_IDS` minus the exempt ids so the two cannot drift.
 */
const ADMIN_SECTION_ORDER: readonly DocumentedSectionId[] = (
  Object.keys(ADMIN_SECTION_TOPICS) as DocumentedSectionId[]
);

// ── Staff registry ───────────────────────────────────────────────────
//
// A different array, by construction — admin topics are structurally
// unreachable from the staff surface (AC-15), not filtered out at runtime.
const STAFF_TOPICS: readonly GuideTopic[] = [
  // OQ-1's staff twin (owner-approved 2026-08-10), first in the index. The
  // design's ruling says "push a GuideTopic with group: 'overview' into
  // ADMIN_STANDALONE_TOPICS (and the staff twin)" — staff are the day-one
  // audience this topic exists for. No `HelpButton` points at it: it documents
  // the rhythm, not a screen.
  {
    id: 'Overview', audience: 'staff', gate: null,
    group: 'overview', key: 'topics.overview', actions: 4,
  },
  {
    id: 'EODCount', audience: 'staff', gate: null,
    group: 'staff', key: 'topics.eodCount', actions: 3,
  },
  {
    id: 'Reorder', audience: 'staff', gate: null,
    group: 'staff', key: 'topics.reorder', actions: 2,
  },
  {
    id: 'WeeklyCount', audience: 'staff', gate: null,
    group: 'staff', key: 'topics.weeklyCount', actions: 3,
  },
  {
    id: 'StorePicker', audience: 'staff', gate: null,
    group: 'staff', key: 'topics.storePicker', actions: 2,
  },
  {
    id: 'Settings', audience: 'staff', gate: null,
    group: 'staff', key: 'topics.settings', actions: 3,
  },
];

// ── Public API ───────────────────────────────────────────────────────

/** Every topic for one surface, in index order. A fresh array each call —
 *  memoize with `useMemo` in the views (the cost is a ≤17-element alloc). */
export function guideTopics(audience: GuideAudience): GuideTopic[] {
  if (audience === 'staff') return [...STAFF_TOPICS];
  return [
    ...ADMIN_STANDALONE_TOPICS,
    ...ADMIN_SECTION_ORDER.map((id) => ADMIN_SECTION_TOPICS[id]),
  ];
}

/**
 * Topic lookup by id. Returns `null` for an unknown id — every consumer falls
 * back to the index and NEVER throws. That is the deep-link-safety contract
 * for both surfaces (a staff `topicId` route param is caller-controlled).
 */
export function findGuideTopic(
  audience: GuideAudience,
  id: string | null | undefined,
): GuideTopic | null {
  if (!id) return null;
  for (const topic of guideTopics(audience)) {
    if (topic.id === id) return topic;
  }
  return null;
}

/**
 * Role-filtered topics for one surface, using the SAME two gates the sidebar
 * uses (`useIsMaster()` / `useIsSuperAdmin()`), read by the caller and passed
 * in so this module stays hook-free and node-testable.
 *
 * NOT filtered by the user's personal spec-008 sidebar-hide override: a hidden
 * section is still a real page they can unhide, so hiding its documentation
 * would be a dead end.
 *
 * §2 restated: this is presentation parity with the nav, NOT authorization.
 */
export function visibleGuideTopics(
  audience: GuideAudience,
  roles: { isMaster: boolean; isSuperAdmin: boolean },
): GuideTopic[] {
  return guideTopics(audience).filter((topic) => {
    if (topic.gate === 'master') return roles.isMaster;
    if (topic.gate === 'superAdmin') return roles.isSuperAdmin;
    return true;
  });
}

/**
 * Every catalog-relative key a topic renders:
 * `['topics.inventory.title', 'topics.inventory.purpose',
 *   'topics.inventory.actions.1', ...]`. Used by the i18n parity test.
 */
export function guideTopicKeys(topic: GuideTopic): string[] {
  const keys = [`${topic.key}.title`, `${topic.key}.purpose`];
  for (let n = 1; n <= topic.actions; n += 1) {
    keys.push(`${topic.key}.actions.${n}`);
  }
  return keys;
}

/**
 * Catalog-relative chrome keys — the strings the Guide views render that are
 * NOT topic content. Exported so the i18n parity test covers them too (§8
 * R-9): a *consistently* misspelled chrome key is present in all three locales
 * and would sail past the 3-way parity suites while rendering a raw dot-path.
 */
export const GUIDE_CHROME_KEYS: readonly string[] = [
  'title',
  'indexTitle',
  'intro',
  'purposeLabel',
  'actionsLabel',
  'seeAllPages',
  'backToIndex',
  // `back` is the staff Guide screen's return-to-the-caller control (the admin
  // surface uses the sheet's ✕ / the phone drill header instead). It lives in
  // the `guide.` root with the rest of the Guide chrome and ships in both
  // catalogs so this list stays one flat set for the parity test.
  'back',
  'helpAria',
  'groups.overview',
  'groups.operations',
  'groups.planning',
  'groups.insights',
  'groups.admin',
  'groups.tenancy',
  'groups.staff',
];

export type { AdminSectionId };
