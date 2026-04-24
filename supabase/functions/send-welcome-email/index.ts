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

// Proof that this email belongs to a freshly-registered user:
//   1. caller is authenticated (has a valid user JWT)
//   2. their auth email matches the `email` arg
//   3. a profile row for them exists (confirms registerInvitedUser completed)
async function verifyFreshRegistration(authHeader: string | null, email: string) {
  if (!authHeader?.startsWith("Bearer ")) return { error: "missing bearer token", status: 401 };
  const token = authHeader.slice(7);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userRes, error: userErr } = await client.auth.getUser();
  if (userErr || !userRes?.user) return { error: "invalid token", status: 401 };
  if (userRes.user.email?.toLowerCase() !== email.toLowerCase()) {
    return { error: "email mismatch", status: 403 };
  }
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile } = await admin.from("profiles").select("id").eq("id", userRes.user.id).maybeSingle();
  if (!profile) return { error: "profile not found", status: 403 };
  return { status: 200 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, name } = await req.json();

    if (!email || !name) {
      return new Response(JSON.stringify({ error: "email and name required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const gate = await verifyFreshRegistration(req.headers.get("Authorization"), email);
    if (gate.status !== 200) {
      return new Response(JSON.stringify({ error: gate.error }), {
        status: gate.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
          subject: "Welcome to 2AM Inventory \u2014 You're all set!",
          html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px"><div style="background:#1A1A18;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px"><h1 style="color:#FFF;font-size:28px;margin:0;letter-spacing:1px">2AM</h1><p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:14px">Inventory Management</p></div><div style="text-align:center;margin-bottom:24px"><div style="width:64px;height:64px;background:#EAF3DE;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:32px">\u2705</div></div><h2 style="color:#1A1A18;font-size:22px;text-align:center">You're all set, ${name}!</h2><p style="color:#6B6A65;font-size:15px;line-height:1.6;text-align:center">Congratulations! Your account has been created and you're ready to use 2AM Inventory Management.</p><p style="color:#6B6A65;font-size:15px;line-height:1.6;text-align:center">You can now sign in with your email and password.</p><div style="text-align:center;margin:32px 0"><a href="${APP_URL}" style="background:#1A1A18;color:#FFF;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block">Sign in now</a></div><hr style="border:none;border-top:1px solid #EEEDE8;margin:32px 0"/><p style="color:#9B9A95;font-size:12px;text-align:center">2AM Inventory Management System</p></div>`,
        }),
      });

      return new Response(JSON.stringify({ success: res.ok }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, note: "No email provider" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
