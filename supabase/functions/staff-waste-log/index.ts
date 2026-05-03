// Phase 13d — staff-app waste-log ship-in.
// POST /staff-waste-log
//
// Body:
//   {
//     "client_uuid":   "uuid",
//     "store_id":      "uuid",
//     "ingredient_id": "uuid",
//     "quantity":      number,
//     "unit":          "string?",
//     "reason":        "expired" | "dropped" | "overproduction" | "quality" | "other",
//     "notes":         "string?",
//     "submitted_by":  "staff:user-id"
//   }
//
// 200 OK: { waste_id, stock_after }
// 409 Conflict: { waste_id, conflict: true } — client_uuid was already processed
// 400 / 404 / 500 — validation / lookup / DB
//
// All writes happen inside staff_log_waste() Postgres function — atomic.

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function checkAuth(req: Request): Response | null {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!STAFF_SERVICE_TOKEN) return json({ error: "STAFF_SERVICE_TOKEN unset on server" }, 500);
  if (token !== STAFF_SERVICE_TOKEN) return json({ error: "invalid service token" }, 401);
  return null;
}

const VALID_REASONS = new Set(["expired", "dropped", "overproduction", "quality", "other"]);

interface Body {
  client_uuid?: string;
  store_id?: string;
  ingredient_id?: string;
  quantity?: number;
  unit?: string;
  reason?: string;
  notes?: string;
  submitted_by?: string;
}

function validate(b: Body): string | null {
  if (!b.store_id) return "store_id required";
  if (!b.ingredient_id) return "ingredient_id required";
  if (typeof b.quantity !== "number" || !Number.isFinite(b.quantity) || b.quantity <= 0) {
    return "quantity must be a positive number";
  }
  if (!b.reason || !VALID_REASONS.has(b.reason)) {
    return `reason must be one of: ${Array.from(VALID_REASONS).join(", ")}`;
  }
  if (!b.submitted_by) return "submitted_by required";
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

  const { data, error } = await admin.rpc("staff_log_waste", {
    p_client_uuid: body.client_uuid || null,
    p_store_id: body.store_id,
    p_ingredient_id: body.ingredient_id,
    p_quantity: body.quantity,
    p_unit: body.unit || null,
    p_reason: body.reason,
    p_notes: body.notes || null,
    p_submitted_by: body.submitted_by,
  });

  if (error) {
    // Postgres P0002 (no_data_found) → ingredient not at store
    if ((error as any).code === "P0002") {
      return json({ error: "ingredient not found at store" }, 404);
    }
    console.error("[staff-waste-log] rpc error:", error);
    return json({ error: "rpc failed", detail: error.message }, 500);
  }

  if (data?.conflict) {
    return json({ waste_id: data.waste_id, conflict: true, reason: data.reason }, 409);
  }

  return json({ waste_id: data.waste_id, stock_after: data.stock_after });
});
