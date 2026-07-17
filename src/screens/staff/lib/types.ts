// src/lib/types.ts — shared TypeScript types for the imr-staff EOD slice.
//
// These mirror the imr-inventory contract (spec 061) and the v1 queue
// shape canonicalized in spec 062 §3. They are intentionally NOT in
// src/types/index.ts (no such file exists yet) — the staff app is small
// enough that a single co-located types file is sufficient.

// Per-locale name override map. Reuses the SHARED admin type (spec 040)
// rather than a staff mirror — it's a pure type, no supabase coupling, and
// the staff `Locale` union is byte-identical to the admin one, so the
// pure `getLocalizedName` resolver (src/i18n/localizedName.ts) consumes
// both without drift. Carries `catalog_ingredients.i18n_names` so the
// count screens can render item names in the active locale.
import type { LocalizedNames } from '../../../types';

/** Per-store assignment row read from `user_stores` joined with stores. */
export type UserStore = {
  storeId: string;
  storeName: string;
};

/** Inventory item row for the EOD count screen list. Shape derived from
 *  the imr-inventory inventory_items + catalog_ingredients JOIN; we
 *  need name + unit + vendor scoping, plus the units-per-case
 *  (`catalog_ingredients.case_qty`) so the Cases input can convert to a
 *  total exactly like the admin worksheet (spec 086).
 *
 *  `caseQty` is kept nullable (NOT collapsed to 1 at hydration like the
 *  admin mapper at db.ts:3385) so a future pack-size-aware feature can
 *  tell "genuinely 1-per-case" from "unknown". The conversion site
 *  applies the admin's `|| 1` fallback, so the arithmetic is identical. */
export type EodItem = {
  id: string;
  vendorId: string | null;
  name: string;
  unit: string;
  caseQty: number | null;
  /** Per-locale name overrides from `catalog_ingredients.i18n_names`.
   *  Optional — absent on legacy/un-translated rows. The display name is
   *  resolved via `getLocalizedName({ name, i18nNames }, locale)` so the
   *  list re-renders in the active staff locale. */
  i18nNames?: LocalizedNames;
  /** Spec 127 — brand-shared ingredient photo OBJECT PATH from
   *  `catalog_ingredients.image_path` (`<brandId>/<catalogId>/<uuid>.jpg`, NOT
   *  a URL). Resolved to a public CDN URL via `ingredientImageUrl`
   *  (../../../lib/ingredientImage) at render time. Optional — absent/undefined
   *  or null = no photo → the count row renders the placeholder thumbnail. */
  imagePath?: string | null;
  /** Spec 128 — whether this item's product effectively changed (photo or
   *  primary-vendor) since THIS store last counted it. Set from the
   *  `staff_items_updated` RPC (via `fetchUpdatedItemIds`) and merged onto the
   *  item before `setItems`. Absent/false → no "Updated" badge. */
  updated?: boolean;
};

/** Vendor row (id + name) for the vendor switcher. */
export type Vendor = {
  id: string;
  name: string;
};

/** Single entry inside a queued submission. Spec 086: the staff screen
 *  now records full Cases + loose Units per item, converted to a single
 *  total client-side (`cases × (caseQty || 1) + units`). We persist all
 *  three values using the snake_case `eod_entries` column names so the
 *  RPC boundary (`entriesForRpc`) is a near-identity map and the queued
 *  payload reads 1:1 against the DB columns. The single `count` field
 *  from spec 062 is removed — every reader is in-repo and updated in
 *  spec 086, and a persisted `:v1` payload is migrated in
 *  `migrateQueueIfNeeded` (NOT aliased — a half-migrated shape would be
 *  ambiguous).
 *
 *  `actual_remaining` is the computed total (the number the reports
 *  read); the raw splits are null when the corresponding box is blank
 *  (mirrors the admin's `actualRemainingCases` / `actualRemainingEach`
 *  on `src/types/index.ts`). */
export type EodEntry = {
  item_id: string;
  actual_remaining: number;
  actual_remaining_cases: number | null;
  actual_remaining_each: number | null;
};

/** Canonical shape persisted to AsyncStorage. Single source of truth
 *  for the queue payload (spec 062 §3 — bump the storage key version
 *  if this shape changes). */
export type QueuedSubmission = {
  client_uuid: string;
  store_id: string;
  date: string;          // ISO yyyy-mm-dd — captured at submit-press, not mount
  vendor_id: string;
  status: 'submitted';
  entries: EodEntry[];
  queued_at: string;     // ISO timestamp
  intent_user_id: string;
  attempts: number;
  lastError?: string;
};

/** Active sign-in state machine — see spec 062 §2.
 *
 * Note: prior cycles included a `toast?: string` field on 'signed-out'
 * but it had no consumer — the SignIn screen never read it. We now
 * fire toasts directly at the failure site (RootStack.restoreSession,
 * SignIn.runGate) so the gate-failure path always surfaces a message.
 */
export type AuthState =
  | { kind: 'idle' }
  | { kind: 'restoring' }
  | { kind: 'signing-in' }
  | { kind: 'gating' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; userId: string; stores: UserStore[] };

/** Active store currently selected. Persisted to
 *  `imr-staff:active-store:v1`. */
export type ActiveStore = {
  id: string;
  name: string;
} | null;

/** RPC request payload — what `EODCount` submits. */
export type SubmitPayload = {
  store_id: string;
  date: string;
  vendor_id: string;
  entries: EodEntry[];
};

/** RPC response envelope. */
export type StaffSubmitEodResponse = {
  submission_id: string;
  conflict: boolean;
  reason?: string;
};

/** Outcome of a single submit() call — drives the UI presentation
 *  layer. See spec 062 §4. */
export type Outcome =
  | { kind: 'success';        submission_id: string }
  | { kind: 'success-replay'; submission_id: string }
  | { kind: 'forbidden';      message: string }
  | { kind: 'queued';         client_uuid: string }
  | { kind: 'failed';         message: string };

/** Spec 098 — weekly full-store count item (NOT vendor-scoped). Same
 *  catalog-derived shape as EodItem minus the vendor scoping; the weekly
 *  screen lists EVERY item at the active store. `caseQty` kept nullable
 *  (collapsed to 1 at the conversion site via `|| 1`). */
export type WeeklyItem = {
  id: string;
  name: string;
  unit: string;
  /** Catalog category for display-only grouping. Collapsed to '' when the
   *  catalog row has no category (same convention as the admin inventory
   *  mapper at db.ts:3498); the screen renders the '' bucket under an
   *  "Uncategorized" header. Category does NOT affect what is submitted. */
  category: string;
  caseQty: number | null;
  /** Per-locale name overrides from `catalog_ingredients.i18n_names`.
   *  Optional — absent on legacy/un-translated rows. Resolved at render
   *  via `getLocalizedName({ name, i18nNames }, locale)` so item names
   *  switch with the active staff locale. */
  i18nNames?: LocalizedNames;
  /** Spec 127 — brand-shared ingredient photo OBJECT PATH from
   *  `catalog_ingredients.image_path` (`<brandId>/<catalogId>/<uuid>.jpg`, NOT
   *  a URL). Resolved via `ingredientImageUrl` (../../../lib/ingredientImage) at
   *  render time. Optional — absent/null = no photo → placeholder thumbnail. */
  imagePath?: string | null;
  /** Spec 128 — whether this item's product effectively changed (photo or
   *  primary-vendor) since THIS store last counted it. Set from the
   *  `staff_items_updated` RPC (via `fetchUpdatedItemIds`) and merged onto the
   *  item before `setItems`. Absent/false → no "Updated" badge. */
  updated?: boolean;
};

/** Spec 098 — single entry inside a weekly-count submit. Mirrors the
 *  admin `submit_weekly_count` RPC entry contract (snake_case). */
export type WeeklyEntry = {
  item_id: string;
  actual_remaining: number;
  actual_remaining_cases: number | null;
  actual_remaining_each: number | null;
  unit: string | null;
};

/** Spec 098 — the `weekly_count_status` RPC result for the active store
 *  (camelCase mirror of the RPC return row). Drives the WeeklyDueBanner
 *  and the post-submit confirmation copy. */
export type WeeklyStatusValue =
  | 'not_scheduled'
  | 'completed'
  | 'open'
  | 'overdue';

export type WeeklyStatus = {
  storeId: string;
  dueDow: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  status: WeeklyStatusValue;
  lastCountId: string | null;
  lastCountedAt: string | null;
};

/** Spec 098 — `submit_weekly_count` RPC response envelope. */
export type SubmitWeeklyResponse = {
  count_id: string;
  conflict: boolean;
  entry_ids: string[];
};

/** Existing submission summary for the "Last submitted at HH:MM" banner
 *  + pre-fill. Server-side fetch happens on screen mount + vendor
 *  switcher change. */
export type ExistingSubmission = {
  submission_id: string;
  submitted_at: string;            // ISO timestamp
  entries: EodEntry[];
};
