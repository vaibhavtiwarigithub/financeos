import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:3000";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const session: "morning" | "evening" = body.session ?? "morning";

  const r = await fetch(`${APP_URL}/api/briefing/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": CRON_SECRET,
    },
    body: JSON.stringify({ session }),
  });

  const result = await r.json().catch(() => ({}));
  return new Response(JSON.stringify({ ok: r.ok, session, ...result }), {
    headers: { "Content-Type": "application/json" },
  });
});
