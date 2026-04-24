import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_URL = "https://hopeful-lewin.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_ROLES = new Set(["admin", "master"]);

async function requireAdminCaller(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) return { error: "missing bearer token", status: 401 };
  const token = authHeader.slice(7);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userRes, error: userErr } = await client.auth.getUser();
  if (userErr || !userRes?.user) return { error: "invalid token", status: 401 };
  const appRole = (userRes.user.app_metadata as any)?.role;
  if (ADMIN_ROLES.has(appRole)) return { status: 200 };
  const { data: profile } = await client.from("profiles").select("role").eq("id", userRes.user.id).single();
  if (!profile || !ADMIN_ROLES.has(profile.role)) return { error: "forbidden", status: 403 };
  return { status: 200 };
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
    const { email, name, role, storeNames } = await req.json();

    if (!email || !name) {
      return new Response(JSON.stringify({ error: "email and name required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const registerUrl = `${APP_URL}?register=true`;
    const expiresText = "48 hours";

    if (RESEND_API_KEY) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "2AM Inventory <onboarding@resend.dev>",
          to: [email],
          subject: "You're invited to 2AM Inventory",
          html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px"><div style="background:#1A1A18;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px"><h1 style="color:#FFF;font-size:28px;margin:0;letter-spacing:1px">2AM</h1><p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:14px">Inventory Management</p></div><h2 style="color:#1A1A18;font-size:20px">Welcome, ${name}!</h2><p style="color:#6B6A65;font-size:15px;line-height:1.6">You've been invited to join <strong>2AM Inventory</strong> as a <strong>${role}</strong>${storeNames ? ` with access to <strong>${storeNames}</strong>` : ""}.</p><p style="color:#6B6A65;font-size:15px;line-height:1.6">Click the button below to create your account:</p><div style="text-align:center;margin:32px 0"><a href="${registerUrl}" style="background:#1A1A18;color:#FFF;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block">Create your account</a></div><p style="color:#9B9A95;font-size:13px;text-align:center">This invitation expires in <strong>${expiresText}</strong>.</p><hr style="border:none;border-top:1px solid #EEEDE8;margin:32px 0"/><p style="color:#9B9A95;font-size:12px;text-align:center">2AM Inventory Management System</p></div>`,
        }),
      });

      const ok = res.ok;
      return new Response(JSON.stringify({ success: ok, method: "resend" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fallback: Supabase Auth invite
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.auth.admin.inviteUserByEmail(email, {
      data: { name, role },
      redirectTo: registerUrl,
    });

    return new Response(JSON.stringify({ success: true, method: "supabase-auth" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
