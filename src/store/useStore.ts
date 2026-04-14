// src/store/useStore.ts
import { create } from 'zustand';
import {
  AppState, User, InventoryItem, Recipe, WasteEntry,
  EODSubmission, Vendor, POSImport, AppNotification,
  AuditEvent, AuditAction, Store, ItemStatus, PrepRecipe,
  OrderDayVendor, OrderSubmission,
} from '../types';
import {
  STORES, USERS, INVENTORY, RECIPES, VENDORS,
  WASTE_LOG, AUDIT_LOG, PREP_RECIPES,
  EOD_SUBMISSIONS, POS_IMPORTS,
} from '../data/seed';
import * as db from '../lib/db';

interface StoreActions {
  // Auth
  login: (user: User) => void;
  logout: () => void;
  setCurrentStore: (store: Store) => void;
  loadFromSupabase: (storeId?: string) => Promise<void>;

  // Inventory
  addItem: (item: Omit<InventoryItem, 'id'>) => void;
  updateItem: (id: string, updates: Partial<InventoryItem>) => void;
  deleteItem: (id: string) => void;
  adjustStock: (id: string, newStock: number, by: string) => void;
  getItemStatus: (item: InventoryItem) => ItemStatus;

  // Recipe Categories
  addRecipeCategory: (name: string) => void;
  updateRecipeCategory: (oldName: string, newName: string) => void;
  deleteRecipeCategory: (name: string) => void;

  // Ingredient Categories
  addIngredientCategory: (name: string) => void;
  updateIngredientCategory: (oldName: string, newName: string) => void;
  deleteIngredientCategory: (name: string) => void;

  // Recipes
  addRecipe: (recipe: Omit<Recipe, 'id'>) => void;
  updateRecipe: (id: string, updates: Partial<Recipe>) => void;
  deleteRecipe: (id: string) => void;

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
  deleteVendor: (id: string) => void;

  // POS Import
  importPOS: (posImport: Omit<POSImport, 'id'>) => void;

  // Stores
  addStore: (store: Omit<Store, 'id'>) => void;
  updateStore: (id: string, updates: Partial<Store>) => void;

  // Users
  inviteUser: (user: Omit<User, 'id'>) => void;
  updateUser: (id: string, updates: Partial<User>) => void;
  removeUser: (id: string) => void;

  // Orders
  setOrderSchedule: (day: string, vendors: OrderDayVendor[]) => void;
  submitOrder: (submission: Omit<OrderSubmission, 'id'>) => void;
  setTimezone: (tz: string) => void;
  toggleDarkMode: () => void;

  // Notifications
  addNotification: (message: string) => void;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;

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
let auditCounter = AUDIT_LOG.length + 1;
let userCounter = USERS.length + 1;

const makeId = (prefix: string, counter: number) => `${prefix}${counter}`;

export const useStore = create<FullStore>((set, get) => ({
  // Initial state — start logged out, all data loaded from Supabase after login
  currentUser: null,
  currentStore: { id: '', name: '', address: '', status: 'active' as const },
  stores: [],
  users: USERS,
  inventory: INVENTORY,
  recipes: RECIPES,
  recipeCategories: ['Sandwiches & Burgers', 'Over Rice Platters', 'Mains', 'Salads', 'Starters', 'Desserts', 'Sides', 'Drinks'],
  ingredientCategories: ['Protein', 'Seafood', 'Produce', 'Dairy', 'Dry goods', 'Bakery', 'Condiments', 'Drinks', 'Desserts'],
  prepRecipes: PREP_RECIPES,
  wasteLog: WASTE_LOG,
  eodSubmissions: EOD_SUBMISSIONS,
  vendors: VENDORS,
  posImports: POS_IMPORTS,
  auditLog: AUDIT_LOG,
  orderSchedule: {
    Monday: [{ vendorName: 'US Foods', deliveryDay: 'Wednesday' }],
    Tuesday: [{ vendorName: 'Sysco', deliveryDay: 'Thursday' }],
    Wednesday: [{ vendorName: 'Local Farms Co.', deliveryDay: 'Friday' }],
    Thursday: [],
    Friday: [],
    Saturday: [],
    Sunday: [],
  },
  orderSubmissions: [],
  timezone: 'America/New_York',
  darkMode: false,
  notifications: [],
  storeLoading: false,

  // Auth
  login: (user) => {
    set({ currentUser: user });
    // Fetch stores from Supabase, then set current store and load data
    db.fetchStores().then((cloudStores) => {
      const allStores = cloudStores.length > 0 ? cloudStores : get().stores;
      const userStore = allStores.find((s) => user.stores.includes(s.id)) || allStores[0];
      if (allStores.length > 0) set({ stores: allStores });
      if (userStore) {
        set({ currentStore: userStore });
        get().loadFromSupabase(userStore.id);
      }
    }).catch(() => {
      // Fallback to local stores
      const localStore = get().stores.find((s) => user.stores.includes(s.id)) || get().stores[0];
      if (localStore) set({ currentStore: localStore });
    });
  },
  logout: () => {
    set({ currentUser: null });
    import('../lib/auth').then(({ signOut }) => signOut()).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },
  setCurrentStore: (store) => {
    set({ currentStore: store });
    get().loadFromSupabase(store.id);
  },

  loadFromSupabase: async (storeId?: string) => {
    const sid = storeId || get().currentStore?.id;
    if (!sid) return;
    set({ storeLoading: true });
    try {
      // Always fetch stores from Supabase
      const cloudStores = await db.fetchStores().catch(() => []);
      if (cloudStores.length > 0) {
        set({ stores: cloudStores });
      }

      // "All Stores" view — fetch from every store and merge
      if (sid === '__all__') {
        const allStores = get().stores;
        const allData = await Promise.all(
          allStores.map((s) => db.fetchAllForStore(s.id).catch(() => null))
        );
        set({
          inventory: allData.flatMap((d) => d?.inventory || []),
          recipes: allData.flatMap((d) => d?.recipes || []),
          prepRecipes: allData.flatMap((d) => d?.prepRecipes || []),
          vendors: allData.flatMap((d) => d?.vendors || []),
          wasteLog: allData.flatMap((d) => d?.wasteLog || []),
          auditLog: allData.flatMap((d) => d?.auditLog || []),
          ...(allData[0]?.recipeCategories?.length ? { recipeCategories: allData[0].recipeCategories } : {}),
          ...(allData[0]?.ingredientCategories?.length ? { ingredientCategories: allData[0].ingredientCategories } : {}),
        });
        return;
      }

      const data = await db.fetchAllForStore(sid);
      // Cloud is the source of truth — always replace, even if empty
      set({
        inventory: data.inventory,
        recipes: data.recipes,
        prepRecipes: data.prepRecipes,
        vendors: data.vendors,
        wasteLog: data.wasteLog,
        auditLog: data.auditLog,
        ...(data.recipeCategories.length > 0 ? { recipeCategories: data.recipeCategories } : {}),
        ...(data.ingredientCategories.length > 0 ? { ingredientCategories: data.ingredientCategories } : {}),
      });
      // Background cleanup of records older than 90 days
      db.cleanupOldRecords().catch((e: any) => console.warn('[Supabase]', e?.message || e));
    } catch (e) {
      console.log('[Supabase] Load failed, using local data:', e);
    } finally {
      set({ storeLoading: false });
    }
  },

  // Inventory
  addItem: (item) => {
    const id = makeId('i', ++itemCounter);
    const newItem: InventoryItem = { casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: '', ...item, id };
    set((s) => ({ inventory: [...s.inventory, newItem] }));
    // Sync to Supabase
    db.createInventoryItem(item).catch((e) => console.warn('[Supabase] createItem failed:', e?.message || e));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: item.storeId || get().currentStore.id,
      storeName: get().stores.find((s) => s.id === item.storeId)?.name || get().currentStore.name,
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
    db.updateInventoryItem(id, updates).catch((e: any) => console.warn('[Supabase]', e?.message || e));
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

  deleteItem: (id) => {
    const item = get().inventory.find((i) => i.id === id);
    set((s) => ({
      inventory: s.inventory.filter((i) => i.id !== id),
    }));
    db.deleteInventoryItem(id).catch((e: any) => console.warn('[Supabase]', e?.message || e));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Item deleted',
      detail: 'Item removed from store',
      itemRef: item?.name || id,
      value: '',
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
    db.adjustItemStock(id, newStock, get().currentUser?.id || '').catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  getItemStatus: (item) => {
    if (item.currentStock <= 0) return 'out';
    if (item.currentStock < item.parLevel) return 'low';
    return 'ok';
  },

  // Recipe Categories
  addRecipeCategory: (name) => {
    set((s) => ({ recipeCategories: [...s.recipeCategories, name] }));
    db.addRecipeCategory(name).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  updateRecipeCategory: (oldName, newName) => {
    set((s) => ({
      recipeCategories: s.recipeCategories.map((c) => (c === oldName ? newName : c)),
      recipes: s.recipes.map((r) => (r.category === oldName ? { ...r, category: newName } : r)),
    }));
    db.updateRecipeCategory(oldName, newName).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  deleteRecipeCategory: (name) => {
    set((s) => ({ recipeCategories: s.recipeCategories.filter((c) => c !== name) }));
    db.deleteRecipeCategory(name).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  // Ingredient Categories
  addIngredientCategory: (name) => {
    set((s) => ({ ingredientCategories: [...s.ingredientCategories, name] }));
    db.addIngredientCategory(name).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  updateIngredientCategory: (oldName, newName) => {
    set((s) => ({
      ingredientCategories: s.ingredientCategories.map((c) => (c === oldName ? newName : c)),
      inventory: s.inventory.map((i) => (i.category === oldName ? { ...i, category: newName } : i)),
    }));
    db.updateIngredientCategory(oldName, newName).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  deleteIngredientCategory: (name) => {
    set((s) => ({ ingredientCategories: s.ingredientCategories.filter((c) => c !== name) }));
    db.deleteIngredientCategory(name).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  // Recipes
  addRecipe: (recipe) => {
    const id = makeId('r', ++recipeCounter);
    set((s) => ({ recipes: [...s.recipes, { ...recipe, id }] }));
    db.createRecipe(recipe).catch((e: any) => console.warn('[Supabase]', e?.message || e));
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
    db.updateRecipe(id, updates).catch((e: any) => console.warn('[Supabase]', e?.message || e));
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

  deleteRecipe: (id) => {
    const recipe = get().recipes.find((r) => r.id === id);
    set((s) => ({ recipes: s.recipes.filter((r) => r.id !== id) }));
    db.deleteRecipe(id).catch((e: any) => console.warn('[Supabase]', e?.message || e));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Recipe deleted',
      detail: 'Recipe removed',
      itemRef: recipe?.menuItem || id,
      value: '',
    });
  },

  // Prep Recipes
  addPrepRecipe: (recipe) => {
    const id = makeId('pr', ++prepRecipeCounter);
    set((s) => ({ prepRecipes: [...s.prepRecipes, { ...recipe, id }] }));
    db.createPrepRecipe(recipe).catch((e: any) => console.warn('[Supabase]', e?.message || e));
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
    // Capture storeId BEFORE mutating state (prevents race condition in multi-store loops)
    const storeId = get().prepRecipes.find((r) => r.id === id)?.storeId;
    set((s) => ({
      prepRecipes: s.prepRecipes.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    }));
    // Use versioned update to preserve historical records
    db.updatePrepRecipeVersioned(id, { ...updates, storeId })
      .then((newId) => {
        // Replace old ID with new versioned ID in local state
        set((s) => ({ prepRecipes: s.prepRecipes.map((r) => r.id === id ? { ...r, id: newId } : r) }));
      })
      .catch((e: any) => {
        // Fallback to non-versioned update
        db.updatePrepRecipe(id, updates).catch(() => {});
        console.warn('[Supabase] versioned update failed, fell back:', e?.message);
      });
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
    db.deletePrepRecipe(id).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  // Waste
  logWaste: (entry) => {
    const id = makeId('w', ++wasteCounter);
    set((s) => ({ wasteLog: [{ ...entry, id }, ...s.wasteLog] }));
    db.logWasteEntry(entry).catch((e: any) => console.warn('[Supabase]', e?.message || e));
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
    // Check if this is an update to an existing submission
    const existing = get().eodSubmissions.find(
      (s) =>
        s.submittedByUserId === submission.submittedByUserId &&
        s.storeId === submission.storeId &&
        s.date === submission.date
    );

    if (existing) {
      // Update existing submission
      set((s) => ({
        eodSubmissions: s.eodSubmissions.map((sub) =>
          sub.id === existing.id
            ? { ...sub, entries: submission.entries, timestamp: submission.timestamp }
            : sub
        ),
      }));
    } else {
      // New submission
      const id = makeId('eod', Date.now());
      set((s) => ({ eodSubmissions: [{ ...submission, id }, ...s.eodSubmissions] }));
    }

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
        detail: existing ? 'Count updated' : 'Remaining count submitted',
        itemRef: entry.itemName,
        value: `${entry.actualRemaining} ${entry.unit}`,
      });
    });
  },

  // Vendors
  addVendor: (vendor) => {
    const id = makeId('v', ++vendorCounter);
    set((s) => ({ vendors: [...s.vendors, { ...vendor, id }] }));
    db.createVendor(vendor).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  updateVendor: (id, updates) => {
    set((s) => ({
      vendors: s.vendors.map((v) => (v.id === id ? { ...v, ...updates } : v)),
    }));
    db.updateVendor(id, updates).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  deleteVendor: (id) => {
    set((s) => ({ vendors: s.vendors.filter((v) => v.id !== id) }));
    db.deleteVendor(id).catch((e: any) => console.warn('[Supabase]', e?.message || e));
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
              const { getConversionFactor } = require('../utils/unitConversion');
              const factor = getConversionFactor(ing.unit, item.unit);
              const convertedQty = factor !== null ? ing.quantity * factor : ing.quantity;
              get().adjustStock(
                ing.itemId,
                Math.max(0, item.currentStock - convertedQty * saleItem.qtySold),
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

  // Stores
  addStore: (store) => {
    const id = `s${Date.now()}`;
    set((s) => ({ stores: [...s.stores, { ...store, id }] }));
    db.createStore(store).then((newId) => {
      set((s) => ({ stores: s.stores.map((st) => st.id === id ? { ...st, id: newId } : st) }));
    }).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  updateStore: (id, updates) => {
    set((s) => ({
      stores: s.stores.map((st) => st.id === id ? { ...st, ...updates } : st),
      currentStore: s.currentStore.id === id ? { ...s.currentStore, ...updates } : s.currentStore,
    }));
    const { supabase } = require('../lib/supabase');
    supabase.from('stores').update({ name: updates.name, address: updates.address }).eq('id', id).catch((e: any) => console.warn('[Supabase]', e?.message || e));
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
      currentUser: s.currentUser?.id === id ? { ...s.currentUser, ...updates } : s.currentUser,
    }));
  },

  removeUser: (id) => {
    set((s) => ({ users: s.users.filter((u) => u.id !== id) }));
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'User deleted',
      detail: 'User account removed',
      itemRef: id,
      value: '',
    });
  },

  // Orders
  setOrderSchedule: (day, vendors) => {
    set((s) => ({
      orderSchedule: { ...s.orderSchedule, [day]: vendors },
    }));
  },

  submitOrder: (submission) => {
    const id = `ord${Date.now()}`;
    set((s) => ({ orderSubmissions: [...s.orderSubmissions, { ...submission, id }] }));
  },

  setTimezone: (tz) => {
    set({ timezone: tz });
  },

  toggleDarkMode: () => {
    set((s) => ({ darkMode: !s.darkMode }));
  },

  // Notifications
  addNotification: (message) => {
    const id = `notif-${Date.now()}`;
    const notif: AppNotification = { id, message, timestamp: new Date().toISOString(), read: false };
    set((s) => ({ notifications: [notif, ...s.notifications] }));
  },
  markNotificationRead: (id) => {
    set((s) => ({ notifications: s.notifications.map((n) => n.id === id ? { ...n, read: true } : n) }));
  },
  clearNotifications: () => {
    set({ notifications: [] });
  },

  // Audit — write only to Supabase, loaded on next refresh via loadFromSupabase
  addAuditEvent: (event) => {
    db.addAuditEvent(event).catch((e: any) => console.warn('[Supabase]', e?.message || e));
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

  // Prep recipe cost = sum of ingredient costs (supports sub-recipes with cycle guard)
  getPrepRecipeCost: (prepRecipeId) => {
    const calcCost = (id: string, visited: Set<string>): number => {
      if (visited.has(id)) return 0; // cycle detected
      visited.add(id);
      const prep = get().prepRecipes.find((p) => p.id === id);
      if (!prep) return 0;
      const { getConversionFactor } = require('../utils/unitConversion');
      return prep.ingredients.reduce((sum, ing) => {
        const isSubRecipe = (ing.type || 'raw') === 'prep';
        if (isSubRecipe) {
          // Sub-recipe: get cost per unit of the referenced prep recipe
          const subRecipe = get().prepRecipes.find((p) => p.id === ing.itemId);
          if (!subRecipe) return sum;
          const subCost = calcCost(ing.itemId, new Set(visited));
          const subYield = subRecipe.yieldQuantity || 1;
          const costPerUnit = subYield > 0 ? subCost / subYield : 0;
          const factor = getConversionFactor(ing.unit, subRecipe.yieldUnit);
          const convertedQty = factor !== null ? ing.quantity * factor : ing.quantity;
          return sum + costPerUnit * convertedQty;
        }
        // Raw ingredient
        const item = get().inventory.find((i) => i.id === ing.itemId) ||
          get().inventory.find((i) => i.name.toLowerCase() === ing.itemName.toLowerCase());
        if (!item) return sum;
        let factor = getConversionFactor(ing.unit, item.subUnitUnit || item.unit);
        if (factor === null && item.subUnitUnit) factor = getConversionFactor(ing.unit, item.unit);
        if (factor === null) return sum; // Can't convert — skip rather than inflate
        return sum + item.costPerUnit * ing.quantity * factor;
      }, 0);
    };
    return calcCost(prepRecipeId, new Set());
  },

  // Cost per yield unit (e.g., cost per lb of marinated chicken)
  getPrepRecipeCostPerUnit: (prepRecipeId) => {
    const prep = get().prepRecipes.find((p) => p.id === prepRecipeId);
    if (!prep) return 0;
    // Live yield calculation (don't trust stored yieldQuantity — may have corrupt baseQuantity)
    const { smartToBase } = require('../utils/unitConversion');
    let yG = 0, yF = 0;
    for (const ing of prep.ingredients) {
      const b = smartToBase(ing.quantity, ing.unit);
      if (b.unit === 'fl_oz') yF += b.quantity; else yG += b.quantity;
    }
    let yieldQty = prep.yieldQuantity;
    if (prep.ingredients.length > 0) {
      if (yF > 0 && yG === 0) {
        yieldQty = yF >= 128 ? yF / 128 : yF >= 32 ? yF / 32 : yF;
      } else if (yG > 0 && yF === 0) {
        yieldQty = yG >= 453.592 ? yG / 453.592 : yG >= 28.35 ? yG / 28.3495 : yG;
      } else {
        const t = yG + yF * 29.5735;
        yieldQty = t >= 453.592 ? t / 453.592 : t;
      }
    }
    if (yieldQty === 0) return 0;
    return get().getPrepRecipeCost(prepRecipeId) / yieldQty;
  },

  // Menu recipe cost = raw ingredients + prep recipe portions
  getRecipeCost: (recipeId) => {
    const recipe = get().recipes.find((r) => r.id === recipeId);
    if (!recipe) return 0;

    // Raw ingredient costs (with unit conversion)
    const { getConversionFactor } = require('../utils/unitConversion');
    const rawCost = recipe.ingredients.reduce((sum, ing) => {
      const item = get().inventory.find((i) => i.id === ing.itemId) ||
        get().inventory.find((i) => i.name.toLowerCase() === ing.itemName?.toLowerCase());
      if (!item) return sum;
      // Try subUnitUnit first, then item.unit, skip if neither converts
      let factor = getConversionFactor(ing.unit, item.subUnitUnit || item.unit);
      if (factor === null && item.subUnitUnit) factor = getConversionFactor(ing.unit, item.unit);
      if (factor === null) return sum; // Can't convert (e.g. g → each) — skip rather than inflate
      return sum + item.costPerUnit * ing.quantity * factor;
    }, 0);

    // Prep recipe costs
    const prepCost = (recipe.prepItems || []).reduce((sum, prep) => {
      const subRecipe = get().prepRecipes.find((p) => p.id === prep.prepRecipeId);
      if (!subRecipe) return sum;
      const costPerUnit = get().getPrepRecipeCostPerUnit(prep.prepRecipeId);
      const factor = getConversionFactor(prep.unit, subRecipe.yieldUnit);
      const convertedQty = factor !== null ? prep.quantity * factor : prep.quantity;
      return sum + costPerUnit * convertedQty;
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
