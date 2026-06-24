// src/types/index.ts

import type { Locale } from '../i18n';

export type UserRole = 'super_admin' | 'master' | 'admin' | 'user';

/**
 * Spec 040 P3 — per-locale name override map for user-entered data.
 * Keyed by Locale so adding a 4th language widens the type with zero
 * migration. The English canonical lives on the parent row's `name` /
 * `menu_item` column and is never written here. Partial — a row without
 * any translations is shape `{}`, not required to spell out keys.
 *
 * Wire shape (snake_case → camelCase): `i18n_names` JSONB column maps to
 * `i18nNames` here. Empty / whitespace-only string values are treated as
 * "no translation" by `getLocalizedName` and fall through to the English
 * canonical silently (no `(en)` tag, no `[untranslated]` placeholder).
 */
export type LocalizedNames = Partial<Record<Locale, string>>;

/**
 * Spec 040 P3 — recipe / ingredient category list entry. The `name`
 * field is the canonical English label (also the join key against
 * `recipes.category` / `inventory_items.category` — both string fields).
 * `i18nNames` carries the per-locale overrides for display only;
 * filter / select join logic continues to operate on `name` because
 * the join columns store the English canonical too.
 */
export interface RecipeCategory {
  name: string;
  i18nNames: LocalizedNames;
}

export interface IngredientCategory {
  name: string;
  i18nNames: LocalizedNames;
}

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
  /**
   * Spec 095 — admin-assigned login username (mirrors profiles.username).
   * Globally unique, case-folded (stored lowercased). NULL for rows that
   * predate the backfill or were never assigned one — those users log in by
   * email. Optional because older sessions may not have loaded the column.
   */
  username?: string | null;
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
  /**
   * Spec 040 P3 — per-locale name overrides for the catalog ingredient
   * `name`. See `LocalizedNames`. Hydrated by `fetchCatalogIngredients`
   * from `catalog_ingredients.i18n_names` (JSONB). Also forwarded into
   * the joined `InventoryItem.i18nNames` by `mapItem` so per-store
   * inventory list views read it without a second lookup.
   */
  i18nNames?: LocalizedNames;
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
  expiryDate?: string | null;
  lastUpdatedBy: string;
  lastUpdatedAt: string;
  eodRemaining: number;
  storeId: string;
  // Packaging / case info — hydrated from CatalogIngredient
  casePrice: number;
  caseQty: number;
  subUnitSize: number;
  subUnitUnit: string;
  /**
   * Spec 040 P3 — per-locale name overrides hydrated from the joined
   * catalog row's `i18n_names` JSONB column. See `LocalizedNames` for
   * the shape; consumed by `getLocalizedName` / `useLocalizedName`.
   * Optional because legacy in-memory rows from before the spec landed
   * may omit it; readers must treat `undefined` as `{}`.
   */
  i18nNames?: LocalizedNames;
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
  /**
   * Spec 040 P3 — per-locale name overrides for `menuItem`. See
   * `LocalizedNames`. The `recipes` table is the only one of the five
   * P3 tables with a non-`name` canonical column (`menu_item`); the
   * `getLocalizedName` helper handles the column resolution.
   */
  i18nNames?: LocalizedNames;
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
  /**
   * Spec 040 P3 — per-locale name overrides for the prep recipe `name`.
   * See `LocalizedNames`.
   */
  i18nNames?: LocalizedNames;
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
//
// Spec 098 adds 'weekly' — the staff weekly full-store count. It reuses the
// inventory_counts table (advisory snapshot) but is written ONLY via the
// dedicated submit_weekly_count RPC; the generic submit_inventory_count RPC
// keeps rejecting 'weekly' (defense-in-depth allowlist).
export type InventoryCountKind = 'spot' | 'open' | 'mid_shift' | 'close' | 'weekly';

// Spec 098 — per-store weekly-count status for the admin tab + staff banner.
// camelCase mirror of the weekly_count_status RPC return table.
export type WeeklyCountStatusValue =
  | 'not_scheduled'   // no cadence configured (due_dow NULL)
  | 'completed'       // a weekly count exists in the current window
  | 'open'            // uncompleted, before/within the window (banner shows)
  | 'overdue';        // uncompleted and it IS the due day (banner shows)

export interface WeeklyCountStatus {
  storeId: string;
  dueDow: number | null;          // 0=Sun..6=Sat, null when not_scheduled
  windowStart: string | null;     // YYYY-MM-DD, null when not_scheduled
  windowEnd: string | null;       // YYYY-MM-DD, null when not_scheduled
  status: WeeklyCountStatusValue;
  lastCountId: string | null;     // the in-window weekly count, if completed
  lastCountedAt: string | null;
}

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
  | 'User deleted'
  | 'Recipe saved'
  | 'Recipe deleted'
  | 'Prep recipe saved'
  | 'Prep recipe deleted'
  | 'Stock adjusted'
  | 'Order missed';

export interface Store {
  id: string;
  /** Brand the store belongs to. Single-tenant for now (always "2AM PROJECT"). */
  brandId: string;
  name: string;
  address: string;
  status: 'active' | 'inactive';
  // HH:MM in 24h (store local time via the app's timezone). Used to schedule EOD reminders.
  eodDeadlineTime?: string;
  // Spec 098 — per-store weekly full-count due day-of-week.
  // 0=Sunday .. 6=Saturday (JS Date.getDay() convention). null/undefined =
  // no cadence configured = weekly count not scheduled (excluded from
  // reminders and overdue status).
  weeklyCountDueDow?: number | null;
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
  /**
   * Spec 024 — hydrated client-side from `useStore.stores` in
   * `loadFromSupabase` so broadcast-notification builders + selectors
   * that compare against currentStore.name still match. Optional
   * because legacy callers (e.g. `OrdersScreen`) construct submissions
   * without it; the hydration backfills.
   */
  storeName?: string;
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
  /**
   * Spec 040 P3 — widened from `string[]` to `{ name; i18nNames }[]` so
   * the categories list can localize its display labels. The `name` field
   * is the canonical English string (still the join key everywhere else
   * in the codebase); `i18nNames` carries the per-locale overrides.
   * Consumers that need a flat string list `.map((c) => c.name)`.
   */
  recipeCategories: RecipeCategory[];
  ingredientCategories: IngredientCategory[];
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
  /**
   * Spec 021 — last fetched reorder-list envelope for the current store.
   * `null` until ReorderSection opens and triggers
   * `loadReorderSuggestions`. Cleared (not refreshed) by
   * `loadFromSupabase` so the section stays the lazy-load entry point.
   */
  reorderPayload: ReorderPayload | null;
  reorderLoading: boolean;
  reorderError: string | null;
  /**
   * Spec 060 — server-computed per-recipe capacity for the active
   * store. Keyed by `recipeId` for O(1) lookup from
   * `RecipesSection`'s inline badge. Populated as a fire-and-forget
   * tail of `loadFromSupabase`; cleared (set to `{}`) on store
   * switch so the prior store's numbers never leak. The shape is
   * the `MenuCapacityRow` returned by `db.fetchMenuCapacity`.
   */
  menuCapacity: Record<string, MenuCapacityRow>;
  auditLog: AuditEvent[];
  orderSchedule: OrderSchedule;
  orderSubmissions: OrderSubmission[];
  timezone: string;
  darkMode: boolean;
  /**
   * Spec 038: per-user preferred chrome language. One of 'en' | 'es' |
   * 'zh-CN' (see `Locale` in `src/i18n/index.ts` — single source of
   * truth). Hydrated at boot from localStorage / AsyncStorage (web
   * synchronous, native async) and overridden after login by
   * profiles.locale via hydrateLocale. The persisting setter is
   * setLocale (writes through to profiles.locale via db.saveLocale).
   */
  locale: Locale;
  /**
   * Spec 008: per-user Cmd UI sidebar layout override. `null` means
   * uncustomized (the InventoryDesktopLayout hardcoded default groups
   * render verbatim). Populated from profiles.sidebar_layout at login;
   * mutated only via setSidebarLayoutOverride which persists optimistically.
   */
  sidebarLayoutOverride: SidebarLayoutOverride | null;
  notifications: AppNotification[];
  /**
   * Spec 024 — gate for the "loading…" splash during `loadFromSupabase`.
   * The useStore initial-state literal sets this to `false`; the action
   * flips it `true` on entry and back to `false` in the `finally`. Not
   * optional — readers (legacy `AppNavigator`) assume the field exists.
   */
  storeLoading: boolean;
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
   *  - `waste` (Spec 034): `{ range?: 'last_30d' | 'this_month' | 'last_full_month' | 'last_90d', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD', by?: 'reason' | 'category' | 'item' }`.
   *    Same shape as cogs but with an extra `'reason'` value on the `by` axis.
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
 *
 * Spec 037 — the `report_run_custom` runner adds two optional metadata
 * fields (`_truncated`, `_row_count`). Other runners do not emit them;
 * the FE branches on `templateId === 'custom'` for any rendering that
 * relies on these keys. Optional so other runners keep typechecking.
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
  // Spec 037 — custom-SQL runner only. Other runners do not emit these.
  _truncated?: boolean;
  _row_count?: number;
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

/**
 * Spec 021 — per-vendor reorder suggestion. `'eod'` means the vendor's
 * `on_hand` came from today's EOD `actual_remaining` (authoritative);
 * `'stock'` means it fell back to `inventory_items.current_stock`
 * (last-known snapshot — manager hasn't counted this vendor yet).
 */
export type OnHandSource = 'eod' | 'stock';

/**
 * Spec 021 — one line in a reorder vendor card. `pendingPoQty` is the
 * "inbound" segment of the `on hand | inbound | par → order` breakdown.
 * v1 always returns 0 (see spec §1 — `po_items` isn't a real write
 * target yet); the column exists so the v2 swap is transparent.
 *
 * `flags` is a lowercase-token string array surfaced as icons next to
 * the item name. Known tokens:
 *   - `'no_par'`           — par_level NULL or 0
 *   - `'no_usage_rate'`    — usage_per_portion NULL or 0
 *   - `'eod_missing_for_item'` — vendor is EOD-sourced but THIS item's
 *     EOD entry is missing (fell back to current_stock for this row
 *     only). Vendor-level `onHandSource` stays `'eod'`.
 *   - `'truncated'`        — recipe-graph depth cap hit during forecast.
 */
export interface ReorderItem {
  itemId: string;
  itemName: string;
  unit: string;
  onHand: number;
  pendingPoQty: number;
  parLevel: number;
  usageForecasted: number;
  parReplacement: number;
  suggestedQty: number;
  costPerUnit: number;
  estimatedCost: number;
  // Spec 088 — case-based ordering. `caseQty` is units-per-case from the
  // catalog (always present; `1` when no case size). `suggestedCases` is
  // the whole-case order (ceil of suggestedQty / caseQty) and is `null`
  // when `caseQty <= 1` (no case size → base unit unchanged).
  // `suggestedUnits` is the server-authoritative ordered base-unit total
  // (= suggestedCases × caseQty for case items, else suggestedQty); the FE
  // reads it verbatim rather than re-deriving cases × caseQty. Estimated
  // cost is already case-rounded server-side and rides on `estimatedCost`.
  caseQty: number;
  suggestedCases: number | null;
  suggestedUnits: number;
  flags: string[];
  /**
   * Spec 100 — per-item localized-name overrides surfaced by the
   * `report_reorder_list` RPC from `catalog_ingredients.i18n_names`.
   * Optional + defaults to `{}` so the admin path (which never reads it)
   * and any pre-migration payload tolerate absence. Rendered via
   * `getLocalizedName({ name: itemName, i18nNames }, locale)` on the staff
   * reorder screen only — EOD/Weekly already do the same. Mirrors the
   * optional `i18nNames?` on the catalog/inventory types above.
   */
  i18nNames?: LocalizedNames;
}

/**
 * Spec 021 — one vendor's reorder card. `scheduleKnown=false` means the
 * vendor has no `order_schedule` row; the RPC falls back to a 7-day
 * default and surfaces a `_warnings` entry. The UI badges this so the
 * manager knows the cadence is an assumption.
 */
export interface ReorderVendor {
  vendorId: string;
  vendorName: string;
  scheduleKnown: boolean;
  nextDeliveryDate: string;       // YYYY-MM-DD
  daysUntilNextDelivery: number;
  onHandSource: OnHandSource;
  eodSubmittedAt: string | null;  // ISO-8601 or null
  items: ReorderItem[];
  vendorTotalCost: number;
}

/**
 * Spec 021 — payload returned by `report_reorder_list(uuid, jsonb)`.
 * `vendors` is already filtered: vendors with zero suggested items are
 * dropped server-side. KPIs reflect only the surfaced vendors.
 * `warnings` is non-fatal — currently used for vendors without an
 * `order_schedule` row (one warning per such vendor).
 */
export interface ReorderPayload {
  asOfDate: string;
  vendors: ReorderVendor[];
  kpis: {
    vendorCount: number;
    itemCount: number;
    totalEstimatedCost: number;
    eodSourcedVendorCount: number;
    stockFallbackVendorCount: number;
  };
  // `vendor` is an optional, frontend-parsed convenience field: for
  // `code === 'schedule_unknown'` warnings the staff Reorder screen extracts
  // the vendor name from the server-built `message` so it can re-localize the
  // warning (spec follow-up). It is undefined for warnings produced outside
  // that parse path (e.g. the admin db.ts mapper), which is why it's optional.
  warnings: Array<{ code: string; message: string; vendor?: string }>;
}

/**
 * Spec 060 — one row per recipe from `compute_menu_capacity` RPC.
 * Mapped from snake_case → camelCase in `db.fetchMenuCapacity`.
 *
 * Field semantics:
 *  - `hasRecipe=false` → no BOM defined; UI renders "no recipe
 *    defined" in place of the capacity number.
 *  - `makeableQty` is `null` when no constraint binds (no BOM,
 *    or prep chain with zero leaf ingredients). For
 *    `hasRecipe=true && makeableQty=null` the badge renders
 *    nothing; the no-recipe label is gated by `hasRecipe`.
 *  - `bindingCatalogId` always points at a LEAF ingredient
 *    (a raw catalog row), even when the constraint surfaced
 *    through a prep recipe. The UI shows "limited by: flour"
 *    not "limited by: sauce X".
 *  - `bindingShortfall` is "how much more of the binding
 *    ingredient is needed to make ONE more of this menu item",
 *    in the catalog's unit, clamped at >= 0.
 *  - `lowIngredientCount` is the count of DISTINCT catalog
 *    ingredients (direct + transitive prep leaves) with
 *    `current_stock < par_level` in the caller's store; rows
 *    with `par_level <= 0` / NULL are excluded (cf. spec edge case).
 *  - `hasUnitMismatch=true` → at least one recipe line declared
 *    a unit string different from the catalog's. UI qualifies
 *    the number with `~`. See spec 060 §2 — server-side unit
 *    conversion is deferred to a future cleanup.
 *  - `truncated=true` → recursive prep walk hit the depth-5 cap
 *    with graph left to explore. UI qualifies with `?`.
 */
export interface MenuCapacityRow {
  recipeId: string;
  storeId: string;
  hasRecipe: boolean;
  makeableQty: number | null;
  bindingCatalogId: string | null;
  bindingCatalogName: string | null;
  bindingShortfall: number | null;
  lowIngredientCount: number;
  hasUnitMismatch: boolean;
  truncated: boolean;
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
