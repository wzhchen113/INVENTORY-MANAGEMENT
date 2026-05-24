// Spec 061 — staff-catalog deprecation.
//
// As of spec 061, the staff app talks to Supabase directly via per-user
// JWT and reads inventory_items / vendors / recipes through PostgREST
// gated by the existing RLS policies. This Edge Function — which routed
// reads through a shared STAFF_SERVICE_TOKEN bypassing per-user RLS —
// is permanently retired.
//
// All routes (including OPTIONS preflight) return HTTP 410 with a
// descriptive JSON body pointing at the spec. The function stays
// deployed (verify_jwt = false retained in supabase/config.toml) so any
// stale caller fails LOUD with an actionable error rather than 404'ing
// or hitting a CORS-preflight-401 ambiguity.
//
// CORS headers are preserved identical to the v1 body so a hypothetical
// browser caller's preflight doesn't fail at the CORS layer (which
// would mask the 410 with a confusing console error).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({
      error: "staff-catalog: deprecated as of spec 061 — staff app now talks to Supabase directly via per-user JWT",
      reference: "specs/061-staff-app-eod-count.md",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
