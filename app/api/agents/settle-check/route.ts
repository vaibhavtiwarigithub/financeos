import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { runAccountingEnvelope } from "@/lib/monitoring/run-accounting";
import { fetchMassiveGroupedDaily } from "@/lib/data/quotes";
import { lastCompletedMarketSession } from "@/lib/trading/market-calendar";
import { compareSettledMarks, SETTLE_TOLERANCE_PCT, type SettleMark } from "@/lib/paper/settle-check";

// Next-day settlement check for US paper marks. MEASURE-ONLY.
//
// The US PositionMonitor marks at 16:15 ET from Yahoo — the only vendor carrying
// the just-closed session at that hour. Yahoo cannot corroborate Yahoo, so those
// marks ship `uncorroborated`. The grouped feed becomes available the next
// morning and IS independent; this pass compares against it.
//
// It writes NO money state: no NAV, no position price, no trade. A material
// drift TAINTS the affected paper_performance row and raises a critical, so the
// number is labelled untrustworthy rather than silently replaced. Restating a
// closed session's NAV would re-decide the past, which the frozen-history rule
// forbids — and the exits already filled at the marked price regardless.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const startedAt = new Date().toISOString();
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();

  try {
    const url = new URL(req.url);
    // Default: the newest session that has fully closed. `lastCompletedMarketSession`
    // always steps back at least one calendar day, which is exactly right here —
    // today's grouped bars do not exist yet.
    const session = url.searchParams.get("session") || lastCompletedMarketSession("us");

    const { data: markRows, error: markErr } = await svc
      .from("paper_position_marks")
      .select("symbol, qty, mark_price, provenance, source")
      .eq("market", "us")
      .eq("session_date", session);
    if (markErr) throw new Error(`paper_position_marks read failed: ${markErr.message}`);

    const marks: SettleMark[] = (markRows ?? []).map((m: any) => ({
      symbol: String(m.symbol),
      qty: Number(m.qty ?? 0),
      markPrice: Number(m.mark_price ?? 0),
      provenance: String(m.provenance ?? ""),
      source: String(m.source ?? ""),
    }));

    const symbols = [...new Set(marks.map((m) => m.symbol))];
    const grouped = symbols.length
      ? await fetchMassiveGroupedDaily(session, symbols, process.env.MASSIVE_API_KEY ?? "")
      : {};
    const settled: Record<string, number> = {};
    for (const [sym, q] of Object.entries(grouped)) settled[sym] = q.price;

    const result = compareSettledMarks(session, marks, settled, SETTLE_TOLERANCE_PCT);
    const issueKey = "paper-settle-drift:us";

    if (result.verdict === "drift_detected") {
      // Label the session's NAV untrustworthy. `nav` itself is left ALONE.
      await svc.from("paper_performance").update({
        tainted: true,
        taint_reason:
          `settle_drift (${session}): marks written at 16:15 ET did not survive comparison with the ` +
          `settled closes published next morning. ` +
          result.beyond.map((r) => `${r.symbol} marked ${r.marked} vs settled ${r.settled} (${r.driftPct.toFixed(3)}%)`).join("; ") +
          `. Net NAV impact ${result.navDrift.toFixed(2)}. nav is NOT restated — the exits for this session already ` +
          `filled at the marked price, and re-deciding a closed session is forbidden by the frozen-history rule.`,
      }).eq("market", "us").eq("date", session);

      await reportIssue({
        issueKey, severity: "critical", category: "paper-truth",
        title: `US marks drifted from settled closes — ${session}`,
        detail:
          `${result.beyond.length} of ${result.compared} live marks differ from the authoritative close by more than ` +
          `${SETTLE_TOLERANCE_PCT}%: ` +
          result.beyond.map((r) => `${r.symbol} ${r.marked} vs ${r.settled} (${r.driftPct.toFixed(3)}%)`).join("; ") +
          `. Net NAV impact ${result.navDrift.toFixed(2)}. The row is tainted; nav is not restated.`,
      }, svc);
    } else if (result.verdict === "corroborated") {
      await resolveIssue(issueKey, svc);
    }
    // `nothing_to_compare` deliberately neither raises nor resolves: an
    // unpublished feed is not evidence that the marks were right.

    await svc.from("agent_runs").insert({
      agent_type: "settle_check",
      market: "us",
      status: result.verdict === "drift_detected" ? "error" : "done",
      trigger_source: "scheduled",
      symbols,
      result_summary:
        `Settle ${session}: ${result.compared} compared, ${result.beyond.length} beyond ${SETTLE_TOLERANCE_PCT}%, ` +
        `${result.unverifiable.length} unverifiable, worst ${result.worstDriftPct.toFixed(3)}%, ` +
        `NAV drift ${result.navDrift.toFixed(2)} — ${result.verdict}.`,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      workload_metrics: {
        settle: result,
        ...runAccountingEnvelope({
          job: "settle-check:us",
          market: "us",
          eligible: result.compared + result.unverifiable.length,
          succeeded: result.compared,
          expectedSkip: 0,
          deferred: 0,
          unavailable: result.unverifiable.length,
          failed: 0,
          businessMetrics: { beyond_tolerance: result.beyond.length, nav_drift: result.navDrift },
        }),
      },
    } as any).catch(() => {});

    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await svc.from("agent_runs").insert({
      agent_type: "settle_check", market: "us", status: "error",
      trigger_source: "scheduled", result_summary: `SettleCheck failed: ${msg}`,
      started_at: startedAt, completed_at: new Date().toISOString(),
    } as any).catch(() => {});
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
