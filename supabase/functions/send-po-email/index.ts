import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Spec 107 (OQ-1) — send a purchase order to its vendor as an escaped HTML
// table via Resend, then flip status draft → 'sent' SERVER-SIDE on a Resend 2xx.
// ALWAYS confirm-gated on the client (src/utils/confirmAction) and NEVER
// auto-sent: this function only ever runs from the confirmed "Send to vendor"
// button. Modeled byte-for-structure on send-invite-email/index.ts.
//
// verify_jwt = default (true) — this is an admin-triggered action carrying the
// caller's JWT, the OPPOSITE of the staff-*/pwa-catalog service-token functions.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Mirror of `public.auth_is_privileged()` on the edge-function side. Sending a
// PO to a vendor is a privileged, outbound, side-effecting action → role-gated.
// Must include `super_admin` so role-broadened RLS callers (spec 026 Track A)
// don't get 403'd at the edge layer. Reference shape:
// supabase/functions/send-invite-email/index.ts:20 / delete-user/index.ts:19.
const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);

async function requireAdminCaller(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) return { error: "missing bearer token", status: 401 };
  const token = authHeader.slice(7);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userRes, error: userErr } = await client.auth.getUser();
  if (userErr || !userRes?.user) return { error: "invalid token", status: 401 };
  const appRole = (userRes.user.app_metadata as any)?.role;
  if (ADMIN_ROLES.has(appRole)) return { status: 200, client };
  const { data: profile } = await client.from("profiles").select("role").eq("id", userRes.user.id).single();
  if (!profile || !ADMIN_ROLES.has(profile.role)) return { error: "forbidden", status: 403 };
  return { status: 200, client };
}

// Spec 028: HTML-escape EVERY interpolated value into the email body template
// literal below (caller/catalog-controlled item names are the highest-risk
// injection surface). Inlined per spec 028 §3 (not shared via _shared/) because
// `supabase functions deploy <name>` ships one function at a time and a shared
// module is invisible drift surface. Byte-identical mirror at
// src/utils/escapeHtml.ts.
function escapeHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function money(n: unknown): string {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : "0.00";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // (1) ROLE GATE — privileged callers only (mirrors auth_is_privileged()).
  const gate = await requireAdminCaller(req.headers.get("Authorization"));
  if (gate.status !== 200 || !gate.client) {
    return new Response(JSON.stringify({ error: gate.error }), {
      status: gate.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const callerClient = gate.client;

  try {
    const { poId } = await req.json();
    if (!poId) {
      return new Response(JSON.stringify({ error: "poId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // (2) AUTHORITATIVE READ — re-read the PO + vendor + lines SERVER-SIDE via
    // the service-role client (never trust a client-supplied HTML body or line
    // set). Item name/unit live on catalog_ingredients post-P3, reached through
    // inventory_items.catalog_id.
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: po, error: poErr } = await admin
      .from("purchase_orders")
      .select("id, store_id, status, total_cost, reference_date, vendor_id, vendors(name, email)")
      .eq("id", poId)
      .single();

    if (poErr || !po) {
      return new Response(JSON.stringify({ error: "purchase order not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // (3) STORE VISIBILITY — belt-and-suspenders. The admin gate already implies
    // cross-store visibility (ADMIN_ROLES ⊆ privileged, privileged sees all
    // stores), but re-check auth_can_see_store via the CALLER-scoped client so a
    // scoped-but-admin-roled edge can't send another store's PO. Matches the RPC
    // gates.
    const { data: canSee, error: seeErr } = await callerClient.rpc("auth_can_see_store", {
      p_store_id: (po as any).store_id,
    });
    if (seeErr || canSee !== true) {
      return new Response(JSON.stringify({ error: "not authorized for this store" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const vendor = (po as any).vendors;
    const vendorEmail: string | null = vendor?.email ?? null;
    if (!vendorEmail) {
      // Phone/text vendors: the client should offer "mark as sent manually"
      // instead of calling this function. Refuse the email path explicitly.
      return new Response(JSON.stringify({ error: "vendor has no email; use mark-as-sent-manually" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: lines, error: linesErr } = await admin
      .from("po_items")
      .select("id, ordered_qty, cost_per_unit, inventory_items(catalog_id, catalog_ingredients(name, unit))")
      .eq("po_id", poId);

    if (linesErr) {
      return new Response(JSON.stringify({ error: linesErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // (4) RENDER the PO table — EVERY interpolated value escaped.
    const vendorName = escapeHtml(vendor?.name ?? "Vendor");
    const refDate = escapeHtml((po as any).reference_date ?? "");
    let grandTotal = 0;
    const rowsHtml = (lines ?? [])
      .map((ln: any) => {
        const ci = ln.inventory_items?.catalog_ingredients;
        const itemName = escapeHtml(ci?.name ?? "Item");
        const unit = escapeHtml(ci?.unit ?? "");
        const qty = Number(ln.ordered_qty) || 0;
        const unitCost = Number(ln.cost_per_unit) || 0;
        const lineTotal = qty * unitCost;
        grandTotal += lineTotal;
        return `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #EEEDE8">${itemName}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #EEEDE8;text-align:right">${escapeHtml(String(qty))} ${unit}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #EEEDE8;text-align:right">$${escapeHtml(money(unitCost))}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #EEEDE8;text-align:right">$${escapeHtml(money(lineTotal))}</td>
        </tr>`;
      })
      .join("");

    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:40px 20px"><div style="background:#1A1A18;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px"><h1 style="color:#FFF;font-size:28px;margin:0;letter-spacing:1px">I.M.R</h1><p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:14px">Purchase Order</p></div><h2 style="color:#1A1A18;font-size:20px">Order for ${vendorName}</h2>${refDate ? `<p style="color:#6B6A65;font-size:14px">Reference date: <strong>${refDate}</strong></p>` : ""}<table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px"><thead><tr><th style="padding:8px 12px;text-align:left;border-bottom:2px solid #1A1A18">Item</th><th style="padding:8px 12px;text-align:right;border-bottom:2px solid #1A1A18">Qty</th><th style="padding:8px 12px;text-align:right;border-bottom:2px solid #1A1A18">Unit</th><th style="padding:8px 12px;text-align:right;border-bottom:2px solid #1A1A18">Total</th></tr></thead><tbody>${rowsHtml}</tbody><tfoot><tr><td colspan="3" style="padding:12px;text-align:right;font-weight:600">Total</td><td style="padding:12px;text-align:right;font-weight:700">$${escapeHtml(money(grandTotal))}</td></tr></tfoot></table><p style="color:#9B9A95;font-size:12px;text-align:center">Sent via I.M.R — Inventory Management for Restaurant</p></div>`;

    // (5) SEND via Resend. If no key is configured (local/dev), fail loudly —
    // there is no silent success path (spec 031). The status flip happens ONLY
    // on a Resend 2xx below, binding the send and the flip so they cannot
    // diverge (a lost client response can't leave a sent-but-still-draft PO).
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: "email channel not configured (RESEND_API_KEY unset)" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "I.M.R Inventory <onboarding@resend.dev>",
        to: [vendorEmail],
        subject: `Purchase Order — ${vendor?.name ?? "Vendor"}`,
        html,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return new Response(JSON.stringify({ error: `resend send failed (HTTP ${res.status})`, detail }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // (6) STATUS FLIP — SERVER-SIDE, only on a Resend 2xx. draft → 'sent'. Only
    // flip when the PO is currently 'draft' (idempotent: re-sending an already
    // 'sent' PO leaves it 'sent'; never regress a partial/received PO).
    if ((po as any).status === "draft") {
      const { error: flipErr } = await admin
        .from("purchase_orders")
        .update({ status: "sent" })
        .eq("id", poId)
        .eq("status", "draft");
      if (flipErr) {
        // The email WAS sent; surface the flip failure so the operator can
        // mark-as-sent-manually rather than assume a clean send.
        return new Response(JSON.stringify({ success: true, method: "resend", status: "draft", warning: "email sent but status flip failed" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ success: true, method: "resend", status: "sent" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
