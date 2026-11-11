import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Spec 012c §14 / Probe 16 — `super_admin` was missing from the
// allowed-callers set, so the new "Delete profile" button in the Brands
// section (super-admin only) would have been rejected with 403. Adding
// it explicitly closes the gap. The existing 'admin' / 'master' grants
// remain (pre-existing risk surface — flagged for security-auditor).
const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);

// Spec 167 (S1 / security M1) — canonical lowercase, hyphenated uuid only.
// Byte-identical to supabase/functions/manage-store-user/index.ts UUID_RE
// (inline-not-shared, spec 027 §4.2). supabase-js auth.admin.deleteUser
// throws on anything else, while Postgres accepts braces / no hyphens, so a
// non-canonical id would reach the cleanup deletes and then 500 mid-way.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Byte-identical mirror of src/lib/placeholderEmail.ts (spec 165 §3.2);
// enforced by src/lib/placeholderEmail.parity.test.ts.
// BEGIN placeholder-email (spec 165)
const PLACEHOLDER_EMAIL_RE = /^u-[0-9a-f]{32}@no-email\.invalid$/;
function isPlaceholderEmail(email: unknown): boolean {
  return typeof email === "string" && PLACEHOLDER_EMAIL_RE.test(email.trim().toLowerCase());
}
// END placeholder-email (spec 165)

// Discriminated-union return so the outer handler can narrow on
// `status === 200` and reach `userId` / `appRole` without `!` non-null
// assertions.
type AdminGate =
  | { status: 200; userId: string; appRole: string }
  | { status: 401 | 403; error: string };

async function requireAdminCaller(authHeader: string | null): Promise<AdminGate> {
  if (!authHeader?.startsWith("Bearer ")) return { error: "missing bearer token", status: 401 };
  const token = authHeader.slice(7);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userRes, error: userErr } = await client.auth.getUser();
  if (userErr || !userRes?.user) return { error: "invalid token", status: 401 };
  const appRole = (userRes.user.app_metadata as any)?.role;
  if (ADMIN_ROLES.has(appRole)) return { userId: userRes.user.id, appRole, status: 200 };
  // JWT app_metadata didn't carry a privileged role — fall back to
  // profiles.role for callers whose JWT hasn't been refreshed since a
  // role change (or for whom app_metadata was never populated). The
  // profile-role fallback is the source of truth for the spec 012a
  // promotion path: super_admin role is set on profiles.role and the
  // JWT app_metadata is best-effort-synced by profiles_sync_role_to_jwt.
  const { data: profile } = await client.from("profiles").select("role").eq("id", userRes.user.id).single();
  if (!profile || !ADMIN_ROLES.has(profile.role)) return { error: "forbidden", status: 403 };
  return { userId: userRes.user.id, appRole: profile.role, status: 200 };
}

// Spec 043 — brand-match gate, so a compromised brand-A admin session cannot
// trigger a brand-B delete via this edge function's service_role path (which
// bypasses RLS by design). Since spec 187 dropped the "Admins can delete
// profiles" policy, public.profiles has no DELETE policy and this function is
// the only way a profile gets deleted, so this gate is the only brand scoping
// on that path.
//
// Decision shape:
//   1. Caller is super_admin → allow. super_admin keeps cross-brand delete
//      through this function. `target` is null because the
//      outer handler does its own service-role read for the
//      last-of-role guard path; super_admin can delete any role.
//   2. Caller is admin/master → fetch caller's profiles.brand_id and
//      target's profiles.brand_id + role in a single round-trip via the
//      service-role client. If the target has NO profiles row (auth-only
//      user), there's no brand to compare — fall through with `target =
//      null` (preserves pre-spec-043 behaviour for cleanup of orphaned
//      auth.users rows). If the target's profile brand_id mismatches
//      the caller's, 403.
//   3. Else (defense-in-depth — should be unreachable because
//      requireAdminCaller would have 403'd) → 403.
//
// Closes Spec 043 code-review S2 (TOCTOU on profile reads): the
// returned `target` is reused by the outer last-of-role path instead
// of refetching `profiles.role` in a second service-role round-trip.
//
// Inline per CLAUDE.md spec 027/028 "inline-not-shared" rule for edge
// functions — `supabase/functions/_shared/` is invisible drift surface.
type BrandGate =
  | { status: 200; target: { brand_id: string | null; role: string } | null }
  | { status: 403; error: string };

async function requireSameBrandOrSuperAdmin(
  serviceClient: SupabaseClient,
  callerId: string,
  callerAppRole: string,
  targetUserId: string,
): Promise<BrandGate> {
  if (callerAppRole === "super_admin") return { status: 200, target: null };
  if (callerAppRole !== "admin" && callerAppRole !== "master") {
    // Belt-and-suspenders. requireAdminCaller should have already
    // rejected unknown roles.
    return { error: "forbidden", status: 403 };
  }

  // Single read for both columns the destructive path needs:
  // brand_id (this gate) and role (the outer last-of-role guard).
  // Closes the TOCTOU window between the two pre-S2 reads.
  const { data: targetProfile, error: targetErr } = await serviceClient
    .from("profiles")
    .select("brand_id, role")
    .eq("id", targetUserId)
    .maybeSingle();
  if (targetErr) {
    return { error: targetErr.message, status: 403 };
  }
  // Auth-only user (no profiles row). No brand to compare; preserve
  // the pre-spec-043 cleanup behaviour. The destructive path below
  // still runs auth.admin.deleteUser (and the user_stores /
  // invitations cleanups, which are no-ops for an auth-only user
  // anyway).
  if (!targetProfile) return { status: 200, target: null };

  const { data: callerProfile, error: callerErr } = await serviceClient
    .from("profiles")
    .select("brand_id")
    .eq("id", callerId)
    .maybeSingle();
  if (callerErr) {
    return { error: callerErr.message, status: 403 };
  }
  if (!callerProfile) {
    // Caller's app_metadata.role says admin/master but they have no
    // profiles row. Treat as forbidden — without a brand we cannot
    // safely scope the delete.
    return { error: "forbidden: caller profile not found", status: 403 };
  }

  // Closes Spec 043 code-review S1 (null-vs-null brand_id comparison
  // gap). The DB CHECK profiles_role_brand_consistent enforces
  // brand_id NOT NULL for admin/master rows, but the runtime guard
  // closes the narrow window where the constraint is in a transient
  // state (mid-backfill, disabled CHECK, etc.). Without this guard,
  // `null !== null` evaluates false in JS — a caller with NULL
  // brand_id attempting to delete a super_admin (also NULL brand_id)
  // would mispass the strict-inequality check below.
  if (!callerProfile.brand_id) {
    return { error: "forbidden: caller has no brand scope", status: 403 };
  }

  if (callerProfile.brand_id !== targetProfile.brand_id) {
    return { error: "forbidden: target is in a different brand", status: 403 };
  }

  return { status: 200, target: { brand_id: targetProfile.brand_id, role: targetProfile.role } };
}

// ── Audit trail (spec 187) ────────────────────────────────────────────────
// Server-side public.audit_log rows recording who deleted whom, in spec 167's
// writer shape (supabase/functions/manage-store-user/index.ts). One row per
// store in the union of the target's user_stores and the stores of the
// approvals they approved, never a NULL-store row. Best-effort: these helpers
// NEVER throw, and an audit failure never changes the delete or its response.
//
// Log hygiene (spec 167 AC-4/AC-6, spec 187 AC-29): log lines carry only static
// text plus caller id, target id, action and the error code (or the exception
// class name for a throw). Never the error message/details, the rows, the name
// or the email.

const AUDIT_ACTION = "User deleted";
const AUDIT_TIMEOUT_MS = 3000;

type DeleteAuditIds = { callerId: string; targetId: string };

type DeleteAuditSnapshot = {
  callerHasProfile: boolean;
  targetName: string | null;
  targetRole: string | null;
  targetBrandId: string | null;
  email: string | null;
  // null when a read failed (already logged): no rows are written.
  storeIds: string[] | null;
  // null when the count read failed (already logged), not "no approvals": no rows are written.
  approvalCount: number | null;
};

type DeleteAuditRow = {
  store_id: string;
  user_id: string | null;
  action: typeof AUDIT_ACTION;
  item_ref: string | null;
  value: string;
  detail: string;
};

function errorClass(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

function logAuditFailure(what: string, ids: DeleteAuditIds, code: unknown): void {
  console.error(`[delete-user] ${what} failed`, ids.callerId, ids.targetId, AUDIT_ACTION, code);
}

// NEVER throws. Reads what the audit row needs while it still exists. Runs after
// the last-of-role guard, so refused requests do none of this I/O.
async function readDeleteAuditSnapshot(
  serviceClient: SupabaseClient,
  callerId: string,
  targetId: string,
): Promise<DeleteAuditSnapshot> {
  const ids: DeleteAuditIds = { callerId, targetId };

  const readProfiles = async () => {
    try {
      const { data, error } = await serviceClient
        .from("profiles")
        .select("id, name, role, brand_id")
        .in("id", [targetId, callerId])
        .abortSignal(AbortSignal.timeout(AUDIT_TIMEOUT_MS));
      if (error) {
        logAuditFailure("audit profile read", ids, error.code);
        return null;
      }
      return (data ?? []) as { id: string; name: string; role: string; brand_id: string | null }[];
    } catch (e) {
      logAuditFailure("audit profile read", ids, errorClass(e));
      return null;
    }
  };

  // auth.users isn't exposed through PostgREST. Same call manage-store-user uses.
  const readEmail = async () => {
    let timer: number | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DOMException("audit email read timed out", "TimeoutError")), AUDIT_TIMEOUT_MS);
      });
      // On timeout the race abandons the getUserById call; it doesn't cancel it.
      const { data, error } = await Promise.race([serviceClient.auth.admin.getUserById(targetId), timeout]);
      if (error) {
        logAuditFailure("audit email read", ids, error.code ?? error.status);
        return null;
      }
      return data.user?.email ?? null;
    } catch (e) {
      logAuditFailure("audit email read", ids, errorClass(e));
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const readUserStoreIds = async () => {
    try {
      const { data, error } = await serviceClient
        .from("user_stores")
        .select("store_id")
        .eq("user_id", targetId)
        .abortSignal(AbortSignal.timeout(AUDIT_TIMEOUT_MS));
      if (error) {
        logAuditFailure("audit store read", ids, error.code);
        return null;
      }
      return ((data ?? []) as { store_id: string }[]).map((r) => r.store_id);
    } catch (e) {
      logAuditFailure("audit store read", ids, errorClass(e));
      return null;
    }
  };

  const readApprovalCount = async () => {
    try {
      const { count, error } = await serviceClient
        .from("order_approvals")
        .select("id", { count: "exact", head: true })
        .eq("approved_by", targetId)
        .abortSignal(AbortSignal.timeout(AUDIT_TIMEOUT_MS));
      if (error) {
        logAuditFailure("audit approval count", ids, error.code);
        return null;
      }
      return count ?? 0;
    } catch (e) {
      logAuditFailure("audit approval count", ids, errorClass(e));
      return null;
    }
  };

  // From stores, not order_approvals: max_rows = 1000 (config.toml) would silently
  // drop stores for a target with more than 1,000 approvals.
  const readApprovalStoreIds = async () => {
    try {
      const { data, error } = await serviceClient
        .from("stores")
        .select("id, order_approvals!inner(id)")
        .eq("order_approvals.approved_by", targetId)
        .limit(1, { referencedTable: "order_approvals" })
        .abortSignal(AbortSignal.timeout(AUDIT_TIMEOUT_MS));
      if (error) {
        logAuditFailure("audit approval store read", ids, error.code);
        return null;
      }
      return ((data ?? []) as { id: string }[]).map((r) => r.id);
    } catch (e) {
      logAuditFailure("audit approval store read", ids, errorClass(e));
      return null;
    }
  };

  const [profiles, email, userStoreIds, approvalCount, approvalStoreIds] = await Promise.all([
    readProfiles(),
    readEmail(),
    readUserStoreIds(),
    readApprovalCount(),
    readApprovalStoreIds(),
  ]);

  const target = profiles?.find((p) => p.id === targetId) ?? null;
  return {
    // A failed read leaves user_id NULL, which can't fail the FK.
    callerHasProfile: profiles?.some((p) => p.id === callerId) ?? false,
    targetName: target?.name ?? null,
    targetRole: target?.role ?? null,
    targetBrandId: target?.brand_id ?? null,
    email,
    storeIds:
      userStoreIds && approvalStoreIds ? Array.from(new Set([...userStoreIds, ...approvalStoreIds])) : null,
    approvalCount,
  };
}

// Pure. One row per store id. A placeholder account's address never reaches a
// column (spec 165): both surfaces render `value` only when it is truthy.
function buildUserDeletedRows(
  storeIds: string[],
  ids: DeleteAuditIds,
  snapshot: DeleteAuditSnapshot,
  approvalCount: number,
  authUserDeleted: boolean,
): DeleteAuditRow[] {
  const itemRef = isPlaceholderEmail(snapshot.targetName) ? null : snapshot.targetName;
  const value = snapshot.email && !isPlaceholderEmail(snapshot.email) ? snapshot.email : "";
  const detail = JSON.stringify({
    caller_id: ids.callerId,
    target_id: ids.targetId,
    target_role: snapshot.targetRole,
    brand_id: snapshot.targetBrandId,
    approval_count: approvalCount,
    auth_user_deleted: authUserDeleted,
  });
  return storeIds.map((store_id) => ({
    store_id,
    user_id: snapshot.callerHasProfile ? ids.callerId : null,
    action: AUDIT_ACTION,
    item_ref: itemRef,
    value,
    detail,
  }));
}

// NEVER throws / rejects. One bulk INSERT (atomic: all rows or none).
async function writeDeleteAudit(
  serviceClient: SupabaseClient,
  ids: DeleteAuditIds,
  snapshot: DeleteAuditSnapshot,
  authUserDeleted: boolean,
): Promise<void> {
  // The store or approval-count read failed, and already logged.
  if (snapshot.storeIds === null || snapshot.approvalCount === null) return;

  const rows = buildUserDeletedRows(snapshot.storeIds, ids, snapshot, snapshot.approvalCount, authUserDeleted);
  if (rows.length === 0) {
    console.warn("[delete-user] audit skipped: target has no stores", ids.callerId, ids.targetId, AUDIT_ACTION);
    return;
  }
  try {
    const { error } = await serviceClient
      .from("audit_log")
      .insert(rows)
      .abortSignal(AbortSignal.timeout(AUDIT_TIMEOUT_MS));
    if (error) logAuditFailure("audit write", ids, error.code);
  } catch (e) {
    logAuditFailure("audit write", ids, errorClass(e));
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const gate = await requireAdminCaller(req.headers.get("Authorization"));
  if (gate.status !== 200) {
    return new Response(JSON.stringify({ error: gate.error }), {
      status: gate.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Spec 167 (L7) — normalize once: trim + lowercase. Postgres uuid
    // comparison is case-insensitive but JS string === is not, so an
    // uppercased self id used to slip past the self-guard. A non-string
    // userId (or a null / array body) normalizes to "" → "userId required"
    // instead of throwing. The normalized value is used for every later
    // read / guard / delete (uuid columns parse case-insensitively).
    const body: unknown = await req.json();
    const rawUserId =
      body && typeof body === "object" ? (body as Record<string, unknown>).userId : undefined;
    const userId = typeof rawUserId === "string" ? rawUserId.trim().toLowerCase() : "";

    // Empty, or not the canonical uuid form (braces, no hyphens, etc.) →
    // refuse BEFORE the self-guard and before any read / side effect.
    if (!userId || !UUID_RE.test(userId)) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (userId === gate.userId.toLowerCase()) {
      return new Response(JSON.stringify({ error: "cannot delete self" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Spec 043 — defense-in-depth brand-match gate. Runs BEFORE the
    // spec 031 last-of-role guard so a brand-A admin attempting to
    // delete a brand-B super_admin gets 403 (not the misleading 400
    // 'cannot delete the last super_admin'). Same-brand last-of-role
    // attempts still fall through to the last-of-role guard below.
    //
    // The gate also returns the target's `{ brand_id, role }` row so
    // the last-of-role path below can reuse it instead of issuing a
    // second service-role read against `profiles` (closes Spec 043
    // code-review S2 TOCTOU). For super_admin callers and auth-only
    // targets, `target` is null and the last-of-role guard no-ops as
    // before.
    const brandGate = await requireSameBrandOrSuperAdmin(
      supabase,
      gate.userId,
      gate.appRole,
      userId,
    );
    if (brandGate.status !== 200) {
      return new Response(JSON.stringify({ error: brandGate.error }), {
        status: brandGate.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Spec 031 — last-of-role guard. Refuse deletion if the target is
    // the only remaining super_admin or master. The guard sits BEFORE
    // any side-effect deletes so a refusal is atomic — no partial
    // cleanup on the target's row. The SQL helper
    // public.assert_not_last_of_role() is the single source of truth
    // (also exercised by supabase/tests/delete_last_privileged_guard.test.sql).
    //
    // Target role comes from the brand-gate's consolidated read for
    // admin/master callers. For super_admin callers (brandGate.target
    // is null), look up the role here — super_admin retains
    // cross-brand DELETE and may target any role.
    //
    // Auth-only user (no profiles row) → guard no-ops; the existing
    // delete sequence handles cleanup of user_stores / invitations /
    // auth.users as before.
    let targetRole: string | null = brandGate.target?.role ?? null;
    if (targetRole === null && gate.appRole === "super_admin") {
      const { data: targetProfileRole, error: lookupError } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .maybeSingle();

      if (lookupError) {
        return new Response(JSON.stringify({ error: lookupError.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      targetRole = targetProfileRole?.role ?? null;
    }

    if (targetRole) {
      const { error: guardError } = await supabase.rpc("assert_not_last_of_role", {
        target_user_id: userId,
        target_role: targetRole,
      });
      if (guardError) {
        const status = guardError.code === "P0001" ? 400 : 500;
        return new Response(JSON.stringify({ error: guardError.message }), {
          status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Spec 187 — read before the cleanup deletes remove what the audit row needs.
    const auditIds: DeleteAuditIds = { callerId: gate.userId, targetId: userId };
    const auditSnapshot = await readDeleteAuditSnapshot(supabase, gate.userId, userId);

    await supabase.from("user_stores").delete().eq("user_id", userId);
    const { data: removedProfiles } = await supabase.from("profiles").delete().eq("id", userId).select("id");
    // Decides the audit row and nothing else. The cleanup errors stay ignored.
    const profileRemoved = (removedProfiles?.length ?? 0) > 0;
    await supabase.from("invitations").delete().eq("profile_id", userId);

    // A separate flag rather than a check on the caught value: a thrown `undefined`
    // must still count as a failure and must not fall through to the 200.
    let error: { message: string } | null = null;
    let authDeleteThrew = false;
    let authDeleteThrown: unknown;
    try {
      ({ error } = await supabase.auth.admin.deleteUser(userId));
    } catch (e) {
      authDeleteThrew = true;
      authDeleteThrown = e;
    }
    const authUserDeleted = !error && !authDeleteThrew;

    // Write whenever the profile or the login was removed: an errored profile
    // delete rolled back, but the auth delete then cascades to profiles.
    if (profileRemoved || authUserDeleted) {
      await writeDeleteAudit(supabase, auditIds, auditSnapshot, authUserDeleted);
    } else {
      console.warn("[delete-user] audit skipped: nothing removed", gate.userId, userId, AUDIT_ACTION);
    }

    if (authDeleteThrew) throw authDeleteThrown;

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
