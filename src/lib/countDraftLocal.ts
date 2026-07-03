// src/lib/countDraftLocal.ts — Spec 106 (admin device-local draft fallback).
//
// The ADMIN device-local offline copy of a count draft (design §5). Kept OUT of
// src/lib/db.ts on purpose: db.ts is the PostgREST/RPC surface (every export
// routes through useInflight.track + .abortSignal), and these are synchronous
// localStorage (web) / best-effort AsyncStorage (native) reads/writes — not
// PostgREST — so they are NOT track()ed. The platform split mirrors
// persistDarkModeLocal / persistActiveBrandLocal (src/store/useStore.ts).
//
// Admin Cmd is WEB-PRIMARY (design §5): the common-path read is synchronous
// localStorage. On native the sync read returns null and the write/clear are
// best-effort async — admin native is a minority surface and the server copy is
// the source of truth when online. The SEMANTIC that matters (mirrored by the
// staff AsyncStorage carve-out) is single-slot + unsynced flag + savedAt stamp.
//
// Storage key: `imr.countDraft.<screen>.<storeId>.<userId>` — namespaced under
// `imr.*` like LOCALE_KEY / ACTIVE_BRAND_KEY. The userId is in the KEY so a
// shared web browser (two managers, same device) never cross-reads — belt-and-
// suspenders on top of the fact that offline drafts are private scratch.

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CountOrderScreen } from './countOrder';
import { isLocalDraftRecord } from './countDrafts';

/**
 * The local single-slot record. One per (user, screen, store) key. `savedAt` is
 * the SAME client-stamped value as the server copy once synced (design §9);
 * `unsynced: true` means the record was written offline and has not yet been
 * pushed to the server.
 */
export type LocalCountDraft = {
  payload: Record<string, unknown>;
  savedAt: string; // ISO-8601, same stamp as the server copy when synced
  unsynced: boolean; // true = written offline, not yet pushed
};

/** Namespace prefix for the admin local-draft keys (design §5). */
export const COUNT_DRAFT_KEY_PREFIX = 'imr.countDraft';

/** Build the per-slot storage key. Order matches the design:
 *  `imr.countDraft.<screen>.<storeId>.<userId>`. */
export function countDraftLocalKey(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): string {
  return `${COUNT_DRAFT_KEY_PREFIX}.${screen}.${storeId}.${userId}`;
}

/** Shape-validator: a parsed local record must be a single-slot draft, else it
 *  is treated as no-draft (a malformed record never crashes a restore).
 *  Delegates to the shared predicate in countDrafts.ts (single-sourced with
 *  the staff trio — hygiene sweep dedup). */
function isLocalCountDraft(x: unknown): x is LocalCountDraft {
  return isLocalDraftRecord(x);
}

/**
 * READ the device-local draft for the slot, or `null` when absent / malformed /
 * unreadable. SYNCHRONOUS on web (the common admin path). On native this returns
 * `null` synchronously (design §5) — admin native is a minority surface and the
 * server copy is authoritative when online; a best-effort async hydrate is
 * acceptable but not provided here (the FE can call the server fetch). Never
 * throws.
 */
export function readLocalCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): LocalCountDraft | null {
  if (Platform.OS !== 'web') return null;
  try {
    const raw = window.localStorage.getItem(countDraftLocalKey(userId, screen, storeId));
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isLocalCountDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * WRITE the device-local draft for the slot. Best-effort — NEVER throws (a
 * write failure is swallowed the way persistDarkModeLocal / writeActiveStoreId
 * do; the caller surfaces its own toast on the server path). Synchronous on
 * web; fire-and-forget on native.
 */
export function writeLocalCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
  rec: LocalCountDraft,
): void {
  const key = countDraftLocalKey(userId, screen, storeId);
  try {
    const json = JSON.stringify(rec);
    if (Platform.OS === 'web') {
      window.localStorage.setItem(key, json);
    } else {
      AsyncStorage.setItem(key, json).catch(() => { /* best-effort */ });
    }
  } catch { /* best-effort */ }
}

/**
 * CLEAR the device-local draft for the slot (on Discard / delete-on-submit /
 * adopt-server). Best-effort — never throws. Synchronous on web; fire-and-forget
 * on native.
 */
export function clearLocalCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): void {
  const key = countDraftLocalKey(userId, screen, storeId);
  try {
    if (Platform.OS === 'web') {
      window.localStorage.removeItem(key);
    } else {
      AsyncStorage.removeItem(key).catch(() => { /* best-effort */ });
    }
  } catch { /* best-effort */ }
}
