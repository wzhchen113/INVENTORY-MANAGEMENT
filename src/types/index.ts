// src/types/index.ts

export type UserRole = 'master' | 'admin' | 'user';

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
}

export interface Brand {
  id: string;
  name: string;
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
  submittedBy: string;
  submittedByUserId: string;
  timestamp: string;
  itemCount: number;
  status: 'draft' | 'submitted';
  entries: EODEntry[];
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
  | 'Prep recipe saved'
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
  auditLog: AuditEvent[];
  orderSchedule: OrderSchedule;
  orderSubmissions: OrderSubmission[];
  timezone: string;
  darkMode: boolean;
  notifications: AppNotification[];
  /**
   * Per-item unit-conversion rows used to bridge recipe units (oz, fl_oz,
   * ea, ...) to the inventory item's tracking unit (cases, bags, ...).
   * Optional in the type because not every store has populated these yet,
   * but `useStore` always initializes it to []. Read by `convertToItemUnit`
   * (src/utils/unitConversion.ts) when caseQty/subUnitSize alone can't bridge
   * the units (e.g. custom packs).
   */
  ingredientConversions?: IngredientConversion[];
}

export interface ReportDefinition {
  id: string;
  storeId: string;
  templateId: 'variance' | 'waste' | 'cogs' | 'vendor' | 'velocity' | 'custom';
  name: string;
  scope?: 'this_store' | 'all_stores';
  params?: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
}

export interface AppNotification {
  id: string;
  message: string;
  timestamp: string;
  read: boolean;
}
