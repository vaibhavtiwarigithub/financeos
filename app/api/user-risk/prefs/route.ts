// A user's OWN daily-risk-email preference.
//
// Own-data route: reads and writes exactly one row, keyed to the session user.
// The unsubscribe token is never returned — it is a capability that turns the
// email off without a login, so it belongs in the email and nowhere else.
import { NextRequest, NextResponse } from "next/server";
import { getSessionRole } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data } = await svc
    .from("user_risk_email_prefs")
    .select("enabled, send_hour_utc, last_sent_at")
    .eq("user_id", userId)
    .maybeSingle();

  // No row means never opted in — which is OFF, the default the schema sets.
  return NextResponse.json({
    enabled: Boolean(data?.enabled),
    sendHourUtc: data?.send_hour_utc ?? 12,
    lastSentAt: data?.last_sent_at ?? null,
  });
}

export async function POST(req: NextRequest) {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const enabled = Boolean(body?.enabled);
  const hour = Number(body?.sendHourUtc);
  const sendHourUtc = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 12;

  const svc = createServiceClient();
  // user_id comes from the session, never the body, so nobody can subscribe
  // anyone else. The unsubscribe token is left alone: rotating it on every
  // toggle would silently break links in already-delivered mail.
  const { error } = await svc
    .from("user_risk_email_prefs")
    .upsert({ user_id: userId, enabled, send_hour_utc: sendHourUtc }, { onConflict: "user_id" });

  if (error) return NextResponse.json({ error: "could not save" }, { status: 500 });
  return NextResponse.json({ ok: true, enabled, sendHourUtc });
}
