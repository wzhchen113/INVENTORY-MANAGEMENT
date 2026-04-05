// src/types/index.ts

export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  name: string;
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
  vendorId: string;
  vendorName: string;
  usagePerPortion: number;
  expiryDate?: string;
  lastUpdatedBy: string;
  lastUpdatedAt: string;
  eodRemaining: number;
  storeId: string;
}

export type ItemStatus = 'ok' | 'low' | 'out';

export interface Recipe {
  id: string;
  menuItem: string;
  category: string;
  sellPrice: number;
  ingredients: RecipeIngredient[];
  storeId: string;
}

export interface RecipeIngredient {
  itemId: string;
  itemName: string;
  quantity: number;
  unit: string;
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
  actualRemaining: number;
  unit: string;
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
  categories: string[];
  lastOrderDate?: string;
}

export interface PurchaseOrderItem {
  itemId: string;
  itemName: string;
  unit: string;
  orderedQty: number;
  receivedQty?: number;
  costPerUnit: number;
}

export type POStatus = 'draft' | 'sent' | 'received' | 'partial';

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  createdBy: string;
  createdByUserId: string;
  createdAt: string;
  expectedDelivery: string;
  items: PurchaseOrderItem[];
  totalCost: number;
  status: POStatus;
  storeId: string;
  receivedAt?: string;
  receivedBy?: string;
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
  | 'POS import'
  | 'Waste log'
  | 'PO created'
  | 'PO sent'
  | 'Receiving'
  | 'User invite'
  | 'Recipe saved'
  | 'Stock adjusted';

export interface Store {
  id: string;
  name: string;
  address: string;
  status: 'active' | 'inactive';
}

export interface AppState {
  currentUser: User | null;
  currentStore: Store;
  stores: Store[];
  users: User[];
  inventory: InventoryItem[];
  recipes: Recipe[];
  wasteLog: WasteEntry[];
  eodSubmissions: EODSubmission[];
  vendors: Vendor[];
  purchaseOrders: PurchaseOrder[];
  posImports: POSImport[];
  auditLog: AuditEvent[];
}
