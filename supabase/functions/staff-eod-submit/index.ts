// Phase 13c — staff-app EOD submission ship-in.
// POST /staff-eod-submit
//
// Body:
//   {
//     "client_uuid":   "uuid",         // staff app generates per attempt
//     "store_id":      "uuid",
//     "date":          "YYYY-MM-DD",
//     "submitted_by":  "staff:user-id", // identity claim (string)
//     "submitted_at":  "ISO8601?",
//     "status":        "submitted" | "draft",
//     "entries": [
//       { "ingredient_id": "uuid", "actual_remaining": number, "unit": "string", "notes": "string?" }
//     ]
//   }
//
// 200 OK: { submission_id, entry_ids[], stock_updates[] }
// 409 Conflict: { submission_id, conflict: true } — same client_uuid retried
// 4xx for validation errors, 5xx for DB issues.
//
// All writes happen inside the staff_submit_eod() Postgres function so
// they commit or roll back atomically.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STAFF_SERVICE_TOKEN = Deno.env.get("STAFF_SERVICE_TOKEN") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });

function checkAuth(req: Request): Response | null {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!STAFF_SERVICE_TOKEN) return json({ error: "STAFF_SERVICE_TOKEN unset on server" }, 500);
  if (token !== STAFF_SERVICE_TOKEN) return json({ error: "invalid service token" }, 401);
  return null;
}

interface Entry {
  ingredient_id: string;
  actual_remaining: number;
  unit?: string;
  notes?: string;
}

interface Body {
  client_uuid?: string;
  store_id?: string;
  date?: string;
  submitted_by?: string;
  submitted_at?: string;
  status?: "submitted" | "draft";
  entries?: Entry[];
}

function validate(b: Body): string | null {
  if (!b.store_id) return "store_id required";
  if (!b.date) return "date required (YYYY-MM-DD)";
  if (!b.submitted_by) return "submitted_by required";
  if (b.status && b.status !== "submitted" && b.status !== "draft") return "status must be 'submitted' or 'draft'";
  if (!Array.isArray(b.entries) || b.entries.length === 0) return "entries[] required (>= 1 row)";
  for (let i = 0; i < b.entries.length; i++) {
    const e = b.entries[i];
    if (!e.ingredient_id) return `entries[${i}].ingredient_id required`;
    if (typeof e.actual_remaining !== "number" || !Number.isFinite(e.actual_remaining)) {
      return `entries[${i}].actual_remaining must be a finite number`;
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authFail = checkAuth(req);
  if (authFail) return authFail;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const validationErr = validate(body);
  if (validationErr) return json({ error: validationErr }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Verify the store exists. Catches typos before the RPC runs.
  const { data: store } = await admin.from("stores").select("id").eq("id", body.store_id!).maybeSingle();
  if (!store) return json({ error: "store not found" }, 404);

  // Call the transactional RPC.
  const { data, error } = await admin.rpc("staff_submit_eod", {
    p_client_uuid: body.client_uuid || null,
    p_store_id: body.store_id,
    p_date: body.date,
    p_submitted_by: body.submitted_by,
    p_status: body.status || "submitted",
    p_entries: body.entries,
  });

  if (error) {
    console.error("[staff-eod-submit] rpc error:", error);
    return json({ error: "rpc failed", detail: error.message }, 500);
  }

  // RPC returns the conflict marker when client_uuid was previously seen.
  // Surface as 409 so the staff app's retry logic treats it cleanly.
  if (data?.conflict) {
    return json(
      {
        submission_id: data.submission_id,
        conflict: true,
        reason: data.reason,
      },
      409,
    );
  }

  return json({
    submission_id: data.submission_id,
    entry_ids: data.entry_ids || [],
    stock_updates: data.stock_updates || [],
  });
});
