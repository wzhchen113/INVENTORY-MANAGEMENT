// src/types/index.ts

export type UserRole = 'super_admin' | 'master' | 'admin' | 'user';

export interface User {
  id: string;
  name: string;
  nickname: string;
  email: string;
  role: UserRole;
  stores: string[];
  status: 'active' | 'pending';
  initials: string;
  color: string;
  /**
   * Per-user kill switch for EOD/order reminders. When false, the
   * eod-reminder-cron edge function skips this user for BOTH push AND
   * the Resend email fallback. Toggled from the Profile sidebar.
   * Optional because older sessions may not have loaded it yet —
   * readers should treat `undefined` as "enabled" (default).
   */
  notificationsEnabled?: boolean;
  /**
   * Spec 012b — brand the user is scoped to (mirrors profiles.brand_id
   * post-012a). NULL for super-admin (sees all brands). NULL for legacy
   * 'user' role staff. Set for 'admin' role per
   * profiles_role_brand_consistent CHECK.
   */
  brandId?: string | null;
}

export interface Brand {
  id: string;
  name: string;
  /** Spec 012a — soft-delete tombstone. NULL on active brands. Surfaced
   *  to super-admin Brands list so deleted tenants are visible. */
  deletedAt?: string | null;
  /** Spec 012b — brands list rendering uses this. */
  createdAt?: string | null;
}

/**
 * Brand-level master record for an ingredient. The shared "what we use"
 * across all stores in the chain. Per-store cost / vendor / par / stock
 * lives on InventoryItem, which FKs back via catalogId.
 */
export interface CatalogIngredient {
  id: string;
  brandId: string;
  name: string;
  unit: string;
  category: string;
  caseQty: number;
  subUnitSize: number;
  subUnitUnit: string;
  defaultCost: number;
  defaultCasePrice: number;
  /**
   * Spec 010: default days from receipt to expiry, used by the
   * Receiving auto-stamp branch to set inventory_items.expiry_date when
   * the row has no existing expiry. NULL/undefined = no auto-compute.
   * The per-row inventory_items.expiry_date can override on a per-row
   * basis. See specs/010-attention-queue-phase-2.md §1.
   */
  defaultShelfLifeDays?: number | null;
}

export interface InventoryItem {
  id: string;
  /**
   * FK to catalog_ingredients(id). Source of truth for name/unit/category/
   * case_qty/sub_unit_size/sub_unit_unit after Phase 3 drops those columns
   * from inventory_items. The fields below are populated from the catalog
   * via JOIN at fetch time so existing UI code keeps working.
   */
  catalogId: string;
  name: string;
  category: string;
  unit: string;
  costPerUnit: number;
  currentStock: number;
  parLevel: number;
  averageDailyUsage: number;
  safetyStock: number;
  vendorId: string;
  vendorName: string;
  usagePerPortion: number;
  expiryDate?: string;
  lastUpdatedBy: string;
  lastUpdatedAt: string;
  eodRemaining: number;
  storeId: string;
  // Packaging / case info — hydrated from CatalogIngredient
  casePrice: number;
  caseQty: number;
  subUnitSize: number;
  subUnitUnit: string;
}

export type ItemStatus = 'ok' | 'low' | 'out';

export interface Recipe {
  id: string;
  menuItem: string;
  category: string;
  sellPrice: number;
  ingredients: RecipeIngredient[];
  prepItems: RecipePrepItem[];
  /**
   * Recipes are brand-level after the catalog refactor. brandId is the
   * authoritative scope. `storeId` is kept populated with the brand id
   * for back-compat with legacy non-Cmd screens until they're removed,
   * but Cmd UI should not filter by it (every store sees every recipe).
   */
  brandId: string;
  storeId: string;
}

export interface RecipeIngredient {
  /**
   * After the brand catalog refactor, this is a `catalog_ingredients.id`
   * (brand-level), not a per-store `inventory_items.id`. Cost lookups
   * resolve it to the current store's inventory_items row by matching
   * `inventory_items.catalog_id === itemId AND inventory_items.store_id
   * === currentStore.id`. Field name kept as `itemId` to avoid touching
   * every consumer; semantically it's a catalog id now.
   */
  itemId: string;
  itemName: string;
  quantity: number;
  unit: string;
}

export interface RecipePrepItem {
  prepRecipeId: string;
  prepRecipeName: string;
  quantity: number;
  unit: string;
}

export interface PrepRecipe {
  id: string;
  name: string;
  category: string;
  yieldQuantity: number;
  yieldUnit: string;
  notes: string;
  ingredients: PrepRecipeIngredient[];
  /** Brand-level after catalog refactor. storeId carries brand id for back-compat. */
  brandId: string;
  storeId: string;
  createdBy: string;
  createdAt: string;
  // Versioning
  version: number;
  isCurrent: boolean;
  parentId?: string;
}

export interface PrepRecipeIngredient {
  /**
   * For type='raw': a `catalog_ingredients.id` (brand-level).
   * For type='prep': a `prep_recipes.id` (sub-recipe reference).
   * Field name kept as `itemId` to avoid touching every consumer.
   */
  itemId: string;
  itemName: string;
  quantity: number;
  unit: string;
  // Base unit (source of truth for math)
  baseQuantity: number;
  baseUnit: string; // 'g' or 'fl_oz'
  // Sub-recipe support: 'raw' = inventory item, 'prep' = nested prep recipe
  type?: 'raw' | 'prep';
}

export interface IngredientConversion {
  id: string;
  /**
   * After the catalog refactor this is a catalog_ingredients.id.
   * Field name kept for back-compat; semantics shifted from per-store
   * inventory row to brand-level catalog row.
   */
  inventoryItemId: string;
  purchaseUnit: string;
  baseUnit: string;
  conversionFactor: number;
  netYieldPct: number;
}

export interface WasteEntry {
  id: string;
  itemId: string;
  itemName: string;
  quantity: number;
  unit: string;
  costPerUnit: number;
  reason: WasteReason;
  loggedBy: string;
  loggedByUserId: string;
  timestamp: string;
  notes: string;
  storeId: string;
}

export type WasteReason =
  | 'Expired'
  | 'Dropped/spilled'
  | 'Over-prepped'
  | 'Quality issue'
  | 'Theft'
  | 'Other';

export interface EODEntry {
  id: string;
  itemId: string;
  itemName: string;
  actualRemaining: number;        // authoritative total in base units
  unit: string;
  // Dual-entry (optional, only when hasCaseInfo)
  actualRemainingCases?: number;  // sealed cases counted
  actualRemainingEach?: number;   // loose units counted
  submittedBy: string;
  submittedByUserId: string;
  timestamp: string;
  date: string;
  storeId: string;
  notes: string;
}

export interface EODSubmission {
  id: string;
  date: string;
  storeId: string;
  storeName: string;
  // Spec 020 — per-vendor partitioning. `vendor_id NOT NULL` on
  // eod_submissions; populated post-migration via mode backfill across
  // each submission's eod_entries. New submissions always carry the
  // selected vendor id. `vendorName` is hydrated client-side from
  // useStore.vendors for display (server payload doesn't join the name).
  vendorId: string;
  vendorName?: string;
  submittedBy: string;
  submittedByUserId: string;
  timestamp: string;
  itemCount: number;
  status: 'draft' | 'submitted';
  entries: EODEntry[];
}

// ─── Spec 019: Any-time inventory count ─────────────────────────────
// New `inventory_counts` table is additive — it does NOT collapse the
// existing EOD path (eod_submissions). The 'eod' kind is intentionally
// excluded from this client union; EOD continues to flow through
// staff_submit_eod / submitEODCount. See spec 019 §Data model AC.
export type InventoryCountKind = 'spot' | 'open' | 'mid_shift' | 'close';

export interface InventoryCountEntry {
  id: string;
  countId: string;
  itemId: string;
  itemName: string;                      // hydrated via catalog join
  actualRemaining: number | null;
  actualRemainingCases?: number | null;
  actualRemainingEach?: number | null;
  unit?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface InventoryCount {
  id: string;
  storeId: string;
  kind: InventoryCountKind;
  countedAt: string;
  submittedBy: string | null;
  submitterName?: string;                // hydrated via profiles join
  submittedAt: string;
  status: 'draft' | 'submitted';
  clientUuid?: string | null;
  notes?: string | null;
  createdAt: string;
  entries: InventoryCountEntry[];        // populated by fetchInventoryCount only
}

// List-row shape — no entries, includes derived itemCount.
export interface InventoryCountSummary {
  id: string;
  storeId: string;
  kind: InventoryCountKind;
  countedAt: string;
  submittedBy: string | null;
  submitterName?: string;
  submittedAt: string;
  status: 'draft' | 'submitted';
  itemCount: number;
  notes?: string | null;
}

export interface Vendor {
  id: string;
  /** Brand-scoped after catalog refactor. */
  brandId: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  accountNumber: string;
  leadTimeDays: number;
  deliveryDays: string[];
  categories: string[];
  lastOrderDate?: string;
  // HH:MM in 24h (store local time). Cron fires 60/30/10 min before this on
  // the vendor's scheduled order days, unless the order has already been placed.
  orderCutoffTime?: string;
  // HH:MM in 24h (store local time). Locks the EOD count screen for this
  // vendor's items once this time passes. Falls back to the store-wide
  // eodDeadlineTime when not set. Distinct from orderCutoffTime, which gates
  // when the order itself must be placed with the vendor.
  eodDeadlineTime?: string;
}

export interface POSSaleItem {
  menuItem: string;
  qtySold: number;
  revenue: number;
  recipeId?: string;
  recipeMapped: boolean;
}

export interface POSImport {
  id: string;
  filename: string;
  importedAt: string;
  importedBy: string;
  date: string;
  storeId: string;
  items: POSSaleItem[];
}

export interface ReconciliationLine {
  itemId: string;
  itemName: string;
  posQtySold: number;
  recipeUsed: string;
  expectedDeduction: number;
  openingStock: number;
  eodRemaining: number;
  eodBy: string;
  eodTime: string;
  expectedRemaining: number;
  variance: number;
  unit: string;
  result: 'match' | 'mismatch' | 'review';
  /**
   * True when at least one recipe contributing to this line had a unit we
   * couldn't convert into the inventory item's tracking unit. The numeric
   * fields (expectedDeduction / variance) still reflect rows that DID
   * convert, but the line is forced to `result: 'review'` and the screen
   * surfaces a "Unit mismatch" badge so the admin knows to fix the recipe.
   */
  unitMismatch?: boolean;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  userId: string;
  userName: string;
  userRole: UserRole;
  storeId: string;
  storeName: string;
  action: AuditAction;
  detail: string;
  itemRef: string;
  value: string;
}

export type AuditAction =
  | 'EOD entry'
  | 'Item edit'
  | 'Item added'
  | 'Item deleted'
  | 'POS import'
  | 'Waste log'
  | 'User invite'
  | 'Recipe saved'
  | 'Recipe deleted'
  | 'Prep recipe saved'
  | 'Prep recipe deleted'
  | 'Stock adjusted';

export interface Store {
  id: string;
  /** Brand the store belongs to. Single-tenant for now (always "2AM PROJECT"). */
  brandId: string;
  name: string;
  address: string;
  status: 'active' | 'inactive';
  // HH:MM in 24h (store local time via the app's timezone). Used to schedule EOD reminders.
  eodDeadlineTime?: string;
}

export interface OrderDayVendor {
  vendorId?: string;
  vendorName: string;
  deliveryDay: string;
}

export interface OrderSchedule {
  [day: string]: OrderDayVendor[];
}

export interface OrderSubmission {
  id: string;
  storeId: string;
  day: string;
  date: string;
  vendorName: string;
  submittedBy: string;
  submittedAt: string;
}

export interface AppState {
  currentUser: User | null;
  currentStore: Store;
  /** The brand the current user is operating in. Single-tenant for now. */
  brand: Brand | null;
  /** Brand-level master ingredient list. */
  catalogIngredients: CatalogIngredient[];
  stores: Store[];
  users: User[];
  inventory: InventoryItem[];
  recipes: Recipe[];
  recipeCategories: string[];
  ingredientCategories: string[];
  prepRecipes: PrepRecipe[];
  wasteLog: WasteEntry[];
  eodSubmissions: EODSubmission[];
  vendors: Vendor[];
  posImports: POSImport[];
  posRecipeAliases: { pos_name: string; recipe_id: string; store_id: string | null }[];
  savedReports: ReportDefinition[];
  /**
   * Spec 016 — most-recent run per saved definition. Keyed by
   * `definitionId`. Full history stays in DB; the store holds only the
   * latest for the open detail view to render. Lazy-loaded by
   * `loadLatestRun(definitionId)` when a saved-report tile is opened —
   * NOT populated by `loadFromSupabase` to keep boot payload bounded.
   */
  reportRuns: Record<string, ReportRun>;
  auditLog: AuditEvent[];
  orderSchedule: OrderSchedule;
  orderSubmissions: OrderSubmission[];
  timezone: string;
  darkMode: boolean;
  /**
   * Spec 008: per-user Cmd UI sidebar layout override. `null` means
   * uncustomized (the InventoryDesktopLayout hardcoded default groups
   * render verbatim). Populated from profiles.sidebar_layout at login;
   * mutated only via setSidebarLayoutOverride which persists optimistically.
   */
  sidebarLayoutOverride: SidebarLayoutOverride | null;
  notifications: AppNotification[];
  /**
   * Per-item unit-conversion rows used to bridge recipe units (oz, fl_oz,
   * ea, ...) to the inventory item's tracking unit (cases, bags, ...).
   * Always initialized to `[]` by `useStore`; never undefined at runtime.
   * Read by `convertToItemUnit` (src/utils/unitConversion.ts) when
   * caseQty/subUnitSize alone can't bridge the units (e.g. custom packs).
   */
  ingredientConversions: IngredientConversion[];
  /**
   * Spec 012b — super-admin's explicit brand-context override. NULL
   * means:
   *   - super-admin: "All brands" mode → app navigates to Brands section
   *   - non-super-admin: NOT USED (the picker is hidden; brand is implicit
   *     via profiles.brand_id, surfaced through the existing `brand` slice)
   */
  currentBrandId: string | null;
  /** Spec 012b — full brands list (super-admin only). Empty array for
   *  non-super-admin since the brand picker / Brands section are hidden
   *  for them. Populated by loadBrandsList action at login for super-admins. */
  brandsList: Brand[];
}

export interface ReportDefinition {
  id: string;
  storeId: string;
  templateId: 'variance' | 'waste' | 'cogs' | 'vendor' | 'velocity' | 'custom';
  name: string;
  scope?: 'this_store' | 'all_stores';
  /**
   * Per-template params. Shape is template-dependent; the dispatcher
   * RPC `report_run` accepts whatever is here as `jsonb` and the
   * specific runner coerces / defaults. Stays `Record<string, unknown>`
   * for forward-compat so adding a new template doesn't churn the
   * frontend type wall.
   *
   * Per-template expected keys (informational — runners default
   * missing keys, so this is what the modal SHOULD send):
   *  - `cogs` (Spec 017 / REPORTS-2): `{ range?: 'last_30d' | 'this_month' | 'last_full_month' | 'last_90d', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD', by?: 'category' | 'item' }`.
   *    `range` is informational (drives the chip label); `from`/`to` are authoritative.
   *  - Other templates: TBD per their own specs.
   */
  params?: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
}

/**
 * Spec 016 (REPORTS-1) — uniform output envelope returned by every
 * `report_run_<template>` RPC. The detail frame trusts this shape;
 * `kpis`/`columns`/`rows` are always non-null arrays, `series` is
 * either an array or null. The `_status`/`_message` keys are
 * envelope metadata used by the dispatcher to flag templates whose
 * runner hasn't been wired yet.
 */
export interface ReportRunOutput {
  kpis: Array<{
    label: string;
    value: string | number;
    tone?: 'ok' | 'warn' | 'danger' | null;
  }>;
  columns: Array<{
    key: string;
    label: string;
    align?: 'left' | 'right' | null;
  }>;
  rows: Array<Record<string, unknown>>;
  series: Array<{ label: string; x: string; y: number }> | null;
  _status?: 'not_implemented';
  _message?: string;
}

/**
 * Spec 016 (REPORTS-1) — single execution of a report definition (or
 * an ad-hoc template + params with no saved definition). Append-only
 * history; the latest row per `definitionId` is what the detail frame
 * displays.
 */
export interface ReportRun {
  id: string;
  definitionId: string | null;
  templateId: string;
  storeId: string;
  params: Record<string, unknown>;
  output: ReportRunOutput | null;
  status: 'pending' | 'ok' | 'error';
  errorMessage: string | null;
  ranAt: string;
  ranBy: string | null;
}

export interface AppNotification {
  id: string;
  message: string;
  timestamp: string;
  read: boolean;
}

/**
 * Spec 008: per-user Cmd UI sidebar override list. Stored in
 * profiles.sidebar_layout (jsonb). NULL on the row OR `null`/`undefined`
 * here means "use the hardcoded default groups array verbatim".
 *
 * Override semantics (see spec 008 §2 + §7):
 *   - One entry per customized item; items not present inherit default
 *     position + visibility.
 *   - `id` matches TreeItem.id from InventoryDesktopLayout.tsx.
 *   - `group?` present only when the user moved the item to a different
 *     group than its default ("Operations" | "Planning" | "Insights").
 *   - `order?` present only when the user reordered. Lower = higher in
 *     the list within its group. Sort keys are normalized at render time;
 *     stored values just need to be ordered.
 *   - `hidden?` present and `true` only when the user hid the item.
 *
 * The merge algorithm (`applySidebarOverride`) silently drops stale
 * entries whose `id` no longer exists in the hardcoded default — that
 * gives "future spec-added items auto-append to default group" for free.
 */
export interface SidebarLayoutOverrideEntry {
  id: string;
  group?: string;
  order?: number;
  hidden?: boolean;
}

export interface SidebarLayoutOverride {
  /** Schema version. Readers that don't recognize `v` must fall back to
   *  the default layout (treat as if the override were null). */
  v: 1;
  items: SidebarLayoutOverrideEntry[];
}
