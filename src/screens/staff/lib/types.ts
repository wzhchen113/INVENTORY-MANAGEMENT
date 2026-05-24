// src/lib/types.ts — shared TypeScript types for the imr-staff EOD slice.
//
// These mirror the imr-inventory contract (spec 061) and the v1 queue
// shape canonicalized in spec 062 §3. They are intentionally NOT in
// src/types/index.ts (no such file exists yet) — the staff app is small
// enough that a single co-located types file is sufficient.

/** Per-store assignment row read from `user_stores` joined with stores. */
export type UserStore = {
  storeId: string;
  storeName: string;
};

/** Inventory item row for the EOD count screen list. Shape derived from
 *  the imr-inventory inventory_items + catalog_ingredients JOIN; we
 *  only need name + unit + vendor scoping for v1. */
export type EodItem = {
  id: string;
  vendorId: string | null;
  name: string;
  unit: string;
};

/** Vendor row (id + name) for the vendor switcher. */
export type Vendor = {
  id: string;
  name: string;
};

/** Single entry inside a queued submission. UI-side shape uses
 *  item_id + count for readability; the RPC boundary remaps to
 *  ingredient_id + actual_remaining inside `useEodSubmit`. */
export type EodEntry = {
  item_id: string;
  count: number;
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

/** Existing submission summary for the "Last submitted at HH:MM" banner
 *  + pre-fill. Server-side fetch happens on screen mount + vendor
 *  switcher change. */
export type ExistingSubmission = {
  submission_id: string;
  submitted_at: string;            // ISO timestamp
  entries: EodEntry[];
};
