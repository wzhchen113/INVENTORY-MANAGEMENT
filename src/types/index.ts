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
  auditLog: AuditEvent[];
  orderSchedule: OrderSchedule;
  orderSubmissions: OrderSubmission[];
  timezone: string;
  darkMode: boolean;
  notifications: AppNotification[];
}

export interface AppNotification {
  id: string;
  message: string;
  timestamp: string;
  read: boolean;
}
