// username-resolve — spec 095. Resolves a username → email so the shared login
// portal can sign in a user who typed a username instead of an email. Supabase
// has no native username auth, and the anon/client role cannot read auth.users,
// so this runs service-role behind a service-token bearer (same model as
// pwa-catalog / staff-*).
//
//   POST /functions/v1/username-resolve
//   Authorization: Bearer ${USERNAME_RESOLVE_SERVICE_TOKEN}
//   body: { "username": string }
//
// ANTI-ORACLE CONTRACT (spec §API contract, flagged for security-auditor):
//   The function ALWAYS returns HTTP 200 { "email": string | null } for any
//   well-formed request — `null` for "no such username", "username maps to a
//   user with no resolvable email", a malformed/empty username, OR any internal
//   lookup failure (fail-closed to the generic login error, NOT 500, so a
//   transient DB blip is indistinguishable from not-found and never becomes an
//   oracle). The HTTP status NEVER reveals existence. The only non-200 paths are
//   401 (bad/missing service token) and 500 (the service token secret is unset
//   on the server — mirrors pwa-catalog). The caller then attempts
//   signInWithPassword and collapses every failure into one generic string.
//
// JSON only — no HTML output, so no escapeHtml helper is needed. No
// requireAdminCaller / ADMIN_ROLES gate — this is a pre-auth, service-token
// endpoint, not a role-gated one. Uses USERNAME_RESOLVE_SERVICE_TOKEN, a NEW
// secret distinct from PWA_SERVICE_TOKEN (different blast radius).
//
// RATE LIMIT (spec 095 review fix — security Medium-1): the client token ships
// in the public bundle, so the token gate is anti-casual-anon, not a real
// secret. To keep a token-extractor from scripting username→email harvesting,
// every request is metered per-IP through the DB-backed fixed-window limiter
// (check_username_resolve_rate_limit RPC — 20 req/min/IP). Over budget → a
// generic HTTP 429. 429 is a PER-IP signal ("calling too often"), not a
// per-username one, so it does NOT reopen the enumeration oracle: the non-429
// success path stays ALWAYS 200 { email: string | null }. In-memory counters
// can't enforce a real budget across stateless isolates — hence the shared DB
// counter (see the migration header for the full rationale).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const USERNAME_RESOLVE_SERVICE_TOKEN = Deno.env.get("USERNAME_RESOLVE_SERVICE_TOKEN") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

// Best-effort client IP for the per-IP rate limiter. Behind the Supabase edge
// gateway the real client IP is the FIRST entry of x-forwarded-for; fall back to
// x-real-ip, then to an empty string (the RPC collapses blank/unknown into a
// single shared 'unknown' bucket so it fails toward throttling, not toward an
// unmetered hole).
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return (req.headers.get("x-real-ip") || "").trim();
}

function checkAuth(req: Request): Response | null {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!USERNAME_RESOLVE_SERVICE_TOKEN) {
    return jsonResponse(500, { error: "USERNAME_RESOLVE_SERVICE_TOKEN unset on server" });
  }
  if (token !== USERNAME_RESOLVE_SERVICE_TOKEN) {
    return jsonResponse(401, { error: "invalid service token" });
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed" });
  }

  const authFail = checkAuth(req);
  if (authFail) return authFail;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Per-IP rate limit (spec 095 review fix). Over budget → generic 429. This is
  // a per-IP signal, NOT a per-username one, so it does not leak existence. A
  // limiter FAILURE (RPC error) fails OPEN — we never let an infra blip block
  // legitimate logins — but the success path below still honors a clean DENY.
  try {
    const { data: allowed, error: rlErr } = await admin.rpc(
      "check_username_resolve_rate_limit",
      { p_ip: clientIp(req) },
    );
    if (!rlErr && allowed === false) {
      return jsonResponse(429, { error: "rate limited" });
    }
  } catch (_e) {
    // Fail open on a limiter error — do not turn a transient DB blip into a
    // login outage.
  }

  // From here on, ALWAYS 200 { email: ... }. A malformed body, an unknown
  // username, or any internal failure all resolve to { email: null } — the
  // status never distinguishes them (anti-oracle).
  let username = "";
  try {
    const body = await req.json();
    if (body && typeof body.username === "string") {
      username = body.username.trim();
    }
  } catch (_e) {
    return jsonResponse(200, { email: null });
  }

  if (!username) {
    return jsonResponse(200, { email: null });
  }

  try {
    // Case-insensitive EXACT match mirroring the lower(username) UNIQUE index.
    // `ilike` treats its argument as a LIKE pattern, so `%`, `_`, and `\` in the
    // input must be escaped to prevent wildcard matching (e.g. an underscore is
    // a valid username char that would otherwise act as a single-char wildcard
    // and match the wrong row). After escaping, the pattern is an exact
    // case-insensitive comparison.
    const likePattern = username.replace(/([\\%_])/g, "\\$1");
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("id")
      .ilike("username", likePattern)
      .limit(1)
      .maybeSingle();

    if (profileErr || !profile) {
      return jsonResponse(200, { email: null });
    }

    const { data: userData, error: userErr } = await admin.auth.admin.getUserById(profile.id as string);
    if (userErr || !userData?.user?.email) {
      return jsonResponse(200, { email: null });
    }

    return jsonResponse(200, { email: userData.user.email });
  } catch (_e) {
    // Fail-closed: any unexpected error is indistinguishable from not-found.
    return jsonResponse(200, { email: null });
  }
});
