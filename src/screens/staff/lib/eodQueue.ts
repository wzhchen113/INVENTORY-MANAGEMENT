// src/lib/eodQueue.ts — AsyncStorage helpers for the EOD offline queue.
//
// Spec 062 §3 — canonical storage key: `imr-staff:eod-queue:v2`.
// Bump the version suffix when QueuedSubmission shape changes.
// Migration story documented at bottom of this file.
//
// Spec 086 bumped v1 → v2: the `entries` element shape changed from
// `{ item_id, count }` to `{ item_id, actual_remaining,
// actual_remaining_cases, actual_remaining_each }`. `migrateQueueIfNeeded`
// performs a read-once, lossless migrate of any in-flight v1 payload
// (see the transform + idempotency guard there).
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
import type { EodEntry, QueuedSubmission } from './types';

export const QUEUE_KEY = 'imr-staff:eod-queue:v2';
/** The prior queue key (spec 062). Read-once-migrated to QUEUE_KEY in
 *  `migrateQueueIfNeeded`, then removed. Kept as a named constant so the
 *  migrate branch and its tests reference a single source of truth. */
export const V1_QUEUE_KEY = 'imr-staff:eod-queue:v1';
export const ACTIVE_STORE_KEY = 'imr-staff:active-store:v1';

// 30-day GC threshold per spec 062 §3 — stale items belonging to no-
// longer-signed-in users are purged on mount, regardless of
// intent_user_id.
const GC_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** Validates a single v2 `entries` element — the spec 086 shape. A v1
 *  `{ item_id, count }` element fails here (no `actual_remaining`), so a
 *  stale-shape payload that somehow lands under the v2 key is rejected
 *  on hydrate rather than drained with an `undefined` total. */
function isValidEodEntry(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.item_id === 'string' &&
    typeof e.actual_remaining === 'number' &&
    (e.actual_remaining_cases === null || typeof e.actual_remaining_cases === 'number') &&
    (e.actual_remaining_each === null || typeof e.actual_remaining_each === 'number')
  );
}

/** Shape-validator for hydrated items. Rejects partial / malformed
 *  rows; downstream code can assume the type is honest. Updated in
 *  lockstep with the spec 086 `entries` element shape (contract rule at
 *  the bottom of this file). */
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
    o.entries.every(isValidEodEntry) &&
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

/** Old (spec 062) v1 `entries` element shape: a single `count`. */
type V1EodEntry = { item_id: string; count: number };

/** Best-effort map of one v1 entry → the v2 3-field shape, interpreting
 *  the old single `count` as a units-only legacy count (consistent with
 *  how a legacy DB row with NULL splits is read — spec 086 OQ-4):
 *  total → actual_remaining, cases → null, units → count. Returns null
 *  for a malformed element so a single bad row doesn't poison the batch
 *  (mirrors hydrateQueue's tolerant posture). */
function migrateV1Entry(x: unknown): EodEntry | null {
  if (typeof x !== 'object' || x === null) return null;
  const e = x as Partial<V1EodEntry>;
  if (typeof e.item_id !== 'string' || typeof e.count !== 'number') return null;
  return {
    item_id: e.item_id,
    actual_remaining: e.count,
    actual_remaining_cases: null,
    actual_remaining_each: e.count,
  };
}

/** Migration entry-point called once on App mount BEFORE the store
 *  hydrates (App.tsx — runs immediately before `hydrateQueue()`).
 *
 *  Spec 086 v1 → v2: the `entries` element shape changed, so any
 *  in-flight v1 payload (a staff member's unsynced end-of-day work) is
 *  READ-ONCE MIGRATED — never dropped. Each v1 `{ item_id, count }`
 *  entry becomes the v2 `{ item_id, actual_remaining: count,
 *  actual_remaining_cases: null, actual_remaining_each: count }` shape
 *  (a units-only legacy count). The migrated array is written under the
 *  v2 key and the v1 key removed.
 *
 *  IDEMPOTENT (contract rule 3): if the v2 key already exists we do NOT
 *  clobber it — a second mount must not overwrite freshly-enqueued v2
 *  items with re-read v1 bytes. We migrate ONLY when v2 is absent/empty
 *  AND v1 is present. Malformed v1 bytes are best-effort: skip the bad
 *  element / payload, don't throw. */
export async function migrateQueueIfNeeded(): Promise<void> {
  // Idempotency guard: if v2 already holds REAL entries, the migrate has
  // run (or v2 was written natively) — do not touch v1. An ABSENT or EMPTY
  // v2 (null / '' / '[]') is deliberately treated as not-yet-populated, so a
  // v1 carrying real entries can still flow in (re-running into an empty v2
  // is idempotent — it produces the same migrated array). When we DO skip,
  // we leave any stale v1 key in place; it is inert — nothing reads it once
  // v2 holds entries, and clearing it is not worth a second write per mount.
  const existingV2 = await safeRead(QUEUE_KEY);
  if (existingV2 != null && existingV2 !== '' && existingV2 !== '[]') {
    return;
  }

  const rawV1 = await safeRead(V1_QUEUE_KEY);
  if (rawV1 == null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawV1);
  } catch {
    // Malformed v1 bytes — back them up (so debug can recover) and drop
    // the key so we don't re-attempt every mount. No throw.
    await backupCorrupt(rawV1, 'v1-migrate-parse-error', V1_QUEUE_KEY);
    return;
  }
  if (!Array.isArray(parsed)) {
    await backupCorrupt(rawV1, 'v1-migrate-not-an-array', V1_QUEUE_KEY);
    return;
  }

  const migrated: QueuedSubmission[] = [];
  for (const el of parsed) {
    if (typeof el !== 'object' || el === null) continue;
    const o = el as Record<string, unknown>;
    if (
      typeof o.client_uuid !== 'string' ||
      typeof o.store_id !== 'string' ||
      typeof o.date !== 'string' ||
      typeof o.vendor_id !== 'string' ||
      o.status !== 'submitted' ||
      !Array.isArray(o.entries) ||
      typeof o.queued_at !== 'string' ||
      typeof o.intent_user_id !== 'string' ||
      typeof o.attempts !== 'number'
    ) {
      // Skip a malformed submission — best-effort, don't throw.
      continue;
    }
    const entries = o.entries
      .map(migrateV1Entry)
      .filter((e): e is EodEntry => e !== null);
    migrated.push({
      client_uuid: o.client_uuid,
      store_id: o.store_id,
      date: o.date,
      vendor_id: o.vendor_id,
      status: 'submitted',
      entries,
      queued_at: o.queued_at,
      intent_user_id: o.intent_user_id,
      attempts: o.attempts,
      ...(typeof o.lastError === 'string' ? { lastError: o.lastError } : {}),
    });
  }

  // Write the migrated payload under v2, then remove the v1 key. Order
  // matters: write-then-remove means a crash between the two leaves v1
  // intact and v2 populated — the next mount's idempotency guard sees a
  // non-empty v2 and skips, so we never double-migrate or lose data.
  await persistQueue(migrated);
  await AsyncStorage.removeItem(V1_QUEUE_KEY).catch(() => {});
  // eslint-disable-next-line no-console
  console.warn(
    `[eodQueue] migrated ${migrated.length} queued submission(s) from v1 → v2`,
  );
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

async function backupCorrupt(
  raw: string,
  reason: string,
  sourceKey: string = QUEUE_KEY,
): Promise<void> {
  const backupKey = `${sourceKey}-corrupted:${new Date().toISOString()}`;
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
  await AsyncStorage.removeItem(sourceKey).catch(() => {});
}

// ─── MIGRATION CONTRACT ───────────────────────────────────────────
//
// DONE — v1 → v2 (spec 086): `entries` element shape changed from
// `{ item_id, count }` to `{ item_id, actual_remaining,
// actual_remaining_cases, actual_remaining_each }`. `migrateQueueIfNeeded`
// reads the v1 key, maps each entry's `count` to a units-only legacy
// count, writes the v2 key, and removes v1 — idempotently (guarded on a
// non-empty v2). `isValidQueuedSubmission` validates the v2 entry shape
// via `isValidEodEntry`.
//
// When QueuedSubmission shape changes AGAIN (v2 → v3):
//   1. Bump the QUEUE_KEY suffix (e.g. `imr-staff:eod-queue:v3`) and add
//      a `V2_QUEUE_KEY` const for the prior key.
//   2. Add a v2 → v3 transform branch in `migrateQueueIfNeeded`:
//        - Read the OLD key (`imr-staff:eod-queue:v2`).
//        - Transform each item to the new shape (best-effort).
//        - Write to the NEW key.
//        - Delete the OLD key.
//   3. The transform MUST be idempotent — guard on a non-empty NEW key
//      so a second mount never clobbers freshly-enqueued items.
//   4. Document the change in this comment block and bump the
//      version stamp in the spec.
//
// The shape validator (`isValidQueuedSubmission`) is the contract
// for the CURRENT version — update it in lockstep with any field
// additions/removals.
