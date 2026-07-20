// Spec 132 (D-2, 131 D-3/D-4) — the extension's thin I.M.R data client. A
// legitimate carve-out from CLAUDE.md's "all DB access through db.ts": the
// extension is a SEPARATE bundle (like src/screens/staff/), so it talks to
// Supabase via its OWN supabase-js client, not the Expo app's db.ts.
//
// Auth: the admin's OWN email+password Supabase session (D-2). Every call rides
// the admin's JWT, so the two SECURITY INVOKER RPCs + the guarded mark-ordered
// UPDATE are bounded to EXACTLY the admin's auth_can_see_store / auth_can_see_brand
// visibility — no service key, no broader-than-admin access (AC-2). NO vendor
// credential is ever handled here.

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';
import { chromeStorageAdapter } from './storageAdapter';
import type { OrderPayload, PendingOrder } from './types';

let client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: chromeStorageAdapter,
        storageKey: 'imr-cart-filler-auth',
        autoRefreshToken: true,
        persistSession: true,
        // No URL-based session detection in an extension context.
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

export interface AuthResult {
  session: Session | null;
  error: string | null;
}

/** Sign in as the admin with their OWN I.M.R email + password (AC-2 / D-2). */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await getClient().auth.signInWithPassword({ email, password });
  return { session: data.session ?? null, error: error ? error.message : null };
}

export async function signOut(): Promise<void> {
  await getClient().auth.signOut();
}

export async function getSession(): Promise<Session | null> {
  const { data } = await getClient().auth.getSession();
  return data.session ?? null;
}

export interface RpcResult<T> {
  data: T | null;
  error: string | null;
}

/** 131 RPC 1 — the pending PO set, optionally filtered to one vendor (AC-3). */
export async function fetchPendingOrders(vendorId: string | null): Promise<RpcResult<PendingOrder[]>> {
  const { data, error } = await getClient().rpc('get_pending_extension_orders', {
    p_vendor_id: vendorId,
  });
  if (error) return { data: null, error: error.message };
  return { data: (data as PendingOrder[]) ?? [], error: null };
}

/** 131 RPC 2 — one PO's structured payload (AC-4). */
export async function fetchOrderPayload(poId: string): Promise<RpcResult<OrderPayload>> {
  const { data, error } = await getClient().rpc('get_extension_order_payload', {
    p_po_id: poId,
  });
  if (error) return { data: null, error: error.message };
  return { data: (data as OrderPayload) ?? null, error: null };
}

/**
 * 131 D-4 / AC-6 — the mark-ordered write-back. A GUARDED PostgREST UPDATE
 * (`... set status='sent' where id=:poId AND status='draft'`) — REQUIRED shape
 * per the architect post-impl S-1 (never the unguarded markPurchaseOrderSent).
 * The `and status='draft'` guard makes it idempotent (a re-mark is a 0-row
 * no-op) and cannot resurrect a received/cancelled PO. store_member_update_
 * purchase_orders RLS bounds it to visible stores (a caller cannot mark a PO
 * ordered in a store they can't see).
 *
 * Returns the number of rows updated (1 on a real transition, 0 on an
 * already-sent / not-visible / not-draft PO). NEVER call this in dry-run —
 * the dry-run gate (core/dryRun.ts) governs whether it fires.
 */
export async function markOrdered(poId: string): Promise<RpcResult<number>> {
  const { data, error } = await getClient()
    .from('purchase_orders')
    .update({ status: 'sent' })
    .eq('id', poId)
    .eq('status', 'draft')
    .select('id');
  if (error) return { data: null, error: error.message };
  return { data: (data as unknown[])?.length ?? 0, error: null };
}
