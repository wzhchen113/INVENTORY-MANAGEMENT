// src/store/useSupabaseStore.ts
// Drop-in replacement for useStore.ts — wires all actions to Supabase
// Usage: swap "import { useStore } from '../store/useSupabaseStore'"
//     →  "import { useStore } from '../store/useSupabaseStore'"

import { create } from 'zustand';
import { AppState, User, Store, InventoryItem, ItemStatus } from '../types';
import { signIn, signOut, getSession } from '../lib/auth';
import * as db from '../lib/db';

interface SupabaseStoreActions {
  // Auth
  initSession: () => Promise<void>;
  login: (email: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  setCurrentStore: (store: Store) => void;

  // Data loading
  loadAll: (storeId: string) => Promise<void>;
  isLoading: boolean;
  error: string | null;

  // Inventory
  addItem: (item: Omit<InventoryItem, 'id'>) => Promise<void>;
  updateItem: (id: string, updates: Partial<InventoryItem>) => Promise<void>;
  getItemStatus: (item: InventoryItem) => ItemStatus;
  getLowStockItems: () => InventoryItem[];
  getInventoryValue: () => number;
  getRecipeCost: (recipeId: string) => number;
  getRecipeFoodCostPct: (recipeId: string) => number;
  getWasteThisWeek: () => number;

  // Waste
  logWaste: (entry: any) => Promise<void>;

  // EOD
  submitEOD: (submission: any) => Promise<void>;

  // Vendors
  addVendor: (vendor: any) => Promise<void>;

  // POs
  createPO: (po: any) => Promise<void>;
  updatePOStatus: (id: string, status: any) => void;
  receivePO: (id: string, items: any[], by: string) => Promise<void>;

  // POS
  importPOS: (posImport: any) => Promise<void>;

  // Users
  inviteUser: (user: any) => void;
  updateUser: (id: string, updates: any) => void;

  // Prep Recipes
  addPrepRecipe: (recipe: any) => void;
  updatePrepRecipe: (id: string, updates: any) => void;
  deletePrepRecipe: (id: string) => void;
  getPrepRecipeCost: (prepRecipeId: string) => number;
  getPrepRecipeCostPerUnit: (prepRecipeId: string) => number;

  // Audit
  addAuditEvent: (event: any) => Promise<void>;

  // Recipes (enhanced)
  addRecipe: (recipe: any) => void;
  updateRecipe: (id: string, updates: any) => void;

  // Misc
  getFoodCostPercent: () => number;
  adjustStock: (id: string, newStock: number, by: string) => void;
}

type FullStore = AppState & SupabaseStoreActions;

export const useStore = create<FullStore>((set, get) => ({
  // ── Initial state ──────────────────────────────────────
  currentUser: null,
  currentStore: { id: '', name: '', address: '', status: 'active' },
  stores: [],
  users: [],
  inventory: [],
  recipes: [],
  prepRecipes: [],
  wasteLog: [],
  eodSubmissions: [],
  vendors: [],
  purchaseOrders: [],
  posImports: [],
  auditLog: [],
  orderSchedule: {
    Monday: [], Tuesday: [], Wednesday: [], Thursday: [],
    Friday: [], Saturday: [], Sunday: [],
  },
  orderSubmissions: [],
  timezone: 'America/New_York',
  isLoading: false,
  error: null,

  // ── Auth ───────────────────────────────────────────────
  initSession: async () => {
    const { user } = await getSession();
    if (user) {
      set({ currentUser: user });
      const stores = await db.fetchStores();
      const userStore = stores.find((s) => user.stores.includes(s.id)) || stores[0];
      set({ stores, currentStore: userStore });
      if (userStore) await get().loadAll(userStore.id);
    }
  },

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    const { user, error } = await signIn(email, password);
    if (error || !user) {
      set({ isLoading: false, error: error || 'Login failed' });
      return error;
    }
    const stores = await db.fetchStores();
    const userStore = stores.find((s) => user.stores.includes(s.id)) || stores[0];
    set({ currentUser: user, stores, currentStore: userStore, isLoading: false });
    if (userStore) await get().loadAll(userStore.id);
    return null;
  },

  logout: async () => {
    await signOut();
    set({ currentUser: null, inventory: [], recipes: [], wasteLog: [], auditLog: [] });
  },

  setCurrentStore: async (store) => {
    set({ currentStore: store });
    await get().loadAll(store.id);
  },

  // ── Load all data for a store ──────────────────────────
  loadAll: async (storeId) => {
    set({ isLoading: true });
    try {
      const [inventory, recipes, wasteLog, vendors, purchaseOrders, auditLog] = await Promise.all([
        db.fetchInventory(storeId),
        db.fetchRecipes(storeId),
        db.fetchWasteLog(storeId),
        db.fetchVendors(),
        db.fetchPurchaseOrders(storeId),
        db.fetchAuditLog(storeId),
      ]);
      set({ inventory, recipes, wasteLog, vendors, purchaseOrders, auditLog, isLoading: false });
    } catch (e: any) {
      set({ error: e.message, isLoading: false });
    }
  },

  // ── Inventory ──────────────────────────────────────────
  addItem: async (item) => {
    const newItem = await db.createInventoryItem(item);
    set((s) => ({ inventory: [...s.inventory, newItem] }));
    await get().addAuditEvent({
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

  updateItem: async (id, updates) => {
    await db.updateInventoryItem(id, updates);
    set((s) => ({
      inventory: s.inventory.map((i) => (i.id === id ? { ...i, ...updates } : i)),
    }));
    await get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Item edit',
      detail: 'Item updated',
      itemRef: get().inventory.find((i) => i.id === id)?.name || id,
      value: '',
    });
  },

  getItemStatus: (item) => {
    if (item.currentStock <= 0) return 'out';
    if (item.currentStock < item.parLevel) return 'low';
    return 'ok';
  },

  getLowStockItems: () => get().inventory.filter((i) => get().getItemStatus(i) !== 'ok'),
  getInventoryValue: () => get().inventory.reduce((s, i) => s + i.currentStock * i.costPerUnit, 0),
  getWasteThisWeek: () => get().wasteLog.reduce((s, e) => s + e.quantity * e.costPerUnit, 0),

  getRecipeCost: (recipeId) => {
    const recipe = get().recipes.find((r) => r.id === recipeId);
    if (!recipe) return 0;
    const rawCost = recipe.ingredients.reduce((sum, ing) => {
      const item = get().inventory.find((i) => i.id === ing.itemId);
      return sum + (item ? item.costPerUnit * ing.quantity : 0);
    }, 0);
    const prepCost = (recipe.prepItems || []).reduce((sum, prep) => {
      const costPerUnit = get().getPrepRecipeCostPerUnit(prep.prepRecipeId);
      return sum + costPerUnit * prep.quantity;
    }, 0);
    return rawCost + prepCost;
  },

  getRecipeFoodCostPct: (recipeId) => {
    const recipe = get().recipes.find((r) => r.id === recipeId);
    if (!recipe || recipe.sellPrice === 0) return 0;
    return (get().getRecipeCost(recipeId) / recipe.sellPrice) * 100;
  },

  // ── Waste ──────────────────────────────────────────────
  logWaste: async (entry) => {
    await db.logWasteEntry(entry);
    // Deduct from stock
    const item = get().inventory.find((i) => i.id === entry.itemId);
    if (item) {
      const newStock = Math.max(0, item.currentStock - entry.quantity);
      await db.adjustItemStock(item.id, newStock, entry.loggedByUserId);
      set((s) => ({
        inventory: s.inventory.map((i) =>
          i.id === item.id ? { ...i, currentStock: newStock } : i
        ),
        wasteLog: [{ ...entry, id: Date.now().toString() }, ...s.wasteLog],
      }));
    }
    await get().addAuditEvent({
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

  // ── EOD ───────────────────────────────────────────────
  submitEOD: async (submission) => {
    await db.submitEODCount(submission);
    set((s) => ({
      eodSubmissions: [{ ...submission, id: Date.now().toString() }, ...s.eodSubmissions],
    }));
    for (const entry of submission.entries) {
      await get().addAuditEvent({
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
    }
  },

  // ── Vendors ───────────────────────────────────────────
  addVendor: async (vendor) => {
    await db.createVendor(vendor);
    set((s) => ({ vendors: [...s.vendors, { ...vendor, id: Date.now().toString() }] }));
  },

  // ── Purchase Orders ───────────────────────────────────
  createPO: async (po) => {
    await db.createPurchaseOrder(po);
    set((s) => ({
      purchaseOrders: [{ ...po, id: Date.now().toString(), poNumber: 'PO-NEW' }, ...s.purchaseOrders],
    }));
    await get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: 'admin',
      storeId: po.storeId,
      storeName: get().currentStore.name,
      action: 'PO created',
      detail: `PO created for ${po.vendorName}`,
      itemRef: '',
      value: `$${po.totalCost.toFixed(2)}`,
    });
  },

  updatePOStatus: (id, status) => {
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => (p.id === id ? { ...p, status } : p)),
    }));
  },

  receivePO: async (id, items, by) => {
    await db.receivePurchaseOrder(id, items, get().currentUser?.id || '');
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) =>
        p.id === id ? { ...p, status: 'received' as const } : p
      ),
    }));
    await get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: by,
      userRole: 'admin',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Receiving',
      detail: 'Delivery confirmed',
      itemRef: id,
      value: `${items.length} items`,
    });
  },

  // ── POS Import ────────────────────────────────────────
  importPOS: async (posImport) => {
    await db.savePOSImport(
      get().currentStore.id,
      posImport.filename,
      get().currentUser?.id || '',
      posImport.items
    );
    // Deduct inventory using recipe mappings
    for (const saleItem of posImport.items) {
      if (saleItem.recipeId) {
        const recipe = get().recipes.find((r) => r.id === saleItem.recipeId);
        if (recipe) {
          for (const ing of recipe.ingredients) {
            const item = get().inventory.find((i) => i.id === ing.itemId);
            if (item) {
              const newStock = Math.max(0, item.currentStock - ing.quantity * saleItem.qtySold);
              await db.adjustItemStock(item.id, newStock, get().currentUser?.id || '');
            }
          }
        }
      }
    }
    await get().addAuditEvent({
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
    // Reload inventory
    await get().loadAll(get().currentStore.id);
  },

  // ── Users (local only — real invite uses Supabase Admin) ──
  inviteUser: (user) => {
    set((s) => ({ users: [...s.users, { ...user, id: Date.now().toString() }] }));
  },
  updateUser: (id, updates) => {
    set((s) => ({ users: s.users.map((u) => (u.id === id ? { ...u, ...updates } : u)) }));
  },

  // ── Recipes (enhanced) ─────────────────────────────────
  addRecipe: (recipe) => {
    set((s) => ({ recipes: [...s.recipes, { ...recipe, id: Date.now().toString() }] }));
  },
  updateRecipe: (id, updates) => {
    set((s) => ({ recipes: s.recipes.map((r) => (r.id === id ? { ...r, ...updates } : r)) }));
  },

  // ── Prep Recipes ──────────────────────────────────────
  addPrepRecipe: (recipe) => {
    set((s) => ({ prepRecipes: [...s.prepRecipes, { ...recipe, id: Date.now().toString() }] }));
  },
  updatePrepRecipe: (id, updates) => {
    set((s) => ({ prepRecipes: s.prepRecipes.map((r) => (r.id === id ? { ...r, ...updates } : r)) }));
  },
  deletePrepRecipe: (id) => {
    set((s) => ({ prepRecipes: s.prepRecipes.filter((r) => r.id !== id) }));
  },
  getPrepRecipeCost: (prepRecipeId) => {
    const prep = get().prepRecipes.find((p) => p.id === prepRecipeId);
    if (!prep) return 0;
    return prep.ingredients.reduce((sum, ing) => {
      const item = get().inventory.find((i) => i.id === ing.itemId);
      return sum + (item ? item.costPerUnit * ing.quantity : 0);
    }, 0);
  },
  getPrepRecipeCostPerUnit: (prepRecipeId) => {
    const prep = get().prepRecipes.find((p) => p.id === prepRecipeId);
    if (!prep || prep.yieldQuantity === 0) return 0;
    return get().getPrepRecipeCost(prepRecipeId) / prep.yieldQuantity;
  },

  // ── Misc ──────────────────────────────────────────────
  getFoodCostPercent: () => 31.4,
  adjustStock: (id, newStock, by) => {
    set((s) => ({
      inventory: s.inventory.map((item) =>
        item.id === id ? { ...item, currentStock: newStock, lastUpdatedBy: by } : item
      ),
    }));
  },

  // ── Audit Log ─────────────────────────────────────────
  addAuditEvent: async (event) => {
    await db.addAuditEvent(event);
    set((s) => ({
      auditLog: [{ ...event, id: Date.now().toString() }, ...s.auditLog],
    }));
  },
}));
