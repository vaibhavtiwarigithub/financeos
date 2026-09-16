// User notification preferences: daily risk email + newsletter opt-in.
// Own-data route — reads and writes rows keyed to the session user only.
import { NextRequest, NextResponse } from "next/server";
import { getSessionRole } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const [{ data: riskPrefs }, { data: notifPrefs }] = await Promise.all([
    svc.from("user_risk_email_prefs")
      .select("enabled, send_hour_utc, last_sent_at")
      .eq("user_id", userId)
      .maybeSingle(),
    svc.from("user_notification_prefs")
      .select("newsletter_opted_in")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  return NextResponse.json({
    riskEmail: {
      enabled: Boolean(riskPrefs?.enabled),
      sendHourUtc: riskPrefs?.send_hour_utc ?? 12,
      lastSentAt: riskPrefs?.last_sent_at ?? null,
    },
    newsletter: {
      optedIn: Boolean(notifPrefs?.newsletter_opted_in),
    },
  });
}

export async function POST(req: NextRequest) {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const svc = createServiceClient();
  const ops: Promise<any>[] = [];

  if ("riskEmail" in body) {
    const enabled = Boolean(body.riskEmail?.enabled);
    const hour = Number(body.riskEmail?.sendHourUtc);
    const sendHourUtc = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 12;
    ops.push(
      svc.from("user_risk_email_prefs")
        .upsert({ user_id: userId, enabled, send_hour_utc: sendHourUtc }, { onConflict: "user_id" })
    );
  }

  if ("newsletter" in body) {
    const optedIn = Boolean(body.newsletter?.optedIn);
    ops.push(
      svc.from("user_notification_prefs")
        .upsert({ user_id: userId, newsletter_opted_in: optedIn, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
    );
  }

  if (!ops.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const results = await Promise.all(ops);
  const failed = results.find(r => r.error);
  if (failed) return NextResponse.json({ error: "could not save preferences" }, { status: 500 });

  return NextResponse.json({ ok: true });
}
