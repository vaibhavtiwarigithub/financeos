// One-click unsubscribe from the daily risk email.
//
// Deliberately NOT gated on a session: an unsubscribe link that demands a login
// is not a working unsubscribe, and someone who wants the mail to stop should
// never have to remember a password to stop it. The token in
// `user_risk_email_prefs.unsubscribe_token` is the authority — it is a 24-byte
// random value, it grants nothing except turning this one preference OFF, and
// it cannot be used to read anything.
//
// The response is identical whether the token matched or not, so this cannot be
// used to probe which tokens (and therefore which subscriptions) exist.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const PAGE = (msg: string) => `<!doctype html><html><body style="margin:0;background:#F3F4F6;font:400 14px/1.6 Arial,sans-serif;color:#111;">
<div style="max-width:520px;margin:64px auto;background:#fff;border-radius:10px;padding:28px;">
<div style="font:700 18px Arial,sans-serif;margin-bottom:8px;">Daily risk email</div>
<div style="color:#4B5563;">${msg}</div>
</div></body></html>`;

async function unsubscribe(token: string | null): Promise<Response> {
  const body = PAGE(
    "You will not receive the daily risk email any more. Nothing else about your account has changed —"
    + " you can still sign in, and your broker connection is untouched. To turn it back on, use the"
    + " settings on your risk page.",
  );
  const headers = { "Content-Type": "text/html; charset=utf-8" };

  // A missing or unknown token returns the SAME page. Only the write differs.
  if (!token) return new NextResponse(body, { headers });

  const svc = createServiceClient();
  await svc
    .from("user_risk_email_prefs")
    .update({ enabled: false })
    .eq("unsubscribe_token", token);

  return new NextResponse(body, { headers });
}

export async function GET(req: NextRequest) {
  return unsubscribe(req.nextUrl.searchParams.get("token"));
}

// Mail clients that pre-fetch links use GET; RFC 8058 one-click uses POST.
// Both must work, and both are idempotent.
export async function POST(req: NextRequest) {
  return unsubscribe(req.nextUrl.searchParams.get("token"));
}
