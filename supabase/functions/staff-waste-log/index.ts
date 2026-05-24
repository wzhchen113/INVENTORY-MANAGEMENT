// Spec 061 — staff-waste-log deprecation.
//
// As of spec 061, the staff app talks to Supabase directly via per-user
// JWT. Waste-log is OUT OF SCOPE for the v1 staff app (only EOD count
// ships), so this Edge Function is permanently retired without a
// per-user-JWT replacement. A future spec may re-enable waste-log for
// staff by re-GRANTing public.staff_log_waste() to authenticated (the
// sibling RPC at 20260504000002_staff_log_waste_rpc.sql is still
// service_role-only as of spec 061).
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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({
      error: "staff-waste-log: deprecated as of spec 061 — staff app now talks to Supabase directly via per-user JWT",
      reference: "specs/061-staff-app-eod-count.md",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
