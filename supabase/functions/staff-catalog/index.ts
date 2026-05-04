// Phase 13b — staff-app catalog ship-out.
// GET /staff-catalog?store_id={uuid}&since={iso8601?}
//
// Returns the canonical catalog snapshot (ingredients + vendors + categories
// + recipes) for a single store. The staff app's offline cache pulls this
// on first run and on a timer; passing `since` returns only rows whose
// updated_at > since (delta sync).
//
// Auth: Bearer STAFF_SERVICE_TOKEN. The staff app's *backend* signs each
// call; admin trusts the backend's identity assertion (in this endpoint
// the assertion is just "give me catalog for store X" — no per-user
// claims needed for reads).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STAFF_SERVICE_TOKEN = Deno.env.get("STAFF_SERVICE_TOKEN") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Validate Bearer STAFF_SERVICE_TOKEN. Returns null on success, Response on
// auth failure.
function checkAuth(req: Request): Response | null {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!STAFF_SERVICE_TOKEN) {
    return new Response(JSON.stringify({ error: "STAFF_SERVICE_TOKEN unset on server" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (token !== STAFF_SERVICE_TOKEN) {
    return new Response(JSON.stringify({ error: "invalid service token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authFail = checkAuth(req);
  if (authFail) return authFail;

  const url = new URL(req.url);
  const storeId = url.searchParams.get("store_id");
  const since = url.searchParams.get("since"); // ISO8601 — optional

  if (!storeId) {
    return new Response(JSON.stringify({ error: "store_id query param required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve store
  const { data: store, error: storeErr } = await admin
    .from("stores")
    .select("id, name")
    .eq("id", storeId)
    .maybeSingle();
  if (storeErr) {
    return new Response(JSON.stringify({ error: "stores lookup failed", detail: storeErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!store) {
    return new Response(JSON.stringify({ error: "store not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Build queries with optional `since` filter
  let ingQuery = admin
    .from("inventory_items")
    .select(
      "id, store_id, name, category, unit, par_level, current_stock, cost_per_unit, vendor_id, case_qty, case_price, sub_unit_size, sub_unit_unit, updated_at",
    )
    .eq("store_id", storeId);
  if (since) ingQuery = ingQuery.gt("updated_at", since);

  // Vendors aren't store-scoped in this schema, so ship the lot. Filter by
  // updated_at if since is set so deltas stay small.
  let vendorQuery = admin.from("vendors").select("id, name, lead_time_days, order_cutoff_time, delivery_days");
  // vendors table doesn't have updated_at in this schema — skip since for vendors

  const [ingRes, venRes, catRes, recRes] = await Promise.all([
    ingQuery.order("name"),
    vendorQuery.order("name"),
    admin.from("ingredient_categories").select("name").order("name"),
    // Menu recipes (for portion lookups when staff counts a recipe). Embed
    // recipe_ingredients (with normalized base_quantity/base_unit) and
    // recipe_prep_items so portion math has everything it needs in one call.
    admin
      .from("recipes")
      .select(
        "id, store_id, menu_item, category, sell_price, " +
          "recipe_ingredients(item_id, quantity, unit, base_quantity, base_unit), " +
          "recipe_prep_items(prep_recipe_id, quantity, unit)",
      )
      .eq("store_id", storeId),
  ]);

  if (ingRes.error || venRes.error || catRes.error || recRes.error) {
    return new Response(
      JSON.stringify({
        error: "catalog fetch failed",
        detail: ingRes.error?.message || venRes.error?.message || catRes.error?.message || recRes.error?.message,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ETag: max(updated_at) across the ingredient set in this response.
  // Staff app passes this back as `since` next time. Vendors/categories
  // don't have updated_at, so we don't track them in the etag — staff app
  // can refetch the lot every N hours separately if needed.
  let etag: string | null = null;
  for (const row of ingRes.data || []) {
    const ts = row.updated_at as string | null;
    if (ts && (!etag || ts > etag)) etag = ts;
  }

  const body = {
    etag,
    store: { id: store.id, name: store.name },
    ingredients: (ingRes.data || []).map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      unit: r.unit,
      par_level: r.par_level,
      current_stock: r.current_stock,
      cost_per_unit: r.cost_per_unit,
      vendor_id: r.vendor_id,
      case_qty: r.case_qty,
      case_price: r.case_price,
      sub_unit_size: r.sub_unit_size,
      sub_unit_unit: r.sub_unit_unit,
      updated_at: r.updated_at,
    })),
    vendors: (venRes.data || []).map((v) => ({
      id: v.id,
      name: v.name,
      lead_time_days: v.lead_time_days,
      order_cutoff_time: v.order_cutoff_time,
      delivery_days: v.delivery_days,
    })),
    categories: (catRes.data || []).map((c) => c.name),
    recipes: (recRes.data || []).map((r: any) => ({
      id: r.id,
      menu_item: r.menu_item,
      category: r.category,
      sell_price: r.sell_price,
      ingredients: (r.recipe_ingredients || []).map((ing: any) => ({
        item_id: ing.item_id,
        quantity: ing.quantity,
        unit: ing.unit,
        base_quantity: ing.base_quantity,
        base_unit: ing.base_unit,
      })),
      prep_items: (r.recipe_prep_items || []).map((p: any) => ({
        prep_recipe_id: p.prep_recipe_id,
        quantity: p.quantity,
        unit: p.unit,
      })),
    })),
    // Hint: when the staff app sees this, they should pass it back as
    // `since` next call. If null, no ingredients matched (delta was empty)
    // — staff app keeps its previous etag.
    is_delta: !!since,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...(etag ? { ETag: `"${etag}"` } : {}),
      "Cache-Control": "private, max-age=60",
    },
  });
});
