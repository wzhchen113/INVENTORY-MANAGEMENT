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
// best-effort async; the restore paths read through `loadLocalCountDraft`
// (spec 181 B2), which reads AsyncStorage on native so a native write is
// restorable. The server copy stays the source of truth when online. The SEMANTIC that matters (mirrored by the
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

/** Parse a raw stored value into a draft: `null` for a missing value, invalid
 *  JSON, or a shape that fails `isLocalCountDraft`. Never throws. Shared by the
 *  web (`readLocalCountDraft`) and native (`loadLocalCountDraft`) restore paths
 *  so the validity rule can't drift between them. */
function parseLocalCountDraft(raw: string | null): LocalCountDraft | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLocalCountDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * READ the device-local draft for the slot, or `null` when absent / malformed /
 * unreadable. SYNCHRONOUS web-only primitive (the common admin path). On native
 * this returns `null` synchronously — native callers must use
 * `loadLocalCountDraft` (spec 181 B2), which reads AsyncStorage. Never throws.
 */
export function readLocalCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): LocalCountDraft | null {
  if (Platform.OS !== 'web') return null;
  try {
    return parseLocalCountDraft(
      window.localStorage.getItem(countDraftLocalKey(userId, screen, storeId)),
    );
  } catch {
    return null;
  }
}

/**
 * Spec 181 (B2) — platform-agnostic ASYNC read of the device-local draft.
 *   - web: resolves `readLocalCountDraft(...)` (the sync localStorage read,
 *     reused verbatim).
 *   - native: `AsyncStorage.getItem` under the SAME key `writeLocalCountDraft`
 *     uses, then JSON.parse + shape check.
 * A miss, malformed value, parse error or storage rejection resolves `null`.
 * NEVER rejects.
 */
export function loadLocalCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): Promise<LocalCountDraft | null> {
  if (Platform.OS === 'web') {
    return Promise.resolve(readLocalCountDraft(userId, screen, storeId));
  }
  let pending: Promise<string | null>;
  try {
    pending = AsyncStorage.getItem(countDraftLocalKey(userId, screen, storeId));
  } catch {
    return Promise.resolve(null);
  }
  return pending.then(parseLocalCountDraft, () => null);
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
