// src/store/useStore.ts
import { create } from 'zustand';
import {
  AppState, User, InventoryItem, Recipe, WasteEntry,
  EODSubmission, Vendor, POSImport, AppNotification,
  AuditEvent, AuditAction, Store, ItemStatus, PrepRecipe,
  OrderDayVendor, OrderSubmission, ReportDefinition, ReportRun,
  IngredientConversion, SidebarLayoutOverride, CatalogIngredient,
  Brand, InventoryCountKind, ReorderPayload, MenuCapacityRow,
  LocalizedNames, RecipeCategory, IngredientCategory,
  WeeklyCountStatus,
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
import type { Locale } from '../i18n';

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

// Spec 038 — local cache key for the user's preferred chrome language.
// Namespaced under `imr.*` like ACTIVE_BRAND_KEY rather than the bare
// `'darkMode'` (legacy). Exported so App.tsx imports it instead of
// duplicating the literal.
export const LOCALE_KEY = 'imr.locale';

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

// Spec 038 — local cache for the chrome language so the boot-time
// hydrator in App.tsx can restore the locale before first paint
// without waiting on Supabase. Mirrors persistDarkModeLocal.
function persistLocaleLocal(value: Locale) {
  try {
    if (Platform.OS === 'web') {
      window.localStorage.setItem(LOCALE_KEY, value);
    } else {
      AsyncStorage.setItem(LOCALE_KEY, value).catch(() => { /* best-effort */ });
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
   *  lists. On error, notifyBackendError. Spec 029 — pass
   *  `{ silent: true }` to suppress the success info-toast (e.g. when
   *  the caller is already toasting itself, as in the self-delete flow).
   *  The error path always toasts via notifyBackendError regardless. */
  deleteProfile: (profileId: string, opts?: { silent?: boolean }) => Promise<boolean>;

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
  // Spec 040 P3 — `i18nNames` is an optional new parameter on add /
  // rename that persists per-locale labels through `db.addRecipeCategory`
  // / `db.updateRecipeCategory`. Defaults to `{}` when omitted.
  addRecipeCategory: (name: string, i18nNames?: LocalizedNames) => void;
  updateRecipeCategory: (
    oldName: string,
    newName: string,
    i18nNames?: LocalizedNames,
  ) => void;
  deleteRecipeCategory: (name: string) => void;
  /**
   * Spec 040 P3 — patch a recipe category's `i18nNames` without renaming
   * it. Optimistic-then-revert. Used by the form auto-fill path when
   * DeepL suggestions arrive after the row already exists.
   */
  setRecipeCategoryI18nNames: (name: string, i18nNames: LocalizedNames) => void;

  // Ingredient Categories
  addIngredientCategory: (name: string, i18nNames?: LocalizedNames) => void;
  updateIngredientCategory: (
    oldName: string,
    newName: string,
    i18nNames?: LocalizedNames,
  ) => void;
  deleteIngredientCategory: (name: string) => void;
  setIngredientCategoryI18nNames: (
    name: string,
    i18nNames: LocalizedNames,
  ) => void;

  /**
   * Spec 040 P3 — patch the catalog row's `i18n_names` for an existing
   * catalog ingredient. The corresponding InventoryItem rows hydrated
   * from the catalog also get their local `i18nNames` patched so
   * list / detail views render the new translations immediately.
   */
  setCatalogI18nNames: (catalogId: string, i18nNames: LocalizedNames) => void;
  /**
   * Spec 040 P3 — patch an existing recipe's `i18n_names`. The save
   * itself is authoritative; this action is fired by the form when
   * DeepL suggestions arrive after the row already exists.
   */
  setRecipeI18nNames: (recipeId: string, i18nNames: LocalizedNames) => void;
  /**
   * Spec 040 P3 — patch an existing prep recipe's `i18n_names`.
   */
  setPrepRecipeI18nNames: (prepId: string, i18nNames: LocalizedNames) => void;

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

  /**
   * Spec 019 — submit an any-time inventory count. Parallel to submitEOD;
   * does NOT touch eod_submissions and does NOT update inventory_items.
   * current_stock (advisory snapshot per spec Q2). No persistent slice —
   * the section component owns the recent-counts fetch via `db.ts`.
   *
   * Mints the `client_uuid` internally via crypto.randomUUID() so retries
   * (re-clicks of Submit) flow through the RPC's idempotency check rather
   * than producing duplicate rows. On error: `notifyBackendError`. On a
   * conflict (same UUID re-submitted) the helper still resolves with
   * `conflict: true` and the caller toasts "Already submitted" rather than
   * "Count submitted".
   */
  submitInventoryCount: (input: {
    storeId: string;
    kind: InventoryCountKind;
    countedAt: string;
    status?: 'draft' | 'submitted';
    entries: Array<{
      itemId: string;
      actualRemaining?: number | null;
      actualRemainingCases?: number | null;
      actualRemainingEach?: number | null;
      unit?: string | null;
      notes?: string | null;
    }>;
    notes?: string | null;
    /** Caller-minted idempotency key — one UUID per submit-button press.
     *  A retry from the caller passing the same UUID returns the
     *  existing row with `conflict: true` instead of inserting a duplicate.
     *  See architect §6 + §10. */
    clientUuid: string;
  }) => Promise<{ countId: string; conflict: boolean } | null>;

  // Vendors
  addVendor: (vendor: Omit<Vendor, 'id'>) => void;
  updateVendor: (id: string, updates: Partial<Vendor>) => void;
  deleteVendor: (id: string) => void;

  // POS Import
  importPOS: (posImport: Omit<POSImport, 'id'>) => void;

  // POS recipe aliases (POS-name → recipe_id mappings, store-scoped)
  upsertPosRecipeAliases: (rows: { posName: string; recipeId: string }[]) => Promise<void>;
  applyAliasToPastImports: (posName: string, recipeId: string) => Promise<number>;
  /** Spec 015 — delete the store-scoped alias for `posName`. Optimistic;
   *  reverts via `notifyBackendError` on backend failure. Case-insensitive
   *  trim-match against the local slice; the underlying DELETE is keyed
   *  on `(store_id, pos_name)`. Global aliases (store_id IS NULL) are not
   *  touched by this action — the UI hides remove for those rows. */
  removePosRecipeAlias: (posName: string) => Promise<void>;

  // Stores
  addStore: (store: Omit<Store, 'id'>) => void;
  updateStore: (id: string, updates: Partial<Store>) => void;
  /** Spec 098 — set (or clear, with `null`) a store's weekly-count due
   *  day-of-week (0=Sun..6=Sat). Optimistic-then-revert: the local
   *  `stores`/`currentStore` slice updates first, then `db.updateStore`
   *  PATCHes `weekly_count_due_dow`; on backend failure the slice reverts
   *  and the error routes through `notifyBackendError`. */
  setStoreWeeklyDueDow: (id: string, dow: number | null) => void;

  // Spec 098 — admin weekly-count status read slice (per-store
  // completed/overdue for the current week). Fetched on demand by
  // InventoryCountSection's weekly tab.
  weeklyCountStatus: WeeklyCountStatus[];
  weeklyCountStatusLoading: boolean;
  /** Load per-store weekly status for all visible stores as of the
   *  caller's local YYYY-MM-DD (todayIso convention). Best-effort —
   *  errors leave the previous slice in place. */
  loadWeeklyCountStatus: (asOfDate: string) => Promise<void>;

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

  // Spec 038 — chrome-language preference.
  /**
   * Persist the user's preferred chrome language to `profiles.locale`
   * (and local storage). Optimistic-then-revert: local state + cache
   * update first, DB write second; on backend error reverts and routes
   * through `notifyBackendError`. Used by LocaleSwitcher's onPress.
   */
  setLocale: (value: Locale) => void;
  /** Apply a locale value WITHOUT persisting — used at boot/login to
   *  restore the cached / DB-stored preference. Mirrors `setDarkMode`
   *  (no-persist hydrator). */
  hydrateLocale: (value: Locale) => void;

  /** Spec 044 — apply the brand slice WITHOUT persisting. Used by
   *  App.tsx after getSession() returns to seed the `brand` slice from
   *  the AuthResult so the TitleBar renders the correct `<INITIALS>://`
   *  prefix on first paint instead of flashing `inv://` until
   *  `setCurrentStore`'s downstream async load lands ~50-200 ms later.
   *  Mirrors `hydrateLocale` / `hydrateSidebarLayoutOverride` in shape —
   *  sync, idempotent, no DB write. `null` clears the slice (super_admin
   *  with no brand_id, soft-deleted brand, or RLS-denied embed). */
  hydrateBrand: (brand: { id: string; name: string } | null) => void;

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

  // Report runs (Spec 016 — REPORTS-1)
  /**
   * Spec 016 — append a new run for `definitionId`. Optimistic-then-revert.
   * Writes a `pending` row to `reportRuns[definitionId]` immediately,
   * swaps to the resolved row on success, deletes the pending entry on
   * error and routes through `notifyBackendError('Run report', e)`.
   * No-op if `definitionId` doesn't resolve to a saved report.
   *
   * Spec 017 (REPORTS-2) — `overrideParams` shadows the saved
   * `definition.params` for this run only (e.g. a chip-dropdown in the
   * detail header changing the date range without saving it back to the
   * definition). Merge shape: `{ ...def.params, ...overrideParams }` —
   * override keys win. The merged object travels both to `db.runReport`
   * (which sends it to the dispatcher AND persists to `report_runs.params`)
   * AND to the optimistic display row so the detail frame sees the active
   * override immediately. The saved `ReportDefinition.params` is NOT
   * mutated by this action — the user's "save changes to definition"
   * affordance is a separate follow-up.
   */
  runReport: (definitionId: string, overrideParams?: Record<string, unknown>) => void;
  /**
   * Spec 016 — pull the most recent run for `definitionId` from DB and
   * hydrate `reportRuns[definitionId]`. No optimistic behavior; pure
   * load. No-op if no row exists (the empty state). Console-warns on
   * unexpected DB error since a missing run is not user-facing.
   */
  loadLatestRun: (definitionId: string) => Promise<void>;

  /**
   * Spec 021 — lazy-load the reorder-list envelope for the current
   * store. Fires the `report_reorder_list` RPC, writes loading/error
   * around the call, and stores the resulting payload in
   * `reorderPayload`. No optimistic behavior — this is a pure read.
   *
   * Errors surface to `reorderError` (rendered in-section as a panel,
   * not a toast — matches the reports detail-frame pattern). A console
   * warning is still emitted for the dev console.
   */
  loadReorderSuggestions: (asOfDate?: string) => Promise<void>;

  /**
   * Spec 060 — server-computed per-recipe capacity for the active
   * store. Fires `compute_menu_capacity` via `db.fetchMenuCapacity`
   * and reduces the array → `Record<recipeId, MenuCapacityRow>` for
   * O(1) lookups in `RecipesSection`'s inline badge.
   *
   * Called fire-and-forget by `loadFromSupabase` (not awaited so
   * first paint never blocks on capacity). On error, sets
   * `menuCapacity` to `{}` and routes through `notifyBackendError`
   * so the user gets a toast. The badge falls back to rendering
   * nothing when the slice is empty.
   *
   * No realtime wiring is needed — the same `loadFromSupabase`
   * triggered by every onSync re-fires this. The 400ms debounce in
   * `useRealtimeSync` already absorbs bursty inventory writes.
   */
  loadMenuCapacity: (storeId?: string) => Promise<void>;

  // Computed
  getLowStockItems: () => InventoryItem[];
  getInventoryValue: () => number;
  getFoodCostPercent: () => number;
  getWasteThisWeek: () => number;
  getRecipeCost: (recipeId: string) => number;
  getRecipeFoodCostPct: (recipeId: string) => number;
  getPrepRecipe: (prepRecipeId: string) => PrepRecipe | undefined;
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
  weeklyCountStatus: [],
  weeklyCountStatusLoading: false,
  users: USERS,
  inventory: INVENTORY,
  recipes: RECIPES,
  // Spec 040 P3 — slice shape widened from `string[]` to
  // `{ name; i18nNames }[]`. The English-named defaults stay as the
  // boot fallback; `loadFromSupabase` overwrites with the DB shape that
  // carries real per-locale overrides once the user logs in.
  recipeCategories: [
    'Sandwiches & Burgers', 'Over Rice Platters', 'Mains', 'Salads',
    'Starters', 'Desserts', 'Sides', 'Drinks',
  ].map((name): RecipeCategory => ({ name, i18nNames: {} })),
  ingredientCategories: [
    'Protein', 'Seafood', 'Produce', 'Dairy', 'Dry goods',
    'Bakery', 'Condiments', 'Drinks', 'Desserts',
  ].map((name): IngredientCategory => ({ name, i18nNames: {} })),
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
  // Spec 038 — preferred chrome language. Defaults to 'en'. Hydrated
  // synchronously at boot from localStorage (web) / asynchronously from
  // AsyncStorage (native) before the first render, then overridden by
  // profiles.locale once the session restore completes in App.tsx.
  locale: 'en' as Locale,
  // Spec 008: null = uncustomized. Hydrated from profiles.sidebar_layout
  // at login (App.tsx) and mutated by setSidebarLayoutOverride.
  sidebarLayoutOverride: null,
  notifications: [],
  storeLoading: false,
  ingredientConversions: [] as IngredientConversion[],
  savedReports: [],
  // Spec 016 — most-recent run per definitionId. Lazy-loaded; not
  // populated by loadFromSupabase (see `loadLatestRun`).
  reportRuns: {} as Record<string, ReportRun>,
  // Spec 021 — reorder-list envelope. Lazy-loaded on ReorderSection
  // mount; not populated by `loadFromSupabase`. The slice IS cleared
  // by `loadFromSupabase` (which fires on store switch via
  // `setCurrentStore`) so the section's mount-effect pulls fresh data
  // for the new store instead of flashing the previous store's cards.
  reorderPayload: null as ReorderPayload | null,
  reorderLoading: false,
  reorderError: null as string | null,
  // Spec 060 — server-computed per-recipe capacity for the active
  // store. Empty `{}` until `loadFromSupabase` triggers the
  // fire-and-forget `loadMenuCapacity(sid)` tail. Cleared on store
  // switch in the same `set({...})` block that resets the reorder
  // slice — so the prior store's numbers never flash in the new
  // store's RecipesSection.
  menuCapacity: {} as Record<string, MenuCapacityRow>,
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
    // Spec 038 — reset locale to 'en' so the next sign-in flow starts
    // from English chrome until getSession() resolves and hydrateLocale
    // re-applies the new user's preference. Avoids a flash of the
    // previous user's locale on the login screen for shared machines.
    // Persist locally too so a subsequent page reload before next sign-in
    // doesn't restore the prior user's cached locale via
    // readCachedLocaleSync (security-auditor Low).
    set({ locale: 'en' });
    persistLocaleLocal('en');
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

  deleteProfile: async (profileId, opts) => {
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
      // Spec 029 — `silent: true` (used by the self-delete branch in
      // UsersSection, which fires its own success toast) suppresses
      // this info-toast. Default + non-silent calls preserve the
      // existing 'Profile deleted' info-toast UX.
      if (!opts?.silent) {
        Toast.show({
          type: 'info',
          text1: 'Profile deleted',
          text2: 'Both profile row and auth user have been removed.',
          visibilityTime: 4000,
        });
      }
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
          // Spec 060 — capacity is per-store; cross-store rollup is OOS.
          // Clear so a switch from a real store to "All Stores" doesn't
          // leave stale numbers visible in RecipesSection's badge.
          menuCapacity: {},
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
        // Spec 021 — clear the reorder envelope on store switch so the
        // section's mount-effect pulls fresh data for the new store
        // instead of briefly showing the previous store's vendor cards.
        // The section will re-fetch via its useEffect on currentStore.id.
        reorderPayload: null,
        reorderLoading: false,
        reorderError: null,
        // Spec 060 — wipe per-recipe capacity on store switch so the
        // prior store's badges don't flash. The fire-and-forget
        // `loadMenuCapacity(sid)` below repopulates asynchronously;
        // RecipesSection's badge renders nothing in the gap.
        menuCapacity: {},
      });
      // Spec 060 — fire-and-forget capacity load. NOT awaited so the
      // first paint never blocks on the RPC (typical ~40-50ms on seed,
      // but a slow link could blow past `storeLoading`'s window).
      // Errors route through `notifyBackendError` inside the action.
      get().loadMenuCapacity(sid);
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
    const newItem: InventoryItem = { ...item, id: tempId };
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

  // Recipe Categories — Spec 040 P3: slice shape is now
  // `{ name; i18nNames }[]`. Equality / lookup still happens against
  // the English canonical `name` because the join column on `recipes`
  // / `inventory_items` stores English literals.
  addRecipeCategory: (name, i18nNames) => {
    const entry: RecipeCategory = { name, i18nNames: i18nNames ?? {} };
    set((s) => ({ recipeCategories: [...s.recipeCategories, entry] }));
    db.addRecipeCategory(name, i18nNames).catch((e: any) => {
      set((s) => ({
        recipeCategories: s.recipeCategories.filter((c) => c.name !== name),
      }));
      notifyBackendError('Add recipe category', e);
    });
  },

  updateRecipeCategory: (oldName, newName, i18nNames) => {
    const prevCats = get().recipeCategories;
    const prevRecipes = get().recipes;
    set((s) => ({
      recipeCategories: s.recipeCategories.map((c) =>
        c.name === oldName
          ? { name: newName, i18nNames: i18nNames ?? c.i18nNames }
          : c,
      ),
      recipes: s.recipes.map((r) =>
        r.category === oldName ? { ...r, category: newName } : r,
      ),
    }));
    db.updateRecipeCategory(oldName, newName, i18nNames).catch((e: any) => {
      set({ recipeCategories: prevCats, recipes: prevRecipes });
      notifyBackendError('Rename recipe category', e);
    });
  },

  deleteRecipeCategory: (name) => {
    const prevCats = get().recipeCategories;
    set((s) => ({
      recipeCategories: s.recipeCategories.filter((c) => c.name !== name),
    }));
    db.deleteRecipeCategory(name).catch((e: any) => {
      set({ recipeCategories: prevCats });
      notifyBackendError('Delete recipe category', e);
    });
  },

  setRecipeCategoryI18nNames: (name, i18nNames) => {
    const prev = get().recipeCategories;
    set((s) => ({
      recipeCategories: s.recipeCategories.map((c) =>
        c.name === name ? { ...c, i18nNames } : c,
      ),
    }));
    db.updateRecipeCategoryI18n(name, i18nNames).catch((e: any) => {
      set({ recipeCategories: prev });
      notifyBackendError('Save translation', e);
    });
  },

  // Ingredient Categories
  addIngredientCategory: (name, i18nNames) => {
    const entry: IngredientCategory = { name, i18nNames: i18nNames ?? {} };
    set((s) => ({
      ingredientCategories: [...s.ingredientCategories, entry],
    }));
    db.addIngredientCategory(name, i18nNames).catch((e: any) => {
      set((s) => ({
        ingredientCategories: s.ingredientCategories.filter((c) => c.name !== name),
      }));
      notifyBackendError('Add ingredient category', e);
    });
  },

  updateIngredientCategory: (oldName, newName, i18nNames) => {
    const prevCats = get().ingredientCategories;
    const prevInv = get().inventory;
    set((s) => ({
      ingredientCategories: s.ingredientCategories.map((c) =>
        c.name === oldName
          ? { name: newName, i18nNames: i18nNames ?? c.i18nNames }
          : c,
      ),
      inventory: s.inventory.map((i) =>
        i.category === oldName ? { ...i, category: newName } : i,
      ),
    }));
    db.updateIngredientCategory(oldName, newName, i18nNames).catch((e: any) => {
      set({ ingredientCategories: prevCats, inventory: prevInv });
      notifyBackendError('Rename ingredient category', e);
    });
  },

  deleteIngredientCategory: (name) => {
    const prevCats = get().ingredientCategories;
    set((s) => ({
      ingredientCategories: s.ingredientCategories.filter((c) => c.name !== name),
    }));
    db.deleteIngredientCategory(name).catch((e: any) => {
      set({ ingredientCategories: prevCats });
      notifyBackendError('Delete ingredient category', e);
    });
  },

  setIngredientCategoryI18nNames: (name, i18nNames) => {
    const prev = get().ingredientCategories;
    set((s) => ({
      ingredientCategories: s.ingredientCategories.map((c) =>
        c.name === name ? { ...c, i18nNames } : c,
      ),
    }));
    db.updateIngredientCategoryI18n(name, i18nNames).catch((e: any) => {
      set({ ingredientCategories: prev });
      notifyBackendError('Save translation', e);
    });
  },

  // Spec 040 P3 — catalog ingredient / recipe / prep recipe i18nNames
  // patches. Fired by the form auto-fill path when DeepL suggestions
  // resolve after the row already exists. Optimistic-then-revert.
  setCatalogI18nNames: (catalogId, i18nNames) => {
    if (!catalogId) return;
    const prevCatalog = get().catalogIngredients;
    const prevInventory = get().inventory;
    set((s) => ({
      catalogIngredients: s.catalogIngredients.map((c) =>
        c.id === catalogId ? { ...c, i18nNames } : c,
      ),
      // Inventory rows hydrate `i18nNames` from the joined catalog row —
      // patch local matches so list/detail views render the new
      // translations immediately without waiting for the next reload.
      inventory: s.inventory.map((i) =>
        i.catalogId === catalogId ? { ...i, i18nNames } : i,
      ),
    }));
    db.updateCatalogIngredientI18n(catalogId, i18nNames).catch((e: any) => {
      set({ catalogIngredients: prevCatalog, inventory: prevInventory });
      notifyBackendError('Save translation', e);
    });
  },

  setRecipeI18nNames: (recipeId, i18nNames) => {
    if (!recipeId) return;
    const prev = get().recipes;
    set((s) => ({
      recipes: s.recipes.map((r) =>
        r.id === recipeId ? { ...r, i18nNames } : r,
      ),
    }));
    db.updateRecipeI18n(recipeId, i18nNames).catch((e: any) => {
      set({ recipes: prev });
      notifyBackendError('Save translation', e);
    });
  },

  setPrepRecipeI18nNames: (prepId, i18nNames) => {
    if (!prepId) return;
    const prev = get().prepRecipes;
    set((s) => ({
      prepRecipes: s.prepRecipes.map((r) =>
        r.id === prepId ? { ...r, i18nNames } : r,
      ),
    }));
    db.updatePrepRecipeI18n(prepId, i18nNames).catch((e: any) => {
      set({ prepRecipes: prev });
      notifyBackendError('Save translation', e);
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
    // Spec 020: per-vendor partitioning. Merge lookup is now scoped on
    // (storeId, date, vendorId) to mirror the new DB UNIQUE (store_id, date,
    // vendor_id). Two same-day submissions for DIFFERENT vendors create two
    // separate rows; an EDIT on the SAME vendor still merges into the same
    // row.
    const subVendorId = submission.vendorId;
    const subVendorName = submission.vendorName;
    const existing = get().eodSubmissions.find(
      (s) =>
        s.storeId === submission.storeId &&
        s.date === submission.date &&
        s.vendorId === subVendorId
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
      // Spec 020 Q6: vendor-scoped current_stock writes. A vendor's EOD only
      // mutates inventory items belonging to that vendor. Items counted via
      // the unscheduled-item escape hatch (their vendorId !== submission's
      // vendorId, OR the item has null vendorId) still produce eod_entries
      // (via db.submitEODCount) and an audit row (below), but their
      // inventory_items.current_stock is NOT touched here. The previous
      // guard short-circuited true for null-vendor items, bypassing the
      // vendor filter and letting the admin-JWT db.adjustItemStock path
      // overwrite escape-hatch stock — code-reviewer round-2 C2 catch.
      // Strict equality preserves the RPC's `where vendor_id = p_vendor_id`
      // semantics (no UPDATE fires when the item's vendor differs from
      // the submission's vendor, including null-vendor items).
      const item = get().inventory.find((i) => i.id === entry.itemId);
      const itemMatchesSubmittedVendor = item?.vendorId === subVendorId;

      if (itemMatchesSubmittedVendor) {
        set((s) => ({
          inventory: s.inventory.map((it) =>
            it.id === entry.itemId
              ? {
                  ...it,
                  // EOD count is the authoritative re-measurement of the shelf,
                  // so reset currentStock too. Without this, dashboard tiles
                  // (inventory value, low/out-of-stock, stock alerts) keep
                  // showing pre-count zeros — see DashboardScreen `inventoryValue`.
                  currentStock: entry.actualRemaining,
                  eodRemaining: entry.actualRemaining,
                  lastUpdatedBy: entry.submittedBy,
                  lastUpdatedAt: entry.timestamp,
                }
              : it
          ),
        }));
        // Persist the recalibration so it survives reload. Mirrors the
        // adjustStock action's db.adjustItemStock call (line ~325 above).
        // Only fires for items matching the submitted vendor — escape-hatch
        // items keep their server-side current_stock untouched per Q6.
        db
          .adjustItemStock(
            entry.itemId,
            entry.actualRemaining,
            entry.submittedByUserId || get().currentUser?.id || '',
          )
          .catch((e: any) => console.warn('[Supabase]', e?.message || e));
      }
      // Audit row fires regardless of vendor match so the count is always
      // traceable. The prefix uses the action verb ("Count updated" /
      // "Remaining count submitted") so the audit feed reads naturally
      // in the Cmd UI's authed-user path. The staff-app RPC's audit row
      // uses `<submitted_by> · vendor: <name>` (no verb prefix) because
      // p_submitted_by is already the display name and the audit table is
      // read in plain SQL by ops/admin tools. Both paths share the
      // ` · vendor: <name>` suffix so parsers that split on " · vendor: "
      // get consistent vendor identification across paths.
      const detailBase = existing ? 'Count updated' : 'Remaining count submitted';
      const detail = subVendorName
        ? `${detailBase} · vendor: ${subVendorName}`
        : detailBase;
      get().addAuditEvent({
        timestamp: entry.timestamp,
        userId: entry.submittedByUserId,
        userName: entry.submittedBy,
        userRole: 'user',
        storeId: submission.storeId,
        storeName: submission.storeName,
        action: 'EOD entry',
        detail,
        itemRef: entry.itemName,
        value: `${entry.actualRemaining} ${entry.unit}`,
      });
    });

    // Broadcast a bell-icon notification to every other admin + linked user
    // of this store. In-app only; push/email stays scoped to the reminder cron.
    const submitterName = submission.submittedBy || get().currentUser?.name || 'someone';
    const verb = existing ? 'edited' : 'submitted';
    const vendorSuffix = subVendorName ? ` (${subVendorName})` : '';
    const msg = `${submitterName} ${verb} today's EOD count${vendorSuffix} for ${submission.storeName}`;
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

  // Spec 019 — Any-time inventory count. No persistent slice mutation;
  // the section component fetches counts on demand via db.fetchRecent…
  // and db.fetchInventoryCount, mirroring how `loadLatestRun` keeps the
  // boot payload bounded.
  submitInventoryCount: async (input) => {
    const storeId = input.storeId || get().currentStore?.id;
    if (!storeId || storeId === '__all__') {
      const e = new Error('No active store');
      notifyBackendError('Submit inventory count', e);
      return null;
    }
    // The caller (the section) mints the `client_uuid` ONCE per submit-
    // button press and passes it here. A retry from the section with the
    // same UUID flows through the RPC's idempotency check rather than
    // producing a duplicate row. Architect §6 + §10.
    try {
      const result = await db.submitInventoryCount({
        storeId,
        kind: input.kind,
        countedAt: input.countedAt,
        status: input.status,
        entries: input.entries,
        notes: input.notes ?? null,
        clientUuid: input.clientUuid,
      });
      return { countId: result.countId, conflict: result.conflict };
    } catch (e: any) {
      notifyBackendError('Submit inventory count', e);
      return null;
    }
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
    let updated = 0;
    try {
      updated = await db.applyAliasToPastImports(storeId, posName, recipeId);
    } catch (e: any) {
      console.warn('[Supabase] applyAliasToPastImports:', e?.message || e);
      return 0;
    }
    // Spec 015 §7b — local reconciliation. After the server-side `ilike`
    // UPDATE returns N, walk the in-memory `posImports` slice and patch any
    // `items[].menuItem` that case-insensitive-trim-matches `posName` so the
    // imports.log row counts and the UNMAPPED.LOG panel stay in sync within
    // the same session without a full reload. `posImports` is not hydrated
    // from Supabase and not realtime-echoed for this table, so this patch is
    // the only way the local UI reflects what the server just changed.
    if (updated > 0) {
      const target = posName.trim().toLowerCase();
      set((s) => ({
        posImports: s.posImports.map((im) => {
          if (im.storeId !== storeId) return im;
          let dirty = false;
          const items = (im.items || []).map((it) => {
            if (it.recipeMapped) return it;
            const name = (it.menuItem || '').trim().toLowerCase();
            if (name !== target) return it;
            dirty = true;
            return { ...it, recipeMapped: true, recipeId };
          });
          return dirty ? { ...im, items } : im;
        }),
      }));
    }
    return updated;
  },

  // Spec 015 §7a — remove a store-scoped alias. Optimistic-then-revert,
  // mirrors `removeOrderScheduleEntry`. Snapshot the prev slice, mutate
  // locally first, fire the DELETE, revert + toast on backend failure.
  removePosRecipeAlias: async (posName) => {
    const storeId = get().currentStore.id;
    if (!storeId || !posName) return;
    const trimmed = posName.trim();
    if (!trimmed) return;
    const prev = get().posRecipeAliases;
    set({
      posRecipeAliases: prev.filter(
        (a) => !(
          a.store_id === storeId
          && a.pos_name.trim().toLowerCase() === trimmed.toLowerCase()
        ),
      ),
    });
    try {
      await db.deletePosRecipeAlias(storeId, trimmed);
    } catch (e: any) {
      set({ posRecipeAliases: prev });
      notifyBackendError('Remove alias', e);
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
    // Snapshot for revert-on-error (Spec 083 — optimistic-then-revert parity
    // with the rest of the store).
    const prevStores = get().stores;
    const prevCurrentStore = get().currentStore;
    set((s) => ({
      stores: s.stores.map((st) => st.id === id ? { ...st, ...updates } : st),
      currentStore: s.currentStore.id === id ? { ...s.currentStore, ...updates } : s.currentStore,
    }));
    // Spec 083 — delegate the write to db.updateStore (closes the inline
    // supabase.from('stores') carve-out) and include `status` in the partial
    // update. The privileged_update_stores RLS policy enforces the
    // admin/master/super_admin gate server-side.
    //
    // The explicit 4-field object is REQUIRED, not redundant: `updates` is typed
    // Partial<Store> (wider) while db.updateStore takes
    // Partial<Pick<Store,'name'|'address'|'eodDeadlineTime'|'status'>>. Spreading
    // `updates` directly would be a type error; this literal narrows to exactly
    // the writable fields and intentionally drops `brandId` (a brand transfer
    // would trip auth_can_see_brand WITH CHECK — see db.updateStore). Do NOT
    // "simplify" this back into a passthrough that reintroduces brandId.
    db.updateStore(id, {
      name: updates.name,
      address: updates.address,
      eodDeadlineTime: updates.eodDeadlineTime,
      status: updates.status,
    }).catch((e: any) => {
      set({ stores: prevStores, currentStore: prevCurrentStore });
      notifyBackendError('Update store', e);
    });
  },

  // Spec 098 — per-store weekly-count due day-of-week. Separate from
  // updateStore because that action intentionally narrows to a 4-field
  // writable subset and drops weeklyCountDueDow; the dedicated cadence
  // write goes straight through db.updateStore's extended Pick.
  setStoreWeeklyDueDow: (id, dow) => {
    const prevStores = get().stores;
    const prevCurrentStore = get().currentStore;
    set((s) => ({
      stores: s.stores.map((st) =>
        st.id === id ? { ...st, weeklyCountDueDow: dow } : st,
      ),
      currentStore:
        s.currentStore.id === id
          ? { ...s.currentStore, weeklyCountDueDow: dow }
          : s.currentStore,
    }));
    db.updateStore(id, { weeklyCountDueDow: dow }).catch((e: any) => {
      set({ stores: prevStores, currentStore: prevCurrentStore });
      notifyBackendError('Set weekly due day', e);
    });
  },

  // Spec 098 — load per-store weekly-count status for the admin tab.
  loadWeeklyCountStatus: async (asOfDate) => {
    set({ weeklyCountStatusLoading: true });
    try {
      const rows = await db.fetchWeeklyCountStatus(asOfDate);
      set({ weeklyCountStatus: rows });
    } catch (e: any) {
      notifyBackendError('Load weekly count status', e);
    } finally {
      set({ weeklyCountStatusLoading: false });
    }
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

  // Spec 038 — chrome-language preference. Optimistic-then-revert via
  // notifyBackendError per architect §5. Mirrors setSidebarLayoutOverride
  // rather than the simpler toggleDarkMode pattern because language
  // errors are more user-visible — a user toggling and getting silent
  // failure would be confused on their next device.
  setLocale: (next) => {
    const prev = get().locale;
    if (prev === next) return;
    set({ locale: next });
    // Persist locally (web localStorage / native AsyncStorage) for
    // instant boot-time restore on the next reload.
    persistLocaleLocal(next);
    const userId = get().currentUser?.id;
    // Not logged in (e.g. login screen) — local-only, no DB write.
    if (!userId) return;
    db.saveLocale(userId, next).catch((e: any) => {
      set({ locale: prev });
      notifyBackendError('Save language', e);
    });
  },

  // Spec 038 — no-persist hydrator. Mirrors setDarkMode / hydrate-
  // SidebarLayoutOverride. Used by App.tsx after getSession() returns
  // to seed the store from the DB-stored value without round-tripping
  // it back to the column.
  hydrateLocale: (next) => {
    set({ locale: next });
  },

  // Spec 044 — no-persist brand-slice hydrator. Mirrors hydrateLocale.
  // App.tsx calls this BEFORE login() so the TitleBar's store-picker
  // prefix renders the right brand initials (e.g. `2P://towson`) on the
  // very first paint, instead of flashing `inv://towson` while the
  // setCurrentStore → loadFromSupabase chain finishes ~50-200 ms later.
  // The async refresh from loadFromSupabase overwrites with the same
  // brand row (visually a no-op); we just buy the first-paint frame.
  hydrateBrand: (brand) => {
    set({ brand });
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

  // Spec 016 — report runs (lazy-loaded)
  runReport: (definitionId, overrideParams) => {
    const def = (get().savedReports || []).find((r) => r.id === definitionId);
    if (!def) return;
    // Snapshot the previous run (if any) BEFORE the optimistic write so an
    // RLS-rejected retry can restore the last-good row instead of leaving
    // the detail frame stuck in "No runs yet". Mirror of the pattern in
    // `deleteReportDefinition` above. Spec 016 follow-up — closes
    // code-reviewer Should-fix #4.
    const prev = (get().reportRuns || {})[definitionId] ?? null;
    // Spec 017 (REPORTS-2) — merge override over saved params for this
    // run only. The merged object travels to the optimistic display row,
    // the dispatcher RPC, AND the persisted `report_runs.params` so the
    // audit trail reflects what was actually computed. `def.params` is
    // left untouched so the saved definition is preserved.
    const mergedParams: Record<string, unknown> = overrideParams
      ? { ...(def.params || {}), ...overrideParams }
      : (def.params || {});
    const optimistic: ReportRun = {
      id: `run-pending-${Date.now()}`,
      definitionId,
      templateId: def.templateId,
      storeId: def.storeId,
      params: mergedParams,
      output: null,
      status: 'pending',
      errorMessage: null,
      ranAt: new Date().toISOString(),
      // `ranBy` here is purely for the optimistic display row — it does
      // NOT travel to the server. The persisted `ran_by` value is set by
      // the column's `default auth.uid()` (spec 016 follow-up migration
      // `20260510130000_report_runs_consistency.sql`).
      ranBy: get().currentUser?.id || null,
    };
    set((s) => ({
      reportRuns: { ...(s.reportRuns || {}), [definitionId]: optimistic },
    }));

    db.runReport({
      definitionId,
      templateId: def.templateId,
      storeId: def.storeId,
      params: def.params || {},
      overrideParams,
    })
      .then((saved) => {
        set((s) => ({
          reportRuns: { ...(s.reportRuns || {}), [definitionId]: saved },
        }));
      })
      .catch((e: any) => {
        set((s) => {
          const next = { ...(s.reportRuns || {}) };
          if (prev) {
            next[definitionId] = prev;
          } else {
            delete next[definitionId];
          }
          return { reportRuns: next };
        });
        notifyBackendError('Run report', e);
      });
  },

  loadLatestRun: async (definitionId) => {
    try {
      const row = await db.fetchLatestRun({ definitionId });
      if (row) {
        set((s) => ({
          reportRuns: { ...(s.reportRuns || {}), [definitionId]: row },
        }));
      }
    } catch (e: any) {
      console.warn('[Supabase] loadLatestRun:', e?.message || e);
    }
  },

  // Spec 021 — lazy-load the reorder envelope for currentStore. Reads via
  // `db.fetchReorderSuggestions` which calls the `report_reorder_list`
  // RPC. Error path mirrors `loadLatestRun` (console.warn + in-state
  // error) — surfacing as a toast on a section open would be noisy, so
  // the section renders its own error pane.
  loadReorderSuggestions: async (asOfDate) => {
    const storeId = get().currentStore?.id;
    if (!storeId) return;
    set({ reorderLoading: true, reorderError: null });
    try {
      const payload = await db.fetchReorderSuggestions(storeId, asOfDate);
      set({ reorderPayload: payload, reorderLoading: false, reorderError: null });
    } catch (e: any) {
      const message = e?.message || String(e);
      console.warn('[Supabase] loadReorderSuggestions:', message);
      set({ reorderLoading: false, reorderError: message });
    }
  },

  // Spec 060 — load server-computed per-recipe capacity for the
  // active store. Called fire-and-forget by `loadFromSupabase`. Reduces
  // the array → keyed object so the inline badge in `RecipesSection`
  // can do O(1) lookups by recipeId.
  //
  // The `__all__` super-admin view skips this load (capacity is
  // per-store; cross-store rollup is out of scope per spec).
  //
  // No optimistic behavior — this is a pure read. On error, we wipe
  // the slice to `{}` (so the badge degrades to "render nothing"
  // rather than showing stale numbers from a prior store) and toast
  // via `notifyBackendError`.
  loadMenuCapacity: async (storeId) => {
    const sid = storeId || get().currentStore?.id;
    if (!sid || sid === '__all__') return;
    try {
      const rows = await db.fetchMenuCapacity(sid);
      const keyed: Record<string, MenuCapacityRow> = {};
      for (const r of rows) {
        if (r.recipeId) keyed[r.recipeId] = r;
      }
      set({ menuCapacity: keyed });
    } catch (e: any) {
      set({ menuCapacity: {} });
      notifyBackendError('Load menu capacity', e);
    }
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

  // Resolve a prep_recipes id to the current version of its lineage. Recipes
  // and sub-recipes may reference an older version (is_current=false) created
  // before a version bump; without this walk, downstream cost calc finds
  // nothing and returns $0. Walks descendants via parent_id with a cycle
  // guard. Returns the original prep if no descendants exist (orphaned
  // chains still get the historical record rather than nothing).
  getPrepRecipe: (prepRecipeId) => {
    const all = get().prepRecipes;
    const visited = new Set<string>();
    let cur = all.find((p) => p.id === prepRecipeId);
    if (!cur) return undefined;
    while (cur.isCurrent === false && !visited.has(cur.id)) {
      visited.add(cur.id);
      const child = all.find((p) => p.parentId === cur!.id);
      if (!child) break;
      cur = child;
    }
    return cur;
  },

  // Prep recipe cost = sum of ingredient costs (supports sub-recipes with cycle guard)
  getPrepRecipeCost: (prepRecipeId) => {
    const calcCost = (id: string, visited: Set<string>): number => {
      if (visited.has(id)) return 0; // cycle detected
      visited.add(id);
      const prep = get().getPrepRecipe(id);
      if (!prep) return 0;
      const { getConversionFactor, smartToBase } = require('../utils/unitConversion');
      const allConversions = get().ingredientConversions || [];
      return prep.ingredients.reduce((sum, ing) => {
        const isSubRecipe = (ing.type || 'raw') === 'prep';
        if (isSubRecipe) {
          const subRecipe = get().getPrepRecipe(ing.itemId);
          if (!subRecipe) return sum;
          const subCost = calcCost(subRecipe.id, new Set(visited));
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
    const prep = get().getPrepRecipe(prepRecipeId);
    if (!prep) return 0;
    const totalCost = get().getPrepRecipeCost(prep.id);
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
      const subRecipe = get().getPrepRecipe(prep.prepRecipeId);
      if (!subRecipe) return sum;
      const costPerUnit = get().getPrepRecipeCostPerUnit(subRecipe.id);
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
