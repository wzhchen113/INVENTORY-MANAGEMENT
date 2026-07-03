// src/screens/staff/lib/countDrafts.ts — staff per-user count-draft I/O (carve-out).
//
// Spec 106 §6. The staff subtree uses the documented direct-`supabase`
// carve-out (CLAUDE.md "DB access centralized" — the whole staff subtree may
// call `supabase.from/rpc` directly, like the EOD fetch helpers in
// EODCount.tsx + fetchReorder.ts + the spec-103 countOrder carve-out). So the
// read/save/delete of the SAME `public.user_count_drafts` table the admin path
// touches via `src/lib/db.ts:fetchCountDraft/saveCountDraft/deleteCountDraft`
// is authored here a SECOND time — intentionally. The carve-out is about the
// I/O call sites, NOT the pure logic: the reconcile / stale-filter /
// (de)serialize helpers are RE-EXPORTED from `src/lib/countDrafts.ts` so the
// only logic worth testing stays single-sourced (design §6 / §8), and the
// staff screen imports the ENTIRE draft surface from this one staff-local
// module.
//
// This file mirrors the admin helpers' contract:
//   - fetchCountDraft  → the draft row envelope, or null when no row exists.
//   - saveCountDraft   → PLAIN UPSERT on the FULL unique constraint
//                        (onConflict 'user_id,screen,store_id') — the spec-106
//                        divergence from spec 103's delete-then-insert; the
//                        full constraint IS a valid ON CONFLICT target.
//   - deleteCountDraft → delete the one (user, screen, store) slot.
// Errors throw (PostgREST error) so the screen reverts + notifies via the staff
// notifyBackendError — same posture as fetchReorder / the countOrder carve-out.
// No `useInflight.track()` (that's the admin path); plain `await`.
//
// Device-local offline fallback uses AsyncStorage with a VERSIONED key, modeled
// on eodQueue's key-constant + backupCorrupt conventions (NOT the eodQueue array
// itself — a draft is a single-slot overwrite, not a FIFO of finished submits;
// the spec OoS'd reusing the queue mechanism).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../../lib/supabase';
import { isLocalDraftRecord } from '../../../lib/countDrafts';
import type { CountOrderScreen } from '../../../lib/countOrder';
import type { CountDraftRow } from '../../../lib/db';

// Re-export the pure helpers + all draft types so the staff screens import the
// ENTIRE draft surface from one staff-local module (the pure logic transparently
// re-exported from src/lib/countDrafts, the I/O authored here).
export {
  reconcileDrafts,
  applyDraftStaleFilter,
  serializeAdminInventoryDraft,
  deserializeAdminInventoryDraft,
  serializeWeeklyDraft,
  deserializeWeeklyDraft,
  COUNT_DRAFT_PAYLOAD_VERSION,
} from '../../../lib/countDrafts';
export type {
  CountOrderScreen,
  DraftCandidate,
  LocalDraftCandidate,
  ReconcileAction,
  ReconcileResult,
  CountKind,
  AdminInventoryDraftForm,
  WeeklyDraftForm,
} from '../../../lib/countDrafts';
export type { CountDraftRow } from '../../../lib/db';

// ─── Server I/O (direct supabase, no track) ──────────────────

/**
 * READ (on screen open). Returns the draft row envelope, or `null` when no row
 * exists for the (user, screen, store) slot (the no-draft state — NOT an
 * error). A genuine error throws; the caller degrades to "no draft" and the
 * form renders fresh (AC-5 restore is best-effort), surfacing via the staff
 * notifyBackendError. payload is opaque JSONB (the pure serializer owns it);
 * saved_at is camelCased inline to savedAt.
 */
export async function fetchCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): Promise<CountDraftRow | null> {
  const { data, error } = await supabase
    .from('user_count_drafts')
    .select('payload, saved_at')
    .eq('user_id', userId)
    .eq('screen', screen)
    .eq('store_id', storeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    payload: (data.payload ?? {}) as Record<string, unknown>,
    savedAt: data.saved_at as string,
  };
}

/**
 * SAVE (upsert whole-draft). Replaces the one (user, screen, store) slot as a
 * PLAIN UPSERT on the FULL unique constraint (onConflict
 * 'user_id,screen,store_id') — the spec-106 divergence from spec 103's
 * delete-then-insert (design §4/§6). Throws on error so the screen reverts +
 * notifyBackendError.
 *
 * `savedAt` is minted by the CALLER at Save time and passed through UNCHANGED so
 * the SAME stamp lands on both the server row and the AsyncStorage copy (design
 * §9) — that is what makes the reconcile equal-tie a true "already synced"
 * no-op. The helper does NOT mint saved_at. `updated_at` is a fresh server-audit
 * timestamp; the reconcile never reads it.
 */
export async function saveCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
  payload: Record<string, unknown>,
  savedAt: string,
): Promise<void> {
  const { error } = await supabase
    .from('user_count_drafts')
    .upsert(
      {
        user_id: userId,
        screen,
        store_id: storeId,
        payload,
        saved_at: savedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,screen,store_id' },
    );
  if (error) throw error;
}

/**
 * DELETE the one (user, screen, store) slot. Used by both Discard (AC-7) and
 * the successful-Submit cleanup (AC-8). Throws on error. Touches ONLY this slot.
 */
export async function deleteCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): Promise<void> {
  const { error } = await supabase
    .from('user_count_drafts')
    .delete()
    .eq('user_id', userId)
    .eq('screen', screen)
    .eq('store_id', storeId);
  if (error) throw error;
}

// ─── Device-local offline fallback (AsyncStorage) ────────────
//
// Single record per (user, screen, store) slot — OVERWRITE, not append (the
// OoS'd eodQueue is a FIFO of finished submits; a draft is single-slot). The
// `:v1` suffix follows the eodQueue migration-contract convention: bump it if
// the local record shape changes and document the transform (see MIGRATION
// CONTRACT at the bottom).

/** Local single-slot record. Mirrors the admin LocalCountDraft (design §5). */
export type LocalStaffDraft = {
  payload: Record<string, unknown>;
  savedAt: string; // ISO-8601, same stamp as the server copy when synced
  unsynced: boolean; // true = written offline, not yet pushed
};

/** Canonical storage-key prefix (design §6). Full key:
 *  `imr-staff:count-draft:v1:<screen>:<storeId>:<userId>`. */
export const COUNT_DRAFT_KEY_PREFIX = 'imr-staff:count-draft:v1';

/** Build the per-slot AsyncStorage key. */
export function staffCountDraftKey(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): string {
  return `${COUNT_DRAFT_KEY_PREFIX}:${screen}:${storeId}:${userId}`;
}

/** Shape-validator: a parsed local record must be a single-slot draft, else it
 *  is treated as no-draft (a malformed record never crashes a restore).
 *  Delegates to the shared predicate in src/lib/countDrafts.ts (single-sourced
 *  with the admin trio — hygiene sweep dedup). */
function isLocalStaffDraft(x: unknown): x is LocalStaffDraft {
  return isLocalDraftRecord(x);
}

/**
 * READ the device-local draft for the slot, or `null` when absent / malformed /
 * unreadable. NEVER throws; corrupt bytes are backed up to a
 * `<key>-corrupted:<ISO>` key so debug can recover them (eodQueue.backupCorrupt
 * posture), then treated as no-draft.
 */
export async function readLocalStaffDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): Promise<LocalStaffDraft | null> {
  const key = staffCountDraftKey(userId, screen, storeId);
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[countDrafts] read ${key} failed:`, err);
    return null;
  }
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await backupCorrupt(key, raw, 'parse-error');
    return null;
  }
  if (!isLocalStaffDraft(parsed)) {
    await backupCorrupt(key, raw, 'shape-mismatch');
    return null;
  }
  return parsed;
}

/**
 * WRITE the device-local draft for the slot. Best-effort — NEVER throws (a
 * write failure is logged and surfaced by the staff notifyBackendError on the
 * caller's server path, matching eodQueue's best-effort-durability posture).
 */
export async function writeLocalStaffDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
  rec: LocalStaffDraft,
): Promise<void> {
  const key = staffCountDraftKey(userId, screen, storeId);
  await AsyncStorage.setItem(key, JSON.stringify(rec)).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[countDrafts] write ${key} failed:`, err);
  });
}

/**
 * CLEAR the device-local draft for the slot (on Discard / delete-on-submit /
 * adopt-server). Best-effort — never throws.
 */
export async function clearLocalStaffDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): Promise<void> {
  const key = staffCountDraftKey(userId, screen, storeId);
  await AsyncStorage.removeItem(key).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[countDrafts] clear ${key} failed:`, err);
  });
}

/** Back up corrupt bytes to a `<key>-corrupted:<ISO>` key, then remove the
 *  source key — mirrors eodQueue.backupCorrupt so debug can recover a bad
 *  record. Best-effort throughout. */
async function backupCorrupt(sourceKey: string, raw: string, reason: string): Promise<void> {
  const backupKey = `${sourceKey}-corrupted:${new Date().toISOString()}`;
  try {
    await AsyncStorage.setItem(backupKey, raw);
    // eslint-disable-next-line no-console
    console.warn(`[countDrafts] corrupt local draft (${reason}); backed up to ${backupKey}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[countDrafts] backup of corrupt local draft failed:', err);
  }
  await AsyncStorage.removeItem(sourceKey).catch(() => {});
}

// ─── MIGRATION CONTRACT ───────────────────────────────────────────
//
// CURRENT — v1: LocalStaffDraft = { payload, savedAt, unsynced }. The key
// suffix is `:v1` (COUNT_DRAFT_KEY_PREFIX).
//
// When LocalStaffDraft shape changes (v1 → v2):
//   1. Bump COUNT_DRAFT_KEY_PREFIX to `imr-staff:count-draft:v2` and add a
//      `V1_COUNT_DRAFT_KEY_PREFIX` const for the prior key.
//   2. Add a read-once, best-effort v1 → v2 transform in readLocalStaffDraft
//      (read the OLD key, map to the new shape, write the NEW key, remove the
//      OLD key) — guarded so it never clobbers a freshly-written v2 record.
//   3. Update isLocalStaffDraft in lockstep with the new fields.
//   4. Document the change here and bump the version stamp in the spec.
//
// NOTE: the `payload` inside the record is versioned SEPARATELY by the pure
// serializers (COUNT_DRAFT_PAYLOAD_VERSION in src/lib/countDrafts.ts, the `v`
// field). This key `:v1` versions the LOCAL RECORD ENVELOPE, not the payload
// shape — the two can bump independently.
