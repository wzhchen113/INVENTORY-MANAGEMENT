// src/store/useStore.ts
import { create } from 'zustand';
import {
  AppState, User, InventoryItem, Recipe, WasteEntry,
  EODSubmission, Vendor, POSImport, AppNotification,
  AuditEvent, AuditAction, Store, ItemStatus, PrepRecipe,
  OrderDayVendor, OrderSubmission, ReportDefinition,
  IngredientConversion, SidebarLayoutOverride, CatalogIngredient,
  Brand,
} from '../types';
import {
  STORES, USERS, INVENTORY, RECIPES, VENDORS,
  WASTE_LOG, AUDIT_LOG, PREP_RECIPES,
  EOD_SUBMISSIONS, POS_IMPORTS,
} from '../data/seed';
import * as db from '../lib/db';
import { supabase } from '../lib/supabase';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';

// Surface a backend failure to the user instead of swallowing it in
// console.warn. Used by the recipe + prep recipe CRUD paths to revert
// optimistic local-state mutations and tell the admin what happened.
function notifyBackendError(action: string, e: any) {
  const message = e?.message || String(e);
  console.warn(`[Supabase] ${action} failed:`, message);
  Toast.show({
    type: 'error',
    text1: `${action} failed`,
    text2: message,
    visibilityTime: 5000,
  });
}

const DARK_MODE_KEY = 'darkMode';

// Spec 012b — super-admin's active-brand override key. Tab-scoped via
// localStorage on web; per-install on native via AsyncStorage. Cleared
// at login so a fresh session always starts in "All brands" mode.
// Cleanup #9 — exported so App.tsx imports it instead of duplicating.
export const ACTIVE_BRAND_KEY = 'imr.cmd.superAdmin.activeBrand';

// Fire-and-forget local cache so the boot-time hydrator in App.tsx can
// restore the theme before the first paint, without waiting on Supabase.
function persistDarkModeLocal(value: boolean) {
  try {
    if (Platform.OS === 'web') {
      window.localStorage.setItem(DARK_MODE_KEY, String(value));
    } else {
      AsyncStorage.setItem(DARK_MODE_KEY, String(value)).catch(() => { /* best-effort */ });
    }
  } catch { /* best-effort */ }
}

function persistActiveBrandLocal(brandId: string | null) {
  try {
    const v = brandId ?? '';
    if (Platform.OS === 'web') {
      window.localStorage.setItem(ACTIVE_BRAND_KEY, v);
    } else {
      AsyncStorage.setItem(ACTIVE_BRAND_KEY, v).catch(() => { /* best-effort */ });
    }
  } catch { /* best-effort */ }
}

function clearActiveBrandLocal() {
  try {
    if (Platform.OS === 'web') {
      window.localStorage.removeItem(ACTIVE_BRAND_KEY);
    } else {
      AsyncStorage.removeItem(ACTIVE_BRAND_KEY).catch(() => { /* best-effort */ });
    }
  } catch { /* best-effort */ }
}

interface StoreActions {
  // Auth
  login: (user: User) => void;
  logout: () => void;
  setCurrentStore: (store: Store) => void;
  loadFromSupabase: (storeId?: string) => Promise<void>;

  // Spec 012b — super-admin brand context.
  /**
   * Set the super-admin's explicit brand-context override. NULL = "All
   * brands" mode (clears currentStore so per-store sections render an
   * empty state and the consumer can navigate to BrandsSection). Non-null
   * picks the first store in that brand and triggers loadFromSupabase
   * via setCurrentStore.
   */
  setCurrentBrandId: (brandId: string | null) => void;
  /** Spec 012b — load the full brands list (super-admin only). Called
   *  after login when currentUser.role === 'super_admin'. Idempotent. */
  loadBrandsList: () => Promise<void>;
  /** Spec 012b — INSERT a brand. Optimistic-then-revert via
   *  notifyBackendError. RLS gates to super-admin. */
  createBrand: (name: string) => Promise<Brand | null>;
  /** Spec 012b cleanup #2 — store-owned mirror of fetchBrandsWithStats.
   *  BrandsSection consumes this slice instead of calling db.ts directly,
   *  matching every other section under src/screens/cmd/sections/.
   *  012c cleanup SF #6: post-012c the slice may contain soft-deleted
   *  brands too if any consumer last invoked `loadBrandStatsIncludingDeleted`
   *  rather than `loadBrandStats`. Filter by `deletedAt == null` if you
   *  need active-only. (Future spec should split into two slices for
   *  cleaner separation.) */
  brandStats: Array<Brand & { storeCount: number; memberCount: number; catalogIngredientCount: number }>;
  loadBrandStats: () => Promise<void>;
  /** Spec 012b cleanup #2 — per-brand admin lists, keyed by brandId. */
  brandAdminsByBrandId: Record<string, User[]>;
  loadBrandAdmins: (brandId: string) => Promise<void>;

  // Spec 012c — brand lifecycle (rename, soft-delete, restore, preview,
  // hard-delete, audit log) + Q-ARCH-1 profile mutations on the members
  // tab (demote, delete). All super-admin-only at the RLS / RPC layer;
  // the UI also gates on useIsSuperAdmin().
  /** Rename a brand. Optimistic-then-revert via notifyBackendError. */
  renameBrand: (brandId: string, newName: string) => Promise<boolean>;
  /** Soft-delete a brand. Optimistic — moves the row to the soft-deleted
   *  partition. If brandId === currentBrandId, also auto-swaps to null
   *  (per AC S5) and surfaces a toast. Revert on backend error. */
  softDeleteBrand: (brandId: string) => Promise<boolean>;
  /** Restore a soft-deleted brand. Optimistic. Per Q-ARCH-3 does NOT
   *  touch currentBrandId. Revert on backend error. */
  restoreBrand: (brandId: string) => Promise<boolean>;
  /** Preview the cascade — wraps db.previewBrandCascade. No optimistic
   *  state mutation; just returns the payload to the caller. */
  previewBrandCascade: (brandId: string) => Promise<db.BrandCascadePreview | null>;
  /** Hard-delete a brand. NO optimistic mutation — destructive enough
   *  that the UI waits for server confirmation. After success, drops
   *  the row from brandStats / brandsList; if brandId === currentBrandId,
   *  auto-swaps to null. Errors surface via notifyBackendError. */
  hardDeleteBrand: (brandId: string) => Promise<db.BrandCascadePreview | null>;
  /** Variant of loadBrandStats that includes soft-deleted brands.
   *  Powers the Trash sub-tab. */
  loadBrandStatsIncludingDeleted: () => Promise<void>;
  /** brand_deletion_log audit slice — keyed by brandId, or `__all__`
   *  for the unfiltered call. */
  brandDeletionLog: Record<string, db.BrandDeletionLogEntry[]>;
  loadBrandDeletionLog: (brandId?: string) => Promise<void>;
  /** Spec 012c (Q-ARCH-1) — demote an admin/master profile to user.
   *  Optimistic-then-revert. Wraps db.demoteProfileToUser, which also
   *  clears `brand_id` so the row stops counting toward the H5
   *  blocking-profile total. */
  demoteProfileToUser: (profileId: string) => Promise<boolean>;
  /** Spec 012c (Q-ARCH-1) — irreversibly delete a profile + auth user.
   *  NO optimistic mutation. Wraps the existing auth.deleteUser edge
   *  function call. On success, drops the row from any cached members
   *  lists. On error, notifyBackendError. */
  deleteProfile: (profileId: string) => Promise<boolean>;

  // Inventory
  addItem: (item: Omit<InventoryItem, 'id'>) => void;
  updateItem: (id: string, updates: Partial<InventoryItem>) => void;
  deleteItem: (id: string) => void;
  adjustStock: (id: string, newStock: number, by: string) => void;
  getItemStatus: (item: InventoryItem) => ItemStatus;

  // Catalog (brand-level master records)
  /**
   * Spec 010: optimistic update of a catalog_ingredients row's
   * brand-shared fields (today: `defaultShelfLifeDays`). Writes through
   * `db.updateCatalogIngredient`; reverts the local catalogIngredients
   * slice on failure via `notifyBackendError`. Catalog-only fields
   * already round-tripped via `updateItem` (name/unit/category/case_qty
   * /sub_unit_*) stay there for back-compat.
   */
  updateCatalogIngredient: (
    catalogId: string,
    patch: { defaultShelfLifeDays?: number | null },
  ) => void;

  // Recipe Categories
  addRecipeCategory: (name: string) => void;
  updateRecipeCategory: (oldName: string, newName: string) => void;
  deleteRecipeCategory: (name: string) => void;

  // Ingredient Categories
  addIngredientCategory: (name: string) => void;
  updateIngredientCategory: (oldName: string, newName: string) => void;
  deleteIngredientCategory: (name: string) => void;

  // Ingredient Conversions (Spec 004 — write UI on CatalogConversionsTab)
  addIngredientConversion: (conv: Omit<IngredientConversion, 'id'>) => void;
  updateIngredientConversion: (id: string, patch: Partial<IngredientConversion>) => void;
  deleteIngredientConversion: (id: string) => void;

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

  // POS recipe aliases (POS-name → recipe_id mappings, store-scoped)
  upsertPosRecipeAliases: (rows: { posName: string; recipeId: string }[]) => Promise<void>;
  applyAliasToPastImports: (posName: string, recipeId: string) => Promise<number>;

  // Stores
  addStore: (store: Omit<Store, 'id'>) => void;
  updateStore: (id: string, updates: Partial<Store>) => void;

  // Users
  inviteUser: (user: Omit<User, 'id'>) => void;
  updateUser: (id: string, updates: Partial<User>) => void;
  removeUser: (id: string) => void;

  // Orders
  setOrderSchedule: (day: string, vendors: OrderDayVendor[]) => void;
  /** Spec 007 §3 — add a single (store, day, vendor) row to the schedule.
   *  Optimistic; reverts on failure via notifyBackendError. day must be
   *  TitleCase ("Monday".."Sunday"). */
  addOrderScheduleEntry: (
    day: string,
    vendor: { vendorId: string; vendorName: string; deliveryDay?: string },
  ) => void;
  /** Spec 007 §3 — remove a single (store, day, vendor) row. Optimistic;
   *  reverts on failure via notifyBackendError. */
  removeOrderScheduleEntry: (day: string, vendorId: string) => void;
  submitOrder: (submission: Omit<OrderSubmission, 'id'>) => void;
  setTimezone: (tz: string) => void;
  toggleDarkMode: () => void;
  /** Apply a dark-mode value WITHOUT persisting — used at boot to restore
   *  the cached / DB-stored preference. */
  setDarkMode: (value: boolean) => void;

  // Sidebar layout (Spec 008)
  /**
   * Apply a sidebar override value WITHOUT persisting — used at boot to
   * restore the DB-stored value into local state. Mirrors `setDarkMode`
   * (no-persist hydrator) vs `toggleDarkMode` (persisting setter).
   * See spec 008 §3 — avoids the redundant UPDATE-on-login round-trip.
   */
  hydrateSidebarLayoutOverride: (override: SidebarLayoutOverride | null) => void;
  /**
   * Persist the user's Cmd UI sidebar override list (or `null` to reset
   * to the hardcoded default). Optimistic-then-revert: writes local state
   * first, then `db.saveSidebarLayout`; on error reverts and surfaces via
   * `notifyBackendError`. Save-on-done semantics — caller passes the full
   * override list, not partial diffs. See spec 008 §4 / §6.
   */
  setSidebarLayoutOverride: (override: SidebarLayoutOverride | null) => void;

  // Notifications
  addNotification: (message: string) => void;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;

  // Audit
  addAuditEvent: (event: Omit<AuditEvent, 'id'>) => void;

  // Saved reports (Phase 12f)
  addReportDefinition: (rep: Omit<ReportDefinition, 'id' | 'createdAt'>) => void;
  deleteReportDefinition: (id: string) => void;

  // Computed
  getLowStockItems: () => InventoryItem[];
  getInventoryValue: () => number;
  getFoodCostPercent: () => number;
  getWasteThisWeek: () => number;
  getRecipeCost: (recipeId: string) => number;
  getRecipeFoodCostPct: (recipeId: string) => number;
  getPrepRecipeCost: (prepRecipeId: string) => number;
  getPrepRecipeCostPerUnit: (prepRecipeId: string) => number;
  getIngredientLineCost: (ing: { itemId: string; itemName?: string; quantity: number; unit: string }) => number;
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
  currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' as const },
  brand: null,
  catalogIngredients: [],
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
  posRecipeAliases: [],
  auditLog: AUDIT_LOG,
  // Start empty — real schedule comes from Supabase via loadFromSupabase.
  // Demo vendors used to live here but leaked into fresh users' Orders
  // screens whenever their store had no order_schedule rows in DB yet.
  orderSchedule: {
    Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [],
  },
  orderSubmissions: [],
  timezone: 'America/New_York',
  darkMode: false,
  // Spec 008: null = uncustomized. Hydrated from profiles.sidebar_layout
  // at login (App.tsx) and mutated by setSidebarLayoutOverride.
  sidebarLayoutOverride: null,
  notifications: [],
  storeLoading: false,
  ingredientConversions: [] as IngredientConversion[],
  savedReports: [],
  // Spec 012b — super-admin brand context. NULL = "All brands" mode,
  // hidden for non-super-admin (the picker doesn't render).
  currentBrandId: null,
  brandsList: [] as Brand[],
  // Spec 012b cleanup #2 — store-owned brand stats + admins. Empty until
  // a super-admin opens BrandsSection.
  brandStats: [] as Array<Brand & { storeCount: number; memberCount: number; catalogIngredientCount: number }>,
  brandAdminsByBrandId: {} as Record<string, User[]>,
  // Spec 012c — audit-log slice keyed by brandId or `__all__`.
  brandDeletionLog: {} as Record<string, db.BrandDeletionLogEntry[]>,

  // Auth
  login: (user) => {
    set({ currentUser: user });
    // Spec 012b — clear any stale super-admin active-brand override on
    // login so a fresh session always starts in "All brands" mode.
    // localStorage value persists across tab reloads but not across logins.
    clearActiveBrandLocal();
    set({ currentBrandId: null, brandsList: [] });
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
    // Spec 012b — super-admin gets the brand picker; preload the full
    // brands list so the dropdown renders immediately on first open.
    if (user.role === 'super_admin') {
      get().loadBrandsList().catch(() => { /* logged inside */ });
    }
  },
  logout: () => {
    set({ currentUser: null });
    // Spec 012b — drop super-admin brand context on logout.
    clearActiveBrandLocal();
    set({ currentBrandId: null, brandsList: [], brandStats: [], brandAdminsByBrandId: {}, brandDeletionLog: {} });
    import('../lib/auth').then(({ signOut }) => signOut()).catch((e: any) => console.warn('[Supabase]', e?.message || e));
    // Drop web-push subscription for this browser so the user doesn't keep
    // getting reminders for a store they no longer have access to.
    import('../lib/webPush').then(({ unsubscribeFromPush }) => unsubscribeFromPush()).catch(() => {});
  },
  setCurrentStore: (store) => {
    // Legacy "All Stores" mode is gone — the dashboard now shows one focal
    // store with a fleet-wide EOD overview alongside it. If anything still
    // tries to set __all__, redirect to the first store the user can see so
    // we don't end up with a phantom store id and broken loadFromSupabase.
    if (store.id === '__all__') {
      const user = get().currentUser;
      const accessible = user?.role === 'admin' || user?.role === 'master' || user?.role === 'super_admin'
        ? get().stores
        : get().stores.filter((s) => user?.stores.includes(s.id));
      const fallback = accessible[0] || get().stores[0];
      if (!fallback) return;
      set({ currentStore: fallback });
      get().loadFromSupabase(fallback.id);
      return;
    }
    set({ currentStore: store });
    get().loadFromSupabase(store.id);
  },

  // Spec 012b — super-admin brand context.
  setCurrentBrandId: (brandId) => {
    const prev = get().currentBrandId;
    if (prev === brandId) return;

    persistActiveBrandLocal(brandId);
    set({ currentBrandId: brandId });

    if (brandId === null) {
      // "All brands" mode — clear currentStore so per-store sections
      // don't render stale data. The consumer (ResponsiveCmdShell)
      // forces section to "Brands" via a paletteAction request.
      set({
        currentStore: { id: '', brandId: '', name: '', address: '', status: 'active' },
        brand: null,
      });
      return;
    }

    // Brand-switch — re-derive currentStore for the new brand. Pick the
    // first store the user can see in the new brand. Super-admin sees
    // every store via 012a's RLS. setCurrentStore triggers
    // loadFromSupabase as a side-effect; that fetcher writes the `brand`
    // slice from fetchBrandForStore.
    const newStore = get().stores.find((s) => s.brandId === brandId);
    if (newStore) {
      get().setCurrentStore(newStore);
    } else {
      // Fresh brand with no stores yet — clear currentStore. Sections
      // will render empty states; the operator's first task is to add
      // a store inside the brand.
      const placeholder: Store = { id: '', brandId, name: '', address: '', status: 'active' };
      const matchingBrand = get().brandsList.find((b) => b.id === brandId);
      set({
        currentStore: placeholder,
        brand: matchingBrand ? { id: matchingBrand.id, name: matchingBrand.name } : null,
      });
    }
  },

  loadBrandsList: async () => {
    try {
      const list = await db.fetchBrandsLite({ includeSoftDeleted: false });
      set({ brandsList: list });
    } catch (e: any) {
      console.warn('[Supabase] loadBrandsList:', e?.message || e);
    }
  },

  createBrand: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    // Optimistic insert with a temp id so the UI updates immediately.
    const tempId = `tmp-brand-${Date.now()}`;
    const optimistic: Brand = { id: tempId, name: trimmed, deletedAt: null, createdAt: new Date().toISOString() };
    const prev = get().brandsList;
    set({ brandsList: [...prev, optimistic].sort((a, b) => a.name.localeCompare(b.name)) });
    try {
      const created = await db.createBrand(trimmed);
      // Swap temp id for server-assigned UUID.
      set({
        brandsList: get().brandsList
          .map((b) => (b.id === tempId ? created : b))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
      // Cleanup #6 — re-fetch brandStats so the BrandsSection list pane
      // shows the new brand without requiring navigate-away-and-back.
      get().loadBrandStats().catch(() => { /* logged inside */ });
      return created;
    } catch (e: any) {
      // Revert.
      set({ brandsList: prev });
      notifyBackendError('Create brand', e);
      return null;
    }
  },

  // Cleanup #2 — store-owned brand stats. BrandsSection consumes via the
  // `brandStats` slice + `loadBrandStats` action instead of importing
  // db.ts directly.
  loadBrandStats: async () => {
    try {
      const rows = await db.fetchBrandsWithStats();
      set({ brandStats: rows });
    } catch (e: any) {
      console.warn('[Supabase] loadBrandStats:', e?.message || e);
      set({ brandStats: [] });
    }
  },

  // Cleanup #2 — per-brand admin lists. BrandsSection's detail pane
  // dispatches this when the selection changes; result is keyed by brandId
  // so multiple opened detail tabs don't trample each other's data.
  loadBrandAdmins: async (brandId) => {
    if (!brandId) return;
    try {
      const rows = await db.fetchBrandAdmins(brandId);
      set({
        brandAdminsByBrandId: {
          ...get().brandAdminsByBrandId,
          [brandId]: rows,
        },
      });
    } catch (e: any) {
      console.warn('[Supabase] loadBrandAdmins:', e?.message || e);
    }
  },

  // ── Spec 012c — brand lifecycle actions ───────────────────────────
  renameBrand: async (brandId, newName) => {
    const trimmed = newName.trim();
    if (!brandId || !trimmed) return false;
    const prevList = get().brandsList;
    const prevStats = get().brandStats;
    const prevBrand = get().brand;
    // Optimistic.
    set({
      brandsList: prevList.map((b) => (b.id === brandId ? { ...b, name: trimmed } : b)),
      brandStats: prevStats.map((b) => (b.id === brandId ? { ...b, name: trimmed } : b)),
      brand: prevBrand && prevBrand.id === brandId ? { ...prevBrand, name: trimmed } : prevBrand,
    });
    try {
      await db.renameBrand(brandId, trimmed);
      return true;
    } catch (e: any) {
      // Revert all three slices.
      set({ brandsList: prevList, brandStats: prevStats, brand: prevBrand });
      notifyBackendError('Rename brand', e);
      return false;
    }
  },

  softDeleteBrand: async (brandId) => {
    if (!brandId) return false;
    const prevList = get().brandsList;
    const prevStats = get().brandStats;
    const prevBrandId = get().currentBrandId;
    const target = prevStats.find((b) => b.id === brandId) ?? prevList.find((b) => b.id === brandId);
    const brandName = target?.name || 'brand';
    const nowISO = new Date().toISOString();
    // Optimistic — flip deletedAt locally; the Trash partition picks
    // up the row on next render.
    set({
      brandsList: prevList.map((b) => (b.id === brandId ? { ...b, deletedAt: nowISO } : b)),
      brandStats: prevStats.map((b) => (b.id === brandId ? { ...b, deletedAt: nowISO } : b)),
    });
    // Auto-swap currentBrandId if the soft-deleted brand was active.
    if (prevBrandId === brandId) {
      get().setCurrentBrandId(null);
      Toast.show({
        type: 'info',
        text1: `Brand "${brandName}" was deleted`,
        text2: 'Switched to All brands view.',
        visibilityTime: 4000,
      });
    }
    try {
      await db.softDeleteBrand(brandId);
      return true;
    } catch (e: any) {
      // Revert. Cleanup SF #4 — restore brandsList + brandStats. Restore
      // currentBrandId via `set` directly instead of `setCurrentBrandId`
      // because the latter triggers a full `loadFromSupabase` which we
      // don't want on a failed RPC (the local data is already correct).
      set({ brandsList: prevList, brandStats: prevStats });
      if (prevBrandId === brandId) {
        persistActiveBrandLocal(prevBrandId);
        set({ currentBrandId: prevBrandId });
      }
      notifyBackendError('Soft-delete brand', e);
      return false;
    }
  },

  restoreBrand: async (brandId) => {
    if (!brandId) return false;
    const prevList = get().brandsList;
    const prevStats = get().brandStats;
    // Optimistic — Q-ARCH-3 says we do NOT auto-swap currentBrandId.
    set({
      brandsList: prevList.map((b) => (b.id === brandId ? { ...b, deletedAt: null } : b)),
      brandStats: prevStats.map((b) => (b.id === brandId ? { ...b, deletedAt: null } : b)),
    });
    try {
      await db.restoreBrand(brandId);
      return true;
    } catch (e: any) {
      set({ brandsList: prevList, brandStats: prevStats });
      notifyBackendError('Restore brand', e);
      return false;
    }
  },

  previewBrandCascade: async (brandId) => {
    if (!brandId) return null;
    try {
      return await db.previewBrandCascade(brandId);
    } catch (e: any) {
      notifyBackendError('Preview brand cascade', e);
      return null;
    }
  },

  hardDeleteBrand: async (brandId) => {
    if (!brandId) return null;
    try {
      const result = await db.hardDeleteBrand(brandId);
      // After server confirms, remove from all brand slices.
      set({
        brandsList: get().brandsList.filter((b) => b.id !== brandId),
        brandStats: get().brandStats.filter((b) => b.id !== brandId),
      });
      const brandName = result.brandName || 'brand';
      if (get().currentBrandId === brandId) {
        get().setCurrentBrandId(null);
        Toast.show({
          type: 'info',
          text1: `Brand "${brandName}" was purged`,
          text2: 'Switched to All brands view.',
          visibilityTime: 4000,
        });
      } else {
        Toast.show({
          type: 'success',
          text1: `Purged "${brandName}"`,
          text2: 'Cascade complete — brand and all attached data erased.',
          visibilityTime: 4000,
        });
      }
      return result;
    } catch (e: any) {
      notifyBackendError('Hard-delete brand', e);
      return null;
    }
  },

  loadBrandStatsIncludingDeleted: async () => {
    try {
      const rows = await db.fetchBrandsWithStats({ includeSoftDeleted: true });
      set({ brandStats: rows });
    } catch (e: any) {
      console.warn('[Supabase] loadBrandStatsIncludingDeleted:', e?.message || e);
    }
  },

  loadBrandDeletionLog: async (brandId) => {
    try {
      const rows = await db.fetchBrandDeletionLog(brandId ? { brandId } : undefined);
      const key = brandId || '__all__';
      set({
        brandDeletionLog: {
          ...get().brandDeletionLog,
          [key]: rows,
        },
      });
    } catch (e: any) {
      console.warn('[Supabase] loadBrandDeletionLog:', e?.message || e);
    }
  },

  demoteProfileToUser: async (profileId) => {
    if (!profileId) return false;
    // Optimistic — flip the role pill across every cached members list
    // that contains this profile. Spec §7: members tab re-renders from
    // the cache so the row visually moves to the USER partition.
    const prevByBrand = get().brandAdminsByBrandId;
    const next: Record<string, User[]> = {};
    for (const [bid, list] of Object.entries(prevByBrand)) {
      next[bid] = list.map((u) => (u.id === profileId ? { ...u, role: 'user' as const, brandId: null } : u));
    }
    set({ brandAdminsByBrandId: next });
    try {
      await db.demoteProfileToUser(profileId);
      // Re-fetch any brand whose admins list contained this profile so
      // the row drops out of MembersTab (it's now role='user' AND
      // brand_id=null, so fetchBrandAdmins won't return it next time).
      const affectedBrands = Object.entries(prevByBrand)
        .filter(([, list]) => list.some((u) => u.id === profileId))
        .map(([bid]) => bid);
      for (const bid of affectedBrands) {
        get().loadBrandAdmins(bid).catch(() => { /* logged inside */ });
      }
      Toast.show({
        type: 'info',
        text1: 'Profile demoted',
        text2: 'Role changed to user; brand affiliation cleared.',
        visibilityTime: 4000,
      });
      return true;
    } catch (e: any) {
      set({ brandAdminsByBrandId: prevByBrand });
      notifyBackendError('Demote profile', e);
      return false;
    }
  },

  deleteProfile: async (profileId) => {
    if (!profileId) return false;
    try {
      const { deleteUser } = await import('../lib/auth');
      const { error } = await deleteUser(profileId);
      if (error) {
        notifyBackendError('Delete profile', new Error(error));
        return false;
      }
      // Drop the row from every cached members list.
      const prevByBrand = get().brandAdminsByBrandId;
      const next: Record<string, User[]> = {};
      for (const [bid, list] of Object.entries(prevByBrand)) {
        next[bid] = list.filter((u) => u.id !== profileId);
      }
      set({ brandAdminsByBrandId: next });
      Toast.show({
        type: 'info',
        text1: 'Profile deleted',
        text2: 'Both profile row and auth user have been removed.',
        visibilityTime: 4000,
      });
      return true;
    } catch (e: any) {
      notifyBackendError('Delete profile', e);
      return false;
    }
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

      // "All Stores" view — fetch from every store and merge per-store
      // data. Brand-level data (catalog/recipes/preps/vendors) is the
      // SAME across all stores so we just take the first store's copy.
      if (sid === '__all__') {
        const allStores = get().stores;
        const allData = await Promise.all(
          allStores.map((s) => db.fetchAllForStore(s.id).catch(() => null))
        );
        const firstWithBrand = allData.find((d) => d?.brand);
        set({
          brand: firstWithBrand?.brand || null,
          catalogIngredients: firstWithBrand?.catalogIngredients || [],
          recipes: firstWithBrand?.recipes || [],
          prepRecipes: firstWithBrand?.prepRecipes || [],
          vendors: firstWithBrand?.vendors || [],
          inventory: allData.flatMap((d) => d?.inventory || []),
          wasteLog: allData.flatMap((d) => d?.wasteLog || []),
          auditLog: allData.flatMap((d) => d?.auditLog || []),
          ...(allData[0]?.recipeCategories?.length ? { recipeCategories: allData[0].recipeCategories } : {}),
          ...(allData[0]?.ingredientCategories?.length ? { ingredientCategories: allData[0].ingredientCategories } : {}),
          ...(allData[0]?.ingredientConversions ? { ingredientConversions: allData[0].ingredientConversions } : {}),
          posRecipeAliases: allData.flatMap((d) => d?.posRecipeAliases || []),
        });
        return;
      }

      const data = await db.fetchAllForStore(sid);
      // Cloud is the source of truth — always replace, even if empty
      set({
        brand: data.brand,
        catalogIngredients: data.catalogIngredients || [],
        inventory: data.inventory,
        recipes: data.recipes,
        prepRecipes: data.prepRecipes,
        vendors: data.vendors,
        wasteLog: data.wasteLog,
        auditLog: data.auditLog,
        // Rehydrate recent EOD submissions + order submissions so checkmarks
        // and "submitted" pills survive a refresh. Backfill storeName so
        // selectors that compare against currentStore.name still match.
        eodSubmissions: (data.eodSubmissions || []).map((s: any) => ({
          ...s, storeName: s.storeName || get().stores.find((st) => st.id === s.storeId)?.name || '',
        })),
        orderSubmissions: (data.orderSubmissions || []).map((o: any) => ({
          ...o, storeName: o.storeName || get().stores.find((st) => st.id === o.storeId)?.name || '',
        })),
        ...(data.recipeCategories.length > 0 ? { recipeCategories: data.recipeCategories } : {}),
        ...(data.ingredientCategories.length > 0 ? { ingredientCategories: data.ingredientCategories } : {}),
        ...(data.ingredientConversions ? { ingredientConversions: data.ingredientConversions } : {}),
        posRecipeAliases: data.posRecipeAliases || [],
        savedReports: (data as any).savedReports || [],
        // Replace — not merge — so switching from a store with scheduled
        // vendors to one with none doesn't leave the old store's days
        // visible. Baseline = 7 empty days, then spread whatever DB has.
        orderSchedule: {
          Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [],
          ...(data.orderSchedule || {}),
        },
      });
      // Background cleanup of records older than 90 days
      db.cleanupOldRecords().catch((e: any) => console.warn('[Supabase]', e?.message || e));

      // Refresh bell-icon notifications from the DB so cron-generated reminders
      // show up immediately after login / store switch.
      const uid = get().currentUser?.id;
      if (uid) {
        db.fetchNotifications(uid, 50).then((rows) => {
          set({
            notifications: rows.map((r) => ({
              id: r.id,
              message: r.message,
              timestamp: r.createdAt,
              read: !!r.readAt,
            })),
          });
        }).catch((e: any) => console.warn('[Supabase] fetchNotifications:', e?.message || e));
      }
    } catch (e) {
      console.log('[Supabase] Load failed, using local data:', e);
    } finally {
      set({ storeLoading: false });
    }
  },

  // Inventory
  addItem: (item) => {
    const tempId = makeId('i', ++itemCounter);
    const newItem: InventoryItem = { casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: '', ...item, id: tempId };
    set((s) => ({ inventory: [...s.inventory, newItem] }));
    // Swap temp id for server-assigned UUID once insert resolves so an
    // immediate edit/delete after create hits the real row.
    db.createInventoryItem(item)
      .then((saved) => set((s) => ({
        inventory: s.inventory.map((i) => (i.id === tempId ? saved : i)),
      })))
      .catch((e: any) => {
        set((s) => ({ inventory: s.inventory.filter((i) => i.id !== tempId) }));
        notifyBackendError('Add item', e);
      });
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
    const prev = get().inventory.find((i) => i.id === id);
    set((s) => ({
      inventory: s.inventory.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    }));
    db.updateInventoryItem(id, updates).catch((e: any) => {
      if (prev) {
        set((s) => ({ inventory: s.inventory.map((i) => (i.id === id ? prev : i)) }));
      }
      notifyBackendError('Update item', e);
    });
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
    db.deleteInventoryItem(id).catch((e: any) => {
      if (item) {
        set((s) => ({ inventory: [...s.inventory, item] }));
      }
      notifyBackendError('Delete item', e);
    });
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
    const prev = get().inventory.find((i) => i.id === id);
    set((s) => ({
      inventory: s.inventory.map((item) =>
        item.id === id
          ? { ...item, currentStock: newStock, lastUpdatedBy: by, lastUpdatedAt: new Date().toLocaleTimeString() }
          : item
      ),
    }));
    db.adjustItemStock(id, newStock, get().currentUser?.id || '').catch((e: any) => {
      if (prev) {
        set((s) => ({ inventory: s.inventory.map((i) => (i.id === id ? prev : i)) }));
      }
      notifyBackendError('Adjust stock', e);
    });
  },

  // Spec 010: optimistic catalog-ingredient update for brand-shared
  // fields (defaultShelfLifeDays today). Mirrors updateIngredientConversion
  // (useStore.ts:553) — snapshot prev slice, mutate local, on error revert
  // and surface via notifyBackendError. No audit-log entry: catalog
  // metadata changes are infrequent and the diff isn't operator-facing.
  updateCatalogIngredient: (catalogId, patch) => {
    if (!catalogId) return;
    const prev: CatalogIngredient[] = get().catalogIngredients;
    set((s) => ({
      catalogIngredients: s.catalogIngredients.map((c) =>
        c.id === catalogId ? { ...c, ...patch } : c,
      ),
    }));
    db.updateCatalogIngredient(catalogId, patch).catch((e: any) => {
      set({ catalogIngredients: prev });
      notifyBackendError('Update catalog ingredient', e);
    });
  },

  getItemStatus: (item) => {
    if (item.currentStock <= 0) return 'out';
    if (item.currentStock < item.parLevel) return 'low';
    return 'ok';
  },

  // Recipe Categories
  addRecipeCategory: (name) => {
    set((s) => ({ recipeCategories: [...s.recipeCategories, name] }));
    db.addRecipeCategory(name).catch((e: any) => {
      set((s) => ({ recipeCategories: s.recipeCategories.filter((c) => c !== name) }));
      notifyBackendError('Add recipe category', e);
    });
  },

  updateRecipeCategory: (oldName, newName) => {
    const prevCats = get().recipeCategories;
    const prevRecipes = get().recipes;
    set((s) => ({
      recipeCategories: s.recipeCategories.map((c) => (c === oldName ? newName : c)),
      recipes: s.recipes.map((r) => (r.category === oldName ? { ...r, category: newName } : r)),
    }));
    db.updateRecipeCategory(oldName, newName).catch((e: any) => {
      set({ recipeCategories: prevCats, recipes: prevRecipes });
      notifyBackendError('Rename recipe category', e);
    });
  },

  deleteRecipeCategory: (name) => {
    const prevCats = get().recipeCategories;
    set((s) => ({ recipeCategories: s.recipeCategories.filter((c) => c !== name) }));
    db.deleteRecipeCategory(name).catch((e: any) => {
      set({ recipeCategories: prevCats });
      notifyBackendError('Delete recipe category', e);
    });
  },

  // Ingredient Categories
  addIngredientCategory: (name) => {
    set((s) => ({ ingredientCategories: [...s.ingredientCategories, name] }));
    db.addIngredientCategory(name).catch((e: any) => {
      set((s) => ({ ingredientCategories: s.ingredientCategories.filter((c) => c !== name) }));
      notifyBackendError('Add ingredient category', e);
    });
  },

  updateIngredientCategory: (oldName, newName) => {
    const prevCats = get().ingredientCategories;
    const prevInv = get().inventory;
    set((s) => ({
      ingredientCategories: s.ingredientCategories.map((c) => (c === oldName ? newName : c)),
      inventory: s.inventory.map((i) => (i.category === oldName ? { ...i, category: newName } : i)),
    }));
    db.updateIngredientCategory(oldName, newName).catch((e: any) => {
      set({ ingredientCategories: prevCats, inventory: prevInv });
      notifyBackendError('Rename ingredient category', e);
    });
  },

  deleteIngredientCategory: (name) => {
    const prevCats = get().ingredientCategories;
    set((s) => ({ ingredientCategories: s.ingredientCategories.filter((c) => c !== name) }));
    db.deleteIngredientCategory(name).catch((e: any) => {
      set({ ingredientCategories: prevCats });
      notifyBackendError('Delete ingredient category', e);
    });
  },

  // Ingredient Conversions — write UI on CatalogConversionsTab (Spec 004).
  // Optimistic-then-revert. The slice itself is hydrated by
  // loadFromSupabase via fetchIngredientConversions; these actions add
  // the missing per-row CRUD path.
  addIngredientConversion: (conv) => {
    const tempId = `_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: IngredientConversion = { ...conv, id: tempId };
    set((s) => ({ ingredientConversions: [...s.ingredientConversions, optimistic] }));
    db.createIngredientConversion(conv)
      .then((saved) => set((s) => ({
        ingredientConversions: s.ingredientConversions.map(
          (c) => (c.id === tempId ? saved : c),
        ),
      })))
      .catch((e: any) => {
        set((s) => ({
          ingredientConversions: s.ingredientConversions.filter(
            (c) => c.id !== tempId,
          ),
        }));
        notifyBackendError('Add conversion', e);
      });
  },

  updateIngredientConversion: (id, patch) => {
    const prev = get().ingredientConversions;
    set((s) => ({
      ingredientConversions: s.ingredientConversions.map(
        (c) => (c.id === id ? { ...c, ...patch } : c),
      ),
    }));
    db.updateIngredientConversion(id, patch)
      .then((saved) => set((s) => ({
        ingredientConversions: s.ingredientConversions.map(
          (c) => (c.id === id ? saved : c),
        ),
      })))
      .catch((e: any) => {
        set({ ingredientConversions: prev });
        notifyBackendError('Update conversion', e);
      });
  },

  deleteIngredientConversion: (id) => {
    const prev = get().ingredientConversions;
    set((s) => ({
      ingredientConversions: s.ingredientConversions.filter(
        (c) => c.id !== id,
      ),
    }));
    db.deleteIngredientConversion(id).catch((e: any) => {
      set({ ingredientConversions: prev });
      notifyBackendError('Delete conversion', e);
    });
  },

  // Recipes — brand-level after the catalog refactor. brandId resolved
  // from the store's current brand if not explicitly set on the input.
  addRecipe: (recipe) => {
    const brandId = recipe.brandId || get().brand?.id || get().currentStore.brandId || '';
    const recipeWithBrand = { ...recipe, brandId, storeId: brandId };
    const tempId = makeId('r', ++recipeCounter);
    set((s) => ({ recipes: [...s.recipes, { ...recipeWithBrand, id: tempId }] }));
    db.createRecipe(recipeWithBrand)
      .then((saved) => set((s) => ({
        recipes: s.recipes.map((r) => (r.id === tempId ? saved : r)),
      })))
      .catch((e: any) => {
        // Revert: drop the temp row so the UI matches the DB.
        set((s) => ({ recipes: s.recipes.filter((r) => r.id !== tempId) }));
        notifyBackendError('Save recipe', e);
      });
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
    const prev = get().recipes.find((r) => r.id === id);
    set((s) => ({
      recipes: s.recipes.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    }));
    db.updateRecipe(id, updates).catch((e: any) => {
      if (prev) {
        set((s) => ({ recipes: s.recipes.map((r) => (r.id === id ? prev : r)) }));
      }
      notifyBackendError('Update recipe', e);
    });
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
    db.deleteRecipe(id).catch((e: any) => {
      if (recipe) {
        set((s) => ({ recipes: [...s.recipes, recipe] }));
      }
      notifyBackendError('Delete recipe', e);
    });
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

  // Prep Recipes — brand-level after the catalog refactor.
  addPrepRecipe: (recipe) => {
    const brandId = recipe.brandId || get().brand?.id || get().currentStore.brandId || '';
    const recipeWithBrand = { ...recipe, brandId, storeId: brandId };
    const tempId = makeId('pr', ++prepRecipeCounter);
    set((s) => ({ prepRecipes: [...s.prepRecipes, { ...recipeWithBrand, id: tempId }] }));
    db.createPrepRecipe(recipeWithBrand)
      .then((newId) => set((s) => ({
        prepRecipes: s.prepRecipes.map((r) => (r.id === tempId ? { ...r, id: newId } : r)),
      })))
      .catch((e: any) => {
        set((s) => ({ prepRecipes: s.prepRecipes.filter((r) => r.id !== tempId) }));
        notifyBackendError('Save prep recipe', e);
      });
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
    // Capture brandId AND prev-state BEFORE mutating (prevents race in multi-store
    // loops, and gives us something to revert to on backend failure).
    const prev = get().prepRecipes.find((r) => r.id === id);
    const brandId = updates.brandId || prev?.brandId || get().brand?.id || get().currentStore.brandId || '';
    set((s) => ({
      prepRecipes: s.prepRecipes.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    }));
    // Use versioned update to preserve historical records. On error, revert
    // local state and surface the toast so the admin sees the failure.
    db.updatePrepRecipeVersioned(id, { ...updates, brandId, storeId: brandId })
      .then((newId) => {
        // Replace old ID with new versioned ID in local state
        set((s) => ({ prepRecipes: s.prepRecipes.map((r) => r.id === id ? { ...r, id: newId } : r) }));
      })
      .catch((e: any) => {
        if (prev) {
          set((s) => ({ prepRecipes: s.prepRecipes.map((r) => (r.id === id ? prev : r)) }));
        }
        notifyBackendError('Update prep recipe', e);
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
    const recipe = get().prepRecipes.find((r) => r.id === id);
    set((s) => ({
      prepRecipes: s.prepRecipes.filter((r) => r.id !== id),
    }));
    db.deletePrepRecipe(id).catch((e: any) => {
      if (recipe) {
        set((s) => ({ prepRecipes: [...s.prepRecipes, recipe] }));
      }
      notifyBackendError('Delete prep recipe', e);
    });
    get().addAuditEvent({
      timestamp: new Date().toLocaleString(),
      userId: get().currentUser?.id || '',
      userName: get().currentUser?.name || '',
      userRole: get().currentUser?.role || 'user',
      storeId: get().currentStore.id,
      storeName: get().currentStore.name,
      action: 'Prep recipe deleted',
      detail: 'Prep recipe removed',
      itemRef: recipe?.name || id,
      value: '',
    });
  },

  // Waste
  logWaste: (entry) => {
    const id = makeId('w', ++wasteCounter);
    set((s) => ({ wasteLog: [{ ...entry, id }, ...s.wasteLog] }));
    db.logWasteEntry(entry).catch((e: any) => {
      set((s) => ({ wasteLog: s.wasteLog.filter((w) => w.id !== id) }));
      notifyBackendError('Log waste', e);
    });
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
    // Existing-merge lookup is store+date scoped (no user) to mirror the
    // DB's UNIQUE (store_id, date) — admins editing a regular user's count
    // should update the same local row, not append a parallel one.
    const existing = get().eodSubmissions.find(
      (s) =>
        s.storeId === submission.storeId &&
        s.date === submission.date
    );

    if (existing) {
      // Merge new entries with existing (update matching items, add new ones)
      const mergedEntries = [...existing.entries];
      submission.entries.forEach((newEntry) => {
        const idx = mergedEntries.findIndex((e) => e.itemId === newEntry.itemId);
        if (idx >= 0) mergedEntries[idx] = newEntry;
        else mergedEntries.push(newEntry);
      });
      set((s) => ({
        eodSubmissions: s.eodSubmissions.map((sub) =>
          sub.id === existing.id
            ? { ...sub, entries: mergedEntries, itemCount: mergedEntries.length, timestamp: submission.timestamp, status: submission.status }
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
                // EOD count is the authoritative re-measurement of the shelf,
                // so reset currentStock too. Without this, dashboard tiles
                // (inventory value, low/out-of-stock, stock alerts) keep
                // showing pre-count zeros — see DashboardScreen `inventoryValue`.
                currentStock: entry.actualRemaining,
                eodRemaining: entry.actualRemaining,
                lastUpdatedBy: entry.submittedBy,
                lastUpdatedAt: entry.timestamp,
              }
            : item
        ),
      }));
      // Persist the recalibration so it survives reload. Mirrors the
      // adjustStock action's db.adjustItemStock call (line ~325 above).
      db
        .adjustItemStock(
          entry.itemId,
          entry.actualRemaining,
          entry.submittedByUserId || get().currentUser?.id || '',
        )
        .catch((e: any) => console.warn('[Supabase]', e?.message || e));
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

    // Broadcast a bell-icon notification to every other admin + linked user
    // of this store. In-app only; push/email stays scoped to the reminder cron.
    const submitterName = submission.submittedBy || get().currentUser?.name || 'someone';
    const verb = existing ? 'edited' : 'submitted';
    const msg = `${submitterName} ${verb} today's EOD count for ${submission.storeName}`;
    const { supabase } = require('../lib/supabase');
    // supabase-js v2 builders (rpc, from().update(), etc.) are thenable but
    // DON'T expose `.catch` — chaining it throws TypeError synchronously and
    // aborts submitEOD before handleSubmit's persistToCloud call runs.
    // Promise.resolve(...) promotes the thenable to a real Promise that has .catch.
    Promise.resolve(
      supabase.rpc('broadcast_notification', {
        p_store_id: submission.storeId,
        p_message: msg,
        p_exclude_user_id: submission.submittedByUserId || null,
      })
    ).catch((e: any) => console.warn('[Supabase] broadcast_notification (eod):', e?.message || e));
  },

  // Vendors — brand-level after the catalog refactor.
  addVendor: (vendor) => {
    const brandId = vendor.brandId || get().brand?.id || get().currentStore.brandId || '';
    const vendorWithBrand = { ...vendor, brandId };
    const tempId = makeId('v', ++vendorCounter);
    set((s) => ({ vendors: [...s.vendors, { ...vendorWithBrand, id: tempId }] }));
    db.createVendor(vendorWithBrand)
      .then((saved) => set((s) => ({
        vendors: s.vendors.map((v) => (v.id === tempId ? saved : v)),
      })))
      .catch((e: any) => {
        set((s) => ({ vendors: s.vendors.filter((v) => v.id !== tempId) }));
        notifyBackendError('Add vendor', e);
      });
  },

  updateVendor: (id, updates) => {
    const prev = get().vendors.find((v) => v.id === id);
    set((s) => ({
      vendors: s.vendors.map((v) => (v.id === id ? { ...v, ...updates } : v)),
    }));
    db.updateVendor(id, updates).catch((e: any) => {
      if (prev) set((s) => ({ vendors: s.vendors.map((v) => (v.id === id ? prev : v)) }));
      notifyBackendError('Update vendor', e);
    });
  },

  deleteVendor: (id) => {
    const vendor = get().vendors.find((v) => v.id === id);
    set((s) => ({ vendors: s.vendors.filter((v) => v.id !== id) }));
    db.deleteVendor(id).catch((e: any) => {
      if (vendor) set((s) => ({ vendors: [...s.vendors, vendor] }));
      notifyBackendError('Delete vendor', e);
    });
  },

  // POS Import — adjusts the CURRENT store's stock based on sales × BOM.
  // Recipe ingredients reference catalog ids (brand-level); we resolve
  // each to the per-store inventory_items row before adjusting stock.
  importPOS: (posImport) => {
    const id = makeId('pos', Date.now());
    set((s) => ({ posImports: [{ ...posImport, id }, ...s.posImports] }));
    const storeId = get().currentStore?.id;
    posImport.items.forEach((saleItem) => {
      if (saleItem.recipeId) {
        const recipe = get().recipes.find((r) => r.id === saleItem.recipeId);
        if (recipe) {
          recipe.ingredients.forEach((ing) => {
            const item =
              get().inventory.find((i) => i.catalogId === ing.itemId && i.storeId === storeId) ||
              get().inventory.find((i) => i.id === ing.itemId); // legacy fallback
            if (item) {
              const { getConversionFactor } = require('../utils/unitConversion');
              const factor = getConversionFactor(ing.unit, item.unit);
              const convertedQty = factor !== null ? ing.quantity * factor : ing.quantity;
              get().adjustStock(
                item.id,
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

  // POS recipe aliases — persistent (pos_name → recipe_id) per store. Called
  // by POSImportScreen after Confirm Import so the same POS string never
  // re-fuzzy-matches on subsequent imports.
  upsertPosRecipeAliases: async (rows) => {
    const storeId = get().currentStore.id;
    if (!storeId || rows.length === 0) return;
    const normalized = rows.map((r) => ({ posName: r.posName.trim(), recipeId: r.recipeId, storeId }));
    set((s) => {
      const remaining = s.posRecipeAliases.filter((a) =>
        !normalized.some((n) => n.posName.toLowerCase() === a.pos_name.toLowerCase() && a.store_id === storeId)
      );
      return {
        posRecipeAliases: [
          ...remaining,
          ...normalized.map((n) => ({ pos_name: n.posName, recipe_id: n.recipeId, store_id: storeId })),
        ],
      };
    });
    try {
      await db.upsertPosRecipeAliases(normalized);
    } catch (e: any) {
      console.warn('[Supabase] upsertPosRecipeAliases:', e?.message || e);
    }
  },

  applyAliasToPastImports: async (posName, recipeId) => {
    const storeId = get().currentStore.id;
    if (!storeId) return 0;
    try {
      return await db.applyAliasToPastImports(storeId, posName, recipeId);
    } catch (e: any) {
      console.warn('[Supabase] applyAliasToPastImports:', e?.message || e);
      return 0;
    }
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
    // Only include fields that are present in `updates` so we don't clobber existing values with undefined.
    const dbUpdates: Record<string, any> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.address !== undefined) dbUpdates.address = updates.address;
    if (updates.eodDeadlineTime !== undefined) dbUpdates.eod_deadline_time = updates.eodDeadlineTime;
    // Promote the builder to a real Promise before .catch (builders are
    // thenable but lack `.catch`, so chaining it throws TypeError).
    Promise.resolve(
      supabase.from('stores').update(dbUpdates).eq('id', id)
    ).catch((e: any) => console.warn('[Supabase]', e?.message || e));
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
    const prev = get().orderSchedule;
    set((s) => ({
      orderSchedule: { ...s.orderSchedule, [day]: vendors },
    }));
    // Persist to Supabase
    const storeId = get().currentStore?.id;
    if (storeId && storeId !== '__all__') {
      db.saveOrderSchedule(storeId, day, vendors).catch((e: any) => {
        set({ orderSchedule: prev });
        notifyBackendError('Save order schedule', e);
      });
    }
  },

  // Spec 007 §3 — per-cell schedule writes. The new OrderScheduleSection
  // weekly grid + the EOD inline `+ vendor` / `×` affordances both go
  // through these actions instead of saveOrderSchedule's bulk replace.
  // Optimistic-then-revert with notifyBackendError on failure (matches
  // the addIngredientConversion / setOrderSchedule pattern).
  addOrderScheduleEntry: (day, vendor) => {
    const prev = get().orderSchedule;
    set((s) => ({
      orderSchedule: {
        ...s.orderSchedule,
        [day]: [
          ...(s.orderSchedule[day] ?? []),
          {
            vendorId: vendor.vendorId,
            vendorName: vendor.vendorName,
            deliveryDay: vendor.deliveryDay ?? day,
          },
        ],
      },
    }));
    const storeId = get().currentStore?.id;
    if (storeId && storeId !== '__all__' && vendor.vendorId) {
      db.addOrderScheduleEntry(storeId, day, vendor).catch((e: any) => {
        set({ orderSchedule: prev });
        notifyBackendError('Add schedule entry', e);
      });
    }
  },

  removeOrderScheduleEntry: (day, vendorId) => {
    const prev = get().orderSchedule;
    set((s) => ({
      orderSchedule: {
        ...s.orderSchedule,
        [day]: (s.orderSchedule[day] ?? []).filter(
          (v) => v.vendorId !== vendorId,
        ),
      },
    }));
    const storeId = get().currentStore?.id;
    if (storeId && storeId !== '__all__') {
      db.removeOrderScheduleEntry(storeId, day, vendorId).catch((e: any) => {
        set({ orderSchedule: prev });
        notifyBackendError('Remove schedule entry', e);
      });
    }
  },

  submitOrder: (submission) => {
    // Optimistic local write so the "submitted" pill flips immediately.
    const tempId = `ord${Date.now()}`;
    set((s) => ({ orderSubmissions: [...s.orderSubmissions, { ...submission, id: tempId }] }));
    // Persist to purchase_orders so it survives refresh + is visible to the
    // reminder cron's "already ordered today" check.
    db.createPurchaseOrder({
      storeId: submission.storeId,
      vendorId: (submission as any).vendorId,
      vendorName: submission.vendorName,
      submittedByUserId: get().currentUser?.id,
      totalCost: (submission as any).totalCost,
      day: submission.day,
      date: submission.date,
      // Caller (OrdersScreen) already stamps submission.date with the day-card
      // reference date, so forwarding it as referenceDate persists that
      // context into the DB's reference_date column.
      referenceDate: submission.date,
    }).then((serverId) => {
      if (!serverId) return;
      set((s) => ({
        orderSubmissions: s.orderSubmissions.map((o) => o.id === tempId ? { ...o, id: serverId } : o),
      }));
    }).catch((e: any) => {
      set((s) => ({ orderSubmissions: s.orderSubmissions.filter((o) => o.id !== tempId) }));
      notifyBackendError('Submit order', e);
    });

    // Broadcast a bell-icon notification to admins + linked users.
    const submitterName = get().currentUser?.name || 'someone';
    const storeName = submission.storeName || get().stores.find((st) => st.id === submission.storeId)?.name || 'store';
    const msg = `${submission.vendorName} order for ${storeName} submitted by ${submitterName}`;
    const { supabase } = require('../lib/supabase');
    // Same fix as submitEOD: promote the rpc builder to a real Promise before
    // .catch so it doesn't throw TypeError and abort submitOrder.
    Promise.resolve(
      supabase.rpc('broadcast_notification', {
        p_store_id: submission.storeId,
        p_message: msg,
        p_exclude_user_id: get().currentUser?.id || null,
      })
    ).catch((e: any) => console.warn('[Supabase] broadcast_notification (order):', e?.message || e));
  },

  setTimezone: (tz) => {
    set({ timezone: tz });
  },

  toggleDarkMode: () => {
    const next = !get().darkMode;
    set({ darkMode: next });
    // Persist locally (web localStorage / native AsyncStorage) for instant
    // boot-time restore, plus push to profiles.dark_mode so it follows the
    // user across devices. Both writes are fire-and-forget — UI never waits.
    persistDarkModeLocal(next);
    const userId = get().currentUser?.id;
    if (userId) {
      supabase.from('profiles').update({ dark_mode: next }).eq('id', userId)
        .then(({ error }) => {
          if (error) console.warn('[Supabase] persist dark_mode:', error.message);
        });
    }
  },

  setDarkMode: (value) => {
    set({ darkMode: value });
  },

  // Spec 008: no-persist hydrator. Mirrors setDarkMode — used by the
  // App.tsx login-restore path to seed local state from the value just
  // read out of profiles.sidebar_layout. Avoids the redundant UPDATE
  // that the original (persisting) setter would have triggered.
  hydrateSidebarLayoutOverride: (override) => {
    set({ sidebarLayoutOverride: override });
  },

  // Spec 008: optimistic-then-revert per setDarkMode/addOrderScheduleEntry
  // precedent. `null` = reset to default (writes NULL to the column).
  // `produceOverride` (frontend) returns null for "no changes" so an
  // empty edit-mode session never writes a spurious override.
  // Used by edit-mode DONE / reset paths in InventoryDesktopLayout.tsx.
  // For login-restore (no DB write), use hydrateSidebarLayoutOverride.
  setSidebarLayoutOverride: (override) => {
    const prev = get().sidebarLayoutOverride;
    set({ sidebarLayoutOverride: override });
    const userId = get().currentUser?.id;
    // Not logged in (e.g. legacy/demo mode) — local-only, no persistence.
    if (!userId) return;
    db.saveSidebarLayout(userId, override).catch((e: any) => {
      set({ sidebarLayoutOverride: prev });
      notifyBackendError('Save sidebar layout', e);
    });
  },

  // Notifications — optimistic in-memory write, then persist to Supabase so the
  // bell-icon history survives across devices. Cron-generated rows come in via
  // loadFromSupabase.
  addNotification: (message) => {
    const localId = `notif-${Date.now()}`;
    const notif: AppNotification = { id: localId, message, timestamp: new Date().toISOString(), read: false };
    set((s) => ({ notifications: [notif, ...s.notifications] }));
    const userId = get().currentUser?.id;
    if (!userId) return;
    db.createNotification(userId, message).then((serverId) => {
      if (!serverId) return;
      // Replace the local temp id with the server id so subsequent reads/marks
      // target the right row.
      set((s) => ({
        notifications: s.notifications.map((n) => n.id === localId ? { ...n, id: serverId } : n),
      }));
    }).catch((e: any) => console.warn('[Supabase] addNotification:', e?.message || e));
  },
  markNotificationRead: (id) => {
    set((s) => ({ notifications: s.notifications.map((n) => n.id === id ? { ...n, read: true } : n) }));
    // Only persist server-side if this looks like a server id (uuid), not a
    // local `notif-<timestamp>` id that hasn't round-tripped yet.
    if (id && !id.startsWith('notif-')) {
      db.markNotificationReadDb(id).catch((e: any) => console.warn('[Supabase] markNotificationRead:', e?.message || e));
    }
  },
  clearNotifications: () => {
    // Mark all as read rather than delete, so history stays in the DB.
    set((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) }));
    const userId = get().currentUser?.id;
    if (userId) {
      db.clearNotificationsDb(userId).catch((e: any) => console.warn('[Supabase] clearNotifications:', e?.message || e));
    }
  },

  // Audit — write only to Supabase, loaded on next refresh via loadFromSupabase
  addAuditEvent: (event) => {
    db.addAuditEvent(event).catch((e: any) => console.warn('[Supabase]', e?.message || e));
  },

  // Phase 12f — saved reports
  addReportDefinition: (rep) => {
    const tempId = makeId('rep', Date.now());
    const optimistic: ReportDefinition = {
      ...rep,
      id: tempId,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({ savedReports: [optimistic, ...(s.savedReports || [])] }));
    db.createReportDefinition(rep)
      .then((saved) => {
        if (!saved) return;
        set((s) => ({
          savedReports: (s.savedReports || []).map((r) => (r.id === tempId ? saved : r)),
        }));
      })
      .catch((e: any) => {
        set((s) => ({ savedReports: (s.savedReports || []).filter((r) => r.id !== tempId) }));
        notifyBackendError('Save report', e);
      });
  },

  deleteReportDefinition: (id) => {
    const prev = (get().savedReports || []).find((r) => r.id === id);
    set((s) => ({ savedReports: (s.savedReports || []).filter((r) => r.id !== id) }));
    db.deleteReportDefinition(id).catch((e: any) => {
      if (prev) set((s) => ({ savedReports: [...(s.savedReports || []), prev] }));
      notifyBackendError('Delete report', e);
    });
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
      const { getConversionFactor, smartToBase } = require('../utils/unitConversion');
      const allConversions = get().ingredientConversions || [];
      return prep.ingredients.reduce((sum, ing) => {
        const isSubRecipe = (ing.type || 'raw') === 'prep';
        if (isSubRecipe) {
          const subRecipe = get().prepRecipes.find((p) => p.id === ing.itemId);
          if (!subRecipe) return sum;
          const subCost = calcCost(ing.itemId, new Set(visited));
          const subYield = subRecipe.yieldQuantity || 1;
          const costPerUnit = subYield > 0 ? subCost / subYield : 0;
          const factor = getConversionFactor(ing.unit, subRecipe.yieldUnit);
          const convertedQty = factor !== null ? ing.quantity * factor : ing.quantity;
          return sum + costPerUnit * convertedQty;
        }
        // Raw ingredient — delegate to shared helper (single source of truth)
        return sum + get().getIngredientLineCost(ing);
      }, 0);
    };
    return calcCost(prepRecipeId, new Set());
  },

  // Cost per yield unit (e.g., cost per lb of marinated chicken).
  // Trusts the user-entered yieldQuantity — that's the cooked / drained net
  // yield that the cost should be amortized across. For preps with cook /
  // drain loss (e.g. marinade chicken: 2kg input → 1.5kg cooked), dividing
  // by the input ingredient sum understates per-unit cost. Falls back to a
  // live recompute only when yieldQuantity is missing (legacy data) so
  // unmigrated rows still produce a non-zero number.
  getPrepRecipeCostPerUnit: (prepRecipeId) => {
    const prep = get().prepRecipes.find((p) => p.id === prepRecipeId);
    if (!prep) return 0;
    const totalCost = get().getPrepRecipeCost(prepRecipeId);
    if (prep.yieldQuantity && prep.yieldQuantity > 0) {
      return totalCost / prep.yieldQuantity;
    }
    // Legacy fallback — yieldQuantity was never set. Sum ingredient base
    // quantities and convert to a friendly display unit.
    const { smartToBase } = require('../utils/unitConversion');
    let yG = 0, yF = 0;
    for (const ing of prep.ingredients) {
      const b = smartToBase(ing.quantity, ing.unit);
      if (b.unit === 'fl_oz') yF += b.quantity; else yG += b.quantity;
    }
    let yieldQty = 0;
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
    console.warn(`[prep] using live-recomputed yield for "${prep.name}" — set yield_quantity for accurate cost-per-unit`);
    return totalCost / yieldQty;
  },

  // Shared helper: calculate cost of a single raw ingredient line item
  // costPerUnit is per counted unit (per bag/case/each). To cost a recipe line we must
  // convert the recipe quantity into counted units: recipe unit → sub-unit (g/oz/lbs via
  // getConversionFactor) → counted unit (via subUnitSize).
  getIngredientLineCost: (ing) => {
    const { getConversionFactor, smartToBase } = require('../utils/unitConversion');
    // After the catalog refactor `ing.itemId` is a catalog id. Resolve to
    // the CURRENT STORE's per-store inventory_items row to get
    // cost_per_unit / vendor / case packing.
    const storeId = get().currentStore?.id;
    const item =
      get().inventory.find((i) => i.catalogId === ing.itemId && i.storeId === storeId) ||
      get().inventory.find((i) => i.id === ing.itemId) || // legacy item_id callers
      get().inventory.find((i) => i.name.toLowerCase() === (ing.itemName || '').toLowerCase() && i.storeId === storeId);
    if (!item) return 0;
    // Short-circuit: recipe uses the counted unit directly (e.g. 1 each, 2 bags)
    if (ing.unit === item.unit) return item.costPerUnit * ing.quantity;
    // Standard conversion: recipe unit → sub-unit → counted unit
    let factor = getConversionFactor(ing.unit, item.subUnitUnit || item.unit);
    if (factor === null && item.subUnitUnit) factor = getConversionFactor(ing.unit, item.unit);
    if (factor !== null) {
      const qtyInSubUnit = ing.quantity * factor;
      const subUnitSize = item.subUnitSize || 1;
      const qtyInCountedUnit = subUnitSize > 0 ? qtyInSubUnit / subUnitSize : qtyInSubUnit;
      return item.costPerUnit * qtyInCountedUnit;
    }
    // Fallback: ingredient_conversions for abstract units (e.g. 1 each = 400g).
    // Conversions live at brand level now (keyed by catalog id).
    const allConversions = get().ingredientConversions || [];
    const conv = allConversions.find((c: any) =>
      c.inventoryItemId === item.catalogId || c.inventoryItemId === item.id);
    if (conv && conv.conversionFactor > 0) {
      const costPerBase = item.costPerUnit / conv.conversionFactor;
      const base = smartToBase(ing.quantity, ing.unit);
      return costPerBase * base.quantity;
    }
    return 0;
  },

  // Menu recipe cost = raw ingredients + prep recipe portions
  getRecipeCost: (recipeId) => {
    const recipe = get().recipes.find((r) => r.id === recipeId);
    if (!recipe) return 0;
    const { getConversionFactor } = require('../utils/unitConversion');

    const rawCost = recipe.ingredients.reduce((sum, ing) => sum + get().getIngredientLineCost(ing), 0);

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
