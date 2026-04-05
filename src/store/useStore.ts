// src/store/useStore.ts
import { create } from 'zustand';
import {
  AppState, User, InventoryItem, Recipe, WasteEntry,
  EODSubmission, Vendor, PurchaseOrder, POSImport,
  AuditEvent, AuditAction, Store, ItemStatus, PrepRecipe,
} from '../types';
import {
  STORES, USERS, INVENTORY, RECIPES, VENDORS,
  WASTE_LOG, PURCHASE_ORDERS, AUDIT_LOG, PREP_RECIPES,
} from '../data/seed';

interface StoreActions {
  // Auth
  login: (user: User) => void;
  logout: () => void;
  setCurrentStore: (store: Store) => void;

  // Inventory
  addItem: (item: Omit<InventoryItem, 'id'>) => void;
  updateItem: (id: string, updates: Partial<InventoryItem>) => void;
  adjustStock: (id: string, newStock: number, by: string) => void;
  getItemStatus: (item: InventoryItem) => ItemStatus;

  // Recipes
  addRecipe: (recipe: Omit<Recipe, 'id'>) => void;
  updateRecipe: (id: string, updates: Partial<Recipe>) => void;

  // Prep Recipes
  addPrepRecipe: (recipe: Omit<PrepRecipe, 'id'>) => void;
  updatePrepRecipe: (id: string, updates: Partial<PrepRecipe>) => void;
  deletePrepRecipe: (id: string) => void;

  // Waste
  logWaste: (entry: Omit<WasteEntry, 'id'>) => void;

  // EOD
  submitEOD: (submission: Omit<EODSubmission, 'id'>) => void;

  // Vendors
  addVendor: (vendor: Omit<Vendor, 'id'>) => void;
  updateVendor: (id: string, updates: Partial<Vendor>) => void;

  // Purchase Orders
  createPO: (po: Omit<PurchaseOrder, 'id' | 'poNumber'>) => void;
  updatePOStatus: (id: string, status: PurchaseOrder['status']) => void;
  receivePO: (id: string, receivedItems: { itemId: string; receivedQty: number }[], receivedBy: string) => void;

  // POS Import
  importPOS: (posImport: Omit<POSImport, 'id'>) => void;

  // Users
  inviteUser: (user: Omit<User, 'id'>) => void;
  updateUser: (id: string, updates: Partial<User>) => void;

  // Audit
  addAuditEvent: (event: Omit<AuditEvent, 'id'>) => void;

  // Computed
  getLowStockItems: () => InventoryItem[];
  getInventoryValue: () => number;
  getFoodCostPercent: () => number;
  getWasteThisWeek: () => number;
  getRecipeCost: (recipeId: string) => number;
  getRecipeFoodCostPct: (recipeId: string) => number;
  getPrepRecipeCost: (prepRecipeId: string) => number;
  getPrepRecipeCostPerUnit: (prepRecipeId: string) => number;
}

type FullStore = AppState & StoreActions;

let itemCounter = INVENTORY.length + 1;
let recipeCounter = RECIPES.length + 1;
let prepRecipeCounter = PREP_RECIPES.length + 1;
let wasteCounter = WASTE_LOG.length + 1;
let vendorCounter = VENDORS.length + 1;
let poCounter = PURCHASE_ORDERS.length + 1;
let auditCounter = AUDIT_LOG.length + 1;
let userCounter = USERS.length + 1;

const makeId = (prefix: string, counter: number) => `${prefix}${counter}`;

export const useStore = create<FullStore>((set, get) => ({
  // Initial state
  currentUser: USERS[0],
  currentStore: STORES[0],
  stores: STORES,
  users: USERS,
  inventory: INVENTORY,
  recipes: RECIPES,
  prepRecipes: PREP_RECIPES,
  wasteLog: WASTE_LOG,
  eodSubmissions: [],
  vendors: VENDORS,
  purchaseOrders: PURCHASE_ORDERS,
  posImports: [],
  auditLog: AUDIT_LOG,

  // Auth
  login: (user) => set({ currentUser: user }),
  logout: () => set({ currentUser: null }),
  setCurrentStore: (store) => set({ currentStore: store }),

  // Inventory
  addItem: (item) => {
    const id = makeId('i', ++itemCounter);
    const newItem: InventoryItem = { ...item, id };
    set((s) => ({ inventory: [...s.inventory, newItem] }));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Item added',
      detail: 'New item created',
      itemRef: item.name,
      value: `${item.currentStock} ${item.unit}`,
    });
  },

  updateItem: (id, updates) => {
    set((s) => ({
      inventory: s.inventory.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    }));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Item edit',
      detail: 'Item updated',
      itemRef: get().inventory.find((i) => i.id === id)?.name || id,
      value: JSON.stringify(updates),
    });
  },

  adjustStock: (id, newStock, by) => {
    set((s) => ({
      inventory: s.inventory.map((item) =>
        item.id === id
          ? { ...item, currentStock: newStock, lastUpdatedBy: by, lastUpdatedAt: new Date().toLocaleTimeString() }
          : item
      ),
    }));
  },

  getItemStatus: (item) => {
    if (item.currentStock <= 0) return 'out';
    if (item.currentStock < item.parLevel) return 'low';
    return 'ok';
  },

  // Recipes
  addRecipe: (recipe) => {
    const id = makeId('r', ++recipeCounter);
    set((s) => ({ recipes: [...s.recipes, { ...recipe, id }] }));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Recipe saved',
      detail: 'New recipe added',
      itemRef: recipe.menuItem,
      value: `${recipe.ingredients.length} ingredients`,
    });
  },

  updateRecipe: (id, updates) => {
    set((s) => ({
      recipes: s.recipes.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    }));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Recipe saved',
      detail: 'Recipe updated',
      itemRef: get().recipes.find((r) => r.id === id)?.menuItem || id,
      value: '',
    });
  },

  // Prep Recipes
  addPrepRecipe: (recipe) => {
    const id = makeId('pr', ++prepRecipeCounter);
    set((s) => ({ prepRecipes: [...s.prepRecipes, { ...recipe, id }] }));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Prep recipe saved',
      detail: 'New prep recipe added',
      itemRef: recipe.name,
      value: `${recipe.ingredients.length} ingredients, yields ${recipe.yieldQuantity} ${recipe.yieldUnit}`,
    });
  },

  updatePrepRecipe: (id, updates) => {
    set((s) => ({
      prepRecipes: s.prepRecipes.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    }));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Prep recipe saved',
      detail: 'Prep recipe updated',
      itemRef: get().prepRecipes.find((r) => r.id === id)?.name || id,
      value: '',
    });
  },

  deletePrepRecipe: (id) => {
    set((s) => ({
      prepRecipes: s.prepRecipes.filter((r) => r.id !== id),
    }));
  },

  // Waste
  logWaste: (entry) => {
    const id = makeId('w', ++wasteCounter);
    set((s) => ({ wasteLog: [{ ...entry, id }, ...s.wasteLog] }));
    const item = get().inventory.find((i) => i.id === entry.itemId);
    if (item) {
      get().adjustStock(
        entry.itemId,
        Math.max(0, item.currentStock - entry.quantity),
        entry.loggedBy
      );
    }
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Waste log',
      detail: `${entry.reason} logged`,
      itemRef: entry.itemName,
      value: `${entry.quantity} ${entry.unit}`,
    });
  },

  // EOD
  submitEOD: (submission) => {
    const id = makeId('eod', Date.now());
    set((s) => ({ eodSubmissions: [{ ...submission, id }, ...s.eodSubmissions] }));
    submission.entries.forEach((entry) => {
      set((s) => ({
        inventory: s.inventory.map((item) =>
          item.id === entry.itemId
            ? {
                ...item,
                eodRemaining: entry.actualRemaining,
                lastUpdatedBy: entry.submittedBy,
                lastUpdatedAt: entry.timestamp,
              }
            : item
        ),
      }));
      get().addAuditEvent({
        timestamp: entry.timestamp,
        userId: entry.submittedByUserId,
        userName: entry.submittedBy,
        userRole: 'user',
        storeId: submission.storeId,
        storeName: submission.storeName,
        action: 'EOD entry',
        detail: 'Remaining count submitted',
        itemRef: entry.itemName,
        value: `${entry.actualRemaining} ${entry.unit}`,
      });
    });
  },

  // Vendors
  addVendor: (vendor) => {
    const id = makeId('v', ++vendorCounter);
    set((s) => ({ vendors: [...s.vendors, { ...vendor, id }] }));
  },

  updateVendor: (id, updates) => {
    set((s) => ({
      vendors: s.vendors.map((v) => (v.id === id ? { ...v, ...updates } : v)),
    }));
  },

  // Purchase Orders
  createPO: (po) => {
    const id = makeId('po', ++poCounter);
    const poNumber = `PO-${String(poCounter + 3).padStart(3, '0')}`;
    set((s) => ({
      purchaseOrders: [{ ...po, id, poNumber }, ...s.purchaseOrders],
    }));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: 'admin',
      storeId: po.storeId,
      storeName: get().stores.find((s) => s.id === po.storeId)?.name || '',
      action: po.status === 'sent' ? 'PO sent' : 'PO created',
      detail: `${poNumber} ${po.status === 'sent' ? 'sent to' : 'drafted for'} ${po.vendorName}`,
      itemRef: poNumber,
      value: `$${po.totalCost.toFixed(2)}`,
    });
  },

  updatePOStatus: (id, status) => {
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((po) =>
        po.id === id ? { ...po, status } : po
      ),
    }));
  },

  receivePO: (id, receivedItems, receivedBy) => {
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((po) =>
        po.id === id
          ? {
              ...po,
              status: 'received' as const,
              receivedAt: new Date().toLocaleDateString(),
              receivedBy,
              items: po.items.map((item) => {
                const received = receivedItems.find((r) => r.itemId === item.itemId);
                return received ? { ...item, receivedQty: received.receivedQty } : item;
              }),
            }
          : po
      ),
    }));
    receivedItems.forEach(({ itemId, receivedQty }) => {
      const item = get().inventory.find((i) => i.id === itemId);
      if (item) {
        get().adjustStock(itemId, item.currentStock + receivedQty, receivedBy);
      }
    });
    const po = get().purchaseOrders.find((p) => p.id === id);
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: receivedBy,
      userRole: 'admin',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Receiving',
      detail: `Delivery confirmed from ${po?.vendorName}`,
      itemRef: po?.poNumber || id,
      value: `${receivedItems.length} items`,
    });
  },

  // POS Import
  importPOS: (posImport) => {
    const id = makeId('pos', Date.now());
    set((s) => ({ posImports: [{ ...posImport, id }, ...s.posImports] }));
    posImport.items.forEach((saleItem) => {
      if (saleItem.recipeId) {
        const recipe = get().recipes.find((r) => r.id === saleItem.recipeId);
        if (recipe) {
          recipe.ingredients.forEach((ing) => {
            const item = get().inventory.find((i) => i.id === ing.itemId);
            if (item) {
              get().adjustStock(
                ing.itemId,
                Math.max(0, item.currentStock - ing.quantity * saleItem.qtySold),
                'POS import'
              );
            }
          });
        }
      }
    });
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: 'admin',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'POS import',
      detail: 'POS CSV uploaded & reconciled',
      itemRef: posImport.filename,
      value: `${posImport.items.length} items`,
    });
  },

  // Users
  inviteUser: (user) => {
    const id = makeId('u', ++userCounter);
    set((s) => ({ users: [...s.users, { ...user, id }] }));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: 'admin',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'User invite',
      detail: `Invited as ${user.role}`,
      itemRef: user.name,
      value: user.stores.join(', '),
    });
  },

  updateUser: (id, updates) => {
    set((s) => ({
      users: s.users.map((u) => (u.id === id ? { ...u, ...updates } : u)),
    }));
  },

  // Audit
  addAuditEvent: (event) => {
    const id = makeId('a', ++auditCounter);
    set((s) => ({ auditLog: [{ ...event, id }, ...s.auditLog] }));
  },

  // Computed
  getLowStockItems: () => {
    return get().inventory.filter((item) => {
      const status = get().getItemStatus(item);
      return status === 'low' || status === 'out';
    });
  },

  getInventoryValue: () => {
    return get().inventory.reduce(
      (sum, item) => sum + item.currentStock * item.costPerUnit,
      0
    );
  },

  getFoodCostPercent: () => 31.4,

  getWasteThisWeek: () => {
    return get().wasteLog.reduce(
      (sum, entry) => sum + entry.quantity * entry.costPerUnit,
      0
    );
  },

  // Prep recipe cost = sum of ingredient costs
  getPrepRecipeCost: (prepRecipeId) => {
    const prep = get().prepRecipes.find((p) => p.id === prepRecipeId);
    if (!prep) return 0;
    return prep.ingredients.reduce((sum, ing) => {
      const item = get().inventory.find((i) => i.id === ing.itemId);
      return sum + (item ? item.costPerUnit * ing.quantity : 0);
    }, 0);
  },

  // Cost per yield unit (e.g., cost per lb of marinated chicken)
  getPrepRecipeCostPerUnit: (prepRecipeId) => {
    const prep = get().prepRecipes.find((p) => p.id === prepRecipeId);
    if (!prep || prep.yieldQuantity === 0) return 0;
    return get().getPrepRecipeCost(prepRecipeId) / prep.yieldQuantity;
  },

  // Menu recipe cost = raw ingredients + prep recipe portions
  getRecipeCost: (recipeId) => {
    const recipe = get().recipes.find((r) => r.id === recipeId);
    if (!recipe) return 0;

    // Raw ingredient costs
    const rawCost = recipe.ingredients.reduce((sum, ing) => {
      const item = get().inventory.find((i) => i.id === ing.itemId);
      return sum + (item ? item.costPerUnit * ing.quantity : 0);
    }, 0);

    // Prep recipe costs
    const prepCost = (recipe.prepItems || []).reduce((sum, prep) => {
      const costPerUnit = get().getPrepRecipeCostPerUnit(prep.prepRecipeId);
      return sum + costPerUnit * prep.quantity;
    }, 0);

    return rawCost + prepCost;
  },

  getRecipeFoodCostPct: (recipeId) => {
    const recipe = get().recipes.find((r) => r.id === recipeId);
    if (!recipe || recipe.sellPrice === 0) return 0;
    const cost = get().getRecipeCost(recipeId);
    return (cost / recipe.sellPrice) * 100;
  },
}));
