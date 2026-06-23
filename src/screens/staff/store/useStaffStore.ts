// src/screens/staff/store/useStaffStore.ts — single Zustand store for the
// staff EOD count flow.
//
// Spec 063 — renamed from `useStore` to `useStaffStore` so it doesn't
// collide with admin's `useStore` at `src/store/useStore.ts`. The two
// stores are slice-isolated: admin code never imports `useStaffStore`;
// staff code never imports `useStore`. Helper exports
// (`currentStaffUserId`, `selectStaffStores`) are renamed away from the
// admin store's semantically-different `currentUserId` / `selectStores`
// concepts.
//
// Slices:
//   - auth      : sign-in state machine (idle → restoring → … → signed-in)
//   - active    : the currently selected store (id + name)
//   - queue     : mirror of the AsyncStorage offline queue (spec 062 §3 Q1)
//   - drain     : `draining: boolean` flag for the QueueIndicator
//   - actions   : signIn / signOut / setActiveStore / queue mutations
//
// Queue mutations write through to AsyncStorage synchronously via
// `persistQueue` — write failure is logged but the in-memory state
// still reflects the mutation (best-effort durability — see eodQueue.ts).

import { create } from 'zustand';
import type {
  ActiveStore,
  AuthState,
  QueuedSubmission,
  SubmitWeeklyResponse,
  UserStore,
  WeeklyEntry,
  WeeklyStatus,
} from '../lib/types';
import {
  persistQueue,
  writeActiveStoreId,
  writeCachedLocale,
} from '../lib/eodQueue';
import { notifyBackendError } from '../lib/notifyBackendError';
import { supabase } from '../../../lib/supabase';
import { uuidv4 } from '../lib/uuid';
import { _setActiveLocaleGetter, _setActiveLocaleHook, type Locale } from '../i18n';

export type StaffState = {
  // ─── LOCALE (chrome language) ─────────────────────────
  /** Active chrome language. Drives the staff i18n `t()`. Initialized
   *  at boot from profiles.locale (DB, cross-device) → cached value →
   *  'en'. Components that must re-render on a change subscribe to this
   *  slice (e.g. `useStaffStore((s) => s.locale)`). */
  locale: Locale;

  /** Set the active locale and persist it: (a) update state, (b) write
   *  the local cache for instant boot restore, (c) push to
   *  profiles.locale when signed in (staff carve-out — direct
   *  supabase.update). Optimistic-then-revert: a failed DB write rolls
   *  the in-memory locale back and surfaces a toast. */
  setLocale: (next: Locale) => void;

  /** Apply a locale WITHOUT persisting — used at boot/login to seed the
   *  store from the DB/cache value without round-tripping it back to the
   *  column (mirrors admin `hydrateLocale`). */
  hydrateLocale: (next: Locale) => void;

  // ─── AUTH ─────────────────────────────────────────────
  authState: AuthState;
  setAuthState: (s: AuthState) => void;

  // ─── ACTIVE STORE ─────────────────────────────────────
  activeStore: ActiveStore;
  setActiveStore: (s: ActiveStore) => void;

  // ─── QUEUE (mirror of AsyncStorage) ───────────────────
  eodQueue: QueuedSubmission[];
  draining: boolean;

  /** Seed the in-memory queue from AsyncStorage on mount. Does NOT
   *  persist (the source IS AsyncStorage at this point). */
  hydrateQueueFromStorage: (items: QueuedSubmission[]) => void;

  /** Append a new queued item and write through to AsyncStorage. */
  enqueueEod: (item: QueuedSubmission) => Promise<void>;

  /** Remove an item by client_uuid and write through. */
  dequeueEod: (clientUuid: string) => Promise<void>;

  /** Bump attempts counter (drain failures) and write through. */
  bumpEodAttempts: (clientUuid: string, lastError?: string) => Promise<void>;

  /** Replace the whole queue (drain orchestrator after a batch). */
  replaceQueue: (items: QueuedSubmission[]) => Promise<void>;

  /** Flag the drain loop is in flight (toggled by useEodSubmit). */
  setDraining: (draining: boolean) => void;

  // ─── WEEKLY COUNT (spec 098) ──────────────────────────
  /** The `weekly_count_status` result for the active store, refreshed on
   *  screen focus (staff v1 has no realtime — banner reads on focus per
   *  AC). null until the first fetch resolves. */
  weeklyStatus: WeeklyStatus | null;

  /** Fetch `weekly_count_status` for one store (direct supabase.rpc —
   *  staff carve-out, spec 063). Stores the result in `weeklyStatus`.
   *  Best-effort: errors route through `notifyBackendError` and leave the
   *  previous status in place. */
  fetchWeeklyStatus: (storeId: string, asOfDate: string) => Promise<void>;

  /** Submit a weekly full-store count via `submit_weekly_count` (direct
   *  supabase.rpc — staff carve-out). Client-mints `client_uuid` for
   *  idempotency. On success, optimistically marks `weeklyStatus.status =
   *  'completed'` so the banner clears immediately; on error the previous
   *  status is preserved and the error is surfaced. Returns the RPC
   *  envelope, or null on failure. */
  submitWeeklyCount: (input: {
    storeId: string;
    countedAt: string;
    entries: WeeklyEntry[];
    notes?: string | null;
  }) => Promise<SubmitWeeklyResponse | null>;

  // ─── SELECTORS ────────────────────────────────────────
  /** Count of queued items belonging to the current user
   *  (intent_user_id filter). Drives the QueueIndicator badge. */
  pendingCountForUser: (userId: string | undefined) => number;
};

export const useStaffStore = create<StaffState>((set, get) => ({
  // ─── LOCALE ───────────────────────────────────────────
  locale: 'en',

  setLocale: (next) => {
    const prev = get().locale;
    if (prev === next) return;
    set({ locale: next });
    // Local cache for instant boot restore (best-effort, fire-and-forget).
    void writeCachedLocale(next);
    // Persist to profiles.locale when signed in. Staff carve-out (spec
    // 063): direct supabase.update, NOT src/lib/db.ts. RLS scopes the
    // write to the caller's own row (id = auth.uid()); the
    // profiles_locale_check CHECK constraint enforces the enum.
    const userId = currentStaffUserId(get().authState);
    if (!userId) return; // login screen / not signed in — local-only.
    void supabase
      .from('profiles')
      .update({ locale: next })
      .eq('id', userId)
      .then(({ error }) => {
        if (error) {
          // Optimistic-then-revert: roll back and surface a toast.
          set({ locale: prev });
          void writeCachedLocale(prev);
          notifyBackendError('Save language', error);
        }
      });
  },

  hydrateLocale: (next) => set({ locale: next }),

  // ─── AUTH ─────────────────────────────────────────────
  authState: { kind: 'idle' },
  setAuthState: (s) => set({ authState: s }),

  // ─── ACTIVE STORE ─────────────────────────────────────
  activeStore: null,
  setActiveStore: (s) => {
    set({ activeStore: s });
    // Fire-and-forget AsyncStorage write — failure is logged.
    void writeActiveStoreId(s ? s.id : null);
  },

  // ─── QUEUE ────────────────────────────────────────────
  eodQueue: [],
  draining: false,

  hydrateQueueFromStorage: (items) => set({ eodQueue: items }),

  enqueueEod: async (item) => {
    const updated = [...get().eodQueue, item];
    set({ eodQueue: updated });
    try {
      await persistQueue(updated);
    } catch (err) {
      notifyBackendError('queue write failed', err);
    }
  },

  dequeueEod: async (clientUuid) => {
    const updated = get().eodQueue.filter((q) => q.client_uuid !== clientUuid);
    set({ eodQueue: updated });
    try {
      await persistQueue(updated);
    } catch (err) {
      notifyBackendError('queue write failed', err);
    }
  },

  bumpEodAttempts: async (clientUuid, lastError) => {
    const updated = get().eodQueue.map((q) =>
      q.client_uuid === clientUuid
        ? { ...q, attempts: q.attempts + 1, lastError: lastError ?? q.lastError }
        : q,
    );
    set({ eodQueue: updated });
    try {
      await persistQueue(updated);
    } catch (err) {
      notifyBackendError('queue write failed', err);
    }
  },

  replaceQueue: async (items) => {
    set({ eodQueue: items });
    try {
      await persistQueue(items);
    } catch (err) {
      notifyBackendError('queue write failed', err);
    }
  },

  setDraining: (draining) => set({ draining }),

  // ─── WEEKLY COUNT (spec 098) ──────────────────────────
  weeklyStatus: null,

  fetchWeeklyStatus: async (storeId, asOfDate) => {
    try {
      const { data, error } = await supabase.rpc('weekly_count_status', {
        p_store_id: storeId,
        p_as_of_date: asOfDate,
      });
      if (error) throw error;
      // RPC returns a table; with p_store_id non-null it's one row.
      const row = (Array.isArray(data) ? data[0] : data) as
        | {
            store_id: string;
            due_dow: number | null;
            window_start: string | null;
            window_end: string | null;
            status: WeeklyStatus['status'];
            last_count_id: string | null;
            last_counted_at: string | null;
          }
        | undefined;
      if (!row) {
        set({ weeklyStatus: null });
        return;
      }
      set({
        weeklyStatus: {
          storeId: row.store_id,
          dueDow: row.due_dow ?? null,
          windowStart: row.window_start ?? null,
          windowEnd: row.window_end ?? null,
          status: row.status,
          lastCountId: row.last_count_id ?? null,
          lastCountedAt: row.last_counted_at ?? null,
        },
      });
    } catch (err) {
      notifyBackendError('fetchWeeklyStatus', err);
    }
  },

  submitWeeklyCount: async ({ storeId, countedAt, entries, notes }) => {
    // Snapshot for optimistic-then-revert: clearing the banner on success
    // and restoring it if the RPC rejects.
    const prevStatus = get().weeklyStatus;
    try {
      const { data, error } = await supabase.rpc('submit_weekly_count', {
        p_client_uuid: uuidv4(),
        p_store_id: storeId,
        p_counted_at: countedAt,
        p_entries: entries,
        p_notes: notes ?? null,
      });
      if (error) throw error;
      const envelope = (data ?? {}) as Partial<SubmitWeeklyResponse>;
      // Optimistically mark this store completed so the banner clears
      // before the next focus refetch.
      if (prevStatus && prevStatus.storeId === storeId) {
        set({ weeklyStatus: { ...prevStatus, status: 'completed' } });
      }
      return {
        count_id: envelope.count_id ?? '',
        conflict: Boolean(envelope.conflict),
        entry_ids: envelope.entry_ids ?? [],
      };
    } catch (err) {
      // Revert any optimistic change (none yet here, but keep parity with
      // the store-wide pattern) and surface the error.
      set({ weeklyStatus: prevStatus });
      notifyBackendError('submitWeeklyCount', err);
      return null;
    }
  },

  // ─── SELECTORS ────────────────────────────────────────
  pendingCountForUser: (userId) => {
    if (!userId) return 0;
    return get().eodQueue.filter((q) => q.intent_user_id === userId).length;
  },
}));

// Wire the staff i18n's locale access to this store. Done once at module
// init. Importing the store inside the i18n module would create a cycle
// (the store imports the i18n registrations), so the dependency is
// injected this direction instead.
//
// Two wirings:
//   - SNAPSHOT getter for the bare `t()` (imperative call sites).
//   - REACTIVE hook for `useI18n()` — a Zustand selector subscription so
//     render-time consumers re-render when the locale changes (spec 099).
_setActiveLocaleGetter(() => useStaffStore.getState().locale);
_setActiveLocaleHook(() => useStaffStore((s) => s.locale));

// ─── HELPER: derive current signed-in user id ─────────────────────
// Many callers need the userId from authState; the kind-guard
// boilerplate is repetitive. Tiny helper for clarity. Spec 063
// renamed from `currentUserId` so the admin store's User-typed
// `currentUser` semantics don't get confused with the staff store's
// signed-in `userId`.
export function currentStaffUserId(state: AuthState | undefined): string | undefined {
  if (!state) return undefined;
  return state.kind === 'signed-in' ? state.userId : undefined;
}

/** Convenience selector for use in components — returns the active
 *  store assignment list (empty if not signed in). Spec 063 renamed
 *  from `selectStores` to disambiguate from admin code that selects
 *  brand-scoped Store rows. */
export function selectStaffStores(state: StaffState): UserStore[] {
  return state.authState.kind === 'signed-in' ? state.authState.stores : [];
}
