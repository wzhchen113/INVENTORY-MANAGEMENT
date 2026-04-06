// src/store/useJsonServerSync.ts
// Optional hook that syncs Zustand actions to json-server
// Usage: call useJsonServerSync() in a top-level component to enable persistence
// Requires: npx json-server db.json --port 3001

import { useEffect, useRef } from 'react';
import { useStore } from './useStore';
import * as api from '../lib/api';

export function useJsonServerSync() {
  const initialized = useRef(false);
  const serverAvailable = useRef(false);

  useEffect(() => {
    if (initialized.current || !__DEV__) return;
    initialized.current = true;

    // Check if json-server is running, then load data
    api.isServerRunning().then((running) => {
      serverAvailable.current = running;
      if (!running) {
        console.log('[json-server] Not running — using in-memory seed data');
        return;
      }
      console.log('[json-server] Connected — loading data from db.json');
      loadFromServer();
    });
  }, []);

  // Subscribe to store changes and sync to server (dev only)
  useEffect(() => {
    if (!__DEV__) return;
    const unsub = useStore.subscribe((state, prevState) => {
      if (!serverAvailable.current) return;

      // Sync new EOD submissions
      if (state.eodSubmissions.length > prevState.eodSubmissions.length) {
        const newest = state.eodSubmissions[0];
        if (newest) {
          api.addEODSubmission(newest).catch((e) =>
            console.warn('[json-server] Failed to sync EOD submission:', e.message)
          );
        }
      }

      // Sync new waste entries
      if (state.wasteLog.length > prevState.wasteLog.length) {
        const newest = state.wasteLog[0];
        if (newest) {
          api.addWasteEntry(newest).catch((e) =>
            console.warn('[json-server] Failed to sync waste entry:', e.message)
          );
        }
      }

      // Sync new audit events
      if (state.auditLog.length > prevState.auditLog.length) {
        const newest = state.auditLog[0];
        if (newest) {
          api.addAuditEntry(newest).catch((e) =>
            console.warn('[json-server] Failed to sync audit entry:', e.message)
          );
        }
      }
    });

    return unsub;
  }, []);
}

async function loadFromServer() {
  try {
    const [eodSubmissions, wasteLog, auditLog] = await Promise.all([
      api.fetchEODSubmissions(),
      api.fetchWasteLog(),
      api.fetchAuditLog(),
    ]);

    // Merge server data into store (server data takes precedence for these collections)
    const state = useStore.getState();
    useStore.setState({
      eodSubmissions: eodSubmissions.length > 0 ? eodSubmissions : state.eodSubmissions,
      wasteLog: wasteLog.length > 0 ? wasteLog : state.wasteLog,
      auditLog: auditLog.length > 0 ? auditLog : state.auditLog,
    });

    console.log('[json-server] Loaded:', {
      eodSubmissions: eodSubmissions.length,
      wasteLog: wasteLog.length,
      auditLog: auditLog.length,
    });
  } catch (e: any) {
    console.warn('[json-server] Failed to load data:', e.message);
  }
}
