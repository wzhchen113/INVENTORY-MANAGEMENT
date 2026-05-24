// src/lib/eodQueue.ts — AsyncStorage helpers for the EOD offline queue.
//
// Spec 062 §3 — canonical storage key: `imr-staff:eod-queue:v1`.
// Bump the version suffix when QueuedSubmission shape changes.
// Migration story documented at bottom of this file.
//
// Quota note: a single QueuedSubmission is ~500 bytes; iOS AsyncStorage
// quota is 6 MB ≈ 12,000 items. v1 will never approach this — a single
// shift produces ≤5 submissions. A queue stuck for weeks would surface
// via `attempts >= 5` → 'needs-attention' UI long before quota.
//
// Failure mode: an AsyncStorage write that throws DOES NOT roll back
// the in-memory store; we log + toast via notifyBackendError. Worst
// case: an app kill loses the most recent enqueue. Acceptable per spec
// (the offline queue is best-effort durability, not zero-loss).

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueuedSubmission } from './types';

export const QUEUE_KEY = 'imr-staff:eod-queue:v1';
export const ACTIVE_STORE_KEY = 'imr-staff:active-store:v1';

// 30-day GC threshold per spec 062 §3 — stale items belonging to no-
// longer-signed-in users are purged on mount, regardless of
// intent_user_id.
const GC_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** Shape-validator for hydrated items. Rejects partial / malformed
 *  rows; downstream code can assume the type is honest. */
function isValidQueuedSubmission(x: unknown): x is QueuedSubmission {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.client_uuid === 'string' &&
    typeof o.store_id === 'string' &&
    typeof o.date === 'string' &&
    typeof o.vendor_id === 'string' &&
    o.status === 'submitted' &&
    Array.isArray(o.entries) &&
    typeof o.queued_at === 'string' &&
    typeof o.intent_user_id === 'string' &&
    typeof o.attempts === 'number'
  );
}

/** Read the queue from AsyncStorage. NEVER throws; corrupt payloads
 *  are backed up to a `:v1-corrupted:<ISO timestamp>` key so debug
 *  can recover the bytes. Stale items (>30d) are GC'd here per spec
 *  062 §3. */
export async function hydrateQueue(): Promise<QueuedSubmission[]> {
  const raw = await safeRead(QUEUE_KEY);
  if (raw == null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await backupCorrupt(raw, 'parse-error');
    return [];
  }
  if (!Array.isArray(parsed)) {
    await backupCorrupt(raw, 'not-an-array');
    return [];
  }
  const valid = parsed.filter(isValidQueuedSubmission);
  if (valid.length !== parsed.length) {
    // Partial corruption — preserve the valid rows, log the loss.
    // eslint-disable-next-line no-console
    console.warn(
      `[eodQueue] dropped ${parsed.length - valid.length} malformed item(s) on hydrate`,
    );
  }
  // 30-day GC: items whose queued_at is older than now-30d are
  // purged unconditionally (independent of intent_user_id).
  const now = Date.now();
  const fresh = valid.filter((item) => {
    const ts = Date.parse(item.queued_at);
    if (Number.isNaN(ts)) return true; // keep unparseable; will retry on drain or surface as needs-attention
    return now - ts <= GC_MAX_AGE_MS;
  });
  if (fresh.length !== valid.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[eodQueue] GC purged ${valid.length - fresh.length} item(s) older than 30 days`,
    );
    // Persist the GC'd state immediately so the next mount doesn't
    // re-evaluate the same expired rows.
    await persistQueue(fresh).catch(() => {});
  }
  return fresh;
}

/** Migration entry-point called once on App mount BEFORE the store
 *  hydrates. v1 has no prior version; the future v1 → v2 transform
 *  branches here. See bottom of file for the contract.
 *
 *  v1 baseline is a no-op — there is nothing to migrate, and
 *  `hydrateQueue()` already runs immediately after on the App mount
 *  path (where it both validates the payload and triggers the
 *  corrupt-payload backup if the bytes are bad). Activating this
 *  function on a real v1 → v2 schema change is documented at the
 *  bottom of this file. */
export async function migrateQueueIfNeeded(): Promise<void> {
  // No-op for v1 — see comment block above and the migration contract
  // at the bottom of this file. Activate on v1 → v2 schema bump.
}

/** Persist the queue array to AsyncStorage. Throws on write error so
 *  the caller can surface via notifyBackendError. */
export async function persistQueue(items: QueuedSubmission[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));
}

/** Append one item to the queue and persist. Returns the new array
 *  for store-mirror updates. */
export async function pushQueueItem(
  items: QueuedSubmission[],
  next: QueuedSubmission,
): Promise<QueuedSubmission[]> {
  const updated = [...items, next];
  await persistQueue(updated);
  return updated;
}

/** Read-only peek at the queue (no parse failures surface — corrupted
 *  storage returns []). Use this for diagnostic-only callers; the
 *  store mirror is the canonical source for UI. */
export async function peekQueue(): Promise<QueuedSubmission[]> {
  return hydrateQueue();
}

/** Drain helper — given the current queue and a per-item submit fn
 *  that returns `'success' | 'forbidden' | 'network'`, walks the
 *  queue FIFO and removes successes + forbiddens (the latter stays
 *  in error-surfacing UI but is removed from the queue per spec). */
export type DrainOutcome = 'success' | 'forbidden' | 'network';

export async function drainQueue(
  items: QueuedSubmission[],
  submitOne: (item: QueuedSubmission) => Promise<DrainOutcome>,
): Promise<{ remaining: QueuedSubmission[]; forbiddenItems: QueuedSubmission[] }> {
  let remaining = [...items];
  const forbiddenItems: QueuedSubmission[] = [];
  // Iterate by snapshot — drain is single-threaded and FIFO.
  // We re-build the remaining list each loop iteration so a network
  // failure doesn't drop later items.
  for (const item of items) {
    const outcome = await submitOne(item);
    if (outcome === 'success') {
      remaining = remaining.filter((q) => q.client_uuid !== item.client_uuid);
    } else if (outcome === 'forbidden') {
      remaining = remaining.filter((q) => q.client_uuid !== item.client_uuid);
      forbiddenItems.push(item);
    } else {
      // network — leave in remaining, but bump attempts in the
      // returned slot so the UI can surface 'needs-attention' at >=5.
      remaining = remaining.map((q) =>
        q.client_uuid === item.client_uuid
          ? { ...q, attempts: q.attempts + 1, lastError: 'network' }
          : q,
      );
      // Stop draining on the first network error — likely we've gone
      // offline again. Retry on the next connectivity flip.
      break;
    }
  }
  await persistQueue(remaining).catch(() => {
    // Persist failure is logged but not fatal — the in-memory store
    // will re-attempt next mutation.
  });
  return { remaining, forbiddenItems };
}

/** Replace the queue with the provided array. Used by the store's
 *  `_persistQueue` write-through. */
export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_KEY);
}

// ─── ACTIVE STORE PERSISTENCE ─────────────────────────────────────

export async function readActiveStoreId(): Promise<string | null> {
  return safeRead(ACTIVE_STORE_KEY);
}

export async function writeActiveStoreId(storeId: string | null): Promise<void> {
  if (storeId == null) {
    await AsyncStorage.removeItem(ACTIVE_STORE_KEY).catch(() => {});
    return;
  }
  await AsyncStorage.setItem(ACTIVE_STORE_KEY, storeId).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[eodQueue] writeActiveStoreId:', err);
  });
}

// ─── INTERNALS ────────────────────────────────────────────────────

async function safeRead(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[eodQueue] read ${key} failed:`, err);
    return null;
  }
}

async function backupCorrupt(raw: string, reason: string): Promise<void> {
  const backupKey = `${QUEUE_KEY}-corrupted:${new Date().toISOString()}`;
  try {
    await AsyncStorage.setItem(backupKey, raw);
    // eslint-disable-next-line no-console
    console.warn(
      `[eodQueue] corrupt payload (${reason}); backed up to ${backupKey}`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[eodQueue] backup of corrupt payload failed:`, err);
  }
  await AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});
}

// ─── MIGRATION CONTRACT (FUTURE v1 → v2) ──────────────────────────
//
// When QueuedSubmission shape changes:
//   1. Bump the QUEUE_KEY suffix (e.g. `imr-staff:eod-queue:v2`).
//   2. Add a v1 → v2 transform branch in `migrateQueueIfNeeded`:
//        - Read the OLD key (`imr-staff:eod-queue:v1`).
//        - Transform each item to the new shape (best-effort).
//        - Write to the NEW key.
//        - Delete the OLD key.
//   3. The transform MUST be idempotent — if a partial migration
//      crashes, the next mount runs it again.
//   4. Document the change in this comment block and bump the
//      version stamp in the spec.
//
// The shape validator (`isValidQueuedSubmission`) is the contract
// for the CURRENT version — update it in lockstep with any field
// additions/removals.
