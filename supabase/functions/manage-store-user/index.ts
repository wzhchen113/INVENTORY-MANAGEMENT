// manage-store-user (spec 165) — admin-only create / set-password for
// USERNAME-ONLY store users (no real email).
//
//   POST { action: "create", name, username, password, storeIds }
//     → 201 { id, username }
//   POST { action: "set_password", userId, password }
//     → 200 { success: true }
//
// Auth posture: verify_jwt = true (pinned in config.toml). The caller's
// Supabase JWT is gated by an inline requireAdminCaller() / ADMIN_ROLES set
// mirroring public.auth_is_privileged() (copied verbatim from delete-user),
// plus the spec 043 brand-match gate for admin/master callers. Every DB write
// uses the service-role client, which BYPASSES RLS and the spec 164
// profiles_insert_role_guard — so every role / brand / store rule is
// enforced explicitly in this file. The request can never choose the role
// (hard-coded 'user'), the brand (derived from the stores), the email
// (server-generated placeholder) or the auth user id.
//
// Placeholder email: `u-<32 hex>@no-email.invalid` (spec 165 §3). Random,
// not derived from the user id or username. Never returned in a response.
//
// Log hygiene (spec 165 §4.5): never log the request body, the password, the
// generated email, or GoTrue request objects. Only error code/status and the
// compensation orphan id are logged.
//
// JSON only — no HTML, so no escapeHtml() concern.
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

// Mirrors public.auth_is_privileged() (admin OR super-admin). CLAUDE.md
// "Edge function role gates mirror auth_is_privileged()".
const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);

const PASSWORD_MIN_LENGTH = 8;
const NAME_MAX_LENGTH = 100;
const MAX_STORE_IDS = 100;
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Byte-identical mirror of src/lib/usernameValidation.ts (spec 165 §3.4);
// enforced by src/lib/placeholderEmail.parity.test.ts.
const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // BEGIN reserved-usernames (spec 165)
  'admin',
  'root',
  'master',
  'superadmin',
  'super_admin',
  'support',
  'system',
  'null',
  'undefined',
  'me',
  'owner',
  // END reserved-usernames (spec 165)
]);

// Byte-identical mirror of src/lib/placeholderEmail.ts (spec 165 §3.2);
// enforced by src/lib/placeholderEmail.parity.test.ts.
// BEGIN placeholder-email (spec 165)
const PLACEHOLDER_EMAIL_RE = /^u-[0-9a-f]{32}@no-email\.invalid$/;
function isPlaceholderEmail(email: unknown): boolean {
  return typeof email === "string" && PLACEHOLDER_EMAIL_RE.test(email.trim().toLowerCase());
}
// END placeholder-email (spec 165)

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Caller gate (verbatim from delete-user/index.ts) ──────────────────────

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

// ── Caller brand scope (spec 043 wording, delete-user/index.ts:119-140) ───
// super_admin → { brandId: null } (no brand scope; may target any brand).
// admin/master → their non-NULL profiles.brand_id, or a 403.

type CallerBrand =
  | { ok: true; brandId: string | null }
  | { ok: false; status: 403 | 500; error: string };

async function readCallerBrand(
  serviceClient: SupabaseClient,
  callerId: string,
  callerAppRole: string,
): Promise<CallerBrand> {
  if (callerAppRole === "super_admin") return { ok: true, brandId: null };
  if (callerAppRole !== "admin" && callerAppRole !== "master") {
    // Belt-and-suspenders: requireAdminCaller already rejected other roles.
    return { ok: false, status: 403, error: "forbidden" };
  }
  const { data, error } = await serviceClient
    .from("profiles")
    .select("brand_id")
    .eq("id", callerId)
    .maybeSingle();
  if (error) {
    console.error("[manage-store-user] caller brand read failed", error.code);
    return { ok: false, status: 500, error: "internal error" };
  }
  if (!data) return { ok: false, status: 403, error: "forbidden: caller profile not found" };
  if (!data.brand_id) return { ok: false, status: 403, error: "forbidden: caller has no brand scope" };
  return { ok: true, brandId: data.brand_id as string };
}

// ── Password rule (spec 165 §4.1) ─────────────────────────────────────────

function checkPassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    return "password must be at least 8 characters";
  }
  return null;
}

type AuthErrorLike = { code?: string; status?: number; message?: string } | null | undefined;

// GoTrue weak-password class: weak_password / validation_failed / HTTP 422
// (covers the 72-byte bcrypt cap and any prod password_requirements).
// `email_exists` / `user_already_exists` (also 422) are placeholder
// collisions → 500 per §3.1, never the weak-password class.
function isWeakPasswordError(err: AuthErrorLike): boolean {
  if (!err) return false;
  if (err.code === "email_exists" || err.code === "user_already_exists") return false;
  return err.code === "weak_password" || err.code === "validation_failed" || err.status === 422;
}

// GoTrue messages describe the rule and never echo the value; belt-and-braces
// scrub in case one ever quotes the generated placeholder address.
function safeAuthMessage(err: AuthErrorLike, placeholder: string | null, fallback: string): string {
  const msg = typeof err?.message === "string" && err.message.length > 0 ? err.message : fallback;
  if (placeholder && msg.toLowerCase().includes(placeholder.toLowerCase())) return fallback;
  if (msg.toLowerCase().includes("no-email.invalid")) return fallback;
  return msg;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function generatePlaceholderEmail(): string {
  return "u-" + crypto.randomUUID().replaceAll("-", "") + "@no-email.invalid";
}

// Mirrors register_invited_profile (20261007000000_profiles_insert_hardening.sql):
// split on single spaces, first character of each part (empty parts add
// nothing), join, first 2, uppercase.
function deriveInitials(name: string): string {
  const firsts = name
    .split(" ")
    .map((w) => Array.from(w)[0] ?? "")
    .join("");
  return Array.from(firsts).slice(0, 2).join("").toUpperCase();
}

// Compensation (spec 165 §4.4). One auth.admin.deleteUser cascades
// auth.users → profiles → user_stores. Retry once; if both fail, remove the
// public rows directly so the username is released and no half-row shows in
// the Users list, then log the orphan id (id only).
async function compensate(serviceClient: SupabaseClient, newId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await serviceClient.auth.admin.deleteUser(newId);
      if (!error) return;
    } catch (_e) {
      // fall through to retry / manual cleanup
    }
  }
  try {
    await serviceClient.from("user_stores").delete().eq("user_id", newId);
    await serviceClient.from("profiles").delete().eq("id", newId);
  } catch (_e) {
    // best effort
  }
  console.error("[manage-store-user] compensation incomplete; orphan auth user", newId);
}

// ── action: create (spec 165 §4.2) ────────────────────────────────────────

async function handleCreate(
  body: Record<string, unknown>,
  gate: { userId: string; appRole: string },
): Promise<Response> {
  // Allowlisted fields only. role / brand_id / email / id are never read.
  const rawName = body.name;
  const rawUsername = body.username;
  const password = body.password;
  const rawStoreIds = body.storeIds;

  // 1. name
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) return json(400, { error: "name is required" });
  if (name.length > NAME_MAX_LENGTH) return json(400, { error: "name must be at most 100 characters" });

  // 2. username
  const username = typeof rawUsername === "string" ? rawUsername.trim().toLowerCase() : "";
  if (!USERNAME_RE.test(username)) {
    return json(400, { error: "username must be 3-20 characters: a-z, 0-9, _ or ." });
  }
  if (RESERVED_USERNAMES.has(username)) return json(400, { error: "username is reserved" });

  // 3. password (verbatim, no trim)
  const pwErr = checkPassword(password);
  if (pwErr) return json(400, { error: pwErr });
  const pw = password as string;

  // 4. storeIds
  const ids = Array.from(
    new Set(
      (Array.isArray(rawStoreIds) ? rawStoreIds : [])
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0),
    ),
  );
  if (ids.length === 0) return json(400, { error: "at least one store is required" });
  if (ids.length > MAX_STORE_IDS || ids.some((v) => !UUID_RE.test(v))) {
    return json(400, { error: "unknown store" });
  }

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 5. parallel reads (no side effects)
  const likePattern = username.replace(/([\\%_])/g, "\\$1");
  const [storesRes, callerBrand, takenRes] = await Promise.all([
    service.from("stores").select("id, brand_id").in("id", ids),
    readCallerBrand(service, gate.userId, gate.appRole),
    service.from("profiles").select("id").ilike("username", likePattern).limit(1).maybeSingle(),
  ]);

  if (!callerBrand.ok) return json(callerBrand.status, { error: callerBrand.error });
  if (storesRes.error) {
    console.error("[manage-store-user] stores read failed", storesRes.error.code);
    return json(500, { error: "could not create account" });
  }
  if (takenRes.error) {
    console.error("[manage-store-user] username pre-check failed", takenRes.error.code);
    return json(500, { error: "could not create account" });
  }

  const storeRows = (storesRes.data ?? []) as { id: string; brand_id: string | null }[];
  if (storeRows.length < ids.length) return json(400, { error: "unknown store" });
  const brands = new Set(storeRows.map((r) => r.brand_id));
  if (brands.size !== 1 || brands.has(null)) {
    return json(400, { error: "stores must belong to one brand" });
  }
  const derivedBrand = storeRows[0].brand_id as string;
  if (callerBrand.brandId !== null && callerBrand.brandId !== derivedBrand) {
    return json(403, { error: "forbidden: target is in a different brand" });
  }
  if (takenRes.data) return json(409, { error: "username taken" });

  // 6. placeholder + profile cosmetics
  const placeholder = generatePlaceholderEmail();
  if (!isPlaceholderEmail(placeholder)) return json(500, { error: "could not create account" });
  const initials = deriveInitials(name);
  const color = "#378ADD";

  // 7. side effect 1 — auth user (createUser sends no email)
  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email: placeholder,
    password: pw,
    email_confirm: true,
    user_metadata: { name },
  });
  if (createErr || !created?.user?.id) {
    if (isWeakPasswordError(createErr)) {
      return json(400, { error: safeAuthMessage(createErr, placeholder, "could not create account") });
    }
    console.error("[manage-store-user] createUser failed", createErr?.code, createErr?.status);
    return json(500, { error: "could not create account" });
  }
  const newId = created.user.id;

  // Steps 8-9 run inside a try so a THROWN exception (not only a returned
  // `error`) still compensates (spec 165 §4.4 "no partial state"). The
  // returned-error branches are unchanged; compensateOnce() guarantees the
  // rollback runs at most once per request even if a branch throws after
  // compensating.
  let compensated = false;
  const compensateOnce = async (): Promise<void> => {
    if (compensated) return;
    compensated = true;
    await compensate(service, newId);
  };
  try {
    // 8. side effect 2 — profile (role is a literal, never from the request)
    const { error: profileErr } = await service.from("profiles").insert({
      id: newId,
      name,
      role: "user",
      brand_id: derivedBrand,
      username,
      status: "active",
      color,
      initials,
    });
    if (profileErr) {
      await compensateOnce();
      const detail = `${profileErr.message ?? ""} ${profileErr.details ?? ""}`;
      if (profileErr.code === "23505" && detail.includes("profiles_username_lower_key")) {
        return json(409, { error: "username taken" });
      }
      console.error("[manage-store-user] profile insert failed", profileErr.code);
      return json(500, { error: "could not create account" });
    }

    // 9. side effect 3 — user_stores, ONE bulk statement (all or nothing)
    const { error: usErr } = await service
      .from("user_stores")
      .insert(ids.map((store_id) => ({ user_id: newId, store_id })));
    if (usErr) {
      await compensateOnce();
      if ((usErr.message ?? "").includes("cross-brand user_stores assignment rejected")) {
        return json(400, { error: "stores must belong to one brand" });
      }
      if (usErr.code === "23503") return json(400, { error: "unknown store" });
      console.error("[manage-store-user] user_stores insert failed", usErr.code);
      return json(500, { error: "could not create account" });
    }
  } catch (e) {
    await compensateOnce();
    // Log hygiene (§4.5): error class name only — never the message/body.
    console.error("[manage-store-user] create side effect threw", e instanceof Error ? e.name : typeof e);
    return json(500, { error: "could not create account" });
  }

  // 10. no email, no password, no brand in the response
  return json(201, { id: newId, username });
}

// ── action: set_password (spec 165 §4.3) ──────────────────────────────────

async function handleSetPassword(
  body: Record<string, unknown>,
  gate: { userId: string; appRole: string },
): Promise<Response> {
  const rawUserId = body.userId;
  const password = body.password;

  // 1. userId (lowercased so the self-guard cannot be bypassed by case —
  //    Postgres uuid comparison is case-insensitive, JS string === is not)
  const userId = typeof rawUserId === "string" ? rawUserId.trim().toLowerCase() : "";
  if (!UUID_RE.test(userId)) return json(400, { error: "userId required" });

  // 2. self-guard — before any read or write
  if (userId === gate.userId.toLowerCase()) {
    return json(400, { error: "cannot set password for self" });
  }

  // 3. password
  const pwErr = checkPassword(password);
  if (pwErr) return json(400, { error: pwErr });
  const pw = password as string;

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 4. target + caller brand reads (no side effects)
  const [callerBrand, targetRes] = await Promise.all([
    readCallerBrand(service, gate.userId, gate.appRole),
    service.from("profiles").select("brand_id, role").eq("id", userId).maybeSingle(),
  ]);
  if (!callerBrand.ok) return json(callerBrand.status, { error: callerBrand.error });
  if (targetRes.error) {
    console.error("[manage-store-user] target read failed", targetRes.error.code);
    return json(500, { error: "could not update password" });
  }
  const target = targetRes.data as { brand_id: string | null; role: string } | null;
  // Deliberate difference from requireSameBrandOrSuperAdmin: a missing
  // target profile is REFUSED, not allowed through.
  if (!target) return json(403, { error: "forbidden: target is not a store user" });
  if (callerBrand.brandId !== null && target.brand_id !== callerBrand.brandId) {
    return json(403, { error: "forbidden: target is in a different brand" });
  }
  if (target.role !== "user") return json(403, { error: "forbidden: target is not a store user" });

  // 5. placeholder-account only — real-email accounts keep the email reset
  const { data: authUser, error: getErr } = await service.auth.admin.getUserById(userId);
  if (getErr || !authUser?.user) {
    console.error("[manage-store-user] getUserById failed", getErr?.code, getErr?.status);
    return json(500, { error: "could not update password" });
  }
  // Defense in depth (security L3): the JWT role must not disagree with the
  // profile. A set app_metadata.role other than 'user' is refused with the
  // same non-user-target error as step 4.
  const jwtRole: unknown = authUser.user.app_metadata?.role;
  if (jwtRole !== undefined && jwtRole !== null && jwtRole !== "user") {
    return json(403, { error: "forbidden: target is not a store user" });
  }
  if (!isPlaceholderEmail(authUser.user.email)) {
    return json(400, { error: "account has an email; use password reset" });
  }

  // 6. side effect — GoTrue's admin password update also logs out every
  //    session of the user (refresh tokens revoked); proven by smoke S-REV.
  const { error: updErr } = await service.auth.admin.updateUserById(userId, { password: pw });
  if (updErr) {
    if (isWeakPasswordError(updErr)) {
      return json(400, { error: safeAuthMessage(updErr, authUser.user.email ?? null, "could not update password") });
    }
    console.error("[manage-store-user] updateUserById failed", updErr.code, updErr.status);
    return json(500, { error: "could not update password" });
  }

  return json(200, { success: true });
}

// ── entry ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  try {
    const gate = await requireAdminCaller(req.headers.get("Authorization"));
    if (gate.status !== 200) return json(gate.status, { error: gate.error });

    let body: unknown;
    try {
      body = await req.json();
    } catch (_e) {
      return json(400, { error: "invalid JSON" });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(400, { error: "invalid JSON" });
    }
    const b = body as Record<string, unknown>;

    if (b.action === "create") return await handleCreate(b, gate);
    if (b.action === "set_password") return await handleSetPassword(b, gate);
    return json(400, { error: "unknown action" });
  } catch (_e) {
    // Never return e.message — a thrown parse error could quote body fragments.
    return json(500, { error: "internal error" });
  }
});
