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
  UserStore,
} from '../lib/types';
import {
  persistQueue,
  writeActiveStoreId,
} from '../lib/eodQueue';
import { notifyBackendError } from '../lib/notifyBackendError';

export type StaffState = {
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

  // ─── SELECTORS ────────────────────────────────────────
  /** Count of queued items belonging to the current user
   *  (intent_user_id filter). Drives the QueueIndicator badge. */
  pendingCountForUser: (userId: string | undefined) => number;
};

export const useStaffStore = create<StaffState>((set, get) => ({
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

  // ─── SELECTORS ────────────────────────────────────────
  pendingCountForUser: (userId) => {
    if (!userId) return 0;
    return get().eodQueue.filter((q) => q.intent_user_id === userId).length;
  },
}));

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
