// src/lib/adminSections.ts — Spec 158 §5 (architect addition).
//
// The admin Cmd UI's sidebar-destination id union, in default sidebar order.
//
// Why this lives in its own module rather than inside `guide.ts`: making
// `cmdSelectors.ts` (core navigation) depend on the guide model would invert
// the dependency direction — documentation should depend on the product, never
// the reverse — and a future non-guide consumer of the union (deep links,
// palette routing) would otherwise have to import the docs module to get it.
//
// Deliberate constraints (mirrors `installGuide.ts` / `guide.ts`):
//   - no store import, no `.tsx` import, no `react-native` import;
//   - pure data only, so it is safe in the fast jest `node` project and in the
//     staff bundle's type graph (`guide.ts` imports it `import type`, so no
//     runtime module edge is created at all).
//
// LOAD-BEARING: these strings are simultaneously
//   (a) the spec-008 `profiles.sidebar_layout` override keys,
//   (b) the shell's `section` state values, and
//   (c) the spec-158 guide topic ids.
// Renaming one is a data migration, not a refactor.

/** Every sidebar destination id, in default sidebar order. */
export const ADMIN_SECTION_IDS = [
  // Operations
  'Inventory',
  'Dashboard',
  'EODCount',
  'InventoryCount',
  'WasteLog',
  // Planning
  'Ordering',
  'Vendors',
  'Recipes',
  'PrepRecipes',
  // Insights
  'MenuImpact',
  'Reconciliation',
  'POSImports',
  'AuditLog',
  'Reports',
  'DBInspector',
  // Admin (master-gated)
  'Users',
  // Tenancy (super-admin-gated)
  'Brands',
  // Help (spec 158)
  'Guide',
] as const;

export type AdminSectionId = (typeof ADMIN_SECTION_IDS)[number];
