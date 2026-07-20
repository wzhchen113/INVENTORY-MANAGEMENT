// Spec 132 — the popup ↔ background message protocol. A small discriminated
// union; the background is the only place that touches supabase-js + chrome
// tabs/scripting, so the popup stays a thin UI.

import type { PendingOrder, ReportLine } from './types';

export type Request =
  | { type: 'AUTH_STATUS' }
  | { type: 'SIGN_IN'; email: string; password: string }
  | { type: 'SIGN_OUT' }
  | { type: 'PENDING_FOR_TAB' }
  | { type: 'RUN'; poId: string; dryRun: boolean }
  | { type: 'MARK_ORDERED'; poId: string; dryRun: boolean };

export interface AuthStatusResponse {
  signedIn: boolean;
  email: string | null;
  error: string | null;
}

export interface PendingResponse {
  /** Pending POs matched to the CURRENT tab's vendor origin (AC-3), or []. */
  orders: PendingOrder[];
  /** The current tab origin, for display. */
  origin: string | null;
  /** True if the current tab is one of the two host-permitted vendor sites. */
  onVendorSite: boolean;
  error: string | null;
}

export interface RunResponse {
  report: ReportLine[];
  /** Set when the run STOPPED on an AC-9 boundary (challenge / not-logged-in). */
  stopped: null | { reason: 'challenge' | 'not-logged-in'; detail: string };
  dryRun: boolean;
  error: string | null;
}

export interface MarkOrderedResponse {
  /** Rows updated: 1 on a real draft→sent transition, 0 on a no-op/blocked. */
  updated: number;
  /** True when the write was suppressed because dry-run is on (AC-10). */
  suppressedByDryRun: boolean;
  error: string | null;
}

export type Response =
  | AuthStatusResponse
  | PendingResponse
  | RunResponse
  | MarkOrderedResponse
  | { error: string | null };
