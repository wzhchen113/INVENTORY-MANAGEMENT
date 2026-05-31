// e2e/fixtures/db.ts — Spec 079: shared service-role client for the e2e/ tree.
//
// WHY THIS EXISTS (DRY extraction, NOT a new capability). Spec 078 landed
// the service-role client + the `assertLocalStack` prod-URL guard inside
// `global-setup.ts`, and `global-teardown.ts` already cross-imported
// `assertLocalStack` FROM that setup file — a smell (the guard + key living
// in a setup file). Spec 079 adds a THIRD consumer (the EOD persistence
// service-role read, AC-EOD-PERSIST-2), so the right time to extract a small
// shared factory has arrived. global-setup + global-teardown are refactored
// to import from here; their behavior is IDENTICAL (same URL, same key, same
// guard) — pure de-duplication. The service-role helper is merely EXTRACTED,
// not newly introduced; the 078 security audit already cleared it.
//
// SECURITY POSTURE (unchanged from spec 078): LOCAL stack only. The key is
// the well-known demo service key baked into `supabase start`
// (env-overridable via SUPABASE_SERVICE_ROLE_KEY). It is NOT a prod secret.
// `assertLocalStack` refuses any non-local URL unless E2E_ALLOW_REMOTE=1 (the
// deferred OQ-1 remote-test-branch path). The key is never logged. The runtime
// DB touch lives in test code (the e2e/ tree), so it does not widen the
// src/lib/db.ts centralization rule.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Well-known LOCAL stack values (stable across `supabase start`); both
// env-overridable so a remote test branch is a CI-secret swap, not a code
// change (OQ-1). The service-role key bypasses RLS for the fixture insert +
// the single persistence read.
const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// Prod-URL guard (security-auditor Low, spec 078 fix-pass): the service-role
// key writes/reads rows bypassing RLS. Refuse to run against anything but the
// local stack, so a stray prod `EXPO_PUBLIC_SUPABASE_URL` in a dev's shell can
// never be targeted. Set `E2E_ALLOW_REMOTE=1` to intentionally point at a
// remote test branch (the deferred OQ-1 path). Behavior is byte-for-byte
// identical to the spec-078 version that lived in global-setup.ts.
export function assertLocalStack(url: string): void {
  if (process.env.E2E_ALLOW_REMOTE) return;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) {
    throw new Error(
      `[e2e] refusing to run a service-role fixture against non-local URL "${url}". ` +
        `This guard prevents a stray prod EXPO_PUBLIC_SUPABASE_URL from being targeted. ` +
        `Set E2E_ALLOW_REMOTE=1 to intentionally target a remote stack (OQ-1).`,
    );
  }
}

// The single source of the service-role client for the e2e/ tree. The guard
// fires on EVERY construction (defense in depth — a caller can never get a
// client pointed at a non-local URL by accident).
export function serviceRoleClient(): SupabaseClient {
  assertLocalStack(SUPABASE_URL);
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Today's date as `yyyy-mm-dd` in LOCAL time — a byte-for-byte mirror of
// EODCount.todayIso() (src/screens/staff/screens/EODCount.tsx:57-63). The EOD
// app writes eod_submissions.date with THIS derivation, so the persistence
// read (AC-EOD-PERSIST-2/3) must key off the identical string or it would
// query the wrong calendar day near a midnight boundary. Local (not UTC) on
// purpose: that is what the app writes.
export function todayIso(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
