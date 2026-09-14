// Opt-in daily risk email — send cron.
//
// Spec: features/per-user-broker-risk/FEATURE_ARCHITECTURE.md §5.
// POST /api/agents/user-risk-email  (cron-secret gated)
//
// Invariants:
//   • OPT-IN ONLY. `user_risk_email_prefs.enabled` defaults false and is the
//     sole gate. An invitation to view the app is not consent to be emailed.
//   • ONE send per user per day, enforced by a UNIQUE INDEX on
//     (user_id, send_date), and the audit row is written BEFORE the provider is
//     called. A duplicated or retried cron loses the insert race and cannot mail
//     twice — bookkeeping after the fact would leave that window open.
//   • Content comes only from that user's own rows. The owner's book, research
//     and signals are never included.
//   • Access is re-checked at send time: a revoked user is not emailed, even if
//     their preference row still says enabled.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { OWNER_EMAIL } from "@/lib/auth/owner";
import { getEmailProvider } from "@/lib/providers/email";
import { buildRiskEmailHtml, riskEmailSubject } from "@/lib/email/guest-risk-email";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Belt and braces alongside the unique index: a bug cannot mail the world. */
const MAX_SENDS_PER_RUN = 50;

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const now = new Date();
  const sendDate = now.toISOString().slice(0, 10);
  const hourUtc = now.getUTCHours();
  const base = process.env.APP_BASE_URL || req.nextUrl.origin;

  const { data: prefs } = await svc
    .from("user_risk_email_prefs")
    .select("user_id, enabled, send_hour_utc, unsubscribe_token")
    .eq("enabled", true)
    .eq("send_hour_utc", hourUtc);

  const candidates = (prefs ?? []).slice(0, MAX_SENDS_PER_RUN);
  if (!candidates.length) {
    return NextResponse.json({ ok: true, hourUtc, considered: 0, sent: 0, skipped: [] });
  }

  const provider = getEmailProvider();
  const from = process.env.EMAIL_FROM || "Kairos <noreply@kairos.app>";
  const results: Array<{ userId: string; status: string; reason?: string }> = [];
  let sent = 0;

  for (const pref of candidates) {
    const userId = String(pref.user_id);

    // Access is re-checked here, not inherited from the preference row: a
    // revoked grant must stop the mail as well as the pages.
    const { data: grant } = await svc
      .from("app_user_roles")
      .select("revoked_at, email")
      .eq("user_id", userId)
      .maybeSingle();
    const { data: authUser } = await svc.auth.admin.getUserById(userId);
    const email = authUser?.user?.email ?? grant?.email ?? null;
    const isOwner = email === OWNER_EMAIL;
    if (!email || (!isOwner && (!grant || grant.revoked_at))) {
      results.push({ userId, status: "skipped", reason: "no_access" });
      continue;
    }

    // Latest completed run, whatever market it was for.
    const { data: run } = await svc
      .from("user_holding_risk_runs")
      .select("id, market, status, skip_reason, as_of_date, summary, started_at")
      .eq("user_id", userId)
      .eq("status", "ok")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!run?.summary) {
      // Nothing computed means nothing to say. Sending an empty digest would
      // train the reader to ignore the one that matters.
      results.push({ userId, status: "skipped", reason: "no_run" });
      continue;
    }

    const { data: prior } = await svc
      .from("user_holding_risk_runs")
      .select("summary, started_at")
      .eq("user_id", userId)
      .eq("market", run.market)
      .eq("status", "ok")
      .lt("started_at", run.started_at)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Claim the day BEFORE sending. If this loses the unique race, another run
    // already mailed this user today and we stop here.
    const { error: claimErr } = await svc
      .from("user_risk_email_sends")
      .insert({ user_id: userId, send_date: sendDate, market: run.market, status: "sent" });
    if (claimErr) {
      results.push({ userId, status: "skipped", reason: "already_sent_today" });
      continue;
    }

    const s: any = run.summary;

    // Per-holding rows drive the "why" section (largest position, correlated
    // pairs, missing history). Read them from the snapshots the run actually
    // wrote rather than expecting a duplicate copy inside the summary.
    const { data: snapRows } = await svc
      .from("user_holding_risk_snapshots")
      .select("symbol, metrics")
      .eq("user_id", userId)
      .eq("run_id", run.id)
      .limit(200);
    const holdingsForEmail = (snapRows ?? []).map((r: any) => ({
      symbol: String(r.symbol),
      weightPct: Number(r.metrics?.weightPct ?? 0),
      beta: Number(r.metrics?.beta ?? 0),
      sector: r.metrics?.sector ?? undefined,
      correlation: r.metrics?.correlation ?? null,
    }));

    const emailInput = {
      asOfDate: run.as_of_date ?? null,
      market: run.market as "us" | "india",
      currency: String(s.currency ?? ""),
      riskScore: Number(s.riskScore ?? 0),
      totalValue: Number(s.totalValue ?? 0),
      var95_dollar: Number(s.var95_dollar ?? 0),
      portfolioBeta: Number(s.portfolioBeta ?? 0),
      holdingCount: Number(s.holdingCount ?? 0),
      sectorBreakdown: s.sectorBreakdown ?? [],
      holdings: holdingsForEmail,
      previousScore: prior?.summary ? Number((prior.summary as any).riskScore ?? NaN) : null,
      staleNote: null,
      appBaseUrl: base,
      unsubscribeToken: String(pref.unsubscribe_token ?? ""),
    };
    const html = buildRiskEmailHtml(emailInput);

    try {
      await provider.send({ from, to: email, subject: riskEmailSubject(emailInput), html });
      await svc.from("user_risk_email_prefs").update({ last_sent_at: now.toISOString() }).eq("user_id", userId);
      sent++;
      results.push({ userId, status: "sent" });
    } catch (e: any) {
      await svc.from("user_risk_email_sends")
        .update({ status: "failed", detail: String(e?.message ?? e).slice(0, 300) })
        .eq("user_id", userId).eq("send_date", sendDate);
      results.push({ userId, status: "failed" });
    }
  }

  // User ids and outcomes only — never an address, a figure, or a holding.
  return NextResponse.json({ ok: true, hourUtc, considered: candidates.length, sent, results });
}
