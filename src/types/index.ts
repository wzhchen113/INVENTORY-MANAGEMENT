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

export interface InventoryItem {
  id: string;
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
  // Packaging / case info
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
  storeId: string;
}

export interface RecipeIngredient {
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
  storeId: string;
  createdBy: string;
  createdAt: string;
  // Versioning
  version: number;
  isCurrent: boolean;
  parentId?: string;
}

export interface PrepRecipeIngredient {
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
