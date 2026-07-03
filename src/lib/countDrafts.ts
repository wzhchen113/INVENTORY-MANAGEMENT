// src/lib/countDrafts.ts — Spec 106.
//
// Shared, dependency-free PURE module for the count-screen save-draft + resume
// feature. No `supabase`, no React, no store — so BOTH the admin path (db.ts)
// and the staff-subtree carve-out (src/screens/staff/lib/countDrafts.ts) import
// it without violating the spec-063 carve-out (which is about `supabase.from/rpc`
// call sites, not pure helpers). Centralizing the only testable logic here is
// what keeps the two duplicated thin I/O paths byte-aligned (design §8 / §14),
// exactly as src/lib/countOrder.ts does for spec 103.
//
// This is the AC-18 jest surface: reconcileDrafts (whole-draft last-write-wins),
// applyDraftStaleFilter (deleted-since id tolerance), and the per-screen
// (de)serializers (verbatim-string round-trip). All are pure + total and
// TOLERANT on malformed input (return an empty-but-valid value rather than
// throw — the same posture as eodQueue.hydrateQueue).

// Reuse the spec-103 screen-key type: the two draft screen keys are a SUBSET of
// the four count-order keys, single-sourced so the two features never drift.
export type { CountOrderScreen } from './countOrder';

// ─── Payload schema version (design §3) ──────────────────────
// A payload schema version stamped on every serialized payload so a future
// shape change (the EOD follow-up, or adding a field) is DETECTABLE. v1 does NOT
// version-GATE on read: the deserializers read fields forward-tolerantly
// (per-field coercion, missing → empty) REGARDLESS of `v`, so an unknown or
// missing `v` deserializes normally rather than throwing. When a real shape
// break lands, add an explicit `v` check here and in the deserializers.
export const COUNT_DRAFT_PAYLOAD_VERSION = 1 as const;

// The four-value admin header `kind` enum (matches the admin Inventory count
// segmented control). An out-of-enum value on deserialize falls back to the
// screen default 'spot' rather than crashing the control (design §3).
export type CountKind = 'spot' | 'open' | 'mid_shift' | 'close';
const COUNT_KINDS: readonly CountKind[] = ['spot', 'open', 'mid_shift', 'close'];
const DEFAULT_COUNT_KIND: CountKind = 'spot';

// ─── Reconcile candidate + result types (design §8) ──────────
/**
 * A reconcile candidate: a draft plus its client-stamped `saved_at`. `null`
 * means "no draft on this side". The `unsynced` flag is only meaningful for the
 * LOCAL candidate (a local draft written offline, not yet pushed to the server).
 */
export type DraftCandidate = {
  payload: Record<string, unknown>;
  savedAt: string; // ISO-8601, client-stamped
} | null;

/** The local candidate carries the offline `unsynced` flag alongside the draft. */
export type LocalDraftCandidate =
  | (NonNullable<DraftCandidate> & { unsynced: boolean })
  | null;

/**
 * Shape-validator for a parsed device-local slot record
 * ({ payload, savedAt, unsynced }). Shared by BOTH storage trios —
 * `src/lib/countDraftLocal.ts` (admin, localStorage) and
 * `src/screens/staff/lib/countDrafts.ts` (staff, AsyncStorage) — which
 * previously duplicated this body byte-for-byte. A malformed record is
 * treated as no-draft (never crashes a restore).
 */
export function isLocalDraftRecord(x: unknown): x is NonNullable<LocalDraftCandidate> {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.payload === 'object' &&
    o.payload !== null &&
    !Array.isArray(o.payload) &&
    typeof o.savedAt === 'string' &&
    typeof o.unsynced === 'boolean'
  );
}

/**
 * The sync action the CALLER runs after reconcile (the pure function does no
 * I/O):
 *   - 'none'              → nothing to do (both absent, or server-only).
 *   - 'push'             → push the local draft up to the server, then clear
 *                          its unsynced flag (local is the newer winner, or the
 *                          lone unsynced local with no server row).
 *   - 'adopt-clear-local' → drop the local copy in favour of the server (server
 *                          is the newer winner).
 *   - 'clear-local-flag'  → the local and server drafts are byte-identical
 *                          (same saved_at) → just clear the local unsynced flag
 *                          (already in sync; no re-push).
 */
export type ReconcileAction =
  | 'none'
  | 'push'
  | 'adopt-clear-local'
  | 'clear-local-flag';

export type ReconcileResult = {
  /** The draft to RESTORE the form from (or null when there is nothing). */
  winner: DraftCandidate;
  /** Which source the winner came from — drives the restore + the banner. */
  restoreFrom: 'local' | 'server' | 'none';
  /** The sync action the caller performs (see ReconcileAction). */
  action: ReconcileAction;
};

/**
 * WHOLE-DRAFT LAST-WRITE-WINS (AC-15/16). Pure + total.
 *
 * Compares `saved_at` STRING-vs-STRING (ISO-8601 UTC sorts lexicographically =
 * chronologically) — LOCAL candidate vs SERVER candidate only. It NEVER reads
 * the server's `now()` and NEVER does a field-level merge (v1 is whole-draft
 * last-write-wins; the spec OoS'd per-field merge). Branch table:
 *
 *   local     server    →  winner   restoreFrom   action
 *   ────────  ────────     ───────   ───────────   ──────
 *   null      null          null     none          none
 *   null      present       server   server        none
 *   present   null          local    local         push   (lone local → sync up)
 *     └─ (unsynced only matters here — an already-synced local with no server
 *        row is an impossible steady state; we still push to be safe)
 *   L > S     (present)     local    local         push
 *   L < S     (present)     server   server        adopt-clear-local
 *   L == S    (present)     server   server        clear-local-flag  (tie→server)
 *
 * Tie-break (equal to the byte): SERVER wins — prefer the already-synced copy
 * and avoid a pointless re-push (design §0.3). The equal case is the normal
 * "same write, already synced" steady state produced by minting one `saved_at`
 * for both the local record and the server row at Save time (design §9).
 */
export function reconcileDrafts(
  local: LocalDraftCandidate,
  server: DraftCandidate,
): ReconcileResult {
  // Both absent → nothing to restore, nothing to sync.
  if (!local && !server) {
    return { winner: null, restoreFrom: 'none', action: 'none' };
  }

  // Server only → adopt the server draft; nothing to push.
  if (!local && server) {
    return { winner: server, restoreFrom: 'server', action: 'none' };
  }

  // Local only → the lone local candidate is ALWAYS the push winner, regardless
  // of its `unsynced` flag: with no server counterpart the correct action is to
  // push it up (idempotent by the shared savedAt stamp, so re-pushing an
  // already-synced record is a harmless no-op the equal-tie later collapses).
  if (local && !server) {
    return { winner: local, restoreFrom: 'local', action: 'push' };
  }

  // Both present → compare saved_at string-vs-string (ISO UTC → chronological).
  // The non-null assertions are safe: the two `!local`/`!server` guards above
  // handle every other combination.
  const l = local as NonNullable<LocalDraftCandidate>;
  const s = server as NonNullable<DraftCandidate>;

  if (l.savedAt > s.savedAt) {
    // Local is newer → local wins, push it up.
    return { winner: l, restoreFrom: 'local', action: 'push' };
  }
  if (l.savedAt < s.savedAt) {
    // Server is newer → adopt server, drop the local copy.
    return { winner: s, restoreFrom: 'server', action: 'adopt-clear-local' };
  }
  // Equal to the byte → tie → SERVER wins; the two are the same write already
  // synced, so just clear the local unsynced flag (no re-push).
  return { winner: s, restoreFrom: 'server', action: 'clear-local-flag' };
}

// ─── Stale-item-id tolerant apply (AC-11) ────────────────────
// The three per-item maps in a payload, keyed by inventory_items.id (as text).
const PER_ITEM_MAP_KEYS = ['caseCounts', 'unitCounts', 'itemNotes'] as const;

/**
 * STALE-ID-TOLERANT APPLY (AC-11). Pure + total.
 *
 * Given a deserialized-or-raw payload object and the set of LIVE item ids for
 * the current store, returns a NEW payload with every per-item map
 * (caseCounts / unitCounts / itemNotes) filtered to live ids only. An id that
 * references an item deleted since the draft was saved is dropped SILENTLY
 * (mirrors applyCountOrder's "ignore deleted ids"). Header fields
 * (kind / countedAtLocal / notes / v) pass through UNTOUCHED. Never mutates the
 * input. A non-object payload yields `{}`.
 */
export function applyDraftStaleFilter(
  payload: Record<string, unknown>,
  liveItemIds: ReadonlySet<string>,
): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {};
  }
  const out: Record<string, unknown> = { ...payload };
  for (const mapKey of PER_ITEM_MAP_KEYS) {
    const map = payload[mapKey];
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      // Absent or malformed map → leave the shallow copy's value as-is (an
      // absent map stays absent; a malformed one is the serializer's problem).
      continue;
    }
    const filtered: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(map as Record<string, unknown>)) {
      if (liveItemIds.has(id)) filtered[id] = value;
    }
    out[mapKey] = filtered;
  }
  return out;
}

// ─── Serializers / deserializers (design §3, AC-3) ───────────
// Values are the VERBATIM typed strings the counter entered (AC-5: "0" stays
// "0", "" stays ""), NEVER coerced to numbers — a draft is resumable form
// state, not a computed submission.

/** Coerce an unknown into a `Record<string,string>` of only string→string
 *  entries (drops any non-string value/key defensively). Used by both
 *  deserializers so a malformed map degrades gracefully. */
function toStringMap(x: unknown): Record<string, string> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Coerce an unknown into a string (empty string for anything non-string). */
function toStr(x: unknown): string {
  return typeof x === 'string' ? x : '';
}

/** Validate the admin header kind against the four-value enum; fall back to the
 *  screen default 'spot' for an out-of-enum value (design §3). */
function toCountKind(x: unknown): CountKind {
  return (COUNT_KINDS as readonly string[]).includes(x as string)
    ? (x as CountKind)
    : DEFAULT_COUNT_KIND;
}

/** The admin-inventory form shape the section holds in local React state. */
export type AdminInventoryDraftForm = {
  kind: string;
  countedAtLocal: string;
  notes: string;
  caseCounts: Record<string, string>;
  unitCounts: Record<string, string>;
  itemNotes: Record<string, string>;
};

/** The staff-weekly form shape the screen holds in local React state. */
export type WeeklyDraftForm = {
  caseCounts: Record<string, string>;
  unitCounts: Record<string, string>;
};

/**
 * Serialize the admin Inventory count form into the `admin-inventory` payload
 * (design §3). Pure. Stamps `v: 1`. Values pass through verbatim (AC-5).
 */
export function serializeAdminInventoryDraft(
  form: AdminInventoryDraftForm,
): Record<string, unknown> {
  return {
    v: COUNT_DRAFT_PAYLOAD_VERSION,
    kind: form.kind,
    countedAtLocal: form.countedAtLocal,
    notes: form.notes,
    caseCounts: { ...form.caseCounts },
    unitCounts: { ...form.unitCounts },
    itemNotes: { ...form.itemNotes },
  };
}

/**
 * Deserialize an `admin-inventory` payload back into the form shape (design
 * §3). Pure + total; TOLERANT — a non-object payload yields an empty-but-valid
 * form (default kind, empty strings, empty maps) rather than throwing, and each
 * field is read forward-tolerantly (missing → empty; non-string map entries
 * dropped) REGARDLESS of `v` (v1 does not version-gate on read). `kind` is
 * validated against the four-value enum (fallback 'spot'). The per-item maps are
 * NOT stale-filtered here — that is applyDraftStaleFilter's job on restore.
 */
export function deserializeAdminInventoryDraft(
  payload: Record<string, unknown>,
): {
  kind: CountKind;
  countedAtLocal: string;
  notes: string;
  caseCounts: Record<string, string>;
  unitCounts: Record<string, string>;
  itemNotes: Record<string, string>;
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      kind: DEFAULT_COUNT_KIND,
      countedAtLocal: '',
      notes: '',
      caseCounts: {},
      unitCounts: {},
      itemNotes: {},
    };
  }
  return {
    kind: toCountKind(payload.kind),
    countedAtLocal: toStr(payload.countedAtLocal),
    notes: toStr(payload.notes),
    caseCounts: toStringMap(payload.caseCounts),
    unitCounts: toStringMap(payload.unitCounts),
    itemNotes: toStringMap(payload.itemNotes),
  };
}

/**
 * Serialize the staff Weekly count form into the `staff-weekly` payload (design
 * §3). Pure. Stamps `v: 1`. Values pass through verbatim (AC-5).
 */
export function serializeWeeklyDraft(
  form: WeeklyDraftForm,
): Record<string, unknown> {
  return {
    v: COUNT_DRAFT_PAYLOAD_VERSION,
    caseCounts: { ...form.caseCounts },
    unitCounts: { ...form.unitCounts },
  };
}

/**
 * Deserialize a `staff-weekly` payload back into the form shape (design §3).
 * Pure + total; TOLERANT — a non-object payload yields empty maps rather than
 * throwing, and the maps are read forward-tolerantly (missing → empty;
 * non-string entries dropped) REGARDLESS of `v` (v1 does not version-gate on
 * read). The maps are NOT stale-filtered here (applyDraftStaleFilter does that
 * on restore).
 */
export function deserializeWeeklyDraft(
  payload: Record<string, unknown>,
): { caseCounts: Record<string, string>; unitCounts: Record<string, string> } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { caseCounts: {}, unitCounts: {} };
  }
  return {
    caseCounts: toStringMap(payload.caseCounts),
    unitCounts: toStringMap(payload.unitCounts),
  };
}
