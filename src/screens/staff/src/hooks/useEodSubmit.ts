// src/hooks/useEodSubmit.ts — submit orchestrator + drain coordinator.
//
// Spec 062 §4: the canonical hook that maps the supabase RPC into one
// of four outcomes (success / success-replay / forbidden / queued /
// failed). UI screens depend ONLY on this hook — they never touch
// supabase.rpc directly.
//
// Drain behavior:
//   - Fires on connectivity flip (false → true) via useConnectionStatus.
//   - Also fires once on mount (in case items were queued by a prior
//     session that died offline).
//   - Drain order: FIFO by queued_at.
//   - Single-threaded — drain one item, wait for response, drain next.
//   - intent_user_id boundary: items not matching the current user's
//     auth.uid() are SKIPPED at drain time (left in storage as a
//     passive record).
//   - "All counts synced" toast is debounced 400ms to avoid jarring
//     mid-screen-transition fires (spec 062 §11 risk (h)).
//
// Note on entry shape mapping:
//   UI side (this hook's `SubmitPayload`) uses `item_id` + `count`.
//   Backend RPC expects `ingredient_id` + `actual_remaining` per
//   jsonb_to_recordset signature. Mapping happens once at the RPC
//   boundary; callers stay readable.

import { useCallback, useEffect, useRef } from 'react';
import Toast from 'react-native-toast-message';
import { supabase } from '../lib/supabase';
import { currentUserId, useStore } from '../store/useStore';
import { useConnectionStatus } from './useConnectionStatus';
import { uuidv4 } from '../lib/uuid';
import { t } from '../i18n';
import type {
  EodEntry,
  Outcome,
  QueuedSubmission,
  StaffSubmitEodResponse,
  SubmitPayload,
} from '../lib/types';

const DRAIN_TOAST_DEBOUNCE_MS = 400;

function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: string; name?: string };
  const msg = (e.message || '').toLowerCase();
  const name = (e.name || '').toLowerCase();
  return (
    msg.includes('network request failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('aborted') ||
    msg.includes('timeout') ||
    name === 'aborterror' ||
    name === 'typeerror' && msg.includes('network')
  );
}

function isForbidden(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string; status?: number };
  if (e.code === '42501') return true;
  if (e.status === 403) return true;
  // Some supabase-js shapes surface the SQLSTATE in the message.
  return Boolean(e.message && e.message.includes('42501'));
}

function entriesForRpc(entries: EodEntry[]): Array<{
  ingredient_id: string;
  actual_remaining: number;
}> {
  return entries.map((e) => ({
    ingredient_id: e.item_id,
    actual_remaining: e.count,
  }));
}

async function callStaffSubmitEod(
  clientUuid: string,
  payload: SubmitPayload,
): Promise<StaffSubmitEodResponse> {
  const { data, error } = await supabase.rpc('staff_submit_eod', {
    p_client_uuid: clientUuid,
    p_store_id: payload.store_id,
    p_date: payload.date,
    p_submitted_by: null,
    p_status: 'submitted',
    p_entries: entriesForRpc(payload.entries),
    p_vendor_id: payload.vendor_id,
  });
  if (error) throw error;
  return data as StaffSubmitEodResponse;
}

export function useEodSubmit(): {
  submit: (payload: SubmitPayload) => Promise<Outcome>;
  pending: number;
  draining: boolean;
} {
  const isOnline = useConnectionStatus();

  // Reactive selectors. Filtered count for the CURRENT user only
  // (intent_user_id soft boundary).
  const userId = useStore((s) => currentUserId(s.authState));
  const pending = useStore((s) => s.pendingCountForUser(userId));
  const draining = useStore((s) => s.draining);

  // Track wasOnline to detect false → true transitions.
  const wasOnlineRef = useRef<boolean>(isOnline);
  // Debounce timer for "All counts synced" toast.
  const allSyncedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard against overlapping drains.
  const drainingRef = useRef<boolean>(false);

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    useStore.getState().setDraining(true);
    try {
      const me = userId;
      if (!me) {
        // No signed-in user — nothing we're allowed to drain.
        return;
      }
      // Snapshot the queue at drain start; we re-read the store as we go.
      // FIFO by queued_at — sort defensively in case the in-memory order
      // ever drifts.
      const snapshot = [...useStore.getState().eodQueue].sort(
        (a, b) => a.queued_at.localeCompare(b.queued_at),
      );
      let drainedAny = false;
      for (const item of snapshot) {
        // intent_user_id boundary: skip items not belonging to the
        // currently signed-in user. They stay in storage.
        if (item.intent_user_id !== me) continue;

        // Re-derive the network status before each call — connectivity
        // can drop mid-drain.
        try {
          const res = await callStaffSubmitEod(item.client_uuid, {
            store_id: item.store_id,
            date: item.date,
            vendor_id: item.vendor_id,
            entries: item.entries,
          });
          // success OR replay — both treated as removal.
          await useStore.getState().dequeueEod(item.client_uuid);
          drainedAny = true;
          if (res.conflict) {
            // Replay path — quieter toast.
            Toast.show({
              type: 'success',
              text1: t('eod.toast.alreadySubmitted'),
              position: 'bottom',
              visibilityTime: 2500,
            });
          }
        } catch (err) {
          if (isForbidden(err)) {
            // 403 — REMOVE from queue (spec: do NOT infinitely re-queue).
            // Show persistent error indicator naming date + vendor.
            await useStore.getState().dequeueEod(item.client_uuid);
            Toast.show({
              type: 'error',
              text1: t('chrome.queue.syncErrorBanner', {
                date: item.date,
                vendor: item.vendor_id,
              }),
              position: 'bottom',
              visibilityTime: 6000,
            });
          } else if (isNetworkError(err)) {
            // Network — bump attempts; leave in queue; STOP the drain
            // (likely offline again).
            await useStore.getState().bumpEodAttempts(
              item.client_uuid,
              'network',
            );
            break;
          } else {
            // Other error (5xx / malformed). Bump attempts; continue to
            // next item so a single bad row doesn't block the queue.
            await useStore.getState().bumpEodAttempts(
              item.client_uuid,
              err instanceof Error ? err.message : 'unknown',
            );
          }
        }
      }
      // Debounced "All counts synced" — only when queue is empty AFTER
      // the drain pass AND we actually drained at least one item.
      if (
        drainedAny &&
        useStore.getState().pendingCountForUser(me) === 0
      ) {
        if (allSyncedTimerRef.current) clearTimeout(allSyncedTimerRef.current);
        allSyncedTimerRef.current = setTimeout(() => {
          Toast.show({
            type: 'success',
            text1: t('eod.toast.allSynced'),
            position: 'bottom',
            visibilityTime: 2500,
          });
        }, DRAIN_TOAST_DEBOUNCE_MS);
      }
    } finally {
      drainingRef.current = false;
      useStore.getState().setDraining(false);
    }
  }, [userId]);

  // Effect 1 — drain on connectivity flip (false → true).
  useEffect(() => {
    const was = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;
    if (!was && isOnline) {
      void drain();
    }
  }, [isOnline, drain]);

  // Effect 2 — one-shot drain on mount (in case items were queued by
  // a prior session that died offline). Only fires once per mount;
  // bounded by drainingRef.
  useEffect(() => {
    if (isOnline) {
      void drain();
    }
    // Intentionally omitting `drain` and `isOnline` from deps so this
    // is a true one-shot — the flip-detection effect above handles
    // ongoing transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(
    async (payload: SubmitPayload): Promise<Outcome> => {
      const clientUuid = uuidv4();
      const me = userId;
      if (!me) {
        return {
          kind: 'failed',
          message: 'Not signed in',
        };
      }

      // Build the canonical queue shape upfront — we may need it for
      // the offline/network paths.
      const queueItem: QueuedSubmission = {
        client_uuid: clientUuid,
        store_id: payload.store_id,
        date: payload.date,
        vendor_id: payload.vendor_id,
        status: 'submitted',
        entries: payload.entries,
        queued_at: new Date().toISOString(),
        intent_user_id: me,
        attempts: 0,
      };

      // Snapshot connectivity. If offline, persist + return queued.
      if (!isOnline) {
        await useStore.getState().enqueueEod(queueItem);
        return { kind: 'queued', client_uuid: clientUuid };
      }

      try {
        const res = await callStaffSubmitEod(clientUuid, payload);
        if (res.conflict === true) {
          return {
            kind: 'success-replay',
            submission_id: res.submission_id,
          };
        }
        return { kind: 'success', submission_id: res.submission_id };
      } catch (err) {
        if (isForbidden(err)) {
          return {
            kind: 'forbidden',
            message: t('eod.error.forbidden'),
          };
        }
        if (isNetworkError(err)) {
          await useStore.getState().enqueueEod(queueItem);
          return { kind: 'queued', client_uuid: clientUuid };
        }
        return {
          kind: 'failed',
          message: t('eod.toast.failed'),
        };
      }
    },
    [isOnline, userId],
  );

  return { submit, pending, draining };
}
