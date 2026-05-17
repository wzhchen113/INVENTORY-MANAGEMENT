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

// Spec 043 — defense-in-depth brand-match gate. Mirrors the SQL-side
// "Admins can delete profiles" DELETE policy tightening so a compromised
// brand-A admin session cannot trigger a brand-B delete via this edge
// function's service_role path (which bypasses RLS by design).
//
// Decision shape:
//   1. Caller is super_admin → allow. auth_can_see_brand short-circuits
//      on auth_is_super_admin, so super_admin retains cross-brand DELETE
//      via the SQL policy too — parity. `target` is null because the
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
    const { userId } = await req.json();

    if (!userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (userId === gate.userId) {
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

    await supabase.from("user_stores").delete().eq("user_id", userId);
    await supabase.from("profiles").delete().eq("id", userId);
    await supabase.from("invitations").delete().eq("profile_id", userId);

    const { error } = await supabase.auth.admin.deleteUser(userId);

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
