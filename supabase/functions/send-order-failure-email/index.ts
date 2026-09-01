import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Spec 162 (AC-8) — email the store's admins + a fixed ops mailbox when the
// cart-filler extension's auto-place attempt FAILED to put the order through on
// bjs.com.
//
// AUTH POSTURE — event-driven, NOT a user-invoked privileged op. pg
// (public.enqueue_order_failure_email, SECURITY DEFINER) fires net.http_post
// here with { attempt_id } and Authorization: Bearer <_edge_auth.cron_bearer>
// after record_vendor_order_attempt commits. So: verify_jwt = false in
// config.toml + the shared-bearer gate below, exactly like
// submission-push-fanout / the reminder crons. There is deliberately NO
// ADMIN_ROLES gate — there is no caller JWT to gate on.
//
// RECIPIENTS are resolved SERVER-SIDE from the attempt's brand (never from the
// request body): every super_admin, plus every admin/master of that brand, plus
// ORDER_FAILURE_OPS_EMAIL. The actor is NOT excluded — spec 120 excludes the
// submitter from their own submission's push, but an unattended auto-place means
// the operator walked away, so they are precisely who needs to hear about it.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// The fixed ops mailbox (owner decision, spec 162). Unset = the admins still get
// it; only the extra copy is lost.
const OPS_EMAIL = Deno.env.get("ORDER_FAILURE_OPS_EMAIL");

// Spec 028: HTML-escape EVERY interpolated value into the email body. Inlined
// per spec 028 §3 (not shared via _shared/) because `supabase functions deploy
// <name>` ships one function at a time and a shared module is invisible drift
// surface. Byte-identical mirror at src/utils/escapeHtml.ts.
function escapeHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function money(n: unknown): string {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : "0.00";
}

// Stage → the sentence a human reads first. Mirrors the extension's
// extension/src/core/checkout.ts `STAGE_REASON`; if you change one, change the
// other in the same commit (same posture as escapeHtml / derivePushCopy — the
// extension is a separate bundle and cannot import Deno code).
const STAGE_REASON: Record<string, string> = {
  "cart-verify": "The BJ's cart did not match the purchase order, so nothing was ordered.",
  "cap-check": "The BJ's cart total was over the spend cap, so nothing was ordered.",
  "address-verify": "BJ's was set to ship somewhere other than your saved address, so nothing was ordered.",
  "card-verify": "BJ's was set to charge a card other than the one you saved, so nothing was ordered.",
  "checkout-nav": "BJ's checkout could not be reached or advanced, so nothing was ordered.",
  "place": "BJ's never accepted the place-order click, so nothing was ordered.",
  "confirm": "BJ's did not return an order number, so the order is NOT confirmed.",
  "challenge": "BJ's showed a CAPTCHA or sign-in wall, so nothing was ordered.",
  "error": "The automation hit an unexpected error, so nothing was ordered.",
};

// Shared-bearer gate — mirrors submission-push-fanout / eod-reminder-cron. pg
// reads cron_bearer from public._edge_auth (RLS-locked, service_role-only) and
// sends it; we do the same lookup via service_role and compare. Anon callers
// cannot read the table so they cannot forge the token.
async function expectedBearer(supabaseUrl: string, serviceRoleKey: string): Promise<string | null> {
  try {
    const sb = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.from("_edge_auth").select("value").eq("name", "cron_bearer").single();
    if (error || !data?.value) return null;
    return data.value as string;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }), { status: 500 });
  }

  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const want = await expectedBearer(SUPABASE_URL, SERVICE_ROLE_KEY);
  if (!want || token !== want) {
    return new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body → 400 below */ }
    const attemptId = body?.attempt_id as string | undefined;
    if (!attemptId) {
      return new Response(JSON.stringify({ ok: false, error: "attempt_id required" }), { status: 400 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // AUTHORITATIVE READ — everything in the email comes from the DB, never from
    // the request body (which carries only an id).
    const { data: attempt, error: attemptErr } = await sb
      .from("vendor_order_attempts")
      .select("id, po_id, store_id, outcome, stage, detail, cart_total, cap_total, created_at, purchase_orders(po_number), stores(name, brand_id), vendors(name)")
      .eq("id", attemptId)
      .single();
    if (attemptErr || !attempt) {
      return new Response(JSON.stringify({ ok: false, error: `attempt not found: ${attemptErr?.message || "null"}` }), { status: 404 });
    }

    // A placed order is not a failure. Refuse rather than send a confusing email
    // — this function has exactly one job.
    if ((attempt as any).outcome !== "failed") {
      return new Response(JSON.stringify({ ok: true, skipped: "outcome is not 'failed'" }), {
        headers: { "content-type": "application/json" },
      });
    }

    const brandId = (attempt as any).stores?.brand_id ?? null;

    // RECIPIENTS — all super_admin (any brand) + admin/master of the attempt's
    // brand. Two reads then union, mirroring submission-push-fanout (the OR
    // spans a brand-scoped and an unscoped arm). The actor is NOT excluded.
    const recipientIds = new Set<string>();
    const { data: supers, error: supErr } = await sb
      .from("profiles").select("id").eq("role", "super_admin");
    if (supErr) {
      return new Response(JSON.stringify({ ok: false, error: `supers: ${supErr.message}` }), { status: 500 });
    }
    for (const r of (supers || []) as any[]) recipientIds.add(r.id as string);

    if (brandId) {
      const { data: brandAdmins, error: baErr } = await sb
        .from("profiles").select("id").in("role", ["admin", "master"]).eq("brand_id", brandId);
      if (baErr) {
        return new Response(JSON.stringify({ ok: false, error: `brandAdmins: ${baErr.message}` }), { status: 500 });
      }
      for (const r of (brandAdmins || []) as any[]) recipientIds.add(r.id as string);
    }

    // `profiles` has NO email column (spec 082 note in src/lib/db.ts) — the
    // address lives on auth.users, reachable here only because we hold the
    // service-role key. One getUserById per recipient: the set is a handful of
    // admins, so N small reads beat paging listUsers() over the whole project.
    // A lookup that fails is skipped, never fatal — one unreachable admin must
    // not cost the others their email.
    const emails = new Set<string>();
    for (const id of recipientIds) {
      try {
        const { data: u } = await sb.auth.admin.getUserById(id);
        const addr = u?.user?.email;
        if (addr) emails.add(addr);
      } catch {
        /* skip this recipient */
      }
    }

    if (OPS_EMAIL) emails.add(OPS_EMAIL);

    if (emails.size === 0) {
      return new Response(JSON.stringify({ ok: true, recipients: 0, sent: false }), {
        headers: { "content-type": "application/json" },
      });
    }

    // RENDER — every interpolated value escaped (AC-8 / spec 028).
    const vendorName = escapeHtml((attempt as any).vendors?.name ?? "Vendor");
    const storeName = escapeHtml((attempt as any).stores?.name ?? "");
    const poNumber = escapeHtml((attempt as any).purchase_orders?.po_number ?? "");
    const stage = (attempt as any).stage as string;
    const reason = escapeHtml(STAGE_REASON[stage] ?? "The order was not placed.");
    const detail = escapeHtml((attempt as any).detail ?? "");
    const cartTotal = (attempt as any).cart_total;
    const capTotal = (attempt as any).cap_total;

    const totalsRow = cartTotal != null
      ? `<p style="color:#6B6A65;font-size:14px;margin:4px 0">Cart total read from BJ's: <strong>$${escapeHtml(money(cartTotal))}</strong>${
          capTotal != null ? ` · spend cap <strong>$${escapeHtml(money(capTotal))}</strong>` : ""
        }</p>`
      : "";

    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:40px 20px"><div style="background:#1A1A18;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px"><h1 style="color:#FFF;font-size:28px;margin:0;letter-spacing:1px">I.M.R</h1><p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:14px">Order not placed</p></div><h2 style="color:#1A1A18;font-size:20px">${vendorName} order failed${storeName ? ` — ${storeName}` : ""}</h2><p style="color:#791F1F;font-size:15px;font-weight:600;margin:12px 0">${reason}</p>${
      poNumber ? `<p style="color:#6B6A65;font-size:14px;margin:4px 0">Purchase order: <strong>${poNumber}</strong></p>` : ""
    }${totalsRow}${
      detail ? `<p style="color:#6B6A65;font-size:13px;margin:16px 0;padding:12px;background:#F6F5F1;border-radius:8px"><strong>What the automation saw:</strong><br>${detail}</p>` : ""
    }<p style="color:#1A1A18;font-size:14px;margin:20px 0">The purchase order was left as a draft in I.M.R — nothing was ordered and nothing was charged. Open BJ's and place it by hand, or fix the problem above and run the extension again.</p><p style="color:#9B9A95;font-size:12px;text-align:center">Sent via I.M.R — Inventory Management for Restaurant</p></div>`;

    // SEND via Resend. No key configured = fail loudly (spec 031: no silent
    // success path). The bell + push arm already fired from pg, so a 503 here
    // means "email arm down", not "nobody was told".
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "email channel not configured (RESEND_API_KEY unset)" }), { status: 503 });
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "I.M.R Inventory <onboarding@resend.dev>",
        to: [...emails],
        // Subjects are not HTML and do not need escaping (CLAUDE.md spec-028).
        subject: `Order NOT placed — ${(attempt as any).vendors?.name ?? "Vendor"}${
          (attempt as any).stores?.name ? ` · ${(attempt as any).stores.name}` : ""
        }`,
        html,
      }),
    });

    if (!res.ok) {
      const detailText = await res.text().catch(() => "");
      return new Response(JSON.stringify({ ok: false, error: `resend send failed (HTTP ${res.status})`, detail: detailText }), { status: 502 });
    }

    return new Response(JSON.stringify({ ok: true, recipients: emails.size, sent: true }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500 });
  }
});
