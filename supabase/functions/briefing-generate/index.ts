import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPaused, pausedResponse } from "../_shared/pause-check.ts";

// APP_URL must be set as a Supabase secret — NOT localhost.
// Set via: supabase secrets set APP_URL=https://your-nextjs-url.com
const APP_URL = Deno.env.get("APP_URL") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!APP_URL || APP_URL.includes("localhost")) {
    return new Response(
      JSON.stringify({ error: "APP_URL not configured. Set via: supabase secrets set APP_URL=https://your-app-url.com" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { paused, reason } = await checkPaused(supabase);
  if (paused) return pausedResponse(reason);

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
